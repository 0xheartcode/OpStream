/**
 * Live event indexer — follows the Bitcoin/OPNET chain tip.
 *
 * After bootstrap completes, this module picks up from the last indexer
 * checkpoint and continuously processes new blocks as they arrive.
 *
 * Architecture:
 *   - Polls getBlockNumber() every pollIntervalMs (default 30s, ~2 Bitcoin blocks)
 *   - When a new block is seen, calls scanBlocks() for the range [checkpoint+1, newBlock]
 *   - Checkpoint is updated by scanBlocks() after each block
 *   - Tracks `blocksIndexedLive` and `eventsIndexedLive` in the metrics store
 *
 * Usage:
 *   const handle = startLiveIndexer(db, client);
 *   // later:
 *   handle.stop();
 */

import type { DatabaseSync } from 'node:sqlite';
import { log } from '../core/logger.js';
import { metrics } from '../core/metrics.js';
import type { OpnetRpcClient } from '../rpc/opnetRpc.js';
import { aggregateCandles } from './candles.js';
import type { CandleInterval } from './candles.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScanBlocksFn = (
  db: DatabaseSync,
  client: OpnetRpcClient,
  fromBlock: bigint,
  toBlock: bigint,
  opts: { chunkSize: bigint; minIntervalMs: number; nativeSwapEnabled: boolean },
) => Promise<unknown>;

export interface LiveIndexerOptions {
  /** How often to poll for new blocks (ms). Default: 30_000 (30s). */
  pollIntervalMs?: number;
  /** Maximum blocks to process per poll cycle. Default: 100. */
  maxBlocksPerCycle?: number;
  /** Enable NativeSwap pool discovery while scanning. Default: true. */
  nativeSwapEnabled?: boolean;
  /**
   * Override the scanBlocks implementation (for testing).
   * Defaults to the real scanBlocks from bootstrap.ts.
   */
  scanFn?: ScanBlocksFn;
}

export interface LiveIndexerHealth {
  running: boolean;
  lastPollAt: number;
  lastIndexedBlock: number;
  blocksIndexedLive: number;
  eventsIndexedLive: number;
}

export interface LiveIndexerHandle {
  stop(): void;
  health(): LiveIndexerHealth;
}

// ---------------------------------------------------------------------------
// Checkpoint helpers
// ---------------------------------------------------------------------------

const SCAN_TYPE_INDEXER = 'indexer';

function getCheckpoint(db: DatabaseSync): bigint {
  const row = db.prepare(
    'SELECT last_block FROM scan_checkpoints WHERE scan_type = ?',
  ).get(SCAN_TYPE_INDEXER) as { last_block: number } | undefined;
  return row ? BigInt(row.last_block) : 0n;
}

// ---------------------------------------------------------------------------
// startLiveIndexer
// ---------------------------------------------------------------------------

/**
 * Start the live indexer poll loop.
 *
 * Returns immediately with a handle. The polling runs asynchronously
 * via setTimeout — the caller must keep the process alive (event loop).
 */
export function startLiveIndexer(
  db: DatabaseSync,
  client: OpnetRpcClient,
  opts?: LiveIndexerOptions,
): LiveIndexerHandle {
  const pollIntervalMs    = opts?.pollIntervalMs    ?? 30_000;
  const maxBlocksPerCycle = opts?.maxBlocksPerCycle ?? 100;
  const nativeSwapEnabled = opts?.nativeSwapEnabled ?? true;
  const scanFn            = opts?.scanFn;

  let running = true;
  let lastPollAt = 0;
  let lastIndexedBlock = Number(getCheckpoint(db));
  let timer: ReturnType<typeof setTimeout> | null = null;

  let _resolveStop: (() => void) | null = null;
  const stopPromise = new Promise<void>((resolve) => { _resolveStop = resolve; });

  async function runOnePoll(): Promise<void> {
    lastPollAt = Date.now();

    try {
      const checkpoint = getCheckpoint(db);
      const currentBlock = await client.getBlockNumber();

      const fromBlock = checkpoint + 1n;
      let toBlock = currentBlock;

      if (toBlock - fromBlock + 1n > BigInt(maxBlocksPerCycle)) {
        toBlock = fromBlock + BigInt(maxBlocksPerCycle) - 1n;
      }

      if (fromBlock > currentBlock) {
        log('DEBUG', 'liveIndexer', 'indexer: up to date', {
          checkpoint: Number(checkpoint),
          currentBlock: Number(currentBlock),
        });
      } else {
        const eventsBefore = (db.prepare('SELECT COUNT(*) as c FROM events').get() as { c: number }).c;

        // Use injected scanFn (for tests) or lazy-load the real scanBlocks
        const scan = scanFn ?? (await import('./bootstrap.js')).scanBlocks;
        await scan(db, client, fromBlock, toBlock, {
          chunkSize: BigInt(maxBlocksPerCycle),
          minIntervalMs: 0,
          nativeSwapEnabled,
        });

        const eventsAfter = (db.prepare('SELECT COUNT(*) as c FROM events').get() as { c: number }).c;
        const blocksProcessed = Number(toBlock - fromBlock + 1n);
        const eventsNew = eventsAfter - eventsBefore;

        metrics.increment('blocksIndexedLive', blocksProcessed);
        metrics.increment('eventsIndexedLive', eventsNew);
        lastIndexedBlock = Number(toBlock);

        try {
          const batchFrom = Number(fromBlock);
          const batchTo = Number(toBlock);
          const poolRows = db.prepare(
            `SELECT DISTINCT pool_address FROM reserve_snapshots WHERE block_number >= ? AND block_number <= ?`,
          ).all(batchFrom, batchTo) as unknown as { pool_address: string }[];
          const INTERVALS: CandleInterval[] = ['10m', '1h', '1d'];
          for (const { pool_address } of poolRows) {
            for (const interval of INTERVALS) {
              aggregateCandles(db, pool_address, interval, batchFrom, batchTo);
            }
          }
        } catch (err) {
          log('WARN', 'liveIndexer', 'Candle aggregation failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }

        log('INFO', 'liveIndexer', 'Live indexer: processed blocks', {
          fromBlock: Number(fromBlock),
          toBlock: Number(toBlock),
          blocksProcessed,
          newEvents: eventsNew,
        });
      }
    } catch (err) {
      log('WARN', 'liveIndexer', 'Live indexer poll failed', {
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

  void runOnePoll().finally(() => scheduleNext());

  const handle: LiveIndexerHandle = {
    stop(): void {
      running = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      log('INFO', 'liveIndexer', 'Live indexer stopped', {
        lastIndexedBlock,
        blocksIndexedLive: metrics.get().blocksIndexedLive,
      });
      _resolveStop?.();
    },

    health(): LiveIndexerHealth {
      const snap = metrics.get();
      return {
        running,
        lastPollAt,
        lastIndexedBlock,
        blocksIndexedLive: snap.blocksIndexedLive,
        eventsIndexedLive: snap.eventsIndexedLive,
      };
    },
  };

  (handle as LiveIndexerHandle & { _stopPromise: Promise<void> })._stopPromise = stopPromise;
  return handle;
}

/**
 * Blocking wrapper around startLiveIndexer — resolves only when stop() is called.
 */
export async function runLiveIndexer(
  db: DatabaseSync,
  client: OpnetRpcClient,
  opts?: LiveIndexerOptions,
  onHandle?: (handle: LiveIndexerHandle) => void,
): Promise<void> {
  const handle = startLiveIndexer(db, client, opts);
  onHandle?.(handle);
  await (handle as LiveIndexerHandle & { _stopPromise: Promise<void> })._stopPromise;
}
