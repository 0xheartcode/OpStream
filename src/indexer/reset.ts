/**
 * OpStream reset — truncate all scanned tables so the next bootstrap
 * starts from scratch.
 *
 * This is destructive. The CLI wrapper in main.ts prompts the user for
 * confirmation unless --yes is passed or FORCE=1 is set.
 *
 * What it clears:
 *   - blocks, transactions, tx_outputs, events  (raw scan data)
 *   - contract_deployments                          (deployment index)
 *   - scan_checkpoints                           (so bootstrap restarts at FROM_BLOCK)
 *   - mempool_pending                            (pending-tx cache)
 *
 * What it preserves:
 *   - tokens          (owned by OpKit — metadata users provide)
 *   - runtime_metrics (monitoring counters)
 *   - error_log       (historical diagnostics)
 */

import type { DbAdapter } from '../core/dbAdapter.js';

/** Tables cleared by `reset`, in an order safe for either dialect. */
export const RESET_TABLES: readonly string[] = [
  'events',
  'tx_outputs',
  'transactions',
  'blocks',
  'contract_deployments',
  'scan_checkpoints',
  'mempool_pending',
] as const;

export interface ResetResult {
  /** Per-table row counts BEFORE truncation, for reporting. */
  cleared: Record<string, number>;
}

/**
 * Truncate all scanned tables inside a single transaction.
 *
 * Uses plain `DELETE FROM` so it works identically on SQLite and
 * Postgres via DbAdapter — TRUNCATE is Postgres-only.
 */
export async function resetDatabase(db: DbAdapter): Promise<ResetResult> {
  const cleared: Record<string, number> = {};

  await db.transaction(async () => {
    for (const table of RESET_TABLES) {
      const row = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
      cleared[table] = Number(row?.n ?? 0);
      await db.run(`DELETE FROM ${table}`);
    }
  });

  return { cleared };
}
