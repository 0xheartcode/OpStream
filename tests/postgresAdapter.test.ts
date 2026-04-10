/**
 * Tests for postgresAdapter.ts
 *
 * PostgresAdapter wraps the `postgres` driver. Rather than spinning up a real
 * Postgres server, we inject a fake sql driver that captures what is called on
 * it. This lets us verify placeholder conversion, correct method routing, and
 * transaction scoping without any external infrastructure.
 */

import { describe, it, expect, vi } from 'vitest';
import { PostgresAdapter } from '../src/core/postgresAdapter.js';
import type postgres from 'postgres';

// ---------------------------------------------------------------------------
// Fake postgres.Sql builder
// ---------------------------------------------------------------------------

type SqlRow = Record<string, unknown>;

/**
 * Builds a minimal postgres.Sql-shaped double.
 *
 * - `unsafe(sql, params)` resolves to `rows`
 * - `begin(fn)` calls fn with a nested sql double that records calls separately
 * - `end()` resolves immediately
 */
function fakeSql(rows: SqlRow[] = []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];

  const unsafeFn = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    return rows;
  });

  const sql = Object.assign(
    // Tagged template — not used in the adapter except for `await sql\`SELECT 1\``
    // in openPostgresDb. We don't test that path here; just make it callable.
    vi.fn().mockResolvedValue([{ '?column?': 1 }]),
    {
      unsafe: unsafeFn,
      begin: vi.fn(async (fn: (txSql: typeof sql) => Promise<unknown>) => {
        // Provide a nested sql with its own unsafe spy so we can verify that
        // the adapter routes through _txSql inside the callback.
        const txCalls: Array<{ sql: string; params: unknown[] }> = [];
        const txUnsafe = vi.fn(async (s: string, p: unknown[] = []) => {
          txCalls.push({ sql: s, params: p });
          return rows;
        });
        const txSql = Object.assign(vi.fn(), { unsafe: txUnsafe, begin: vi.fn(), end: vi.fn() });
        const result = await fn(txSql as unknown as postgres.TransactionSql);
        (sql as { _txCalls?: typeof txCalls })._txCalls = txCalls;
        return result;
      }),
      end: vi.fn().mockResolvedValue(undefined),
      // Expose call log for assertions
      _calls: calls,
    },
  ) as unknown as postgres.Sql & { _calls: typeof calls; _txCalls?: typeof calls };

  return sql;
}

// ---------------------------------------------------------------------------
// toPositional — tested via the adapter's run/get/all methods
// ---------------------------------------------------------------------------

describe('placeholder conversion (? → $N)', () => {
  it('replaces a single ? with $1', async () => {
    const sql = fakeSql();
    const adapter = new PostgresAdapter(sql);

    await adapter.run('SELECT * FROM t WHERE id = ?', [42]);

    expect(sql._calls[0].sql).toBe('SELECT * FROM t WHERE id = $1');
    expect(sql._calls[0].params).toEqual([42]);
  });

  it('replaces multiple ? with incrementing $N', async () => {
    const sql = fakeSql();
    const adapter = new PostgresAdapter(sql);

    await adapter.run('INSERT INTO t (a, b, c) VALUES (?, ?, ?)', [1, 'two', 3n]);

    expect(sql._calls[0].sql).toBe('INSERT INTO t (a, b, c) VALUES ($1, $2, $3)');
    expect(sql._calls[0].params).toEqual([1, 'two', 3n]);
  });

  it('leaves SQL without placeholders unchanged', async () => {
    const sql = fakeSql();
    const adapter = new PostgresAdapter(sql);

    await adapter.run('SELECT 1');

    expect(sql._calls[0].sql).toBe('SELECT 1');
  });

  it('does not expand ? inside string literals (simple passthrough — no SQL parser)', async () => {
    // The adapter does a simple regex replace — it does not parse SQL.
    // This test documents the known behaviour rather than asserting correctness
    // of SQL-literal handling.
    const sql = fakeSql();
    const adapter = new PostgresAdapter(sql);

    await adapter.run("SELECT '?' FROM t WHERE id = ?", ['hello']);

    // Both ? are replaced — the simple regex does not skip string literals.
    expect(sql._calls[0].sql).toBe("SELECT '$1' FROM t WHERE id = $2");
  });
});

// ---------------------------------------------------------------------------
// run / get / all
// ---------------------------------------------------------------------------

describe('run()', () => {
  it('calls sql.unsafe with converted SQL and params', async () => {
    const sql = fakeSql();
    const adapter = new PostgresAdapter(sql);

    await adapter.run('DELETE FROM t WHERE x = ?', ['abc']);

    expect(sql.unsafe).toHaveBeenCalledOnce();
    expect(sql.unsafe).toHaveBeenCalledWith('DELETE FROM t WHERE x = $1', ['abc']);
  });

  it('resolves without returning data', async () => {
    const sql = fakeSql([{ affected: 1 }]);
    const adapter = new PostgresAdapter(sql);

    const result = await adapter.run('DELETE FROM t');

    expect(result).toBeUndefined();
  });
});

describe('get()', () => {
  it('returns the first row', async () => {
    const sql = fakeSql([{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }]);
    const adapter = new PostgresAdapter(sql);

    const row = await adapter.get<{ id: number; name: string }>('SELECT * FROM users WHERE id = ?', [1]);

    expect(row).toEqual({ id: 1, name: 'Alice' });
  });

  it('returns undefined when no rows', async () => {
    const sql = fakeSql([]);
    const adapter = new PostgresAdapter(sql);

    const row = await adapter.get('SELECT * FROM t WHERE 1 = 0');

    expect(row).toBeUndefined();
  });
});

describe('all()', () => {
  it('returns all rows', async () => {
    const rows = [{ x: 1 }, { x: 2 }, { x: 3 }];
    const sql = fakeSql(rows);
    const adapter = new PostgresAdapter(sql);

    const result = await adapter.all<{ x: number }>('SELECT x FROM t');

    expect(result).toHaveLength(3);
    expect(result).toEqual(rows);
  });

  it('returns empty array when no rows', async () => {
    const sql = fakeSql([]);
    const adapter = new PostgresAdapter(sql);

    const result = await adapter.all('SELECT * FROM empty');

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// exec()
// ---------------------------------------------------------------------------

describe('exec()', () => {
  it('splits on semicolons and executes each statement', async () => {
    const sql = fakeSql();
    const adapter = new PostgresAdapter(sql);

    await adapter.exec('CREATE TABLE a (id INT); CREATE TABLE b (id INT);');

    // exec uses this.sql.unsafe directly (not going through toPositional)
    expect(sql.unsafe).toHaveBeenCalledTimes(2);
    expect(sql.unsafe.mock.calls[0][0]).toBe('CREATE TABLE a (id INT)');
    expect(sql.unsafe.mock.calls[1][0]).toBe('CREATE TABLE b (id INT)');
  });

  it('skips empty statements from trailing semicolons', async () => {
    const sql = fakeSql();
    const adapter = new PostgresAdapter(sql);

    await adapter.exec('CREATE TABLE x (id INT);  ;  ');

    expect(sql.unsafe).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// transaction()
// ---------------------------------------------------------------------------

describe('transaction()', () => {
  it('executes the callback inside sql.begin()', async () => {
    const sql = fakeSql([{ val: 42 }]);
    const adapter = new PostgresAdapter(sql);

    let capturedResult: unknown;
    await adapter.transaction(async () => {
      capturedResult = await adapter.get('SELECT val FROM t WHERE id = ?', [1]);
    });

    expect(sql.begin).toHaveBeenCalledOnce();
    // Queries inside the transaction go through the tx-scoped sql, not the outer one
    expect((sql as { _txCalls?: Array<{ sql: string }> })._txCalls?.[0].sql).toBe(
      'SELECT val FROM t WHERE id = $1',
    );
    expect(capturedResult).toEqual({ val: 42 });
  });

  it('returns the value returned by the callback', async () => {
    const sql = fakeSql();
    const adapter = new PostgresAdapter(sql);

    const result = await adapter.transaction(async () => 'done');

    expect(result).toBe('done');
  });

  it('restores _txSql to null after the transaction', async () => {
    const sql = fakeSql();
    const adapter = new PostgresAdapter(sql);

    await adapter.transaction(async () => {
      // inner no-op
    });

    // After the transaction, outer sql.unsafe should be used again
    await adapter.run('SELECT 1');
    expect(sql._calls.some((c) => c.sql === 'SELECT 1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// close()
// ---------------------------------------------------------------------------

describe('close()', () => {
  it('calls sql.end()', async () => {
    const sql = fakeSql();
    const adapter = new PostgresAdapter(sql);

    await adapter.close();

    expect(sql.end).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// dialect
// ---------------------------------------------------------------------------

describe('dialect', () => {
  it('is "postgres"', () => {
    const sql = fakeSql();
    const adapter = new PostgresAdapter(sql);
    expect(adapter.dialect).toBe('postgres');
  });
});
