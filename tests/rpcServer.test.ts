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

/** Seed a scan_checkpoints row so btc_blockNumber / "latest" resolution works. */
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

/** Seed a contract deployment row (table is still `token_deployments` pre-rename). */
async function seedDeployment(
  db: DbAdapter,
  contractAddress: string,
  bytecodeHash: string,
  blockNumber = 100,
  txHash = 'deploy_' + contractAddress,
): Promise<void> {
  await db.run(
    `INSERT OR IGNORE INTO token_deployments
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
    const { headers } = await rpc(url, 'btc_blockNumber', []);
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
      body: JSON.stringify({ id: 1, method: 'btc_blockNumber' }),
    });
    const body = await res.json() as { error: { code: number } };
    expect(body.error.code).toBe(-32600);
  });

  it('wrong jsonrpc version → -32600', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'btc_blockNumber' }),
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

describe('btc_blockNumber', () => {
  let url: string;
  let close: () => Promise<void>;
  let db: DbAdapter;

  beforeAll(async () => {
    db = createTestDb();
    ({ url, close } = await startTestServer(db));
  });

  afterAll(() => close());

  it('returns 0x0 when no checkpoint exists', async () => {
    const { body } = await rpc(url, 'btc_blockNumber', []);
    expect(body.result).toBe('0x0');
  });

  it('returns hex block number from checkpoint', async () => {
    await seedCheckpoint(db, 100);
    const { body } = await rpc(url, 'btc_blockNumber', []);
    expect(body.result).toBe('0x64'); // 100 decimal
  });

  it('echoes the request id', async () => {
    const { body } = await rpc(url, 'btc_blockNumber', [], 42);
    expect(body.id).toBe(42);
  });

  it('echoes string ids', async () => {
    const { body } = await rpc(url, 'btc_blockNumber', [], 'req-abc');
    expect(body.id).toBe('req-abc');
  });
});

describe('btc_getLogs', () => {
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
    const { body } = await rpc(url, 'btc_getLogs', [{}]);
    expect(body.result).toHaveLength(4);
  });

  it('filter by address', async () => {
    const { body } = await rpc(url, 'btc_getLogs', [{ address: 'bc1qa' }]);
    expect(body.result).toHaveLength(2);
    for (const log of body.result) {
      expect(log.address).toBe('bc1qa');
    }
  });

  it('filter by eventName', async () => {
    const { body } = await rpc(url, 'btc_getLogs', [{ eventName: 'Swap' }]);
    expect(body.result).toHaveLength(2);
    for (const log of body.result) {
      expect(log.topics[0]).toBe('Swap');
    }
  });

  it('filter by fromBlock + toBlock', async () => {
    const { body } = await rpc(url, 'btc_getLogs', [{ fromBlock: 100, toBlock: 200 }]);
    expect(body.result).toHaveLength(3);
  });

  it('filter by combined address + eventName', async () => {
    const { body } = await rpc(url, 'btc_getLogs', [{ address: 'bc1qa', eventName: 'Swap' }]);
    expect(body.result).toHaveLength(1);
    expect(body.result[0].address).toBe('bc1qa');
    expect(body.result[0].topics[0]).toBe('Swap');
  });

  it('returned log has correct shape', async () => {
    const { body } = await rpc(url, 'btc_getLogs', [{ address: 'bc1qa', eventName: 'Swap' }]);
    const log = body.result[0];
    expect(typeof log.address).toBe('string');
    expect(Array.isArray(log.topics)).toBe(true);
    expect(typeof log.data).toBe('string');
    expect(log.blockNumber).toMatch(/^0x/);
    expect(typeof log.transactionHash).toBe('string');
    expect(typeof log.logIndex).toBe('number');
  });

  it('"latest" resolves to checkpoint block', async () => {
    const { body } = await rpc(url, 'btc_getLogs', [{ fromBlock: 'latest', toBlock: 'latest' }]);
    // No events at block 500, result should be empty (not an error)
    expect(Array.isArray(body.result)).toBe(true);
    expect(body.error).toBeUndefined();
  });

  it('hex fromBlock string is parsed correctly', async () => {
    // 0x64 = 100
    const { body } = await rpc(url, 'btc_getLogs', [{ fromBlock: '0x64', toBlock: '0x64' }]);
    expect(body.result).toHaveLength(2); // two events at block 100
  });

  it('missing params → -32602', async () => {
    const { body } = await rpc(url, 'btc_getLogs');
    expect(body.error.code).toBe(-32602);
  });

  it('empty params array → -32602', async () => {
    const { body } = await rpc(url, 'btc_getLogs', []);
    expect(body.error.code).toBe(-32602);
  });

  it('null filter → -32602', async () => {
    const { body } = await rpc(url, 'btc_getLogs', [null]);
    expect(body.error.code).toBe(-32602);
  });
});

describe('btc_getBlockReceipts', () => {
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
    const { body } = await rpc(url, 'btc_getBlockReceipts', [999999]);
    expect(body.result).toBeNull();
  });

  it('known block returns correct shape', async () => {
    const { body } = await rpc(url, 'btc_getBlockReceipts', [941400]);
    const result = body.result;
    expect(result.block_number).toBe(941400);
    expect(result.block_hash).toBe('blockhash_941400');
    expect(Array.isArray(result.transactions)).toBe(true);
  });

  it('transactions are ordered by tx_index', async () => {
    const { body } = await rpc(url, 'btc_getBlockReceipts', [941400]);
    const txs = body.result.transactions as Array<{ tx_hash: string }>;
    expect(txs[0]!.tx_hash).toBe('txA');
    expect(txs[1]!.tx_hash).toBe('txB');
  });

  it('events nested under correct transaction', async () => {
    const { body } = await rpc(url, 'btc_getBlockReceipts', [941400]);
    const txA = (body.result.transactions as Array<{ tx_hash: string; events: unknown[] }>)
      .find((t) => t.tx_hash === 'txA')!;
    expect(txA.events).toHaveLength(1);
    expect((txA.events[0] as { topics: string[] }).topics[0]).toBe('Swap');
  });

  it('"latest" resolves via checkpoint', async () => {
    // Checkpoint is 500, no block at 500 → null
    const { body } = await rpc(url, 'btc_getBlockReceipts', ['latest']);
    expect(body.result).toBeNull();
    expect(body.error).toBeUndefined();
  });

  it('missing params → -32602', async () => {
    const { body } = await rpc(url, 'btc_getBlockReceipts');
    expect(body.error.code).toBe(-32602);
  });
});

describe('btc_getTransaction', () => {
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
    const { body } = await rpc(url, 'btc_getTransaction', ['0xdeadbeef']);
    expect(body.result).toBeNull();
  });

  it('known hash returns tx fields', async () => {
    const { body } = await rpc(url, 'btc_getTransaction', ['txKnown']);
    expect(body.result.tx_hash).toBe('txKnown');
    expect(body.result.block_number).toBe(100);
    expect(typeof body.result.failed).toBe('boolean');
  });

  it('associated events are included', async () => {
    const { body } = await rpc(url, 'btc_getTransaction', ['txKnown']);
    expect(body.result.events).toHaveLength(1);
    expect(body.result.events[0].topics[0]).toBe('Mint');
  });

  it('missing params → -32602', async () => {
    const { body } = await rpc(url, 'btc_getTransaction');
    expect(body.error.code).toBe(-32602);
  });

  it('non-string param → -32602', async () => {
    const { body } = await rpc(url, 'btc_getTransaction', [42]);
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

  it('unknown method is proxied with correct body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: 'proxied' }),
    } as Response);
    vi.stubGlobal('fetch', mockFetch);

    // Use nodePost (node:http) so the stub does not intercept our own HTTP call
    const { body } = await nodePost(url, { jsonrpc: '2.0', id: 1, method: 'btc_getBalance', params: ['bc1qtest'] });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [calledUrl, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('http://upstream.example');
    const sent = JSON.parse(init.body as string) as { method: string; params: unknown[] };
    expect(sent.method).toBe('btc_getBalance');
    expect(sent.params).toEqual(['bc1qtest']);
    expect((body as { result: string }).result).toBe('proxied');
  });

  it('proxy fetch error returns -32603', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', mockFetch);

    // Use nodePost so the rejection does not kill our own HTTP call
    const { body } = await nodePost(url, { jsonrpc: '2.0', id: 1, method: 'btc_unknownMethod', params: [] });
    const b = body as { error: { code: number; message: string } };
    expect(b.error.code).toBe(-32603);
    expect(b.error.message).toContain('Upstream proxy error');
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
        { jsonrpc: '2.0', id: 1, method: 'btc_blockNumber', params: [] },
        { jsonrpc: '2.0', id: 2, method: 'btc_blockNumber', params: [] },
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
        { jsonrpc: '2.0', id: 1, method: 'btc_blockNumber', params: [] },
        { jsonrpc: '1.0', id: 2, method: 'btc_blockNumber' },  // wrong version
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

describe('btc_getBlockByNumber', () => {
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
    const { body } = await rpc(url, 'btc_getBlockByNumber', [999999]);
    expect(body.result).toBeNull();
  });

  it('slim form returns tx hashes (default)', async () => {
    const { body } = await rpc(url, 'btc_getBlockByNumber', [941500]);
    expect(body.result.block_number).toBe(941500);
    expect(body.result.block_hash).toBe('blockhash_941500');
    expect(body.result.transactions).toEqual(['txBN_A', 'txBN_B']);
  });

  it('full form (includeTx=true) returns RpcTransaction objects with events', async () => {
    const { body } = await rpc(url, 'btc_getBlockByNumber', [941500, true]);
    const txs = body.result.transactions as Array<{ tx_hash: string; events: unknown[] }>;
    expect(txs).toHaveLength(2);
    expect(txs[0]!.tx_hash).toBe('txBN_A');
    expect(txs[0]!.events).toHaveLength(1);
    expect(txs[1]!.tx_hash).toBe('txBN_B');
    expect(txs[1]!.events).toHaveLength(0);
  });

  it('"latest" resolves via checkpoint', async () => {
    const { body } = await rpc(url, 'btc_getBlockByNumber', ['latest']);
    // Checkpoint 500, no block at 500 → null (not an error)
    expect(body.result).toBeNull();
    expect(body.error).toBeUndefined();
  });

  it('hex block number is parsed', async () => {
    const hex = '0x' + (941500).toString(16);
    const { body } = await rpc(url, 'btc_getBlockByNumber', [hex]);
    expect(body.result.block_number).toBe(941500);
  });

  it('missing params → -32602', async () => {
    const { body } = await rpc(url, 'btc_getBlockByNumber');
    expect(body.error.code).toBe(-32602);
  });
});

describe('btc_getBlockByHash', () => {
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
    const { body } = await rpc(url, 'btc_getBlockByHash', ['nope']);
    expect(body.result).toBeNull();
  });

  it('known hash returns the block (slim)', async () => {
    const { body } = await rpc(url, 'btc_getBlockByHash', ['blockhash_941600']);
    expect(body.result.block_number).toBe(941600);
    expect(body.result.transactions).toEqual(['txBH_A']);
  });

  it('includeTx=true expands transactions', async () => {
    const { body } = await rpc(url, 'btc_getBlockByHash', ['blockhash_941600', true]);
    const txs = body.result.transactions as Array<{ tx_hash: string }>;
    expect(txs[0]!.tx_hash).toBe('txBH_A');
  });

  it('non-string param → -32602', async () => {
    const { body } = await rpc(url, 'btc_getBlockByHash', [42]);
    expect(body.error.code).toBe(-32602);
  });
});

describe('btc_getTransactionReceipt', () => {
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
    const { body } = await rpc(url, 'btc_getTransactionReceipt', ['0xdeadbeef']);
    expect(body.result).toBeNull();
  });

  it('successful tx receipt includes events and failed=false', async () => {
    const { body } = await rpc(url, 'btc_getTransactionReceipt', ['txRcpt']);
    expect(body.result.tx_hash).toBe('txRcpt');
    expect(body.result.failed).toBe(false);
    expect(body.result.events).toHaveLength(1);
    expect(body.result.events[0].topics[0]).toBe('Transfer');
  });

  it('failed tx surfaces failed=true + revert_reason', async () => {
    const { body } = await rpc(url, 'btc_getTransactionReceipt', ['txFail']);
    expect(body.result.failed).toBe(true);
    expect(body.result.revert_reason).toBe('out of gas');
  });

  it('missing params → -32602', async () => {
    const { body } = await rpc(url, 'btc_getTransactionReceipt');
    expect(body.error.code).toBe(-32602);
  });
});

describe('btc_getCodeHash', () => {
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
        method: 'btc_getCodeHash',
        params: ['bc1qcontract1'],
      });
      expect((body as { result: string }).result).toBe('0xabc123hash');
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it('local miss falls through to upstream proxy', async () => {
    const db = createTestDb();
    const { url, close } = await startTestServer(db, 'http://upstream.example');

    const mockFetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: '0xupstreamhash' }),
    } as Response);
    vi.stubGlobal('fetch', mockFetch);

    try {
      const { body } = await nodePost(url, {
        jsonrpc: '2.0',
        id: 1,
        method: 'btc_getCodeHash',
        params: ['bc1qunknown'],
      });
      expect(mockFetch).toHaveBeenCalledOnce();
      const [calledUrl, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(calledUrl).toBe('http://upstream.example');
      const sent = JSON.parse(init.body as string) as { method: string };
      expect(sent.method).toBe('btc_getCodeHash');
      expect((body as { result: string }).result).toBe('0xupstreamhash');
    } finally {
      await close();
    }
  });

  it('non-string param → -32602', async () => {
    const db = createTestDb();
    const { url, close } = await startTestServer(db);
    try {
      const { body } = await rpc(url, 'btc_getCodeHash', [42]);
      expect(body.error.code).toBe(-32602);
    } finally {
      await close();
    }
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
