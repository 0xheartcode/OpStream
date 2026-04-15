/**
 * Pure block scanner — scans blocks, stores events, tracks deployments.
 *
 * This module knows nothing about pools, reserves, candles, or DEX-specific
 * logic. It is the generic Layer 2 engine that powers both bootstrap and
 * live indexing.
 *
 * All SQL uses ANSI ON CONFLICT syntax (compatible with SQLite 3.24+ and Postgres).
 */

import { createHash } from 'node:crypto';
import {
  type InteractionTransaction,
  type DeploymentTransaction,
  OPNetTransactionTypes,
  type TransactionBase,
} from 'opnet';
import { log } from '../core/logger.js';
import type { DbAdapter } from '../core/dbAdapter.js';
import type { EventInput } from './eventStore.js';
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
  /** ITransactionReceipt.receipt raw bytes (archival field for btc_getTransactionReceipt). */
  receipt: Buffer | null;
  /** ITransactionReceipt.receiptProofs serialized as JSON string array. */
  receiptProofsJson: string | null;
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
  transactionsStored: number;
  deploymentsFound: number;
}

/** Callback invoked for each event as it's indexed. Used for WebSocket broadcast. */
export type OnEventCallback = (event: {
  blockNumber:     number;
  txHash:          string;
  contractAddress: string;
  eventName:       string;
  logIndex:        number;
  blockTimestamp:  number;
  txIndex:         number;
  fromAddress:     string | null;
  gasUsed:         string | null;
  burnedBitcoin:   string | null;
  failed:          boolean;
  revertReason:    string | null;
  eventRaw:        string;
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
  /**
   * When true, store every tx in a block including plain Bitcoin txs that
   * have no OPNET interaction (`tx_type = 'generic'`), and all of their
   * outputs. Defaults to false — in typical OPNET blocks generics account
   * for ~95% of rows and nobody queries them, so persisting them turns
   * tx_outputs into the dominant table for no practical gain.
   *
   * Set via OPSTREAM_STORE_GENERIC_TXS=true when you genuinely need a
   * full-archive copy of the chain.
   */
  storeGenericTxs?: boolean;
  /**
   * Called once per block after all events have been committed and dispatched.
   * Receives the block number, all tx hashes in the block, and the block timestamp.
   * Used to cross-link confirmed txids with the mempool poller.
   */
  onBlockConfirmed?: (params: { blockNumber: number; txHashes: string[]; blockTimestamp: number }) => void;
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

function hashBytecode(bytecode: Uint8Array | string | undefined): string | null {
  if (!bytecode) return null;
  const buf = bytecode instanceof Uint8Array ? Buffer.from(bytecode) : Buffer.from(bytecode, 'hex');
  if (buf.length === 0) return null;
  return createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Checkpoint helpers
// ---------------------------------------------------------------------------

const SCAN_TYPE_INDEXER = 'indexer';

const SQL_GET_CHECKPOINT = `SELECT last_block FROM scan_checkpoints WHERE scan_type = ?`;
const SQL_SAVE_CHECKPOINT = `
  INSERT INTO scan_checkpoints (scan_type, last_block, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT (scan_type) DO UPDATE SET
    last_block = excluded.last_block,
    updated_at = excluded.updated_at
`;

export async function getCheckpoint(db: DbAdapter): Promise<bigint> {
  const row = await db.get<{ last_block: number }>(SQL_GET_CHECKPOINT, [SCAN_TYPE_INDEXER]);
  return row ? BigInt(row.last_block) : 0n;
}

export async function saveCheckpoint(db: DbAdapter, block: bigint): Promise<void> {
  await db.run(SQL_SAVE_CHECKPOINT, [SCAN_TYPE_INDEXER, Number(block), Math.floor(Date.now() / 1000)]);
}

// ---------------------------------------------------------------------------
// Block helpers (reorg detection + metadata)
// ---------------------------------------------------------------------------

const SQL_SAVE_BLOCK = `
  INSERT INTO blocks (
    block_number, block_hash, timestamp, tx_count, opnet_tx_count,
    previous_block_hash, previous_block_checksum, bits, nonce, version,
    size, weight, stripped_size, median_time,
    checksum_root, merkle_root, storage_root, receipt_root,
    ema, base_gas, block_gas_used, checksum_proofs
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (block_number) DO UPDATE SET
    block_hash              = excluded.block_hash,
    timestamp               = excluded.timestamp,
    tx_count                = excluded.tx_count,
    opnet_tx_count          = excluded.opnet_tx_count,
    previous_block_hash     = excluded.previous_block_hash,
    previous_block_checksum = excluded.previous_block_checksum,
    bits                    = excluded.bits,
    nonce                   = excluded.nonce,
    version                 = excluded.version,
    size                    = excluded.size,
    weight                  = excluded.weight,
    stripped_size           = excluded.stripped_size,
    median_time             = excluded.median_time,
    checksum_root           = excluded.checksum_root,
    merkle_root             = excluded.merkle_root,
    storage_root            = excluded.storage_root,
    receipt_root            = excluded.receipt_root,
    ema                     = excluded.ema,
    base_gas                = excluded.base_gas,
    block_gas_used          = excluded.block_gas_used,
    checksum_proofs         = excluded.checksum_proofs
`;
const SQL_GET_BLOCK_HASH = `SELECT block_hash FROM blocks WHERE block_number = ?`;

/** Archival header fields from IBlockCommon, serialized for the scanner to pass to saveBlock. */
export interface ArchivalBlockFields {
  previousBlockHash?:     string | null;
  previousBlockChecksum?: string | null;
  bits?:                  string | null;
  nonce?:                 number | null;
  version?:               number | null;
  size?:                  number | null;
  weight?:                number | null;
  strippedSize?:          number | null;
  medianTime?:            number | null;
  checksumRoot?:          string | null;
  merkleRoot?:            string | null;
  storageRoot?:           string | null;
  receiptRoot?:           string | null;
  ema?:                   string | null;
  baseGas?:               string | null;
  blockGasUsed?:          string | null;
  /** checksumProofs is an array of [index, proofHashes[]]; stored as JSON. */
  checksumProofsJson?:    string | null;
}

/**
 * Persist a block row.
 *
 * @param txCount       Raw Bitcoin block size — all txs in the block, OPNET or
 *                      not. Matches upstream btc_getBlockByNumber's txCount
 *                      field. Pass null when unknown.
 * @param opnetTxCount  OPNET-relevant txs actually persisted by the scanner
 *                      (interaction + deployment). OpStream-local metric.
 * @param archival      Optional archival header fields from IBlockCommon —
 *                      needed for faithful upstream-shape responses.
 */
export async function saveBlock(
  db: DbAdapter,
  blockNumber: number,
  blockHash: string,
  timestamp: number | null,
  txCount: number | null,
  opnetTxCount: number = 0,
  archival: ArchivalBlockFields = {},
): Promise<void> {
  await db.run(SQL_SAVE_BLOCK, [
    blockNumber, blockHash, timestamp, txCount, opnetTxCount,
    archival.previousBlockHash     ?? null,
    archival.previousBlockChecksum ?? null,
    archival.bits                  ?? null,
    archival.nonce                 ?? null,
    archival.version               ?? null,
    archival.size                  ?? null,
    archival.weight                ?? null,
    archival.strippedSize          ?? null,
    archival.medianTime            ?? null,
    archival.checksumRoot          ?? null,
    archival.merkleRoot            ?? null,
    archival.storageRoot           ?? null,
    archival.receiptRoot           ?? null,
    archival.ema                   ?? null,
    archival.baseGas               ?? null,
    archival.blockGasUsed          ?? null,
    archival.checksumProofsJson    ?? null,
  ]);
}

export async function getBlockHash(db: DbAdapter, blockNumber: number): Promise<string | null> {
  const row = await db.get<{ block_hash: string }>(SQL_GET_BLOCK_HASH, [blockNumber]);
  return row?.block_hash ?? null;
}

export async function deleteBlockDataFrom(db: DbAdapter, fromBlock: number): Promise<void> {
  await db.run(
    `DELETE FROM tx_outputs WHERE tx_hash IN (SELECT tx_hash FROM transactions WHERE block_number >= ?)`,
    [fromBlock],
  );
  await db.run(`DELETE FROM events       WHERE block_number >= ?`, [fromBlock]);
  await db.run(`DELETE FROM transactions WHERE block_number >= ?`, [fromBlock]);
  await db.run(`DELETE FROM blocks       WHERE block_number >= ?`, [fromBlock]);
  await db.run(`DELETE FROM contract_deployments WHERE block_number >= ?`, [fromBlock]);
}

// ---------------------------------------------------------------------------
// Prepared SQL strings (ANSI — compatible with SQLite 3.24+ and Postgres)
// ---------------------------------------------------------------------------

const SQL_INSERT_EVENT = `
  INSERT INTO events
    (block_number, tx_hash, contract_address, event_name, log_index, event_raw, data_length)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT DO NOTHING
`;

const SQL_INSERT_TX = `
  INSERT INTO transactions
    (tx_hash, block_number, tx_index, tx_type, from_address, contract_address,
     gas_used, special_gas_used, burned_bitcoin, priority_fee, max_gas_sat,
     failed, revert_reason, calldata, calldata_length, sender_pub_key_hash,
     receipt, receipt_proofs)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT DO NOTHING
`;

const SQL_INSERT_OUTPUT = `
  INSERT INTO tx_outputs (tx_hash, output_index, value_sat, script_type, address)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT DO NOTHING
`;

const SQL_INSERT_DEPLOY = `
  INSERT INTO contract_deployments
    (block_number, tx_hash, contract_address, deployer, bytecode_hash)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT DO NOTHING
`;

// ---------------------------------------------------------------------------
// Core scanner
// ---------------------------------------------------------------------------

/**
 * Scan a range of blocks, store all events and token deployments.
 *
 * This is the pure, generic scanner — no DEX knowledge, no pool discovery.
 * It fetches each block from RPC and stores raw event bytes. Decoding is the
 * consumer's job (e.g. op-index reads event_raw and applies its decoder registry).
 *
 * All writes for a single block are batched in one transaction to avoid
 * lock contention and improve throughput.
 */
export async function scanBlockRange(
  db: DbAdapter,
  client: OpnetRpcClient,
  fromBlock: bigint,
  toBlock: bigint,
  opts?: ScanOptions,
): Promise<ScanResult> {
  const minIntervalMs = opts?.minIntervalMs ?? 0;
  const onEvent = opts?.onEvent;
  const onBlockConfirmed = opts?.onBlockConfirmed;
  const storeGenericTxs = opts?.storeGenericTxs ?? false;
  const startTime = Date.now();
  let lastCallTime = 0;
  let totalEvents = 0;
  let totalTransactions = 0;
  let totalDeployments = 0;
  let totalBlocks = 0;

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
    const blockTimestamp = block.time;
    const events: (EventInput & {
      logIndex:       number;
      blockTimestamp: number;
      txIndex:        number;
      fromAddress:    string | null;
      gasUsed:        string | null;
      burnedBitcoin:  string | null;
      failed:         boolean;
      revertReason:   string | null;
    })[] = [];
    const txRows: TxRow[] = [];
    const deployments: Array<{ blockNumber: number; txHash: string; contractAddr: string; deployer: string; bytecodeHash: string | null }> = [];

    const blockTxs = block.transactions as TransactionBase<OPNetTransactionTypes>[];
    const outputRows: OutputRow[] = [];

    for (let txIndex = 0; txIndex < blockTxs.length; txIndex++) {
      const tx = blockTxs[txIndex]!;

      const txAsInteraction = tx as InteractionTransaction;
      const fromAddress  = txAsInteraction.from          ? String(txAsInteraction.from) : null;
      const contractAddr = txAsInteraction.contractAddress ?? null;
      const gasUsedStr       = tx.gasUsed       != null ? String(tx.gasUsed)       : null;
      const burnedBitcoinStr = tx.burnedBitcoin != null ? String(tx.burnedBitcoin) : null;
      const txType =
        tx.OPNetType === OPNetTransactionTypes.Interaction ? 'interaction' :
        tx.OPNetType === OPNetTransactionTypes.Deployment   ? 'deployment'  :
        'generic';

      // Skip generic (non-OPNET) txs entirely when not in full-archive mode.
      // In typical OPNET blocks these are ~95% of the transactions and nothing
      // in the query surface uses them, so persisting them bloats the DB ~10x
      // for no practical value. Opt in with storeGenericTxs=true when you need
      // a complete chain archive.
      if (txType === 'generic' && !storeGenericTxs) continue;

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

      // Archival receipt fields — receipt bytes + per-tx merkle proofs.
      // These are exposed by the SDK on TransactionBase via the
      // ITransactionReceipt mixin; we persist them so the RPC server can
      // answer btc_getTransactionReceipt locally with the exact upstream
      // shape. Empty arrays / absent values store as NULL, not empty string.
      const receiptBytes = (tx as unknown as { receipt?: Uint8Array | string })['receipt'];
      let receiptBuf: Buffer | null = null;
      if (receiptBytes instanceof Uint8Array && receiptBytes.length > 0) {
        receiptBuf = Buffer.from(receiptBytes);
      } else if (typeof receiptBytes === 'string' && receiptBytes.length > 0) {
        receiptBuf = Buffer.from(receiptBytes, 'hex');
      }
      const receiptProofsArr = (tx as unknown as { receiptProofs?: string[] })['receiptProofs'];
      const receiptProofsJson = Array.isArray(receiptProofsArr) && receiptProofsArr.length > 0
        ? JSON.stringify(receiptProofsArr)
        : null;

      txRows.push({
        txHash:          tx.id,
        blockNumber,
        txIndex,
        txType,
        fromAddress,
        contractAddress: contractAddr,
        gasUsed:         gasUsedStr,
        specialGasUsed:  tx.specialGasUsed != null ? String(tx.specialGasUsed) : null,
        burnedBitcoin:   burnedBitcoinStr,
        priorityFee:     tx.priorityFee    != null ? String(tx.priorityFee)    : null,
        maxGasSat:       tx.maxGasSat      != null ? String(tx.maxGasSat)      : null,
        failed:          tx.failed ? 1 : 0,
        revertReason:    tx.revert ?? null,
        calldata,
        calldataLength,
        senderPubKeyHash,
        receipt:         receiptBuf,
        receiptProofsJson,
      });

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
            events.push({
              blockNumber,
              txHash:         itx.id,
              contractAddress: evContractAddr,
              eventName:      event.type,
              logIndex:       logIndex++,
              rawData,
              blockTimestamp,
              txIndex,
              fromAddress,
              gasUsed:        gasUsedStr,
              burnedBitcoin:  burnedBitcoinStr,
              failed:         tx.failed,
              revertReason:   tx.revert ?? null,
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

    // Single transaction per block: all writes or none
    try {
      await db.transaction(async () => {
        for (const t of txRows) {
          await db.run(SQL_INSERT_TX, [
            t.txHash, t.blockNumber, t.txIndex, t.txType, t.fromAddress, t.contractAddress,
            t.gasUsed, t.specialGasUsed, t.burnedBitcoin, t.priorityFee, t.maxGasSat,
            t.failed, t.revertReason, t.calldata, t.calldataLength, t.senderPubKeyHash,
            t.receipt, t.receiptProofsJson,
          ]);
        }
        for (const o of outputRows) {
          await db.run(SQL_INSERT_OUTPUT, [
            o.txHash, o.outputIndex, o.valueSat !== null ? Number(o.valueSat) : null, o.scriptType, o.address,
          ]);
        }
        for (const e of events) {
          await db.run(SQL_INSERT_EVENT, [
            e.blockNumber, e.txHash, e.contractAddress, e.eventName, e.logIndex,
            e.rawData, e.rawData.length,
          ]);
        }
        for (const d of deployments) {
          await db.run(SQL_INSERT_DEPLOY, [
            d.blockNumber, d.txHash, d.contractAddr, d.deployer, d.bytecodeHash,
          ]);
        }
        // tx_count = raw Bitcoin block size (upstream-compatible).
        // opnet_tx_count = OPNET txs we actually stored (interaction + deployment).
        // Archival header fields are pulled from the SDK block object via an
        // untyped cast — opnet's Block class exposes IBlockCommon but the
        // exported type we use here is narrowed.
        const b = block as unknown as {
          previousBlockHash?:     string;
          previousBlockChecksum?: string;
          bits?:                  string;
          nonce?:                 number | bigint;
          version?:               number;
          size?:                  number;
          weight?:                number;
          strippedSize?:          number;
          medianTime?:            number;
          checksumRoot?:          string;
          merkleRoot?:            string;
          storageRoot?:           string;
          receiptRoot?:           string;
          ema?:                   string | bigint;
          baseGas?:               string | bigint;
          gasUsed?:               string | bigint;
          checksumProofs?:        unknown;
        };
        await db.run(SQL_SAVE_BLOCK, [
          blockNumber,
          String(block.hash ?? ''),
          blockTimestamp,
          blockTxs.length,
          txRows.length,
          b.previousBlockHash     ?? null,
          b.previousBlockChecksum ?? null,
          b.bits                  ?? null,
          b.nonce != null ? Number(b.nonce) : null,
          b.version               ?? null,
          b.size                  ?? null,
          b.weight                ?? null,
          b.strippedSize          ?? null,
          b.medianTime            ?? null,
          b.checksumRoot          ?? null,
          b.merkleRoot            ?? null,
          b.storageRoot           ?? null,
          b.receiptRoot           ?? null,
          b.ema     != null ? String(b.ema)     : null,
          b.baseGas != null ? String(b.baseGas) : null,
          b.gasUsed != null ? String(b.gasUsed) : null,
          b.checksumProofs != null ? JSON.stringify(b.checksumProofs) : null,
        ]);
      });
    } catch (err) {
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
          blockNumber:     e.blockNumber,
          txHash:          e.txHash,
          contractAddress: e.contractAddress,
          eventName:       e.eventName,
          logIndex:        e.logIndex,
          blockTimestamp:  e.blockTimestamp,
          txIndex:         e.txIndex,
          fromAddress:     e.fromAddress,
          gasUsed:         e.gasUsed,
          burnedBitcoin:   e.burnedBitcoin,
          failed:          e.failed,
          revertReason:    e.revertReason,
          eventRaw:        '0x' + e.rawData.toString('hex'),
        });
      }
    }

    if (onBlockConfirmed) {
      onBlockConfirmed({
        blockNumber,
        txHashes:       txRows.map((t) => t.txHash),
        blockTimestamp,
      });
    }

    totalEvents += events.length;
    totalTransactions += txRows.length;
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

  await saveCheckpoint(db, toBlock);

  const elapsedSec = (Date.now() - startTime) / 1000;
  const totalRange = Number(toBlock - fromBlock + 1n);
  const bps = totalRange > 0 ? (totalBlocks / elapsedSec).toFixed(1) : '0';
  log('INFO', 'scanner',
    `Synced ${Number(fromBlock)}..${Number(toBlock)}  ` +
    `${totalBlocks} blocks in ${humanElapsed(elapsedSec)} (${bps} blk/s)  ` +
    `events: ${totalEvents}  transactions: ${totalTransactions}`,
  );

  return {
    eventsStored: totalEvents,
    blocksScanned: totalBlocks,
    transactionsStored: totalTransactions,
    deploymentsFound: totalDeployments,
  };
}
