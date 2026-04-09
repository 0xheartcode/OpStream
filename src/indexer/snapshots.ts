/**
 * Reserve snapshot storage — append-only history of pool reserves.
 *
 * Every reserve change (bootstrap discovery, live watcher poll, activity detection)
 * is recorded so we can reconstruct price history and backtest strategies.
 */

import { DatabaseSync } from 'node:sqlite';

export type SnapshotSource = 'bootstrap' | 'watcher' | 'scanner';

/**
 * Insert a reserve snapshot. Silently ignores duplicates
 * (same pool + block + source) via INSERT OR IGNORE.
 */
export function insertSnapshot(
  db: DatabaseSync,
  poolAddress: string,
  blockNumber: bigint,
  reserve0: string,
  reserve1: string,
  source: SnapshotSource,
  impliedPrice: number | null,
): void {
  db.prepare(`
    INSERT OR IGNORE INTO reserve_snapshots
      (pool_address, block_number, reserve0, reserve1, implied_price, source)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(poolAddress, Number(blockNumber), reserve0, reserve1, impliedPrice, source);
}

/**
 * Compute the implied mid-price from reserves, adjusted for decimals.
 *
 * - NativeSwap (BTC/Token): token1 per BTC = (reserve1 / 10^d1) / (reserve0 / 10^8)
 * - Motoswap (Token/Token): token1 per token0 = (reserve1 / 10^d1) / (reserve0 / 10^d0)
 *
 * Returns null if either reserve is zero.
 */
export function computeImpliedPrice(
  reserve0: string,
  reserve1: string,
  dex: 'nativeswap' | 'motoswap',
  token0Decimals: number,
  token1Decimals: number,
): number | null {
  const r0 = Number(reserve0);
  const r1 = Number(reserve1);
  if (r0 === 0 || r1 === 0) return null;

  const d0 = dex === 'nativeswap' ? 8 : token0Decimals;
  const d1 = token1Decimals;

  return (r1 / 10 ** d1) / (r0 / 10 ** d0);
}

/**
 * Delete snapshots older than `keepDays`, retaining at least one per pool per day
 * (the one with the highest block number). Returns number of rows deleted.
 */
export function pruneOldSnapshots(db: DatabaseSync, keepDays: number): number {
  const cutoff = Math.floor(Date.now() / 1000) - keepDays * 86400;

  const result = db.prepare(`
    DELETE FROM reserve_snapshots
    WHERE created_at < ?
      AND id NOT IN (
        SELECT MAX(id) FROM reserve_snapshots
        WHERE created_at < ?
        GROUP BY pool_address, created_at / 86400
      )
  `).run(cutoff, cutoff);

  return (result as { changes: number }).changes;
}
