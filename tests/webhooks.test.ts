import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { SubscriptionManager, resetWebhookManager } from '../src/indexer/webhooks.js';
import type { WebhookEvent } from '../src/indexer/webhooks.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal enriched event covering all optional fields. */
function enrichedEvent(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    blockNumber:     100,
    txHash:          'tx_abc',
    contractAddress: 'bc1qcontract',
    eventName:       'Transfer',
    logIndex:        0,
    blockTimestamp:  1_700_000_000,
    txIndex:         2,
    fromAddress:     'bc1qsender',
    gasUsed:         '5000',
    burnedBitcoin:   '250',
    failed:          false,
    revertReason:    null,
    eventRaw:        '0xdeadbeef',
    ...overrides,
  };
}

/**
 * Decode a raw RFC-6455 WebSocket text frame into the JSON string it carries.
 * Only handles unmasked server frames (which is what OpStream's server sends).
 */
function decodeWsFrame(buf: Buffer): string {
  let offset = 2;
  let payloadLen = (buf[1] & 0x7f);
  if (payloadLen === 126) {
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    // 64-bit length — we only need the low 32 bits for test payloads
    payloadLen = buf.readUInt32BE(6);
    offset = 10;
  }
  return buf.subarray(offset, offset + payloadLen).toString('utf8');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SubscriptionManager', () => {
  let manager: SubscriptionManager;

  beforeEach(() => {
    manager = new SubscriptionManager();
  });

  afterEach(() => {
    manager.stopBroadcastServer();
    resetWebhookManager();
    vi.restoreAllMocks();
  });

  // ── dispatch → broadcast EventEmitter ────────────────────────────────────

  describe('dispatch() → broadcast event', () => {
    it('emits all core fields on broadcast', () => {
      const received: WebhookEvent[] = [];
      manager.on('broadcast', (e: WebhookEvent) => received.push(e));

      manager.dispatch(enrichedEvent());

      expect(received).toHaveLength(1);
      const e = received[0];
      expect(e.blockNumber).toBe(100);
      expect(e.txHash).toBe('tx_abc');
      expect(e.contractAddress).toBe('bc1qcontract');
      expect(e.eventName).toBe('Transfer');
    });

    it('emits all enriched fields on broadcast', () => {
      const received: WebhookEvent[] = [];
      manager.on('broadcast', (e: WebhookEvent) => received.push(e));

      manager.dispatch(enrichedEvent());

      const e = received[0];
      expect(e.logIndex).toBe(0);
      expect(e.blockTimestamp).toBe(1_700_000_000);
      expect(e.txIndex).toBe(2);
      expect(e.fromAddress).toBe('bc1qsender');
      expect(e.gasUsed).toBe('5000');
      expect(e.burnedBitcoin).toBe('250');
      expect(e.failed).toBe(false);
      expect(e.revertReason).toBeNull();
      expect(e.eventRaw).toBe('0xdeadbeef');
    });

    it('emits failed=true and revertReason when tx reverted', () => {
      const received: WebhookEvent[] = [];
      manager.on('broadcast', (e: WebhookEvent) => received.push(e));

      manager.dispatch(enrichedEvent({ failed: true, revertReason: 'OutOfGas' }));

      expect(received[0].failed).toBe(true);
      expect(received[0].revertReason).toBe('OutOfGas');
    });

    it('dispatches multiple events independently', () => {
      const received: WebhookEvent[] = [];
      manager.on('broadcast', (e: WebhookEvent) => received.push(e));

      manager.dispatch(enrichedEvent({ txHash: 'tx1', logIndex: 0 }));
      manager.dispatch(enrichedEvent({ txHash: 'tx2', logIndex: 1 }));
      manager.dispatch(enrichedEvent({ txHash: 'tx3', logIndex: 2 }));

      expect(received).toHaveLength(3);
      expect(received.map(e => e.txHash)).toEqual(['tx1', 'tx2', 'tx3']);
      expect(received.map(e => e.logIndex)).toEqual([0, 1, 2]);
    });
  });

  // ── dispatch → WebSocket frame ────────────────────────────────────────────

  describe('dispatch() → WebSocket frame', () => {
    it('writes a valid WS text frame containing all enriched fields', () => {
      const socket = new PassThrough();
      const chunks: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));

      // Inject the socket directly into the internal client set
      (manager as { _wsClients: Set<typeof socket> })._wsClients.add(socket);

      manager.dispatch(enrichedEvent());

      const frame = Buffer.concat(chunks);
      // First byte: 0x81 = FIN + text opcode
      expect(frame[0]).toBe(0x81);

      const json = decodeWsFrame(frame);
      expect(() => JSON.parse(json)).not.toThrow();

      const parsed = JSON.parse(json) as WebhookEvent;
      expect(parsed.blockNumber).toBe(100);
      expect(parsed.logIndex).toBe(0);
      expect(parsed.blockTimestamp).toBe(1_700_000_000);
      expect(parsed.fromAddress).toBe('bc1qsender');
      expect(parsed.gasUsed).toBe('5000');
      expect(parsed.burnedBitcoin).toBe('250');
      expect(parsed.failed).toBe(false);
      expect(parsed.revertReason).toBeNull();
      expect(parsed.eventRaw).toBe('0xdeadbeef');
    });

    it('removes a socket from _wsClients when write() throws synchronously', () => {
      // Use a stub socket whose write() throws — this is what the try/catch in
      // dispatch() is designed to handle (e.g. a socket that errors mid-write).
      const throwingSocket = {
        write: () => { throw new Error('ECONNRESET'); },
      } as unknown as PassThrough;

      (manager as { _wsClients: Set<typeof throwingSocket> })._wsClients.add(throwingSocket);
      expect(manager.wsClientCount).toBe(1);

      // dispatch() must not propagate the socket error to the caller
      expect(() => manager.dispatch(enrichedEvent())).not.toThrow();
      // The bad socket must be evicted
      expect(manager.wsClientCount).toBe(0);
    });

    it('sends to multiple WS clients simultaneously', () => {
      const sockets = [new PassThrough(), new PassThrough(), new PassThrough()];
      const received: string[][] = sockets.map(() => []);

      for (let i = 0; i < sockets.length; i++) {
        const idx = i;
        sockets[i].on('data', (chunk: Buffer) => {
          received[idx].push(decodeWsFrame(chunk));
        });
        (manager as { _wsClients: Set<(typeof sockets)[0]> })._wsClients.add(sockets[i]);
      }

      manager.dispatch(enrichedEvent());

      for (const msgs of received) {
        expect(msgs).toHaveLength(1);
        const parsed = JSON.parse(msgs[0]) as WebhookEvent;
        expect(parsed.eventRaw).toBe('0xdeadbeef');
      }
    });
  });

  // ── matchesPattern() ──────────────────────────────────────────────────────

  describe('matchesPattern()', () => {
    const event = enrichedEvent();

    it('matches when pattern is empty (catch-all)', () => {
      expect(manager.matchesPattern({}, event)).toBe(true);
    });

    it('matches on contract address (case-insensitive)', () => {
      expect(manager.matchesPattern({ contract: 'BC1QCONTRACT' }, event)).toBe(true);
      expect(manager.matchesPattern({ contract: 'bc1qcontract' }, event)).toBe(true);
      expect(manager.matchesPattern({ contract: 'bc1qother' }, event)).toBe(false);
    });

    it('matches on eventName', () => {
      expect(manager.matchesPattern({ eventName: 'Transfer' }, event)).toBe(true);
      expect(manager.matchesPattern({ eventName: 'Swap' }, event)).toBe(false);
    });

    it('enriched fields do not interfere with pattern matching', () => {
      // Extra fields on the event should not break the AND logic
      const e = enrichedEvent({ failed: true, revertReason: 'OutOfGas', logIndex: 5 });
      expect(manager.matchesPattern({ contract: 'bc1qcontract', eventName: 'Transfer' }, e)).toBe(true);
    });
  });

  // ── HTTP delivery ─────────────────────────────────────────────────────────

  describe('HTTP delivery', () => {
    it('POSTs enriched event body to registered URL', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true } as Response);
      vi.stubGlobal('fetch', mockFetch);

      const id = manager.register({}, 'http://example.com/hook');
      manager.dispatch(enrichedEvent());

      // _deliverWithRetry is async fire-and-forget — flush microtasks
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockFetch).toHaveBeenCalledOnce();
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as WebhookEvent;
      expect(body.logIndex).toBe(0);
      expect(body.blockTimestamp).toBe(1_700_000_000);
      expect(body.eventRaw).toBe('0xdeadbeef');

      manager.unregister(id);
    });

    it('retries on HTTP 500 and gives up after MAX_RETRIES', async () => {
      vi.useFakeTimers();
      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' } as Response);
      vi.stubGlobal('fetch', mockFetch);

      manager.register({}, 'http://example.com/hook');
      manager.dispatch(enrichedEvent());

      // Advance through all retry delays (1s + 2s + 4s = 7s)
      await vi.runAllTimersAsync();

      // 1 initial attempt + 3 retries = 4 total calls
      expect(mockFetch).toHaveBeenCalledTimes(4);
      vi.useRealTimers();
    });
  });

  // ── startBroadcastServer / stopBroadcastServer ───────────────────────────

  describe('startBroadcastServer / stopBroadcastServer', () => {
    it('wsClientCount starts at zero', () => {
      expect(manager.wsClientCount).toBe(0);
    });

    it('stopBroadcastServer on a never-started manager is a no-op', () => {
      expect(() => manager.stopBroadcastServer()).not.toThrow();
    });

    it('stopBroadcastServer destroys injected clients', () => {
      const socket = new PassThrough();
      (manager as { _wsClients: Set<typeof socket> })._wsClients.add(socket);
      expect(manager.wsClientCount).toBe(1);

      manager.stopBroadcastServer();
      expect(manager.wsClientCount).toBe(0);
    });

    it('startBroadcastServer is idempotent — second call is a no-op', () => {
      const port = 19876;
      manager.startBroadcastServer(port);
      manager.startBroadcastServer(port); // should not throw or bind twice
      manager.stopBroadcastServer();
    });
  });

  // ── subscription management ───────────────────────────────────────────────

  describe('register / unregister', () => {
    it('register returns unique IDs', () => {
      const id1 = manager.register({}, 'http://a.com');
      const id2 = manager.register({}, 'http://b.com');
      expect(id1).not.toBe(id2);
      expect(manager.subscriptionCount).toBe(2);
    });

    it('unregister removes the subscription', () => {
      const id = manager.register({}, 'http://a.com');
      expect(manager.unregister(id)).toBe(true);
      expect(manager.subscriptionCount).toBe(0);
    });

    it('unregister returns false for unknown IDs', () => {
      expect(manager.unregister('sub_nonexistent')).toBe(false);
    });

    it('getSubscriptions returns all registered subscriptions', () => {
      manager.register({ eventName: 'Swap' }, 'http://a.com');
      manager.register({ contract: 'bc1q' }, 'http://b.com');
      const subs = manager.getSubscriptions();
      expect(subs).toHaveLength(2);
      expect(subs.map(s => s.callbackUrl)).toContain('http://a.com');
    });
  });
});
