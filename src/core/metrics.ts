/**
 * Runtime metrics counters for OpStream (indexer/scanner infrastructure only).
 *
 * Bot-specific metrics (strategy-specific) remain in your-app.
 *
 * Usage:
 *   import { metrics } from './metrics.js';
 *   metrics.increment('newPoolsFound');
 *   metrics.get(); // returns snapshot
 *
 * Persistence:
 *   metrics.loadFromDb(db)    — call on startup to restore last-run counters
 *   metrics.persistToDb(db)   — call on SIGINT / shutdown
 */

import type Database from 'better-sqlite3';

export type MetricKey =
  | 'reserveUpdates'
  | 'rpcErrors'
  | 'newPoolsFound'
  | 'poolsViable'
  | 'queueDrops'
  | 'blocksIndexedLive'
  | 'eventsIndexedLive';

export type MetricsSnapshot = Record<MetricKey, number>;

const METRIC_KEYS: MetricKey[] = [
  'reserveUpdates',
  'rpcErrors',
  'newPoolsFound',
  'poolsViable',
  'queueDrops',
  'blocksIndexedLive',
  'eventsIndexedLive',
];

function makeZeroCounters(): MetricsSnapshot {
  const obj: Partial<MetricsSnapshot> = {};
  for (const k of METRIC_KEYS) obj[k] = 0;
  return obj as MetricsSnapshot;
}

let _counters: MetricsSnapshot = makeZeroCounters();

export const metrics = {
  /** Increment a counter by 1 (or by `amount`). */
  increment(key: MetricKey, amount = 1): void {
    _counters[key] += amount;
  },

  /** Return a snapshot copy of all counters. */
  get(): MetricsSnapshot {
    return { ..._counters };
  },

  /** Reset all counters to zero (primarily for tests). */
  reset(): void {
    _counters = makeZeroCounters();
  },

  /**
   * Persist all counters to the `runtime_metrics` SQLite table.
   * Called on SIGINT / clean shutdown.
   */
  persistToDb(db: Database.Database): void {
    try {
      const snap = _counters;
      db.exec('BEGIN');
      try {
        db.exec(`DELETE FROM runtime_metrics`);
        const stmt = db.prepare(
          `INSERT INTO runtime_metrics (key, value) VALUES (?, ?)`,
        );
        for (const k of METRIC_KEYS) {
          stmt.run(k, snap[k]);
        }
        db.exec('COMMIT');
      } catch (innerErr) {
        db.exec('ROLLBACK');
        throw innerErr;
      }
    } catch (err) {
      process.stderr.write(
        `[metrics] DB write failure: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  },

  /**
   * Load counters from the `runtime_metrics` table.
   * Called once on startup to restore previous session's counts.
   */
  loadFromDb(db: Database.Database): void {
    try {
      const rows = db
        .prepare(`SELECT key, value FROM runtime_metrics`)
        .all() as { key: string; value: number }[];
      for (const row of rows) {
        if ((METRIC_KEYS as string[]).includes(row.key)) {
          _counters[row.key as MetricKey] = row.value;
        }
      }
    } catch {
      // Table may not exist yet (first run) — silently ignore
    }
  },
};

export { METRIC_KEYS };
