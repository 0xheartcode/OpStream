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
// Internal types
// ---------------------------------------------------------------------------

interface TxRow {
  txHash: string;
  blockNumber: number;
  txIndex: number;
  txType: string;
  fromAddress: string | null;
  contractAddress: string | null;
  gasUsed: string | null;
  specialGasUsed: string | null;
  burnedBitcoin: string | null;
  priorityFee: string | null;
  maxGasSat: string | null;
  failed: number;
  revertReason: string | null;
  calldata: Buffer | null;
  calldataLength: number | null;
  senderPubKeyHash: string | null;
}

interface OutputRow {
  txHash: string;
  outputIndex: number;
  valueSat: bigint | null;
  scriptType: string | null;
  address: string | null;
}

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
  /**
   * Called every ~10 blocks with (doneInChunk, chunkProgressLine).
   * When provided, scanner skips its own log() for progress — the caller
   * owns the display (e.g. two-line TTY rewrite in bootstrap).
   */
  onProgress?: (doneInChunk: number, chunkLine: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Render a text progress bar: [========>           ] */
export function progressBar(done: number, total: number, width: number): string {
  if (total <= 0) return `[${''.padEnd(width, '-')}]`;
  const filled = Math.round((done / total) * width);
  const empty = width - filled;
  return `[${'='.repeat(Math.max(0, filled - 1))}${filled > 0 ? '>' : ''}${'.'.repeat(empty)}]`;
}

/** Format seconds into human-readable elapsed time. */
export function humanElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ${s}s`;
}

// ---------------------------------------------------------------------------
// Deployment helpers
// ---------------------------------------------------------------------------

function hashBytecode(bytecode: Uint8Array | string | undefined): string {
  if (!bytecode) return '';
  const buf = bytecode instanceof Uint8Array ? Buffer.from(bytecode) : Buffer.from(bytecode, 'hex');
  return createHash('sha256').update(buf).digest('hex').slice(0, 16);
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
// Block helpers (reorg detection + metadata)
// ---------------------------------------------------------------------------

export function saveBlock(
  db: DatabaseSync,
  blockNumber: number,
  blockHash: string,
  timestamp: number | null,
  txCount: number,
): void {
  db.prepare(`
    INSERT OR REPLACE INTO blocks (block_number, block_hash, timestamp, tx_count)
    VALUES (?, ?, ?, ?)
  `).run(blockNumber, blockHash, timestamp, txCount);
}

export function getBlockHash(db: DatabaseSync, blockNumber: number): string | null {
  const row = db.prepare(
    'SELECT block_hash FROM blocks WHERE block_number = ?',
  ).get(blockNumber) as { block_hash: string } | undefined;
  return row?.block_hash ?? null;
}

export function deleteBlockDataFrom(db: DatabaseSync, fromBlock: number): void {
  // Delete tx_outputs via tx_hash FK (no block_number on tx_outputs)
  db.prepare(`
    DELETE FROM tx_outputs WHERE tx_hash IN (
      SELECT tx_hash FROM transactions WHERE block_number >= ?
    )
  `).run(fromBlock);
  db.prepare('DELETE FROM events WHERE block_number >= ?').run(fromBlock);
  db.prepare('DELETE FROM transactions WHERE block_number >= ?').run(fromBlock);
  db.prepare('DELETE FROM blocks WHERE block_number >= ?').run(fromBlock);
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
      (block_number, tx_hash, contract_address, event_name, log_index, event_raw, decoded_json, data_length)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertTxStmt = db.prepare(`
    INSERT OR IGNORE INTO transactions
      (tx_hash, block_number, tx_index, tx_type, from_address, contract_address,
       gas_used, special_gas_used, burned_bitcoin, priority_fee, max_gas_sat,
       failed, revert_reason, calldata, calldata_length, sender_pub_key_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertOutputStmt = db.prepare(`
    INSERT OR IGNORE INTO tx_outputs (tx_hash, output_index, value_sat, script_type, address)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertDeployStmt = db.prepare(`
    INSERT OR IGNORE INTO token_deployments
      (block_number, tx_hash, contract_address, deployer, bytecode_hash)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertBlockStmt = db.prepare(`
    INSERT OR REPLACE INTO blocks (block_number, block_hash, timestamp, tx_count)
    VALUES (?, ?, ?, ?)
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
    const blockTimestamp: number | null = (block as any).time ?? (block as any).timestamp ?? null;
    const events: (EventInput & { logIndex: number })[] = [];
    const txRows: TxRow[] = [];
    const deployments: Array<{ blockNumber: number; txHash: string; contractAddr: string; deployer: string; bytecodeHash: string }> = [];

    const blockTxs = block.transactions as TransactionBase<OPNetTransactionTypes>[];
    const outputRows: OutputRow[] = [];

    for (let txIndex = 0; txIndex < blockTxs.length; txIndex++) {
      const tx = blockTxs[txIndex]!;

      const fromAddress = String((tx as any).from ?? '') || null;
      const contractAddr = String((tx as any).contractAddress ?? '') || null;
      const txType =
        tx.OPNetType === OPNetTransactionTypes.Interaction ? 'interaction' :
        tx.OPNetType === OPNetTransactionTypes.Deployment   ? 'deployment'  :
        'generic';

      // Interaction-specific fields
      let calldata: Buffer | null = null;
      let calldataLength: number | null = null;
      let senderPubKeyHash: string | null = null;

      if (tx.OPNetType === OPNetTransactionTypes.Interaction) {
        const itx = tx as InteractionTransaction;
        if (itx.calldata && itx.calldata.length > 0) {
          calldata = Buffer.from(itx.calldata);
          calldataLength = calldata.length;
        }
        if (itx.senderPubKeyHash && itx.senderPubKeyHash.length > 0) {
          senderPubKeyHash = Buffer.from(itx.senderPubKeyHash).toString('hex');
        }
      }

      txRows.push({
        txHash:          tx.id,
        blockNumber,
        txIndex,
        txType,
        fromAddress,
        contractAddress: contractAddr,
        gasUsed:         tx.gasUsed        != null ? String(tx.gasUsed)        : null,
        specialGasUsed:  tx.specialGasUsed != null ? String(tx.specialGasUsed) : null,
        burnedBitcoin:   tx.burnedBitcoin  != null ? String(tx.burnedBitcoin)  : null,
        priorityFee:     tx.priorityFee    != null ? String(tx.priorityFee)    : null,
        maxGasSat:       tx.maxGasSat      != null ? String(tx.maxGasSat)      : null,
        failed:          (tx as any).failed ? 1 : 0,
        revertReason:    (tx as any).revert ?? null,
        calldata,
        calldataLength,
        senderPubKeyHash,
      });

      // Bitcoin UTXO outputs — every tx type
      for (const output of tx.outputs) {
        const spk = output.scriptPubKey as { type?: string; address?: string; addresses?: string[] };
        outputRows.push({
          txHash:      tx.id,
          outputIndex: output.index,
          valueSat:    output.value ?? null,
          scriptType:  spk.type ?? null,
          address:     spk.address ?? spk.addresses?.[0] ?? null,
        });
      }

      if (tx.OPNetType === OPNetTransactionTypes.Interaction) {
        const itx = tx as InteractionTransaction;
        let logIndex = 0;

        for (const [evContractAddr, evts] of Object.entries(tx.events)) {
          for (const event of evts) {
            const rawData = Buffer.from(event.data);
            const decoded = decodeEvent(event.type, rawData);
            events.push({
              blockNumber,
              txHash: itx.id,
              contractAddress: evContractAddr,
              eventName: event.type,
              logIndex: logIndex++,
              rawData,
              decodedJson: decoded ? JSON.stringify(decoded) : null,
            });
          }
        }
      } else if (tx.OPNetType === OPNetTransactionTypes.Deployment) {
        const dtx = tx as DeploymentTransaction;
        const deployedAddr = dtx.contractAddress ?? '';
        if (deployedAddr) {
          const deployer = String(dtx.deployerAddress ?? '');
          const bytecodeHash = hashBytecode(dtx.bytecode);
          deployments.push({ blockNumber, txHash: dtx.id, contractAddr: deployedAddr, deployer, bytecodeHash });
        }
      }
    }

    // Single transaction per block: txs + outputs + events + deployments + block metadata
    db.exec('BEGIN');
    try {
      for (const t of txRows) {
        insertTxStmt.run(
          t.txHash, t.blockNumber, t.txIndex, t.txType, t.fromAddress, t.contractAddress,
          t.gasUsed, t.specialGasUsed, t.burnedBitcoin, t.priorityFee, t.maxGasSat,
          t.failed, t.revertReason, t.calldata, t.calldataLength, t.senderPubKeyHash,
        );
      }
      for (const o of outputRows) {
        insertOutputStmt.run(o.txHash, o.outputIndex, o.valueSat !== null ? Number(o.valueSat) : null, o.scriptType, o.address);
      }
      for (const e of events) {
        insertEventStmt.run(
          e.blockNumber, e.txHash, e.contractAddress, e.eventName, e.logIndex,
          e.rawData, e.decodedJson ?? null, e.rawData.length,
        );
      }
      for (const d of deployments) {
        insertDeployStmt.run(
          d.blockNumber, d.txHash, d.contractAddr, d.deployer, d.bytecodeHash,
        );
      }
      const blockHash = String(block.hash ?? '');
      insertBlockStmt.run(blockNumber, blockHash || '', blockTimestamp, blockTxs.length);
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
      const chunkRange = Number(toBlock - fromBlock + 1n);
      const done = Number(bn - fromBlock + 1n);
      const pct = ((done / chunkRange) * 100).toFixed(1);
      const elapsedMs = Date.now() - startTime;
      const bps = (totalBlocks / (elapsedMs / 1000)).toFixed(1);
      const remaining = chunkRange - done;
      const etaSec = totalBlocks > 0 ? (remaining / (totalBlocks / (elapsedMs / 1000))) : 0;
      const bar = progressBar(done, chunkRange, 20);
      const chunkLine =
        ` Chunk   ${bar} ${pct.padStart(5)}%  block ${blockNumber}/${Number(toBlock)}  ` +
        `${bps} blk/s  ETA ${humanElapsed(etaSec)}  events: ${totalEvents}`;

      if (opts?.onProgress) {
        opts.onProgress(done, chunkLine);
      } else {
        log('INFO', 'scanner', chunkLine.trim());
      }
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
