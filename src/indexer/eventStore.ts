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

