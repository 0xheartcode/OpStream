/**
 * Mempool poller — watches the Bitcoin mempool for pending OPNET transactions.
 *
 * Follows the same architectural pattern as liveIndexer.ts:
 *   - setTimeout-based poll loop
 *   - Returns a handle with stop() and health()
 *   - Blocking wrapper via runMempoolPoller()
 *
 * On each poll cycle:
 *   1. Fetch all current mempool txids from Bitcoin Core
 *   2. Dropped detection — diff DB rows (confirmed_at IS NULL AND pruned_at IS NULL)
 *      against the live mempool. Txids no longer present are marked pruned_at
 *      and fire onMempoolDropped (→ MempoolDropped event to WebSocket subscribers).
 *   3. Early-return if mempool is empty (after dropped detection runs)
 *   4. Diff against an in-memory seen-set to find new txids
 *   5. Fetch raw tx hex for new txids (batched concurrently, MAX_BATCH_SIZE = 50)
 *   6. Run btcTxParser to extract OPNET payload — discard non-OPNET txs
 *   7. Insert OPNET pending txs into mempool_pending table
 *   8. Dispatch onMempoolEvent (→ MempoolPending event to WebSocket subscribers)
 *   9. Prune the seen-set (2-hour TTL)
 *  10. Every 100 cycles (~17 min at default interval): TTL-prune resolved
 *      mempool_pending rows older than 24h. Keeps the table tiny; confirmed txs
 *      past the window are still resolvable via the transactions table
 *      (opstream_getTransactionStatus two-step fallback).
 *
 * Confirmed crosslink:
 *   When the live indexer commits a block, main.ts calls handle.markConfirmed(txHashes).
 *   This sets confirmed_at on matching mempool_pending rows so they are excluded from
 *   future dropped-detection checks.
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
  /** Called when a pending tx is no longer visible in the mempool and is assumed dropped. */
  onMempoolDropped?: (event: WebhookEvent) => void;
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
  /**
   * Mark txids as confirmed (sets confirmed_at in mempool_pending).
   * Called by main.ts from the scanner's onBlockConfirmed callback.
   * Fire-and-forget — errors are logged but not propagated.
   */
  markConfirmed(txids: string[]): void;
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

const INSERT_MEMPOOL_PENDING = `
  INSERT OR IGNORE INTO mempool_pending (txid, raw_payload_hex, contract_selector, vsize_bytes)
  VALUES (?, ?, ?, ?)
`;

const SELECT_UNRESOLVED_PENDING = `
  SELECT txid FROM mempool_pending WHERE confirmed_at IS NULL AND pruned_at IS NULL
`;

const UPDATE_PRUNED_AT = `
  UPDATE mempool_pending SET pruned_at = ? WHERE txid = ? AND pruned_at IS NULL
`;

const UPDATE_CONFIRMED_AT = `
  UPDATE mempool_pending SET confirmed_at = ? WHERE txid = ? AND confirmed_at IS NULL
`;

// Prune resolved rows older than this — keeps the table tiny while still
// allowing opstream_getTransactionStatus to answer within the window.
const RESOLVED_ROW_TTL_S = 24 * 60 * 60; // 24 hours

const PRUNE_RESOLVED = `
  DELETE FROM mempool_pending
  WHERE (confirmed_at IS NOT NULL OR pruned_at IS NOT NULL)
    AND COALESCE(confirmed_at, pruned_at, 0) < ?
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
  const pollIntervalMs   = opts?.pollIntervalMs ?? 10_000;
  const onMempoolEvent   = opts?.onMempoolEvent;
  const onMempoolDropped = opts?.onMempoolDropped;

  const seenSet = new SeenSet();
  let running = true;
  let lastPollAt = 0;
  let totalOpnetTxsSeen = 0;
  let totalTxsFetched = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pollCount = 0;

  let _resolveStop: (() => void) | null = null;
  const stopPromise = new Promise<void>((resolve) => { _resolveStop = resolve; });

  async function runOnePoll(): Promise<void> {
    lastPollAt = Date.now();
    metrics.increment('mempoolPollCount');

    try {
      // 1. Get all mempool txids
      const allTxids = await btcRpc.getMempoolTxIds();

      // 2. Dropped detection — diff current mempool against unresolved DB rows.
      //    Runs even on empty mempool so txids that got evicted are not missed.
      if (onMempoolDropped) {
        const allTxSet = new Set(allTxids);
        const pendingRows = await db.all<{ txid: string }>(SELECT_UNRESOLVED_PENDING);
        const now = unixNow();
        for (const row of pendingRows) {
          if (!allTxSet.has(row.txid)) {
            await db.run(UPDATE_PRUNED_AT, [now, row.txid]);
            onMempoolDropped({
              blockNumber:     -1,
              txHash:          row.txid,
              contractAddress: '',
              eventName:       'MempoolDropped',
              failed:          false,
            });
          }
        }
      }

      if (allTxids.length === 0) {
        log('DEBUG', 'mempool', 'Mempool empty or Bitcoin RPC not connected');
        return;
      }

      // 3. Diff against seen-set
      const newTxids = allTxids.filter(txid => !seenSet.has(txid));

      if (newTxids.length === 0) {
        log('DEBUG', 'mempool', 'No new txids in mempool', { total: allTxids.length, seen: seenSet.size });
        return;
      }

      log('DEBUG', 'mempool', 'New mempool txids', { newCount: newTxids.length, totalMempool: allTxids.length });

      // 4. Fetch raw tx hex in batches
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

          // 5. Extract OPNET payload
          const payload = extractOpnetPayload(rawHex);
          if (!payload) continue;

          // 6. OPNET tx found — insert into DB
          opnetFound++;
          totalOpnetTxsSeen++;
          metrics.increment('mempoolOpnetTxsSeen');

          try {
            await db.run(INSERT_MEMPOOL_PENDING, [
              txid,
              payload.payloadHex,
              payload.selectorHex,
              payload.vsizeBytes,
            ]);
          } catch (err) {
            log('WARN', 'mempool', 'Failed to insert mempool_pending row', {
              txid,
              error: err instanceof Error ? err.message : String(err),
            });
          }

          // 7. Dispatch webhook event
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

      // 8. Prune seen-set
      const pruned = seenSet.prune();

      // 9. TTL-prune resolved mempool_pending rows (~every 100 cycles ≈ 17 min at 10s interval)
      pollCount++;
      if (pollCount % 100 === 0) {
        const cutoff = unixNow() - RESOLVED_ROW_TTL_S;
        await db.run(PRUNE_RESOLVED, [cutoff]);
        log('DEBUG', 'mempool', 'Pruned resolved mempool_pending rows older than 24h');
      }

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

  async function doMarkConfirmed(txids: string[]): Promise<void> {
    const now = unixNow();
    for (const txid of txids) {
      await db.run(UPDATE_CONFIRMED_AT, [now, txid]);
    }
  }

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

    markConfirmed(txids: string[]): void {
      if (txids.length === 0) return;
      void doMarkConfirmed(txids).catch((err) => {
        log('WARN', 'mempool', 'markConfirmed failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
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
