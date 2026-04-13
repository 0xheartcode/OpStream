/**
 * OpStream fast-sync HTTP endpoints.
 *
 * Exposes two GET routes that the `sync` CLI command consumes to bootstrap
 * a local database from a remote OpStream instance in seconds rather than
 * hours.
 *
 *   GET /sync/status
 *     Returns a JSON summary of what the server has indexed.
 *     { fromBlock, tipBlock, totalBlocks, totalTxs, totalEvents }
 *
 *   GET /sync/export?from=X&to=Y
 *     Streams a gzip-compressed NDJSON payload containing every DB row for
 *     blocks X–Y (capped at MAX_BLOCKS_PER_CHUNK=100). Each line is:
 *       {"t":"b",  "d":{...block columns...}}
 *       {"t":"tx", "d":{...tx columns, calldata/receipt as base64...}}
 *       {"t":"e",  "d":{...event columns, event_raw as base64...}}
 *       {"t":"dep","d":{...contract_deployment columns...}}
 *       {"t":"out","d":{...tx_output columns...}}
 *     Rows are ordered by type (blocks → txs → events → deps → outputs)
 *     then by block_number within each type.
 *
 * Auth:
 *   If SYNC_SECRET is set on the server, every request must carry:
 *     Authorization: Bearer <SYNC_SECRET>
 *   Without it all /sync/* requests return HTTP 401.
 *   If SYNC_SECRET is unset, the endpoints are open.
 *
 * Integration:
 *   createSyncHandler() returns a plain Node HTTP handler. Mount it from
 *   createRpcHandler() by checking req.url before the POST-only guard.
 */

import { createGzip } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DbAdapter } from '../core/dbAdapter.js';
import { log } from '../core/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum blocks per /sync/export request. Clients chunk accordingly. */
export const MAX_BLOCKS_PER_CHUNK = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert any Buffer columns to base64 strings so they survive JSON. */
function serializeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = Buffer.isBuffer(v) ? v.toString('base64') : v;
  }
  return out;
}

function jsonErr(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleStatus(db: DbAdapter, res: ServerResponse): Promise<void> {
  try {
    const checkpoint = await db.get<{ last_block: number }>(
      "SELECT last_block FROM scan_checkpoints WHERE scan_type = 'indexer'",
    );
    const firstBlock = await db.get<{ block_number: number }>(
      'SELECT MIN(block_number) AS block_number FROM blocks',
    );
    const totalTxs    = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM transactions');
    const totalEvents = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM events');

    const fromBlock = firstBlock?.block_number ?? null;
    const tipBlock  = checkpoint?.last_block   ?? null;
    const totalBlocks =
      fromBlock !== null && tipBlock !== null ? tipBlock - fromBlock + 1 : 0;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      fromBlock,
      tipBlock,
      totalBlocks,
      totalTxs:    Number(totalTxs?.n    ?? 0),
      totalEvents: Number(totalEvents?.n ?? 0),
    }));
  } catch (e) {
    log('ERROR', 'sync', 'Status query failed', { error: String(e) });
    jsonErr(res, 500, 'Internal error');
  }
}

async function handleExport(db: DbAdapter, url: URL, res: ServerResponse): Promise<void> {
  const fromStr = url.searchParams.get('from');
  const toStr   = url.searchParams.get('to');

  if (!fromStr || !toStr) {
    jsonErr(res, 400, 'Missing from or to parameter');
    return;
  }

  const fromRaw = parseInt(fromStr, 10);
  const toRaw   = parseInt(toStr, 10);

  if (isNaN(fromRaw) || isNaN(toRaw) || fromRaw < 0 || toRaw < fromRaw) {
    jsonErr(res, 400, 'Invalid from/to range');
    return;
  }

  // Cap server-side: client must chunk if it wants more
  const from = fromRaw;
  const to   = Math.min(toRaw, fromRaw + MAX_BLOCKS_PER_CHUNK - 1);

  log('DEBUG', 'sync', `Export blocks ${from}–${to}`);

  res.writeHead(200, {
    'Content-Type':     'application/x-ndjson',
    'Content-Encoding': 'gzip',
    'Transfer-Encoding': 'chunked',
    'Cache-Control':    'no-store',
  });

  const gz = createGzip({ level: 6 });
  gz.pipe(res);

  function writeLine(type: string, data: Record<string, unknown>): void {
    gz.write(JSON.stringify({ t: type, d: serializeRow(data) }) + '\n');
  }

  try {
    // Blocks
    const blocks = await db.all<Record<string, unknown>>(
      'SELECT * FROM blocks WHERE block_number >= ? AND block_number <= ? ORDER BY block_number',
      [from, to],
    );
    for (const b of blocks) writeLine('b', b);

    // Transactions (calldata + receipt are BYTEA → base64 via serializeRow)
    const txs = await db.all<Record<string, unknown>>(
      `SELECT * FROM transactions
       WHERE block_number >= ? AND block_number <= ?
       ORDER BY block_number, tx_index`,
      [from, to],
    );
    for (const tx of txs) writeLine('tx', tx);

    // Events (event_raw is BYTEA → base64 via serializeRow)
    const events = await db.all<Record<string, unknown>>(
      `SELECT * FROM events
       WHERE block_number >= ? AND block_number <= ?
       ORDER BY block_number, log_index`,
      [from, to],
    );
    for (const e of events) writeLine('e', e);

    // Contract deployments
    const deps = await db.all<Record<string, unknown>>(
      `SELECT * FROM contract_deployments
       WHERE block_number >= ? AND block_number <= ?
       ORDER BY block_number`,
      [from, to],
    );
    for (const d of deps) writeLine('dep', d);

    // Tx outputs (no block_number — join through transactions)
    const outputs = await db.all<Record<string, unknown>>(
      `SELECT o.* FROM tx_outputs o
       JOIN transactions t ON o.tx_hash = t.tx_hash
       WHERE t.block_number >= ? AND t.block_number <= ?
       ORDER BY t.block_number, o.tx_hash, o.output_index`,
      [from, to],
    );
    for (const o of outputs) writeLine('out', o);
  } catch (e) {
    log('ERROR', 'sync', 'Export stream error', { from, to, error: String(e) });
    // We've already sent the 200 header — best we can do is close the stream.
  } finally {
    gz.end();
  }
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Returns a Node HTTP handler for all /sync/* routes.
 * Mount it from the main HTTP server before the POST-only guard.
 */
export function createSyncHandler(
  db: DbAdapter,
  syncSecret: string | null,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      // Auth
      if (syncSecret) {
        const auth = req.headers['authorization'];
        if (!auth || auth !== `Bearer ${syncSecret}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
      }

      // Only GET is supported
      if (req.method !== 'GET') {
        res.writeHead(405, { Allow: 'GET' });
        res.end();
        return;
      }

      const url = new URL(
        req.url ?? '/',
        `http://${req.headers['host'] ?? 'localhost'}`,
      );

      if (url.pathname === '/sync/status') {
        await handleStatus(db, res);
        return;
      }

      if (url.pathname === '/sync/export') {
        await handleExport(db, url, res);
        return;
      }

      jsonErr(res, 404, 'Not found');
    })();
  };
}
