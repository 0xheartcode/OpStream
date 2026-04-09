/**
 * Pure block scanner — scans blocks, stores events, tracks deployments.
 *
 * This module knows nothing about pools, reserves, candles, or DEX-specific
 * logic. It is the generic Layer 2 engine that powers both bootstrap and
 * live indexing.
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  InteractionTransaction,
  DeploymentTransaction,
  OPNetTransactionTypes,
  TransactionBase,
} from 'opnet';
import { log } from '../core/logger.js';
import type { EventInput } from './eventStore.js';
import { decodeEvent } from '@opnet-devs/opkit';
import type { OpnetRpcClient } from '../rpc/opnetRpc.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScanResult {
  eventsStored: number;
  blocksScanned: number;
  deploymentsFound: number;
}

/** Callback invoked for each event as it's indexed. Used for WebSocket broadcast. */
export type OnEventCallback = (event: {
  blockNumber: number;
  txHash: string;
  contractAddress: string;
  eventName: string;
  decodedJson: string | null;
}) => void;

export interface ScanOptions {
  /** Minimum milliseconds between RPC calls (rate limiting). */
  minIntervalMs?: number;
  /** Called for each event after it's stored. */
  onEvent?: OnEventCallback;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Render a text progress bar: [========>           ] */
function progressBar(done: number, total: number, width: number): string {
  if (total <= 0) return `[${''.padEnd(width, '-')}]`;
  const filled = Math.round((done / total) * width);
  const empty = width - filled;
  return `[${'='.repeat(Math.max(0, filled - 1))}${filled > 0 ? '>' : ''}${'.'.repeat(empty)}]`;
}

/** Format seconds into human-readable elapsed time. */
function humanElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ${s}s`;
}

// ---------------------------------------------------------------------------
// Token deployment helpers
// ---------------------------------------------------------------------------

const OP20_EVENT_NAMES = new Set(['Transfer', 'Approval']);

function hashBytecode(bytecode: Uint8Array | string | undefined): string {
  if (!bytecode) return '';
  const buf = bytecode instanceof Uint8Array ? Buffer.from(bytecode) : Buffer.from(bytecode, 'hex');
  return createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

function isOp20(contractAddress: string, blockEvents: Map<string, Set<string>>): boolean {
  const names = blockEvents.get(contractAddress.toLowerCase());
  if (!names) return false;
  for (const n of OP20_EVENT_NAMES) {
    if (names.has(n)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Checkpoint helpers
// ---------------------------------------------------------------------------

const SCAN_TYPE_INDEXER = 'indexer';

export function getCheckpoint(db: DatabaseSync): bigint {
  const row = db.prepare(
    'SELECT last_block FROM scan_checkpoints WHERE scan_type = ?',
  ).get(SCAN_TYPE_INDEXER) as { last_block: number } | undefined;
  return row ? BigInt(row.last_block) : 0n;
}

export function saveCheckpoint(db: DatabaseSync, block: bigint): void {
  db.prepare(`
    INSERT INTO scan_checkpoints (scan_type, last_block, updated_at)
    VALUES (?, ?, unixepoch())
    ON CONFLICT(scan_type) DO UPDATE SET
      last_block = excluded.last_block,
      updated_at = unixepoch()
  `).run(SCAN_TYPE_INDEXER, Number(block));
}

// ---------------------------------------------------------------------------
// Block hash helpers (reorg detection)
// ---------------------------------------------------------------------------

export function saveBlockHash(db: DatabaseSync, blockNumber: number, blockHash: string): void {
  db.prepare(`
    INSERT OR REPLACE INTO block_hashes (block_number, block_hash)
    VALUES (?, ?)
  `).run(blockNumber, blockHash);
}

export function getBlockHash(db: DatabaseSync, blockNumber: number): string | null {
  const row = db.prepare(
    'SELECT block_hash FROM block_hashes WHERE block_number = ?',
  ).get(blockNumber) as { block_hash: string } | undefined;
  return row?.block_hash ?? null;
}

export function deleteBlockDataFrom(db: DatabaseSync, fromBlock: number): void {
  db.prepare('DELETE FROM events WHERE block_number >= ?').run(fromBlock);
  db.prepare('DELETE FROM block_hashes WHERE block_number >= ?').run(fromBlock);
  db.prepare('DELETE FROM token_deployments WHERE block_number >= ?').run(fromBlock);
}

// ---------------------------------------------------------------------------
// Core scanner
// ---------------------------------------------------------------------------

/**
 * Scan a range of blocks, store all events and token deployments.
 *
 * This is the pure, generic scanner — no DEX knowledge, no pool discovery.
 * It fetches each block from RPC, decodes events, and stores them.
 *
 * All writes for a single block are batched in one transaction to avoid
 * lock contention and improve throughput.
 */
export async function scanBlockRange(
  db: DatabaseSync,
  client: OpnetRpcClient,
  fromBlock: bigint,
  toBlock: bigint,
  opts?: ScanOptions,
): Promise<ScanResult> {
  const minIntervalMs = opts?.minIntervalMs ?? 0;
  const onEvent = opts?.onEvent;
  const startTime = Date.now();
  let lastCallTime = 0;
  let totalEvents = 0;
  let totalDeployments = 0;
  let totalBlocks = 0;

  const insertEventStmt = db.prepare(`
    INSERT OR IGNORE INTO events
      (block_number, tx_hash, contract_address, event_name, event_raw, decoded_json, data_length)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertDeployStmt = db.prepare(`
    INSERT OR IGNORE INTO token_deployments
      (block_number, tx_hash, contract_address, deployer, bytecode_hash, is_op20)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertHashStmt = db.prepare(`
    INSERT OR REPLACE INTO block_hashes (block_number, block_hash)
    VALUES (?, ?)
  `);

  for (let bn = fromBlock; bn <= toBlock; bn++) {
    if (minIntervalMs > 0) {
      const elapsed = Date.now() - lastCallTime;
      if (elapsed < minIntervalMs) {
        await delay(minIntervalMs - elapsed);
      }
    }
    lastCallTime = Date.now();

    let block;
    try {
      block = await client.getBlock(bn);
    } catch (err) {
      log('WARN', 'scanner', 'Failed to fetch block — skipping', {
        blockNumber: Number(bn),
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (!block) continue;

    const blockNumber = Number(block.height);
    const events: EventInput[] = [];
    const deployments: Array<{ blockNumber: number; txHash: string; contractAddr: string; deployer: string; bytecodeHash: string; op20: boolean }> = [];
    const blockEventNames = new Map<string, Set<string>>();

    for (const tx of block.transactions as TransactionBase<OPNetTransactionTypes>[]) {
      if (tx.OPNetType === OPNetTransactionTypes.Interaction) {
        const itx = tx as InteractionTransaction;

        for (const [contractAddr, evts] of Object.entries(tx.events)) {
          const lc = contractAddr.toLowerCase();
          if (!blockEventNames.has(lc)) blockEventNames.set(lc, new Set());
          for (const event of evts) {
            blockEventNames.get(lc)!.add(event.type);
            const rawData = Buffer.from(event.data);
            const decoded = decodeEvent(event.type, rawData);
            events.push({
              blockNumber,
              txHash: itx.id,
              contractAddress: contractAddr,
              eventName: event.type,
              rawData,
              decodedJson: decoded ? JSON.stringify(decoded) : null,
            });
          }
        }
      } else if (tx.OPNetType === OPNetTransactionTypes.Deployment) {
        const dtx = tx as DeploymentTransaction;
        const contractAddr = dtx.contractAddress ?? '';
        if (contractAddr) {
          const deployer = String(dtx.deployerAddress ?? '');
          const bytecodeHash = hashBytecode(dtx.bytecode);
          const op20 = isOp20(contractAddr, blockEventNames);
          deployments.push({ blockNumber, txHash: dtx.id, contractAddr, deployer, bytecodeHash, op20 });
        }
      }
    }

    // Single transaction per block: events + deployments + block hash
    db.exec('BEGIN');
    try {
      for (const e of events) {
        insertEventStmt.run(
          e.blockNumber, e.txHash, e.contractAddress, e.eventName,
          e.rawData, e.decodedJson ?? null, e.rawData.length,
        );
      }
      for (const d of deployments) {
        insertDeployStmt.run(
          d.blockNumber, d.txHash, d.contractAddr, d.deployer, d.bytecodeHash, d.op20 ? 1 : 0,
        );
      }
      const blockHash = String(block.hash ?? '');
      if (blockHash) {
        insertHashStmt.run(blockNumber, blockHash);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      log('WARN', 'scanner', 'Failed to write block data — skipping', {
        blockNumber,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    // Notify subscribers after successful commit
    if (onEvent) {
      for (const e of events) {
        onEvent({
          blockNumber: e.blockNumber,
          txHash: e.txHash,
          contractAddress: e.contractAddress,
          eventName: e.eventName,
          decodedJson: e.decodedJson ?? null,
        });
      }
    }

    totalEvents += events.length;
    totalDeployments += deployments.length;
    totalBlocks++;

    // Progress every 10 blocks
    if (totalBlocks % 10 === 0) {
      const totalRange = Number(toBlock - fromBlock + 1n);
      const done = Number(bn - fromBlock + 1n);
      const pct = ((done / totalRange) * 100).toFixed(1);
      const elapsedMs = Date.now() - startTime;
      const bps = (totalBlocks / (elapsedMs / 1000)).toFixed(1);
      const remaining = totalRange - done;
      const etaSec = totalBlocks > 0 ? (remaining / (totalBlocks / (elapsedMs / 1000))) : 0;

      const bar = progressBar(done, totalRange, 20);
      log('INFO', 'scanner',
        `${bar} ${pct}%  block ${blockNumber}/${Number(toBlock)}  ` +
        `${bps} blk/s  ETA ${humanElapsed(etaSec)}  ` +
        `events: ${totalEvents}  deploys: ${totalDeployments}`,
      );
    }
  }

  saveCheckpoint(db, toBlock);

  const elapsedSec = (Date.now() - startTime) / 1000;
  const totalRange = Number(toBlock - fromBlock + 1n);
  const bps = totalRange > 0 ? (totalBlocks / elapsedSec).toFixed(1) : '0';
  log('INFO', 'scanner',
    `Synced ${Number(fromBlock)}..${Number(toBlock)}  ` +
    `${totalBlocks} blocks in ${humanElapsed(elapsedSec)} (${bps} blk/s)  ` +
    `events: ${totalEvents}  deploys: ${totalDeployments}`,
  );

  return {
    eventsStored: totalEvents,
    blocksScanned: totalBlocks,
    deploymentsFound: totalDeployments,
  };
}
