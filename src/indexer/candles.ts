/**
 * Price candle aggregation (OHLCV) from reserve snapshots.
 *
 * Reads reserve_snapshots, computes implied price OHLCV candles at
 * configurable intervals (10m, 1h, 1d), and upserts to price_candles table.
 *
 * Block-based bucketing: Bitcoin blocks are ~10 min apart.
 *   10m = 1 block, 1h = 6 blocks, 1d = 144 blocks.
 *
 * Volume is estimated as the sum of absolute reserve0 changes between
 * consecutive snapshots within each period.
 */

import { DatabaseSync } from 'node:sqlite';

export type CandleInterval = '10m' | '1h' | '1d';

export interface CandleRow {
  pool_address: string;
  interval: string;
  period_start: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number;
}

/** Blocks per interval (Bitcoin ~10 min block time). */
const BLOCKS_PER_INTERVAL: Record<CandleInterval, number> = {
  '10m': 1,
  '1h': 6,
  '1d': 144,
};

/**
 * Returns the period start block for a given block number and interval.
 */
export function periodStart(blockNumber: number, interval: CandleInterval): number {
  const bpi = BLOCKS_PER_INTERVAL[interval];
  return Math.floor(blockNumber / bpi) * bpi;
}

interface SnapshotRow {
  block_number: number;
  reserve0: string;
  reserve1: string;
  implied_price: number | null;
}

/**
 * Aggregate reserve snapshots into OHLCV candles for a given pool and interval.
 *
 * Reads snapshots in [fromBlock, toBlock], groups by period, computes OHLCV,
 * and upserts into price_candles (INSERT OR REPLACE on UNIQUE constraint).
 */
export function aggregateCandles(
  db: DatabaseSync,
  poolAddress: string,
  interval: CandleInterval,
  fromBlock: number,
  toBlock: number,
): void {
  const bpi = BLOCKS_PER_INTERVAL[interval];

  const snapshots = db.prepare(`
    SELECT block_number, reserve0, reserve1, implied_price
    FROM reserve_snapshots
    WHERE pool_address = ? AND block_number >= ? AND block_number <= ?
    ORDER BY block_number ASC
  `).all(poolAddress, fromBlock, toBlock) as unknown as SnapshotRow[];

  if (snapshots.length === 0) return;

  const periods = new Map<number, SnapshotRow[]>();
  for (const snap of snapshots) {
    const ps = Math.floor(snap.block_number / bpi) * bpi;
    let group = periods.get(ps);
    if (!group) {
      group = [];
      periods.set(ps, group);
    }
    group.push(snap);
  }

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO price_candles
      (pool_address, interval, period_start, open, high, low, close, volume)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const [ps, snaps] of periods) {
    const prices = snaps
      .map(s => s.implied_price)
      .filter((p): p is number => p !== null);

    const open = prices.length > 0 ? prices[0] : null;
    const close = prices.length > 0 ? prices[prices.length - 1] : null;
    const high = prices.length > 0 ? Math.max(...prices) : null;
    const low = prices.length > 0 ? Math.min(...prices) : null;

    let volume = 0;
    for (let i = 1; i < snaps.length; i++) {
      const prev = BigInt(snaps[i - 1].reserve0);
      const curr = BigInt(snaps[i].reserve0);
      const delta = curr > prev ? curr - prev : prev - curr;
      volume += Number(delta);
    }

    upsert.run(poolAddress, interval, ps, open, high, low, close, volume);
  }
}

/**
 * Query candles for a pool at a given interval, ordered by period descending.
 */
export function getCandles(
  db: DatabaseSync,
  poolAddress: string,
  interval: CandleInterval,
  limit: number,
): CandleRow[] {
  return db.prepare(`
    SELECT pool_address, interval, period_start, open, high, low, close, volume
    FROM price_candles
    WHERE pool_address = ? AND interval = ?
    ORDER BY period_start DESC
    LIMIT ?
  `).all(poolAddress, interval, limit) as unknown as CandleRow[];
}
