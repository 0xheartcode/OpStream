/**
 * Universal event store for OPNET on-chain events.
 *
 * Stores raw event bytes from every interaction TX. ABI decoding is out of
 * scope — consumers (op-index) read event_raw from their own database and
 * produce derived state there.
 *
 * ON CONFLICT DO NOTHING ensures idempotent re-scans.
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
  data_length: number;
  created_at: number;
}

export interface EventInput {
  blockNumber: number;
  txHash: string;
  contractAddress: string;
  eventName: string;
  rawData: Buffer;
}

export interface EventQuery {
  contract?: string;
  eventName?: string;
  fromBlock?: number;
  toBlock?: number;
}

const INSERT_SQL = `
  INSERT INTO events
    (block_number, tx_hash, contract_address, event_name, event_raw, data_length)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT DO NOTHING
`;

export async function insertEvent(
  db: DbAdapter,
  blockNumber: number,
  txHash: string,
  contractAddress: string,
  eventName: string,
  rawData: Buffer,
): Promise<void> {
  await db.run(INSERT_SQL, [
    blockNumber,
    txHash,
    contractAddress,
    eventName,
    rawData,
    rawData.length,
  ]);
}

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
        e.rawData.length,
      ]);
    }
  });
}

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
