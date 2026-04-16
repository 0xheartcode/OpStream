import { describe, it, expect, vi } from 'vitest';
import type { Block } from 'opnet';
import { createTestDb } from '../src/core/db.js';
import type { DbAdapter } from '../src/core/dbAdapter.js';
import { resetDatabase, RESET_TABLES } from '../src/indexer/reset.js';
import { runBootstrapCore } from '../src/indexer/bootstrap.js';
import type { OpnetRpcClient } from '../src/rpc/opnetRpc.js';

// ---------------------------------------------------------------------------
// resetDatabase
// ---------------------------------------------------------------------------

async function seedAll(db: DbAdapter): Promise<void> {
  await db.run(
    "INSERT INTO scan_checkpoints (scan_type, last_block, updated_at) VALUES ('indexer', 500, 1700000000)",
  );
  await db.run(
    'INSERT INTO blocks (block_number, block_hash, timestamp, tx_count) VALUES (100, ?, 1700000000, 1)',
    ['h_100'],
  );
  await db.run(
    `INSERT INTO transactions
       (tx_hash, block_number, tx_index, tx_type, from_address, contract_address, gas_used, burned_bitcoin, priority_fee, failed, created_at)
     VALUES ('tx1', 100, 0, 'Interaction', 'bc1qf', 'bc1qc', '1000', '10', '1', 0, 1700000000)`,
  );
  await db.run(
    `INSERT INTO tx_outputs (tx_hash, output_index, value_sat, script_type, address)
     VALUES ('tx1', 0, 5000, 'p2wpkh', 'bc1qrecv')`,
  );
  await db.run(
    `INSERT INTO events
       (block_number, tx_hash, contract_address, event_name, log_index, event_raw, data_length)
     VALUES (100, 'tx1', 'bc1qc', 'Transfer', 0, x'aabb', 2)`,
  );
  await db.run(
    `INSERT INTO contract_deployments
       (block_number, tx_hash, contract_address, deployer, bytecode_hash)
     VALUES (100, 'deploy1', 'bc1qtok', 'bc1qdeployer', '0xdeadbeef')`,
  );
  await db.run(
    `INSERT INTO mempool_pending (txid, raw_payload_hex, first_seen_at)
     VALUES ('mtx1', 'aa', 1700000000)`,
  );
}

async function countAll(db: DbAdapter): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const t of RESET_TABLES) {
    const row = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`);
    counts[t] = Number(row?.n ?? 0);
  }
  return counts;
}

describe('resetDatabase', () => {
  it('clears all RESET_TABLES', async () => {
    const db = createTestDb();
    await seedAll(db);

    const before = await countAll(db);
    for (const t of RESET_TABLES) {
      expect(before[t]).toBeGreaterThan(0);
    }

    const { cleared } = await resetDatabase(db);

    // Reported cleared counts match pre-reset counts
    for (const t of RESET_TABLES) {
      expect(cleared[t]).toBe(before[t]);
    }

    const after = await countAll(db);
    for (const t of RESET_TABLES) {
      expect(after[t]).toBe(0);
    }
  });

  it('does not touch preserved tables (tokens, runtime_metrics, error_log)', async () => {
    const db = createTestDb();
    await db.run(
      "INSERT INTO tokens (address, symbol, name, decimals) VALUES ('bc1qtok', 'TOK', 'Token', 8)",
    );
    await db.run(
      "INSERT INTO runtime_metrics (key, value) VALUES ('scans', 42)",
    );
    await seedAll(db);

    await resetDatabase(db);

    const tokens = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tokens');
    const metrics = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM runtime_metrics');
    expect(Number(tokens?.n)).toBe(1);
    expect(Number(metrics?.n)).toBe(1); // row count, not value
  });

  it('is idempotent — running twice is safe', async () => {
    const db = createTestDb();
    await seedAll(db);
    await resetDatabase(db);
    const { cleared } = await resetDatabase(db);
    for (const t of RESET_TABLES) {
      expect(cleared[t]).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// runBootstrapCore — BOOTSTRAP_TO_BLOCK cap
// ---------------------------------------------------------------------------

/**
 * Fake client that returns the given chain tip and an empty block for any
 * height. The scanner will insert a blocks row but no events.
 */
function cappedClient(chainTip: bigint): OpnetRpcClient {
  return {
    getBlockNumber: vi.fn().mockResolvedValue(chainTip),
    getBlock: vi.fn().mockImplementation(async (h: bigint) => ({
      height:       h,
      hash:         `h_${h}`,
      time:         1_700_000_000 + Number(h),
      transactions: [],
    }) as unknown as Block),
  } as unknown as OpnetRpcClient;
}

describe('runBootstrapCore — BOOTSTRAP_TO_BLOCK cap', () => {
  it('stops at toBlock, not chain tip', async () => {
    const db = createTestDb();
    const client = cappedClient(200n); // real chain tip is 200

    // fromBlock=100, toBlock=109 → should scan exactly 10 blocks
    const result = await runBootstrapCore(
      db, client,
      { chunkSize: 5, fromBlock: 100n, toBlock: 109n },
      0, // rps=0 → no rate limiting
    );

    expect(result.blocksScanned).toBe(10);

    const row = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM blocks');
    expect(Number(row?.n)).toBe(10);
  });

  it('clamps toBlock above chain tip down to tip', async () => {
    const db = createTestDb();
    const client = cappedClient(105n);

    const result = await runBootstrapCore(
      db, client,
      { chunkSize: 100, fromBlock: 100n, toBlock: 999n },
      0,
    );

    // Chain tip is 105 → 100..105 = 6 blocks
    expect(result.blocksScanned).toBe(6);
  });

  it('throws when toBlock < startBlock', async () => {
    const db = createTestDb();
    const client = cappedClient(200n);

    await expect(
      runBootstrapCore(db, client, { fromBlock: 150n, toBlock: 100n }, 0),
    ).rejects.toThrow(/BOOTSTRAP_TO_BLOCK/);
  });

  it('no toBlock → scans to chain tip (unchanged behavior)', async () => {
    const db = createTestDb();
    const client = cappedClient(105n);

    const result = await runBootstrapCore(
      db, client,
      { chunkSize: 100, fromBlock: 100n },
      0,
    );

    expect(result.blocksScanned).toBe(6);
  });
});
