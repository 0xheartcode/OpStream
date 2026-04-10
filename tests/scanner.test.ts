import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OPNetTransactionTypes, type TransactionBase, type Block } from 'opnet';
import { createTestDb } from '../src/core/db.js';
import type { SqliteAdapter } from '../src/core/sqliteAdapter.js';
import type { DbAdapter } from '../src/core/dbAdapter.js';
import { scanBlockRange } from '../src/indexer/scanner.js';
import type { OpnetRpcClient } from '../src/rpc/opnetRpc.js';
import type { OnEventCallback } from '../src/indexer/scanner.js';

// ---------------------------------------------------------------------------
// Fake builders
// ---------------------------------------------------------------------------

/** Minimal InteractionTransaction-shaped object for use in tests. */
function fakeInteractionTx(overrides: Record<string, unknown> = {}): TransactionBase<OPNetTransactionTypes> {
  return {
    id:              'tx_abc',
    OPNetType:       OPNetTransactionTypes.Interaction,
    from:            'bc1qsender',
    contractAddress: 'bc1qcontract',
    gasUsed:         1000n,
    burnedBitcoin:   500n,
    specialGasUsed:  0n,
    priorityFee:     10n,
    maxGasSat:       50000n,
    failed:          false,
    revert:          undefined,
    outputs:         [],
    events: {
      'bc1qcontract': [
        { type: 'Transfer', data: new Uint8Array([0xde, 0xad]) },
      ],
    },
    // Fields required by TransactionBase but irrelevant to our tests
    hash:           'txhash_abc',
    index:          0,
    inputs:         [],
    receiptProofs:  [],
    rawEvents:      {},
    ...overrides,
  } as unknown as TransactionBase<OPNetTransactionTypes>;
}

function fakeBlock(txs: TransactionBase<OPNetTransactionTypes>[], blockNum = 100): Block {
  return {
    height:       BigInt(blockNum),
    hash:         `blockhash_${blockNum}`,
    time:         1_700_000_000 + blockNum,
    transactions: txs,
  } as unknown as Block;
}

function fakeClient(block: Block | null): OpnetRpcClient {
  return {
    getBlock:       vi.fn().mockResolvedValue(block),
    getBlockNumber: vi.fn().mockResolvedValue(100n),
  } as unknown as OpnetRpcClient;
}

/** Cast db to SqliteAdapter for raw synchronous verification queries. */
function rawGet(db: DbAdapter, sql: string, ...params: unknown[]) {
  return (db as SqliteAdapter).rawDb.prepare(sql).get(...(params as [unknown])) as Record<string, unknown> | undefined;
}
function rawAll(db: DbAdapter, sql: string, ...params: unknown[]) {
  return (db as SqliteAdapter).rawDb.prepare(sql).all(...(params as [unknown])) as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('scanBlockRange', () => {
  let db: DbAdapter;

  beforeEach(() => {
    db = createTestDb();
  });

  // ── onEvent enrichment ────────────────────────────────────────────────────

  describe('onEvent callback — enriched fields', () => {
    it('delivers all enriched fields for an interaction tx event', async () => {
      const captured: Parameters<OnEventCallback>[0][] = [];
      const onEvent: OnEventCallback = (e) => captured.push(e);

      await scanBlockRange(db, fakeClient(fakeBlock([fakeInteractionTx()])), 100n, 100n, { onEvent });

      expect(captured).toHaveLength(1);
      const e = captured[0]!;
      expect(e.blockNumber).toBe(100);
      expect(e.txHash).toBe('tx_abc');
      expect(e.contractAddress).toBe('bc1qcontract');
      expect(e.eventName).toBe('Transfer');
      expect(e.logIndex).toBe(0);
      expect(e.blockTimestamp).toBe(1_700_000_100);
      expect(e.txIndex).toBe(0);
      expect(e.fromAddress).toBe('bc1qsender');
      expect(e.gasUsed).toBe('1000');
      expect(e.burnedBitcoin).toBe('500');
      expect(e.failed).toBe(false);
      expect(e.revertReason).toBeNull();
      expect(e.eventRaw).toBe('0xdead');
    });

    it('delivers failed=true and revertReason when tx reverted', async () => {
      const captured: Parameters<OnEventCallback>[0][] = [];
      const tx = fakeInteractionTx({ failed: true, revert: 'InsufficientFunds' });

      await scanBlockRange(db, fakeClient(fakeBlock([tx])), 100n, 100n, {
        onEvent: (e) => captured.push(e),
      });

      expect(captured[0]!.failed).toBe(true);
      expect(captured[0]!.revertReason).toBe('InsufficientFunds');
    });

    it('logIndex increments globally across all events in a tx', async () => {
      const tx = fakeInteractionTx({
        events: {
          'bc1qcontractA': [
            { type: 'Transfer', data: new Uint8Array([0x01]) },
            { type: 'Approval', data: new Uint8Array([0x02]) },
          ],
          'bc1qcontractB': [
            { type: 'Swap', data: new Uint8Array([0x03]) },
          ],
        },
      });

      const captured: Parameters<OnEventCallback>[0][] = [];
      await scanBlockRange(db, fakeClient(fakeBlock([tx])), 100n, 100n, {
        onEvent: (e) => captured.push(e),
      });

      expect(captured).toHaveLength(3);
      expect(captured.map(e => e.logIndex)).toEqual([0, 1, 2]);
    });

    it('txIndex reflects position of tx within the block', async () => {
      const tx0 = fakeInteractionTx({ id: 'tx0' });
      const tx1 = fakeInteractionTx({
        id: 'tx1',
        events: { 'bc1qcontract': [{ type: 'Transfer', data: new Uint8Array([0xaa]) }] },
      });
      const tx2 = fakeInteractionTx({
        id: 'tx2',
        events: { 'bc1qcontract': [{ type: 'Transfer', data: new Uint8Array([0xbb]) }] },
      });

      const captured: Parameters<OnEventCallback>[0][] = [];
      await scanBlockRange(db, fakeClient(fakeBlock([tx0, tx1, tx2])), 100n, 100n, {
        onEvent: (e) => captured.push(e),
      });

      // tx0 has 1 event (logIndex 0), tx1 has 1 event, tx2 has 1 event
      expect(captured.find(e => e.txHash === 'tx0')!.txIndex).toBe(0);
      expect(captured.find(e => e.txHash === 'tx1')!.txIndex).toBe(1);
      expect(captured.find(e => e.txHash === 'tx2')!.txIndex).toBe(2);
    });

    it('eventRaw is hex-encoded with 0x prefix', async () => {
      const tx = fakeInteractionTx({
        events: {
          'bc1qcontract': [{ type: 'Transfer', data: new Uint8Array([0xca, 0xfe, 0xba, 0xbe]) }],
        },
      });

      const captured: Parameters<OnEventCallback>[0][] = [];
      await scanBlockRange(db, fakeClient(fakeBlock([tx])), 100n, 100n, {
        onEvent: (e) => captured.push(e),
      });

      expect(captured[0]!.eventRaw).toBe('0xcafebabe');
    });

    it('does not call onEvent when block has no interaction txs', async () => {
      // Deployment tx only — no events
      const deployTx = {
        id:              'deploy_tx',
        OPNetType:       OPNetTransactionTypes.Deployment,
        contractAddress: 'bc1qnewcontract',
        deployerAddress: 'bc1qdeployer',
        bytecode:        new Uint8Array([0x60, 0x00]),
        gasUsed:         1000n,
        burnedBitcoin:   500n,
        specialGasUsed:  0n,
        priorityFee:     0n,
        maxGasSat:       0n,
        failed:          false,
        outputs:         [],
        events:          {},
        hash:            'deploy_hash',
        index:           0,
        inputs:          [],
        receiptProofs:   [],
        rawEvents:       {},
      } as unknown as TransactionBase<OPNetTransactionTypes>;

      const onEvent = vi.fn();
      await scanBlockRange(db, fakeClient(fakeBlock([deployTx])), 100n, 100n, { onEvent });
      expect(onEvent).not.toHaveBeenCalled();
    });

    it('does not call onEvent when no onEvent option is provided', async () => {
      // Should not throw even without a callback
      await expect(
        scanBlockRange(db, fakeClient(fakeBlock([fakeInteractionTx()])), 100n, 100n),
      ).resolves.not.toThrow();
    });
  });

  // ── DB side-effects ────────────────────────────────────────────────────────

  describe('DB side-effects', () => {
    it('writes event row to events table with correct log_index', async () => {
      await scanBlockRange(db, fakeClient(fakeBlock([fakeInteractionTx()])), 100n, 100n, {});

      const row = rawGet(db, 'SELECT * FROM events WHERE tx_hash = ?', 'tx_abc');
      expect(row).toBeDefined();
      expect(row!['block_number']).toBe(100);
      expect(row!['event_name']).toBe('Transfer');
      expect(row!['log_index']).toBe(0);
      expect(row!['contract_address']).toBe('bc1qcontract');
    });

    it('writes transaction row to transactions table', async () => {
      await scanBlockRange(db, fakeClient(fakeBlock([fakeInteractionTx()])), 100n, 100n, {});

      const row = rawGet(db, 'SELECT * FROM transactions WHERE tx_hash = ?', 'tx_abc');
      expect(row).toBeDefined();
      expect(row!['from_address']).toBe('bc1qsender');
      expect(row!['gas_used']).toBe('1000');
      expect(row!['burned_bitcoin']).toBe('500');
      expect(row!['failed']).toBe(0);
    });

    it('writes block row with correct timestamp', async () => {
      await scanBlockRange(db, fakeClient(fakeBlock([fakeInteractionTx()])), 100n, 100n, {});

      const row = rawGet(db, 'SELECT * FROM blocks WHERE block_number = ?', 100);
      expect(row).toBeDefined();
      expect(row!['timestamp']).toBe(1_700_000_100);
      expect(row!['block_hash']).toBe('blockhash_100');
    });

    it('is idempotent — re-scanning the same block does not duplicate rows', async () => {
      const client = fakeClient(fakeBlock([fakeInteractionTx()]));
      await scanBlockRange(db, client, 100n, 100n, {});
      await scanBlockRange(db, client, 100n, 100n, {});

      const rows = rawAll(db, 'SELECT * FROM events WHERE block_number = 100');
      expect(rows).toHaveLength(1);
    });

    it('scans multiple blocks and accumulates results correctly', async () => {
      const clientFn = vi.fn()
        .mockResolvedValueOnce(fakeBlock([fakeInteractionTx({ id: 'tx_100' })], 100))
        .mockResolvedValueOnce(fakeBlock([
          fakeInteractionTx({ id: 'tx_101a' }),
          fakeInteractionTx({
            id: 'tx_101b',
            events: { 'bc1qcontract': [{ type: 'Swap', data: new Uint8Array([0xff]) }] },
          }),
        ], 101));

      const mockClient = { getBlock: clientFn } as unknown as OpnetRpcClient;
      const result = await scanBlockRange(db, mockClient, 100n, 101n, {});

      expect(result.blocksScanned).toBe(2);
      expect(result.eventsStored).toBe(3); // 1 from block 100 + 2 from block 101
    });
  });

  // ── ScanResult ────────────────────────────────────────────────────────────

  describe('ScanResult', () => {
    it('returns correct eventsStored and blocksScanned counts', async () => {
      const tx = fakeInteractionTx({
        events: {
          'bc1qcontract': [
            { type: 'Transfer', data: new Uint8Array([0x01]) },
            { type: 'Approval', data: new Uint8Array([0x02]) },
          ],
        },
      });

      const result = await scanBlockRange(db, fakeClient(fakeBlock([tx])), 100n, 100n, {});
      expect(result.eventsStored).toBe(2);
      expect(result.blocksScanned).toBe(1);
      expect(result.deploymentsFound).toBe(0);
    });

    it('returns zero counts for a block with no interaction txs', async () => {
      const result = await scanBlockRange(
        db,
        fakeClient(fakeBlock([])),
        100n, 100n,
        {},
      );
      expect(result.eventsStored).toBe(0);
      expect(result.blocksScanned).toBe(1);
    });

    it('gracefully skips a null block (RPC returned nothing)', async () => {
      const result = await scanBlockRange(db, fakeClient(null), 100n, 100n, {});
      expect(result.blocksScanned).toBe(0);
      expect(result.eventsStored).toBe(0);
    });
  });
});
