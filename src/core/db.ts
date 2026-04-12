/**
 * Database initializer for OpStream.
 *
 * Returns a DbAdapter — use SqliteAdapter (default, DB_PATH) or
 * PostgresAdapter (DB_URL). All scanner/indexer code is written against
 * DbAdapter so it works with either backend.
 *
 * Tables:
 *   blocks             Block metadata (hash, timestamp, tx_count)
 *   transactions       Every tx: sender, gas, fees, calldata, revert status
 *   tx_outputs         Bitcoin UTXO outputs per transaction (value flows)
 *   events             Every decoded event from every contract
 *   scan_checkpoints   Block scanning progress (resumable)
 *   contract_deployments  Contract creation tracking (chain-level)
 *   tokens             OP20 metadata cache — written by OpKit, not OpStream
 *   runtime_metrics    Performance counters
 *   error_log          Error tracking
 */

import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DbAdapter } from './dbAdapter.js';
import { SqliteAdapter } from './sqliteAdapter.js';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- tx_count is the raw Bitcoin block size (every tx in the block, OPNET or not)
-- and matches the txCount field returned by upstream btc_getBlockByNumber.
-- opnet_tx_count is the OPStream-local metric: count of OPNET-relevant txs
-- (interaction + deployment) actually persisted by the scanner. With
-- OPSTREAM_STORE_GENERIC_TXS off (default) tx_count is typically ~20x larger
-- than opnet_tx_count.
CREATE TABLE IF NOT EXISTS blocks (
  block_number    INTEGER PRIMARY KEY,
  block_hash      TEXT NOT NULL,
  timestamp       INTEGER,
  tx_count        INTEGER,
  opnet_tx_count  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS transactions (
  tx_hash              TEXT NOT NULL PRIMARY KEY,
  block_number         INTEGER NOT NULL,
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
  calldata             BLOB,
  calldata_length      INTEGER,
  sender_pub_key_hash  TEXT,
  created_at           INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS tx_outputs (
  tx_hash      TEXT NOT NULL,
  output_index INTEGER NOT NULL,
  value_sat    INTEGER,
  script_type  TEXT,
  address      TEXT,
  PRIMARY KEY (tx_hash, output_index)
);

CREATE INDEX IF NOT EXISTS idx_tx_outputs_address ON tx_outputs(address);

CREATE INDEX IF NOT EXISTS idx_transactions_block    ON transactions(block_number);
CREATE INDEX IF NOT EXISTS idx_transactions_from     ON transactions(from_address);
CREATE INDEX IF NOT EXISTS idx_transactions_contract ON transactions(contract_address);

CREATE TABLE IF NOT EXISTS scan_checkpoints (
  scan_type   TEXT NOT NULL PRIMARY KEY,
  last_block  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  block_number     INTEGER NOT NULL,
  tx_hash          TEXT NOT NULL,
  contract_address TEXT NOT NULL,
  event_name       TEXT NOT NULL,
  log_index        INTEGER NOT NULL DEFAULT 0,
  event_raw        BLOB NOT NULL,
  decoded_json     TEXT,
  data_length      INTEGER NOT NULL,
  created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(block_number, tx_hash, contract_address, event_name, log_index)
);

CREATE INDEX IF NOT EXISTS idx_events_block         ON events(block_number);
CREATE INDEX IF NOT EXISTS idx_events_contract      ON events(contract_address);
CREATE INDEX IF NOT EXISTS idx_events_name          ON events(event_name);
CREATE INDEX IF NOT EXISTS idx_events_contract_name ON events(contract_address, event_name);
CREATE INDEX IF NOT EXISTS idx_events_tx_hash       ON events(tx_hash);

-- Every OPNetTransactionTypes.Deployment tx, not just OP-20 tokens.
CREATE TABLE IF NOT EXISTS contract_deployments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  block_number     INTEGER NOT NULL,
  tx_hash          TEXT NOT NULL UNIQUE,
  contract_address TEXT NOT NULL,
  deployer         TEXT,
  bytecode_hash    TEXT,
  created_at       INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_contract_deployments_block    ON contract_deployments(block_number);
CREATE INDEX IF NOT EXISTS idx_contract_deployments_contract ON contract_deployments(contract_address);
CREATE INDEX IF NOT EXISTS idx_contract_deployments_deployer ON contract_deployments(deployer);

-- Owned by OpKit — OpStream never writes to this table.
-- Kept here so OpKit can co-locate its token metadata alongside OpStream data.
CREATE TABLE IF NOT EXISTS tokens (
  address    TEXT NOT NULL PRIMARY KEY,
  symbol     TEXT,
  name       TEXT,
  decimals   INTEGER NOT NULL DEFAULT 8,
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS runtime_metrics (
  key        TEXT NOT NULL PRIMARY KEY,
  value      INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS error_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp    TEXT NOT NULL,
  level        TEXT NOT NULL,
  component    TEXT NOT NULL,
  message      TEXT NOT NULL,
  data_json    TEXT,
  block_number INTEGER,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_error_log_level   ON error_log(level);
CREATE INDEX IF NOT EXISTS idx_error_log_created ON error_log(created_at);

CREATE TABLE IF NOT EXISTS mempool_pending (
  txid             TEXT NOT NULL PRIMARY KEY,
  raw_payload_hex  TEXT NOT NULL,
  contract_selector TEXT,
  decoded_json     TEXT,
  first_seen_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  confirmed_at     INTEGER,
  pruned_at        INTEGER
);

CREATE INDEX IF NOT EXISTS idx_mempool_pending_first_seen ON mempool_pending(first_seen_at);
CREATE INDEX IF NOT EXISTS idx_mempool_pending_confirmed  ON mempool_pending(confirmed_at);
`;

let _adapter: DbAdapter | null = null;
let _rawDb: Database.Database | null = null; // SQLite only — exposed for logger (sync writes to error_log)

/**
 * Applies schema migrations for columns added after initial deployment.
 * Safe to call on both new and existing databases.
 */
function runMigrations(db: Database.Database): void {
  try {
    // alt_address for dual address format support (op1sq bech32m + 0x hex)
    const tokenCols = db.prepare('PRAGMA table_info(tokens)').all() as Array<{ name: string }>;
    if (!tokenCols.some(c => c.name === 'alt_address')) {
      db.exec(`ALTER TABLE tokens ADD COLUMN alt_address TEXT`);
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tokens_alt_address ON tokens(alt_address) WHERE alt_address IS NOT NULL`);
    }

    // log_index on events — needed for deterministic ordering within a tx
    const eventCols = db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>;
    if (!eventCols.some(c => c.name === 'log_index')) {
      db.exec(`ALTER TABLE events ADD COLUMN log_index INTEGER NOT NULL DEFAULT 0`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_events_tx_hash ON events(tx_hash)`);
    }

    // transactions table — added after initial schema
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='transactions'`,
    ).all() as Array<{ name: string }>;
    if (tables.length === 0) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS transactions (
          tx_hash              TEXT NOT NULL PRIMARY KEY,
          block_number         INTEGER NOT NULL,
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
          calldata             BLOB,
          calldata_length      INTEGER,
          sender_pub_key_hash  TEXT,
          created_at           INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_transactions_block    ON transactions(block_number);
        CREATE INDEX IF NOT EXISTS idx_transactions_from     ON transactions(from_address);
        CREATE INDEX IF NOT EXISTS idx_transactions_contract ON transactions(contract_address);
      `);
    } else {
      // Add new columns if upgrading an existing transactions table
      const txCols = db.prepare('PRAGMA table_info(transactions)').all() as Array<{ name: string }>;
      const txColNames = new Set(txCols.map(c => c.name));
      if (!txColNames.has('calldata'))            db.exec(`ALTER TABLE transactions ADD COLUMN calldata BLOB`);
      if (!txColNames.has('calldata_length'))     db.exec(`ALTER TABLE transactions ADD COLUMN calldata_length INTEGER`);
      if (!txColNames.has('sender_pub_key_hash')) db.exec(`ALTER TABLE transactions ADD COLUMN sender_pub_key_hash TEXT`);
    }

    // tx_outputs table — Bitcoin UTXO outputs per transaction
    const outputTables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='tx_outputs'`,
    ).all() as Array<{ name: string }>;
    if (outputTables.length === 0) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tx_outputs (
          tx_hash      TEXT NOT NULL,
          output_index INTEGER NOT NULL,
          value_sat    INTEGER,
          script_type  TEXT,
          address      TEXT,
          PRIMARY KEY (tx_hash, output_index)
        );
        CREATE INDEX IF NOT EXISTS idx_tx_outputs_address ON tx_outputs(address);
      `);
    }

    // blocks table — replaces block_hashes, adds timestamp + tx_count
    const blockTables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='blocks'`,
    ).all() as Array<{ name: string }>;
    if (blockTables.length === 0) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS blocks (
          block_number INTEGER PRIMARY KEY,
          block_hash   TEXT NOT NULL,
          timestamp    INTEGER,
          tx_count     INTEGER NOT NULL DEFAULT 0
        );
      `);
      // Migrate existing block_hashes rows into blocks
      const hashTableExists = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='block_hashes'`,
      ).all() as Array<{ name: string }>;
      if (hashTableExists.length > 0) {
        db.exec(`INSERT OR IGNORE INTO blocks (block_number, block_hash) SELECT block_number, block_hash FROM block_hashes`);
        db.exec(`DROP TABLE block_hashes`);
      }
    }
    // blocks.tx_count semantic swap to match upstream btc_getBlockByNumber:
    //   tx_count       = raw Bitcoin block size (was btc_tx_count in the
    //                    previous schema, or the same column repurposed from
    //                    the old "OPNET stored count" semantic).
    //   opnet_tx_count = OPStream-local count of persisted OPNET txs (new
    //                    column name for what used to be called tx_count).
    //
    // Two-step rename handles both migration paths cleanly: databases that
    // already went through commit 7eeb794 have both columns (old semantics),
    // and older databases only have tx_count (pre-btc_tx_count).
    const blockCols = db.prepare('PRAGMA table_info(blocks)').all() as Array<{ name: string }>;
    const hasBtcCol   = blockCols.some(c => c.name === 'btc_tx_count');
    const hasOpnetCol = blockCols.some(c => c.name === 'opnet_tx_count');

    if (blockCols.length > 0 && !hasOpnetCol) {
      if (hasBtcCol) {
        // Post-7eeb794 databases: swap the two columns.
        // tx_count (OPNET) → opnet_tx_count, btc_tx_count (raw) → tx_count.
        db.exec(`ALTER TABLE blocks RENAME COLUMN tx_count TO opnet_tx_count`);
        db.exec(`ALTER TABLE blocks RENAME COLUMN btc_tx_count TO tx_count`);
      } else {
        // Pre-btc_tx_count databases: existing tx_count meant raw Bitcoin
        // (because generic txs were stored by default), which matches the
        // new meaning. Just add opnet_tx_count; older rows get 0 — we can't
        // distinguish historically without a rescan.
        db.exec(`ALTER TABLE blocks ADD COLUMN opnet_tx_count INTEGER NOT NULL DEFAULT 0`);
      }
    }

    // token_deployments → contract_deployments rename. The table always stored
    // every OPNetTransactionTypes.Deployment tx (not only OP-20 tokens), so the
    // old name was misleading. We rename in-place and drop the old indexes;
    // the new indexes are created on the first CREATE TABLE IF NOT EXISTS pass.
    const oldDeployTable = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='token_deployments'`,
    ).all() as Array<{ name: string }>;
    if (oldDeployTable.length > 0) {
      const newDeployTable = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='contract_deployments'`,
      ).all() as Array<{ name: string }>;
      if (newDeployTable.length === 0) {
        db.exec(`ALTER TABLE token_deployments RENAME TO contract_deployments`);
        db.exec(`DROP INDEX IF EXISTS idx_token_deployments_block`);
        db.exec(`DROP INDEX IF EXISTS idx_token_deployments_contract`);
        db.exec(`DROP INDEX IF EXISTS idx_token_deployments_deployer`);
      }
    }

    // mempool_pending table — pending OPNET transactions from the Bitcoin mempool
    const mempoolTables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='mempool_pending'`,
    ).all() as Array<{ name: string }>;
    if (mempoolTables.length === 0) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS mempool_pending (
          txid             TEXT NOT NULL PRIMARY KEY,
          raw_payload_hex  TEXT NOT NULL,
          contract_selector TEXT,
          decoded_json     TEXT,
          first_seen_at    INTEGER NOT NULL DEFAULT (unixepoch()),
          confirmed_at     INTEGER,
          pruned_at        INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_mempool_pending_first_seen ON mempool_pending(first_seen_at);
        CREATE INDEX IF NOT EXISTS idx_mempool_pending_confirmed  ON mempool_pending(confirmed_at);
      `);
    }
  } catch (err) {
    throw new Error(
      `Database migration failed: ${err instanceof Error ? err.message : String(err)}. ` +
      `The database may be corrupted or from an incompatible version.`,
    );
  }
}

/**
 * Open (or return the existing) SQLite database as a DbAdapter.
 * Creates parent directories as needed.
 */
export function openDb(path: string): DbAdapter {
  if (_adapter) return _adapter;
  const dir = dirname(path);
  if (dir && dir !== '.' && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const raw = new Database(path);
  raw.exec('PRAGMA busy_timeout = 5000;');
  raw.exec(SCHEMA);
  runMigrations(raw);
  _rawDb = raw;
  _adapter = new SqliteAdapter(raw);
  return _adapter;
}

/**
 * Creates an isolated in-memory SQLite DbAdapter for unit tests.
 * Never use in production — data is lost when the process exits.
 * Access the underlying Database.Database via (adapter as SqliteAdapter).rawDb
 * for direct verification queries in tests.
 */
export function createTestDb(): DbAdapter {
  const raw = new Database(':memory:');
  raw.exec(SCHEMA);
  runMigrations(raw);
  return new SqliteAdapter(raw);
}

export function getDb(): DbAdapter {
  if (!_adapter) throw new Error('DB not initialized — call openDb() first');
  return _adapter;
}

/**
 * Returns the underlying Database.Database when running in SQLite mode.
 * Used by the logger to persist WARN/ERROR rows synchronously.
 * Returns null in Postgres mode.
 */
export function getRawDb(): Database.Database | null {
  return _rawDb;
}

export function closeDb(): void {
  if (_adapter) {
    void _adapter.close();
    _adapter = null;
    _rawDb = null;
  }
}
