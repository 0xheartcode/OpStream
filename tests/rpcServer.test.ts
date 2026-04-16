import { createServer, request as nodeRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestDb } from '../src/core/db.js';
import { insertEventsBatch } from '../src/indexer/eventStore.js';
import { stopRpcServer, createRpcHandler } from '../src/rpc/rpcServer.js';
import type { DbAdapter } from '../src/core/dbAdapter.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Start an HTTP server on a random OS-assigned port. Returns the base URL. */
function startTestServer(db: DbAdapter, upstreamUrl = 'http://upstream.invalid'): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer(createRpcHandler(db, upstreamUrl));
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      const url = `http://127.0.0.1:${port}`;
      const close = () => new Promise<void>((res) => server.close(() => res()));
      resolve({ url, close });
    });
  });
}

/** Convenience wrapper: POST a JSON-RPC request and parse the response. */
async function rpc(url: string, method: string, params?: unknown, id: string | number = 1) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

/**
 * HTTP POST using node:http directly — bypasses global `fetch` so it works
 * even when fetch is stubbed for proxy tests.
 */
function nodePost(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = nodeRequest({
      hostname: u.hostname,
      port: Number(u.port),
      path: u.pathname || '/',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk: string) => { raw += chunk; });
      res.on('end', () => { try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/** Seed a scan_checkpoints row so opstream_blockNumber / "latest" resolution works. */
async function seedCheckpoint(db: DbAdapter, lastBlock: number): Promise<void> {
  await db.run(
    "INSERT OR REPLACE INTO scan_checkpoints (scan_type, last_block, updated_at) VALUES ('indexer', ?, ?)",
    [lastBlock, Math.floor(Date.now() / 1000)],
  );
}

/** Seed a blocks row. */
async function seedBlock(db: DbAdapter, blockNumber: number, hash = 'hash_' + blockNumber): Promise<void> {
  await db.run(
    'INSERT OR REPLACE INTO blocks (block_number, block_hash, timestamp, tx_count) VALUES (?, ?, ?, ?)',
    [blockNumber, hash, 1_700_000_000 + blockNumber, 0],
  );
}

/** Seed a transaction row. */
async function seedTx(db: DbAdapter, txHash: string, blockNumber: number, txIndex = 0): Promise<void> {
  await db.run(
    `INSERT OR IGNORE INTO transactions
       (tx_hash, block_number, tx_index, tx_type, from_address, contract_address, gas_used, burned_bitcoin, priority_fee, failed, created_at)
     VALUES (?, ?, ?, 'Interaction', 'bc1qfrom', 'bc1qcontract', '5000', '100', '10', 0, ?)`,
    [txHash, blockNumber, txIndex, Math.floor(Date.now() / 1000)],
  );
}

/** Seed a contract deployment row. */
async function seedDeployment(
  db: DbAdapter,
  contractAddress: string,
  bytecodeHash: string,
  blockNumber = 100,
  txHash = 'deploy_' + contractAddress,
): Promise<void> {
  await db.run(
    `INSERT OR IGNORE INTO contract_deployments
       (block_number, tx_hash, contract_address, deployer, bytecode_hash)
     VALUES (?, ?, ?, 'bc1qdeployer', ?)`,
    [blockNumber, txHash, contractAddress, bytecodeHash],
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RPC server — HTTP basics', () => {
  let url: string;
  let close: () => Promise<void>;
  let db: DbAdapter;

  beforeAll(async () => {
    db = createTestDb();
    ({ url, close } = await startTestServer(db));
  });

  afterAll(() => close());

  it('GET returns 405 with Allow: POST header', async () => {
    const res = await fetch(url, { method: 'GET' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('PUT returns 405', async () => {
    const res = await fetch(url, { method: 'PUT', body: '{}' });
    expect(res.status).toBe(405);
  });

  it('POST returns 200 even for bad JSON', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'NOT_JSON',
    });
    expect(res.status).toBe(200);
  });

  it('response always has Content-Type: application/json', async () => {
    const { headers } = await rpc(url, 'opstream_blockNumber', []);
    expect(headers.get('content-type')).toContain('application/json');
  });
});

describe('RPC server — parse errors', () => {
  let url: string;
  let close: () => Promise<void>;
  let db: DbAdapter;

  beforeAll(async () => {
    db = createTestDb();
    ({ url, close } = await startTestServer(db));
  });

  afterAll(() => close());

  it('invalid JSON → -32700 Parse error', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad json',
    });
    const body = await res.json() as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
    expect(body.id).toBeNull();
  });

  it('empty body → -32700', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '',
    });
    const body = await res.json() as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it('empty batch array → -32600 Invalid Request', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '[]',
    });
    const body = await res.json() as { error: { code: number } };
    expect(body.error.code).toBe(-32600);
  });
});

describe('RPC server — invalid request', () => {
  let url: string;
  let close: () => Promise<void>;
  let db: DbAdapter;

  beforeAll(async () => {
    db = createTestDb();
    ({ url, close } = await startTestServer(db));
  });

  afterAll(() => close());

  it('missing jsonrpc field → -32600', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 1, method: 'opstream_blockNumber' }),
    });
    const body = await res.json() as { error: { code: number } };
    expect(body.error.code).toBe(-32600);
  });

  it('wrong jsonrpc version → -32600', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'opstream_blockNumber' }),
    });
    const body = await res.json() as { error: { code: number } };
    expect(body.error.code).toBe(-32600);
  });

  it('missing method field → -32600', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1 }),
    });
    const body = await res.json() as { error: { code: number } };
    expect(body.error.code).toBe(-32600);
  });
});

describe('opstream_blockNumber', () => {
  let url: string;
  let close: () => Promise<void>;
  let db: DbAdapter;

  beforeAll(async () => {
    db = createTestDb();
    ({ url, close } = await startTestServer(db));
  });

  afterAll(() => close());

  it('returns 0x0 when no checkpoint exists', async () => {
    const { body } = await rpc(url, 'opstream_blockNumber', []);
    expect(body.result).toBe('0x0');
  });

  it('returns hex block number from checkpoint', async () => {
    await seedCheckpoint(db, 100);
    const { body } = await rpc(url, 'opstream_blockNumber', []);
    expect(body.result).toBe('0x64'); // 100 decimal
  });

  it('echoes the request id', async () => {
    const { body } = await rpc(url, 'opstream_blockNumber', [], 42);
    expect(body.id).toBe(42);
  });

  it('echoes string ids', async () => {
    const { body } = await rpc(url, 'opstream_blockNumber', [], 'req-abc');
    expect(body.id).toBe('req-abc');
  });
});

describe('opstream_getLogs', () => {
  let url: string;
  let close: () => Promise<void>;
  let db: DbAdapter;

  beforeAll(async () => {
    db = createTestDb();
    await seedCheckpoint(db, 500);

    // Insert 4 events across 2 contracts and 2 event names
    await insertEventsBatch(db, [
      { blockNumber: 100, txHash: 'tx1', contractAddress: 'bc1qa', eventName: 'Swap',     rawData: Buffer.from('aa', 'hex') },
      { blockNumber: 100, txHash: 'tx2', contractAddress: 'bc1qa', eventName: 'Transfer', rawData: Buffer.from('bb', 'hex') },
      { blockNumber: 200, txHash: 'tx3', contractAddress: 'bc1qb', eventName: 'Swap',     rawData: Buffer.from('cc', 'hex') },
      { blockNumber: 300, txHash: 'tx4', contractAddress: 'bc1qb', eventName: 'Transfer', rawData: Buffer.from('dd', 'hex') },
    ]);

    ({ url, close } = await startTestServer(db));
  });

  afterAll(() => close());

  it('no filter returns all 4 events', async () => {
    const { body } = await rpc(url, 'opstream_getLogs', [{}]);
    expect(body.result.items).toHaveLength(4);
  });

  it('filter by address', async () => {
    const { body } = await rpc(url, 'opstream_getLogs', [{ address: 'bc1qa' }]);
    expect(body.result.items).toHaveLength(2);
    for (const log of body.result.items) {
      expect(log.address).toBe('bc1qa');
    }
  });

  it('filter by eventName', async () => {
    const { body } = await rpc(url, 'opstream_getLogs', [{ eventName: 'Swap' }]);
    expect(body.result.items).toHaveLength(2);
    for (const log of body.result.items) {
      expect(log.topics[0]).toBe('Swap');
    }
  });

  it('filter by fromBlock + toBlock', async () => {
    const { body } = await rpc(url, 'opstream_getLogs', [{ fromBlock: 100, toBlock: 200 }]);
    expect(body.result.items).toHaveLength(3);
  });

  it('filter by combined address + eventName', async () => {
    const { body } = await rpc(url, 'opstream_getLogs', [{ address: 'bc1qa', eventName: 'Swap' }]);
    expect(body.result.items).toHaveLength(1);
    expect(body.result.items[0].address).toBe('bc1qa');
    expect(body.result.items[0].topics[0]).toBe('Swap');
  });

  it('returned log has correct shape', async () => {
    const { body } = await rpc(url, 'opstream_getLogs', [{ address: 'bc1qa', eventName: 'Swap' }]);
    const log = body.result.items[0];
    expect(typeof log.address).toBe('string');
    expect(Array.isArray(log.topics)).toBe(true);
    expect(typeof log.data).toBe('string');
    expect(log.blockNumber).toMatch(/^0x/);
    expect(typeof log.transactionHash).toBe('string');
    expect(typeof log.logIndex).toBe('number');
  });

  it('"latest" resolves to checkpoint block', async () => {
    const { body } = await rpc(url, 'opstream_getLogs', [{ fromBlock: 'latest', toBlock: 'latest' }]);
    // No events at block 500, result should be empty (not an error)
    expect(Array.isArray(body.result.items)).toBe(true);
    expect(body.error).toBeUndefined();
  });

  it('hex fromBlock string is parsed correctly', async () => {
    // 0x64 = 100
    const { body } = await rpc(url, 'opstream_getLogs', [{ fromBlock: '0x64', toBlock: '0x64' }]);
    expect(body.result.items).toHaveLength(2); // two events at block 100
  });

  it('missing params → -32602', async () => {
    const { body } = await rpc(url, 'opstream_getLogs');
    expect(body.error.code).toBe(-32602);
  });

  it('empty params array → -32602', async () => {
    const { body } = await rpc(url, 'opstream_getLogs', []);
    expect(body.error.code).toBe(-32602);
  });

  it('null filter → -32602', async () => {
    const { body } = await rpc(url, 'opstream_getLogs', [null]);
    expect(body.error.code).toBe(-32602);
  });
});

describe('opstream_getBlockReceipts', () => {
  let url: string;
  let close: () => Promise<void>;
  let db: DbAdapter;

  beforeAll(async () => {
    db = createTestDb();
    await seedCheckpoint(db, 500);
    await seedBlock(db, 941400, 'blockhash_941400');
    await seedTx(db, 'txA', 941400, 0);
    await seedTx(db, 'txB', 941400, 1);
    await insertEventsBatch(db, [
      { blockNumber: 941400, txHash: 'txA', contractAddress: 'bc1qc', eventName: 'Swap',     rawData: Buffer.from('ee', 'hex') },
      { blockNumber: 941400, txHash: 'txB', contractAddress: 'bc1qc', eventName: 'Transfer', rawData: Buffer.from('ff', 'hex') },
    ]);
    ({ url, close } = await startTestServer(db));
  });

  afterAll(() => close());

  it('unknown block returns null', async () => {
    const { body } = await rpc(url, 'opstream_getBlockReceipts', [999999]);
    expect(body.result).toBeNull();
  });

  it('known block returns correct shape', async () => {
    const { body } = await rpc(url, 'opstream_getBlockReceipts', [941400]);
    const result = body.result;
    expect(result.block_number).toBe(941400);
    expect(result.block_hash).toBe('blockhash_941400');
    expect(Array.isArray(result.transactions)).toBe(true);
  });

  it('transactions are ordered by tx_index', async () => {
    const { body } = await rpc(url, 'opstream_getBlockReceipts', [941400]);
    const txs = body.result.transactions as Array<{ hash: string }>;
    expect(txs[0]!.hash).toBe('txA');
    expect(txs[1]!.hash).toBe('txB');
  });

  it('events nested under correct transaction', async () => {
    const { body } = await rpc(url, 'opstream_getBlockReceipts', [941400]);
    const txA = (body.result.transactions as Array<{ hash: string; events: Array<{ type: string }> }>)
      .find((t) => t.hash === 'txA')!;
    expect(txA.events).toHaveLength(1);
    expect(txA.events[0]!.type).toBe('Swap');
  });

  it('"latest" resolves via checkpoint', async () => {
    // Checkpoint is 500, no block at 500 → null
    const { body } = await rpc(url, 'opstream_getBlockReceipts', ['latest']);
    expect(body.result).toBeNull();
    expect(body.error).toBeUndefined();
  });

  it('missing params → -32602', async () => {
    const { body } = await rpc(url, 'opstream_getBlockReceipts');
    expect(body.error.code).toBe(-32602);
  });
});

describe('opstream_getTransaction', () => {
  let url: string;
  let close: () => Promise<void>;
  let db: DbAdapter;

  beforeAll(async () => {
    db = createTestDb();
    await seedTx(db, 'txKnown', 100, 0);
    await insertEventsBatch(db, [
      { blockNumber: 100, txHash: 'txKnown', contractAddress: 'bc1qd', eventName: 'Mint', rawData: Buffer.from('ab', 'hex') },
    ]);
    ({ url, close } = await startTestServer(db));
  });

  afterAll(() => close());

  it('unknown hash returns null', async () => {
    const { body } = await rpc(url, 'opstream_getTransaction', ['0xdeadbeef']);
    expect(body.result).toBeNull();
  });

  it('known hash returns tx fields', async () => {
    const { body } = await rpc(url, 'opstream_getTransaction', ['txKnown']);
    expect(body.result.hash).toBe('txKnown');
    expect(parseInt(body.result.blockNumber as string, 16)).toBe(100);
    expect(typeof body.result.OPNetType).toBe('string');
  });

  it('associated events are included', async () => {
    const { body } = await rpc(url, 'opstream_getTransaction', ['txKnown']);
    expect(body.result.events).toHaveLength(1);
    expect(body.result.events[0].type).toBe('Mint');
  });

  it('missing params → -32602', async () => {
    const { body } = await rpc(url, 'opstream_getTransaction');
    expect(body.error.code).toBe(-32602);
  });

  it('non-string param → -32602', async () => {
    const { body } = await rpc(url, 'opstream_getTransaction', [42]);
    expect(body.error.code).toBe(-32602);
  });
});

describe('RPC server — proxy pass-through', () => {
  let url: string;
  let close: () => Promise<void>;
  let db: DbAdapter;

  // vi.unstubAllGlobals() is required — vi.restoreAllMocks() does NOT restore
  // stubs created with vi.stubGlobal(), so without this the fetch stub leaks
  // into subsequent describe blocks.
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  beforeAll(async () => {
    db = createTestDb();
    ({ url, close } = await startTestServer(db, 'http://upstream.example'));
  });

  afterAll(() => close());

  it('allowlisted btc_* method is proxied with correct body to normalized URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: 'proxied' }),
    } as Response);
    vi.stubGlobal('fetch', mockFetch);

    // Use nodePost (node:http) so the stub does not intercept our own HTTP call
    const { body } = await nodePost(url, { jsonrpc: '2.0', id: 1, method: 'btc_getBalance', params: ['bc1qtest'] });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [calledUrl, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    // Base URL was 'http://upstream.example' — must be normalized to include /api/v1/json-rpc
    expect(calledUrl).toBe('http://upstream.example/api/v1/json-rpc');
    const sent = JSON.parse(init.body as string) as { method: string; params: unknown[] };
    expect(sent.method).toBe('btc_getBalance');
    expect(sent.params).toEqual(['bc1qtest']);
    expect((body as { result: string }).result).toBe('proxied');
  });

  it('unknown btc_* method (not in upstream allowlist) returns -32601 without a network call', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const { body } = await nodePost(url, { jsonrpc: '2.0', id: 1, method: 'btc_unknownMethod', params: [] });
    const b = body as { error: { code: number; message: string } };
    expect(b.error.code).toBe(-32601);
    expect(b.error.message).toContain('btc_unknownMethod');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('proxy fetch error on allowlisted method returns -32603', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', mockFetch);

    const { body } = await nodePost(url, { jsonrpc: '2.0', id: 1, method: 'btc_getCode', params: ['bc1q'] });
    const b = body as { error: { code: number; message: string } };
    expect(b.error.code).toBe(-32603);
    expect(b.error.message).toContain('Upstream proxy error');
  });

  it('proxy: upstream HTTP 404 on allowlisted method returns clean -32603', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.reject(new Error('should not be called')),
    } as unknown as Response);
    vi.stubGlobal('fetch', mockFetch);

    const { body } = await nodePost(url, { jsonrpc: '2.0', id: 1, method: 'btc_getCode', params: ['bc1q'] });
    const b = body as { error: { code: number; message: string } };
    expect(b.error.code).toBe(-32603);
    expect(b.error.message).toBe('Upstream returned HTTP 404 for method btc_getCode');
  });

  it('proxy: non-JSON upstream body returns clean -32603', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      // Simulate upstream returning HTML
      json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
    } as unknown as Response);
    vi.stubGlobal('fetch', mockFetch);

    const { body } = await nodePost(url, { jsonrpc: '2.0', id: 1, method: 'btc_chainId', params: [] });
    const b = body as { error: { code: number; message: string } };
    expect(b.error.code).toBe(-32603);
    expect(b.error.message).toBe('Upstream returned non-JSON response for method btc_chainId');
  });
});

describe('RPC server — batch requests', () => {
  let url: string;
  let close: () => Promise<void>;
  let db: DbAdapter;

  beforeAll(async () => {
    db = createTestDb();
    await seedCheckpoint(db, 200);
    ({ url, close } = await startTestServer(db));
  });

  afterAll(() => close());

  it('batch of two valid requests returns two responses', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'opstream_blockNumber', params: [] },
        { jsonrpc: '2.0', id: 2, method: 'opstream_blockNumber', params: [] },
      ]),
    });
    const body = await res.json() as Array<{ id: number; result: string }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    expect(body.find((r) => r.id === 1)!.result).toBe('0xc8'); // 200
    expect(body.find((r) => r.id === 2)!.result).toBe('0xc8');
  });

  it('batch with one invalid item — that item gets -32600, others succeed', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'opstream_blockNumber', params: [] },
        { jsonrpc: '1.0', id: 2, method: 'opstream_blockNumber' },  // wrong version
      ]),
    });
    const body = await res.json() as Array<{ id: number; result?: string; error?: { code: number } }>;
    expect(body).toHaveLength(2);
    const ok = body.find((r) => r.id === 1)!;
    const bad = body.find((r) => r.id === 2)!;
    expect(ok.result).toBe('0xc8');
    expect(bad.error?.code).toBe(-32600);
  });
});

describe('opstream_getBlockByNumber', () => {
  let url: string;
  let close: () => Promise<void>;
  let db: DbAdapter;

  beforeAll(async () => {
    db = createTestDb();
    await seedCheckpoint(db, 500);
    await seedBlock(db, 941500, 'blockhash_941500');
    await seedTx(db, 'txBN_A', 941500, 0);
    await seedTx(db, 'txBN_B', 941500, 1);
    await insertEventsBatch(db, [
      { blockNumber: 941500, txHash: 'txBN_A', contractAddress: 'bc1qbn', eventName: 'Mint', rawData: Buffer.from('01', 'hex') },
    ]);
    ({ url, close } = await startTestServer(db));
  });

  afterAll(() => close());

  it('unknown block returns null', async () => {
    const { body } = await rpc(url, 'opstream_getBlockByNumber', [999999]);
    expect(body.result).toBeNull();
  });

  it('slim form returns tx hashes (default)', async () => {
    const { body } = await rpc(url, 'opstream_getBlockByNumber', [941500]);
    expect(body.result.block_number).toBe(941500);
    expect(body.result.block_hash).toBe('blockhash_941500');
    expect(body.result.transactions).toEqual(['txBN_A', 'txBN_B']);
  });

  it('full form (includeTx=true) returns RpcTransaction objects with events', async () => {
    const { body } = await rpc(url, 'opstream_getBlockByNumber', [941500, true]);
    const txs = body.result.transactions as Array<{ hash: string; events: unknown[] }>;
    expect(txs).toHaveLength(2);
    expect(txs[0]!.hash).toBe('txBN_A');
    expect(txs[0]!.events).toHaveLength(1);
    expect(txs[1]!.hash).toBe('txBN_B');
    expect(txs[1]!.events).toHaveLength(0);
  });

  it('"latest" resolves via checkpoint', async () => {
    const { body } = await rpc(url, 'opstream_getBlockByNumber', ['latest']);
    // Checkpoint 500, no block at 500 → null (not an error)
    expect(body.result).toBeNull();
    expect(body.error).toBeUndefined();
  });

  it('hex block number is parsed', async () => {
    const hex = '0x' + (941500).toString(16);
    const { body } = await rpc(url, 'opstream_getBlockByNumber', [hex]);
    expect(body.result.block_number).toBe(941500);
  });

  it('missing params → -32602', async () => {
    const { body } = await rpc(url, 'opstream_getBlockByNumber');
    expect(body.error.code).toBe(-32602);
  });
});

describe('opstream_getBlockByHash', () => {
  let url: string;
  let close: () => Promise<void>;
  let db: DbAdapter;

  beforeAll(async () => {
    db = createTestDb();
    await seedBlock(db, 941600, 'blockhash_941600');
    await seedTx(db, 'txBH_A', 941600, 0);
    ({ url, close } = await startTestServer(db));
  });

  afterAll(() => close());

  it('unknown hash returns null', async () => {
    const { body } = await rpc(url, 'opstream_getBlockByHash', ['nope']);
    expect(body.result).toBeNull();
  });

  it('known hash returns the block (slim)', async () => {
    const { body } = await rpc(url, 'opstream_getBlockByHash', ['blockhash_941600']);
    expect(body.result.block_number).toBe(941600);
    expect(body.result.transactions).toEqual(['txBH_A']);
  });

  it('includeTx=true expands transactions', async () => {
    const { body } = await rpc(url, 'opstream_getBlockByHash', ['blockhash_941600', true]);
    const txs = body.result.transactions as Array<{ hash: string }>;
    expect(txs[0]!.hash).toBe('txBH_A');
  });

  it('non-string param → -32602', async () => {
    const { body } = await rpc(url, 'opstream_getBlockByHash', [42]);
    expect(body.error.code).toBe(-32602);
  });
});

describe('opstream_getTransactionReceipt', () => {
  let url: string;
  let close: () => Promise<void>;
  let db: DbAdapter;

  beforeAll(async () => {
    db = createTestDb();
    await seedTx(db, 'txRcpt', 200, 0);
    // A failed tx with revert_reason
    await db.run(
      `INSERT OR IGNORE INTO transactions
         (tx_hash, block_number, tx_index, tx_type, from_address, contract_address, gas_used, burned_bitcoin, priority_fee, failed, revert_reason, created_at)
       VALUES ('txFail', 201, 0, 'Interaction', 'bc1qf', 'bc1qc', '3000', '50', '5', 1, 'out of gas', ?)`,
      [Math.floor(Date.now() / 1000)],
    );
    await insertEventsBatch(db, [
      { blockNumber: 200, txHash: 'txRcpt', contractAddress: 'bc1qr', eventName: 'Transfer', rawData: Buffer.from('77', 'hex') },
    ]);
    ({ url, close } = await startTestServer(db));
  });

  afterAll(() => close());

  it('unknown hash returns null', async () => {
    const { body } = await rpc(url, 'opstream_getTransactionReceipt', ['0xdeadbeef']);
    expect(body.result).toBeNull();
  });

  it('successful tx receipt includes events and failed=false', async () => {
    const { body } = await rpc(url, 'opstream_getTransactionReceipt', ['txRcpt']);
    expect(body.result.hash).toBe('txRcpt');
    expect(body.result.revert).toBeUndefined(); // no revert field = not failed
    expect(body.result.events).toHaveLength(1);
    expect(body.result.events[0].type).toBe('Transfer');
  });

  it('failed tx surfaces revert reason', async () => {
    const { body } = await rpc(url, 'opstream_getTransactionReceipt', ['txFail']);
    expect(typeof body.result.revert).toBe('string');
    expect(body.result.revert).toBe('out of gas');
  });

  it('missing params → -32602', async () => {
    const { body } = await rpc(url, 'opstream_getTransactionReceipt');
    expect(body.error.code).toBe(-32602);
  });
});

describe('opstream_getCodeHash', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('local hit returns stored bytecode_hash without touching upstream', async () => {
    const db = createTestDb();
    await seedDeployment(db, 'bc1qcontract1', '0xabc123hash');
    const { url, close } = await startTestServer(db, 'http://upstream.invalid');

    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    try {
      const { body } = await nodePost(url, {
        jsonrpc: '2.0',
        id: 1,
        method: 'opstream_getCodeHash',
        params: ['bc1qcontract1'],
      });
      expect((body as { result: string }).result).toBe('0xabc123hash');
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it('local miss returns null — no proxy fallback (upstream has no getCodeHash)', async () => {
    const db = createTestDb();
    const { url, close } = await startTestServer(db, 'http://upstream.invalid');

    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    try {
      const { body } = await nodePost(url, {
        jsonrpc: '2.0',
        id: 1,
        method: 'opstream_getCodeHash',
        params: ['bc1qunknown'],
      });
      expect((body as { result: unknown }).result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it('non-string param → -32602', async () => {
    const db = createTestDb();
    const { url, close } = await startTestServer(db);
    try {
      const { body } = await rpc(url, 'opstream_getCodeHash', [42]);
      expect(body.error.code).toBe(-32602);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// btc_* archival handlers — local-served upstream-shape responses
// ---------------------------------------------------------------------------

/** Seed a fully-populated archival block row, mirroring IBlockCommon fields. */
async function seedArchivalBlock(db: DbAdapter, n: number, hash: string): Promise<void> {
  await db.run(
    `INSERT OR REPLACE INTO blocks (
       block_number, block_hash, timestamp, tx_count, opnet_tx_count,
       previous_block_hash, previous_block_checksum, bits, nonce, version,
       size, weight, stripped_size, median_time,
       checksum_root, merkle_root, storage_root, receipt_root,
       ema, base_gas, block_gas_used, checksum_proofs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      n, hash, 1_700_000_000_000 + n, 3448, 7,
      'prev_hash', 'prev_checksum', '1701f0cc', 4149709870, 742178816,
      1611176, 3993803, 794209, 1_700_000_000_000 + n - 600,
      'checksum_root_hex', 'merkle_root_hex', '0xstorage', '0xreceipt',
      'ema_val', 'base_gas_val', '0xblockgas',
      JSON.stringify([[0, ['0xproof0a', '0xproof0b']], [1, ['0xproof1a']]]),
    ],
  );
}

describe('btc_getBlockByNumber (archival)', () => {
  let url: string;
  let close: () => Promise<void>;
  let db: DbAdapter;

  beforeAll(async () => {
    db = createTestDb();
    await seedArchivalBlock(db, 941400, 'blockhash_941400');
    ({ url, close } = await startTestServer(db));
  });
  afterAll(() => close());

  it('returns upstream IBlockCommon shape with all fields populated', async () => {
    const { body } = await rpc(url, 'btc_getBlockByNumber', [941400]);
    const r = body.result;
    expect(r.hash).toBe('blockhash_941400');
    expect(r.height).toBe('941400'); // string, per upstream
    expect(r.txCount).toBe(3448);
    expect(r.bits).toBe('1701f0cc');
    expect(r.nonce).toBe(4149709870);
    expect(r.version).toBe(742178816);
    expect(r.size).toBe(1611176);
    expect(r.weight).toBe(3993803);
    expect(r.strippedSize).toBe(794209);
    expect(r.previousBlockHash).toBe('prev_hash');
    expect(r.merkleRoot).toBe('merkle_root_hex');
    expect(r.storageRoot).toBe('0xstorage');
    expect(r.receiptRoot).toBe('0xreceipt');
    expect(r.checksumProofs).toEqual([[0, ['0xproof0a', '0xproof0b']], [1, ['0xproof1a']]]);
    // Should NOT have a transactions field — upstream returns header only
    expect(r.transactions).toBeUndefined();
  });

  it('unknown block returns null', async () => {
    const { body } = await rpc(url, 'btc_getBlockByNumber', [999999]);
    expect(body.result).toBeNull();
  });

  it('hex block number is parsed', async () => {
    const hex = '0x' + (941400).toString(16);
    const { body } = await rpc(url, 'btc_getBlockByNumber', [hex]);
    expect(body.result.height).toBe('941400');
  });

  it('missing params → -32602', async () => {
    const { body } = await rpc(url, 'btc_getBlockByNumber');
    expect(body.error.code).toBe(-32602);
  });
});

describe('btc_getBlockByHash (archival)', () => {
  let url: string;
  let close: () => Promise<void>;
  let db: DbAdapter;

  beforeAll(async () => {
    db = createTestDb();
    await seedArchivalBlock(db, 941500, 'hash_941500');
    ({ url, close } = await startTestServer(db));
  });
  afterAll(() => close());

  it('returns the same upstream shape by hash', async () => {
    const { body } = await rpc(url, 'btc_getBlockByHash', ['hash_941500']);
    expect(body.result.height).toBe('941500');
    expect(body.result.hash).toBe('hash_941500');
    expect(body.result.checksumProofs).toBeDefined();
  });

  it('unknown hash returns null', async () => {
    const { body } = await rpc(url, 'btc_getBlockByHash', ['nope']);
    expect(body.result).toBeNull();
  });
});

describe('btc_getTransactionReceipt (archival)', () => {
  let url: string;
  let close: () => Promise<void>;
  let db: DbAdapter;

  beforeAll(async () => {
    db = createTestDb();
    // Successful tx with receipt + proofs + an event
    await db.run(
      `INSERT OR IGNORE INTO transactions
         (tx_hash, block_number, tx_index, tx_type, from_address, contract_address,
          gas_used, special_gas_used, burned_bitcoin, priority_fee, failed, revert_reason,
          receipt, receipt_proofs, created_at)
       VALUES ('txArchOk', 300, 0, 'interaction', 'bc1qf', 'bc1qc',
               '554155299', '0', '100', '10000', 0, NULL,
               x'deadbeef', ?, 1700000000)`,
      [JSON.stringify(['0xproof1', '0xproof2'])],
    );
    // Failed tx
    await db.run(
      `INSERT OR IGNORE INTO transactions
         (tx_hash, block_number, tx_index, tx_type, from_address, contract_address,
          gas_used, special_gas_used, burned_bitcoin, priority_fee, failed, revert_reason, created_at)
       VALUES ('txArchFail', 300, 1, 'interaction', 'bc1qf', 'bc1qc',
               '1000', '0', '10', '100', 1, 'out of gas', 1700000000)`,
    );
    await insertEventsBatch(db, [
      { blockNumber: 300, txHash: 'txArchOk', contractAddress: '0xabc', eventName: 'Minted', rawData: Buffer.from('aabb', 'hex') },
    ]);
    ({ url, close } = await startTestServer(db));
  });
  afterAll(() => close());

  it('returns upstream ITransactionReceipt shape: receipt/receiptProofs/events/gasUsed/specialGasUsed', async () => {
    const { body } = await rpc(url, 'btc_getTransactionReceipt', ['txArchOk']);
    const r = body.result;
    // receipt: base64 of the raw bytes stored as BLOB
    expect(r.receipt).toBe(Buffer.from('deadbeef', 'hex').toString('base64'));
    expect(r.receiptProofs).toEqual(['0xproof1', '0xproof2']);
    expect(r.gasUsed).toBe('0x2107bd23'); // 554155299 → 0x2107bd23
    expect(r.specialGasUsed).toBe('0x0');
    expect(r.revert).toBeUndefined(); // successful tx, no revert field
    expect(r.events).toHaveLength(1);
    expect(r.events[0].contractAddress).toBe('0xabc');
    expect(r.events[0].type).toBe('Minted');
    // data is base64-encoded raw bytes
    expect(r.events[0].data).toBe(Buffer.from('aabb', 'hex').toString('base64'));
  });

  it('failed tx surfaces revert reason', async () => {
    const { body } = await rpc(url, 'btc_getTransactionReceipt', ['txArchFail']);
    expect(body.result.revert).toBe('out of gas');
    expect(body.result.gasUsed).toBe('0x3e8'); // 1000 → 0x3e8
  });

  it('empty receipt_proofs stores as empty array in response', async () => {
    const db2 = createTestDb();
    await db2.run(
      `INSERT INTO transactions (tx_hash, block_number, tx_index, tx_type, failed, created_at)
       VALUES ('txEmpty', 1, 0, 'interaction', 0, 1700000000)`,
    );
    const { url: url2, close: close2 } = await startTestServer(db2);
    try {
      const { body } = await rpc(url2, 'btc_getTransactionReceipt', ['txEmpty']);
      expect(body.result.receipt).toBe('');
      expect(body.result.receiptProofs).toEqual([]);
      expect(body.result.events).toEqual([]);
    } finally {
      await close2();
    }
  });

  it('unknown hash returns null', async () => {
    const { body } = await rpc(url, 'btc_getTransactionReceipt', ['0xdoesnotexist']);
    expect(body.result).toBeNull();
  });

  it('btc_* archival handler does NOT consult the upstream proxy', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    try {
      await nodePost(url, { jsonrpc: '2.0', id: 1, method: 'btc_getTransactionReceipt', params: ['txArchOk'] });
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------------------
// opstream_getTransactionStatus
// ---------------------------------------------------------------------------

describe('opstream_getTransactionStatus', () => {
  let url: string;
  let close: () => Promise<void>;
  let db: DbAdapter;

  // Seed a mempool_pending table with one row in each lifecycle state:
  //   txPending   — confirmed_at NULL, pruned_at NULL (still in mempool)
  //   txConfirmed — confirmed_at set (crosslinked by block scanner)
  //   txDropped   — pruned_at set (evicted from mempool)
  // Also seed the transactions table with txConfirmed so the block-number
  // fallback path can resolve it.
  beforeAll(async () => {
    db = await createTestDb();

    await db.run(`
      INSERT INTO mempool_pending (txid, raw_payload_hex, contract_selector, confirmed_at, pruned_at)
      VALUES
        ('txPending',   'deadbeef', NULL, NULL,       NULL),
        ('txConfirmed', 'deadbeef', NULL, 1700000001, NULL),
        ('txDropped',   'deadbeef', NULL, NULL,       1700000002)
    `);

    // Insert a matching transactions row so block_number resolution works
    await db.run(`
      INSERT INTO transactions (tx_hash, block_number, tx_index, tx_type)
      VALUES ('txConfirmed', 42, 0, 'INTERACTION')
    `);

    ({ url, close } = await startTestServer(db));
  });

  afterAll(async () => { await close(); });

  it('returns status=pending for an unresolved mempool tx', async () => {
    const { body } = await rpc(url, 'opstream_getTransactionStatus', ['txPending']);
    expect(body.result.txid).toBe('txPending');
    expect(body.result.status).toBe('pending');
    expect(body.result.blockNumber).toBeNull();
    expect(body.result.confirmedAt).toBeNull();
    expect(body.result.prunedAt).toBeNull();
  });

  it('returns status=confirmed with blockNumber when crosslinked', async () => {
    const { body } = await rpc(url, 'opstream_getTransactionStatus', ['txConfirmed']);
    expect(body.result.status).toBe('confirmed');
    expect(body.result.blockNumber).toBe(42);
    expect(body.result.confirmedAt).toBe(1700000001);
    expect(body.result.prunedAt).toBeNull();
  });

  it('returns status=dropped for an evicted mempool tx', async () => {
    const { body } = await rpc(url, 'opstream_getTransactionStatus', ['txDropped']);
    expect(body.result.status).toBe('dropped');
    expect(body.result.prunedAt).toBe(1700000002);
    expect(body.result.blockNumber).toBeNull();
    expect(body.result.confirmedAt).toBeNull();
  });

  it('returns status=confirmed via transactions table when mempool_pending row is gone', async () => {
    // Simulate post-TTL pruning: insert directly into transactions, no mempool_pending row
    await db.run(`
      INSERT INTO transactions (tx_hash, block_number, tx_index, tx_type)
      VALUES ('txOldConfirmed', 99, 0, 'INTERACTION')
    `);
    const { body } = await rpc(url, 'opstream_getTransactionStatus', ['txOldConfirmed']);
    expect(body.result.status).toBe('confirmed');
    expect(body.result.blockNumber).toBe(99);
    expect(body.result.confirmedAt).toBeNull(); // no mempool row — timestamp unavailable
  });

  it('returns status=unknown for a txid never seen', async () => {
    const { body } = await rpc(url, 'opstream_getTransactionStatus', ['txNeverSeen']);
    expect(body.result.status).toBe('unknown');
    expect(body.result.blockNumber).toBeNull();
    expect(body.result.confirmedAt).toBeNull();
    expect(body.result.prunedAt).toBeNull();
  });

  it('returns error on missing params', async () => {
    const { body } = await rpc(url, 'opstream_getTransactionStatus');
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe(-32602);
  });

  it('returns error on empty string txid', async () => {
    const { body } = await rpc(url, 'opstream_getTransactionStatus', ['']);
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe(-32602);
  });

  it('returns error on non-string param', async () => {
    const { body } = await rpc(url, 'opstream_getTransactionStatus', [12345]);
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe(-32602);
  });
});

describe('startRpcServer / stopRpcServer lifecycle', () => {
  afterEach(() => {
    stopRpcServer();
    vi.restoreAllMocks();
  });

  it('stopRpcServer on never-started server is a no-op', () => {
    expect(() => stopRpcServer()).not.toThrow();
  });
});
