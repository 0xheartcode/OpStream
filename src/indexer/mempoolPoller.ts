/**
 * Mempool poller — watches the Bitcoin mempool for pending OPNET transactions.
 *
 * Follows the same architectural pattern as liveIndexer.ts:
 *   - setTimeout-based poll loop
 *   - Returns a handle with stop() and health()
 *   - Blocking wrapper via runMempoolPoller()
 *
 * On each poll cycle:
 *   1. Fetch all mempool txids from Bitcoin Core
 *   2. Diff against an in-memory seen-set to find new txids
 *   3. Fetch raw tx hex for new txids (batched concurrently)
 *   4. Run btcTxParser to extract OPNET payload — discard non-OPNET txs
 *   5. Insert OPNET pending txs into mempool_pending table
 *   6. Dispatch webhook events for each new OPNET tx
 *   7. Prune the seen-set (2-hour TTL)
 *
 * The seen-set prevents re-fetching txids we've already processed.
 * On a chain with ~20 tokens, OPNET txs are a tiny fraction of the
 * full Bitcoin mempool — the filtering is the core value here.
 *
 * NOTE: The first poll after startup will process all current mempool txids.
 * This can be a burst of several thousand getRawTransaction calls. The
 * MAX_BATCH_SIZE constant limits concurrency to avoid overwhelming the
 * Bitcoin RPC node. On subsequent polls, only NEW txids are fetched.
 *
 * @module mempoolPoller
 */

import { log } from '../core/logger.js';
import { metrics } from '../core/metrics.js';
import type { DbAdapter } from '../core/dbAdapter.js';
import type { BitcoinRpcClient } from '../rpc/btcRpc.js';
import { extractOpnetPayload } from '../rpc/btcTxParser.js';
import type { WebhookEvent } from './webhooks.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Max concurrent getRawTransaction calls per poll cycle. */
const MAX_BATCH_SIZE = 50;

/** Seen-set TTL: 2 hours. Txids older than this are pruned from memory. */
const SEEN_SET_TTL_MS = 2 * 60 * 60 * 1000;

// ─── Seen-set ────────────────────────────────────────────────────────────────

class SeenSet {
  private readonly map = new Map<string, number>();

  has(txid: string): boolean {
    return this.map.has(txid);
  }

  add(txid: string): void {
    this.map.set(txid, Date.now());
  }

  get size(): number {
    return this.map.size;
  }

  /**
   * Prune entries older than TTL.
   * Called once per poll cycle. O(n) but n is bounded by mempool size.
   */
  prune(): number {
    const cutoff = Date.now() - SEEN_SET_TTL_MS;
    let pruned = 0;
    for (const [txid, ts] of this.map) {
      if (ts < cutoff) {
        this.map.delete(txid);
        pruned++;
      }
    }
    return pruned;
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MempoolPollerOptions {
  /** How often to poll for new mempool txids (ms). Default: from config or 10_000. */
  pollIntervalMs?: number;
  /** Called for each new OPNET pending tx found in the mempool. */
  onMempoolEvent?: (event: WebhookEvent) => void;
}

export interface MempoolPollerHealth {
  running: boolean;
  lastPollAt: number;
  seenSetSize: number;
  totalOpnetTxsSeen: number;
  totalTxsFetched: number;
}

export interface MempoolPollerHandle {
  stop(): void;
  health(): MempoolPollerHealth;
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

const INSERT_MEMPOOL_PENDING = `
  INSERT OR IGNORE INTO mempool_pending (txid, raw_payload_hex, contract_selector)
  VALUES (?, ?, ?)
`;

// ─── startMempoolPoller ──────────────────────────────────────────────────────

/**
 * Start the mempool poller loop.
 *
 * Returns immediately with a handle. The polling runs asynchronously
 * via setTimeout — the caller must keep the process alive (event loop).
 */
export function startMempoolPoller(
  db: DbAdapter,
  btcRpc: BitcoinRpcClient,
  opts?: MempoolPollerOptions,
): MempoolPollerHandle {
  const pollIntervalMs = opts?.pollIntervalMs ?? 10_000;
  const onMempoolEvent = opts?.onMempoolEvent;

  const seenSet = new SeenSet();
  let running = true;
  let lastPollAt = 0;
  let totalOpnetTxsSeen = 0;
  let totalTxsFetched = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  let _resolveStop: (() => void) | null = null;
  const stopPromise = new Promise<void>((resolve) => { _resolveStop = resolve; });

  async function runOnePoll(): Promise<void> {
    lastPollAt = Date.now();
    metrics.increment('mempoolPollCount');

    try {
      // 1. Get all mempool txids
      const allTxids = await btcRpc.getMempoolTxIds();
      if (allTxids.length === 0) {
        log('DEBUG', 'mempool', 'Mempool empty or Bitcoin RPC not connected');
        return;
      }

      // 2. Diff against seen-set
      const newTxids = allTxids.filter(txid => !seenSet.has(txid));

      if (newTxids.length === 0) {
        log('DEBUG', 'mempool', 'No new txids in mempool', { total: allTxids.length, seen: seenSet.size });
        return;
      }

      log('DEBUG', 'mempool', 'New mempool txids', { newCount: newTxids.length, totalMempool: allTxids.length });

      // 3. Fetch raw tx hex in batches
      let opnetFound = 0;
      for (let i = 0; i < newTxids.length; i += MAX_BATCH_SIZE) {
        if (!running) break;

        const batch = newTxids.slice(i, i + MAX_BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map(async (txid) => {
            const rawHex = await btcRpc.getRawTransaction(txid);
            return { txid, rawHex };
          }),
        );

        for (const result of results) {
          if (result.status === 'rejected') continue;
          const { txid, rawHex } = result.value;

          totalTxsFetched++;
          metrics.increment('mempoolTxsFetched');

          // Always add to seen-set regardless of OPNET status
          seenSet.add(txid);

          if (!rawHex) continue;

          // 4. Extract OPNET payload
          const payload = extractOpnetPayload(rawHex);
          if (!payload) continue;

          // 5. OPNET tx found — insert into DB
          opnetFound++;
          totalOpnetTxsSeen++;
          metrics.increment('mempoolOpnetTxsSeen');

          try {
            await db.run(INSERT_MEMPOOL_PENDING, [
              txid,
              payload.payloadHex,
              payload.selectorHex,
            ]);
          } catch (err) {
            log('WARN', 'mempool', 'Failed to insert mempool_pending row', {
              txid,
              error: err instanceof Error ? err.message : String(err),
            });
          }

          // 6. Dispatch webhook event
          if (onMempoolEvent) {
            const event: WebhookEvent = {
              blockNumber:     -1, // sentinel: not yet in a block
              txHash:          txid,
              contractAddress: payload.selectorHex ?? '',
              eventName:       'MempoolPending',
              failed:          false,
            };
            onMempoolEvent(event);
          }
        }
      }

      // 7. Prune seen-set
      const pruned = seenSet.prune();

      if (opnetFound > 0 || pruned > 0) {
        log('INFO', 'mempool', 'Poll cycle complete', {
          newTxids: newTxids.length,
          opnetFound,
          seenSetSize: seenSet.size,
          pruned,
        });
      }
    } catch (err) {
      log('WARN', 'mempool', 'Mempool poll failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function scheduleNext(): void {
    if (!running) return;
    timer = setTimeout(() => {
      void runOnePoll().finally(() => scheduleNext());
    }, pollIntervalMs);
  }

  // Run first poll immediately, then schedule
  void runOnePoll().finally(() => scheduleNext());

  log('INFO', 'mempool', 'Mempool poller started', { pollIntervalMs });

  const handle: MempoolPollerHandle = {
    stop(): void {
      running = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      log('INFO', 'mempool', 'Mempool poller stopped', {
        totalOpnetTxsSeen,
        totalTxsFetched,
        seenSetSize: seenSet.size,
      });
      _resolveStop?.();
    },

    health(): MempoolPollerHealth {
      return {
        running,
        lastPollAt,
        seenSetSize: seenSet.size,
        totalOpnetTxsSeen,
        totalTxsFetched,
      };
    },
  };

  (handle as MempoolPollerHandle & { _stopPromise: Promise<void> })._stopPromise = stopPromise;
  return handle;
}

// ─── Blocking wrapper ────────────────────────────────────────────────────────

/**
 * Blocking wrapper around startMempoolPoller — resolves only when stop() is called.
 */
export async function runMempoolPoller(
  db: DbAdapter,
  btcRpc: BitcoinRpcClient,
  opts?: MempoolPollerOptions,
  onHandle?: (handle: MempoolPollerHandle) => void,
): Promise<void> {
  const handle = startMempoolPoller(db, btcRpc, opts);
  onHandle?.(handle);
  await (handle as MempoolPollerHandle & { _stopPromise: Promise<void> })._stopPromise;
}
