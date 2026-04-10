#!/usr/bin/env node
/**
 * OpStream CLI — pure Layer 2 chain scanner for OPNET.
 *
 * Commands:
 *   start      Bootstrap + live (catch up, then follow chain tip)
 *   bootstrap  Full scan from BOOTSTRAP_FROM_BLOCK (exits when done)
 *   live       Follow chain tip only (assumes already caught up)
 *
 * Database:
 *   DB_URL set  → Postgres (e.g. postgres://user:pass@host:5432/opstream)
 *   DB_URL unset → SQLite at DB_PATH (default: data/opstream.db)
 */

import 'dotenv/config';

const USAGE = `
OpStream — Pure Layer 2 chain scanner for OPNET

Usage: npx tsx src/main.ts <command>

Commands:
  start      Bootstrap + live — catch up then follow chain tip
  bootstrap  Full scan from BOOTSTRAP_FROM_BLOCK (exits when done)
  live       Follow chain tip only (assumes already caught up)

Database:
  DB_URL     Postgres connection URL (e.g. postgres://user:pass@host:5432/opstream)
             If unset, SQLite is used (DB_PATH).

Environment:
  OPNET_RPC_URL          OPNET JSON-RPC endpoint (default: https://mainnet.opnet.org)
  DB_PATH                SQLite database file (default: data/opstream.db)
  DB_URL                 Postgres connection URL (overrides DB_PATH when set)
  BOOTSTRAP_FROM_BLOCK   Starting block (default: 941400)
  BOOTSTRAP_RPS          Rate limit: requests per second (default: 10)
  BOOTSTRAP_CHUNK_SIZE   Blocks per chunk (default: 500)
  WS_PORT                WebSocket broadcast port, 0=disabled (default: 0)
  WEBHOOK_URLS           Comma-separated HTTP callback URLs (default: none)
  LOG_LEVEL              DEBUG | INFO | WARN | ERROR (default: INFO)
`.trim();

async function openAdapter() {
  const { loadConfig } = await import('./core/config.js');
  const config = loadConfig();

  if (config.dbUrl) {
    const { openPostgresDb } = await import('./core/postgresAdapter.js');
    const { log } = await import('./core/logger.js');
    log('INFO', 'main', 'Using Postgres database', { url: config.dbUrl.replace(/:\/\/[^@]+@/, '://***@') });
    return openPostgresDb(config.dbUrl);
  } else {
    const { openDb, getRawDb } = await import('./core/db.js');
    const { setLogDb } = await import('./core/logger.js');
    const adapter = openDb(config.dbPath);
    setLogDb(getRawDb());
    return adapter;
  }
}

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

    case 'start': {
      const { runBootstrap } = await import('./indexer/bootstrap.js');
      const { loadConfig } = await import('./core/config.js');
      const { OpnetRpcClient } = await import('./rpc/opnetRpc.js');
      const { runLiveIndexer } = await import('./indexer/liveIndexer.js');
      const { getWebhookManager } = await import('./indexer/webhooks.js');
      const { log } = await import('./core/logger.js');

      await runBootstrap();

      const config = loadConfig();
      const db = await openAdapter();
      const client = new OpnetRpcClient(config.opnetRpcUrl);
      const webhooks = getWebhookManager();

      if (config.wsPort > 0) {
        webhooks.startBroadcastServer(config.wsPort);
        log('INFO', 'main', `WebSocket broadcast server on ws://localhost:${config.wsPort}`);
      }

      log('INFO', 'main', 'Bootstrap complete — switching to live indexer');
      await runLiveIndexer(db, client, {
        onEvent: (event) => webhooks.dispatch(event),
      });
      break;
    }

    case 'live': {
      const { loadConfig } = await import('./core/config.js');
      const { OpnetRpcClient } = await import('./rpc/opnetRpc.js');
      const { runLiveIndexer } = await import('./indexer/liveIndexer.js');
      const { getWebhookManager } = await import('./indexer/webhooks.js');
      const { log } = await import('./core/logger.js');

      const config = loadConfig();
      const db = await openAdapter();
      const client = new OpnetRpcClient(config.opnetRpcUrl);
      const webhooks = getWebhookManager();

      if (config.wsPort > 0) {
        webhooks.startBroadcastServer(config.wsPort);
        log('INFO', 'main', `WebSocket broadcast server on ws://localhost:${config.wsPort}`);
      }

      log('INFO', 'main', 'Starting live indexer...', { dbPath: config.dbPath });
      await runLiveIndexer(db, client, {
        onEvent: (event) => webhooks.dispatch(event),
      });
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
