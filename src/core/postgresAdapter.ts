/**
 * PostgresAdapter — DbAdapter implementation backed by the `postgres` package.
 *
 * SQL is written with `?` placeholders (SQLite style) and converted to
 * Postgres-style `$1, $2, ...` before execution. All dialect differences
 * (BLOB → BYTEA, INTEGER types, etc.) are handled via a separate Postgres
 * schema string — the runtime SQL is kept cross-compatible.
 *
 * Transactions use postgres.begin() which automatically scopes queries to
 * the transaction connection via a nested sql instance.
 */

import postgres from 'postgres';
import type { DbAdapter } from './dbAdapter.js';

// ---------------------------------------------------------------------------
// Postgres schema — equivalent to the SQLite SCHEMA in db.ts but typed for PG
// ---------------------------------------------------------------------------

export const POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS blocks (
  block_number BIGINT PRIMARY KEY,
  block_hash   TEXT NOT NULL,
  timestamp    BIGINT,
  tx_count     INTEGER NOT NULL DEFAULT 0,
  btc_tx_count INTEGER
);

CREATE TABLE IF NOT EXISTS transactions (
  tx_hash              TEXT NOT NULL PRIMARY KEY,
  block_number         BIGINT NOT NULL,
  tx_index             INTEGER NOT NULL,
  tx_type              TEXT NOT NULL,
  from_address         TEXT,
  contract_address     TEXT,
  gas_used             TEXT,
  special_gas_used     TEXT,
  burned_bitcoin       TEXT,
  priority_fee         TEXT,
  max_gas_sat          TEXT,
  failed               INTEGER NOT NULL DEFAULT 0,
  revert_reason        TEXT,
  calldata             BYTEA,
  calldata_length      INTEGER,
  sender_pub_key_hash  TEXT,
  created_at           BIGINT NOT NULL DEFAULT extract(epoch from now())::bigint
);

CREATE TABLE IF NOT EXISTS tx_outputs (
  tx_hash      TEXT NOT NULL,
  output_index INTEGER NOT NULL,
  value_sat    BIGINT,
  script_type  TEXT,
  address      TEXT,
  PRIMARY KEY (tx_hash, output_index)
);

CREATE TABLE IF NOT EXISTS scan_checkpoints (
  scan_type   TEXT NOT NULL PRIMARY KEY,
  last_block  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL DEFAULT extract(epoch from now())::bigint
);

CREATE TABLE IF NOT EXISTS events (
  id               BIGSERIAL PRIMARY KEY,
  block_number     BIGINT NOT NULL,
  tx_hash          TEXT NOT NULL,
  contract_address TEXT NOT NULL,
  event_name       TEXT NOT NULL,
  log_index        INTEGER NOT NULL DEFAULT 0,
  event_raw        BYTEA NOT NULL,
  decoded_json     TEXT,
  data_length      INTEGER NOT NULL,
  created_at       BIGINT NOT NULL DEFAULT extract(epoch from now())::bigint,
  UNIQUE(block_number, tx_hash, contract_address, event_name, log_index)
);

CREATE TABLE IF NOT EXISTS contract_deployments (
  id               BIGSERIAL PRIMARY KEY,
  block_number     BIGINT NOT NULL,
  tx_hash          TEXT NOT NULL UNIQUE,
  contract_address TEXT NOT NULL,
  deployer         TEXT,
  bytecode_hash    TEXT,
  created_at       BIGINT NOT NULL DEFAULT extract(epoch from now())::bigint
);

CREATE TABLE IF NOT EXISTS tokens (
  address    TEXT NOT NULL PRIMARY KEY,
  symbol     TEXT,
  name       TEXT,
  decimals   INTEGER NOT NULL DEFAULT 8,
  alt_address TEXT,
  updated_at BIGINT DEFAULT extract(epoch from now())::bigint
);

CREATE TABLE IF NOT EXISTS runtime_metrics (
  key        TEXT NOT NULL PRIMARY KEY,
  value      BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT DEFAULT extract(epoch from now())::bigint
);

CREATE TABLE IF NOT EXISTS error_log (
  id           BIGSERIAL PRIMARY KEY,
  timestamp    TEXT NOT NULL,
  level        TEXT NOT NULL,
  component    TEXT NOT NULL,
  message      TEXT NOT NULL,
  data_json    TEXT,
  block_number BIGINT,
  created_at   BIGINT NOT NULL DEFAULT extract(epoch from now())::bigint
);

CREATE INDEX IF NOT EXISTS idx_tx_outputs_address      ON tx_outputs(address);
CREATE INDEX IF NOT EXISTS idx_transactions_block      ON transactions(block_number);
CREATE INDEX IF NOT EXISTS idx_transactions_from       ON transactions(from_address);
CREATE INDEX IF NOT EXISTS idx_transactions_contract   ON transactions(contract_address);
CREATE INDEX IF NOT EXISTS idx_events_block            ON events(block_number);
CREATE INDEX IF NOT EXISTS idx_events_contract         ON events(contract_address);
CREATE INDEX IF NOT EXISTS idx_events_name             ON events(event_name);
CREATE INDEX IF NOT EXISTS idx_events_contract_name    ON events(contract_address, event_name);
CREATE INDEX IF NOT EXISTS idx_events_tx_hash          ON events(tx_hash);
CREATE INDEX IF NOT EXISTS idx_contract_deployments_block    ON contract_deployments(block_number);
CREATE INDEX IF NOT EXISTS idx_contract_deployments_contract ON contract_deployments(contract_address);
CREATE INDEX IF NOT EXISTS idx_contract_deployments_deployer ON contract_deployments(deployer);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tokens_alt_address  ON tokens(alt_address) WHERE alt_address IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_error_log_level         ON error_log(level);
CREATE INDEX IF NOT EXISTS idx_error_log_created       ON error_log(created_at);
`;

// ---------------------------------------------------------------------------
// Placeholder conversion: ? → $1, $2, ...
// ---------------------------------------------------------------------------

function toPositional(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// ---------------------------------------------------------------------------
// PostgresAdapter
// ---------------------------------------------------------------------------

export class PostgresAdapter implements DbAdapter {
  readonly dialect = 'postgres' as const;

  // Set to the transaction-scoped sql inside a begin() callback
  private _txSql: postgres.TransactionSql | null = null;

  constructor(private readonly sql: postgres.Sql) {}

  private get conn(): postgres.Sql | postgres.TransactionSql {
    return this._txSql ?? this.sql;
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    await this.conn.unsafe(toPositional(sql), params as postgres.ParameterOrJSON<never>[]);
  }

  async get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const rows = await this.conn.unsafe(toPositional(sql), params as postgres.ParameterOrJSON<never>[]);
    return rows[0] as T | undefined;
  }

  async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const rows = await this.conn.unsafe(toPositional(sql), params as postgres.ParameterOrJSON<never>[]);
    return rows as unknown as T[];
  }

  async exec(sql: string): Promise<void> {
    // Split on semicolons to execute multi-statement DDL safely
    const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
    for (const stmt of statements) {
      await this.sql.unsafe(stmt);
    }
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.sql.begin(async (txSql) => {
      this._txSql = txSql;
      try {
        return await fn();
      } finally {
        this._txSql = null;
      }
    }) as Promise<T>;
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Open a Postgres connection, apply schema, return a PostgresAdapter.
 * url format: postgres://user:pass@host:5432/dbname
 */
export async function openPostgresDb(url: string): Promise<PostgresAdapter> {
  const sql = postgres(url, {
    max: 5,
    idle_timeout: 30,
    connect_timeout: 10,
  });

  // Verify connectivity
  await sql`SELECT 1`;

  // Apply schema (idempotent — CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS)
  const adapter = new PostgresAdapter(sql);
  await adapter.exec(POSTGRES_SCHEMA);

  return adapter;
}
