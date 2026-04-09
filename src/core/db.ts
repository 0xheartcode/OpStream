/**
 * SQLite database initializer for OpStream using Node.js built-in node:sqlite.
 *
 * OpStream is a pure Layer 2 chain scanner — it stores raw events and
 * chain-level data only. Domain-specific tables (pools, reserves, candles)
 * belong in Layer 3 (OpKit handler framework).
 *
 * Tables:
 *   tokens             OP20 token metadata (chain-level)
 *   events             Raw decoded events from all contracts
 *   scan_checkpoints   Block scanning progress
 *   token_deployments  OP20 contract creation tracking
 *   block_hashes       Block hash storage for reorg detection
 *   runtime_metrics    Performance counters
 *   error_log          Error tracking
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tokens (
  address   TEXT NOT NULL PRIMARY KEY,
  symbol    TEXT,
  name      TEXT,
  decimals  INTEGER NOT NULL DEFAULT 8,
  updated_at INTEGER DEFAULT (unixepoch())
);

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
  event_raw        BLOB NOT NULL,
  decoded_json     TEXT,
  data_length      INTEGER NOT NULL,
  created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(block_number, tx_hash, contract_address, event_name)
);

CREATE INDEX IF NOT EXISTS idx_events_block ON events(block_number);
CREATE INDEX IF NOT EXISTS idx_events_contract ON events(contract_address);
CREATE INDEX IF NOT EXISTS idx_events_name ON events(event_name);
CREATE INDEX IF NOT EXISTS idx_events_contract_name ON events(contract_address, event_name);

CREATE TABLE IF NOT EXISTS token_deployments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  block_number     INTEGER NOT NULL,
  tx_hash          TEXT NOT NULL UNIQUE,
  contract_address TEXT NOT NULL,
  deployer         TEXT,
  bytecode_hash    TEXT,
  is_op20          INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_token_deployments_block    ON token_deployments(block_number);
CREATE INDEX IF NOT EXISTS idx_token_deployments_contract ON token_deployments(contract_address);

CREATE TABLE IF NOT EXISTS block_hashes (
  block_number INTEGER PRIMARY KEY,
  block_hash   TEXT NOT NULL
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

CREATE INDEX IF NOT EXISTS idx_error_log_level    ON error_log(level);
CREATE INDEX IF NOT EXISTS idx_error_log_created  ON error_log(created_at);
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
