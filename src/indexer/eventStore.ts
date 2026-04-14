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
  /**
   * Filter by a single contract address, or an array of addresses (OR logic).
   * Accepts both 'address' (Ethereum convention) and 'contractAddress' (OpStream convention).
   */
  contract?: string | string[];
  /**
   * Filter by a single event name, or an array of event names (OR logic).
   * OpStream stores plain human-readable names (e.g. "Swapped") — no ABI hashing needed.
   */
  eventName?: string | string[];
  /** Return only events at or after this block number. */
  fromBlock?: number;
  /** Return only events at or before this block number. */
  toBlock?: number;
  /**
   * Maximum rows to return. Default: 1 000.
   * The server fetches limit+1 internally so hasMore can be set without a COUNT query.
   */
  limit?: number;
  /**
   * Cursor for keyset pagination — return only rows with id > afterId.
   * Set to items[items.length - 1].id from the previous page to fetch the next page.
   * Composes correctly with all other filters.
   */
  afterId?: number;
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

  // contract — single address or array (IN clause)
  if (filters.contract !== undefined) {
    const addrs = Array.isArray(filters.contract) ? filters.contract : [filters.contract];
    if (addrs.length === 1) {
      clauses.push('contract_address = ?');
      params.push(addrs[0]);
    } else if (addrs.length > 1) {
      clauses.push(`contract_address IN (${addrs.map(() => '?').join(', ')})`);
      params.push(...addrs);
    }
  }

  // eventName — single name or array (IN clause)
  if (filters.eventName !== undefined) {
    const names = Array.isArray(filters.eventName) ? filters.eventName : [filters.eventName];
    if (names.length === 1) {
      clauses.push('event_name = ?');
      params.push(names[0]);
    } else if (names.length > 1) {
      clauses.push(`event_name IN (${names.map(() => '?').join(', ')})`);
      params.push(...names);
    }
  }

  if (filters.fromBlock !== undefined) {
    clauses.push('block_number >= ?');
    params.push(filters.fromBlock);
  }
  if (filters.toBlock !== undefined) {
    clauses.push('block_number <= ?');
    params.push(filters.toBlock);
  }
  if (filters.afterId !== undefined) {
    clauses.push('id > ?');
    params.push(filters.afterId);
  }

  const where        = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const effectiveLimit = filters.limit ?? 1_000;
  const sql          = `SELECT * FROM events ${where} ORDER BY id LIMIT ${effectiveLimit}`;

  return db.all<EventRow>(sql, params);
}
