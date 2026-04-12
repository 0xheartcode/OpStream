/**
 * OpStream configuration loader — reads environment variables with safe defaults.
 *
 * OpStream is a pure Layer 2 scanner — no DEX-specific config here.
 * Call loadConfig() once at startup after dotenv.config().
 */

export type OpStreamMode = 'indexer' | 'mempool' | 'full';

export interface OpStreamConfig {
  // Run mode: 'indexer' (default), 'mempool', or 'full' (both)
  mode: OpStreamMode;

  // OPNET / Bitcoin RPC
  opnetRpcUrl: string;
  bitcoinRpcUrl: string;
  bitcoinRpcUser: string;
  bitcoinRpcPass: string;

  // Logging
  logLevel: string;
  logFormat: string;

  // Database — set DB_URL for Postgres, DB_PATH for SQLite (default)
  dbPath: string;
  dbUrl: string | null;

  // Bootstrap scanner
  bootstrapRps: number;
  bootstrapChunkSize: number;
  bootstrapFromBlock: bigint;
  // 0n = unset — scan to current chain tip. When set, bootstrap stops at this
  // block (inclusive), enabling deterministic bounded test runs.
  bootstrapToBlock: bigint;
  // When true, store every tx including non-OPNET generics. Off by default —
  // in real OPNET blocks generics are ~95% of rows and nothing queries them.
  storeGenericTxs: boolean;

  // Metrics emission interval (s)
  metricsIntervalSeconds: number;

  // WebSocket broadcast server port (0 = disabled)
  wsPort: number;

  // JSON-RPC 2.0 HTTP server port (0 = disabled)
  rpcPort: number;

  // Mempool poller interval (ms) — only used in 'mempool' or 'full' mode
  mempoolPollIntervalMs: number;
}

function parseBigInt(val: string | undefined, def: bigint): bigint {
  if (!val) return def;
  try { return BigInt(val); } catch { return def; }
}

function parseInt10(val: string | undefined, def: number): number {
  const n = parseInt(val ?? '', 10);
  return isNaN(n) ? def : n;
}

const VALID_MODES: OpStreamMode[] = ['indexer', 'mempool', 'full'];

function parseMode(val: string | undefined): OpStreamMode {
  if (!val) return 'indexer';
  const lower = val.toLowerCase() as OpStreamMode;
  return VALID_MODES.includes(lower) ? lower : 'indexer';
}

export function loadConfig(): OpStreamConfig {
  return {
    mode:              parseMode(process.env['OPSTREAM_MODE']),
    opnetRpcUrl:       process.env['OPNET_RPC_URL']       ?? 'https://mainnet.opnet.org',
    bitcoinRpcUrl:     process.env['BITCOIN_RPC_URL']     ?? '',
    bitcoinRpcUser:    process.env['BITCOIN_RPC_USER']    ?? '',
    bitcoinRpcPass:    process.env['BITCOIN_RPC_PASS']    ?? '',
    logLevel:          process.env['LOG_LEVEL']           ?? 'INFO',
    logFormat:         process.env['LOG_FORMAT']          ?? 'human',
    dbPath:            process.env['DB_PATH']             ?? 'data/opstream.db',
    dbUrl:             process.env['DB_URL']              ?? null,
    bootstrapRps:        parseInt10(process.env['BOOTSTRAP_RPS'], 10),
    bootstrapChunkSize:  parseInt10(process.env['BOOTSTRAP_CHUNK_SIZE'], 500),
    bootstrapFromBlock:  parseBigInt(process.env['BOOTSTRAP_FROM_BLOCK'], 941400n),
    bootstrapToBlock:    parseBigInt(process.env['BOOTSTRAP_TO_BLOCK'], 0n),
    storeGenericTxs:     process.env['OPSTREAM_STORE_GENERIC_TXS'] === 'true',
    metricsIntervalSeconds: parseInt10(process.env['METRICS_INTERVAL_SECONDS'], 60),
    wsPort:  parseInt10(process.env['WS_PORT'],  0),
    rpcPort: parseInt10(process.env['RPC_PORT'], 0),
    mempoolPollIntervalMs: parseInt10(process.env['MEMPOOL_POLL_INTERVAL_MS'], 10_000),
  };
}

/** Known placeholder strings that must never be used in production. */
const PLACEHOLDER_PATTERNS = [
  'goes-here',
  'your-',
  'example.com',
  'localhost',
  'placeholder',
  'TODO',
  'FIXME',
];

/**
 * Validate a config object and throw if any required address fields contain
 * known placeholder values.
 */
export function validateConfig(config: OpStreamConfig): void {
  const addressFields: Array<keyof OpStreamConfig> = [
    'opnetRpcUrl',
  ];

  for (const field of addressFields) {
    const value = config[field];
    if (typeof value !== 'string' || !value) continue;
    for (const placeholder of PLACEHOLDER_PATTERNS) {
      if (value.includes(placeholder)) {
        throw new Error(
          `Config validation failed: ${field} contains placeholder "${placeholder}". ` +
          `Set the real value via the corresponding environment variable.`,
        );
      }
    }
  }

  // Mempool mode requires Bitcoin RPC
  if ((config.mode === 'mempool' || config.mode === 'full') && !config.bitcoinRpcUrl) {
    throw new Error(
      `Config validation failed: OPSTREAM_MODE="${config.mode}" requires BITCOIN_RPC_URL to be set.`,
    );
  }
}
