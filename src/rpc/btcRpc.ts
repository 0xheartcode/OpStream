/**
 * Bitcoin RPC client — wraps @btc-vision/bitcoin-rpc's BitcoinRPC.
 *
 * Provides a minimal, testable interface for:
 *   - Fetching mempool transaction IDs
 *   - Fetching raw transaction hex
 *   - Getting current block count
 *
 * Lifecycle: call connect() once before any other method.
 * If BITCOIN_RPC_URL is empty, all methods return safe empty/null values
 * and no network calls are made.
 *
 * Injectable for unit testing: pass a `RawBitcoinRpcAdapter` via the
 * second constructor parameter to bypass real network calls.
 */

import { BitcoinRPC, BitcoinVerbosity } from '@btc-vision/bitcoin-rpc';
import { log } from '../core/logger.js';

// ─── Injectable adapter interface ────────────────────────────────────────────

/**
 * Minimal interface that the underlying Bitcoin RPC library must satisfy.
 * Pass a mock implementation to the constructor for unit testing.
 */
export interface RawBitcoinRpcAdapter {
  init(config: {
    BITCOIND_HOST: string;
    BITCOIND_PORT: number;
    BITCOIND_USERNAME: string;
    BITCOIND_PASSWORD: string;
    BITCOIND_HTTPS?: boolean;
  }): Promise<void>;
  getRawMempool(verbose?: BitcoinVerbosity): Promise<string[] | null>;
  getRawTransaction(params: { txId: string; verbose?: BitcoinVerbosity }): Promise<string | null>;
  getBlockCount(): Promise<number | null>;
  /** Optional — Bitcoin Core estimatesmartfee RPC. Returns feerate in BTC/kB. */
  estimateSmartFee?(targetBlocks: number): Promise<{ feerate?: number } | null>;
}

// ─── URL parser ───────────────────────────────────────────────────────────────

interface ParsedBtcUrl {
  host: string;
  port: number;
  username: string;
  password: string;
  https: boolean;
}

function parseBitcoinRpcUrl(
  urlStr: string,
  user: string,
  pass: string,
): ParsedBtcUrl {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    // Bare host:port without scheme
    parsed = new URL(`http://${urlStr}`);
  }

  return {
    host: parsed.hostname,
    port: parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === 'https:' ? 443 : 8332),
    username: parsed.username || user,
    password: parsed.password || pass,
    https: parsed.protocol === 'https:',
  };
}

// ─── BitcoinRpcClient ─────────────────────────────────────────────────────────

/**
 * Thin wrapper around BitcoinRPC with graceful no-op when BITCOIN_RPC_URL is
 * not configured.
 */
export class BitcoinRpcClient {
  private readonly url: string;
  private readonly user: string;
  private readonly pass: string;
  private adapter: RawBitcoinRpcAdapter | null = null;
  private connected = false;

  // ─── estimateSmartFee cache ─────────────────────────────────────────────────
  private _feeRateCache: number | null = null;
  private _feeRateCachedAt = 0;
  private readonly FEE_CACHE_TTL_MS = 60_000;

  /**
   * @param url  BITCOIN_RPC_URL — empty string disables the client.
   * @param user BITCOIN_RPC_USER — fallback if not embedded in URL.
   * @param pass BITCOIN_RPC_PASS — fallback if not embedded in URL.
   * @param injectAdapter Optional pre-configured adapter for unit tests.
   */
  constructor(
    url: string,
    user: string,
    pass: string,
    injectAdapter?: RawBitcoinRpcAdapter,
  ) {
    this.url = url;
    this.user = user;
    this.pass = pass;

    if (injectAdapter) {
      this.adapter = injectAdapter;
      this.connected = true;
    }
  }

  /** Returns true when the client is ready to make calls. */
  get isReady(): boolean {
    return this.connected;
  }

  /**
   * Initializes the underlying RPC connection.
   * Must be called once before getMempoolTxIds / getRawTransaction / getBlockCount.
   * Safe to call when BITCOIN_RPC_URL is empty — logs a notice and returns.
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    if (!this.url) {
      log('INFO', 'btcRpc', 'BITCOIN_RPC_URL not set — Bitcoin RPC disabled');
      return;
    }

    const cfg = parseBitcoinRpcUrl(this.url, this.user, this.pass);

    const btcRpc = new BitcoinRPC();
    try {
      await btcRpc.init({
        BITCOIND_HOST: cfg.host,
        BITCOIND_PORT: cfg.port,
        BITCOIND_USERNAME: cfg.username,
        BITCOIND_PASSWORD: cfg.password,
        BITCOIND_HTTPS: cfg.https,
      });
      this.adapter = btcRpc as unknown as RawBitcoinRpcAdapter;
      this.connected = true;
      log('INFO', 'btcRpc', 'Bitcoin RPC connected', { host: cfg.host, port: cfg.port });
    } catch (err) {
      log('ERROR', 'btcRpc', 'Failed to connect to Bitcoin RPC', {
        host: cfg.host,
        port: cfg.port,
        error: String(err),
      });
    }
  }

  /**
   * Returns all transaction IDs currently in the mempool.
   * Returns an empty array when not connected.
   */
  async getMempoolTxIds(): Promise<string[]> {
    if (!this.adapter) return [];

    try {
      const result = await this.adapter.getRawMempool(BitcoinVerbosity.RAW);
      return result ?? [];
    } catch (err) {
      log('WARN', 'btcRpc', 'getMempoolTxIds failed', { error: String(err) });
      return [];
    }
  }

  /**
   * Returns the raw hex-encoded transaction for the given txid.
   * Returns null when not connected or on error.
   */
  async getRawTransaction(txid: string): Promise<string | null> {
    if (!this.adapter) return null;

    try {
      return await this.adapter.getRawTransaction({
        txId: txid,
        verbose: BitcoinVerbosity.RAW,
      });
    } catch (err) {
      log('WARN', 'btcRpc', 'getRawTransaction failed', {
        txid,
        error: String(err),
      });
      return null;
    }
  }

  /**
   * Returns the current Bitcoin block count (chain height).
   * Returns 0 when not connected or on error.
   */
  async getBlockCount(): Promise<number> {
    if (!this.adapter) return 0;

    try {
      return (await this.adapter.getBlockCount()) ?? 0;
    } catch (err) {
      log('WARN', 'btcRpc', 'getBlockCount failed', { error: String(err) });
      return 0;
    }
  }

  /**
   * Returns the recommended fee rate in sats/vbyte for confirmation within
   * `targetBlocks` blocks (default 2).
   *
   * Result is cached for 60 seconds. On RPC failure or when
   * BITCOIN_RPC_URL is not set, falls back to the FEE_RATE_SATS_PER_VBYTE
   * env var (default 10 sats/vbyte) and logs WARN.
   */
  async estimateSmartFee(targetBlocks = 2): Promise<number> {
    const now = Date.now();
    if (this._feeRateCache !== null && now - this._feeRateCachedAt < this.FEE_CACHE_TTL_MS) {
      return this._feeRateCache;
    }

    const fallback = parseFloat(process.env['FEE_RATE_SATS_PER_VBYTE'] ?? '10');

    if (!this.adapter || !this.adapter.estimateSmartFee) {
      log('WARN', 'btcRpc', 'estimateSmartFee not available — using FEE_RATE_SATS_PER_VBYTE fallback', { fallback });
      return fallback;
    }

    try {
      const result = await this.adapter.estimateSmartFee(targetBlocks);
      if (!result || result.feerate === undefined || result.feerate <= 0) {
        log('WARN', 'btcRpc', 'estimateSmartFee returned no usable rate — using fallback', { fallback });
        return fallback;
      }
      // Bitcoin Core returns feerate in BTC/kB.
      // Convert to sats/vbyte: feerate × 1e8 [sat/BTC] ÷ 1000 [vbyte/kB]
      const rate = Math.round(result.feerate * 1e8 / 1000);
      this._feeRateCache = rate;
      this._feeRateCachedAt = now;
      log('DEBUG', 'btcRpc', 'estimateSmartFee cached', { rate, targetBlocks });
      return rate;
    } catch (err) {
      log('WARN', 'btcRpc', 'estimateSmartFee failed — using FEE_RATE_SATS_PER_VBYTE fallback', {
        error: String(err),
        fallback,
      });
      return fallback;
    }
  }
}
