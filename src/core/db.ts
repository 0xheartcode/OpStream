/**
 * SQLite database initializer for OpStream using Node.js built-in node:sqlite.
 *
 * Creates only the 9 OpStream tables (indexer/scanner data).
 * Bot-specific tables (simulations, strategy_windows, strategy_events, etc.) live in your-app.
 * WAL mode and foreign keys are enabled on every open.
 *
 * Pool status lifecycle:
 *   UNVERIFIED → FRESH (just created) → VIABLE (reserves > 0) → DORMANT (zero reserves)
 *   → DEAD (removed from rotation) | RUG (rug-pull detected)
 */

import { DatabaseSync } from 'node:sqlite';

export type PoolStatus = 'UNVERIFIED' | 'FRESH' | 'VIABLE' | 'DORMANT' | 'DEAD' | 'RUG';

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

CREATE TABLE IF NOT EXISTS pools (
  address       TEXT NOT NULL PRIMARY KEY,
  token0        TEXT NOT NULL,
  token1        TEXT NOT NULL,
  reserve0      TEXT NOT NULL DEFAULT '0',
  reserve1      TEXT NOT NULL DEFAULT '0',
  status        TEXT NOT NULL DEFAULT 'UNVERIFIED',
  fee_bps       INTEGER NOT NULL DEFAULT 20,
  created_block INTEGER,
  last_updated  INTEGER DEFAULT (unixepoch()),
  dex           TEXT NOT NULL DEFAULT 'nativeswap',
  FOREIGN KEY (token0) REFERENCES tokens(address),
  FOREIGN KEY (token1) REFERENCES tokens(address)
);

CREATE INDEX IF NOT EXISTS idx_pools_status ON pools(status);

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

CREATE TABLE IF NOT EXISTS reserve_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_address  TEXT NOT NULL,
  block_number  INTEGER NOT NULL,
  reserve0      TEXT NOT NULL,
  reserve1      TEXT NOT NULL,
  implied_price REAL,
  source        TEXT NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(pool_address, block_number, source)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_pool_block ON reserve_snapshots(pool_address, block_number);
CREATE INDEX IF NOT EXISTS idx_snapshots_block ON reserve_snapshots(block_number);

CREATE TABLE IF NOT EXISTS price_candles (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_address TEXT NOT NULL,
  interval     TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  open         REAL,
  high         REAL,
  low          REAL,
  close        REAL,
  volume       REAL NOT NULL DEFAULT 0,
  UNIQUE(pool_address, interval, period_start)
);

CREATE INDEX IF NOT EXISTS idx_candles_pool_interval ON price_candles(pool_address, interval);

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
    // add dex column if missing
    const cols = db.prepare('PRAGMA table_info(pools)').all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'dex')) {
      db.exec(`ALTER TABLE pools ADD COLUMN dex TEXT NOT NULL DEFAULT 'nativeswap'`);
    }
    if (!cols.some(c => c.name === 'creator_address')) {
      db.exec(`ALTER TABLE pools ADD COLUMN creator_address TEXT`);
    }
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
  _db = new DatabaseSync(path);
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
