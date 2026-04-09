import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../src/core/db.js';
import { aggregateCandles, getCandles, periodStart } from '../src/indexer/candles.js';
import type { DatabaseSync } from 'node:sqlite';

function insertRawSnapshot(
  db: DatabaseSync,
  poolAddress: string,
  blockNumber: number,
  reserve0: string,
  reserve1: string,
  impliedPrice: number | null,
  source = 'bootstrap',
) {
  db.prepare(`
    INSERT OR IGNORE INTO reserve_snapshots
      (pool_address, block_number, reserve0, reserve1, implied_price, source)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(poolAddress, blockNumber, reserve0, reserve1, impliedPrice, source);
}

describe('periodStart', () => {
  it('10m interval: 1-block periods', () => {
    expect(periodStart(100, '10m')).toBe(100);
    expect(periodStart(101, '10m')).toBe(101);
  });

  it('1h interval: 6-block periods', () => {
    expect(periodStart(0, '1h')).toBe(0);
    expect(periodStart(5, '1h')).toBe(0);
    expect(periodStart(6, '1h')).toBe(6);
    expect(periodStart(11, '1h')).toBe(6);
    expect(periodStart(12, '1h')).toBe(12);
  });

  it('1d interval: 144-block periods', () => {
    expect(periodStart(0, '1d')).toBe(0);
    expect(periodStart(143, '1d')).toBe(0);
    expect(periodStart(144, '1d')).toBe(144);
    expect(periodStart(287, '1d')).toBe(144);
    expect(periodStart(288, '1d')).toBe(288);
  });
});

describe('aggregateCandles', () => {
  let db: DatabaseSync;
  const pool = 'pool_abc';

  beforeEach(() => {
    db = createTestDb();
  });

  it('creates OHLCV candle from multiple snapshots in one period', () => {
    insertRawSnapshot(db, pool, 10, '1000', '2000', 2.0);
    insertRawSnapshot(db, pool, 50, '1100', '3300', 3.0);
    insertRawSnapshot(db, pool, 80, '900', '900', 1.0);
    insertRawSnapshot(db, pool, 130, '1200', '3000', 2.5);

    aggregateCandles(db, pool, '1d', 0, 143);

    const candles = getCandles(db, pool, '1d', 10);
    expect(candles).toHaveLength(1);

    const c = candles[0];
    expect(c.period_start).toBe(0);
    expect(c.open).toBe(2.0);
    expect(c.high).toBe(3.0);
    expect(c.low).toBe(1.0);
    expect(c.close).toBe(2.5);
    expect(c.volume).toBe(600);
  });

  it('creates separate candles for different periods', () => {
    insertRawSnapshot(db, pool, 10, '1000', '5000', 5.0);
    insertRawSnapshot(db, pool, 100, '1200', '4800', 4.0);
    insertRawSnapshot(db, pool, 150, '2000', '8000', 4.0);
    insertRawSnapshot(db, pool, 250, '2500', '12500', 5.0);

    aggregateCandles(db, pool, '1d', 0, 287);

    const candles = getCandles(db, pool, '1d', 10);
    expect(candles).toHaveLength(2);
    expect(candles[0].period_start).toBe(144);
    expect(candles[1].period_start).toBe(0);
  });

  it('handles 1h interval (6 blocks per period)', () => {
    insertRawSnapshot(db, pool, 0, '500', '1000', 2.0);
    insertRawSnapshot(db, pool, 3, '600', '1800', 3.0);
    insertRawSnapshot(db, pool, 7, '400', '800', 2.0);

    aggregateCandles(db, pool, '1h', 0, 11);

    const candles = getCandles(db, pool, '1h', 10);
    expect(candles).toHaveLength(2);

    const c6 = candles[0];
    expect(c6.period_start).toBe(6);
    expect(c6.open).toBe(2.0);
    expect(c6.close).toBe(2.0);
    expect(c6.volume).toBe(0);

    const c0 = candles[1];
    expect(c0.period_start).toBe(0);
    expect(c0.open).toBe(2.0);
    expect(c0.close).toBe(3.0);
    expect(c0.high).toBe(3.0);
    expect(c0.low).toBe(2.0);
    expect(c0.volume).toBe(100);
  });

  it('handles 10m interval (1 block per period)', () => {
    insertRawSnapshot(db, pool, 100, '1000', '2000', 2.0);
    insertRawSnapshot(db, pool, 101, '1100', '2200', 2.0);

    aggregateCandles(db, pool, '10m', 100, 101);

    const candles = getCandles(db, pool, '10m', 10);
    expect(candles).toHaveLength(2);
    expect(candles[0].period_start).toBe(101);
    expect(candles[1].period_start).toBe(100);
    expect(candles[0].volume).toBe(0);
    expect(candles[1].volume).toBe(0);
  });

  it('does nothing when no snapshots exist', () => {
    aggregateCandles(db, pool, '1d', 0, 1000);
    const candles = getCandles(db, pool, '1d', 10);
    expect(candles).toHaveLength(0);
  });

  it('handles snapshots with null implied_price', () => {
    insertRawSnapshot(db, pool, 10, '1000', '0', null);
    insertRawSnapshot(db, pool, 50, '1500', '3000', 2.0);
    insertRawSnapshot(db, pool, 80, '800', '0', null);

    aggregateCandles(db, pool, '1d', 0, 143);

    const candles = getCandles(db, pool, '1d', 10);
    expect(candles).toHaveLength(1);
    expect(candles[0].open).toBe(2.0);
    expect(candles[0].close).toBe(2.0);
    expect(candles[0].high).toBe(2.0);
    expect(candles[0].low).toBe(2.0);
    expect(candles[0].volume).toBe(1200);
  });

  it('all-null prices produce null OHLC with zero volume for single snap', () => {
    insertRawSnapshot(db, pool, 10, '1000', '0', null);

    aggregateCandles(db, pool, '1d', 0, 143);

    const candles = getCandles(db, pool, '1d', 10);
    expect(candles).toHaveLength(1);
    expect(candles[0].open).toBeNull();
    expect(candles[0].high).toBeNull();
    expect(candles[0].low).toBeNull();
    expect(candles[0].close).toBeNull();
    expect(candles[0].volume).toBe(0);
  });

  it('upserts on re-aggregation (no duplicates)', () => {
    insertRawSnapshot(db, pool, 10, '1000', '2000', 2.0);
    aggregateCandles(db, pool, '1d', 0, 143);

    insertRawSnapshot(db, pool, 50, '1500', '4500', 3.0);
    aggregateCandles(db, pool, '1d', 0, 143);

    const candles = getCandles(db, pool, '1d', 10);
    expect(candles).toHaveLength(1);
    expect(candles[0].open).toBe(2.0);
    expect(candles[0].close).toBe(3.0);
    expect(candles[0].high).toBe(3.0);
    expect(candles[0].low).toBe(2.0);
  });

  it('respects fromBlock and toBlock range', () => {
    insertRawSnapshot(db, pool, 10, '1000', '2000', 2.0);
    insertRawSnapshot(db, pool, 200, '2000', '4000', 2.0);

    aggregateCandles(db, pool, '1d', 0, 143);

    const candles = getCandles(db, pool, '1d', 10);
    expect(candles).toHaveLength(1);
    expect(candles[0].period_start).toBe(0);
  });

  it('getCandles respects limit', () => {
    insertRawSnapshot(db, pool, 10, '1000', '2000', 2.0);
    insertRawSnapshot(db, pool, 150, '1100', '2200', 2.0);
    insertRawSnapshot(db, pool, 300, '1200', '2400', 2.0);

    aggregateCandles(db, pool, '1d', 0, 500);

    const candles = getCandles(db, pool, '1d', 2);
    expect(candles).toHaveLength(2);
    expect(candles[0].period_start).toBe(288);
    expect(candles[1].period_start).toBe(144);
  });

  it('handles multiple pools independently', () => {
    insertRawSnapshot(db, 'poolA', 10, '1000', '2000', 2.0);
    insertRawSnapshot(db, 'poolB', 10, '5000', '15000', 3.0);

    aggregateCandles(db, 'poolA', '1d', 0, 143);
    aggregateCandles(db, 'poolB', '1d', 0, 143);

    const candlesA = getCandles(db, 'poolA', '1d', 10);
    const candlesB = getCandles(db, 'poolB', '1d', 10);
    expect(candlesA).toHaveLength(1);
    expect(candlesB).toHaveLength(1);
    expect(candlesA[0].open).toBe(2.0);
    expect(candlesB[0].open).toBe(3.0);
  });

  it('volume uses BigInt arithmetic for large reserves', () => {
    const bigReserve0 = '900000000000000000';
    const bigReserve1 = '100000000000000000';
    insertRawSnapshot(db, pool, 10, bigReserve0, bigReserve1, 0.111);
    insertRawSnapshot(db, pool, 50, '910000000000000000', bigReserve1, 0.111);

    aggregateCandles(db, pool, '1d', 0, 143);

    const candles = getCandles(db, pool, '1d', 10);
    expect(candles).toHaveLength(1);
    expect(candles[0].volume).toBe(10000000000000000);
  });
});
