// OpStream — Pure Layer 2 chain scanner for OPNET
//
// Scans every block, stores every event, serves raw data.
// Knows nothing about pools, reserves, DEXes, or swap math.

// Core
export { loadConfig, validateConfig } from './core/config.js';
export type { OpStreamConfig } from './core/config.js';
export { openDb, createTestDb, getDb, getRawDb, closeDb } from './core/db.js';
export type { DbAdapter } from './core/dbAdapter.js';
export { SqliteAdapter } from './core/sqliteAdapter.js';
export { PostgresAdapter, openPostgresDb } from './core/postgresAdapter.js';
export { log, debug, info, warn, error, setLogAdapter, setLogDb, pruneErrorLog, queryRecentErrors, refreshLogConfig } from './core/logger.js';
export type { LogLevel } from './core/logger.js';
export { metrics, METRIC_KEYS } from './core/metrics.js';
export type { MetricKey, MetricsSnapshot } from './core/metrics.js';
export { startMetricsLogger } from './core/metricsTimer.js';

// RPC
export { OpnetRpcClient } from './rpc/opnetRpc.js';
export type { RpcLogFilter, RpcLog } from './rpc/opnetRpc.js';
export { BitcoinRpcClient } from './rpc/btcRpc.js';
export type { RawBitcoinRpcAdapter } from './rpc/btcRpc.js';

// Scanner
export {
  scanBlockRange,
  getCheckpoint,
  saveCheckpoint,
  saveBlock,
  getBlockHash,
  deleteBlockDataFrom,
} from './indexer/scanner.js';
export type { ScanResult, ScanOptions, OnEventCallback } from './indexer/scanner.js';

// Bootstrap (CLI orchestration)
export { runBootstrap, runBootstrapCore, runCatchup, queryTokenDeployments } from './indexer/bootstrap.js';
export type { BootstrapOptions, BootstrapResult, TokenDeploymentRow } from './indexer/bootstrap.js';

// Event store
export { insertEvent, insertEventsBatch, queryEvents, backfillDecoded } from './indexer/eventStore.js';
export type { EventRow, EventInput, EventQuery } from './indexer/eventStore.js';

// Live indexer
export { startLiveIndexer, runLiveIndexer } from './indexer/liveIndexer.js';
export type { LiveIndexerOptions, LiveIndexerHealth, LiveIndexerHandle, ScanBlocksFn } from './indexer/liveIndexer.js';

// Webhooks (raw event subscriptions — arguably L2)
export { SubscriptionManager, loadEnvWebhooks, getWebhookManager, resetWebhookManager } from './indexer/webhooks.js';
export type { EventPattern, WebhookEvent, Subscription } from './indexer/webhooks.js';
