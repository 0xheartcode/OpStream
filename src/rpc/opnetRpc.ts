/**
 * OPNET RPC client.
 *
 * Wraps opnet's JSONRpcProvider to expose a minimal, testable interface.
 * Provides getLogs() by scanning blocks and extracting events from interaction
 * transactions (OPNET does not have a native eth_getLogs equivalent).
 *
 * All methods log WARN/ERROR on failure so callers can diagnose without a debugger.
 */

import { networks } from '@btc-vision/bitcoin';
import {
  Block,
  InteractionTransaction,
  JSONRpcProvider,
  OPNetTransactionTypes,
  TransactionBase,
} from 'opnet';
import type { CallResult } from 'opnet';
import type { ICallRequestError } from 'opnet';
import { log } from '../core/logger.js';

// ─── Public types ────────────────────────────────────────────────────────────

/** Filter used with getLogs() to scan for contract events. */
export interface RpcLogFilter {
  /** Optional contract address to filter by. */
  address?: string;
  fromBlock: bigint;
  toBlock: bigint;
  /** Optional event-name array (OPNET uses event names, not keccak topics). */
  topics?: string[];
}

/** A single decoded contract event, analogous to an Ethereum log entry. */
export interface RpcLog {
  /** Contract address that emitted the event. */
  address: string;
  /** First element is the event name; OPNET has no topic hashing. */
  topics: string[];
  /** Hex-encoded event payload. */
  data: string;
  blockNumber: bigint;
  transactionHash: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const RPC_TIMEOUT_MS      = 5_000;
const CIRCUIT_BREAKER_MAX = 3;
const BACKOFF_BASE_MS     = 1_000;

// ─── OpnetRpcClient ──────────────────────────────────────────────────────────

/**
 * Thin wrapper around JSONRpcProvider.
 *
 * Injectable for testing: pass a pre-constructed provider via the second
 * constructor parameter.
 *
 * Reliability features:
 *   - Per-request 5s timeout (via Promise.race)
 *   - Exponential backoff on consecutive failures (1s → 2s → 4s)
 *   - Circuit breaker: after 3 consecutive failures, getBlock() returns null
 *     immediately until the next successful call resets the counter.
 */
export class OpnetRpcClient {
  /** Exposed for unit tests that need to stub individual methods. */
  readonly provider: JSONRpcProvider;

  private _consecutiveFailures = 0;

  constructor(url: string, provider?: JSONRpcProvider) {
    this.provider = provider ?? new JSONRpcProvider({
      url,
      network: networks.bitcoin,
    });
  }

  /** Number of consecutive RPC failures since last success. */
  get consecutiveFailures(): number { return this._consecutiveFailures; }

  /** True when the circuit breaker is open (≥ CIRCUIT_BREAKER_MAX failures). */
  get circuitOpen(): boolean { return this._consecutiveFailures >= CIRCUIT_BREAKER_MAX; }

  /**
   * Run a provider call with a 5s timeout.
   * Throws if the call exceeds the timeout.
   */
  private _withTimeout<T>(fn: () => Promise<T>): Promise<T> {
    return Promise.race([
      fn(),
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error('RPC timeout')), RPC_TIMEOUT_MS),
      ),
    ]);
  }

  /**
   * Record a failure and sleep with exponential backoff.
   * Does NOT open/close the circuit — callers check circuitOpen themselves.
   */
  private async _recordFailureAndBackoff(): Promise<void> {
    this._consecutiveFailures++;
    const delayMs = BACKOFF_BASE_MS * 2 ** (Math.min(this._consecutiveFailures, 3) - 1);
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }

  /** Record a success and reset the circuit breaker. */
  private _recordSuccess(): void {
    this._consecutiveFailures = 0;
  }

  /** Returns the current block height. Wrapped in the same 5s timeout as getBlock(). */
  async getBlockNumber(): Promise<bigint> {
    return this._withTimeout(() => this.provider.getBlockNumber());
  }

  /**
   * Returns a Block with full transaction data (prefetchTxs = true).
   * Returns null if the circuit breaker is open or the call times out.
   * Each InteractionTransaction already carries its receipt events.
   */
  async getBlock(n: bigint): Promise<Block | null> {
    if (this.circuitOpen) {
      log('WARN', 'rpc', 'getBlock: circuit breaker open — skipping block', {
        blockNumber: Number(n),
        consecutiveFailures: this._consecutiveFailures,
      });
      return null;
    }
    try {
      const block = await this._withTimeout(() => this.provider.getBlock(Number(n), true));
      this._recordSuccess();
      return block;
    } catch (err) {
      log('WARN', 'rpc', 'getBlock: failed', {
        blockNumber: Number(n),
        error: err instanceof Error ? err.message : String(err),
        consecutiveFailures: this._consecutiveFailures + 1,
      });
      await this._recordFailureAndBackoff();
      return null;
    }
  }

  /**
   * Scans [fromBlock, toBlock] for contract events matching the filter.
   *
   * OPNET does not expose a native getLogs RPC call, so we iterate blocks,
   * inspect each interaction transaction's embedded receipt events, and
   * return matching entries.
   */
  async getLogs(filter: RpcLogFilter): Promise<RpcLog[]> {
    const logs: RpcLog[] = [];

    for (let bn = filter.fromBlock; bn <= filter.toBlock; bn++) {
      const block = await this.getBlock(bn);
      if (!block) continue;

      const blockNumber = BigInt(block.height.toString());

      for (const tx of block.transactions as TransactionBase<OPNetTransactionTypes>[]) {
        if (tx.OPNetType !== OPNetTransactionTypes.Interaction) continue;

        const itx = tx as InteractionTransaction;
        const contractAddr = itx.contractAddress;

        if (filter.address && contractAddr !== filter.address) continue;

        for (const [evContractAddr, events] of Object.entries(tx.events)) {
          if (filter.address && evContractAddr !== filter.address) continue;

          for (const event of events) {
            if (filter.topics && !filter.topics.includes(event.type)) continue;

            logs.push({
              address: evContractAddr,
              topics: [event.type],
              data: Buffer.from(event.data).toString('hex'),
              blockNumber,
              transactionHash: itx.id,
            });
          }
        }
      }
    }

    return logs;
  }

  /**
   * Scans blocks for transactions where a target contract emits a specific event,
   * and returns the full event map for each matching transaction.
   *
   * Unlike getLogs (which returns individual events), this preserves the cross-contract
   * context needed to identify tokens from co-occurring Transferred events.
   */
  async scanForTransactions(
    fromBlock: bigint,
    toBlock: bigint,
    targetContract: string | undefined,
    eventName: string,
  ): Promise<Array<{
    blockNumber: bigint;
    txHash: string;
    events: Record<string, Array<{ type: string; data: Buffer }>>;
  }>> {
    const results: Array<{
      blockNumber: bigint;
      txHash: string;
      events: Record<string, Array<{ type: string; data: Buffer }>>;
    }> = [];

    for (let bn = fromBlock; bn <= toBlock; bn++) {
      const block = await this.getBlock(bn);
      if (!block) continue;

      const blockNumber = BigInt(block.height.toString());

      for (const tx of block.transactions as TransactionBase<OPNetTransactionTypes>[]) {
        if (tx.OPNetType !== OPNetTransactionTypes.Interaction) continue;

        const itx = tx as InteractionTransaction;

        let hasMatch = false;
        for (const [addr, events] of Object.entries(tx.events)) {
          if (targetContract && addr !== targetContract) continue;
          for (const event of events) {
            if (event.type === eventName) {
              hasMatch = true;
              break;
            }
          }
          if (hasMatch) break;
        }

        if (hasMatch) {
          const eventMap: Record<string, Array<{ type: string; data: Buffer }>> = {};
          for (const [addr, events] of Object.entries(tx.events)) {
            eventMap[addr] = events.map(e => ({ type: e.type, data: Buffer.from(e.data) }));
          }
          results.push({ blockNumber, txHash: itx.id, events: eventMap });
        }
      }
    }

    return results;
  }

  /**
   * Simulates a contract call and returns the raw response bytes.
   * Returns null if the call fails or the contract reverts.
   */
  async call(address: string, calldata: Uint8Array): Promise<Uint8Array | null> {
    let result: CallResult | ICallRequestError;
    try {
      result = await this.provider.call(address, calldata);
    } catch (err) {
      log('ERROR', 'rpc', 'call: provider threw', {
        address,
        error: String(err),
      });
      return null;
    }

    if ('error' in result) {
      log('WARN', 'rpc', 'call: contract returned error', {
        address,
        error: result.error,
      });
      return null;
    }

    const cr = result as CallResult;
    if (cr.revert) {
      log('WARN', 'rpc', 'call: contract reverted', {
        address,
        revert: cr.revert,
      });
      return null;
    }

    // BinaryReader type defs may not expose remainingLength — cast through unknown
    const reader = cr.result as unknown as { remainingLength: number; readBytes(n: number): Uint8Array };
    const remaining = reader.remainingLength;
    if (remaining === 0) return new Uint8Array(0);
    return reader.readBytes(remaining);
  }

  /**
   * Returns true if a contract is deployed at the given address.
   * Logs WARN on error and returns false.
   */
  async getCode(address: string): Promise<boolean> {
    try {
      const code = await this.provider.getCode(address);
      return code !== null && code !== undefined;
    } catch (err) {
      log('WARN', 'rpc', 'getCode: failed', { address, error: String(err) });
      return false;
    }
  }
}
