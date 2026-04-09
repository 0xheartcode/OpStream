/**
 * OpStream configuration loader — reads environment variables with safe defaults.
 *
 * Call loadConfig() once at startup after dotenv.config().
 * Trimmed to OpStream-only fields (no trading thresholds, bot flags, or staking params).
 */

export interface OpStreamConfig {
  // OPNET / Bitcoin RPC
  opnetRpcUrl: string;
  bitcoinRpcUrl: string;
  bitcoinRpcUser: string;
  bitcoinRpcPass: string;

  // NativeSwap factory address
  nativeSwapFactory: string;

  // NativeSwap scanning enabled
  nativeSwapEnabled: boolean;

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
}

function parseBool(val: string | undefined, def: boolean): boolean {
  if (val === undefined) return def;
  return val.toLowerCase() !== 'false' && val !== '0';
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
    nativeSwapFactory: process.env['NATIVESWAP_FACTORY']  ?? '',
    nativeSwapEnabled: parseBool(process.env['NATIVESWAP_ENABLED'], true),
    logLevel:          process.env['LOG_LEVEL']           ?? 'INFO',
    logFormat:         process.env['LOG_FORMAT']          ?? 'human',
    dbPath:            process.env['DB_PATH']             ?? 'opstream.db',
    bootstrapRps:        parseInt10(process.env['BOOTSTRAP_RPS'], 10),
    bootstrapChunkSize:  parseInt10(process.env['BOOTSTRAP_CHUNK_SIZE'], 500),
    bootstrapFromBlock:  parseBigInt(process.env['BOOTSTRAP_FROM_BLOCK'], 941400n),
    metricsIntervalSeconds: parseInt10(process.env['METRICS_INTERVAL_SECONDS'], 60),
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
    'nativeSwapFactory',
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
