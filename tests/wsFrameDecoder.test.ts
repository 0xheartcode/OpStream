import { describe, it, expect } from 'vitest';
import { WsFrameDecoder } from '../src/indexer/wsFrameDecoder.js';
import type { WsFrame } from '../src/indexer/wsFrameDecoder.js';

// ---------------------------------------------------------------------------
// Helper: build a valid client→server masked WebSocket text frame
// ---------------------------------------------------------------------------

/**
 * Encode a UTF-8 string as a masked RFC 6455 text frame.
 * maskKey is optional — if omitted, 0x00000000 is used (XOR identity).
 */
function makeTextFrame(text: string, maskKey: Buffer = Buffer.alloc(4)): Buffer {
  const payload    = Buffer.from(text, 'utf8');
  const payloadLen = payload.length;

  let header: Buffer;
  if (payloadLen < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;             // FIN + text opcode
    header[1] = 0x80 | payloadLen; // MASK bit + 7-bit length
  } else if (payloadLen < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payloadLen, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(payloadLen, 6);
  }

  // Masked payload
  const masked = Buffer.allocUnsafe(payloadLen);
  for (let i = 0; i < payloadLen; i++) {
    masked[i] = (payload[i] ?? 0) ^ (maskKey[i % 4] ?? 0);
  }

  return Buffer.concat([header, maskKey, masked]);
}

/** Build a masked ping frame. */
function makePingFrame(data: Buffer = Buffer.alloc(0), maskKey: Buffer = Buffer.alloc(4)): Buffer {
  const header = Buffer.alloc(2);
  header[0] = 0x89;               // FIN + ping opcode
  header[1] = 0x80 | data.length;
  const masked = Buffer.allocUnsafe(data.length);
  for (let i = 0; i < data.length; i++) {
    masked[i] = (data[i] ?? 0) ^ (maskKey[i % 4] ?? 0);
  }
  return Buffer.concat([header, maskKey, masked]);
}

/** Build a masked close frame. */
function makeCloseFrame(maskKey: Buffer = Buffer.alloc(4)): Buffer {
  const header = Buffer.alloc(2);
  header[0] = 0x88; // FIN + close opcode
  header[1] = 0x80; // MASK, zero payload
  return Buffer.concat([header, maskKey]);
}

/** Collect all frames emitted synchronously while calling decoder.feed(). */
function collectFrames(decoder: WsFrameDecoder, chunk: Buffer): WsFrame[] {
  const frames: WsFrame[] = [];
  const listener = (f: WsFrame): void => { frames.push(f); };
  decoder.on('frame', listener);
  decoder.feed(chunk);
  decoder.off('frame', listener);
  return frames;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WsFrameDecoder', () => {
  it('decodes a simple short text frame (zero mask key)', () => {
    const decoder = new WsFrameDecoder();
    const text    = '{"jsonrpc":"2.0","id":1}';
    const frame   = makeTextFrame(text);

    const frames = collectFrames(decoder, frame);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.opcode).toBe('text');
    expect(frames[0]!.payload.toString('utf8')).toBe(text);
  });

  it('correctly unmasks payload using a non-zero mask key', () => {
    const decoder = new WsFrameDecoder();
    const text    = 'hello OPNET';
    const maskKey = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const frame   = makeTextFrame(text, maskKey);

    const frames = collectFrames(decoder, frame);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.payload.toString('utf8')).toBe(text);
  });

  it('emits ping frame with correct opcode', () => {
    const decoder   = new WsFrameDecoder();
    const pingData  = Buffer.from('keepalive');
    const maskKey   = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const frame     = makePingFrame(pingData, maskKey);

    const frames = collectFrames(decoder, frame);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.opcode).toBe('ping');
    expect(frames[0]!.payload).toEqual(pingData);
  });

  it('emits close frame with correct opcode', () => {
    const decoder = new WsFrameDecoder();
    const frame   = makeCloseFrame();

    const frames = collectFrames(decoder, frame);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.opcode).toBe('close');
  });

  it('silently drops unknown opcodes', () => {
    const decoder = new WsFrameDecoder();
    // Opcode 0x3 is reserved/unknown
    const raw = Buffer.from([
      0x83,       // FIN + opcode 0x3
      0x80 | 3,   // MASK + length 3
      0,0,0,0,    // mask key (zero)
      0x41, 0x42, 0x43, // payload "ABC"
    ]);

    const frames = collectFrames(decoder, raw);
    expect(frames).toHaveLength(0);
  });

  it('handles split-chunk delivery (frame arrives in two pieces)', () => {
    const decoder = new WsFrameDecoder();
    const text    = 'split delivery test';
    const maskKey = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);
    const full    = makeTextFrame(text, maskKey);
    const mid     = Math.floor(full.length / 2);

    const allFrames: WsFrame[] = [];
    decoder.on('frame', (f) => allFrames.push(f));

    decoder.feed(full.subarray(0, mid));   // first half — incomplete
    expect(allFrames).toHaveLength(0);     // not yet

    decoder.feed(full.subarray(mid));      // second half — complete
    expect(allFrames).toHaveLength(1);
    expect(allFrames[0]!.payload.toString('utf8')).toBe(text);
  });

  it('parses two consecutive frames from a single chunk', () => {
    const decoder = new WsFrameDecoder();
    const a = makeTextFrame('frame-A');
    const b = makeTextFrame('frame-B');

    const frames = collectFrames(decoder, Buffer.concat([a, b]));
    expect(frames).toHaveLength(2);
    expect(frames[0]!.payload.toString()).toBe('frame-A');
    expect(frames[1]!.payload.toString()).toBe('frame-B');
  });

  it('decodes a 126-length extended frame correctly', () => {
    const decoder = new WsFrameDecoder();
    // Build a payload of exactly 126 bytes
    const text    = 'x'.repeat(126);
    const frame   = makeTextFrame(text);

    // Verify our helper encoded it with the 16-bit extended length
    expect(frame[1]! & 0x7f).toBe(126);

    const frames = collectFrames(decoder, frame);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.payload.toString('utf8')).toBe(text);
  });

  it('decodes a 127-length (32-bit) extended frame correctly', () => {
    const decoder = new WsFrameDecoder();
    // Build a payload of exactly 65536 bytes (triggers the 64-bit length path)
    const text    = 'y'.repeat(65536);
    const frame   = makeTextFrame(text);

    expect(frame[1]! & 0x7f).toBe(127);

    const frames = collectFrames(decoder, frame);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.payload.length).toBe(65536);
    expect(frames[0]!.payload.toString('utf8')).toBe(text);
  });

  it('handles an unmasked frame gracefully (server→server scenario)', () => {
    const decoder = new WsFrameDecoder();
    const text    = 'no mask';
    const payload = Buffer.from(text, 'utf8');
    // Build unmasked frame (MASK bit = 0)
    const header  = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = payload.length; // no MASK bit
    const raw = Buffer.concat([header, payload]);

    const frames = collectFrames(decoder, raw);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.payload.toString('utf8')).toBe(text);
  });
});
