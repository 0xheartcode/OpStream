/**
 * JSON-RPC 2.0 HTTP server for OpStream.
 *
 * Implements a subset of the OPNET RPC surface served directly from the local
 * index — no block scanning required:
 *
 *   btc_getLogs          — query indexed events by address/name/block range (O(1))
 *   btc_blockNumber      — latest indexed block from scan_checkpoints
 *   btc_getBlockReceipts — all txs + events for a block in one call
 *   btc_getTransaction   — single tx + its events by hash
 *
 * All other methods are transparently proxied to the upstream OPNET node
 * (OPNET_RPC_URL), making OpStream a complete drop-in replacement for any
 * consumer currently pointing JSONRpcProvider at mainnet.opnet.org.
 *
 * Enable with: RPC_PORT=3001  (default 0 = disabled)
 * Works with both SQLite and Postgres via the DbAdapter abstraction.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { DbAdapter } from '../core/dbAdapter.js';
import { queryEvents } from '../indexer/eventStore.js';
import type { EventRow } from '../indexer/eventStore.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Extended RPC log shape — adds logIndex to the base RpcLog. */
export interface RpcLogExtended {
  address: string;
  topics: string[];         // [eventName]
  data: string;             // event_raw hex, no 0x prefix
  blockNumber: string;      // hex string "0x…" — bigint-safe over JSON
  transactionHash: string;
  logIndex: number;
}

/** Result shape for btc_getTransaction. */
export interface RpcTransaction {
  tx_hash: string;
  block_number: number;
  tx_index: number;
  tx_type: string;
  from_address: string | null;
  contract_address: string | null;
  gas_used: string | null;
  burned_bitcoin: string | null;
  priority_fee: string | null;
  failed: boolean;
  revert_reason: string | null;
  events: RpcLogExtended[];
}

/** Result shape for btc_getBlockReceipts. */
export interface RpcBlockReceipts {
  block_number: number;
  block_hash: string;
  timestamp: number | null;
  tx_count: number;
  transactions: RpcTransaction[];
}

// ---------------------------------------------------------------------------
// Internal wire types
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: string;
  id: string | number | null | undefined;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

// DB row types for typed queries
interface TxDbRow {
  tx_hash: string;
  block_number: number;
  tx_index: number;
  tx_type: string;
  from_address: string | null;
  contract_address: string | null;
  gas_used: string | null;
  burned_bitcoin: string | null;
  priority_fee: string | null;
  failed: number;   // SQLite INTEGER — 0 or 1
  revert_reason: string | null;
}

interface BlockDbRow {
  block_number: number;
  block_hash: string;
  timestamp: number | null;
  tx_count: number;
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 error codes
// ---------------------------------------------------------------------------

const PARSE_ERROR     = { code: -32700, message: 'Parse error' };
const INVALID_REQUEST = { code: -32600, message: 'Invalid Request' };
const INVALID_PARAMS  = { code: -32602, message: 'Invalid params' };
const INTERNAL_ERROR  = { code: -32603, message: 'Internal error' };

const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MB

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(id: string | number | null | undefined, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function fail(id: string | number | null | undefined, e: { code: number; message: string }): JsonRpcError {
  return { jsonrpc: '2.0', id: id ?? null, error: e };
}

function isValidRequest(v: unknown): v is JsonRpcRequest {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return r['jsonrpc'] === '2.0' && typeof r['method'] === 'string';
}

/**
 * Resolve a block param to a concrete block number.
 * Accepts: number literal, decimal string, hex string "0x…", or "latest".
 * Returns undefined when the input is absent or unparseable (no filter applied).
 */
function resolveBlock(val: unknown, latest: number | undefined): number | undefined {
  if (val === undefined || val === null) return undefined;
  if (val === 'latest') return latest;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const n = val.startsWith('0x') ? parseInt(val, 16) : parseInt(val, 10);
    return isNaN(n) ? undefined : n;
  }
  return undefined;
}

/** Map a DB event row to the wire RpcLogExtended shape. */
function rowToLog(row: EventRow & { log_index: number }): RpcLogExtended {
  return {
    address:          row.contract_address,
    topics:           [row.event_name],
    data:             row.event_raw.toString('hex'),
    blockNumber:      '0x' + row.block_number.toString(16),
    transactionHash:  row.tx_hash,
    logIndex:         row.log_index,
  };
}

/** Map a DB transaction row + its events to the wire RpcTransaction shape. */
function rowToTx(tx: TxDbRow, events: RpcLogExtended[]): RpcTransaction {
  return {
    tx_hash:          tx.tx_hash,
    block_number:     tx.block_number,
    tx_index:         tx.tx_index,
    tx_type:          tx.tx_type,
    from_address:     tx.from_address,
    contract_address: tx.contract_address,
    gas_used:         tx.gas_used,
    burned_bitcoin:   tx.burned_bitcoin,
    priority_fee:     tx.priority_fee,
    failed:           tx.failed !== 0,
    revert_reason:    tx.revert_reason,
    events,
  };
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        resolve(null);
      } else {
        chunks.push(chunk);
      }
    });

    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

async function getLatestIndexedBlock(db: DbAdapter): Promise<number | undefined> {
  const row = await db.get<{ last_block: number }>(
    "SELECT last_block FROM scan_checkpoints WHERE scan_type = 'indexer'",
  );
  return row?.last_block;
}

// ---------------------------------------------------------------------------
// Method handlers
// ---------------------------------------------------------------------------

async function handleGetLogs(
  id: string | number | null | undefined,
  params: unknown,
  db: DbAdapter,
): Promise<JsonRpcResponse> {
  if (!Array.isArray(params) || params.length < 1) return fail(id, INVALID_PARAMS);
  const f = params[0];
  if (typeof f !== 'object' || f === null) return fail(id, INVALID_PARAMS);

  const filter = f as Record<string, unknown>;

  let latest: number | undefined;
  if (filter['fromBlock'] === 'latest' || filter['toBlock'] === 'latest') {
    latest = await getLatestIndexedBlock(db);
  }

  try {
    const rows = await queryEvents(db, {
      contract:  typeof filter['address']   === 'string' ? filter['address']   : undefined,
      eventName: typeof filter['eventName'] === 'string' ? filter['eventName'] : undefined,
      fromBlock: resolveBlock(filter['fromBlock'], latest),
      toBlock:   resolveBlock(filter['toBlock'],   latest),
    });
    return ok(id, (rows as Array<EventRow & { log_index: number }>).map(rowToLog));
  } catch (e) {
    return fail(id, { ...INTERNAL_ERROR, message: `Internal error: ${String(e)}` });
  }
}

async function handleBlockNumber(
  id: string | number | null | undefined,
  db: DbAdapter,
): Promise<JsonRpcResponse> {
  try {
    const latest = await getLatestIndexedBlock(db);
    return ok(id, latest !== undefined ? '0x' + latest.toString(16) : '0x0');
  } catch (e) {
    return fail(id, { ...INTERNAL_ERROR, message: `Internal error: ${String(e)}` });
  }
}

async function handleGetBlockReceipts(
  id: string | number | null | undefined,
  params: unknown,
  db: DbAdapter,
): Promise<JsonRpcResponse> {
  if (!Array.isArray(params) || params.length < 1) return fail(id, INVALID_PARAMS);

  let latest: number | undefined;
  if (params[0] === 'latest') latest = await getLatestIndexedBlock(db);
  const blockNumber = resolveBlock(params[0], latest);
  if (blockNumber === undefined) return fail(id, INVALID_PARAMS);

  try {
    const blockRow = await db.get<BlockDbRow>(
      'SELECT block_number, block_hash, timestamp, tx_count FROM blocks WHERE block_number = ?',
      [blockNumber],
    );
    if (!blockRow) return ok(id, null);

    const txRows = await db.all<TxDbRow>(
      `SELECT tx_hash, block_number, tx_index, tx_type, from_address, contract_address,
              gas_used, burned_bitcoin, priority_fee, failed, revert_reason
       FROM transactions WHERE block_number = ? ORDER BY tx_index`,
      [blockNumber],
    );

    const eventRows = await db.all<EventRow & { log_index: number }>(
      'SELECT * FROM events WHERE block_number = ? ORDER BY tx_hash, log_index',
      [blockNumber],
    );

    // Group events by tx_hash for O(N) assembly
    const eventsByTx = new Map<string, Array<EventRow & { log_index: number }>>();
    for (const row of eventRows) {
      const bucket = eventsByTx.get(row.tx_hash) ?? [];
      bucket.push(row);
      eventsByTx.set(row.tx_hash, bucket);
    }

    const result: RpcBlockReceipts = {
      block_number: blockRow.block_number,
      block_hash:   blockRow.block_hash,
      timestamp:    blockRow.timestamp,
      tx_count:     blockRow.tx_count,
      transactions: txRows.map((tx) =>
        rowToTx(tx, (eventsByTx.get(tx.tx_hash) ?? []).map(rowToLog)),
      ),
    };

    return ok(id, result);
  } catch (e) {
    return fail(id, { ...INTERNAL_ERROR, message: `Internal error: ${String(e)}` });
  }
}

async function handleGetTransaction(
  id: string | number | null | undefined,
  params: unknown,
  db: DbAdapter,
): Promise<JsonRpcResponse> {
  if (!Array.isArray(params) || typeof params[0] !== 'string') return fail(id, INVALID_PARAMS);
  const txHash = params[0] as string;

  try {
    const txRow = await db.get<TxDbRow>(
      `SELECT tx_hash, block_number, tx_index, tx_type, from_address, contract_address,
              gas_used, burned_bitcoin, priority_fee, failed, revert_reason
       FROM transactions WHERE tx_hash = ?`,
      [txHash],
    );
    if (!txRow) return ok(id, null);

    const eventRows = await db.all<EventRow & { log_index: number }>(
      'SELECT * FROM events WHERE tx_hash = ? ORDER BY log_index',
      [txHash],
    );

    return ok(id, rowToTx(txRow, eventRows.map(rowToLog)));
  } catch (e) {
    return fail(id, { ...INTERNAL_ERROR, message: `Internal error: ${String(e)}` });
  }
}

async function proxyToUpstream(
  id: string | number | null | undefined,
  method: string,
  params: unknown,
  upstreamUrl: string,
): Promise<JsonRpcResponse> {
  try {
    const body = JSON.stringify({ jsonrpc: '2.0', id: id ?? null, method, params });
    const res = await fetch(upstreamUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    return await res.json() as JsonRpcResponse;
  } catch (e) {
    return fail(id, { code: INTERNAL_ERROR.code, message: `Upstream proxy error: ${String(e)}` });
  }
}

// ---------------------------------------------------------------------------
// Request dispatcher
// ---------------------------------------------------------------------------

async function handleSingle(
  raw: unknown,
  db: DbAdapter,
  upstreamUrl: string,
): Promise<JsonRpcResponse> {
  if (!isValidRequest(raw)) {
    const id = (typeof raw === 'object' && raw !== null)
      ? (raw as Record<string, unknown>)['id'] as string | number | null | undefined
      : undefined;
    return fail(id, INVALID_REQUEST);
  }

  const { id, method, params } = raw;

  switch (method) {
    case 'btc_getLogs':          return handleGetLogs(id, params, db);
    case 'btc_blockNumber':      return handleBlockNumber(id, db);
    case 'btc_getBlockReceipts': return handleGetBlockReceipts(id, params, db);
    case 'btc_getTransaction':   return handleGetTransaction(id, params, db);
    default:                     return proxyToUpstream(id, method, params, upstreamUrl);
  }
}

// ---------------------------------------------------------------------------
// HTTP handler — exported for testing
// ---------------------------------------------------------------------------

export function createRpcHandler(
  db: DbAdapter,
  upstreamUrl: string,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST' });
        res.end();
        return;
      }

      const bodyText = await readBody(req);
      if (bodyText === null) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(fail(null, PARSE_ERROR)));
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(fail(null, PARSE_ERROR)));
        return;
      }

      let response: unknown;

      if (Array.isArray(parsed)) {
        if (parsed.length === 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(fail(null, INVALID_REQUEST)));
          return;
        }
        response = await Promise.all(parsed.map((r) => handleSingle(r, db, upstreamUrl)));
      } else {
        response = await handleSingle(parsed, db, upstreamUrl);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    })();
  };
}

// ---------------------------------------------------------------------------
// Singleton lifecycle
// ---------------------------------------------------------------------------

let _server: Server | null = null;

/** Start the JSON-RPC server on the given port. Idempotent — no-op if already running. */
export function startRpcServer(port: number, db: DbAdapter, upstreamUrl: string): void {
  if (_server) return;
  _server = createServer(createRpcHandler(db, upstreamUrl));
  _server.listen(port);
}

/** Stop the JSON-RPC server. No-op if not running. */
export function stopRpcServer(): void {
  _server?.close();
  _server = null;
}

/** Returns the underlying Server instance (used for port discovery in tests). */
export function getRpcServer(): Server | null {
  return _server;
}
