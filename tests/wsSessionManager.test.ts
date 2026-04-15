import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { WsSessionManager } from '../src/indexer/wsSessionManager.js';
import type { WebhookEvent } from '../src/indexer/webhooks.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal fake duplex socket that keeps the two directions fully separate.
 *
 * Problem with PassThrough: socket.write() feeds data back through the stream
 * as a 'data' event, which loops server responses into the WsFrameDecoder.
 *
 * Solution: intercept write() calls with a private '_serverWrite' event so
 * they land only in the test's `writes` array, never back in the decoder.
 */
class MockSocket extends EventEmitter {
  write(chunk: Buffer | string): boolean {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    this.emit('_serverWrite', buf);
    return true;
  }

  /** Simulate the client sending data to the server. */
  push(chunk: Buffer): void {
    this.emit('data', chunk);
  }

  /** Simulate a clean disconnect — emits 'close' synchronously. */
  destroy(): void {
    this.emit('close');
  }
}

/** Build a minimal enriched WebhookEvent. */
function ev(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    blockNumber:     100,
    txHash:          'txabc',
    contractAddress: 'bc1qcontract',
    eventName:       'Swapped',
    failed:          false,
    ...overrides,
  };
}

/** Decode a server→client text frame into a JavaScript value. */
function decodeFrame(buf: Buffer): unknown {
  // Server frames are NOT masked.
  // byte 0: FIN + opcode (0x81 = text)
  // byte 1: payload length (< 126 for test messages)
  const payloadLen = buf[1]! & 0x7f;
  const payload    = buf.subarray(2, 2 + payloadLen);
  return JSON.parse(payload.toString('utf8'));
}

/**
 * Build a masked client→server text frame from a JSON value.
 * Uses a zero mask key for simplicity (XOR identity → payload unchanged).
 */
function encodeClientFrame(value: unknown): Buffer {
  const text    = JSON.stringify(value);
  const payload = Buffer.from(text, 'utf8');
  const len     = payload.length;

  const header = Buffer.alloc(2);
  header[0] = 0x81;
  header[1] = 0x80 | len; // MASK bit + 7-bit length

  const maskKey = Buffer.alloc(4); // zero key — XOR identity
  const masked  = Buffer.from(payload); // already unmasked because key is 0

  return Buffer.concat([header, maskKey, masked]);
}

/** Connect a MockSocket to the manager and return collected server writes. */
function connect(mgr: WsSessionManager): { socket: MockSocket; writes: Buffer[] } {
  const socket = new MockSocket();
  const writes: Buffer[] = [];
  socket.on('_serverWrite', (chunk: Buffer) => { writes.push(chunk); });
  mgr.addConnection(socket as unknown as import('node:stream').Duplex);
  return { socket, writes };
}

/** Send a JSON-RPC request frame to the session manager via the socket. */
function send(socket: MockSocket, req: unknown): void {
  const frame = encodeClientFrame(req);
  socket.push(frame);
}

/** Parse all complete JSON frames written by the server into the socket. */
function readResponses(writes: Buffer[]): unknown[] {
  const combined = Buffer.concat(writes);
  const results: unknown[] = [];
  let offset = 0;
  while (offset < combined.length) {
    if (combined.length - offset < 2) break;
    const b1 = combined[offset + 1]!;
    const lenByte = b1 & 0x7f;
    let payloadLen: number;
    let headerLen: number;
    if (lenByte < 126) {
      payloadLen = lenByte;
      headerLen  = 2;
    } else if (lenByte === 126) {
      payloadLen = combined.readUInt16BE(offset + 2);
      headerLen  = 4;
    } else {
      payloadLen = combined.readUInt32BE(offset + 6);
      headerLen  = 10;
    }
    const payload = combined.subarray(offset + headerLen, offset + headerLen + payloadLen);
    try {
      results.push(JSON.parse(payload.toString('utf8')));
    } catch {
      // skip malformed
    }
    offset += headerLen + payloadLen;
  }
  return results;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WsSessionManager', () => {
  let mgr: WsSessionManager;

  beforeEach(() => {
    mgr = new WsSessionManager();
  });

  // ── Session lifecycle ────────────────────────────────────────────────────

  it('tracks session count', () => {
    expect(mgr.sessionCount).toBe(0);
    const { socket } = connect(mgr);
    expect(mgr.sessionCount).toBe(1);
    socket.destroy();
    expect(mgr.sessionCount).toBe(0);
  });

  it('removes session on socket error event', () => {
    const { socket } = connect(mgr);
    expect(mgr.sessionCount).toBe(1);
    socket.emit('error', new Error('boom'));
    expect(mgr.sessionCount).toBe(0);
  });

  // ── Broadcast mode (default) ─────────────────────────────────────────────

  it('broadcasts raw JSON to unsubscribed sessions', () => {
    const { writes } = connect(mgr);
    mgr.dispatch(ev());
    expect(writes.length).toBeGreaterThan(0);
    const msg = decodeFrame(Buffer.concat(writes)) as Record<string, unknown>;
    expect(msg['eventName']).toBe('Swapped');
    expect(msg['blockNumber']).toBe(100);
  });

  it('broadcasts to multiple unsubscribed sessions', () => {
    const { writes: w1 } = connect(mgr);
    const { writes: w2 } = connect(mgr);
    mgr.dispatch(ev());
    expect(w1.length).toBeGreaterThan(0);
    expect(w2.length).toBeGreaterThan(0);
  });

  // ── opstream_subscribe ────────────────────────────────────────────────────

  it('returns a subId on subscribe and switches to subscribed mode', () => {
    const { socket, writes } = connect(mgr);
    send(socket, { jsonrpc: '2.0', id: 1, method: 'opstream_subscribe', params: ['logs', {}] });

    const responses = readResponses(writes);
    expect(responses).toHaveLength(1);
    const resp = responses[0] as Record<string, unknown>;
    expect(resp['id']).toBe(1);
    expect(typeof resp['result']).toBe('string');
    expect((resp['result'] as string).startsWith('0x')).toBe(true);
  });

  it('sends matching event as opstream_subscription notification (logs, no filter)', () => {
    const { socket, writes } = connect(mgr);
    send(socket, { jsonrpc: '2.0', id: 1, method: 'opstream_subscribe', params: ['logs', {}] });
    writes.length = 0; // clear the ack

    mgr.dispatch(ev({ eventName: 'Swapped', contractAddress: 'bc1qcontract' }));

    const msgs = readResponses(writes);
    expect(msgs).toHaveLength(1);
    const msg = msgs[0] as Record<string, unknown>;
    expect(msg['method']).toBe('opstream_subscription');
    const params = msg['params'] as Record<string, unknown>;
    expect((params['result'] as Record<string, unknown>)['eventName']).toBe('Swapped');
  });

  it('filters by address (case-insensitive)', () => {
    const { socket, writes } = connect(mgr);
    send(socket, { jsonrpc: '2.0', id: 1, method: 'opstream_subscribe', params: ['logs', { address: 'BC1QTARGET' }] });
    writes.length = 0;

    mgr.dispatch(ev({ contractAddress: 'bc1qtarget' }));   // matches (case-insensitive)
    mgr.dispatch(ev({ contractAddress: 'bc1qother'  }));   // no match

    const msgs = readResponses(writes);
    expect(msgs).toHaveLength(1);
  });

  it('filters by eventNames array', () => {
    const { socket, writes } = connect(mgr);
    send(socket, { jsonrpc: '2.0', id: 1, method: 'opstream_subscribe', params: ['logs', { eventNames: ['Transfer'] }] });
    writes.length = 0;

    mgr.dispatch(ev({ eventName: 'Transfer' }));   // matches
    mgr.dispatch(ev({ eventName: 'Approval'  }));  // no match

    const msgs = readResponses(writes);
    expect(msgs).toHaveLength(1);
    const result = (msgs[0] as Record<string, unknown>)['params'] as Record<string, unknown>;
    expect((result['result'] as Record<string, unknown>)['eventName']).toBe('Transfer');
  });

  it('skips mempool events (blockNumber -1) for logs subscriptions', () => {
    const { socket, writes } = connect(mgr);
    send(socket, { jsonrpc: '2.0', id: 1, method: 'opstream_subscribe', params: ['logs', {}] });
    writes.length = 0;

    mgr.dispatch(ev({ blockNumber: -1, eventName: 'MempoolPending' }));

    expect(readResponses(writes)).toHaveLength(0);
  });

  it('routes txStatus events correctly', () => {
    const { socket, writes } = connect(mgr);
    send(socket, { jsonrpc: '2.0', id: 1, method: 'opstream_subscribe', params: ['txStatus', { txid: 'mytxid' }] });
    writes.length = 0;

    mgr.dispatch(ev({ txHash: 'mytxid',   blockNumber: -1, eventName: 'MempoolPending' }));  // match
    mgr.dispatch(ev({ txHash: 'otherid',  blockNumber: -1, eventName: 'MempoolPending' }));  // no match
    mgr.dispatch(ev({ txHash: 'mytxid',   blockNumber: 101, eventName: 'Swapped'       }));  // match (confirmed tx)

    const msgs = readResponses(writes);
    expect(msgs).toHaveLength(2);
  });

  it('routes newBlocks events correctly', () => {
    const { socket, writes } = connect(mgr);
    send(socket, { jsonrpc: '2.0', id: 1, method: 'opstream_subscribe', params: ['newBlocks'] });
    writes.length = 0;

    mgr.dispatch(ev({ eventName: 'NewBlock', txHash: '', contractAddress: '' }));  // match
    mgr.dispatch(ev({ eventName: 'Swapped' }));                                    // no match

    const msgs = readResponses(writes);
    expect(msgs).toHaveLength(1);
    const result = (msgs[0] as Record<string, unknown>)['params'] as Record<string, unknown>;
    expect((result['result'] as Record<string, unknown>)['eventName']).toBe('NewBlock');
  });

  it('returns error for unknown subscription kind', () => {
    const { socket, writes } = connect(mgr);
    send(socket, { jsonrpc: '2.0', id: 1, method: 'opstream_subscribe', params: ['unknown_kind'] });

    const responses = readResponses(writes);
    expect(responses).toHaveLength(1);
    const resp = responses[0] as Record<string, unknown>;
    expect(resp['error']).toBeTruthy();
    const err = resp['error'] as Record<string, unknown>;
    expect(err['code']).toBe(-32602);
  });

  it('returns error for txStatus without txid', () => {
    const { socket, writes } = connect(mgr);
    send(socket, { jsonrpc: '2.0', id: 1, method: 'opstream_subscribe', params: ['txStatus', {}] });

    const responses = readResponses(writes);
    const resp = responses[0] as Record<string, unknown>;
    expect(resp['error']).toBeTruthy();
  });

  // ── opstream_unsubscribe ──────────────────────────────────────────────────

  it('unsubscribes and reverts to broadcast mode when all subs removed', () => {
    const { socket, writes } = connect(mgr);
    send(socket, { jsonrpc: '2.0', id: 1, method: 'opstream_subscribe', params: ['logs', {}] });
    const subId = (readResponses(writes)[0] as Record<string, unknown>)['result'] as string;
    writes.length = 0;

    send(socket, { jsonrpc: '2.0', id: 2, method: 'opstream_unsubscribe', params: [subId] });

    // Should get unsubscribe ack
    const responses = readResponses(writes);
    const resp = responses[0] as Record<string, unknown>;
    expect(resp['result']).toBe(true);
    writes.length = 0;

    // Should now receive raw broadcast again
    mgr.dispatch(ev());
    const msgs = readResponses(writes);
    expect(msgs).toHaveLength(1);
    // Raw broadcast: no "method" field, just the event directly
    expect((msgs[0] as Record<string, unknown>)['method']).toBeUndefined();
    expect((msgs[0] as Record<string, unknown>)['eventName']).toBe('Swapped');
  });

  it('returns false when unsubscribing unknown subId', () => {
    const { socket, writes } = connect(mgr);
    send(socket, { jsonrpc: '2.0', id: 1, method: 'opstream_unsubscribe', params: ['0xnotexist'] });

    const responses = readResponses(writes);
    const resp = responses[0] as Record<string, unknown>;
    expect(resp['result']).toBe(false);
  });

  it('returns error when unsubscribe has no subId', () => {
    const { socket, writes } = connect(mgr);
    send(socket, { jsonrpc: '2.0', id: 1, method: 'opstream_unsubscribe', params: [] });

    const responses = readResponses(writes);
    const resp = responses[0] as Record<string, unknown>;
    expect(resp['error']).toBeTruthy();
  });

  // ── Pong / misc ───────────────────────────────────────────────────────────

  it('replies with pong to a ping frame', () => {
    const { socket, writes } = connect(mgr);

    // Build a masked ping frame
    const pingData  = Buffer.from('ping-payload');
    const maskKey   = Buffer.alloc(4);
    const header    = Buffer.alloc(2);
    header[0] = 0x89; // FIN + ping
    header[1] = 0x80 | pingData.length;
    const maskedPayload = Buffer.from(pingData); // zero key = identity
    const pingFrame = Buffer.concat([header, maskKey, maskedPayload]);

    socket.push(pingFrame);

    // Server should have written a pong (opcode 0x8A)
    const combined = Buffer.concat(writes);
    expect(combined.length).toBeGreaterThan(0);
    expect(combined[0]! & 0x0f).toBe(0x0a); // pong opcode
  });

  it('silently ignores malformed JSON from client', () => {
    const { socket, writes } = connect(mgr);

    // Send a valid WS frame but with invalid JSON content
    const payload = Buffer.from('this is not json');
    const header  = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = 0x80 | payload.length;
    const maskKey = Buffer.alloc(4);
    socket.push(Buffer.concat([header, maskKey, payload]));

    // No crash, no response
    expect(writes).toHaveLength(0);
  });

  // ── Multiple subscriptions ────────────────────────────────────────────────

  it('handles multiple subscriptions on one session, sends once per matching event', () => {
    const { socket, writes } = connect(mgr);
    send(socket, { jsonrpc: '2.0', id: 1, method: 'opstream_subscribe', params: ['logs', { eventNames: ['Swapped'] }] });
    send(socket, { jsonrpc: '2.0', id: 2, method: 'opstream_subscribe', params: ['logs', { eventNames: ['Swapped'] }] });
    writes.length = 0;

    // Both subs match — but event should only be sent ONCE per session
    mgr.dispatch(ev({ eventName: 'Swapped' }));
    const msgs = readResponses(writes);
    expect(msgs).toHaveLength(1);
  });
});
