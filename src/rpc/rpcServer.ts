/**
 * JSON-RPC 2.0 HTTP server for OpStream.
 *
 * OpStream acts as a **local archival node**: for any OPNET RPC method that
 * can be answered from indexed data, it serves the exact upstream shape
 * locally at index speed. Methods that require live chain state (btc_call,
 * btc_getBalance, btc_getStorageAt, btc_sendRawTransaction, etc.) are
 * forwarded to the upstream node unchanged. Any opnet-SDK client can point
 * at OpStream and get transparent speedup with no code changes.
 *
 *   btc_*        OPNET RPC methods.
 *
 *                Served locally (archival parity with upstream shape):
 *                  btc_getBlockByNumber      — IBlockCommon header shape
 *                  btc_getBlockByHash        — same, by hash
 *                  btc_getTransactionReceipt — ITransactionReceipt shape
 *
 *                Proxied (state / live-node / too-many-fields):
 *                  btc_blockNumber           — chain tip, not indexed tip
 *                  btc_getTransactionByHash  — full tx with raw bytes, pow, etc.
 *                  btc_call, btc_getBalance, btc_getStorageAt, btc_getCode,
 *                  btc_sendRawTransaction, btc_getUTXOs, mempool + epoch
 *                  methods, etc. — 28-method UPSTREAM_METHODS allowlist
 *                  guards against typos so unknowns return local -32601.
 *
 *   opstream_*   OpStream extensions — queries upstream doesn't support at
 *                all, or richer response shapes that embed events and tx
 *                metadata in one call for indexer consumers:
 *
 *                  opstream_getLogs                events by contract / name / range
 *                  opstream_blockNumber            latest indexed checkpoint
 *                  opstream_getBlockByNumber       rich: header + txs + events
 *                  opstream_getBlockByHash         same, by hash
 *                  opstream_getBlockReceipts       every tx + events for a block
 *                  opstream_getTransaction         tx metadata + events by hash
 *                  opstream_getTransactionReceipt  rich receipt with tx metadata
 *                  opstream_getCodeHash            bytecode hash from contract_deployments
 *
 * Blocks rows scanned before the archival schema additions have NULL for
 * header fields we didn't previously store; a fresh bootstrap populates
 * them all.
 *
 * Enable with: RPC_PORT=3001  (default 0 = disabled)
 * Works with both SQLite and Postgres via the DbAdapter abstraction.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { DbAdapter } from '../core/dbAdapter.js';
import { queryEvents } from '../indexer/eventStore.js';
import type { EventRow } from '../indexer/eventStore.js';
import { log } from '../core/logger.js';
import { createSyncHandler } from './syncHandler.js';

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

/**
 * Result shape for btc_getBlockByNumber / btc_getBlockByHash.
 *
 * `transactions` is either an array of tx hashes (slim, default) or an array
 * of full RpcTransaction objects (when includeTx=true).
 */
export interface RpcBlock {
  block_number: number;
  block_hash: string;
  timestamp: number | null;
  tx_count: number;
  transactions: string[] | RpcTransaction[];
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

const PARSE_ERROR      = { code: -32700, message: 'Parse error' };
const INVALID_REQUEST  = { code: -32600, message: 'Invalid Request' };
const METHOD_NOT_FOUND = { code: -32601, message: 'Method not found' };
const INVALID_PARAMS   = { code: -32602, message: 'Invalid params' };
const INTERNAL_ERROR   = { code: -32603, message: 'Internal error' };

const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MB

// ---------------------------------------------------------------------------
// Upstream method surface
// ---------------------------------------------------------------------------

/**
 * Every btc_* method the upstream OPNET RPC actually exposes, taken verbatim
 * from opnet/build/providers/interfaces/JSONRpcMethods.js.
 *
 * Methods NOT in this set (typos, deprecated names) return -32601 locally
 * without a network round trip. Methods in this set are proxied to upstream
 * UNLESS they're handled locally first in the dispatch switch — a handful
 * of methods (getBlockByNumber, getBlockByHash, getTransactionReceipt) are
 * served from the local archival index before the allowlist check.
 */
const UPSTREAM_METHODS: ReadonlySet<string> = new Set([
  'btc_blockNumber',
  'btc_chainId',
  'btc_reorg',
  'btc_getBlockByChecksum',
  'btc_gas',
  'btc_getTransactionByHash',
  'btc_sendRawTransaction',
  'btc_sendRawTransactionPackage',
  'btc_preimage',
  'btc_publicKeyInfo',
  'btc_getUTXOs',
  'btc_getBalance',
  'btc_blockWitness',
  'btc_internal',
  'btc_getCode',
  'btc_getStorageAt',
  'btc_latestEpoch',
  'btc_getEpochByNumber',
  'btc_getEpochByHash',
  'btc_getEpochTemplate',
  'btc_submitEpoch',
  'btc_call',
  'btc_getMempoolInfo',
  'btc_getPendingTransaction',
  'btc_getLatestPendingTransactions',
]);

/**
 * Normalize an upstream base URL. The OPNET node speaks JSON-RPC at
 * /api/v1/json-rpc, but callers typically pass just the hostname
 * (e.g. https://mainnet.opnet.org). Mirror the same append-if-missing
 * logic used by opnet's JSONRpcProvider.providerUrl() so a bare hostname
 * and a fully-qualified endpoint both work.
 */
function normalizeUpstreamUrl(url: string): string {
  if (url.includes('/api/v1/json-rpc')) return url;
  return url.replace(/\/+$/, '') + '/api/v1/json-rpc';
}

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

/**
 * Shared block-body loader used by getBlockByNumber and getBlockByHash.
 * Returns null when the block is not in the local index.
 */
async function loadBlock(
  db: DbAdapter,
  where: 'block_number' | 'block_hash',
  key: number | string,
  includeTx: boolean,
): Promise<RpcBlock | null> {
  const blockRow = await db.get<BlockDbRow>(
    `SELECT block_number, block_hash, timestamp, tx_count FROM blocks WHERE ${where} = ?`,
    [key],
  );
  if (!blockRow) return null;

  const txRows = await db.all<TxDbRow>(
    `SELECT tx_hash, block_number, tx_index, tx_type, from_address, contract_address,
            gas_used, burned_bitcoin, priority_fee, failed, revert_reason
     FROM transactions WHERE block_number = ? ORDER BY tx_index`,
    [blockRow.block_number],
  );

  if (!includeTx) {
    return {
      block_number: blockRow.block_number,
      block_hash:   blockRow.block_hash,
      timestamp:    blockRow.timestamp,
      tx_count:     blockRow.tx_count,
      transactions: txRows.map((t) => t.tx_hash),
    };
  }

  const eventRows = await db.all<EventRow & { log_index: number }>(
    'SELECT * FROM events WHERE block_number = ? ORDER BY tx_hash, log_index',
    [blockRow.block_number],
  );
  const eventsByTx = new Map<string, Array<EventRow & { log_index: number }>>();
  for (const row of eventRows) {
    const bucket = eventsByTx.get(row.tx_hash) ?? [];
    bucket.push(row);
    eventsByTx.set(row.tx_hash, bucket);
  }

  return {
    block_number: blockRow.block_number,
    block_hash:   blockRow.block_hash,
    timestamp:    blockRow.timestamp,
    tx_count:     blockRow.tx_count,
    transactions: txRows.map((tx) =>
      rowToTx(tx, (eventsByTx.get(tx.tx_hash) ?? []).map(rowToLog)),
    ),
  };
}

async function handleGetBlockByNumber(
  id: string | number | null | undefined,
  params: unknown,
  db: DbAdapter,
): Promise<JsonRpcResponse> {
  if (!Array.isArray(params) || params.length < 1) return fail(id, INVALID_PARAMS);

  let latest: number | undefined;
  if (params[0] === 'latest') latest = await getLatestIndexedBlock(db);
  const blockNumber = resolveBlock(params[0], latest);
  if (blockNumber === undefined) return fail(id, INVALID_PARAMS);

  const includeTx = params[1] === true;

  try {
    const result = await loadBlock(db, 'block_number', blockNumber, includeTx);
    return ok(id, result);
  } catch (e) {
    return fail(id, { ...INTERNAL_ERROR, message: `Internal error: ${String(e)}` });
  }
}

async function handleGetBlockByHash(
  id: string | number | null | undefined,
  params: unknown,
  db: DbAdapter,
): Promise<JsonRpcResponse> {
  if (!Array.isArray(params) || typeof params[0] !== 'string') return fail(id, INVALID_PARAMS);
  const includeTx = params[1] === true;

  try {
    const result = await loadBlock(db, 'block_hash', params[0], includeTx);
    return ok(id, result);
  } catch (e) {
    return fail(id, { ...INTERNAL_ERROR, message: `Internal error: ${String(e)}` });
  }
}

/**
 * btc_getTransactionReceipt — post-execution data for a tx.
 *
 * Returns the same shape as btc_getTransaction. OpStream's TxDbRow already
 * contains both pre-exec (from, contract_address) and post-exec (gas_used,
 * failed, revert_reason) fields, so we reuse rowToTx.
 */
async function handleGetTransactionReceipt(
  id: string | number | null | undefined,
  params: unknown,
  db: DbAdapter,
): Promise<JsonRpcResponse> {
  if (!Array.isArray(params) || typeof params[0] !== 'string') return fail(id, INVALID_PARAMS);
  const txHash = params[0];

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

/**
 * btc_getCodeHash — bytecode hash for a deployed contract.
 *
 * OpStream-local extension. The upstream OPNET RPC does not expose a
 * getCodeHash method (it has btc_getCode, which returns full bytecode),
 * so there is no proxy fallback: a contract that is not in our local
 * contract_deployments index returns null. That correctly represents both:
 *
 *   - EOAs / unknown addresses (no code on chain)
 *   - Contracts deployed before BOOTSTRAP_FROM_BLOCK (we never saw them)
 *
 * If you need authoritative bytecode for pre-bootstrap contracts, call
 * btc_getCode instead — that method is proxied unchanged to the upstream
 * node, which has full chain history.
 */
async function handleGetCodeHash(
  id: string | number | null | undefined,
  params: unknown,
  db: DbAdapter,
): Promise<JsonRpcResponse> {
  if (!Array.isArray(params) || typeof params[0] !== 'string') return fail(id, INVALID_PARAMS);
  const address = params[0];

  try {
    const row = await db.get<{ bytecode_hash: string | null }>(
      'SELECT bytecode_hash FROM contract_deployments WHERE contract_address = ? LIMIT 1',
      [address],
    );
    if (row && row.bytecode_hash) return ok(id, row.bytecode_hash);
    return ok(id, null);
  } catch (e) {
    return fail(id, { ...INTERNAL_ERROR, message: `Internal error: ${String(e)}` });
  }
}

/**
 * opstream_getBlockRange — return rich block objects for a range of blocks.
 *
 * params: [fromBlock, toBlock, {includeTx?: boolean, includeEvents?: boolean}]
 *   fromBlock / toBlock: block number, hex string, or "latest"
 *   includeTx:     when true, transactions are full objects (default: false → tx hashes)
 *   includeEvents: when true, events are embedded in each tx (default: false)
 *
 * Max range: 50 blocks. Returns an array of RpcBlock objects, one per indexed
 * block in the range (skips any gaps). Useful for downstream consumers that
 * need to poll a specific window; for full bootstrap use /sync/export instead.
 */
const MAX_BLOCK_RANGE = 100;

async function handleGetBlockRange(
  id: string | number | null | undefined,
  params: unknown,
  db: DbAdapter,
): Promise<JsonRpcResponse> {
  if (!Array.isArray(params) || params.length < 2) return fail(id, INVALID_PARAMS);

  let latest: number | undefined;
  if (params[0] === 'latest' || params[1] === 'latest') {
    latest = await getLatestIndexedBlock(db);
  }

  const fromBlock = resolveBlock(params[0], latest);
  const toBlock   = resolveBlock(params[1], latest);
  if (fromBlock === undefined || toBlock === undefined) return fail(id, INVALID_PARAMS);

  const opts = (typeof params[2] === 'object' && params[2] !== null)
    ? params[2] as Record<string, unknown>
    : {};
  const includeTx     = opts['includeTx']     === true;
  const includeEvents = opts['includeEvents'] === true;

  if (toBlock < fromBlock) return fail(id, { ...INVALID_PARAMS, message: 'toBlock must be >= fromBlock' });

  // Clamp to max range
  const clampedTo = Math.min(toBlock, fromBlock + MAX_BLOCK_RANGE - 1);

  try {
    const blockRows = await db.all<ArchivalBlockRow>(
      `SELECT ${ARCHIVAL_BLOCK_COLS}
       FROM blocks WHERE block_number >= ? AND block_number <= ?
       ORDER BY block_number`,
      [fromBlock, clampedTo],
    );

    const results: Record<string, unknown>[] = [];

    for (const blockRow of blockRows) {
      const txRows = await db.all<TxDbRow>(
        `SELECT tx_hash, block_number, tx_index, tx_type, from_address, contract_address,
                gas_used, burned_bitcoin, priority_fee, failed, revert_reason
         FROM transactions WHERE block_number = ? ORDER BY tx_index`,
        [blockRow.block_number],
      );

      // Full archival block header (same 22-field shape as btc_getBlockByNumber)
      const header = blockRowToUpstream(blockRow);

      if (!includeTx) {
        results.push({ ...header, transactions: txRows.map((t) => t.tx_hash) });
        continue;
      }

      // Full tx objects, optionally with events
      const eventsByTx = new Map<string, Array<EventRow & { log_index: number }>>();

      if (includeEvents) {
        const eventRows = await db.all<EventRow & { log_index: number }>(
          'SELECT * FROM events WHERE block_number = ? ORDER BY tx_hash, log_index',
          [blockRow.block_number],
        );
        for (const row of eventRows) {
          const bucket = eventsByTx.get(row.tx_hash) ?? [];
          bucket.push(row);
          eventsByTx.set(row.tx_hash, bucket);
        }
      }

      results.push({
        ...header,
        transactions: txRows.map((tx) =>
          rowToTx(tx, includeEvents ? (eventsByTx.get(tx.tx_hash) ?? []).map(rowToLog) : []),
        ),
      });
    }

    return ok(id, results);
  } catch (e) {
    return fail(id, { ...INTERNAL_ERROR, message: `Internal error: ${String(e)}` });
  }
}

// ---------------------------------------------------------------------------
// btc_* archival handlers — served locally with the exact upstream shape
// ---------------------------------------------------------------------------

/** Full archival row for btc_getBlockBy* responses. Columns mirror IBlockCommon. */
interface ArchivalBlockRow {
  block_number:             number;
  block_hash:               string;
  timestamp:                number | null;
  tx_count:                 number | null;
  previous_block_hash:      string | null;
  previous_block_checksum:  string | null;
  bits:                     string | null;
  nonce:                    number | null;
  version:                  number | null;
  size:                     number | null;
  weight:                   number | null;
  stripped_size:            number | null;
  median_time:              number | null;
  checksum_root:            string | null;
  merkle_root:              string | null;
  storage_root:             string | null;
  receipt_root:             string | null;
  ema:                      string | null;
  base_gas:                 string | null;
  block_gas_used:           string | null;
  checksum_proofs:          string | null;  // JSON text
}

const ARCHIVAL_BLOCK_COLS =
  `block_number, block_hash, timestamp, tx_count,
   previous_block_hash, previous_block_checksum, bits, nonce, version,
   size, weight, stripped_size, median_time,
   checksum_root, merkle_root, storage_root, receipt_root,
   ema, base_gas, block_gas_used, checksum_proofs`;

/** Reshape an ArchivalBlockRow into the upstream IBlockCommon JSON shape. */
function blockRowToUpstream(row: ArchivalBlockRow): Record<string, unknown> {
  return {
    hash:                  row.block_hash,
    height:                String(row.block_number),
    previousBlockHash:     row.previous_block_hash,
    previousBlockChecksum: row.previous_block_checksum,
    bits:                  row.bits,
    nonce:                 row.nonce,
    version:               row.version,
    size:                  row.size,
    txCount:               row.tx_count,
    weight:                row.weight,
    strippedSize:          row.stripped_size,
    time:                  row.timestamp,
    medianTime:            row.median_time,
    checksumRoot:          row.checksum_root,
    merkleRoot:            row.merkle_root,
    storageRoot:           row.storage_root,
    receiptRoot:           row.receipt_root,
    ema:                   row.ema,
    baseGas:               row.base_gas,
    gasUsed:               row.block_gas_used,
    checksumProofs:        row.checksum_proofs ? JSON.parse(row.checksum_proofs) as unknown : null,
  };
}

async function handleBtcGetBlockByNumber(
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
    const row = await db.get<ArchivalBlockRow>(
      `SELECT ${ARCHIVAL_BLOCK_COLS} FROM blocks WHERE block_number = ?`,
      [blockNumber],
    );
    if (!row) return ok(id, null);
    return ok(id, blockRowToUpstream(row));
  } catch (e) {
    return fail(id, { ...INTERNAL_ERROR, message: `Internal error: ${String(e)}` });
  }
}

async function handleBtcGetBlockByHash(
  id: string | number | null | undefined,
  params: unknown,
  db: DbAdapter,
): Promise<JsonRpcResponse> {
  if (!Array.isArray(params) || typeof params[0] !== 'string') return fail(id, INVALID_PARAMS);

  try {
    const row = await db.get<ArchivalBlockRow>(
      `SELECT ${ARCHIVAL_BLOCK_COLS} FROM blocks WHERE block_hash = ?`,
      [params[0]],
    );
    if (!row) return ok(id, null);
    return ok(id, blockRowToUpstream(row));
  } catch (e) {
    return fail(id, { ...INTERNAL_ERROR, message: `Internal error: ${String(e)}` });
  }
}

/**
 * Convert a stored decimal bigint string to the 0x-prefixed hex form used
 * by upstream OPNET responses. "554155299" → "0x2107bd23".
 */
function bigintToHex(v: string | null): string {
  if (!v) return '0x0';
  try { return '0x' + BigInt(v).toString(16); } catch { return '0x0'; }
}

/** Row shape used by btc_getTransactionReceipt. */
interface ReceiptTxRow {
  tx_hash:          string;
  gas_used:         string | null;
  special_gas_used: string | null;
  failed:           number;
  revert_reason:    string | null;
  receipt:          Buffer | null;
  receipt_proofs:   string | null;  // JSON text
}

async function handleBtcGetTransactionReceipt(
  id: string | number | null | undefined,
  params: unknown,
  db: DbAdapter,
): Promise<JsonRpcResponse> {
  if (!Array.isArray(params) || typeof params[0] !== 'string') return fail(id, INVALID_PARAMS);
  const txHash = params[0];

  try {
    const txRow = await db.get<ReceiptTxRow>(
      `SELECT tx_hash, gas_used, special_gas_used, failed, revert_reason, receipt, receipt_proofs
       FROM transactions WHERE tx_hash = ?`,
      [txHash],
    );
    if (!txRow) return ok(id, null);

    const eventRows = await db.all<EventRow & { log_index: number }>(
      'SELECT * FROM events WHERE tx_hash = ? ORDER BY log_index',
      [txHash],
    );

    // Match upstream shape exactly — array of {contractAddress, type, data: base64}.
    const events = eventRows.map((e) => ({
      contractAddress: e.contract_address,
      type:            e.event_name,
      data:            e.event_raw.toString('base64'),
    }));

    const receiptProofs = txRow.receipt_proofs ? JSON.parse(txRow.receipt_proofs) as string[] : [];
    const receiptBase64 = txRow.receipt ? txRow.receipt.toString('base64') : '';

    return ok(id, {
      receipt:        receiptBase64,
      receiptProofs,
      events,
      revert:         txRow.failed ? txRow.revert_reason : undefined,
      gasUsed:        bigintToHex(txRow.gas_used),
      specialGasUsed: bigintToHex(txRow.special_gas_used),
    });
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
  let res: Response;
  try {
    const body = JSON.stringify({ jsonrpc: '2.0', id: id ?? null, method, params });
    res = await fetch(upstreamUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    return fail(id, { code: INTERNAL_ERROR.code, message: `Upstream proxy error: ${String(e)}` });
  }

  // Non-2xx: opportunistically preserve the upstream body if it happens to
  // be a JSON-RPC error (some nodes return errors with non-2xx status).
  // Otherwise fall back to a synthetic error — nginx HTML pages, empty
  // bodies, etc. have nothing worth forwarding.
  if (!res.ok) {
    try {
      const body = await res.json() as JsonRpcResponse;
      if (body && typeof body === 'object' && 'error' in body && body.error) {
        return { jsonrpc: '2.0', id: id ?? null, error: body.error };
      }
    } catch { /* fall through to synthetic error */ }
    return fail(id, {
      code: INTERNAL_ERROR.code,
      message: `Upstream returned HTTP ${res.status} for method ${method}`,
    });
  }

  try {
    return await res.json() as JsonRpcResponse;
  } catch {
    return fail(id, {
      code: INTERNAL_ERROR.code,
      message: `Upstream returned non-JSON response for method ${method}`,
    });
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

  // opstream_* — always local, richer shapes, served from the index.
  switch (method) {
    case 'opstream_getLogs':               return handleGetLogs(id, params, db);
    case 'opstream_blockNumber':           return handleBlockNumber(id, db);
    case 'opstream_getBlockReceipts':      return handleGetBlockReceipts(id, params, db);
    case 'opstream_getBlockByNumber':      return handleGetBlockByNumber(id, params, db);
    case 'opstream_getBlockByHash':        return handleGetBlockByHash(id, params, db);
    case 'opstream_getBlockRange':         return handleGetBlockRange(id, params, db);
    case 'opstream_getTransaction':        return handleGetTransaction(id, params, db);
    case 'opstream_getTransactionReceipt': return handleGetTransactionReceipt(id, params, db);
    case 'opstream_getCodeHash':           return handleGetCodeHash(id, params, db);
  }

  // btc_* archival handlers — same name, same shape as upstream, answered
  // from the local archival index. The opnet SDK's JSONRpcProvider sends
  // these names natively, so any client just works with a speedup.
  switch (method) {
    case 'btc_getBlockByNumber':      return handleBtcGetBlockByNumber(id, params, db);
    case 'btc_getBlockByHash':        return handleBtcGetBlockByHash(id, params, db);
    case 'btc_getTransactionReceipt': return handleBtcGetTransactionReceipt(id, params, db);
  }

  // btc_* — strict proxy against the known upstream surface. Anything not
  // in the allowlist (typos, deprecated methods, opstream_* misspellings)
  // gets a local -32601 instead of a slow upstream round trip.
  if (UPSTREAM_METHODS.has(method)) {
    return proxyToUpstream(id, method, params, upstreamUrl);
  }
  return fail(id, { code: METHOD_NOT_FOUND.code, message: `Method not found: ${method}` });
}

// ---------------------------------------------------------------------------
// HTTP handler — exported for testing
// ---------------------------------------------------------------------------

export function createRpcHandler(
  db: DbAdapter,
  upstreamUrlRaw: string,
  syncSecret: string | null = null,
): (req: IncomingMessage, res: ServerResponse) => void {
  const upstreamUrl = normalizeUpstreamUrl(upstreamUrlRaw);
  const syncHandler = createSyncHandler(db, syncSecret);

  return (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      // Route /sync/* to the sync handler (GET)
      if (req.url?.startsWith('/sync/')) {
        syncHandler(req, res);
        return;
      }

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

      const ip = (req.headers['x-forwarded-for'] as string | undefined)
        ?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? 'unknown';

      let response: unknown;

      if (Array.isArray(parsed)) {
        if (parsed.length === 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(fail(null, INVALID_REQUEST)));
          return;
        }
        log('INFO', 'rpc', `${ip} batch[${parsed.length}]`);
        response = await Promise.all(parsed.map((r) => handleSingle(r, db, upstreamUrl)));
      } else {
        const method = isValidRequest(parsed) ? parsed.method : '<invalid>';
        log('INFO', 'rpc', `${ip} ${method}`);
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
export function startRpcServer(
  port: number,
  db: DbAdapter,
  upstreamUrl: string,
  syncSecret: string | null = null,
): void {
  if (_server) return;
  _server = createServer(createRpcHandler(db, upstreamUrl, syncSecret));
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

