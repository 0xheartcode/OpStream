/**
 * DbAdapter — common interface for SQLite and Postgres backends.
 *
 * All methods are async so callers work identically regardless of dialect.
 * SqliteAdapter wraps the synchronous node:sqlite API (promises resolve
 * immediately); PostgresAdapter uses the `postgres` driver for genuine async.
 */

export interface DbAdapter {
  /** Execute a statement that produces no result rows (INSERT, UPDATE, DELETE). */
  run(sql: string, params?: unknown[]): Promise<void>;

  /** Fetch the first matching row, or undefined if none. */
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;

  /** Fetch all matching rows. */
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;

  /**
   * Execute raw DDL or multi-statement SQL (schema creation, PRAGMAs, etc.).
   * Not for parameterised queries — use run() for those.
   */
  exec(sql: string): Promise<void>;

  /**
   * Run fn inside a database transaction.
   * Commits on success, rolls back on throw, re-throws the original error.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;

  /** Close the underlying connection / pool. */
  close(): Promise<void>;

  /** Which SQL dialect this adapter speaks. Useful for dialect-specific DDL. */
  readonly dialect: 'sqlite' | 'postgres';
}
