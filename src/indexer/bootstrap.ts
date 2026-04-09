/**
 * OpStream bootstrap — CLI orchestrator for the block scanner.
 *
 * This module is a thin wrapper around scanner.ts that loads config,
 * opens the DB, and calls scanBlockRange in chunks.
 *
 * All DEX-specific pool discovery logic has been moved out of OpStream.
 * OpStream is a pure Layer 2 scanner — it stores raw events and
 * chain-level data only.
 */

import { DatabaseSync } from 'node:sqlite';
import { log } from '../core/logger.js';
import { loadConfig } from '../core/config.js';
import { openDb } from '../core/db.js';
import { OpnetRpcClient } from '../rpc/opnetRpc.js';
import { scanBlockRange, getCheckpoint } from './scanner.js';

// TODO: import from @opnet-devs/opkit once rebuild is complete
// import { DEFAULT_MOTO_TOKEN_ADDRESS } from '@opnet-devs/opkit';
const DEFAULT_MOTO_TOKEN_ADDRESS = '0x97e9c02879fcfa8f9dd8134e65e4e10df18b0ef7e4a8148dbc2b9e9bb813ea72';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BootstrapOptions {
  /** Blocks scanned per chunk. Default: 500. */
  chunkSize?: number;
  /** Override start block (ignores checkpoint). Default: use checkpoint. */
  fromBlock?: bigint;
}

export interface BootstrapResult {
  blocksScanned: number;
  eventsStored: number;
}

// ---------------------------------------------------------------------------
// Token deployment query
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

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

function seedBuiltInTokens(db: DatabaseSync): void {
  upsertToken(db, 'btc', 'BTC', 'Bitcoin', 8);
  upsertToken(db, DEFAULT_MOTO_TOKEN_ADDRESS, 'MOTO', 'Motoswap Token', 8);
}

// ---------------------------------------------------------------------------
// Format helper
// ---------------------------------------------------------------------------

function humanElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ${s}s`;
}

// ---------------------------------------------------------------------------
// Testable bootstrap core
// ---------------------------------------------------------------------------

/**
 * Testable bootstrap core — all dependencies injected.
 * Scans blocks in chunks, stores events, seeds built-in tokens.
 */
export async function runBootstrapCore(
  db: DatabaseSync,
  client: OpnetRpcClient,
  opts?: BootstrapOptions,
  bootstrapRps?: number,
): Promise<BootstrapResult> {
  const chunkSize = BigInt(opts?.chunkSize ?? 500);
  const fromBlockOverride = opts?.fromBlock ?? 0n;
  const rps = bootstrapRps ?? 10;
  const minIntervalMs = rps > 0 ? Math.floor(1000 / rps) : 0;

  seedBuiltInTokens(db);

  const currentBlock = await client.getBlockNumber();

  const checkpoint = getCheckpoint(db);
  const startBlock = fromBlockOverride > 0n ? fromBlockOverride : checkpoint + 1n;

  const totalRange = Number(currentBlock - startBlock + 1n);

  if (startBlock > currentBlock) {
    log('INFO', 'bootstrap', `Synced  checkpoint=${Number(checkpoint)}  chain tip=${Number(currentBlock)}  -- up to date`);
    return { blocksScanned: 0, eventsStored: 0 };
  }

  log('INFO', 'bootstrap', '');
  log('INFO', 'bootstrap', `  OpStream Bootstrap`);
  log('INFO', 'bootstrap', `  Chain tip:    ${Number(currentBlock)}`);
  log('INFO', 'bootstrap', `  Start block:  ${Number(startBlock)}`);
  log('INFO', 'bootstrap', `  Blocks to scan: ${totalRange}`);
  log('INFO', 'bootstrap', `  Rate limit:   ${rps} req/s`);
  log('INFO', 'bootstrap', '');

  const startTime = Date.now();
  let totalEvents = 0;
  let totalBlocks = 0;

  for (let chunkStart = startBlock; chunkStart <= currentBlock; chunkStart += chunkSize) {
    const chunkEnd = chunkStart + chunkSize - 1n <= currentBlock
      ? chunkStart + chunkSize - 1n
      : currentBlock;

    const result = await scanBlockRange(db, client, chunkStart, chunkEnd, {
      minIntervalMs,
    });

    totalEvents += result.eventsStored;
    totalBlocks += result.blocksScanned;
  }

  const elapsedSec = (Date.now() - startTime) / 1000;
  const bps = totalBlocks > 0 ? (totalBlocks / elapsedSec).toFixed(1) : '0';
  log('INFO', 'bootstrap', '');
  log('INFO', 'bootstrap', `  Bootstrap complete`);
  log('INFO', 'bootstrap', `  Blocks scanned: ${totalBlocks}`);
  log('INFO', 'bootstrap', `  Events stored:  ${totalEvents}`);
  log('INFO', 'bootstrap', `  Time:           ${humanElapsed(elapsedSec)} (${bps} blk/s)`);
  log('INFO', 'bootstrap', '');

  return { blocksScanned: totalBlocks, eventsStored: totalEvents };
}

// ---------------------------------------------------------------------------
// DB migration repair (address normalization)
// ---------------------------------------------------------------------------

export async function normalizeTokenAddresses(
  db: DatabaseSync,
  client: OpnetRpcClient,
): Promise<void> {
  const { resolveTokenHexAddress } = await import('../readers/poolReaderSdk.js');

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
        db.prepare(`DELETE FROM tokens WHERE address = ? AND address != ?`).run(tok.address, hexAddr);
      } else {
        db.prepare(`INSERT INTO tokens (address, alt_address, symbol, name, decimals, updated_at) VALUES (?, ?, ?, ?, ?, unixepoch())`).run(
          hexAddr, tok.address, tok.symbol, tok.name, tok.decimals,
        );
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
  const { readTokenMetadata: readTokenMetadataSdk } = await import('../readers/poolReaderSdk.js');

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

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/**
 * CLI entry point — called by `npx tsx src/main.ts bootstrap`.
 */
export async function runBootstrap(): Promise<void> {
  const config = loadConfig();
  const db = openDb(config.dbPath);
  const client = new OpnetRpcClient(config.opnetRpcUrl);

  log('INFO', 'bootstrap', 'Bootstrap starting', {
    dbPath: config.dbPath,
    chunkSize: config.bootstrapChunkSize,
    fromBlock: Number(config.bootstrapFromBlock),
  });

  const result = await runBootstrapCore(
    db, client,
    {
      chunkSize: config.bootstrapChunkSize,
      fromBlock: config.bootstrapFromBlock,
    },
    config.bootstrapRps,
  );

  log('INFO', 'bootstrap', 'Bootstrap finished', {
    blocksScanned: result.blocksScanned,
    eventsStored: result.eventsStored,
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
    { chunkSize: config.bootstrapChunkSize },
    config.bootstrapRps,
  );

  log('INFO', 'bootstrap', 'Catchup finished', {
    blocksScanned: result.blocksScanned,
    eventsStored: result.eventsStored,
  });
}
