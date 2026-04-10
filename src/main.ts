#!/usr/bin/env node
/**
 * OpStream CLI — pure Layer 2 chain scanner for OPNET.
 *
 * Commands:
 *   start      Bootstrap + live (catch up, then follow chain tip)
 *   bootstrap  Full scan from BOOTSTRAP_FROM_BLOCK (exits when done)
 *   live       Follow chain tip only (assumes already caught up)
 */

import 'dotenv/config';

const USAGE = `
OpStream — Pure Layer 2 chain scanner for OPNET

Usage: npx tsx src/main.ts <command>

Commands:
  start      Bootstrap + live — catch up then follow chain tip
  bootstrap  Full scan from BOOTSTRAP_FROM_BLOCK (exits when done)
  live       Follow chain tip only (assumes already caught up)

Environment:
  OPNET_RPC_URL          OPNET JSON-RPC endpoint (default: https://mainnet.opnet.org)
  DB_PATH                SQLite database file (default: data/opstream.db)
  BOOTSTRAP_FROM_BLOCK   Starting block (default: 941400)
  BOOTSTRAP_RPS          Rate limit: requests per second (default: 10)
  BOOTSTRAP_CHUNK_SIZE   Blocks per chunk (default: 500)
  WS_PORT                WebSocket broadcast port, 0=disabled (default: 0)
  WEBHOOK_URLS           Comma-separated HTTP callback URLs (default: none)
  LOG_LEVEL              DEBUG | INFO | WARN | ERROR (default: INFO)
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

    case 'start': {
      // Bootstrap to catch up, then switch to live indexing
      const { runBootstrap } = await import('./indexer/bootstrap.js');
      const { loadConfig } = await import('./core/config.js');
      const { openDb } = await import('./core/db.js');
      const { OpnetRpcClient } = await import('./rpc/opnetRpc.js');
      const { runLiveIndexer } = await import('./indexer/liveIndexer.js');
      const { getWebhookManager } = await import('./indexer/webhooks.js');
      const { log } = await import('./core/logger.js');

      await runBootstrap();

      const config = loadConfig();
      const db = openDb(config.dbPath);
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
      const { openDb } = await import('./core/db.js');
      const { OpnetRpcClient } = await import('./rpc/opnetRpc.js');
      const { runLiveIndexer } = await import('./indexer/liveIndexer.js');
      const { getWebhookManager } = await import('./indexer/webhooks.js');
      const { log } = await import('./core/logger.js');

      const config = loadConfig();
      const db = openDb(config.dbPath);
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
