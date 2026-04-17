/**
 * OpStream batch bootstrap — imports data from a remote OpStream instance
 * using the opstream_getBlockRange JSON-RPC method.
 *
 * Alternative to /sync/export (syncImport.ts): uses JSON-RPC batching instead
 * of NDJSON streaming. Useful for testing throughput, or when the remote does
 * not expose /sync/export.
 *
 * Key differences vs /sync/export:
 *   - tx_outputs NOT included (opstream_getBlockRange doesn't return them)
 *   - Configurable batch size (BATCH_SIZE, default 100, server cap 1000)
 *   - Same sliding-window concurrency as syncImport (BATCH_CONCURRENCY, default 8)
 *
 * CLI: npx tsx src/main.ts batch [--source URL] [--batch-size N] [--concurrency N]
 */

import { log } from '../core/logger.js';
import type { DbAdapter } from '../core/dbAdapter.js';

// ---------------------------------------------------------------------------
// Wire types — matches opstream_getBlockRange response shape
// ---------------------------------------------------------------------------

interface BatchEvent {
  contractAddress: string;
  type:            string;
  data:            string;  // base64
}

interface BatchTx {
  hash:             string;
  blockNumber:      string;  // hex "0x…"
  index:            number;
  OPNetType:        string;
  from:             string | null;
  contractAddress:  string | null;
  gasUsed:          string;  // hex "0x…"
  burnedBitcoin:    string;  // hex "0x…"
  priorityFee:      string;  // hex "0x…"
  specialGasUsed:   string;  // hex "0x…"
  calldata:         string | null;  // base64
  receipt:          string | null;  // base64
  receiptProofs:    string[];
  senderPubKeyHash: string | null;  // base64
  revert?:          string | null;
  events:           BatchEvent[];
}

interface BatchDep {
  txHash:          string;
  contractAddress: string;
  deployer:        string | null;
  bytecodeHash:    string | null;
}

interface BatchBlock {
  // Block header — blockRowToUpstream camelCase shape
  hash:                  string;
  height:                string;       // decimal string
  time:                  number | null;
  txCount:               number | null;
  previousBlockHash:     string | null;
  previousBlockChecksum: string | null;
  bits:                  string | null;
  nonce:                 number | null;
  version:               number | null;
  size:                  number | null;
  weight:                number | null;
  strippedSize:          number | null;
  medianTime:            number | null;
  checksumRoot:          string | null;
  merkleRoot:            string | null;
  storageRoot:           string | null;
  receiptRoot:           string | null;
  ema:                   string | null;
  baseGas:               string | null;
  gasUsed:               string | null;  // block_gas_used
  checksumProofs:        unknown;
  transactions:          BatchTx[] | string[];
  deployments:           BatchDep[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a 0x hex string back to a decimal string for DB storage. */
function hexToDecStr(h: string | null | undefined): string | null {
  if (!h || h === '0x0' || h === '0x') return null;
  try { return BigInt(h).toString(); } catch { return null; }
}

function progressBar(done: number, total: number, width = 30): string {
  const filled = Math.round((done / total) * width);
  return '[' + '='.repeat(filled) + '>'.padEnd(width - filled, '.') + ']';
}

function humanElapsed(sec: number): string {
  if (sec < 60)   return `${sec.toFixed(0)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${(sec % 60).toFixed(0)}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

// ---------------------------------------------------------------------------
// DB inserters
// ---------------------------------------------------------------------------

async function saveBlock(db: DbAdapter, b: BatchBlock): Promise<void> {
  const num = parseInt(b.height, 10);
  await db.run(
    `INSERT INTO blocks (
       block_number, block_hash, timestamp, tx_count, opnet_tx_count,
       previous_block_hash, previous_block_checksum, bits, nonce, version,
       size, weight, stripped_size, median_time,
       checksum_root, merkle_root, storage_root, receipt_root,
       ema, base_gas, block_gas_used, checksum_proofs
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (block_number) DO NOTHING`,
    [
      num, b.hash, b.time, b.txCount,
      Array.isArray(b.transactions) ? b.transactions.length : 0,
      b.previousBlockHash, b.previousBlockChecksum, b.bits,
      b.nonce, b.version, b.size, b.weight, b.strippedSize,
      b.medianTime,
      b.checksumRoot, b.merkleRoot, b.storageRoot, b.receiptRoot,
      b.ema, b.baseGas, b.gasUsed,
      b.checksumProofs != null ? JSON.stringify(b.checksumProofs) : null,
    ],
  );
}

async function saveTx(db: DbAdapter, t: BatchTx, blockNum: number): Promise<void> {
  const calldataBuf = t.calldata ? Buffer.from(t.calldata, 'base64') : null;
  const receiptBuf  = t.receipt  ? Buffer.from(t.receipt,  'base64') : null;
  const senderHex   = t.senderPubKeyHash
    ? Buffer.from(t.senderPubKeyHash, 'base64').toString('hex')
    : null;

  await db.run(
    `INSERT INTO transactions (
       tx_hash, block_number, tx_index, tx_type, from_address, contract_address,
       gas_used, special_gas_used, burned_bitcoin, priority_fee, max_gas_sat,
       failed, revert_reason, calldata, calldata_length, sender_pub_key_hash,
       receipt, receipt_proofs, created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (tx_hash) DO NOTHING`,
    [
      t.hash, blockNum, t.index, t.OPNetType,
      t.from ?? null,
      t.contractAddress ?? null,
      hexToDecStr(t.gasUsed),
      hexToDecStr(t.specialGasUsed),
      hexToDecStr(t.burnedBitcoin),
      hexToDecStr(t.priorityFee),
      null,  // max_gas_sat not included in opstream_getBlockRange
      t.revert !== undefined ? 1 : 0,
      t.revert ?? null,
      calldataBuf,
      calldataBuf ? calldataBuf.length : null,
      senderHex,
      receiptBuf,
      t.receiptProofs?.length ? JSON.stringify(t.receiptProofs) : null,
      Math.floor(Date.now() / 1000),
    ],
  );
}

async function saveEvent(
  db: DbAdapter,
  e: BatchEvent,
  txHash: string,
  blockNum: number,
  logIndex: number,
): Promise<void> {
  const rawBuf = Buffer.from(e.data, 'base64');
  await db.run(
    `INSERT INTO events (
       block_number, tx_hash, contract_address, event_name,
       log_index, event_raw, data_length, created_at
     ) VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT (block_number, tx_hash, contract_address, event_name, log_index) DO NOTHING`,
    [
      blockNum, txHash, e.contractAddress, e.type,
      logIndex, rawBuf, rawBuf.length,
      Math.floor(Date.now() / 1000),
    ],
  );
}

async function saveDep(db: DbAdapter, d: BatchDep, blockNum: number): Promise<void> {
  await db.run(
    `INSERT INTO contract_deployments (
       block_number, tx_hash, contract_address, deployer, bytecode_hash, created_at
     ) VALUES (?,?,?,?,?,?)
     ON CONFLICT (tx_hash) DO NOTHING`,
    [
      blockNum, d.txHash, d.contractAddress,
      d.deployer ?? null, d.bytecodeHash ?? null,
      Math.floor(Date.now() / 1000),
    ],
  );
}

async function setCheckpoint(db: DbAdapter, block: number): Promise<void> {
  await db.run(
    `INSERT INTO scan_checkpoints (scan_type, last_block, updated_at)
     VALUES ('indexer', ?, ?)
     ON CONFLICT (scan_type) DO UPDATE SET last_block = excluded.last_block, updated_at = excluded.updated_at`,
    [block, Math.floor(Date.now() / 1000)],
  );
}

async function getLocalCheckpoint(db: DbAdapter): Promise<number | null> {
  const row = await db.get<{ last_block: number | string }>(
    "SELECT last_block FROM scan_checkpoints WHERE scan_type = 'indexer'",
  );
  return row?.last_block !== undefined ? Number(row.last_block) : null;
}

// ---------------------------------------------------------------------------
// Chunk fetcher
// ---------------------------------------------------------------------------

async function fetchChunk(
  sourceUrl: string,
  secret: string | null,
  from: number,
  to: number,
): Promise<BatchBlock[]> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret) headers['Authorization'] = `Bearer ${secret}`;

  const res = await fetch(sourceUrl, {
    method:  'POST',
    headers,
    body:    JSON.stringify({
      jsonrpc: '2.0',
      id:      1,
      method:  'opstream_getBlockRange',
      params:  [from, to, { includeTx: true, includeEvents: true }],
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) throw new Error(`opstream_getBlockRange [${from},${to}] returned HTTP ${res.status}`);

  const json = await res.json() as { result?: BatchBlock[]; error?: { message: string } };

  if (json.error) {
    const msg = json.error.message;
    // Auto-split on range-too-large errors (tx/event limit exceeded).
    // Recursively halve until the sub-ranges fit — same pattern Alchemy clients use.
    if ((msg.includes('transactions') || msg.includes('events')) && msg.includes('limit:') && from < to) {
      const mid = Math.floor((from + to) / 2);
      const left  = await fetchChunk(sourceUrl, secret, from, mid);
      const right = await fetchChunk(sourceUrl, secret, mid + 1, to);
      return [...left, ...right];
    }
    throw new Error(`opstream_getBlockRange [${from},${to}]: ${msg}`);
  }

  return json.result ?? [];
}

// ---------------------------------------------------------------------------
// Public options / result
// ---------------------------------------------------------------------------

export interface BatchScanOptions {
  /** Remote OpStream base URL (falls back to OPNET_RPC_URL env var). */
  sourceUrl?: string;
  /** Shared secret for /sync/* auth (falls back to SYNC_SECRET env var). */
  secret?: string | null;
  /** Blocks per opstream_getBlockRange request. Default 100, server cap 1000. */
  batchSize?: number;
  /** Parallel in-flight requests (sliding window). Default 8. */
  concurrency?: number;
  /** Override start block (ignores local checkpoint). */
  fromBlock?: number;
  /** Stop at this block inclusive (default: remote tip). */
  toBlock?: number;
}

export interface BatchScanResult {
  blocksScanned: number;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

/**
 * Bootstrap by fetching opstream_getBlockRange from a remote OpStream instance.
 *
 * Resumable: reads local checkpoint before starting so a crashed run picks
 * up where it left off. Uses a sliding-window prefetch to overlap network
 * latency with DB inserts.
 */
export async function runBatchScan(
  db: DbAdapter,
  opts: BatchScanOptions = {},
): Promise<BatchScanResult> {
  const sourceUrl = (
    opts.sourceUrl ?? process.env['OPNET_RPC_URL'] ?? ''
  ).replace(/\/+$/, '');

  if (!sourceUrl) {
    throw new Error('No source URL. Pass --source URL or set OPNET_RPC_URL.');
  }

  // Normalise: if the URL ends with /api/v1/json-rpc keep as-is, else append
  const rpcUrl = sourceUrl.includes('/api/v1/json-rpc')
    ? sourceUrl
    : sourceUrl + '/api/v1/json-rpc';

  const secret      = opts.secret !== undefined ? opts.secret : (process.env['SYNC_SECRET'] ?? null);
  const batchSize   = Math.min(opts.batchSize   ?? 100, 1000);
  const concurrency = Math.max(opts.concurrency ?? 8,   1);

  // Probe remote tip via /sync/status (fast, no auth on open instances)
  const base = rpcUrl.replace(/\/api\/v1\/json-rpc\/?$/, '').replace(/\/+$/, '');
  let remoteTip: number;
  try {
    const statusRes = await fetch(`${base}/sync/status`, {
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
      signal:  AbortSignal.timeout(10_000),
    });
    if (!statusRes.ok) throw new Error(`/sync/status HTTP ${statusRes.status}`);
    const status = await statusRes.json() as { tipBlock?: number | string | null; fromBlock?: number | string | null };
    if (status.tipBlock == null) throw new Error('remote has no indexed data');
    remoteTip = Number(status.tipBlock);
  } catch (e) {
    throw new Error(`Cannot reach remote OpStream at ${base}: ${String(e)}`);
  }

  const localCheckpoint = await getLocalCheckpoint(db);
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  const startBlock = opts.fromBlock !== undefined
    ? opts.fromBlock
    : (localCheckpoint !== null ? localCheckpoint + 1 : 0);

  const endBlock = opts.toBlock !== undefined
    ? Math.min(opts.toBlock, remoteTip)
    : remoteTip;

  if (startBlock > endBlock) {
    log('INFO', 'batch', `Already synced to block ${localCheckpoint ?? 'none'}, remote tip ${remoteTip} — up to date`);
    return { blocksScanned: 0 };
  }

  const totalToScan = endBlock - startBlock + 1;

  log('INFO', 'batch', '');
  log('INFO', 'batch', `  OpStream Batch Scan`);
  log('INFO', 'batch', `  Source:         ${rpcUrl}`);
  log('INFO', 'batch', `  Remote tip:     ${remoteTip}`);
  log('INFO', 'batch', `  Start block:    ${startBlock}${localCheckpoint !== null ? ` (resuming from ${localCheckpoint})` : ''}`);
  log('INFO', 'batch', `  End block:      ${endBlock}`);
  log('INFO', 'batch', `  Blocks to scan: ${totalToScan}`);
  log('INFO', 'batch', `  Batch size:     ${batchSize}`);
  log('INFO', 'batch', `  Concurrency:    ${concurrency}`);
  log('INFO', 'batch', '');

  const startTime   = Date.now();
  let blocksScanned = 0;
  const isTTY       = process.stdout.isTTY;

  // Sliding-window prefetch
  const pending = new Map<number, Promise<BatchBlock[]>>();
  let nextToFetch = startBlock;

  function enqueueNext(): void {
    while (pending.size < concurrency && nextToFetch <= endBlock) {
      const chunkTo = Math.min(nextToFetch + batchSize - 1, endBlock);
      pending.set(nextToFetch, fetchChunk(rpcUrl, secret, nextToFetch, chunkTo));
      nextToFetch += batchSize;
    }
  }

  enqueueNext();

  for (let from = startBlock; from <= endBlock; from += batchSize) {
    const to     = Math.min(from + batchSize - 1, endBlock);
    const blocks = await pending.get(from)!;
    pending.delete(from);
    enqueueNext();

    await db.transaction(async () => {
      for (const block of blocks) {
        const blockNum = parseInt(block.height, 10);

        await saveBlock(db, block);

        for (const tx of block.transactions as BatchTx[]) {
          await saveTx(db, tx, blockNum);

          let logIndex = 0;
          for (const event of tx.events ?? []) {
            await saveEvent(db, event, tx.hash, blockNum, logIndex++);
          }
        }

        for (const dep of block.deployments ?? []) {
          await saveDep(db, dep, blockNum);
        }
      }
      await setCheckpoint(db, to);
    });

    blocksScanned += to - from + 1;

    const elapsedSec = (Date.now() - startTime) / 1000;
    const bps        = elapsedSec > 0 ? (blocksScanned / elapsedSec).toFixed(1) : '0';
    const pct        = ((blocksScanned / totalToScan) * 100).toFixed(1);
    const bar        = progressBar(blocksScanned, totalToScan);
    const eta        = elapsedSec > 0 && blocksScanned > 0
      ? humanElapsed(((totalToScan - blocksScanned) / blocksScanned) * elapsedSec)
      : '?';

    if (isTTY) {
      process.stdout.write(
        `\r\x1B[2K${bar} ${pct.padStart(5)}%  block ${to}/${endBlock}  ${bps} blk/s  ETA ${eta}`,
      );
    } else {
      log('INFO', 'batch', `Progress: ${pct}%  block ${to}/${endBlock}  ${bps} blk/s`);
    }
  }

  if (isTTY) process.stdout.write('\n');

  const elapsedSec = (Date.now() - startTime) / 1000;
  const bps = blocksScanned > 0 ? (blocksScanned / elapsedSec).toFixed(1) : '0';

  log('INFO', 'batch', '');
  log('INFO', 'batch', `  Batch scan complete`);
  log('INFO', 'batch', `  Blocks scanned: ${blocksScanned}`);
  log('INFO', 'batch', `  Time:           ${humanElapsed(elapsedSec)} (${bps} blk/s)`);
  log('INFO', 'batch', '');

  return { blocksScanned };
}
