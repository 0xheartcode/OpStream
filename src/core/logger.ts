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
import type { DbAdapter } from './dbAdapter.js';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LEVEL_ORDER: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

// ── Persistent error log ──────────────────────────────────────────────────────

/**
 * Write-behind queue for async DB backends (Postgres).
 * log() stays synchronous — entries are queued and flushed on the next
 * event loop tick via setImmediate. Never throws; DB errors are silently swallowed.
 */
type LogEntry = [ts: string, level: string, component: string, message: string, dataJson: string | null];

let _logAdapter: DbAdapter | null = null;
let _logDb: DatabaseSync | null = null;      // SQLite fast path (kept for pruneErrorLog / queryRecentErrors)
const _logQueue: LogEntry[] = [];
let _flushScheduled = false;

function scheduleFlush(): void {
  if (_flushScheduled || !_logAdapter) return;
  _flushScheduled = true;
  setImmediate(() => {
    _flushScheduled = false;
    if (!_logAdapter || _logQueue.length === 0) return;
    const batch = _logQueue.splice(0);
    void _logAdapter.transaction(async () => {
      for (const [ts, level, component, message, dataJson] of batch) {
        await _logAdapter!.run(
          'INSERT INTO error_log (timestamp, level, component, message, data_json) VALUES (?, ?, ?, ?, ?)',
          [ts, level, component, message, dataJson],
        );
      }
    }).catch(() => { /* never let DB errors crash the logger */ });
  });
}

/**
 * Bind a DbAdapter for persistent error/warning logging.
 * Works with both SQLite and Postgres backends.
 * Call after openDb() / openPostgresDb(); pass null to detach.
 */
export function setLogAdapter(adapter: DbAdapter | null): void {
  _logAdapter = adapter;
  // Also set _logDb for the synchronous helpers when it's a SQLite adapter
  if (adapter && 'rawDb' in adapter) {
    _logDb = (adapter as { rawDb: DatabaseSync }).rawDb;
  } else {
    _logDb = null;
  }
}

/**
 * @deprecated Use setLogAdapter(adapter) instead.
 * Kept for backward compatibility — wraps DatabaseSync directly.
 */
export function setLogDb(db: DatabaseSync | null): void {
  _logDb = db;
  // Detach the adapter too so we don't double-write
  _logAdapter = null;
}

/**
 * Delete error_log rows older than `olderThanDays` days.
 * Requires SQLite backend (synchronous). No-op when Postgres is in use.
 */
export function pruneErrorLog(db: DatabaseSync, olderThanDays = 30): void {
  const cutoff = Math.floor(Date.now() / 1000) - olderThanDays * 86_400;
  db.prepare('DELETE FROM error_log WHERE created_at < ?').run(cutoff);
}

/**
 * Read recent error_log rows, newest first.
 * Requires SQLite backend (synchronous). Returns [] when Postgres is in use.
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

  // Persist WARN/ERROR to error_log table
  if (level === 'WARN' || level === 'ERROR') {
    const dataJson = data ? JSON.stringify(data) : null;
    if (_logAdapter) {
      // Async backend (Postgres or SQLite via adapter) — write-behind queue
      _logQueue.push([ts, level, component, message, dataJson]);
      scheduleFlush();
    } else if (_logDb) {
      // SQLite fast path — synchronous, zero overhead
      try {
        _logDb.prepare(
          'INSERT INTO error_log (timestamp, level, component, message, data_json) VALUES (?, ?, ?, ?, ?)',
        ).run(ts, level, component, message, dataJson);
      } catch {
        // Never let DB errors crash the logger
      }
    }
  }
}

/** Convenience wrappers */
export const debug = (c: string, m: string, d?: Record<string, unknown>) => log('DEBUG', c, m, d);
export const info  = (c: string, m: string, d?: Record<string, unknown>) => log('INFO',  c, m, d);
export const warn  = (c: string, m: string, d?: Record<string, unknown>) => log('WARN',  c, m, d);
export const error = (c: string, m: string, d?: Record<string, unknown>) => log('ERROR', c, m, d);
