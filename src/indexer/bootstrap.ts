/**
 * OpStream bootstrap — CLI orchestrator for the block scanner.
 *
 * Thin wrapper around scanner.ts: loads config, opens DB, calls
 * scanBlockRange in chunks. No domain logic, no token metadata, no
 * OP20 labeling — that belongs in op-index.
 */

import { log } from '../core/logger.js';
import { loadConfig } from '../core/config.js';
import { openAdapter } from '../core/adapter.js';
import type { DbAdapter } from '../core/dbAdapter.js';
import { OpnetRpcClient } from '../rpc/opnetRpc.js';
import { scanBlockRange, getCheckpoint, progressBar, humanElapsed } from './scanner.js';
import { runSyncImport } from './syncImport.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BootstrapOptions {
  /** Blocks scanned per chunk. Default: 500. */
  chunkSize?: number;
  /** Override start block (ignores checkpoint). Default: use checkpoint. */
  fromBlock?: bigint;
  /**
   * Cap the scan at this block (inclusive). Default: chain tip.
   *
   * Enables deterministic bounded test runs: with fromBlock=X, toBlock=X+N
   * the loop scans exactly N+1 blocks regardless of the live tip. Clamped
   * to the chain tip if it exceeds it. Throws if toBlock < startBlock.
   */
  toBlock?: bigint;
  /** Forwarded to scanBlockRange — see ScanOptions.storeGenericTxs. Default false. */
  storeGenericTxs?: boolean;
  /**
   * The OPNET RPC URL the client is pointed at. When this URL responds to
   * /sync/status (i.e. it is another OpStream instance), bootstrap skips
   * block-by-block scanning and uses /sync/export instead.
   * Falls back to OPNET_RPC_URL env var when omitted.
   */
  opnetRpcUrl?: string;
}

export interface BootstrapResult {
  blocksScanned: number;
  eventsStored: number;
}

// ---------------------------------------------------------------------------
// Token deployment query
// ---------------------------------------------------------------------------

export interface ContractDeploymentRow {
  id: number;
  block_number: number;
  tx_hash: string;
  contract_address: string;
  deployer: string;
  bytecode_hash: string;
  created_at: number;
}

export async function queryContractDeployments(
  db: DbAdapter,
  sinceBlock: number,
): Promise<ContractDeploymentRow[]> {
  return db.all<ContractDeploymentRow>(
    `SELECT * FROM contract_deployments WHERE block_number >= ? ORDER BY block_number ASC`,
    [sinceBlock],
  );
}

// ---------------------------------------------------------------------------
// Two-line TTY progress display
// ---------------------------------------------------------------------------

/**
 * Creates a two-line rewriting progress display for TTY terminals.
 * Returns null when stdout is not a TTY — scanner falls back to log().
 *
 * Display:
 *   Overall  [============>..............] 45.2%  block 943721/952000  9.8 blk/s  ETA 1h 12m
 *    Chunk   [=======>...................]  32.1%  block 943721/944394  9.8 blk/s  ETA 4m 12s  events: 123
 *
 * ANSI cursor control used:
 *   \x1B[1A  — move cursor up one line
 *   \r        — carriage return (go to column 0)
 *   \x1B[2K  — erase entire line
 */
function createProgressDisplay(startBlock: number, totalBlocks: number) {
  if (!process.stdout.isTTY) return null;

  const startTime = Date.now();
  let active = false;

  return {
    update(chunkStartOffset: number, doneInChunk: number, chunkLine: string): void {
      const overallDone  = chunkStartOffset + doneInChunk;
      const elapsedSec   = (Date.now() - startTime) / 1000;
      const overallBps   = elapsedSec > 0 ? overallDone / elapsedSec : 0;
      const remaining    = totalBlocks - overallDone;
      const overallEta   = overallBps > 0 ? remaining / overallBps : 0;
      const pct          = ((overallDone / totalBlocks) * 100).toFixed(1);
      const bar          = progressBar(overallDone, totalBlocks, 25);
      const currentBlock = startBlock + overallDone;
      const endBlock     = startBlock + totalBlocks - 1;
      const overallLine  =
        `Overall  ${bar} ${pct.padStart(5)}%  block ${currentBlock}/${endBlock}  ` +
        `${overallBps.toFixed(1)} blk/s  ETA ${humanElapsed(overallEta)}`;

      if (active) {
        // Mote up 1 line, overwrite both lines (no trailing newline keeps cursor on chunk line)
        process.stdout.write(`\x1B[1A\r\x1B[2K${overallLine}\n\r\x1B[2K${chunkLine}`);
      } else {
        process.stdout.write(`${overallLine}\n${chunkLine}`);
        active = true;
      }
    },

    finish(): void {
      if (active) {
        process.stdout.write('\n'); // commit the last chunk line
        active = false;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Testable bootstrap core
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// OpStream upstream detection
// ---------------------------------------------------------------------------

/**
 * Returns true if the given URL is an OpStream instance that exposes
 * /sync/status. When true, bootstrap uses runSyncImport() via /sync/export
 * instead of block-by-block scanning — orders of magnitude faster.
 */
async function probeOpStreamUpstream(rpcUrl: string): Promise<boolean> {
  const base = rpcUrl.replace(/\/api\/v1\/json-rpc\/?$/, '').replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/sync/status`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return false;
    const body = await res.json() as Record<string, unknown>;
    return typeof body['tipBlock'] !== 'undefined';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Testable bootstrap core
// ---------------------------------------------------------------------------

/**
 * Testable bootstrap core — all dependencies injected.
 * Scans blocks in chunks and stores all chain data.
 *
 * When OPNET_RPC_URL responds to /sync/status (i.e. it is an OpStream
 * instance), bootstrap automatically uses the fast /sync/export path instead
 * of block-by-block scanning. Falls back to the scanner if the probe fails.
 */
export async function runBootstrapCore(
  db: DbAdapter,
  client: OpnetRpcClient,
  opts?: BootstrapOptions,
  bootstrapRps?: number,
): Promise<BootstrapResult> {
  const chunkSize = BigInt(opts?.chunkSize ?? 500);
  const fromBlockOverride = opts?.fromBlock ?? 0n;
  const toBlockCap = opts?.toBlock ?? 0n;
  const storeGenericTxs = opts?.storeGenericTxs ?? false;
  const rps = bootstrapRps ?? 10;
  const minIntervalMs = rps > 0 ? Math.floor(1000 / rps) : 0;

  // Fast path: if the upstream URL is an OpStream instance (responds to
  // /sync/status), skip block-by-block scanning and use /sync/export instead.
  // Same data, same result, ~100× fewer HTTP requests.
  const upstreamUrl = opts?.opnetRpcUrl ?? process.env['OPNET_RPC_URL'] ?? '';
  if (upstreamUrl) {
    log('INFO', 'bootstrap', 'Probing upstream for OpStream sync endpoint...');
    const isOpStream = await probeOpStreamUpstream(upstreamUrl);
    if (isOpStream) {
      log('INFO', 'bootstrap', 'OpStream upstream detected — switching to fast /sync/export path');
      const base = upstreamUrl.replace(/\/api\/v1\/json-rpc\/?$/, '').replace(/\/+$/, '');
      const result = await runSyncImport(db, {
        sourceUrl: base,
        secret:    process.env['SYNC_SECRET'] ?? null,
      });
      return {
        blocksScanned: result.blocksImported,
        eventsStored:  0,
      };
    }
    log('INFO', 'bootstrap', 'Upstream is not OpStream — using block-by-block scanner');
  }

  const currentBlock = await client.getBlockNumber();

  const checkpoint = await getCheckpoint(db);
  const startBlock = fromBlockOverride > 0n ? fromBlockOverride : checkpoint + 1n;

  const endBlockInclusive = toBlockCap > 0n
    ? (toBlockCap < currentBlock ? toBlockCap : currentBlock)
    : currentBlock;

  if (toBlockCap > 0n && toBlockCap < startBlock) {
    throw new Error(
      `BOOTSTRAP_TO_BLOCK (${toBlockCap}) is less than start block (${startBlock}). ` +
      `Set BOOTSTRAP_TO_BLOCK >= BOOTSTRAP_FROM_BLOCK, or
 unset it to scan to chain tip.`,
    );
  }

  const totalRange = Number(endBlockInclusive - startBlock + 1n);

  if (startBlock > endBlockInclusive) {
    log('INFO', 'bootstrap', `Synced  checkpoint=${Number(checkpoint)}  target=${Number(endBlockInclusive)}  -- up to date`);
    return { blocksScanned: 0, eventsStored: 0 };
  }

  log('INFO', 'bootstrap', '');
  log('INFO', 'bootstrap', `  OpStream Bootstrap`);
  log('INFO', 'bootstrap', `  Chain tip:      ${Number(currentBlock)}`);
  log('INFO', 'bootstrap', `  Start block:    ${Number(startBlock)}`);
  log('INFO', 'bootstrap', `  End block:      ${Number(endBlockInclusive)}${toBlockCap > 0n ? ' (capped)' : ''}`);
  log('INFO', 'bootstrap', `  Blocks to scan: ${totalRange}`);
  log('INFO', 'bootstrap', `  Rate limit:     ${rps} req/s`);
  log('INFO', 'bootstrap', '');

  const startTime = Date.now();
  let totalEvents = 0;
  let totalBlocks = 0;

  const display = createProgressDisplay(Number(startBlock), totalRange);

  for (let chunkStart = startBlock; chunkStart <= endBlockInclusive; chunkStart += chunkSize) {
    const chunkEnd = chunkStart + chunkSize - 1n <= endBlockInclusive
      ? chunkStart + chunkSize - 1n
      : endBlockInclusive;

    const chunkStartOffset = Number(chunkStart - startBlock);

    const result = await scanBlockRange(db, client, chunkStart, chunkEnd, {
      minIntervalMs,
      storeGenericTxs,
      onProgress: display
        ? (doneInChunk, chunkLine) => display.update(chunkStartOffset, doneInChunk, chunkLine)
        : undefined,
    });

    totalEvents += result.eventsStored;
    totalBlocks += result.blocksScanned;
  }

  display?.finish();

  const elapsedSec = (Date.now() - startTime) / 1000;
  const bps = totalBlocks > 0 ? (totalBlocks / elapsedSec).toFixed(1) : '0';
  log('INFO', 'bootstrap', '');
  log('INFO', 'bootstrap', `  Bootstrap complete`);
  log('INFO', 'bootstrap', `  Blocks scanned: ${totalBlocks}`);
  log('INFO', 'bootstrap', `  Events stored:  ${totalEvents}`);
  log('INFO', 'bootstrap', `  Time:           ${humanElapsed(elapsedSec)} (${bps} blk/s)`);
  log('INFO', 'bootstrap', '');

  return { blocksScanned: totalBlocks, eventsStored: totalEvents };
}

// ---------------------------------------------------------------------------
// CLI entry points
// ---------------------------------------------------------------------------

export async function runBootstrap(): Promise<void> {
  const config = loadConfig();
  const db = await openAdapter();
  const client = new OpnetRpcClient(config.opnetRpcUrl);

  const checkpoint = await getCheckpoint(db);
  const effectiveFromBlock = checkpoint > 0n ? 0n : config.bootstrapFromBlock;

  log('INFO', 'bootstrap', 'Bootstrap starting', {
    dbPath: config.dbPath,
    chunkSize: config.bootstrapChunkSize,
    fromBlock: Number(effectiveFromBlock),
    checkpoint: Number(checkpoint),
    resuming: checkpoint > 0n,
  });

  const result = await runBootstrapCore(
    db, client,
    {
      chunkSize:       config.bootstrapChunkSize,
      fromBlock:       effectiveFromBlock,
      toBlock:         config.bootstrapToBlock,
      storeGenericTxs: config.storeGenericTxs,
      opnetRpcUrl:     config.opnetRpcUrl,
    },
    config.bootstrapRps,
  );

  log('INFO', 'bootstrap', 'Bootstrap finished', {
    blocksScanned: result.blocksScanned,
    eventsStored: result.eventsStored,
  });
}

export async function runCatchup(): Promise<void> {
  const config = loadConfig();
  const db = await openAdapter();
  const client = new OpnetRpcClient(config.opnetRpcUrl);

  log('INFO', 'bootstrap', 'Catchup starting (incremental — from last checkpoint)', {
    dbPath: config.dbPath,
    });

  const result = await runBootstrapCore(
    db, client,
    { chunkSize: config.bootstrapChunkSize, opnetRpcUrl: config.opnetRpcUrl },
    config.bootstrapRps,
  );

  log('INFO', 'bootstrap', 'Catchup finished', {
    blocksScanned: result.blocksScanned,
    eventsStored: result.eventsStored,
  });
}
