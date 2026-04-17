/**
 * Periodic metrics logger.
 *
 * Calls startMetricsLogger(config, db) once on startup to emit a structured
 * metrics log and persist counters every METRICS_INTERVAL_SECONDS seconds.
 *
 * The returned function cancels the timer (call on shutdown).
 */

import type Database from 'better-sqlite3';
import type { OpStreamConfig } from './config.js';
import { metrics } from './metrics.js';
import { log } from './logger.js';

/**
 * Start a periodic metrics logger.
 *
 * @returns A cancel function — call it on shutdown to clear the interval.
 */
export function startMetricsLogger(config: OpStreamConfig, db: Database.Database): () => void {
  const intervalMs = config.metricsIntervalSeconds * 1000;

  const timer = setInterval(() => {
    const snap = metrics.get();
    log('INFO', 'metrics', 'Periodic metrics snapshot', snap as unknown as Record<string, unknown>);
    metrics.persistToDb(db);
  }, intervalMs);

  // Don't keep the Node process alive solely for this timer.
  if (typeof (timer).unref === 'function') {
    (timer).unref();
  }

  return () => clearInterval(timer);
}
