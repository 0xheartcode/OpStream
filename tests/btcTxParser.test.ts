import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { extractOpnetPayload } from '../src/rpc/btcTxParser.js';

// ─── Helpers for building synthetic Bitcoin transactions ──────────────────────

function writeVarInt(n: number): Buffer {
  if (n < 0xfd) return Buffer.from([n]);
  if (n < 0x10000) {
    const buf = Buffer.alloc(3);
    buf[0] = 0xfd;
    buf.writeUInt16LE(n, 1);
    return buf;
  }
  const buf = Buffer.alloc(5);
  buf[0] = 0xfe;
  buf.writeUInt32LE(n, 1);
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

const OP_IF      = 0x63;
const OP_ELSE    = 0x67;
const OP_ENDIF   = 0x68;
const OP_1NEGATE = 0x4f;
const OP_1       = 0x51;

/**
 * Build a minimal tapscript containing OPNET calldata.
 * Simplified: OP_IF [magic "op"] OP_1NEGATE [calldata chunks] OP_ELSE OP_1 OP_ENDIF
 */
function buildOpnetTapscript(calldataChunks: Buffer[], featureChunks: Buffer[] = []): Buffer {
  const parts: Buffer[] = [];
  // Some prefix opcodes (simulating verification)
  parts.push(Buffer.from([OP_1])); // dummy
  parts.push(Buffer.from([OP_IF]));
  parts.push(pushData(Buffer.from('op', 'utf8'))); // OPNET magic
  for (const feat of featureChunks) {
    parts.push(pushData(feat));
  }
  parts.push(Buffer.from([OP_1NEGATE]));
  for (const chunk of calldataChunks) {
    parts.push(pushData(chunk));
  }
  parts.push(Buffer.from([OP_ELSE]));
  parts.push(Buffer.from([OP_1]));
  parts.push(Buffer.from([OP_ENDIF]));
  return Buffer.concat(parts);
}

/**
 * Build a taproot control block. Minimal: version byte (0xc0) + 32-byte internal key.
 */
function buildControlBlock(): Buffer {
  const cb = Buffer.alloc(33);
  cb[0] = 0xc0; // leaf version 0xc0, even parity
  cb.fill(0xaa, 1); // fake internal key
  return cb;
}

/**
 * Build a minimal segwit Bitcoin transaction with one taproot input.
 * The witness contains: [script_stack_items..., tapscript, control_block]
 */
function buildTaprootTx(tapscript: Buffer): string {
  const parts: Buffer[] = [];

  // Version (4 bytes)
  const version = Buffer.alloc(4);
  version.writeUInt32LE(2);
  parts.push(version);

  // Segwit marker + flag
  parts.push(Buffer.from([0x00, 0x01]));

  // 1 input
  parts.push(writeVarInt(1));
  // prevout hash (32 bytes) + index (4 bytes)
  parts.push(Buffer.alloc(32, 0xbb));
  const prevIdx = Buffer.alloc(4);
  prevIdx.writeUInt32LE(0);
  parts.push(prevIdx);
  // scriptSig (empty for taproot)
  parts.push(writeVarInt(0));
  // sequence
  const seq = Buffer.alloc(4, 0xff);
  parts.push(seq);

  // 1 output
  parts.push(writeVarInt(1));
  // value (8 bytes)
  const val = Buffer.alloc(8);
  val.writeBigUInt64LE(50000n);
  parts.push(val);
  // scriptPubKey (taproot: OP_1 <32 bytes>)
  const spk = Buffer.alloc(34);
  spk[0] = 0x51; // OP_1
  spk[1] = 0x20; // push 32
  spk.fill(0xcc, 2);
  parts.push(writeVarInt(spk.length));
  parts.push(spk);

  // Witness — 1 input
  const controlBlock = buildControlBlock();
  // Witness stack: [dummy_stack_item, tapscript, control_block]
  const dummyItem = Buffer.from([0x01]); // 1-byte dummy
  parts.push(writeVarInt(3)); // 3 witness elements
  parts.push(writeVarInt(dummyItem.length));
  parts.push(dummyItem);
  parts.push(writeVarInt(tapscript.length));
  parts.push(tapscript);
  parts.push(writeVarInt(controlBlock.length));
  parts.push(controlBlock);

  // Locktime (4 bytes)
  parts.push(Buffer.alloc(4));

  return Buffer.concat(parts).toString('hex');
}

/**
 * Build a simple non-segwit P2PKH transaction (no witness).
 */
function buildLegacyTx(): string {
  const parts: Buffer[] = [];
  // Version
  const version = Buffer.alloc(4);
  version.writeUInt32LE(1);
  parts.push(version);
  // 1 input (no segwit marker)
  parts.push(writeVarInt(1));
  parts.push(Buffer.alloc(32, 0xaa)); // prevout hash
  const prevIdx = Buffer.alloc(4);
  prevIdx.writeUInt32LE(0);
  parts.push(prevIdx);
  // scriptSig (dummy)
  const scriptSig = Buffer.alloc(10, 0x76);
  parts.push(writeVarInt(scriptSig.length));
  parts.push(scriptSig);
  parts.push(Buffer.alloc(4, 0xff)); // sequence
  // 1 output
  parts.push(writeVarInt(1));
  const val = Buffer.alloc(8);
  val.writeBigUInt64LE(10000n);
  parts.push(val);
  const spk = Buffer.alloc(25, 0x76);
  parts.push(writeVarInt(spk.length));
  parts.push(spk);
  // locktime
  parts.push(Buffer.alloc(4));
  return Buffer.concat(parts).toString('hex');
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('extractOpnetPayload', () => {
  it('returns null for non-segwit (legacy) transaction', () => {
    const hex = buildLegacyTx();
    expect(extractOpnetPayload(hex)).toBeNull();
  });

  it('returns null for empty/malformed hex', () => {
    expect(extractOpnetPayload('')).toBeNull();
    expect(extractOpnetPayload('deadbeef')).toBeNull();
    expect(extractOpnetPayload('not-hex')).toBeNull();
  });

  it('extracts and decompresses OPNET payload from taproot tx', () => {
    // Build a fake calldata, compress it, chunk it
    const calldata = Buffer.from('deadbeef01020304aabbccdd', 'hex');
    const compressed = gzipSync(calldata, { level: 9 });
    const tapscript = buildOpnetTapscript([compressed]);
    const rawHex = buildTaprootTx(tapscript);

    const result = extractOpnetPayload(rawHex);
    expect(result).not.toBeNull();
    expect(result!.payloadHex).toBe(calldata.toString('hex'));
    expect(result!.selectorHex).toBe('0xdeadbeef');
    expect(result!.compressedHex).toBe(compressed.toString('hex'));
  });

  it('handles multi-chunk calldata', () => {
    // Calldata larger than 512 bytes → split into chunks
    const calldata = Buffer.alloc(800, 0x42);
    // Set a recognizable selector
    calldata[0] = 0xaa; calldata[1] = 0xbb; calldata[2] = 0xcc; calldata[3] = 0xdd;
    const compressed = gzipSync(calldata, { level: 9 });
    const chunk1 = compressed.subarray(0, 512);
    const chunk2 = compressed.subarray(512);
    const tapscript = buildOpnetTapscript([chunk1, chunk2]);
    const rawHex = buildTaprootTx(tapscript);

    const result = extractOpnetPayload(rawHex);
    expect(result).not.toBeNull();
    expect(result!.payloadHex).toBe(calldata.toString('hex'));
    expect(result!.selectorHex).toBe('0xaabbccdd');
  });

  it('skips feature data before OP_1NEGATE', () => {
    const calldata = Buffer.from('11223344aabbccdd', 'hex');
    const compressed = gzipSync(calldata, { level: 9 });
    const featureData = Buffer.alloc(64, 0xff); // fake feature chunk
    const tapscript = buildOpnetTapscript([compressed], [featureData]);
    const rawHex = buildTaprootTx(tapscript);

    const result = extractOpnetPayload(rawHex);
    expect(result).not.toBeNull();
    expect(result!.payloadHex).toBe(calldata.toString('hex'));
    expect(result!.selectorHex).toBe('0x11223344');
  });

  it('returns null for taproot tx without OPNET magic', () => {
    // Build a tapscript without the "op" magic
    const script = Buffer.concat([
      Buffer.from([OP_1]),
      Buffer.from([OP_IF]),
      pushData(Buffer.from('notop')), // wrong magic
      Buffer.from([OP_1NEGATE]),
      pushData(Buffer.from('data')),
      Buffer.from([OP_ELSE]),
      Buffer.from([OP_1]),
      Buffer.from([OP_ENDIF]),
    ]);
    const rawHex = buildTaprootTx(script);
    expect(extractOpnetPayload(rawHex)).toBeNull();
  });

  it('returns compressed fallback when decompression fails', () => {
    // Push raw (uncompressed) bytes as if they were calldata
    const rawBytes = Buffer.from('aabbccdd11223344', 'hex');
    const tapscript = buildOpnetTapscript([rawBytes]);
    const rawHex = buildTaprootTx(tapscript);

    const result = extractOpnetPayload(rawHex);
    expect(result).not.toBeNull();
    // When decompression fails, payloadHex falls back to compressedHex
    expect(result!.payloadHex).toBe(rawBytes.toString('hex'));
    expect(result!.compressedHex).toBe(rawBytes.toString('hex'));
  });

  it('returns null when payload is empty after OP_1NEGATE', () => {
    // Script with magic but no data chunks after OP_1NEGATE
    const script = Buffer.concat([
      Buffer.from([OP_1]),
      Buffer.from([OP_IF]),
      pushData(Buffer.from('op')),
      Buffer.from([OP_1NEGATE]),
      Buffer.from([OP_ELSE]),
      Buffer.from([OP_1]),
      Buffer.from([OP_ENDIF]),
    ]);
    const rawHex = buildTaprootTx(script);
    expect(extractOpnetPayload(rawHex)).toBeNull();
  });

  it('returns null for short payload (< 4 bytes) selector', () => {
    const calldata = Buffer.from('aabb', 'hex'); // only 2 bytes
    const compressed = gzipSync(calldata, { level: 9 });
    const tapscript = buildOpnetTapscript([compressed]);
    const rawHex = buildTaprootTx(tapscript);

    const result = extractOpnetPayload(rawHex);
    expect(result).not.toBeNull();
    expect(result!.selectorHex).toBeNull();
    expect(result!.payloadHex).toBe('aabb');
  });
});
