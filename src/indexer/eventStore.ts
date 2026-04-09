/**
 * Universal event store for OPNET on-chain events.
 *
 * Stores ALL events from every interaction TX — unknown events preserved
 * raw (decoded_json = NULL) until an ABI decoder is registered.
 * UNIQUE(block_number, tx_hash, contract_address, event_name) ensures
 * idempotent re-scans via INSERT OR IGNORE.
 */

import type { DatabaseSync } from 'node:sqlite';

export interface EventRow {
  id: number;
  block_number: number;
  tx_hash: string;
  contract_address: string;
  event_name: string;
  event_raw: Buffer;
  decoded_json: string | null;
  data_length: number;
  created_at: number;
}

export interface EventInput {
  blockNumber: number;
  txHash: string;
  contractAddress: string;
  eventName: string;
  rawData: Buffer;
  decodedJson?: string | null;
}

export interface EventQuery {
  contract?: string;
  eventName?: string;
  fromBlock?: number;
  toBlock?: number;
}

export interface DailyVolume {
  /** ISO date string YYYY-MM-DD (estimated from block number). */
  date: string;
  /** Total swap volume for the day (stringified BigInt in token0 / amountIn units). */
  volume: string;
}

const INSERT_SQL = `
  INSERT OR IGNORE INTO events
    (block_number, tx_hash, contract_address, event_name, event_raw, decoded_json, data_length)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`;

/**
 * Insert a single event. Silently ignores duplicates (UNIQUE constraint).
 */
export function insertEvent(
  db: DatabaseSync,
  blockNumber: number,
  txHash: string,
  contractAddress: string,
  eventName: string,
  rawData: Buffer,
  decodedJson?: string | null,
): void {
  db.prepare(INSERT_SQL).run(
    blockNumber,
    txHash,
    contractAddress,
    eventName,
    rawData,
    decodedJson ?? null,
    rawData.length,
  );
}

/**
 * Batch insert events using a prepared statement inside a transaction.
 */
export function insertEventsBatch(db: DatabaseSync, events: EventInput[]): void {
  if (events.length === 0) return;

  const stmt = db.prepare(INSERT_SQL);

  db.exec('BEGIN');
  try {
    for (const e of events) {
      stmt.run(
        e.blockNumber,
        e.txHash,
        e.contractAddress,
        e.eventName,
        e.rawData,
        e.decodedJson ?? null,
        e.rawData.length,
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Query events with optional filters. All filters are ANDed.
 */
export function queryEvents(db: DatabaseSync, filters: EventQuery): EventRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filters.contract) {
    clauses.push('contract_address = ?');
    params.push(filters.contract);
  }
  if (filters.eventName) {
    clauses.push('event_name = ?');
    params.push(filters.eventName);
  }
  if (filters.fromBlock !== undefined) {
    clauses.push('block_number >= ?');
    params.push(filters.fromBlock);
  }
  if (filters.toBlock !== undefined) {
    clauses.push('block_number <= ?');
    params.push(filters.toBlock);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const sql = `SELECT * FROM events ${where} ORDER BY block_number, id`;

  return db.prepare(sql).all(...(params as import('node:sqlite').SQLInputValue[])) as unknown as EventRow[];
}

/**
 * Retroactively decode raw event data for a given contract+event combo.
 * Calls decoderFn on each matching row's event_raw and updates decoded_json.
 * Returns the number of rows updated.
 */
export function backfillDecoded(
  db: DatabaseSync,
  contractAddress: string,
  eventName: string,
  decoderFn: (rawData: Buffer) => Record<string, unknown> | null,
): number {
  const rows = db
    .prepare(
      `SELECT id, event_raw FROM events
       WHERE contract_address = ? AND event_name = ? AND decoded_json IS NULL`,
    )
    .all(contractAddress, eventName) as Array<{ id: number; event_raw: Buffer }>;

  if (rows.length === 0) return 0;

  const updateStmt = db.prepare('UPDATE events SET decoded_json = ? WHERE id = ?');
  let updated = 0;

  db.exec('BEGIN');
  try {
    for (const row of rows) {
      const decoded = decoderFn(row.event_raw);
      if (decoded !== null) {
        updateStmt.run(JSON.stringify(decoded), row.id);
        updated++;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return updated;
}

// ─── Block time constant ─────────────────────────────────────────────────────

const BLOCKS_PER_DAY = 144; // ~10 min per block → 144 blocks/day

/**
 * Aggregates daily swap volume for a pool from decoded swap events.
 *
 * For Motoswap pools: queries Swapped events where contract_address = poolAddress.
 * For NativeSwap pools: queries SwapExecuted events co-occurring with
 * Transferred events from the pool's token contract in the same TX.
 *
 * @param days Number of days to look back from the latest indexed block.
 * @returns Daily volumes sorted oldest-first (ascending date).
 */
export function getDailyVolume(
  db: DatabaseSync,
  poolAddress: string,
  days: number,
): DailyVolume[] {
  const pool = db.prepare('SELECT dex FROM pools WHERE address = ?').get(poolAddress) as
    | { dex: string }
    | undefined;
  if (!pool) return [];

  const maxBlockRow = db.prepare('SELECT MAX(block_number) as mb FROM events').get() as {
    mb: number | null;
  };
  const maxBlock = maxBlockRow?.mb ?? 0;
  if (maxBlock === 0) return [];

  const fromBlock = maxBlock - days * BLOCKS_PER_DAY;

  let swapEvents: Array<{ block_number: number; decoded_json: string }>;

  if (pool.dex === 'motoswap') {
    swapEvents = db
      .prepare(
        `SELECT block_number, decoded_json FROM events
         WHERE contract_address = ? AND event_name = 'Swapped'
           AND block_number >= ? AND decoded_json IS NOT NULL
         ORDER BY block_number`,
      )
      .all(poolAddress, fromBlock) as Array<{ block_number: number; decoded_json: string }>;
  } else {
    swapEvents = db
      .prepare(
        `SELECT e.block_number, e.decoded_json FROM events e
         WHERE e.event_name = 'SwapExecuted'
           AND e.block_number >= ?
           AND e.decoded_json IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM events e2
             WHERE e2.tx_hash = e.tx_hash
               AND e2.contract_address = ?
               AND e2.event_name = 'Transferred'
           )
         ORDER BY e.block_number`,
      )
      .all(fromBlock, poolAddress) as Array<{ block_number: number; decoded_json: string }>;
  }

  if (swapEvents.length === 0) return [];

  const buckets = new Map<number, bigint>();

  for (const evt of swapEvents) {
    const dayIndex = Math.floor((maxBlock - evt.block_number) / BLOCKS_PER_DAY);
    const decoded = JSON.parse(evt.decoded_json);

    let volume = 0n;
    if (pool.dex === 'motoswap') {
      const a0In = BigInt(decoded.amount0In || '0');
      const a0Out = BigInt(decoded.amount0Out || '0');
      volume = a0In > a0Out ? a0In : a0Out;
    } else {
      volume = BigInt(decoded.amountIn || '0');
    }

    const current = buckets.get(dayIndex) ?? 0n;
    buckets.set(dayIndex, current + volume);
  }

  const now = Date.now();
  const result: DailyVolume[] = [];

  for (const [dayIndex, vol] of [...buckets.entries()].sort((a, b) => b[0] - a[0])) {
    const dateMs = now - dayIndex * 24 * 60 * 60 * 1000;
    const date = new Date(dateMs).toISOString().split('T')[0]!;
    result.push({ date, volume: vol.toString() });
  }

  return result;
}
