// OpStream — Chain scanner & indexer for OPNET
// Barrel export

// Core
export { loadConfig, validateConfig } from './core/config.js';
export type { OpStreamConfig } from './core/config.js';
export { openDb, createTestDb, getDb, closeDb } from './core/db.js';
export type { PoolStatus } from './core/db.js';
export { log, debug, info, warn, error, setLogDb, pruneErrorLog, queryRecentErrors, refreshLogConfig } from './core/logger.js';
export type { LogLevel } from './core/logger.js';
export { metrics, METRIC_KEYS } from './core/metrics.js';
export type { MetricKey, MetricsSnapshot } from './core/metrics.js';
export { startMetricsLogger } from './core/metricsTimer.js';

// RPC
export { OpnetRpcClient } from './rpc/opnetRpc.js';
export type { RpcLogFilter, RpcLog } from './rpc/opnetRpc.js';
export { BitcoinRpcClient } from './rpc/btcRpc.js';
export type { RawBitcoinRpcAdapter } from './rpc/btcRpc.js';
