#!/usr/bin/env node
/**
 * OpStream CLI — pure Layer 2 chain scanner for OPNET.
 *
 * Commands:
 *   start      Bootstrap + live (catch up, then follow chain tip)
 *   bootstrap  Full scan from BOOTSTRAP_FROM_BLOCK (exits when done)
 *   live       Follow chain tip only (assumes already caught up)
 *   reset      Truncate all scanned data so the next bootstrap starts fresh
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
  start           Bootstrap + live — catch up then follow chain tip
  bootstrap       Full scan from BOOTSTRAP_FROM_BLOCK (exits when done)
  live            Follow chain tip only (assumes already caught up)
  reset [--yes]   Truncate all scanned tables — destructive. Prompts for
                  confirmation unless --yes is passed or FORCE=1 is set.

Database:
  DB_URL     Postgres connection URL (e.g. postgres://user:pass@host:5432/opstream)
             If unset, SQLite is used (DB_PATH).

Environment:
  OPNET_RPC_URL              OPNET JSON-RPC endpoint (default: https://mainnet.opnet.org)
  DB_PATH                    SQLite database file (default: data/opstream.db)
  DB_URL                     Postgres connection URL (overrides DB_PATH when set)
  BOOTSTRAP_FROM_BLOCK       Starting block (default: 941400)
  BOOTSTRAP_TO_BLOCK         Stop block (inclusive). Unset = scan to chain tip.
                             Enables bounded test runs (e.g. 1000 blocks).
  OPSTREAM_STORE_GENERIC_TXS Store non-OPNET Bitcoin txs in this block (default: false).
                             Off saves ~95% of disk space; set true for a full
                             chain archive.
  BOOTSTRAP_RPS              Rate limit: requests per second (default: 10)
  BOOTSTRAP_CHUNK_SIZE       Blocks per chunk (default: 500)
  WS_PORT                    WebSocket broadcast port, 0=disabled (default: 0)
  RPC_PORT                   JSON-RPC 2.0 HTTP server port, 0=disabled (default: 0)
  WEBHOOK_URLS               Comma-separated HTTP callback URLs (default: none)
  LOG_LEVEL                  DEBUG | INFO | WARN | ERROR (default: INFO)
  OPSTREAM_MODE              Run mode: indexer (default), mempool, or full (both)
  MEMPOOL_POLL_INTERVAL_MS   Mempool poll interval in ms (default: 10000)
  BITCOIN_RPC_URL            Bitcoin Core RPC URL (required for mempool/full mode)
  BITCOIN_RPC_USER           Bitcoin Core RPC username
  BITCOIN_RPC_PASS           Bitcoin Core RPC password
`.trim();

async function openAdapter() {
  const { loadConfig } = await import('./core/config.js');
  const config = loadConfig();

  const { setLogAdapter, log } = await import('./core/logger.js');

  if (config.dbUrl) {
    const { openPostgresDb } = await import('./core/postgresAdapter.js');
    log('INFO', 'main', 'Using Postgres database', { url: config.dbUrl.replace(/:\/\/[^@]+@/, '://***@') });
    const adapter = await openPostgresDb(config.dbUrl);
    setLogAdapter(adapter);
    return adapter;
  } else {
    const { openDb } = await import('./core/db.js');
    const adapter = openDb(config.dbPath);
    setLogAdapter(adapter);
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

    case 'reset': {
      const { resetDatabase, RESET_TABLES } = await import('./indexer/reset.js');
      const { log } = await import('./core/logger.js');

      const flags = process.argv.slice(3);
      const skipPrompt = flags.includes('--yes') || process.env['FORCE'] === '1';

      process.stdout.write('\n');
      process.stdout.write('OpStream reset — about to TRUNCATE the following tables:\n');
      for (const t of RESET_TABLES) process.stdout.write(`  - ${t}\n`);
      process.stdout.write('\nThis is destructive and cannot be undone.\n');

      if (!skipPrompt) {
        if (!process.stdin.isTTY) {
          process.stderr.write(
            '\nrefused: stdin is not a TTY and no --yes / FORCE=1 was provided.\n' +
            'Pass --yes or set FORCE=1 to confirm in non-interactive contexts.\n',
          );
          process.exit(1);
        }
        process.stdout.write('\nType "yes" to confirm: ');
        const answer = await new Promise<string>((resolve) => {
          process.stdin.setEncoding('utf8');
          process.stdin.once('data', (d) => resolve(String(d).trim()));
        });
        if (answer !== 'yes') {
          process.stdout.write('aborted.\n');
          process.exit(1);
        }
      }

      const db = await openAdapter();
      try {
        const { cleared } = await resetDatabase(db);
        log('INFO', 'reset', 'Database reset complete', cleared);
        process.stdout.write('\nCleared rows:\n');
        for (const [table, n] of Object.entries(cleared)) {
          process.stdout.write(`  ${table.padEnd(24)} ${n}\n`);
        }
        process.stdout.write('\nNext: run `npx tsx src/main.ts bootstrap` to re-scan.\n');
      } finally {
        await db.close();
      }
      break;
    }

    case 'start': {
      const { loadConfig, validateConfig } = await import('./core/config.js');
      const { getWebhookManager } = await import('./indexer/webhooks.js');
      const { log } = await import('./core/logger.js');

      const config = loadConfig();
      validateConfig(config);

      const runIndexer = config.mode === 'indexer' || config.mode === 'full';
      const runMempool = config.mode === 'mempool' || config.mode === 'full';

      log('INFO', 'main', `OpStream mode: ${config.mode}`, {
        indexer: runIndexer,
        mempool: runMempool,
      });

      // Bootstrap only when indexer is active
      if (runIndexer) {
        const { runBootstrap } = await import('./indexer/bootstrap.js');
        await runBootstrap();
      }

      const db = await openAdapter();
      const webhooks = getWebhookManager();

      if (config.wsPort > 0) {
        webhooks.startBroadcastServer(config.wsPort);
        log('INFO', 'main', `WebSocket broadcast server on ws://localhost:${config.wsPort}`);
      }

      if (config.rpcPort > 0) {
        const { startRpcServer } = await import('./rpc/rpcServer.js');
        startRpcServer(config.rpcPort, db, config.opnetRpcUrl);
        log('INFO', 'main', `JSON-RPC 2.0 server on http://localhost:${config.rpcPort}`);
      }

      const stopPromises: Promise<void>[] = [];

      // Start live indexer (confirmed blocks)
      if (runIndexer) {
        const { OpnetRpcClient } = await import('./rpc/opnetRpc.js');
        const { startLiveIndexer } = await import('./indexer/liveIndexer.js');

        const client = new OpnetRpcClient(config.opnetRpcUrl);
        log('INFO', 'main', 'Bootstrap complete — starting live indexer');
        const indexerHandle = startLiveIndexer(db, client, {
          onEvent: (event) => webhooks.dispatch(event),
          storeGenericTxs: config.storeGenericTxs,
        });
        stopPromises.push(
          (indexerHandle as ReturnType<typeof startLiveIndexer> & { _stopPromise: Promise<void> })._stopPromise,
        );
      }

      // Start mempool poller (pending OPNET txs)
      if (runMempool) {
        const { BitcoinRpcClient } = await import('./rpc/btcRpc.js');
        const { startMempoolPoller } = await import('./indexer/mempoolPoller.js');

        const btcRpc = new BitcoinRpcClient(config.bitcoinRpcUrl, config.bitcoinRpcUser, config.bitcoinRpcPass);
        await btcRpc.connect();

        const mempoolHandle = startMempoolPoller(db, btcRpc, {
          pollIntervalMs: config.mempoolPollIntervalMs,
          onMempoolEvent: (event) => webhooks.dispatch(event),
        });
        stopPromises.push(
          (mempoolHandle as ReturnType<typeof startMempoolPoller> & { _stopPromise: Promise<void> })._stopPromise,
        );
      }

      // Block until all active pollers stop
      await Promise.all(stopPromises);
      break;
    }

    case 'live': {
      const { loadConfig, validateConfig } = await import('./core/config.js');
      const { getWebhookManager } = await import('./indexer/webhooks.js');
      const { log } = await import('./core/logger.js');

      const config = loadConfig();
      validateConfig(config);

      const runIndexer = config.mode === 'indexer' || config.mode === 'full';
      const runMempool = config.mode === 'mempool' || config.mode === 'full';

      log('INFO', 'main', `OpStream live mode: ${config.mode}`, {
        indexer: runIndexer,
        mempool: runMempool,
      });

      const db = await openAdapter();
      const webhooks = getWebhookManager();

      if (config.wsPort > 0) {
        webhooks.startBroadcastServer(config.wsPort);
        log('INFO', 'main', `WebSocket broadcast server on ws://localhost:${config.wsPort}`);
      }

      if (config.rpcPort > 0) {
        const { startRpcServer } = await import('./rpc/rpcServer.js');
        startRpcServer(config.rpcPort, db, config.opnetRpcUrl);
        log('INFO', 'main', `JSON-RPC 2.0 server on http://localhost:${config.rpcPort}`);
      }

      const stopPromises: Promise<void>[] = [];

      if (runIndexer) {
        const { OpnetRpcClient } = await import('./rpc/opnetRpc.js');
        const { startLiveIndexer } = await import('./indexer/liveIndexer.js');

        const client = new OpnetRpcClient(config.opnetRpcUrl);
        log('INFO', 'main', 'Starting live indexer...', { dbPath: config.dbPath });
        const indexerHandle = startLiveIndexer(db, client, {
          onEvent: (event) => webhooks.dispatch(event),
          storeGenericTxs: config.storeGenericTxs,
        });
        stopPromises.push(
          (indexerHandle as ReturnType<typeof startLiveIndexer> & { _stopPromise: Promise<void> })._stopPromise,
        );
      }

      if (runMempool) {
        const { BitcoinRpcClient } = await import('./rpc/btcRpc.js');
        const { startMempoolPoller } = await import('./indexer/mempoolPoller.js');

        const btcRpc = new BitcoinRpcClient(config.bitcoinRpcUrl, config.bitcoinRpcUser, config.bitcoinRpcPass);
        await btcRpc.connect();

        const mempoolHandle = startMempoolPoller(db, btcRpc, {
          pollIntervalMs: config.mempoolPollIntervalMs,
          onMempoolEvent: (event) => webhooks.dispatch(event),
        });
        stopPromises.push(
          (mempoolHandle as ReturnType<typeof startMempoolPoller> & { _stopPromise: Promise<void> })._stopPromise,
        );
      }

      await Promise.all(stopPromises);
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
