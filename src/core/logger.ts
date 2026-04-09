/**
 * Structured logger.
 *
 * Usage:
 *   import { log } from './logger.js';
 *   log('INFO', 'indexer', 'Loaded pools', { count: 42 });
 *
 * Environment:
 *   LOG_LEVEL   — minimum level to emit (DEBUG|INFO|WARN|ERROR). Default: INFO.
 *   LOG_FORMAT  — output format: 'json' for JSON lines, anything else for human-readable.
 *
 * WARN and ERROR always go to stderr; DEBUG and INFO go to stdout.
 *
 * Persistent error log:
 *   Call setLogDb(db) after DB is open to persist WARN/ERROR rows into error_log table.
 *   Call pruneErrorLog(db) on startup to remove rows older than 30 days.
 */

import type { DatabaseSync } from 'node:sqlite';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LEVEL_ORDER: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

// ── Persistent error log ──────────────────────────────────────────────────────

let _logDb: DatabaseSync | null = null;

/**
 * Bind a SQLite DB for persistent error/warning logging.
 * Call after openDb(); pass null to detach.
 */
export function setLogDb(db: DatabaseSync | null): void {
  _logDb = db;
}

/**
 * Delete error_log rows older than `olderThanDays` days.
 * Safe to call at startup — no-ops when the table is empty.
 */
export function pruneErrorLog(db: DatabaseSync, olderThanDays = 30): void {
  const cutoff = Math.floor(Date.now() / 1000) - olderThanDays * 86_400;
  db.prepare('DELETE FROM error_log WHERE created_at < ?').run(cutoff);
}

/**
 * Read recent error_log rows, newest first.
 */
export function queryRecentErrors(
  db: DatabaseSync,
  limit = 100,
): Array<{ id: number; timestamp: string; level: string; component: string; message: string; data_json: string | null }> {
  return db.prepare(
    'SELECT id, timestamp, level, component, message, data_json FROM error_log ORDER BY id DESC LIMIT ?',
  ).all(limit) as Array<{ id: number; timestamp: string; level: string; component: string; message: string; data_json: string | null }>;
}

function parseLevel(raw: string | undefined): LogLevel {
  const upper = (raw ?? '').toUpperCase();
  if (upper in LEVEL_ORDER) return upper as LogLevel;
  return 'INFO';
}

// Cache env values at module load to avoid process.env reads on every log call.
let _minLevel: LogLevel = parseLevel(process.env['LOG_LEVEL']);
let _isJsonFormat: boolean = process.env['LOG_FORMAT'] === 'json';

/**
 * Refresh the cached log configuration from process.env.
 * Call after modifying LOG_LEVEL or LOG_FORMAT at runtime (e.g. --verbose flag).
 */
export function refreshLogConfig(): void {
  _minLevel = parseLevel(process.env['LOG_LEVEL']);
  _isJsonFormat = process.env['LOG_FORMAT'] === 'json';
}

/**
 * Emit a structured log line.
 */
export function log(
  level: LogLevel,
  component: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[_minLevel]) return;

  const ts = new Date().toISOString();

  if (_isJsonFormat) {
    const entry: Record<string, unknown> = { ts, level, component, message };
    if (data) Object.assign(entry, data);
    const out = level === 'WARN' || level === 'ERROR' ? process.stderr : process.stdout;
    out.write(JSON.stringify(entry) + '\n');
  } else {
    const prefix = `${ts} [${level}] [${component}]`;
    const suffix = data ? ' ' + JSON.stringify(data) : '';
    const line = `${prefix} ${message}${suffix}`;
    if (level === 'WARN' || level === 'ERROR') {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  }

  // Persist WARN/ERROR to error_log table when a DB is bound
  if (_logDb && (level === 'WARN' || level === 'ERROR')) {
    try {
      _logDb.prepare(
        'INSERT INTO error_log (timestamp, level, component, message, data_json) VALUES (?, ?, ?, ?, ?)',
      ).run(ts, level, component, message, data ? JSON.stringify(data) : null);
    } catch {
      // Never let DB errors crash the logger
    }
  }
}

/** Convenience wrappers */
export const debug = (c: string, m: string, d?: Record<string, unknown>) => log('DEBUG', c, m, d);
export const info  = (c: string, m: string, d?: Record<string, unknown>) => log('INFO',  c, m, d);
export const warn  = (c: string, m: string, d?: Record<string, unknown>) => log('WARN',  c, m, d);
export const error = (c: string, m: string, d?: Record<string, unknown>) => log('ERROR', c, m, d);
