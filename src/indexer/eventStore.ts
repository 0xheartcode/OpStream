/**
 * Universal event store for OPNET on-chain events.
 *
 * Stores ALL events from every interaction TX — unknown events preserved
 * raw (decoded_json = NULL) until an ABI decoder is registered.
 * ON CONFLICT DO NOTHING ensures idempotent re-scans.
 *
 * All SQL uses ANSI ON CONFLICT syntax (compatible with SQLite 3.24+ and Postgres).
 */

import type { DbAdapter } from '../core/dbAdapter.js';

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
  INSERT INTO events
    (block_number, tx_hash, contract_address, event_name, event_raw, decoded_json, data_length)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT DO NOTHING
`;

/**
 * Insert a single event. Silently ignores duplicates (UNIQUE constraint).
 */
export async function insertEvent(
  db: DbAdapter,
  blockNumber: number,
  txHash: string,
  contractAddress: string,
  eventName: string,
  rawData: Buffer,
  decodedJson?: string | null,
): Promise<void> {
  await db.run(INSERT_SQL, [
    blockNumber,
    txHash,
    contractAddress,
    eventName,
    rawData,
    decodedJson ?? null,
    rawData.length,
  ]);
}

/**
 * Batch insert events inside a single transaction.
 */
export async function insertEventsBatch(db: DbAdapter, events: EventInput[]): Promise<void> {
  if (events.length === 0) return;

  await db.transaction(async () => {
    for (const e of events) {
      await db.run(INSERT_SQL, [
        e.blockNumber,
        e.txHash,
        e.contractAddress,
        e.eventName,
        e.rawData,
        e.decodedJson ?? null,
        e.rawData.length,
      ]);
    }
  });
}

/**
 * Query events with optional filters. All filters are ANDed.
 */
export async function queryEvents(db: DbAdapter, filters: EventQuery): Promise<EventRow[]> {
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

  return db.all<EventRow>(sql, params);
}

/**
 * Retroactively decode raw event data for a given contract+event combo.
 * Calls decoderFn on each matching row's event_raw and updates decoded_json.
 * Returns the number of rows updated.
 */
export async function backfillDecoded(
  db: DbAdapter,
  contractAddress: string,
  eventName: string,
  decoderFn: (rawData: Buffer) => Record<string, unknown> | null,
): Promise<number> {
  const rows = await db.all<{ id: number; event_raw: Buffer }>(
    `SELECT id, event_raw FROM events
     WHERE contract_address = ? AND event_name = ? AND decoded_json IS NULL`,
    [contractAddress, eventName],
  );

  if (rows.length === 0) return 0;

  let updated = 0;

  await db.transaction(async () => {
    for (const row of rows) {
      const decoded = decoderFn(row.event_raw);
      if (decoded !== null) {
        await db.run('UPDATE events SET decoded_json = ? WHERE id = ?', [
          JSON.stringify(decoded),
          row.id,
        ]);
        updated++;
      }
    }
  });

  return updated;
}
