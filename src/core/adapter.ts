import { loadConfig } from './config.js';
import { setLogAdapter, log } from './logger.js';
import type { DbAdapter } from './dbAdapter.js';

/**
 * Open the active database adapter based on config.
 * Uses Postgres when DB_URL is set, SQLite otherwise.
 * Single source of truth — used by bootstrap, live indexer, and reset.
 */
export async function openAdapter(): Promise<DbAdapter> {
  const config = loadConfig();

  if (config.dbUrl) {
    const { openPostgresDb } = await import('./postgresAdapter.js');
    log('INFO', 'main', 'Using Postgres database', { url: config.dbUrl.replace(/:\/\/[^@]+@/, '://***@') });
    const adapter = await openPostgresDb(config.dbUrl);
    setLogAdapter(adapter);
    return adapter;
  } else {
    const { openDb } = await import('./db.js');
    const adapter = openDb(config.dbPath);
    setLogAdapter(adapter);
    return adapter;
  }
}
