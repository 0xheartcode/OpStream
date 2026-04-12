/**
 * Bitcoin transaction parser — extracts OPNET calldata from raw tx hex.
 *
 * Parses the Bitcoin wire format (segwit) and searches witness data for
 * OPNET interaction transactions. OPNET embeds calldata in tapscript
 * witness data using the following structure:
 *
 *   ... verification opcodes ...
 *   OP_IF
 *     [MAGIC: 0x6f70 ("op")]          ← identifies this as an OPNET tx
 *     [feature data chunks, 512B max each]
 *     OP_1NEGATE                       ← separator between features and calldata
 *     [calldata chunk 1, 512B max]
 *     [calldata chunk 2, 512B max]
 *     [calldata chunk N...]
 *   OP_ELSE
 *     OP_1
 *   OP_ENDIF
 *
 * The calldata chunks are gzip-compressed. After decompression, the payload
 * contains the OPNET calldata (contract address + function selector + args).
 *
 * NOTE: The exact binary layout of the decompressed calldata (selector offset,
 * contract address encoding, argument layout) needs further verification with
 * real mainnet transaction data. The magic byte detection and chunk extraction
 * are based on @btc-vision/transaction's CalldataGenerator source. As OPNET
 * evolves, this parser may need updates — treat it as a living document.
 *
 * Constants from @btc-vision/transaction:
 *   MAGIC = 0x6f70 ("op")           — Generator.ts
 *   DATA_CHUNK_SIZE = 512 bytes     — Generator.ts
 *   Compression = gzip level 9      — Compressor.ts
 *
 * @module btcTxParser
 */

import { gunzipSync } from 'node:zlib';

// ─── Exported types ──────────────────────────────────────────────────────────

export interface OpnetPayload {
  /** Raw OPNET calldata bytes (decompressed) as hex. */
  payloadHex: string;
  /** First 4 bytes of the decompressed payload as hex, or null if < 4 bytes. */
  selectorHex: string | null;
  /** Compressed calldata chunks concatenated, before decompression. Hex-encoded. */
  compressedHex: string;
}

// ─── Bitcoin script opcodes ──────────────────────────────────────────────────

const OP_IF       = 0x63;
const OP_ELSE     = 0x67;
const OP_ENDIF    = 0x68;
const OP_1NEGATE  = 0x4f;

// Push opcodes: 0x01..0x4b = push N bytes directly
// 0x4c = OP_PUSHDATA1 (next 1 byte = length)
// 0x4d = OP_PUSHDATA2 (next 2 bytes LE = length)
// 0x4e = OP_PUSHDATA4 (next 4 bytes LE = length)

const OPNET_MAGIC = Buffer.from('op', 'utf8'); // 0x6f 0x70

// ─── VarInt (CompactSize) reader ─────────────────────────────────────────────

class BufferCursor {
  private offset = 0;
  constructor(private readonly buf: Buffer) {}

  get pos(): number { return this.offset; }
  get remaining(): number { return this.buf.length - this.offset; }

  readUInt8(): number {
    if (this.remaining < 1) throw new Error('BufferCursor: underflow (uint8)');
    return this.buf[this.offset++]!;
  }

  readUInt16LE(): number {
    if (this.remaining < 2) throw new Error('BufferCursor: underflow (uint16)');
    const v = this.buf.readUInt16LE(this.offset);
    this.offset += 2;
    return v;
  }

  readUInt32LE(): number {
    if (this.remaining < 4) throw new Error('BufferCursor: underflow (uint32)');
    const v = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  readSlice(n: number): Buffer {
    if (this.remaining < n) throw new Error(`BufferCursor: underflow (slice ${n}, have ${this.remaining})`);
    const slice = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return slice;
  }

  readVarInt(): number {
    const first = this.readUInt8();
    if (first < 0xfd) return first;
    if (first === 0xfd) return this.readUInt16LE();
    if (first === 0xfe) return this.readUInt32LE();
    // 0xff — 8-byte, but Bitcoin tx counts never exceed 32-bit in practice
    const lo = this.readUInt32LE();
    this.readUInt32LE(); // hi — discard
    return lo;
  }

  skip(n: number): void {
    if (this.remaining < n) throw new Error(`BufferCursor: underflow (skip ${n})`);
    this.offset += n;
  }
}

// ─── Script data push reader ─────────────────────────────────────────────────

/**
 * Read one script element from a Bitcoin script buffer.
 * Returns { opcode, data } where data is the pushed bytes (or null for non-push opcodes).
 * Returns null if cursor is at end.
 */
function readScriptElement(
  script: Buffer,
  cursor: { pos: number },
): { opcode: number; data: Buffer | null } | null {
  if (cursor.pos >= script.length) return null;

  const opcode = script[cursor.pos++]!;

  // Direct push: 0x01..0x4b = push next N bytes
  if (opcode >= 0x01 && opcode <= 0x4b) {
    const end = cursor.pos + opcode;
    if (end > script.length) return null;
    const data = script.subarray(cursor.pos, end);
    cursor.pos = end;
    return { opcode, data };
  }

  // OP_PUSHDATA1
  if (opcode === 0x4c) {
    if (cursor.pos >= script.length) return null;
    const len = script[cursor.pos++]!;
    const end = cursor.pos + len;
    if (end > script.length) return null;
    const data = script.subarray(cursor.pos, end);
    cursor.pos = end;
    return { opcode, data };
  }

  // OP_PUSHDATA2
  if (opcode === 0x4d) {
    if (cursor.pos + 2 > script.length) return null;
    const len = script.readUInt16LE(cursor.pos);
    cursor.pos += 2;
    const end = cursor.pos + len;
    if (end > script.length) return null;
    const data = script.subarray(cursor.pos, end);
    cursor.pos = end;
    return { opcode, data };
  }

  // OP_PUSHDATA4
  if (opcode === 0x4e) {
    if (cursor.pos + 4 > script.length) return null;
    const len = script.readUInt32LE(cursor.pos);
    cursor.pos += 4;
    const end = cursor.pos + len;
    if (end > script.length) return null;
    const data = script.subarray(cursor.pos, end);
    cursor.pos = end;
    return { opcode, data };
  }

  // Non-push opcode (OP_IF, OP_1NEGATE, OP_ELSE, OP_ENDIF, etc.)
  return { opcode, data: null };
}

// ─── Tapscript OPNET payload extraction ──────────────────────────────────────

/**
 * Given a tapscript (the script leaf from witness), search for the OPNET
 * magic bytes and extract the calldata chunks.
 *
 * Returns the concatenated compressed calldata bytes, or null if this is
 * not an OPNET script.
 */
function extractCalldataFromScript(script: Buffer): Buffer | null {
  const cursor = { pos: 0 };

  // Phase 1: Scan for OP_IF followed by a push of OPNET_MAGIC (0x6f70)
  let foundMagic = false;
  while (cursor.pos < script.length) {
    const elem = readScriptElement(script, cursor);
    if (!elem) break;

    if (elem.opcode === OP_IF) {
      // Next element should be the magic push
      const magicElem = readScriptElement(script, cursor);
      if (
        magicElem &&
        magicElem.data &&
        magicElem.data.length === OPNET_MAGIC.length &&
        magicElem.data[0] === OPNET_MAGIC[0] &&
        magicElem.data[1] === OPNET_MAGIC[1]
      ) {
        foundMagic = true;
        break;
      }
    }
  }

  if (!foundMagic) return null;

  // Phase 2: Skip feature data chunks until OP_1NEGATE
  while (cursor.pos < script.length) {
    const elem = readScriptElement(script, cursor);
    if (!elem) return null;
    if (elem.opcode === OP_1NEGATE) break;
    // Feature data chunks — skip them
  }

  // Phase 3: Collect calldata chunks until OP_ELSE or OP_ENDIF
  const chunks: Buffer[] = [];
  while (cursor.pos < script.length) {
    const elem = readScriptElement(script, cursor);
    if (!elem) break;
    if (elem.opcode === OP_ELSE || elem.opcode === OP_ENDIF) break;
    if (elem.data) {
      chunks.push(Buffer.from(elem.data));
    }
  }

  if (chunks.length === 0) return null;
  return Buffer.concat(chunks);
}

// ─── Bitcoin wire format parser ──────────────────────────────────────────────

/**
 * Parse a raw Bitcoin transaction (hex-encoded) and extract witness stacks.
 * Returns an array of witness stacks (one per input), where each witness stack
 * is an array of Buffer elements.
 *
 * Returns null if the transaction is not segwit (no witness data).
 */
function parseWitnessStacks(rawHex: string): Buffer[][] | null {
  const buf = Buffer.from(rawHex, 'hex');
  const c = new BufferCursor(buf);

  // Version (4 bytes)
  c.readUInt32LE();

  // Check for segwit marker + flag
  const marker = c.readUInt8();
  const flag = c.readUInt8();
  if (marker !== 0x00 || flag !== 0x01) {
    // Not segwit — no witness data
    return null;
  }

  // Inputs
  const vinCount = c.readVarInt();
  for (let i = 0; i < vinCount; i++) {
    c.skip(32); // prevout hash
    c.skip(4);  // prevout index
    const scriptLen = c.readVarInt();
    c.skip(scriptLen); // scriptSig
    c.skip(4); // sequence
  }

  // Outputs
  const voutCount = c.readVarInt();
  for (let i = 0; i < voutCount; i++) {
    c.skip(8); // value (int64)
    const scriptLen = c.readVarInt();
    c.skip(scriptLen); // scriptPubKey
  }

  // Witness data — one stack per input
  const witnesses: Buffer[][] = [];
  for (let i = 0; i < vinCount; i++) {
    const stackSize = c.readVarInt();
    const stack: Buffer[] = [];
    for (let j = 0; j < stackSize; j++) {
      const elemLen = c.readVarInt();
      stack.push(c.readSlice(elemLen));
    }
    witnesses.push(stack);
  }

  // locktime (4 bytes) — skip
  return witnesses;
}

/**
 * Check if a witness stack is a taproot script-path spend.
 * In a taproot script-path spend, the witness has ≥ 2 elements:
 *   [...stack items, script, control block]
 * The control block starts with a byte 0xc0 or 0xc1 (leaf version | parity).
 */
function isTaprootScriptPath(stack: Buffer[]): boolean {
  if (stack.length < 2) return false;
  const controlBlock = stack[stack.length - 1]!;
  if (controlBlock.length < 33) return false; // min: 1 byte version + 32 byte internal key
  const leafVersion = controlBlock[0]! & 0xfe; // mask off parity bit
  return leafVersion === 0xc0;
}

/**
 * Get the tapscript from a taproot script-path witness stack.
 * The tapscript is the second-to-last element.
 */
function getTapscript(stack: Buffer[]): Buffer {
  return stack[stack.length - 2]!;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Parse a raw Bitcoin transaction hex and extract the OPNET payload if present.
 *
 * Returns null if:
 *   - The transaction is not segwit
 *   - No taproot script-path spend is found
 *   - No OPNET magic bytes ("op" / 0x6f70) in the tapscript
 *   - Decompression fails
 *
 * The returned payload is the decompressed OPNET calldata. The selectorHex
 * is the first 4 bytes of this payload (the function selector in OPNET's
 * ABI encoding).
 *
 * NOTE: If decompression fails but we found valid OPNET magic + chunks,
 * we return the raw compressed bytes with payloadHex set to compressedHex.
 * This allows downstream consumers to attempt their own decompression or
 * to at least detect the OPNET transaction.
 */
export function extractOpnetPayload(rawTxHex: string): OpnetPayload | null {
  let witnesses: Buffer[][] | null;
  try {
    witnesses = parseWitnessStacks(rawTxHex);
  } catch {
    return null; // Malformed tx
  }

  if (!witnesses) return null;

  for (const stack of witnesses) {
    if (!isTaprootScriptPath(stack)) continue;

    const tapscript = getTapscript(stack);
    const compressed = extractCalldataFromScript(tapscript);
    if (!compressed) continue;

    const compressedHex = compressed.toString('hex');

    // Attempt gzip decompression
    let decompressed: Buffer;
    try {
      decompressed = gunzipSync(compressed);
    } catch {
      // Decompression failed — return compressed payload as fallback
      return {
        payloadHex: compressedHex,
        selectorHex: compressed.length >= 4
          ? '0x' + compressed.subarray(0, 4).toString('hex')
          : null,
        compressedHex,
      };
    }

    const payloadHex = decompressed.toString('hex');
    const selectorHex = decompressed.length >= 4
      ? '0x' + decompressed.subarray(0, 4).toString('hex')
      : null;

    return { payloadHex, selectorHex, compressedHex };
  }

  return null;
}
