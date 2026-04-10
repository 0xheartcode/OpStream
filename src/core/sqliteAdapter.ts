/**
 * SqliteAdapter — DbAdapter implementation backed by node:sqlite (DatabaseSync).
 *
 * All DbAdapter methods are async-compatible but resolve synchronously — the
 * SQLite API is blocking. Statement caching avoids re-preparing on every call,
 * matching the performance of the old prepare()-outside-loop pattern.
 */

import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { DbAdapter } from './dbAdapter.js';

export class SqliteAdapter implements DbAdapter {
  readonly dialect = 'sqlite' as const;

  private readonly _stmtCache = new Map<string, StatementSync>();

  constructor(
    /** The underlying DatabaseSync instance — exposed for logger and migrations. */
    public readonly rawDb: DatabaseSync,
  ) {}

  private stmt(sql: string): StatementSync {
    let s = this._stmtCache.get(sql);
    if (!s) {
      s = this.rawDb.prepare(sql);
      this._stmtCache.set(sql, s);
    }
    return s;
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    this.stmt(sql).run(...(params as Parameters<StatementSync['run']>));
  }

  async get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return this.stmt(sql).get(...(params as Parameters<StatementSync['get']>)) as T | undefined;
  }

  async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.stmt(sql).all(...(params as Parameters<StatementSync['all']>)) as T[];
  }

  async exec(sql: string): Promise<void> {
    this.rawDb.exec(sql);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.rawDb.exec('BEGIN');
    try {
      const result = await fn();
      this.rawDb.exec('COMMIT');
      return result;
    } catch (err) {
      this.rawDb.exec('ROLLBACK');
      throw err;
    }
  }

  async close(): Promise<void> {
    this.rawDb.close();
  }
}
