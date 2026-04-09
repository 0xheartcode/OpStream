#!/usr/bin/env node
/**
 * OpStream CLI — chain scanner & indexer for OPNET.
 *
 * Commands:
 *   bootstrap              Full scan from BOOTSTRAP_FROM_BLOCK
 *   rediscover-pools       Re-run pool discovery on stored events (no block re-scan)
 *   db-migration-repair    Normalize op1sq→0x addresses + refresh token metadata
 */

import 'dotenv/config';

const USAGE = `
OpStream — Chain scanner & indexer for OPNET

Usage: npx tsx src/main.ts <command>

Commands:
  bootstrap              Full scan from BOOTSTRAP_FROM_BLOCK (checkpoint-resumable)
  rediscover-pools       Re-run pool discovery on stored events (no block re-scan)
  db-migration-repair    Normalize op1sq→0x addresses + refresh token decimals/metadata

Environment:
  OPNET_RPC_URL          OPNET JSON-RPC endpoint (default: https://mainnet.opnet.org)
  DB_PATH                SQLite database file (default: opstream.db)
  BOOTSTRAP_FROM_BLOCK   Starting block (default: 941400)
  BOOTSTRAP_RPS          Rate limit: requests per second (default: 10)
  BOOTSTRAP_CHUNK_SIZE   Blocks per chunk (default: 500)
  NATIVESWAP_ENABLED     Enable NativeSwap scanning (default: true)
  LOG_LEVEL              DEBUG | INFO | WARN | ERROR (default: INFO)
  LOG_FORMAT             human | json (default: human)
`.trim();

async function main(): Promise<void> {
  const command = process.argv[2];

  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(USAGE + '\n');
    return;
  }

  switch (command) {
    case 'bootstrap': {
      const { runBootstrap } = await import('./indexer/bootstrap.js');
      await runBootstrap();
      break;
    }

    case 'rediscover-pools': {
      const { loadConfig } = await import('./core/config.js');
      const { openDb } = await import('./core/db.js');
      const { OpnetRpcClient } = await import('./rpc/opnetRpc.js');
      const { rediscoverPools } = await import('./indexer/bootstrap.js');

      const config = loadConfig();
      const db = openDb(config.dbPath);
      const client = new OpnetRpcClient(config.opnetRpcUrl);

      const result = await rediscoverPools(db, client);
      process.stdout.write(
        `Rediscovery complete: ${result.nativeSwapPoolsFound} NativeSwap, ${result.motoswapPoolsFound} Motoswap pools found\n`,
      );
      break;
    }

    case 'db-migration-repair': {
      const { loadConfig } = await import('./core/config.js');
      const { openDb } = await import('./core/db.js');
      const { OpnetRpcClient } = await import('./rpc/opnetRpc.js');
      const { runDbMigrationRepair } = await import('./indexer/bootstrap.js');

      const config = loadConfig();
      const db = openDb(config.dbPath);
      const client = new OpnetRpcClient(config.opnetRpcUrl);

      await runDbMigrationRepair(db, client);
      break;
    }

    default:
      process.stderr.write(`Unknown command: ${command}\n\n`);
      process.stdout.write(USAGE + '\n');
      process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
