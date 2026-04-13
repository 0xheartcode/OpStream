/**
 * OpStream fast-sync client — imports data from a remote OpStream instance.
 *
 * Uses the /sync/status + /sync/export HTTP endpoints (see syncHandler.ts).
 * Each chunk is fetched as gzip-compressed NDJSON, decompressed automatically
 * by the fetch API, and bulk-inserted inside a single transaction.
 *
 * Usage (CLI):
 *   npx tsx src/main.ts sync [--source URL] [--secret SECRET]
 *
 * Falls back to env vars SYNC_SOURCE_URL and SYNC_SECRET when flags are absent.
 *
 * The importer is resumable: it reads the local scan_checkpoints.last_block
 * before each chunk, so a crashed mid-sync picks up where it left off.
 */

import { log } from '../core/logger.js';
import type { DbAdapter } from '../core/dbAdapter.js';
import { MAX_BLOCKS_PER_CHUNK } from '../rpc/syncHandler.js';

// ---------------------------------------------------------------------------
// Remote types
// ---------------------------------------------------------------------------

interface SyncStatus {
  fromBlock: number | null;
  tipBlock:  number | null;
  totalBlocks: number;
  totalTxs:    number;
  totalEvents: number;
}

interface NdjsonLine {
  t: 'b' | 'tx' | 'e' | 'dep' | 'out';
  d: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a base64 string back into a Buffer for BYTEA columns. */
function b64toBuffer(v: unknown): Buffer | null {
  if (typeof v !== 'string' || v === '') return null;
  return Buffer.from(v, 'base64');
}

function coerceInt(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return isNaN(n) ? null : Math.trunc(n);
}

async function fetchStatus(sourceUrl: string, secret: string | null): Promise<SyncStatus> {
  const headers: Record<string, string> = {};
  if (secret) headers['Authorization'] = `Bearer ${secret}`;

  const res = await fetch(`${sourceUrl}/sync/status`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`/sync/status returned HTTP ${res.status}`);
  return await res.json() as SyncStatus;
}

async function fetchChunk(
  sourceUrl: string,
  secret: string | null,
  from: number,
  to: number,
): Promise<NdjsonLine[]> {
  const headers: Record<string, string> = { 'Accept-Encoding': 'gzip' };
  if (secret) headers['Authorization'] = `Bearer ${secret}`;

  const res = await fetch(`${sourceUrl}/sync/export?from=${from}&to=${to}`, {
    headers,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`/sync/export?from=${from}&to=${to} returned HTTP ${res.status}`);

  const text = await res.text();
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as NdjsonLine);
}

// ---------------------------------------------------------------------------
// Bulk inserters — one per entity type
// ---------------------------------------------------------------------------

async function insertBlock(db: DbAdapter, d: Record<string, unknown>): Promise<void> {
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
      d['block_number'], d['block_hash'], d['timestamp'], d['tx_count'],
      d['opnet_tx_count'] ?? 0,
      d['previous_block_hash'], d['previous_block_checksum'], d['bits'],
      d['nonce'], d['version'], d['size'], d['weight'], d['stripped_size'],
      d['median_time'], d['checksum_root'], d['merkle_root'], d['storage_root'],
      d['receipt_root'], d['ema'], d['base_gas'], d['block_gas_used'],
      d['checksum_proofs'],
    ],
  );
}

async function insertTx(db: DbAdapter, d: Record<string, unknown>): Promise<void> {
  await db.run(
    `INSERT INTO transactions (
       tx_hash, block_number, tx_index, tx_type, from_address, contract_address,
       gas_used, special_gas_used, burned_bitcoin, priority_fee, max_gas_sat,
       failed, revert_reason, calldata, calldata_length, sender_pub_key_hash,
       receipt, receipt_proofs, created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (tx_hash) DO NOTHING`,
    [
      d['tx_hash'], d['block_number'], d['tx_index'], d['tx_type'],
      d['from_address'], d['contract_address'],
      d['gas_used'], d['special_gas_used'], d['burned_bitcoin'],
      d['priority_fee'], d['max_gas_sat'],
      coerceInt(d['failed']) ?? 0, d['revert_reason'],
      b64toBuffer(d['calldata']),
      d['calldata_length'],
      d['sender_pub_key_hash'],
      b64toBuffer(d['receipt']),
      d['receipt_proofs'],
      d['created_at'] ?? Math.floor(Date.now() / 1000),
    ],
  );
}

async function insertEvent(db: DbAdapter, d: Record<string, unknown>): Promise<void> {
  await db.run(
    `INSERT INTO events (
       block_number, tx_hash, contract_address, event_name,
       log_index, event_raw, data_length, created_at
     ) VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT (block_number, tx_hash, contract_address, event_name, log_index) DO NOTHING`,
    [
      d['block_number'], d['tx_hash'], d['contract_address'], d['event_name'],
      d['log_index'] ?? 0,
      b64toBuffer(d['event_raw']),
      d['data_length'],
      d['created_at'] ?? Math.floor(Date.now() / 1000),
    ],
  );
}

async function insertDep(db: DbAdapter, d: Record<string, unknown>): Promise<void> {
  await db.run(
    `INSERT INTO contract_deployments (
       block_number, tx_hash, contract_address, deployer, bytecode_hash, created_at
     ) VALUES (?,?,?,?,?,?)
     ON CONFLICT (tx_hash) DO NOTHING`,
    [
      d['block_number'], d['tx_hash'], d['contract_address'],
      d['deployer'], d['bytecode_hash'],
      d['created_at'] ?? Math.floor(Date.now() / 1000),
    ],
  );
}

async function insertOutput(db: DbAdapter, d: Record<string, unknown>): Promise<void> {
  await db.run(
    `INSERT INTO tx_outputs (tx_hash, output_index, value_sat, script_type, address)
     VALUES (?,?,?,?,?)
     ON CONFLICT (tx_hash, output_index) DO NOTHING`,
    [d['tx_hash'], d['output_index'], d['value_sat'], d['script_type'], d['address']],
  );
}

// ---------------------------------------------------------------------------
// Checkpoint helpers
// ---------------------------------------------------------------------------

async function getLocalCheckpoint(db: DbAdapter): Promise<number | null> {
  const row = await db.get<{ last_block: number | string }>(
    "SELECT last_block FROM scan_checkpoints WHERE scan_type = 'indexer'",
  );
  return row?.last_block !== undefined ? Number(row.last_block) : null;
}

async function setCheckpoint(db: DbAdapter, block: number): Promise<void> {
  await db.run(
    `INSERT INTO scan_checkpoints (scan_type, last_block, updated_at)
     VALUES ('indexer', ?, ?)
     ON CONFLICT (scan_type) DO UPDATE SET last_block = excluded.last_block, updated_at = excluded.updated_at`,
    [block, Math.floor(Date.now() / 1000)],
  );
}

// ---------------------------------------------------------------------------
// Progress bar (copied from bootstrap.ts pattern)
// ---------------------------------------------------------------------------

function progressBar(done: number, total: number, width = 30): string {
  const filled = Math.round((done / total) * width);
  return '[' + '='.repeat(filled) + '>'.padEnd(width - filled, '.') + ']';
}

// ---------------------------------------------------------------------------
// Main import loop
// ---------------------------------------------------------------------------

export interface SyncImportOptions {
  /** Override source URL (falls back to SYNC_SOURCE_URL env var). */
  sourceUrl?: string;
  /** Override secret (falls back to SYNC_SECRET env var). */
  secret?: string | null;
}

export interface SyncImportResult {
  blocksImported: number;
  alreadySynced:  boolean;
}

/**
 * Fetch data from a remote OpStream instance and insert it into `db`.
 * Resumable: reads local checkpoint before each chunk.
 */
export async function runSyncImport(
  db: DbAdapter,
  opts: SyncImportOptions = {},
): Promise<SyncImportResult> {
  const sourceUrl = (opts.sourceUrl ?? process.env['SYNC_SOURCE_URL'] ?? '').replace(/\/+$/, '');
  const secret    = opts.secret !== undefined ? opts.secret : (process.env['SYNC_SECRET'] ?? null);

  if (!sourceUrl) {
    throw new Error(
      'No sync source URL. Pass --source URL or set SYNC_SOURCE_URL in your .env.',
    );
  }

  log('INFO', 'sync', `Fetching status from ${sourceUrl}`);
  const status = await fetchStatus(sourceUrl, secret);

  if (status.fromBlock === null || status.tipBlock === null) {
    log('INFO', 'sync', 'Remote has no indexed data yet — nothing to sync');
    return { blocksImported: 0, alreadySynced: true };
  }

  // Coerce to numbers — Postgres BIGINT columns arrive as strings via JSON.
  const remoteFrom = Number(status.fromBlock);
  const remoteTip  = Number(status.tipBlock);

  const localCheckpointRaw = await getLocalCheckpoint(db);
  const localCheckpoint = localCheckpointRaw !== null ? Number(localCheckpointRaw) : null;

  // Determine where to start. If local is ahead, we're done.
  const startBlock = localCheckpoint !== null ? localCheckpoint + 1 : remoteFrom;

  if (startBlock > remoteTip) {
    log('INFO', 'sync', `Already synced up to block ${localCheckpoint ?? 'none'}, remote tip is ${remoteTip} — up to date`);
    return { blocksImported: 0, alreadySynced: true };
  }

  const totalToSync = remoteTip - startBlock + 1;
  log('INFO', 'sync', '');
  log('INFO', 'sync', `  OpStream Fast Sync`);
  log('INFO', 'sync', `  Source:         ${sourceUrl}`);
  log('INFO', 'sync', `  Remote tip:     ${remoteTip}  (${status.totalBlocks} blocks, ${status.totalTxs} txs, ${status.totalEvents} events)`);
  log('INFO', 'sync', `  Local start:    ${startBlock}${localCheckpoint !== null ? ` (resuming from ${localCheckpoint})` : ''}`);
  log('INFO', 'sync', `  Blocks to sync: ${totalToSync}`);
  log('INFO', 'sync', '');

  const startTime = Date.now();
  let blocksImported = 0;
  const isTTY = process.stdout.isTTY;

  for (let from = startBlock; from <= remoteTip; from += MAX_BLOCKS_PER_CHUNK) {
    const to = Math.min(from + MAX_BLOCKS_PER_CHUNK - 1, remoteTip);

    const lines = await fetchChunk(sourceUrl, secret, from, to);

    await db.transaction(async () => {
      for (const { t, d } of lines) {
        switch (t) {
          case 'b':   await insertBlock(db, d);  break;
          case 'tx':  await insertTx(db, d);     break;
          case 'e':   await insertEvent(db, d);  break;
          case 'dep': await insertDep(db, d);    break;
          case 'out': await insertOutput(db, d); break;
        }
      }
      // Advance checkpoint to end of this chunk
      await setCheckpoint(db, to);
    });

    blocksImported += to - from + 1;

    const elapsedSec = (Date.now() - startTime) / 1000;
    const bps        = elapsedSec > 0 ? (blocksImported / elapsedSec).toFixed(1) : '0';
    const pct        = ((blocksImported / totalToSync) * 100).toFixed(1);
    const bar        = progressBar(blocksImported, totalToSync);

    if (isTTY) {
      process.stdout.write(`\r\x1B[2K${bar} ${pct.padStart(5)}%  block ${to}/${remoteTip}  ${bps} blk/s`);
    } else {
      log('INFO', 'sync', `Progress: ${pct}%  block ${to}/${remoteTip}  ${bps} blk/s`);
    }
  }

  if (isTTY) process.stdout.write('\n');

  const elapsedSec = (Date.now() - startTime) / 1000;
  const bps = blocksImported > 0 ? (blocksImported / elapsedSec).toFixed(1) : '0';

  log('INFO', 'sync', '');
  log('INFO', 'sync', `  Sync complete`);
  log('INFO', 'sync', `  Blocks imported: ${blocksImported}`);
  log('INFO', 'sync', `  Time:            ${elapsedSec.toFixed(1)}s (${bps} blk/s)`);
  log('INFO', 'sync', '');

  return { blocksImported, alreadySynced: false };
}
