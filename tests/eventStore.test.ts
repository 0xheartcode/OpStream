import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../src/core/db.js';
import {
  insertEvent,
  insertEventsBatch,
  queryEvents,
  backfillDecoded,
} from '../src/indexer/eventStore.js';
import type { DatabaseSync } from 'node:sqlite';

describe('eventStore', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  describe('insertEvent', () => {
    it('inserts an event and can be read back', () => {
      const raw = Buffer.from('deadbeef', 'hex');
      insertEvent(db, 100, 'tx1', 'contract1', 'Transferred', raw, '{"amount":"42"}');

      const row = db.prepare('SELECT * FROM events WHERE tx_hash = ?').get('tx1') as any;
      expect(row).toBeDefined();
      expect(row.block_number).toBe(100);
      expect(row.tx_hash).toBe('tx1');
      expect(row.contract_address).toBe('contract1');
      expect(row.event_name).toBe('Transferred');
      expect(row.data_length).toBe(4);
      expect(row.decoded_json).toBe('{"amount":"42"}');
    });

    it('stores event with null decoded_json', () => {
      const raw = Buffer.from('cafe', 'hex');
      insertEvent(db, 100, 'tx1', 'contract1', 'Unknown', raw);

      const row = db.prepare('SELECT * FROM events WHERE tx_hash = ?').get('tx1') as any;
      expect(row.decoded_json).toBeNull();
    });

    it('silently ignores duplicate (UNIQUE constraint)', () => {
      const raw = Buffer.from('aa', 'hex');
      insertEvent(db, 100, 'tx1', 'contract1', 'Transferred', raw);
      insertEvent(db, 100, 'tx1', 'contract1', 'Transferred', Buffer.from('bb', 'hex'));

      const rows = db.prepare('SELECT * FROM events WHERE tx_hash = ?').all('tx1') as any[];
      expect(rows.length).toBe(1);
      expect(rows[0].data_length).toBe(1);
    });

    it('allows same block+tx with different event names', () => {
      const raw = Buffer.from('aa', 'hex');
      insertEvent(db, 100, 'tx1', 'contract1', 'Transferred', raw);
      insertEvent(db, 100, 'tx1', 'contract1', 'Synced', raw);

      const rows = db.prepare('SELECT * FROM events WHERE tx_hash = ?').all('tx1') as any[];
      expect(rows.length).toBe(2);
    });
  });

  describe('insertEventsBatch', () => {
    it('inserts multiple events in a single batch', () => {
      const events = [
        { blockNumber: 100, txHash: 'tx1', contractAddress: 'c1', eventName: 'Transferred', rawData: Buffer.from('aa', 'hex') },
        { blockNumber: 100, txHash: 'tx2', contractAddress: 'c1', eventName: 'Synced', rawData: Buffer.from('bb', 'hex') },
        { blockNumber: 101, txHash: 'tx3', contractAddress: 'c2', eventName: 'Swapped', rawData: Buffer.from('cc', 'hex') },
      ];
      insertEventsBatch(db, events);

      const count = db.prepare('SELECT COUNT(*) as cnt FROM events').get() as any;
      expect(count.cnt).toBe(3);
    });

    it('handles empty array gracefully', () => {
      insertEventsBatch(db, []);
      const count = db.prepare('SELECT COUNT(*) as cnt FROM events').get() as any;
      expect(count.cnt).toBe(0);
    });

    it('deduplicates within batch via INSERT OR IGNORE', () => {
      const events = [
        { blockNumber: 100, txHash: 'tx1', contractAddress: 'c1', eventName: 'Transferred', rawData: Buffer.from('aa', 'hex') },
        { blockNumber: 100, txHash: 'tx1', contractAddress: 'c1', eventName: 'Transferred', rawData: Buffer.from('bb', 'hex') },
      ];
      insertEventsBatch(db, events);

      const count = db.prepare('SELECT COUNT(*) as cnt FROM events').get() as any;
      expect(count.cnt).toBe(1);
    });

    it('stores decoded_json when provided', () => {
      const events = [
        { blockNumber: 100, txHash: 'tx1', contractAddress: 'c1', eventName: 'Synced', rawData: Buffer.from('aa', 'hex'), decodedJson: '{"r0":"100"}' },
      ];
      insertEventsBatch(db, events);

      const row = db.prepare('SELECT decoded_json FROM events WHERE tx_hash = ?').get('tx1') as any;
      expect(row.decoded_json).toBe('{"r0":"100"}');
    });
  });

  describe('queryEvents', () => {
    beforeEach(() => {
      insertEventsBatch(db, [
        { blockNumber: 100, txHash: 'tx1', contractAddress: 'c1', eventName: 'Transferred', rawData: Buffer.from('aa', 'hex') },
        { blockNumber: 101, txHash: 'tx2', contractAddress: 'c1', eventName: 'Synced', rawData: Buffer.from('bb', 'hex') },
        { blockNumber: 102, txHash: 'tx3', contractAddress: 'c2', eventName: 'Transferred', rawData: Buffer.from('cc', 'hex') },
        { blockNumber: 200, txHash: 'tx4', contractAddress: 'c2', eventName: 'Swapped', rawData: Buffer.from('dd', 'hex') },
      ]);
    });

    it('returns all events when no filters', () => {
      const rows = queryEvents(db, {});
      expect(rows.length).toBe(4);
    });

    it('filters by contract', () => {
      const rows = queryEvents(db, { contract: 'c1' });
      expect(rows.length).toBe(2);
      expect(rows.every(r => r.contract_address === 'c1')).toBe(true);
    });

    it('filters by event name', () => {
      const rows = queryEvents(db, { eventName: 'Transferred' });
      expect(rows.length).toBe(2);
      expect(rows.every(r => r.event_name === 'Transferred')).toBe(true);
    });

    it('filters by block range', () => {
      const rows = queryEvents(db, { fromBlock: 101, toBlock: 102 });
      expect(rows.length).toBe(2);
      expect(rows[0].block_number).toBe(101);
      expect(rows[1].block_number).toBe(102);
    });

    it('combines contract + name + block range filters', () => {
      const rows = queryEvents(db, { contract: 'c2', eventName: 'Transferred', fromBlock: 100, toBlock: 150 });
      expect(rows.length).toBe(1);
      expect(rows[0].tx_hash).toBe('tx3');
    });

    it('returns empty array when no matches', () => {
      const rows = queryEvents(db, { contract: 'nonexistent' });
      expect(rows.length).toBe(0);
    });

    it('results are ordered by block_number', () => {
      const rows = queryEvents(db, {});
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i].block_number).toBeGreaterThanOrEqual(rows[i - 1].block_number);
      }
    });
  });

  describe('backfillDecoded', () => {
    it('decodes raw events and updates decoded_json', () => {
      insertEvent(db, 100, 'tx1', 'c1', 'Synced', Buffer.from('00000064000000c8', 'hex'));
      insertEvent(db, 101, 'tx2', 'c1', 'Synced', Buffer.from('000000c80000012c', 'hex'));

      const decoder = (raw: Buffer) => {
        const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        return {
          r0: view.getUint32(0).toString(),
          r1: view.getUint32(4).toString(),
        };
      };

      const count = backfillDecoded(db, 'c1', 'Synced', decoder);
      expect(count).toBe(2);

      const rows = queryEvents(db, { contract: 'c1', eventName: 'Synced' });
      expect(rows[0].decoded_json).not.toBeNull();
      const parsed = JSON.parse(rows[0].decoded_json!);
      expect(parsed.r0).toBe('100');
      expect(parsed.r1).toBe('200');
    });

    it('skips rows that already have decoded_json', () => {
      insertEvent(db, 100, 'tx1', 'c1', 'Synced', Buffer.from('aabb', 'hex'), '{"existing":true}');

      const count = backfillDecoded(db, 'c1', 'Synced', () => ({ new: true }));
      expect(count).toBe(0);

      const row = db.prepare('SELECT decoded_json FROM events WHERE tx_hash = ?').get('tx1') as any;
      expect(JSON.parse(row.decoded_json)).toEqual({ existing: true });
    });

    it('handles decoder returning null (malformed data)', () => {
      insertEvent(db, 100, 'tx1', 'c1', 'Synced', Buffer.from('aa', 'hex'));

      const decoder = (raw: Buffer) => {
        if (raw.length < 8) return null;
        return { ok: true };
      };

      const count = backfillDecoded(db, 'c1', 'Synced', decoder);
      expect(count).toBe(0);

      const row = db.prepare('SELECT decoded_json FROM events WHERE tx_hash = ?').get('tx1') as any;
      expect(row.decoded_json).toBeNull();
    });

    it('returns 0 when no matching events', () => {
      const count = backfillDecoded(db, 'nonexistent', 'Synced', () => ({ ok: true }));
      expect(count).toBe(0);
    });

    it('only updates events for the specified contract+event', () => {
      insertEvent(db, 100, 'tx1', 'c1', 'Synced', Buffer.from('aabb', 'hex'));
      insertEvent(db, 100, 'tx2', 'c2', 'Synced', Buffer.from('ccdd', 'hex'));
      insertEvent(db, 100, 'tx3', 'c1', 'Transferred', Buffer.from('eeff', 'hex'));

      backfillDecoded(db, 'c1', 'Synced', () => ({ decoded: true }));

      const c2Row = db.prepare('SELECT decoded_json FROM events WHERE tx_hash = ?').get('tx2') as any;
      expect(c2Row.decoded_json).toBeNull();

      const transferRow = db.prepare('SELECT decoded_json FROM events WHERE tx_hash = ?').get('tx3') as any;
      expect(transferRow.decoded_json).toBeNull();
    });
  });

});
