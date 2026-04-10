/**
 * Tests for poolReaderSdk.ts
 *
 * Strategy: vi.mock('opnet') intercepts getContract so tests control what each
 * contract method returns without any network calls.  Provider methods
 * (getPublicKeysInfoRaw) are stubbed on plain fake-provider objects.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JSONRpcProvider } from 'opnet';

// ---------------------------------------------------------------------------
// Mock opnet's getContract before importing poolReaderSdk
// ---------------------------------------------------------------------------

vi.mock('opnet', async (importOriginal: () => Promise<Record<string, unknown>>) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getContract: vi.fn(),
  };
});

// Import after mock is registered
import { getContract } from 'opnet';
import {
  readTokenMetadata,
  readMotoswapReserves,
  readMotoswapPairTokens,
  readMotoswapPairAddress,
  resolveTokenHexAddress,
  readNativeSwapReserves,
} from '../src/readers/poolReaderSdk.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fake JSONRpcProvider with a configurable getPublicKeysInfoRaw stub. */
function fakeProvider(pubKeyMap: Record<string, unknown> = {}): JSONRpcProvider {
  return {
    getPublicKeysInfoRaw: vi.fn().mockResolvedValue(pubKeyMap),
  } as unknown as JSONRpcProvider;
}

/** Mock getContract to return a contract with the given method stubs. */
function mockContract(methods: Record<string, unknown>) {
  vi.mocked(getContract).mockReturnValue(methods as ReturnType<typeof getContract>);
}

// Silence logger output during tests
vi.mock('../src/core/logger.js', () => ({ log: vi.fn() }));

// ---------------------------------------------------------------------------
// readTokenMetadata
// ---------------------------------------------------------------------------

describe('readTokenMetadata', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns name, symbol, decimals from contract calls', async () => {
    mockContract({
      name:     vi.fn().mockResolvedValue({ properties: { name: 'Wrapped Bitcoin' } }),
      symbol:   vi.fn().mockResolvedValue({ properties: { symbol: 'WBTC' } }),
      decimals: vi.fn().mockResolvedValue({ properties: { decimals: 8 } }),
    });

    const result = await readTokenMetadata(fakeProvider(), 'bc1qtoken');

    expect(result.name).toBe('Wrapped Bitcoin');
    expect(result.symbol).toBe('WBTC');
    expect(result.decimals).toBe(8);
  });

  it('falls back to empty string / 8 decimals when contract calls throw', async () => {
    mockContract({
      name:     vi.fn().mockRejectedValue(new Error('RPC timeout')),
      symbol:   vi.fn().mockRejectedValue(new Error('RPC timeout')),
      decimals: vi.fn().mockRejectedValue(new Error('RPC timeout')),
    });

    const result = await readTokenMetadata(fakeProvider(), 'bc1qtoken');

    expect(result.name).toBe('');
    expect(result.symbol).toBe('');
    expect(result.decimals).toBe(8);
  });

  it('handles partial failure — uses fallback for failed call only', async () => {
    mockContract({
      name:     vi.fn().mockResolvedValue({ properties: { name: 'MyToken' } }),
      symbol:   vi.fn().mockRejectedValue(new Error('network error')),
      decimals: vi.fn().mockResolvedValue({ properties: { decimals: 6 } }),
    });

    const result = await readTokenMetadata(fakeProvider(), 'bc1qtoken');

    expect(result.name).toBe('MyToken');
    expect(result.symbol).toBe('');
    expect(result.decimals).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// readMotoswapReserves
// ---------------------------------------------------------------------------

describe('readMotoswapReserves', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns reserve0 and reserve1 as bigint', async () => {
    mockContract({
      getReserves: vi.fn().mockResolvedValue({
        properties: { reserve0: 1_000_000n, reserve1: 500_000n, blockTimestampLast: 0n },
      }),
    });

    const result = await readMotoswapReserves(fakeProvider(), 'bc1qpair');

    expect(result.reserve0).toBe(1_000_000n);
    expect(result.reserve1).toBe(500_000n);
  });

  it('returns zero reserves on failure', async () => {
    mockContract({
      getReserves: vi.fn().mockRejectedValue(new Error('timeout')),
    });

    const result = await readMotoswapReserves(fakeProvider(), 'bc1qpair');

    expect(result.reserve0).toBe(0n);
    expect(result.reserve1).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// readMotoswapPairTokens
// ---------------------------------------------------------------------------

describe('readMotoswapPairTokens', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns token0 and token1 addresses as strings', async () => {
    mockContract({
      token0: vi.fn().mockResolvedValue({ properties: { token0: 'bc1qtoken0' } }),
      token1: vi.fn().mockResolvedValue({ properties: { token1: 'bc1qtoken1' } }),
    });

    const result = await readMotoswapPairTokens(fakeProvider(), 'bc1qpair');

    expect(result).not.toBeNull();
    expect(result!.token0).toBe('bc1qtoken0');
    expect(result!.token1).toBe('bc1qtoken1');
  });

  it('returns null when token0 call throws', async () => {
    mockContract({
      token0: vi.fn().mockRejectedValue(new Error('network error')),
      token1: vi.fn().mockResolvedValue({ properties: { token1: 'bc1qtoken1' } }),
    });

    const result = await readMotoswapPairTokens(fakeProvider(), 'bc1qpair');

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readMotoswapPairAddress
// ---------------------------------------------------------------------------

describe('readMotoswapPairAddress', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // Valid 32-byte hex addresses (64 hex chars after 0x) that Address.fromString accepts
  const TOKEN0 = '0x' + 'ab'.repeat(32);
  const TOKEN1 = '0x' + 'cd'.repeat(32);

  it('returns the pool address on success', async () => {
    mockContract({
      getPool: vi.fn().mockResolvedValue({ properties: { pool: 'bc1qpairaddress123456' } }),
    });

    const result = await readMotoswapPairAddress(fakeProvider(), 'bc1qfactory', TOKEN0, TOKEN1);

    expect(result).toBe('bc1qpairaddress123456');
  });

  it('returns null when pool string is too short', async () => {
    mockContract({
      getPool: vi.fn().mockResolvedValue({ properties: { pool: 'short' } }),
    });

    const result = await readMotoswapPairAddress(fakeProvider(), 'bc1qfactory', TOKEN0, TOKEN1);

    expect(result).toBeNull();
  });

  it('returns null on contract error', async () => {
    mockContract({
      getPool: vi.fn().mockRejectedValue(new Error('RPC error')),
    });

    const result = await readMotoswapPairAddress(fakeProvider(), 'bc1qfactory', TOKEN0, TOKEN1);

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveTokenHexAddress
// ---------------------------------------------------------------------------

describe('resolveTokenHexAddress', () => {
  it('returns 0x-prefixed addresses unchanged', async () => {
    const result = await resolveTokenHexAddress(fakeProvider(), '0xaabbccddeeff');
    expect(result).toBe('0xaabbccddeeff');
  });

  it('returns "btc" unchanged', async () => {
    const result = await resolveTokenHexAddress(fakeProvider(), 'btc');
    expect(result).toBe('btc');
  });

  it('resolves bc1q address to 0x-prefixed tweaked pubkey', async () => {
    const provider = fakeProvider({
      'bc1qtest': { tweakedPubkey: 'deadbeef1234' },
    });

    const result = await resolveTokenHexAddress(provider, 'bc1qtest');

    expect(result).toBe('0xdeadbeef1234');
  });

  it('returns original address when no tweakedPubkey in response', async () => {
    const provider = fakeProvider({
      'bc1qtest': { error: 'not found' },
    });

    const result = await resolveTokenHexAddress(provider, 'bc1qtest');

    expect(result).toBe('bc1qtest');
  });

  it('returns original address when provider call throws', async () => {
    const provider = {
      getPublicKeysInfoRaw: vi.fn().mockRejectedValue(new Error('network error')),
    } as unknown as JSONRpcProvider;

    const result = await resolveTokenHexAddress(provider, 'bc1qtest');

    expect(result).toBe('bc1qtest');
  });
});

// ---------------------------------------------------------------------------
// readNativeSwapReserves
// ---------------------------------------------------------------------------

describe('readNativeSwapReserves', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns btcReserve and tokenReserve on success', async () => {
    const provider = fakeProvider({
      'bc1qtoken': { tweakedPubkey: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890' },
    });

    mockContract({
      getReserve: vi.fn().mockResolvedValue({
        properties: { virtualBTCReserve: 2_000_000n, virtualTokenReserve: 8_000_000n },
      }),
    });

    const result = await readNativeSwapReserves(provider, 'bc1qtoken');

    expect(result.btcReserve).toBe(2_000_000n);
    expect(result.tokenReserve).toBe(8_000_000n);
  });

  it('returns zeros when no tweaked pubkey found', async () => {
    const provider = fakeProvider({
      'bc1qtoken': { error: 'not found' },
    });

    const result = await readNativeSwapReserves(provider, 'bc1qtoken');

    expect(result.btcReserve).toBe(0n);
    expect(result.tokenReserve).toBe(0n);
  });

  it('returns zeros when getReserve throws', async () => {
    const provider = fakeProvider({
      'bc1qtoken': { tweakedPubkey: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890' },
    });

    mockContract({
      getReserve: vi.fn().mockRejectedValue(new Error('contract error')),
    });

    const result = await readNativeSwapReserves(provider, 'bc1qtoken');

    expect(result.btcReserve).toBe(0n);
    expect(result.tokenReserve).toBe(0n);
  });
});
