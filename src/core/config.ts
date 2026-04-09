/**
 * OpStream configuration loader — reads environment variables with safe defaults.
 *
 * OpStream is a pure Layer 2 scanner — no DEX-specific config here.
 * Call loadConfig() once at startup after dotenv.config().
 */

export interface OpStreamConfig {
  // OPNET / Bitcoin RPC
  opnetRpcUrl: string;
  bitcoinRpcUrl: string;
  bitcoinRpcUser: string;
  bitcoinRpcPass: string;

  // Logging
  logLevel: string;
  logFormat: string;

  // Database
  dbPath: string;

  // Bootstrap scanner
  bootstrapRps: number;
  bootstrapChunkSize: number;
  bootstrapFromBlock: bigint;

  // Metrics emission interval (s)
  metricsIntervalSeconds: number;

  // WebSocket broadcast server port (0 = disabled)
  wsPort: number;
}

function parseBigInt(val: string | undefined, def: bigint): bigint {
  if (!val) return def;
  try { return BigInt(val); } catch { return def; }
}

function parseInt10(val: string | undefined, def: number): number {
  const n = parseInt(val ?? '', 10);
  return isNaN(n) ? def : n;
}

export function loadConfig(): OpStreamConfig {
  return {
    opnetRpcUrl:       process.env['OPNET_RPC_URL']       ?? 'https://mainnet.opnet.org',
    bitcoinRpcUrl:     process.env['BITCOIN_RPC_URL']     ?? '',
    bitcoinRpcUser:    process.env['BITCOIN_RPC_USER']    ?? '',
    bitcoinRpcPass:    process.env['BITCOIN_RPC_PASS']    ?? '',
    logLevel:          process.env['LOG_LEVEL']           ?? 'INFO',
    logFormat:         process.env['LOG_FORMAT']          ?? 'human',
    dbPath:            process.env['DB_PATH']             ?? 'data/opstream.db',
    bootstrapRps:        parseInt10(process.env['BOOTSTRAP_RPS'], 10),
    bootstrapChunkSize:  parseInt10(process.env['BOOTSTRAP_CHUNK_SIZE'], 500),
    bootstrapFromBlock:  parseBigInt(process.env['BOOTSTRAP_FROM_BLOCK'], 941400n),
    metricsIntervalSeconds: parseInt10(process.env['METRICS_INTERVAL_SECONDS'], 60),
    wsPort: parseInt10(process.env['WS_PORT'], 0),
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
}
