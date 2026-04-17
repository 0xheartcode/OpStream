import { describe, it, expect, beforeEach, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createTestDb } from '../src/core/db.js';
import type { DbAdapter } from '../src/core/dbAdapter.js';
import { startMempoolPoller } from '../src/indexer/mempoolPoller.js';
import type { MempoolPollerHandle } from '../src/indexer/mempoolPoller.js';
import type { BitcoinRpcClient } from '../src/rpc/btcRpc.js';
import type { WebhookEvent } from '../src/indexer/webhooks.js';
import { metrics } from '../src/core/metrics.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function writeVarInt(n: number): Buffer {
  if (n < 0xfd) return Buffer.from([n]);
  const buf = Buffer.alloc(3);
  buf[0] = 0xfd;
  buf.writeUInt16LE(n, 1);
  return buf;
}

function pushData(data: Buffer): Buffer {
  if (data.length <= 0x4b) {
    return Buffer.concat([Buffer.from([data.length]), data]);
  }
  if (data.length <= 0xff) {
    return Buffer.concat([Buffer.from([0x4c, data.length]), data]);
  }
  const lenBuf = Buffer.alloc(2);
  lenBuf.writeUInt16LE(data.length);
  return Buffer.concat([Buffer.from([0x4d]), lenBuf, data]);
}

function buildOpnetTapscript(calldataChunks: Buffer[]): Buffer {
  const parts: Buffer[] = [];
  parts.push(Buffer.from([0x51])); // OP_1
  parts.push(Buffer.from([0x63])); // OP_IF
  parts.push(pushData(Buffer.from('op', 'utf8')));
  parts.push(Buffer.from([0x4f])); // OP_1NEGATE
  for (const chunk of calldataChunks) {
    parts.push(pushData(chunk));
  }
  parts.push(Buffer.from([0x67])); // OP_ELSE
  parts.push(Buffer.from([0x51])); // OP_1
  parts.push(Buffer.from([0x68])); // OP_ENDIF
  return Buffer.concat(parts);
}

function buildControlBlock(): Buffer {
  const cb = Buffer.alloc(33);
  cb[0] = 0xc0;
  cb.fill(0xaa, 1);
  return cb;
}

function buildTaprootTxHex(tapscript: Buffer): string {
  const parts: Buffer[] = [];
  const version = Buffer.alloc(4);
  version.writeUInt32LE(2);
  parts.push(version);
  parts.push(Buffer.from([0x00, 0x01])); // segwit
  parts.push(writeVarInt(1)); // 1 input
  parts.push(Buffer.alloc(32, 0xbb)); // prevout
  const prevIdx = Buffer.alloc(4); prevIdx.writeUInt32LE(0); parts.push(prevIdx);
  parts.push(writeVarInt(0)); // empty scriptSig
  parts.push(Buffer.alloc(4, 0xff)); // sequence
  parts.push(writeVarInt(1)); // 1 output
  const val = Buffer.alloc(8); val.writeBigUInt64LE(50000n); parts.push(val);
  const spk = Buffer.alloc(34); spk[0] = 0x51; spk[1] = 0x20; spk.fill(0xcc, 2);
  parts.push(writeVarInt(spk.length));
  parts.push(spk);
  const cb = buildControlBlock();
  const dummy = Buffer.from([0x01]);
  parts.push(writeVarInt(3)); // 3 witness elements
  parts.push(writeVarInt(dummy.length)); parts.push(dummy);
  parts.push(writeVarInt(tapscript.length)); parts.push(tapscript);
  parts.push(writeVarInt(cb.length)); parts.push(cb);
  parts.push(Buffer.alloc(4)); // locktime
  return Buffer.concat(parts).toString('hex');
}

/** Build a raw OPNET tx hex with known calldata. */
function buildOpnetRawTxHex(calldata: Buffer): string {
  const compressed = gzipSync(calldata, { level: 9 });
  const tapscript = buildOpnetTapscript([compressed]);
  return buildTaprootTxHex(tapscript);
}

/** Build a non-OPNET (legacy) tx hex. */
function buildLegacyTxHex(): string {
  const parts: Buffer[] = [];
  const version = Buffer.alloc(4); version.writeUInt32LE(1); parts.push(version);
  parts.push(writeVarInt(1));
  parts.push(Buffer.alloc(32, 0xaa));
  const idx = Buffer.alloc(4); idx.writeUInt32LE(0); parts.push(idx);
  const ss = Buffer.alloc(10, 0x76);
  parts.push(writeVarInt(ss.length)); parts.push(ss);
  parts.push(Buffer.alloc(4, 0xff));
  parts.push(writeVarInt(1));
  const val = Buffer.alloc(8); val.writeBigUInt64LE(10000n); parts.push(val);
  const spk = Buffer.alloc(25, 0x76);
  parts.push(writeVarInt(spk.length)); parts.push(spk);
  parts.push(Buffer.alloc(4));
  return Buffer.concat(parts).toString('hex');
}

// ─── Mock Bitcoin RPC ──────────────────────────────────────────────────────��─

function createMockBtcRpc(
  mempoolTxIds: string[],
  rawTxMap: Map<string, string>,
): BitcoinRpcClient {
  return {
    isReady: true,
    connect: vi.fn(),
    getMempoolTxIds: vi.fn(async () => mempoolTxIds),
    getRawTransaction: vi.fn(async (txid: string) => rawTxMap.get(txid) ?? null),
    getBlockCount: vi.fn(async () => 100),
    estimateSmartFee: vi.fn(async () => 10),
  } as unknown as BitcoinRpcClient;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('mempoolPoller', () => {
  let db: DbAdapter;

  beforeEach(() => {
    db = createTestDb();
    metrics.reset();
  });

  it('inserts OPNET pending txs and dispatches events', async () => {
    const calldata = Buffer.from('deadbeef01020304', 'hex');
    const opnetTxHex = buildOpnetRawTxHex(calldata);

    const rawTxMap = new Map<string, string>();
    rawTxMap.set('txid_opnet_1', opnetTxHex);
    rawTxMap.set('txid_legacy_1', buildLegacyTxHex());

    const btcRpc = createMockBtcRpc(['txid_opnet_1', 'txid_legacy_1'], rawTxMap);
    const events: WebhookEvent[] = [];

    const handle: MempoolPollerHandle = startMempoolPoller(db, btcRpc, {
      pollIntervalMs: 100_000, // long interval — we control timing
      onMempoolEvent: (e) => events.push(e),
    });

    // Wait for the first poll to complete
    await new Promise((r) => setTimeout(r, 200));
    handle.stop();

    // Check DB
    const rows = await db.all<{ txid: string; contract_selector: string | null; vsize_bytes: number | null }>(
      'SELECT txid, contract_selector, vsize_bytes FROM mempool_pending',
    );
    expect(rows.length).toBe(1);
    expect(rows[0].txid).toBe('txid_opnet_1');
    expect(rows[0].contract_selector).toBe('0xdeadbeef');
    // vsize_bytes must be stored and be a positive integer
    expect(rows[0].vsize_bytes).not.toBeNull();
    expect(rows[0].vsize_bytes).toBeGreaterThan(0);

    // Check webhook event dispatched
    expect(events.length).toBe(1);
    expect(events[0].blockNumber).toBe(-1);
    expect(events[0].txHash).toBe('txid_opnet_1');
    expect(events[0].eventName).toBe('MempoolPending');
  });

  it('does not re-fetch already-seen txids', async () => {
    const rawTxMap = new Map<string, string>();
    rawTxMap.set('txid_1', buildLegacyTxHex());

    let callCount = 0;
    const btcRpc = createMockBtcRpc(['txid_1'], rawTxMap);
    const origGetRaw = btcRpc.getRawTransaction;
    (btcRpc as unknown as { getRawTransaction: typeof origGetRaw }).getRawTransaction = vi.fn(async (txid: string) => {
      callCount++;
      return origGetRaw(txid);
    });

    const handle = startMempoolPoller(db, btcRpc, {
      pollIntervalMs: 50, // fast polling for test
    });

    // Wait for 2+ poll cycles
    await new Promise((r) => setTimeout(r, 300));
    handle.stop();

    // getRawTransaction should only be called once for txid_1
    expect(callCount).toBe(1);
  });

  it('reports correct health metrics', async () => {
    const calldata = Buffer.from('aabbccdd11223344', 'hex');
    const rawTxMap = new Map<string, string>();
    rawTxMap.set('txid_op', buildOpnetRawTxHex(calldata));

    const btcRpc = createMockBtcRpc(['txid_op'], rawTxMap);

    const handle = startMempoolPoller(db, btcRpc, {
      pollIntervalMs: 100_000,
    });

    await new Promise((r) => setTimeout(r, 200));

    const health = handle.health();
    expect(health.running).toBe(true);
    expect(health.seenSetSize).toBe(1);
    expect(health.totalOpnetTxsSeen).toBe(1);
    expect(health.totalTxsFetched).toBe(1);

    handle.stop();
    expect(handle.health().running).toBe(false);
  });

  it('handles empty mempool gracefully', async () => {
    const btcRpc = createMockBtcRpc([], new Map());

    const handle = startMempoolPoller(db, btcRpc, {
      pollIntervalMs: 100_000,
    });

    await new Promise((r) => setTimeout(r, 200));
    handle.stop();

    const rows = await db.all('SELECT * FROM mempool_pending');
    expect(rows.length).toBe(0);
  });

  it('is idempotent on duplicate txids', async () => {
    const calldata = Buffer.from('deadbeef01020304', 'hex');
    const opnetTxHex = buildOpnetRawTxHex(calldata);
    const rawTxMap = new Map<string, string>();
    rawTxMap.set('txid_dup', opnetTxHex);

    // Insert the same txid manually first
    await db.run(
      'INSERT INTO mempool_pending (txid, raw_payload_hex, contract_selector) VALUES (?, ?, ?)',
      ['txid_dup', 'existing', '0x00000000'],
    );

    const btcRpc = createMockBtcRpc(['txid_dup'], rawTxMap);
    const handle = startMempoolPoller(db, btcRpc, { pollIntervalMs: 100_000 });

    await new Promise((r) => setTimeout(r, 200));
    handle.stop();

    // Should still be 1 row (INSERT OR IGNORE)
    const rows = await db.all('SELECT * FROM mempool_pending');
    expect(rows.length).toBe(1);
    // Original data preserved (not overwritten)
    const row = rows[0] as { raw_payload_hex: string; vsize_bytes: number | null };
    expect(row.raw_payload_hex).toBe('existing');
    // Manual insert had no vsize_bytes — column is nullable, so NULL is correct here
    expect(row.vsize_bytes).toBeNull();
  });
});
