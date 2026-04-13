import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../src/core/db.js';
import type { SqliteAdapter } from '../src/core/sqliteAdapter.js';
import type { DbAdapter } from '../src/core/dbAdapter.js';
import {
  insertEvent,
  insertEventsBatch,
  queryEvents,
} from '../src/indexer/eventStore.js';

describe('eventStore', () => {
  let db: DbAdapter;

  // Helper: direct SQL reads for test verification (bypasses the async adapter)
  function raw() { return (db as SqliteAdapter).rawDb; }
  function rawGet(sql: string, ...params: unknown[]): any {
    return raw().prepare(sql).get(...(params as [unknown])) as any;
  }
  function rawAll(sql: string, ...params: unknown[]): any[] {
    return raw().prepare(sql).all(...(params as [unknown])) as any[];
  }

  beforeEach(() => {
    db = createTestDb();
  });

  describe('insertEvent', () => {
    it('inserts an event and can be read back', async () => {
      const raw = Buffer.from('deadbeef', 'hex');
      await insertEvent(db, 100, 'tx1', 'contract1', 'Transferred', raw);

      const row = rawGet('SELECT * FROM events WHERE tx_hash = ?', 'tx1');
      expect(row).toBeDefined();
      expect(row.block_number).toBe(100);
      expect(row.tx_hash).toBe('tx1');
      expect(row.contract_address).toBe('contract1');
      expect(row.event_name).toBe('Transferred');
      expect(row.data_length).toBe(4);
    });

    it('persists raw event bytes verbatim', async () => {
      const raw = Buffer.from('cafebabe', 'hex');
      await insertEvent(db, 100, 'tx1', 'contract1', 'Unknown', raw);

      const row = rawGet('SELECT event_raw, data_length FROM events WHERE tx_hash = ?', 'tx1');
      expect(Buffer.from(row.event_raw).toString('hex')).toBe('cafebabe');
      expect(row.data_length).toBe(4);
    });

    it('silently ignores duplicate (UNIQUE constraint)', async () => {
      const raw = Buffer.from('aa', 'hex');
      await insertEvent(db, 100, 'tx1', 'contract1', 'Transferred', raw);
      await insertEvent(db, 100, 'tx1', 'contract1', 'Transferred', Buffer.from('bb', 'hex'));

      const rows = rawAll('SELECT * FROM events WHERE tx_hash = ?', 'tx1');
      expect(rows.length).toBe(1);
      expect(rows[0].data_length).toBe(1);
    });

    it('allows same block+tx with different event names', async () => {
      const raw = Buffer.from('aa', 'hex');
      await insertEvent(db, 100, 'tx1', 'contract1', 'Transferred', raw);
      await insertEvent(db, 100, 'tx1', 'contract1', 'Synced', raw);

      const rows = rawAll('SELECT * FROM events WHERE tx_hash = ?', 'tx1');
      expect(rows.length).toBe(2);
    });
  });

  describe('insertEventsBatch', () => {
    it('inserts multiple events in a single batch', async () => {
      const events = [
        { blockNumber: 100, txHash: 'tx1', contractAddress: 'c1', eventName: 'Transferred', rawData: Buffer.from('aa', 'hex') },
        { blockNumber: 100, txHash: 'tx2', contractAddress: 'c1', eventName: 'Synced', rawData: Buffer.from('bb', 'hex') },
        { blockNumber: 101, txHash: 'tx3', contractAddress: 'c2', eventName: 'Swapped', rawData: Buffer.from('cc', 'hex') },
      ];
      await insertEventsBatch(db, events);

      const count = rawGet('SELECT COUNT(*) as cnt FROM events');
      expect(count.cnt).toBe(3);
    });

    it('handles empty array gracefully', async () => {
      await insertEventsBatch(db, []);
      const count = rawGet('SELECT COUNT(*) as cnt FROM events');
      expect(count.cnt).toBe(0);
    });

    it('deduplicates within batch via ON CONFLICT DO NOTHING', async () => {
      const events = [
        { blockNumber: 100, txHash: 'tx1', contractAddress: 'c1', eventName: 'Transferred', rawData: Buffer.from('aa', 'hex') },
        { blockNumber: 100, txHash: 'tx1', contractAddress: 'c1', eventName: 'Transferred', rawData: Buffer.from('bb', 'hex') },
      ];
      await insertEventsBatch(db, events);

      const count = rawGet('SELECT COUNT(*) as cnt FROM events');
      expect(count.cnt).toBe(1);
    });
  });

  describe('queryEvents', () => {
    beforeEach(async () => {
      await insertEventsBatch(db, [
        { blockNumber: 100, txHash: 'tx1', contractAddress: 'c1', eventName: 'Transferred', rawData: Buffer.from('aa', 'hex') },
        { blockNumber: 101, txHash: 'tx2', contractAddress: 'c1', eventName: 'Synced', rawData: Buffer.from('bb', 'hex') },
        { blockNumber: 102, txHash: 'tx3', contractAddress: 'c2', eventName: 'Transferred', rawData: Buffer.from('cc', 'hex') },
        { blockNumber: 200, txHash: 'tx4', contractAddress: 'c2', eventName: 'Swapped', rawData: Buffer.from('dd', 'hex') },
      ]);
    });

    it('returns all events when no filters', async () => {
      const rows = await queryEvents(db, {});
      expect(rows.length).toBe(4);
    });

    it('filters by contract', async () => {
      const rows = await queryEvents(db, { contract: 'c1' });
      expect(rows.length).toBe(2);
      expect(rows.every(r => r.contract_address === 'c1')).toBe(true);
    });

    it('filters by event name', async () => {
      const rows = await queryEvents(db, { eventName: 'Transferred' });
      expect(rows.length).toBe(2);
      expect(rows.every(r => r.event_name === 'Transferred')).toBe(true);
    });

    it('filters by block range', async () => {
      const rows = await queryEvents(db, { fromBlock: 101, toBlock: 102 });
      expect(rows.length).toBe(2);
      expect(rows[0].block_number).toBe(101);
      expect(rows[1].block_number).toBe(102);
    });

    it('combines contract + name + block range filters', async () => {
      const rows = await queryEvents(db, { contract: 'c2', eventName: 'Transferred', fromBlock: 100, toBlock: 150 });
      expect(rows.length).toBe(1);
      expect(rows[0].tx_hash).toBe('tx3');
    });

    it('returns empty array when no matches', async () => {
      const rows = await queryEvents(db, { contract: 'nonexistent' });
      expect(rows.length).toBe(0);
    });

    it('results are ordered by block_number', async () => {
      const rows = await queryEvents(db, {});
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i].block_number).toBeGreaterThanOrEqual(rows[i - 1].block_number);
      }
    });
  });
});
