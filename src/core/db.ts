/**
 * SQLite database initializer for OpStream using Node.js built-in node:sqlite.
 *
 * OpStream is a pure Layer 2 chain scanner — it stores raw chain-level data only.
 * Domain-specific tables (pools, reserves, candles, token metadata) belong in
 * Layer 3 (OpKit handler framework).
 *
 * Tables:
 *   blocks             Block metadata (hash, timestamp, tx_count)
 *   transactions       Every tx: sender, gas, fees, calldata, revert status
 *   tx_outputs         Bitcoin UTXO outputs per transaction (value flows)
 *   events             Every decoded event from every contract
 *   scan_checkpoints   Block scanning progress (resumable)
 *   token_deployments  Contract creation tracking (chain-level)
 *   tokens             OP20 metadata cache — written by OpKit, not OpStream
 *   runtime_metrics    Performance counters
 *   error_log          Error tracking
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS blocks (
  block_number INTEGER PRIMARY KEY,
  block_hash   TEXT NOT NULL,
  timestamp    INTEGER,
  tx_count     INTEGER NOT NULL DEFAULT 0
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

CREATE TABLE IF NOT EXISTS token_deployments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  block_number     INTEGER NOT NULL,
  tx_hash          TEXT NOT NULL UNIQUE,
  contract_address TEXT NOT NULL,
  deployer         TEXT,
  bytecode_hash    TEXT,
  created_at       INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_token_deployments_block    ON token_deployments(block_number);
CREATE INDEX IF NOT EXISTS idx_token_deployments_contract ON token_deployments(contract_address);
CREATE INDEX IF NOT EXISTS idx_token_deployments_deployer ON token_deployments(deployer);

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
`;

let _db: DatabaseSync | null = null;

/**
 * Applies schema migrations for columns added after initial deployment.
 * Safe to call on both new and existing databases.
 */
function runMigrations(db: DatabaseSync): void {
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
  } catch (err) {
    throw new Error(
      `Database migration failed: ${err instanceof Error ? err.message : String(err)}. ` +
      `The database may be corrupted or from an incompatible version.`,
    );
  }
}

export function openDb(path: string): DatabaseSync {
  if (_db) return _db;
  const dir = dirname(path);
  if (dir && dir !== '.' && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  _db = new DatabaseSync(path);
  _db.exec('PRAGMA busy_timeout = 5000;');
  _db.exec(SCHEMA);
  runMigrations(_db);
  return _db;
}

/**
 * Creates an isolated in-memory SQLite database for unit tests.
 * Never use in production — data is lost when the process exits.
 */
export function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  runMigrations(db);
  return db;
}

export function getDb(): DatabaseSync {
  if (!_db) throw new Error('DB not initialized — call openDb() first');
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
