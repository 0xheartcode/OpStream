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

// Indexer
export { insertEvent, insertEventsBatch, queryEvents, backfillDecoded, getDailyVolume } from './indexer/eventStore.js';
export type { EventRow, EventInput, EventQuery, DailyVolume } from './indexer/eventStore.js';
export { insertSnapshot, computeImpliedPrice, pruneOldSnapshots } from './indexer/snapshots.js';
export type { SnapshotSource } from './indexer/snapshots.js';
export { aggregateCandles, getCandles, periodStart } from './indexer/candles.js';
export type { CandleInterval, CandleRow } from './indexer/candles.js';
export { SubscriptionManager, loadEnvWebhooks, getWebhookManager, resetWebhookManager } from './indexer/webhooks.js';
export type { EventPattern, WebhookEvent, Subscription } from './indexer/webhooks.js';
export {
  runBootstrap, runBootstrapCore, runCatchup, scanBlocks,
  rediscoverPools, runDbMigrationRepair,
  normalizeTokenAddresses, refreshTokenMetadata, verifyUnverifiedMotoswapPools,
  queryTokenDeployments,
  extractNativeSwapTokenFromTx, parseMotoswapPoolCreatedEvent,
} from './indexer/bootstrap.js';
export type { BootstrapOptions, BootstrapResult, TokenDeploymentRow } from './indexer/bootstrap.js';
export { startLiveIndexer, runLiveIndexer } from './indexer/liveIndexer.js';
export type { LiveIndexerOptions, LiveIndexerHealth, LiveIndexerHandle, ScanBlocksFn } from './indexer/liveIndexer.js';

// Readers
export {
  readNativeSwapReserves, readMotoswapReserves, readTokenMetadata,
  addressToBytes, encodeGetReserve, encodeGetReserves,
  decodeGetReserveResponse, decodeGetReservesResponse,
  decodeStringResponse, decodeU8Response,
} from './readers/poolReader.js';
export {
  readTokenMetadata as readTokenMetadataSdk,
  readMotoswapReserves as readMotoswapReservesSdk,
  readNativeSwapReserves as readNativeSwapReservesSdk,
  readMotoswapPairTokens, readMotoswapPairAddress, resolveTokenHexAddress,
} from './readers/poolReaderSdk.js';
