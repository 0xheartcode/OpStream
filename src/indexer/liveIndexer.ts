/**
 * Live event indexer — follows the Bitcoin/OPNET chain tip.
 *
 * After bootstrap completes, this module picks up from the last indexer
 * checkpoint and continuously processes new blocks as they arrive.
 *
 * Architecture:
 *   - Polls getBlockNumber() every pollIntervalMs (default 30s, ~2 Bitcoin blocks)
 *   - When new blocks arrive, calls scanBlockRange() for [checkpoint+1, newBlock]
 *   - Checks for chain reorgs by comparing stored block hashes
 *   - Tracks `blocksIndexedLive` and `eventsIndexedLive` in the metrics store
 */

import { log } from '../core/logger.js';
import { metrics } from '../core/metrics.js';
import type { DbAdapter } from '../core/dbAdapter.js';
import type { OpnetRpcClient } from '../rpc/opnetRpc.js';
import {
  scanBlockRange,
  getCheckpoint,
  getBlockHash,
  deleteBlockDataFrom,
  saveCheckpoint,
} from './scanner.js';
import type { ScanResult, OnEventCallback } from './scanner.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScanBlocksFn = (
  db: DbAdapter,
  client: OpnetRpcClient,
  fromBlock: bigint,
  toBlock: bigint,
) => Promise<ScanResult>;

export interface LiveIndexerOptions {
  /** How often to poll for new blocks (ms). Default: 30_000 (30s). */
  pollIntervalMs?: number;
  /** Maximum blocks to process per poll cycle. Default: 100. */
  maxBlocksPerCycle?: number;
  /**
   * Override the scanBlockRange implementation (for testing).
   * Defaults to the real scanBlockRange from scanner.ts.
   */
  scanFn?: ScanBlocksFn;
  /** Called for each event as it's indexed. Used for WebSocket/webhook dispatch. */
  onEvent?: OnEventCallback;
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
// Reorg detection
// ---------------------------------------------------------------------------

const MAX_REORG_DEPTH = 10;

/**
 * Check if the chain has reorged by comparing stored block hashes.
 * Returns the fork point block number if a reorg is detected, null otherwise.
 */
async function checkForReorg(
  db: DbAdapter,
  client: OpnetRpcClient,
  lastIndexedBlock: number,
): Promise<number | null> {
  for (let depth = 0; depth < MAX_REORG_DEPTH; depth++) {
    const checkBlock = lastIndexedBlock - depth;
    if (checkBlock <= 0) return null;

    const storedHash = await getBlockHash(db, checkBlock);
    if (!storedHash) return null; // no hash stored, can't detect

    try {
      const block = await client.getBlock(BigInt(checkBlock));
      if (!block) return null;

      const onChainHash = String((block as any).hash ?? (block as any).id ?? '');
      if (!onChainHash) return null;

      if (storedHash !== onChainHash) {
        // This block was reorged — continue checking deeper
        continue;
      }

      // Hashes match at this depth
      if (depth > 0) {
        // We found the fork point: blocks from (checkBlock + 1) onward are invalid
        return checkBlock + 1;
      }

      // depth === 0 and hashes match — no reorg
      return null;
    } catch (err) {
      log('WARN', 'liveIndexer', 'Reorg check failed for block', {
        blockNumber: checkBlock,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // Reorg deeper than MAX_REORG_DEPTH — return the deepest point we checked
  log('WARN', 'liveIndexer', `Reorg deeper than ${MAX_REORG_DEPTH} blocks detected`, {
    lastIndexedBlock,
  });
  return lastIndexedBlock - MAX_REORG_DEPTH + 1;
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
  db: DbAdapter,
  client: OpnetRpcClient,
  opts?: LiveIndexerOptions,
): LiveIndexerHandle {
  const pollIntervalMs    = opts?.pollIntervalMs    ?? 30_000;
  const maxBlocksPerCycle = opts?.maxBlocksPerCycle ?? 100;
  const scanFn            = opts?.scanFn;
  const onEvent           = opts?.onEvent;

  let running = true;
  let lastPollAt = 0;
  let lastIndexedBlock = 0; // updated on first poll from getCheckpoint()
  let timer: ReturnType<typeof setTimeout> | null = null;

  let _resolveStop: (() => void) | null = null;
  const stopPromise = new Promise<void>((resolve) => { _resolveStop = resolve; });

  async function runOnePoll(): Promise<void> {
    lastPollAt = Date.now();

    try {
      const checkpoint = await getCheckpoint(db);
      lastIndexedBlock = Number(checkpoint);
      const currentBlock = await client.getBlockNumber();

      // Check for reorgs before scanning new blocks
      if (checkpoint > 0n) {
        const forkPoint = await checkForReorg(db, client, Number(checkpoint));
        if (forkPoint !== null) {
          log('WARN', 'liveIndexer', 'Chain reorg detected — rolling back', {
            forkPoint,
            lastIndexedBlock: Number(checkpoint),
          });
          await deleteBlockDataFrom(db, forkPoint);
          await saveCheckpoint(db, BigInt(forkPoint - 1));
          lastIndexedBlock = forkPoint - 1;
          // Re-scan from fork point on next poll
          return;
        }
      }

      const fromBlock = checkpoint + 1n;
      let toBlock = currentBlock;

      if (toBlock - fromBlock + 1n > BigInt(maxBlocksPerCycle)) {
        toBlock = fromBlock + BigInt(maxBlocksPerCycle) - 1n;
      }

      if (fromBlock > currentBlock) {
        log('INFO', 'live', `Synced  block=${Number(currentBlock)}  waiting for new blocks...`);
      } else {
        const blocksAhead = Number(toBlock - fromBlock + 1n);
        log('INFO', 'live', `New blocks  ${Number(fromBlock)}..${Number(toBlock)} (+${blocksAhead})`);

        const result = scanFn
          ? await scanFn(db, client, fromBlock, toBlock)
          : await scanBlockRange(db, client, fromBlock, toBlock, { onEvent });

        metrics.increment('blocksIndexedLive', blocksAhead);
        metrics.increment('eventsIndexedLive', result.eventsStored);
        lastIndexedBlock = Number(toBlock);

        log('INFO', 'live', `Indexed  block=${Number(toBlock)}  events=${result.eventsStored}  deploys=${result.deploymentsFound}`);
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
  db: DbAdapter,
  client: OpnetRpcClient,
  opts?: LiveIndexerOptions,
  onHandle?: (handle: LiveIndexerHandle) => void,
): Promise<void> {
  const handle = startLiveIndexer(db, client, opts);
  onHandle?.(handle);
  await (handle as LiveIndexerHandle & { _stopPromise: Promise<void> })._stopPromise;
}
