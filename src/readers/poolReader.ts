/**
 * Reads pool reserves and token metadata from OPNET contracts.
 *
 * ─── NativeSwap pools ─────────────────────────────────────────────────────────
 * All BTC/token pools live inside a single NativeSwap contract.
 * Pools are identified by their OP20 token address.
 *   readNativeSwapReserves → calls getReserve(token) on the NativeSwap factory
 *
 * ─── Motoswap pools ───────────────────────────────────────────────────────────
 * Each Token/Token pair is a separate Motoswap pair contract.
 *   readMotoswapReserves → calls getReserves() on the pair contract directly
 *
 * ─── Token metadata ───────────────────────────────────────────────────────────
 *   readTokenMetadata → calls name()/symbol()/decimals() on the OP20 token
 *
 * ABI encoding uses @btc-vision/transaction's ABICoder + BinaryWriter,
 * mirroring the opnet Contract class's own encoding logic.
 */

import { fromBech32 } from '@btc-vision/bitcoin';
import { ABICoder, BinaryReader, BinaryWriter } from '@btc-vision/transaction';
import { log } from '../core/logger.js';
import type { OpnetRpcClient } from '../rpc/opnetRpc.js';
import { DEFAULT_NATIVESWAP_FACTORY } from '@opnet-devs/opkit';

// ─── ABI coder singleton ─────────────────────────────────────────────────────

const abi = new ABICoder();

// ─── Address helpers ──────────────────────────────────────────────────────────

/**
 * Converts a string address to a 32-byte Uint8Array suitable for calldata.
 *
 * Accepted formats:
 *  - bech32 / bech32m P2TR (bc1p…, tb1p…, bcrt1p…) → witness program (32 bytes)
 *  - 64-char hex string (optionally 0x-prefixed) → raw 32 bytes
 *  - Short test stub (< 64 chars) → zero-padded to 32 bytes (tests only)
 */
export function addressToBytes(address: string): Uint8Array {
  // bech32 / bech32m
  try {
    const { data } = fromBech32(address);
    if (data.length === 32) return new Uint8Array(data);
  } catch {
    // not a bech32 address — fall through
  }

  // Hex string (32 bytes = 64 hex chars)
  const hex = address.startsWith('0x') ? address.slice(2) : address;
  if (/^[0-9a-fA-F]{64}$/.test(hex)) {
    return new Uint8Array(Buffer.from(hex, 'hex'));
  }

  // Fallback for test stubs: UTF-8 encode and zero-pad to 32 bytes
  const utf8 = new TextEncoder().encode(address);
  const result = new Uint8Array(32);
  result.set(utf8.subarray(0, Math.min(32, utf8.length)));
  return result;
}

// ─── NativeSwap calldata builders ────────────────────────────────────────────

/** Encodes getReserve(address) calldata for the NativeSwap contract. */
export function encodeGetReserve(tokenAddress: string): Uint8Array {
  const writer = new BinaryWriter();
  const selectorHex = abi.encodeSelector('getReserve(address)');
  writer.writeSelector(parseInt(selectorHex, 16));
  writer.writeBytes(addressToBytes(tokenAddress));
  return writer.getBuffer();
}

// ─── Motoswap calldata builders ───────────────────────────────────────────────

/**
 * Encodes getReserves() calldata for a Motoswap pair contract.
 * No parameters — the pair knows its own tokens.
 */
export function encodeGetReserves(): Uint8Array {
  const writer = new BinaryWriter();
  writer.writeSelector(parseInt(abi.encodeSelector('getReserves()'), 16));
  return writer.getBuffer();
}

// ─── Token metadata calldata builders ────────────────────────────────────────

/** Encodes name() calldata for an OP20 token. */
export function encodeNameCall(): Uint8Array {
  const writer = new BinaryWriter();
  writer.writeSelector(parseInt(abi.encodeSelector('name()'), 16));
  return writer.getBuffer();
}

/** Encodes symbol() calldata for an OP20 token. */
export function encodeSymbolCall(): Uint8Array {
  const writer = new BinaryWriter();
  writer.writeSelector(parseInt(abi.encodeSelector('symbol()'), 16));
  return writer.getBuffer();
}

/** Encodes decimals() calldata for an OP20 token. */
export function encodeDecimalsCall(): Uint8Array {
  const writer = new BinaryWriter();
  writer.writeSelector(parseInt(abi.encodeSelector('decimals()'), 16));
  return writer.getBuffer();
}

// ─── NativeSwap response decoders ────────────────────────────────────────────

/** Decodes the getReserve() response from the NativeSwap contract. */
export function decodeGetReserveResponse(bytes: Uint8Array): {
  liquidity: bigint;
  reservedLiquidity: bigint;
  btcReserve: bigint;
  tokenReserve: bigint;
} {
  const reader = new BinaryReader(bytes);
  const liquidity = reader.readU256();
  const reservedLiquidity = reader.readU256();
  const btcReserve = reader.readU64();
  const tokenReserve = reader.readU256();
  return { liquidity, reservedLiquidity, btcReserve, tokenReserve };
}

// ─── Motoswap response decoders ──────────────────────────────────────────────

/**
 * Decodes the getReserves() response from a Motoswap pair contract.
 *
 * Motoswap follows Uniswap V2 layout: reserve0 (U256) + reserve1 (U256).
 * Some implementations append a blockTimestampLast (U32) — we ignore it.
 */
export function decodeGetReservesResponse(bytes: Uint8Array): {
  reserve0: bigint;
  reserve1: bigint;
} {
  const reader = new BinaryReader(bytes);
  const reserve0 = reader.readU256();
  const reserve1 = reader.readU256();
  return { reserve0, reserve1 };
}

// ─── Token metadata response decoders ────────────────────────────────────────

/** Decodes a length-prefixed string response. */
export function decodeStringResponse(bytes: Uint8Array): string {
  const reader = new BinaryReader(bytes);
  return reader.readStringWithLength();
}

/** Decodes a single-byte uint8 response (decimals). */
export function decodeU8Response(bytes: Uint8Array): number {
  const reader = new BinaryReader(bytes);
  return reader.readU8();
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns the virtual BTC and token reserves for a NativeSwap pool.
 *
 * In NativeSwap, `poolAddress` is the OP20 token address — each token has
 * exactly one BTC/token pool within the NativeSwap contract.
 *
 * Returns {btcReserve: 0n, tokenReserve: 0n} on error (treat as DORMANT).
 */
export async function readNativeSwapReserves(
  client: OpnetRpcClient,
  poolAddress: string,
  factoryAddress: string = DEFAULT_NATIVESWAP_FACTORY,
): Promise<{ btcReserve: bigint; tokenReserve: bigint }> {
  const calldata = encodeGetReserve(poolAddress);
  const response = await client.call(factoryAddress, calldata);

  if (response === null) {
    log('WARN', 'poolReader', 'readNativeSwapReserves: call returned null', {
      poolAddress,
      factoryAddress,
    });
    return { btcReserve: 0n, tokenReserve: 0n };
  }

  try {
    const { btcReserve, tokenReserve } = decodeGetReserveResponse(response);
    return { btcReserve, tokenReserve };
  } catch (err) {
    log('ERROR', 'poolReader', 'readNativeSwapReserves: decode failed', {
      poolAddress,
      error: String(err),
    });
    return { btcReserve: 0n, tokenReserve: 0n };
  }
}

/**
 * Returns the token reserves for a Motoswap pair contract.
 *
 * Unlike NativeSwap, `poolAddress` is the pair contract itself (not a factory).
 * Returns {reserve0: 0n, reserve1: 0n} on error (treat as DORMANT).
 */
export async function readMotoswapReserves(
  client: OpnetRpcClient,
  poolAddress: string,
): Promise<{ reserve0: bigint; reserve1: bigint }> {
  const calldata = encodeGetReserves();
  const response = await client.call(poolAddress, calldata);

  if (response === null) {
    log('WARN', 'poolReader', 'readMotoswapReserves: call returned null', {
      poolAddress,
    });
    return { reserve0: 0n, reserve1: 0n };
  }

  try {
    const { reserve0, reserve1 } = decodeGetReservesResponse(response);
    return { reserve0, reserve1 };
  } catch (err) {
    log('ERROR', 'poolReader', 'readMotoswapReserves: decode failed', {
      poolAddress,
      error: String(err),
    });
    return { reserve0: 0n, reserve1: 0n };
  }
}

/**
 * Returns name, symbol, and decimals for an OP20 token.
 * Missing fields fall back to safe defaults.
 */
export async function readTokenMetadata(
  client: OpnetRpcClient,
  tokenAddress: string,
): Promise<{ symbol: string; decimals: number; name: string }> {
  const [nameBytes, symbolBytes, decimalsBytes] = await Promise.all([
    client.call(tokenAddress, encodeNameCall()),
    client.call(tokenAddress, encodeSymbolCall()),
    client.call(tokenAddress, encodeDecimalsCall()),
  ]);

  let name = '';
  let symbol = '';
  let decimals = 8; // OP20 default

  if (nameBytes === null) {
    log('WARN', 'poolReader', 'readTokenMetadata: name call returned null', { tokenAddress });
  } else {
    try {
      name = decodeStringResponse(nameBytes);
    } catch (err) {
      log('WARN', 'poolReader', 'readTokenMetadata: name decode failed', {
        tokenAddress,
        error: String(err),
      });
    }
  }

  if (symbolBytes === null) {
    log('WARN', 'poolReader', 'readTokenMetadata: symbol call returned null', { tokenAddress });
  } else {
    try {
      symbol = decodeStringResponse(symbolBytes);
    } catch (err) {
      log('WARN', 'poolReader', 'readTokenMetadata: symbol decode failed', {
        tokenAddress,
        error: String(err),
      });
    }
  }

  if (decimalsBytes === null) {
    log('WARN', 'poolReader', 'readTokenMetadata: decimals call returned null', { tokenAddress });
  } else {
    try {
      decimals = decodeU8Response(decimalsBytes);
    } catch (err) {
      log('WARN', 'poolReader', 'readTokenMetadata: decimals decode failed', {
        tokenAddress,
        error: String(err),
      });
    }
  }

  return { name, symbol, decimals };
}

/** @deprecated Use readNativeSwapReserves */
export const readPoolReserves = readNativeSwapReserves;
