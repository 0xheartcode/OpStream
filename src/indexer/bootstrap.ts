/**
 * OpStream — unified single-pass block scanner with event indexing.
 *
 * Scans each block ONCE, stores ALL events in the events table via
 * insertEventsBatch, then discovers pools by querying stored events.
 * Single 'indexer' checkpoint replaces the old dual-checkpoint approach.
 *
 * Entry point (called by main.ts bootstrap command):
 *   runBootstrap()              — loads config, opens DB, calls runBootstrapCore
 *
 * Testable core (injectable dependencies):
 *   runBootstrapCore(db, client, opts?, rps?)
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  InteractionTransaction,
  DeploymentTransaction,
  OPNetTransactionTypes,
  TransactionBase,
} from 'opnet';
import { log } from '../core/logger.js';
import { loadConfig } from '../core/config.js';
import { openDb } from '../core/db.js';
import { OpnetRpcClient } from '../rpc/opnetRpc.js';
import { insertSnapshot, computeImpliedPrice } from './snapshots.js';
import { insertEventsBatch, queryEvents } from './eventStore.js';
import type { EventInput, EventRow } from './eventStore.js';
import { decodeEvent, DEFAULT_NATIVESWAP_FACTORY, DEFAULT_MOTOSWAP_FACTORY, DEFAULT_MOTO_TOKEN_ADDRESS } from '@opnet-devs/opkit';
import { aggregateCandles } from './candles.js';
import type { CandleInterval } from './candles.js';
import {
  readTokenMetadata as readTokenMetadataSdk,
  readMotoswapReserves as readMotoswapReservesSdk,
  readNativeSwapReserves as readNativeSwapReservesSdk,
  readMotoswapPairTokens,
  readMotoswapPairAddress,
  resolveTokenHexAddress,
} from '../readers/poolReaderSdk.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface BootstrapOptions {
  /** Blocks scanned per RPC call. Default: 500. */
  chunkSize?: number;
  /** Override start block (ignores checkpoint). Default: use checkpoint. */
  fromBlock?: bigint;
  /** Skip NativeSwap scanning entirely. Default: true. */
  nativeSwapEnabled?: boolean;
}

export interface BootstrapResult {
  nativeSwapPoolsFound: number;
  motoswapPoolsFound: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Format seconds into human-readable elapsed time. */
function humanElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ${s}s`;
}

/** Returns true if the address is empty or a placeholder (contains repeated 0s). */
function isPlaceholderAddress(addr: string): boolean {
  if (!addr || addr.length < 10) return true;
  if (addr.includes('goeshere')) return true;
  if (/0{20,}/.test(addr)) return true;
  return false;
}

// ─── Scan type identifier (single checkpoint) ────────────────────────────────

const SCAN_TYPE_INDEXER = 'indexer';

// ─── Event parsers (OPNET-native formats) ────────────────────────────────────

/**
 * Extracts the token contract address from a NativeSwap LiquidityListed transaction.
 */
export function extractNativeSwapTokenFromTx(
  nativeSwapAddress: string,
  events: Record<string, Array<{ type: string; data: Buffer }>>,
): string | null {
  for (const [contractAddr, evts] of Object.entries(events)) {
    if (contractAddr === nativeSwapAddress) continue;
    for (const e of evts) {
      if (e.type === 'Transferred') {
        return contractAddr;
      }
    }
  }
  return null;
}

/**
 * Parses a Motoswap PoolCreated event (from the real DEX factory).
 *
 * Event data layout (64 bytes):
 *   bytes [0..31]   — token0 address (32-byte contract hash)
 *   bytes [32..63]  — token1 address (32-byte contract hash)
 */
export function parseMotoswapPoolCreatedEvent(data: Buffer): {
  token0: string;
  token1: string;
} | null {
  if (data.length < 64) {
    log('WARN', 'bootstrap', 'parseMotoswapPoolCreatedEvent: event data too short', {
      length: data.length,
    });
    return null;
  }
  return {
    token0: '0x' + data.subarray(0, 32).toString('hex'),
    token1: '0x' + data.subarray(32, 64).toString('hex'),
  };
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

function getCheckpoint(db: DatabaseSync, scanType: string): bigint {
  const row = db.prepare(
    'SELECT last_block FROM scan_checkpoints WHERE scan_type = ?',
  ).get(scanType) as { last_block: number } | undefined;
  return row ? BigInt(row.last_block) : 0n;
}

function saveCheckpoint(db: DatabaseSync, scanType: string, block: bigint): void {
  db.prepare(`
    INSERT INTO scan_checkpoints (scan_type, last_block, updated_at)
    VALUES (?, ?, unixepoch())
    ON CONFLICT(scan_type) DO UPDATE SET
      last_block = excluded.last_block,
      updated_at = unixepoch()
  `).run(scanType, Number(block));
}

function upsertToken(
  db: DatabaseSync,
  address: string,
  symbol: string,
  name: string,
  decimals: number,
): void {
  db.prepare(`
    INSERT INTO tokens (address, symbol, name, decimals, updated_at)
    VALUES (?, ?, ?, ?, unixepoch())
    ON CONFLICT(address) DO UPDATE SET
      symbol     = excluded.symbol,
      name       = excluded.name,
      decimals   = excluded.decimals,
      updated_at = unixepoch()
  `).run(address, symbol, name, decimals);
}

function insertPool(
  db: DatabaseSync,
  address: string,
  token0: string,
  token1: string,
  createdBlock: bigint,
  dex: 'nativeswap' | 'motoswap',
): void {
  db.prepare(`
    INSERT OR IGNORE INTO pools
      (address, token0, token1, reserve0, reserve1, status, fee_bps, created_block, dex)
    VALUES (?, ?, ?, '0', '0', 'UNVERIFIED', ?, ?, ?)
  `).run(address, token0, token1, dex === 'motoswap' ? 50 : 20, Number(createdBlock), dex);
}

function updatePoolStatus(
  db: DatabaseSync,
  address: string,
  reserve0: string,
  reserve1: string,
  status: 'VIABLE' | 'DORMANT',
): void {
  db.prepare(`
    UPDATE pools
    SET reserve0 = ?, reserve1 = ?, status = ?, last_updated = unixepoch()
    WHERE address = ?
  `).run(reserve0, reserve1, status, address);
}

// ─── Built-in token seeding ───────────────────────────────────────────────────

function seedBuiltInTokens(db: DatabaseSync): void {
  upsertToken(db, 'btc', 'BTC', 'Bitcoin', 8);
  upsertToken(db, DEFAULT_MOTO_TOKEN_ADDRESS, 'MOTO', 'Motoswap Token', 8);
}

// ─── Throttle helper ──────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Pool discovery from events table ────────────────────────────────────────

/**
 * Discovers NativeSwap pools from stored events in the given block range.
 */
async function processNativeSwapPools(
  db: DatabaseSync,
  client: OpnetRpcClient,
  fromBlock: number,
  toBlock: number,
): Promise<number> {
  const nsFactory = isPlaceholderAddress(DEFAULT_NATIVESWAP_FACTORY)
    ? null
    : DEFAULT_NATIVESWAP_FACTORY;

  const liquidityEvents = queryEvents(db, {
    eventName: 'LiquidityListed',
    fromBlock,
    toBlock,
  });

  const factoryEvents = nsFactory
    ? liquidityEvents.filter(e => e.contract_address === nsFactory)
    : liquidityEvents;

  let poolsFound = 0;

  const seenTxHashes = new Set<string>();
  for (const evt of factoryEvents) {
    if (seenTxHashes.has(evt.tx_hash)) continue;
    seenTxHashes.add(evt.tx_hash);

    const allTxEvents = db.prepare(
      'SELECT * FROM events WHERE tx_hash = ?',
    ).all(evt.tx_hash) as unknown as EventRow[];

    let tokenAddress: string | null = null;
    for (const txEvt of allTxEvents) {
      if (nsFactory && txEvt.contract_address === nsFactory) continue;
      if (txEvt.contract_address === DEFAULT_NATIVESWAP_FACTORY) continue;
      if (txEvt.event_name === 'Transferred') {
        tokenAddress = txEvt.contract_address;
        break;
      }
    }

    if (!tokenAddress) continue;

    try {
      const hexAddress = await resolveTokenHexAddress(client.provider, tokenAddress);
      const canonicalAddress = hexAddress;
      const altAddress = hexAddress !== tokenAddress ? tokenAddress : null;

      const isNewPool = !db.prepare('SELECT address FROM pools WHERE address = ?').get(tokenAddress);
      let decimals = 8;

      let tokenSymbol = '';
      if (isNewPool) {
        const meta = await readTokenMetadataSdk(client.provider, tokenAddress);
        decimals = meta.decimals;
        tokenSymbol = meta.symbol || canonicalAddress.slice(0, 8);
        upsertToken(db, canonicalAddress, tokenSymbol, meta.name || '', decimals);
        if (altAddress) {
          db.prepare(`UPDATE tokens SET alt_address = ? WHERE address = ?`).run(altAddress, canonicalAddress);
          db.prepare(`DELETE FROM tokens WHERE address = ? AND address != ?`).run(altAddress, canonicalAddress);
        }
        insertPool(db, tokenAddress, 'btc', canonicalAddress, BigInt(evt.block_number), 'nativeswap');
      } else {
        const tokenRow = db.prepare('SELECT decimals FROM tokens WHERE address = ?').get(canonicalAddress) as any;
        decimals = tokenRow?.decimals ?? 8;
      }

      const { btcReserve, tokenReserve } = await readNativeSwapReservesSdk(client.provider, tokenAddress);
      const status = btcReserve > 0n || tokenReserve > 0n ? 'VIABLE' : 'DORMANT';
      updatePoolStatus(db, tokenAddress, btcReserve.toString(), tokenReserve.toString(), status);

      const price = computeImpliedPrice(btcReserve.toString(), tokenReserve.toString(), 'nativeswap', 8, decimals);
      insertSnapshot(db, tokenAddress, BigInt(evt.block_number), btcReserve.toString(), tokenReserve.toString(), 'bootstrap', price);

      if (isNewPool) {
        log('INFO', 'bootstrap', `NativeSwap NEW pool: ${tokenSymbol}`, {
          poolAddress: tokenAddress.slice(0, 20) + '...',
          tokenHex: canonicalAddress.slice(0, 20) + '...',
          tokenP2op: altAddress ?? 'same',
          status,
          btcReserve: btcReserve.toString(),
          tokenReserve: tokenReserve.toString(),
        });
        poolsFound++;
      } else {
        log('DEBUG', 'bootstrap', `NativeSwap snapshot: ${tokenAddress.slice(0, 20)}`, {
          block: evt.block_number,
        });
      }
    } catch (err) {
      log('WARN', 'bootstrap', 'NativeSwap: failed to process pool — skipping', {
        tokenAddress,
        error: String(err),
      });
    }
  }

  return poolsFound;
}

/**
 * Discovers Motoswap pools from stored events in the given block range.
 */
async function processMotoswapPools(
  db: DatabaseSync,
  client: OpnetRpcClient,
  fromBlock: number,
  toBlock: number,
): Promise<number> {
  const msFactory = isPlaceholderAddress(DEFAULT_MOTOSWAP_FACTORY)
    ? null
    : DEFAULT_MOTOSWAP_FACTORY;

  const createdEvents = queryEvents(db, {
    eventName: 'PoolCreated',
    fromBlock,
    toBlock,
  });

  const factoryEvents = msFactory
    ? createdEvents.filter(e => e.contract_address === msFactory)
    : createdEvents;

  let poolsFound = 0;

  for (const evt of factoryEvents) {
    let token0: string | null = null;
    let token1: string | null = null;

    if (evt.decoded_json) {
      const decoded = JSON.parse(evt.decoded_json);
      token0 = decoded.token0;
      token1 = decoded.token1;
    } else {
      const rawBuf = Buffer.from(evt.event_raw);
      const info = parseMotoswapPoolCreatedEvent(rawBuf);
      if (!info) continue;
      token0 = info.token0;
      token1 = info.token1;
    }

    if (!token0 || !token1) continue;

    const allTxEvents = db.prepare(
      'SELECT * FROM events WHERE tx_hash = ?',
    ).all(evt.tx_hash) as unknown as EventRow[];

    let pairAddress: string | null = null;
    for (const txEvt of allTxEvents) {
      if (msFactory && txEvt.contract_address === msFactory) continue;
      if (txEvt.contract_address === DEFAULT_MOTOSWAP_FACTORY) continue;
      if (txEvt.event_name === 'Synced') {
        pairAddress = txEvt.contract_address;
        break;
      }
    }

    if (!pairAddress) {
      for (const txEvt of allTxEvents) {
        if (msFactory && txEvt.contract_address === msFactory) continue;
        if (txEvt.contract_address === DEFAULT_MOTOSWAP_FACTORY) continue;
        if (txEvt.event_name === 'LiquidityAdded' || txEvt.event_name === 'Swapped') {
          pairAddress = txEvt.contract_address;
          break;
        }
      }
    }

    if (!pairAddress && msFactory) {
      pairAddress = await readMotoswapPairAddress(client.provider, msFactory, token0, token1);
      if (pairAddress) {
        log('DEBUG', 'bootstrap', 'Motoswap: pair address resolved via factory.getPool()', {
          token0: token0.slice(0, 20),
          token1: token1.slice(0, 20),
          pairAddress: pairAddress.slice(0, 20),
        });
      }
    }

    if (!pairAddress) {
      log('WARN', 'bootstrap', 'Motoswap PoolCreated: could not identify pair address', {
        token0: token0.slice(0, 20),
        token1: token1.slice(0, 20),
      });
      continue;
    }

    try {
      const [meta0, meta1] = await Promise.all([
        readTokenMetadataSdk(client.provider, token0),
        readTokenMetadataSdk(client.provider, token1),
      ]);
      upsertToken(db, token0, meta0.symbol || token0.slice(0, 8), meta0.name || '', meta0.decimals);
      upsertToken(db, token1, meta1.symbol || token1.slice(0, 8), meta1.name || '', meta1.decimals);

      insertPool(db, pairAddress, token0, token1, BigInt(evt.block_number), 'motoswap');

      try {
        const reserves = await readMotoswapReservesSdk(client.provider, pairAddress);
        if (reserves) {
          const status = reserves.reserve0 > 0n || reserves.reserve1 > 0n ? 'VIABLE' : 'DORMANT';
          updatePoolStatus(db, pairAddress, reserves.reserve0.toString(), reserves.reserve1.toString(), status);
          log('INFO', 'bootstrap', `Motoswap pool: ${meta0.symbol || '?'}/${meta1.symbol || '?'} [${status}]`, {
            pairAddress: pairAddress.slice(0, 20) + '...',
            reserve0: reserves.reserve0.toString(),
            reserve1: reserves.reserve1.toString(),
          });
        } else {
          log('INFO', 'bootstrap', `Motoswap pool: ${meta0.symbol || '?'}/${meta1.symbol || '?'} [UNVERIFIED — reserves null]`, {
            pairAddress: pairAddress.slice(0, 20) + '...',
          });
        }
      } catch (reserveErr) {
        log('WARN', 'bootstrap', 'Motoswap: reserve fetch failed, leaving UNVERIFIED', {
          pairAddress,
          error: String(reserveErr).slice(0, 120),
        });
      }

      poolsFound++;
    } catch (err) {
      log('WARN', 'bootstrap', 'Motoswap: failed to process pool — skipping', {
        pairAddress,
        error: String(err),
      });
    }
  }

  return poolsFound;
}

// ─── Token deployment indexing ───────────────────────────────────────────────

const OP20_EVENT_NAMES = new Set(['Transfer', 'Approval']);

function hashBytecode(bytecode: Uint8Array | string | undefined): string {
  if (!bytecode) return '';
  const buf = bytecode instanceof Uint8Array ? Buffer.from(bytecode) : Buffer.from(bytecode, 'hex');
  return createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

function isOp20(contractAddress: string, blockEvents: Map<string, Set<string>>): boolean {
  const names = blockEvents.get(contractAddress.toLowerCase());
  if (!names) return false;
  for (const n of OP20_EVENT_NAMES) {
    if (names.has(n)) return true;
  }
  return false;
}

function insertTokenDeployment(
  db: DatabaseSync,
  blockNumber: number,
  txHash: string,
  contractAddress: string,
  deployer: string,
  bytecodeHash: string,
  op20: boolean,
): void {
  try {
    db.prepare(`
      INSERT OR IGNORE INTO token_deployments
        (block_number, tx_hash, contract_address, deployer, bytecode_hash, is_op20)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(blockNumber, txHash, contractAddress, deployer, bytecodeHash, op20 ? 1 : 0);
  } catch (err) {
    log('WARN', 'bootstrap', 'Failed to insert token deployment', {
      txHash, error: String(err),
    });
  }
}

// ─── Single-pass block scanner ───────────────────────────────────────────────

export async function scanBlocks(
  db: DatabaseSync,
  client: OpnetRpcClient,
  fromBlock: bigint,
  toBlock: bigint,
  opts: {
    chunkSize: bigint;
    minIntervalMs: number;
    nativeSwapEnabled: boolean;
  },
): Promise<{ nativeSwapPoolsFound: number; motoswapPoolsFound: number }> {
  let nativeSwapPoolsFound = 0;
  let motoswapPoolsFound = 0;
  const startTime = Date.now();
  let lastCallTime = 0;

  for (let chunkStart = fromBlock; chunkStart <= toBlock; chunkStart += opts.chunkSize) {
    const chunkEnd = chunkStart + opts.chunkSize - 1n <= toBlock
      ? chunkStart + opts.chunkSize - 1n
      : toBlock;

    for (let bn = chunkStart; bn <= chunkEnd; bn++) {
      if (opts.minIntervalMs > 0) {
        const elapsed = Date.now() - lastCallTime;
        if (elapsed < opts.minIntervalMs) {
          await delay(opts.minIntervalMs - elapsed);
        }
      }
      lastCallTime = Date.now();

      let block;
      try {
        block = await client.getBlock(bn);
      } catch (err) {
        log('WARN', 'bootstrap', 'scanBlocks: failed to fetch block — skipping', {
          blockNumber: Number(bn),
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      if (!block) continue;

      const blockNumber = Number(block.height);
      const events: EventInput[] = [];
      const blockEventNames = new Map<string, Set<string>>();

      for (const tx of block.transactions as TransactionBase<OPNetTransactionTypes>[]) {
        if (tx.OPNetType === OPNetTransactionTypes.Interaction) {
          const itx = tx as InteractionTransaction;

          for (const [contractAddr, evts] of Object.entries(tx.events)) {
            const lc = contractAddr.toLowerCase();
            if (!blockEventNames.has(lc)) blockEventNames.set(lc, new Set());
            for (const event of evts) {
              blockEventNames.get(lc)!.add(event.type);
              const rawData = Buffer.from(event.data);
              const decoded = decodeEvent(event.type, rawData);
              events.push({
                blockNumber,
                txHash: itx.id,
                contractAddress: contractAddr,
                eventName: event.type,
                rawData,
                decodedJson: decoded ? JSON.stringify(decoded) : null,
              });
            }
          }
        } else if (tx.OPNetType === OPNetTransactionTypes.Deployment) {
          const dtx = tx as DeploymentTransaction;
          const contractAddr = dtx.contractAddress ?? '';
          if (contractAddr) {
            const deployer = String(dtx.deployerAddress ?? '');
            const bytecodeHash = hashBytecode(dtx.bytecode);
            const op20 = isOp20(contractAddr, blockEventNames);
            insertTokenDeployment(db, blockNumber, dtx.id, contractAddr, deployer, bytecodeHash, op20);
          }
        }
      }

      if (events.length > 0) {
        insertEventsBatch(db, events);
      }
    }

    const chunkFrom = Number(chunkStart);
    const chunkTo = Number(chunkEnd);

    if (opts.nativeSwapEnabled) {
      try {
        nativeSwapPoolsFound += await processNativeSwapPools(db, client, chunkFrom, chunkTo);
      } catch (err) {
        log('WARN', 'bootstrap', 'NativeSwap pool discovery failed for chunk', {
          from: chunkFrom, to: chunkTo, error: String(err),
        });
      }
    }

    try {
      motoswapPoolsFound += await processMotoswapPools(db, client, chunkFrom, chunkTo);
    } catch (err) {
      log('WARN', 'bootstrap', 'Motoswap pool discovery failed for chunk', {
        from: chunkFrom, to: chunkTo, error: String(err),
      });
    }

    saveCheckpoint(db, SCAN_TYPE_INDEXER, chunkEnd);

    try {
      const poolRows = db.prepare(
        `SELECT DISTINCT pool_address FROM reserve_snapshots WHERE block_number >= ? AND block_number <= ?`,
      ).all(chunkFrom, chunkTo) as unknown as { pool_address: string }[];
      const INTERVALS: CandleInterval[] = ['10m', '1h', '1d'];
      for (const { pool_address } of poolRows) {
        for (const interval of INTERVALS) {
          aggregateCandles(db, pool_address, interval, chunkFrom, chunkTo);
        }
      }
    } catch (err) {
      log('WARN', 'bootstrap', 'Candle aggregation failed for chunk', {
        from: chunkFrom, to: chunkTo, error: String(err),
      });
    }

    const elapsedSec = (Date.now() - startTime) / 1000;
    const pct = ((Number(chunkEnd - fromBlock + 1n) / Number(toBlock - fromBlock + 1n)) * 100).toFixed(1);
    log('INFO', 'bootstrap', `indexer: ${pct}%`, {
      block: `${Number(chunkEnd)}/${Number(toBlock)}`,
      nativeSwapPoolsFound, motoswapPoolsFound,
      elapsed: humanElapsed(elapsedSec),
    });
  }

  const elapsedSec = (Date.now() - startTime) / 1000;
  log('INFO', 'bootstrap', 'indexer: scan complete', {
    nativeSwapPoolsFound, motoswapPoolsFound,
    elapsed: humanElapsed(elapsedSec),
    blocksScanned: Number(toBlock - fromBlock + 1n),
  });

  return { nativeSwapPoolsFound, motoswapPoolsFound };
}

// ─── Token deployment query ────────────────────────────────────────────────

export interface TokenDeploymentRow {
  id: number;
  block_number: number;
  tx_hash: string;
  contract_address: string;
  deployer: string;
  bytecode_hash: string;
  is_op20: number;
  created_at: number;
}

export function queryTokenDeployments(
  db: DatabaseSync,
  sinceBlock: number,
  op20Only = false,
): TokenDeploymentRow[] {
  const sql = op20Only
    ? `SELECT * FROM token_deployments WHERE block_number >= ? AND is_op20 = 1 ORDER BY block_number ASC`
    : `SELECT * FROM token_deployments WHERE block_number >= ? ORDER BY block_number ASC`;
  return db.prepare(sql).all(sinceBlock) as unknown as TokenDeploymentRow[];
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Testable bootstrap core — all dependencies injected.
 */
export async function runBootstrapCore(
  db: DatabaseSync,
  client: OpnetRpcClient,
  opts?: BootstrapOptions,
  bootstrapRps?: number,
): Promise<BootstrapResult> {
  const chunkSize = BigInt(opts?.chunkSize ?? 500);
  const nativeSwapEnabled = opts?.nativeSwapEnabled ?? true;
  const fromBlockOverride = opts?.fromBlock ?? 0n;
  const rps = bootstrapRps ?? 10;
  const minIntervalMs = rps > 0 ? Math.floor(1000 / rps) : 0;

  seedBuiltInTokens(db);

  const currentBlock = await client.getBlockNumber();

  const checkpoint = getCheckpoint(db, SCAN_TYPE_INDEXER);
  const startBlock = fromBlockOverride > 0n ? fromBlockOverride : checkpoint + 1n;

  if (startBlock > currentBlock) {
    log('INFO', 'bootstrap', 'indexer: already up to date', {
      checkpoint: Number(checkpoint),
      currentBlock: Number(currentBlock),
    });
    return { nativeSwapPoolsFound: 0, motoswapPoolsFound: 0 };
  }

  log('INFO', 'bootstrap', 'Starting unified block scanner', {
    currentBlock: Number(currentBlock),
    startBlock: Number(startBlock),
    chunkSize: Number(chunkSize),
    rps, nativeSwapEnabled,
  });

  return scanBlocks(db, client, startBlock, currentBlock, {
    chunkSize, minIntervalMs, nativeSwapEnabled,
  });
}

export async function verifyUnverifiedMotoswapPools(
  db: DatabaseSync,
  client: OpnetRpcClient,
): Promise<void> {
  const unverified = db.prepare(
    `SELECT address FROM pools WHERE status = 'UNVERIFIED' AND dex = 'motoswap'`,
  ).all() as unknown as { address: string }[];

  if (unverified.length === 0) return;

  log('INFO', 'bootstrap', `Verifying ${unverified.length} UNVERIFIED Motoswap pools...`);

  let promoted = 0;
  for (const { address } of unverified) {
    try {
      const reserves = await readMotoswapReservesSdk(client.provider, address);
      if (reserves) {
        const status = reserves.reserve0 > 0n || reserves.reserve1 > 0n ? 'VIABLE' : 'DORMANT';
        updatePoolStatus(db, address, reserves.reserve0.toString(), reserves.reserve1.toString(), status);
        log('INFO', 'bootstrap', `  ${address.slice(0, 20)}... → ${status}`);
        promoted++;
      }
    } catch (err) {
      log('WARN', 'bootstrap', `  ${address.slice(0, 20)}... reserve fetch failed`, {
        error: String(err).slice(0, 80),
      });
    }
  }

  log('INFO', 'bootstrap', `Motoswap verification: ${promoted}/${unverified.length} promoted`);
}

export async function normalizeTokenAddresses(
  db: DatabaseSync,
  client: OpnetRpcClient,
): Promise<void> {
  const op1sqTokens = db.prepare(
    `SELECT address, symbol, name, decimals FROM tokens WHERE address LIKE 'op1sq%'`,
  ).all() as unknown as { address: string; symbol: string; name: string; decimals: number }[];

  if (op1sqTokens.length === 0) return;

  log('INFO', 'bootstrap', `Normalizing ${op1sqTokens.length} op1sq token addresses to 0x hex...`);

  let normalized = 0;
  for (const tok of op1sqTokens) {
    try {
      const hexAddr = await resolveTokenHexAddress(client.provider, tok.address);
      if (hexAddr === tok.address) {
        log('WARN', 'bootstrap', `  ${tok.address.slice(0, 20)}... could not resolve to 0x — skipping`);
        continue;
      }

      const existing = db.prepare('SELECT address FROM tokens WHERE address = ?').get(hexAddr);
      if (existing) {
        db.prepare(`UPDATE tokens SET alt_address = ? WHERE address = ?`).run(tok.address, hexAddr);
        db.prepare(`UPDATE pools SET token1 = ? WHERE token1 = ?`).run(hexAddr, tok.address);
        db.prepare(`DELETE FROM tokens WHERE address = ?`).run(tok.address);
      } else {
        db.prepare(`INSERT INTO tokens (address, alt_address, symbol, name, decimals, updated_at) VALUES (?, ?, ?, ?, ?, unixepoch())`).run(
          hexAddr, tok.address, tok.symbol, tok.name, tok.decimals,
        );
        db.prepare(`UPDATE pools SET token1 = ? WHERE token1 = ?`).run(hexAddr, tok.address);
        db.prepare(`DELETE FROM tokens WHERE address = ?`).run(tok.address);
      }

      log('INFO', 'bootstrap', `  ${tok.symbol}: ${tok.address.slice(0, 16)}... → ${hexAddr.slice(0, 18)}...`);
      normalized++;
    } catch (err) {
      log('WARN', 'bootstrap', `  normalization failed for ${tok.address.slice(0, 20)}...`, {
        error: String(err).slice(0, 120),
      });
    }
  }

  log('INFO', 'bootstrap', `Token normalization: ${normalized}/${op1sqTokens.length} tokens normalized`);
}

export async function refreshTokenMetadata(
  db: DatabaseSync,
  client: OpnetRpcClient,
): Promise<void> {
  const tokens = db.prepare(
    `SELECT address, alt_address, symbol, name, decimals FROM tokens WHERE address != 'btc'`,
  ).all() as unknown as { address: string; alt_address: string | null; symbol: string | null; name: string | null; decimals: number }[];

  if (tokens.length === 0) return;

  log('INFO', 'bootstrap', `Refreshing metadata for ${tokens.length} tokens...`);

  let updated = 0;
  for (const tok of tokens) {
    try {
      let meta: { name: string; symbol: string; decimals: number } | null = null;
      const rpcAddr = tok.alt_address ?? tok.address;
      try {
        meta = await readTokenMetadataSdk(client.provider, rpcAddr);
      } catch {
        if (rpcAddr !== tok.address) {
          try { meta = await readTokenMetadataSdk(client.provider, tok.address); } catch { /* ignore */ }
        }
      }
      if (!meta) continue;

      const changed =
        meta.decimals !== tok.decimals ||
        (meta.symbol && meta.symbol !== tok.symbol) ||
        (meta.name && meta.name !== tok.name);

      if (changed) {
        db.prepare(
          `UPDATE tokens SET decimals = ?, symbol = ?, name = ?, updated_at = unixepoch() WHERE address = ?`,
        ).run(meta.decimals, meta.symbol || tok.symbol, meta.name || tok.name, tok.address);

        log('INFO', 'bootstrap', `  ${meta.symbol || tok.symbol}: decimals ${tok.decimals}→${meta.decimals}`, {
          address: tok.address.slice(0, 18) + '...',
        });
        updated++;
      }
    } catch (err) {
      log('WARN', 'bootstrap', `  metadata refresh failed for ${(tok.symbol ?? tok.address).slice(0, 16)}`, {
        error: String(err).slice(0, 100),
      });
    }
  }

  log('INFO', 'bootstrap', `Token metadata refresh: ${updated}/${tokens.length} tokens updated`);
}

export async function runDbMigrationRepair(
  db: DatabaseSync,
  client: OpnetRpcClient,
): Promise<void> {
  log('INFO', 'bootstrap', 'DB migration repair starting...');
  await normalizeTokenAddresses(db, client);
  await refreshTokenMetadata(db, client);
  log('INFO', 'bootstrap', 'DB migration repair complete');
}

export async function rediscoverPools(
  db: DatabaseSync,
  client: OpnetRpcClient,
): Promise<{ nativeSwapPoolsFound: number; motoswapPoolsFound: number }> {
  const range = db.prepare(
    'SELECT MIN(block_number) as minB, MAX(block_number) as maxB FROM events',
  ).get() as { minB: number | null; maxB: number | null } | undefined;

  if (!range?.maxB) {
    log('INFO', 'bootstrap', 'rediscoverPools: events table is empty — run bootstrap first');
    return { nativeSwapPoolsFound: 0, motoswapPoolsFound: 0 };
  }

  log('INFO', 'bootstrap', `rediscoverPools: re-processing events ${range.minB}–${range.maxB}`);

  const [nativeSwapPoolsFound, motoswapPoolsFound] = await Promise.all([
    processNativeSwapPools(db, client, range.minB!, range.maxB),
    processMotoswapPools(db, client, range.minB!, range.maxB),
  ]);

  await normalizeTokenAddresses(db, client);
  await verifyUnverifiedMotoswapPools(db, client);

  log('INFO', 'bootstrap', 'rediscoverPools: done', {
    nativeSwapPoolsFound, motoswapPoolsFound,
  });

  return { nativeSwapPoolsFound, motoswapPoolsFound };
}

/**
 * CLI entry point — called by `npx tsx src/main.ts bootstrap`.
 */
export async function runBootstrap(): Promise<void> {
  const config = loadConfig();
  const db = openDb(config.dbPath);
  const client = new OpnetRpcClient(config.opnetRpcUrl);

  log('INFO', 'bootstrap', 'Bootstrap starting', {
    dbPath: config.dbPath,
    nativeSwapEnabled: config.nativeSwapEnabled,
    chunkSize: config.bootstrapChunkSize,
    fromBlock: Number(config.bootstrapFromBlock),
  });

  const result = await runBootstrapCore(
    db, client,
    {
      chunkSize: config.bootstrapChunkSize,
      fromBlock: config.bootstrapFromBlock,
      nativeSwapEnabled: config.nativeSwapEnabled,
    },
    config.bootstrapRps,
  );

  await normalizeTokenAddresses(db, client);
  await verifyUnverifiedMotoswapPools(db, client);

  log('INFO', 'bootstrap', 'Bootstrap finished', {
    nativeSwapPoolsFound: result.nativeSwapPoolsFound,
    motoswapPoolsFound: result.motoswapPoolsFound,
    total: result.nativeSwapPoolsFound + result.motoswapPoolsFound,
  });
}

export async function runCatchup(): Promise<void> {
  const config = loadConfig();
  const db = openDb(config.dbPath);
  const client = new OpnetRpcClient(config.opnetRpcUrl);

  log('INFO', 'bootstrap', 'Catchup starting (incremental — from last checkpoint)', {
    dbPath: config.dbPath,
  });

  const result = await runBootstrapCore(
    db, client,
    {
      chunkSize: config.bootstrapChunkSize,
      nativeSwapEnabled: config.nativeSwapEnabled,
    },
    config.bootstrapRps,
  );

  const rediscovered = await rediscoverPools(db, client);

  log('INFO', 'bootstrap', 'Catchup finished', {
    newBlocksScanned_nativeSwap: result.nativeSwapPoolsFound,
    newBlocksScanned_motoswap: result.motoswapPoolsFound,
    rediscovered_nativeSwap: rediscovered.nativeSwapPoolsFound,
    rediscovered_motoswap: rediscovered.motoswapPoolsFound,
  });
}
