/**
 * Pool & token reader using the opnet SDK's getContract + ABIs.
 *
 * This replaces the manual BinaryWriter/BinaryReader ABI encoding in poolReader.ts
 * with proper SDK calls that handle OPNET's address/encoding format correctly.
 */

import { getContract, OP_20_ABI, NativeSwapAbi, MotoswapPoolAbi, MotoSwapFactoryAbi } from 'opnet';
import type {
  JSONRpcProvider,
  IOP20Contract,
  IMotoswapPoolContract,
  IMotoswapFactoryContract,
  INativeSwapContract,
  PublicKeyInfo,
} from 'opnet';
import type { BitcoinInterfaceAbi } from 'opnet';
import { networks } from '@btc-vision/bitcoin';
import type { Network } from '@btc-vision/bitcoin';
import { log } from '../core/logger.js';
// TODO: import from @opnet-collective/op-index once rebuild is complete
// import { DEFAULT_NATIVESWAP_FACTORY } from '@opnet-collective/op-index';
const DEFAULT_NATIVESWAP_FACTORY = '0xe63a5daa13af5a41351772940ea3c8abcf3f5e9ff741cfc9d1d1f8463e8bea1a';

const NETWORK: Network = networks.bitcoin;

// ─── Helper to safely call a contract method ─────────────────────────────────

async function safeCall<TProps, TOut>(
  label: string,
  fn: () => Promise<{ properties: TProps }>,
  extract: (props: TProps) => TOut,
  fallback: TOut,
): Promise<TOut> {
  try {
    const result = await fn();
    return extract(result.properties);
  } catch (err) {
    log('WARN', 'poolReaderSdk', `${label} failed`, { error: String(err).slice(0, 120) });
    return fallback;
  }
}

// ─── Token metadata ──────────────────────────────────────────────────────────

/**
 * Reads name, symbol, decimals for an OP-20 token via the opnet SDK.
 */
export async function readTokenMetadata(
  provider: JSONRpcProvider,
  tokenAddress: string,
): Promise<{ name: string; symbol: string; decimals: number }> {
  const contract = getContract<IOP20Contract>(
    tokenAddress,
    OP_20_ABI as unknown as BitcoinInterfaceAbi,
    provider,
    NETWORK,
  );

  const [name, symbol, decimals] = await Promise.all([
    safeCall('name', () => contract.name(), (p) => String(p.name ?? ''), ''),
    safeCall('symbol', () => contract.symbol(), (p) => String(p.symbol ?? ''), ''),
    safeCall('decimals', () => contract.decimals(), (p) => Number(p.decimals ?? 8), 8),
  ]);

  return { name, symbol, decimals };
}

// ─── Motoswap pair reserves ──────────────────────────────────────────────────

/**
 * Reads reserves from a Motoswap pair contract.
 */
export async function readMotoswapReserves(
  provider: JSONRpcProvider,
  pairAddress: string,
): Promise<{ reserve0: bigint; reserve1: bigint }> {
  const contract = getContract<IMotoswapPoolContract>(
    pairAddress,
    MotoswapPoolAbi as unknown as BitcoinInterfaceAbi,
    provider,
    NETWORK,
  );

  return safeCall(
    'getReserves',
    () => contract.getReserves(),
    (p) => ({
      reserve0: BigInt(p.reserve0 ?? 0),
      reserve1: BigInt(p.reserve1 ?? 0),
    }),
    { reserve0: 0n, reserve1: 0n },
  );
}

/**
 * Reads token0 and token1 addresses from a Motoswap pair contract.
 */
export async function readMotoswapPairTokens(
  provider: JSONRpcProvider,
  pairAddress: string,
): Promise<{ token0: string; token1: string } | null> {
  const contract = getContract<IMotoswapPoolContract>(
    pairAddress,
    MotoswapPoolAbi as unknown as BitcoinInterfaceAbi,
    provider,
    NETWORK,
  );

  try {
    const [t0Result, t1Result] = await Promise.all([
      contract.token0(),
      contract.token1(),
    ]);
    return {
      token0: String(t0Result.properties.token0),
      token1: String(t1Result.properties.token1),
    };
  } catch (err) {
    log('WARN', 'poolReaderSdk', 'readMotoswapPairTokens failed', { pairAddress, error: String(err).slice(0, 120) });
    return null;
  }
}

// ─── Motoswap factory ────────────────────────────────────────────────────────

/**
 * Queries the Motoswap factory for the pair address of two tokens.
 * Returns the pair contract address (op1sq format), or null on failure.
 */
export async function readMotoswapPairAddress(
  provider: JSONRpcProvider,
  factoryAddress: string,
  token0: string,
  token1: string,
): Promise<string | null> {
  try {
    const { Address } = await import('@btc-vision/transaction');
    const addr0 = Address.fromString(token0.startsWith('0x') ? token0.slice(2) : token0);
    const addr1 = Address.fromString(token1.startsWith('0x') ? token1.slice(2) : token1);

    const contract = getContract<IMotoswapFactoryContract>(
      factoryAddress,
      MotoSwapFactoryAbi as unknown as BitcoinInterfaceAbi,
      provider,
      NETWORK,
    );
    const result = await contract.getPool(addr0, addr1);
    const pool = String(result.properties.pool ?? '');
    if (!pool || pool === 'undefined' || pool.length < 10) return null;
    return pool;
  } catch (err) {
    log('WARN', 'poolReaderSdk', 'readMotoswapPairAddress failed', {
      token0: token0.slice(0, 20),
      token1: token1.slice(0, 20),
      error: String(err).slice(0, 120),
    });
    return null;
  }
}

// ─── Address normalization ────────────────────────────────────────────────────

/**
 * Resolves any OPNET token address to its canonical 32-byte hex (0x...) form.
 */
export async function resolveTokenHexAddress(
  provider: JSONRpcProvider,
  address: string,
): Promise<string> {
  if (address.startsWith('0x') || address === 'btc') return address;
  try {
    const raw = await provider.getPublicKeysInfoRaw(address);
    const info = raw[address];
    if (info && 'tweakedPubkey' in info && (info as PublicKeyInfo).tweakedPubkey) {
      return '0x' + (info as PublicKeyInfo).tweakedPubkey;
    }
  } catch {
    // fall through — return original on failure
  }
  return address;
}

// ─── NativeSwap reserves ─────────────────────────────────────────────────────

/**
 * Reads NativeSwap reserves for a token.
 */
export async function readNativeSwapReserves(
  provider: JSONRpcProvider,
  tokenAddress: string,
  factoryAddress: string = DEFAULT_NATIVESWAP_FACTORY,
): Promise<{ btcReserve: bigint; tokenReserve: bigint }> {
  try {
    const { Address } = await import('@btc-vision/transaction');
    const raw = await provider.getPublicKeysInfoRaw(tokenAddress);
    const info = raw[tokenAddress];
    if (!info || !('tweakedPubkey' in info) || !(info as PublicKeyInfo).tweakedPubkey) {
      throw new Error(`No tweaked pubkey for ${tokenAddress}`);
    }
    const addr = Address.fromString((info as PublicKeyInfo).tweakedPubkey!);

    const contract = getContract<INativeSwapContract>(
      factoryAddress,
      NativeSwapAbi as unknown as BitcoinInterfaceAbi,
      provider,
      NETWORK,
    );

    const result = await contract.getReserve(addr);

    return {
      btcReserve: result.properties.virtualBTCReserve,
      tokenReserve: result.properties.virtualTokenReserve,
    };
  } catch (err) {
    log('WARN', 'poolReaderSdk', 'readNativeSwapReserves failed', {
      tokenAddress: tokenAddress.slice(0, 30),
      error: String(err).slice(0, 120),
    });
    return { btcReserve: 0n, tokenReserve: 0n };
  }
}
