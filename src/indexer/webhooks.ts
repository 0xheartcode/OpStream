/**
 * Webhook / notification layer — SubscriptionManager.
 *
 * External consumers (Telegram bots, Twitter bots, dashboards) register
 * interest patterns and receive HTTP POST callbacks whenever a matching
 * on-chain event is indexed.
 *
 * Pattern matching (all fields optional, ANDed):
 *   contract   — exact case-insensitive address match
 *   eventName  — exact event name match  (e.g. 'Swapped', 'SwapExecuted')
 *
 * OpStream stores raw event bytes only — payload-aware filters (e.g. minimum
 * amount) belong in the consumer (op-index handlers or the downstream service).
 *
 * Delivery:
 *   - HTTP POST with JSON body (fetch-based, 5s timeout)
 *   - 3 retries with exponential backoff (1s → 2s → 4s)
 *   - Fire-and-forget: dispatch() is synchronous, delivery is async
 *
 * In-memory broadcast:
 *   - SubscriptionManager extends EventEmitter; emits 'broadcast' on dispatch()
 *   - Attach listeners for WebSocket forwarding or in-process consumers
 *
 * WebSocket support (two modes):
 *   Legacy broadcast — startBroadcastServer(port) or attachToServer(server) without
 *     a WsSessionManager: every event is sent as a plain JSON text frame to all clients.
 *     Backward-compatible with old WsEventSource consumers.
 *
 *   Stateful subscriptions — call setWsSessionManager(mgr) before attachToServer():
 *     new connections are handed to WsSessionManager. Each client can send
 *     opstream_subscribe / opstream_unsubscribe JSON-RPC calls and receives
 *     server-side-filtered push notifications. Old broadcast path unused.
 */

import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WsSessionManager } from './wsSessionManager.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Filter criteria for a webhook subscription. All fields optional (AND logic). */
export interface EventPattern {
  /** If set, only match events from this contract address (case-insensitive). */
  contract?: string;
  /** If set, only match events with this exact event name. */
  eventName?: string;
}

/** Normalized on-chain event for webhook delivery. */
export interface WebhookEvent {
  // Core identity fields (always present):
  blockNumber:     number;
  txHash:          string;
  contractAddress: string;
  eventName:       string;

  // Enriched fields (optional — added for WebSocket / op-index Tier-2 consumers):
  logIndex?:       number;              // position of this event within its transaction
  blockTimestamp?: number;              // unix timestamp of the containing block
  txIndex?:        number;              // position of the transaction within the block
  fromAddress?:    string | null;       // address that submitted the transaction
  gasUsed?:        string | null;       // satoshi units, serialised as decimal string
  burnedBitcoin?:  string | null;       // satoshi units, serialised as decimal string
  failed?:         boolean;             // true when the transaction reverted
  revertReason?:   string | null;       // revert message, if any
  eventRaw?:       string;              // hex-encoded raw event bytes, e.g. "0x1a2b3c…"
}

/** A registered subscription. */
export interface Subscription {
  id: string;
  pattern: EventPattern;
  callbackUrl: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RETRY_BASE_DELAY_MS = 1_000;
const MAX_RETRIES = 3;
const FETCH_TIMEOUT_MS = 5_000;

/** WebSocket handshake magic GUID (RFC 6455). */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ---------------------------------------------------------------------------
// SubscriptionManager
// ---------------------------------------------------------------------------

export class SubscriptionManager extends EventEmitter {
  private readonly _subs = new Map<string, Subscription>();
  private _idCounter = 0;
  private _httpServer: Server | null = null;
  private readonly _wsClients = new Set<Duplex>();
  private _wsSessionManager: WsSessionManager | null = null;

  /** Wire a WsSessionManager to handle all new WebSocket connections. */
  setWsSessionManager(mgr: WsSessionManager): void {
    this._wsSessionManager = mgr;
  }

  // ── Registration ──────────────────────────────────────────────────────────

  register(pattern: EventPattern, callbackUrl: string): string {
    const id = `sub_${++this._idCounter}`;
    this._subs.set(id, { id, pattern, callbackUrl });
    return id;
  }

  unregister(subscriptionId: string): boolean {
    return this._subs.delete(subscriptionId);
  }

  get subscriptionCount(): number {
    return this._subs.size;
  }

  getSubscriptions(): Subscription[] {
    return [...this._subs.values()];
  }

  // ── Pattern matching ──────────────────────────────────────────────────────

  matchesPattern(pattern: EventPattern, event: WebhookEvent): boolean {
    if (
      pattern.contract !== undefined &&
      pattern.contract.toLowerCase() !== event.contractAddress.toLowerCase()
    ) {
      return false;
    }

    if (pattern.eventName !== undefined && pattern.eventName !== event.eventName) {
      return false;
    }

    return true;
  }

  // ── Dispatch ─────────────────────────────────────────────────────────────

  dispatch(event: WebhookEvent): void {
    this.emit('broadcast', event);

    if (this._wsSessionManager !== null) {
      this._wsSessionManager.dispatch(event);
    } else if (this._wsClients.size > 0) {
      const json = JSON.stringify(event);
      const frame = this._encodeWsTextFrame(json);
      for (const client of this._wsClients) {
        try {
          client.write(frame);
        } catch {
          this._wsClients.delete(client);
        }
      }
    }

    for (const sub of this._subs.values()) {
      if (this.matchesPattern(sub.pattern, event)) {
        void this._deliverWithRetry(sub.callbackUrl, event, 1);
      }
    }
  }

  // ── HTTP delivery with retry ──────────────────────────────────────────────

  /** @internal exposed for testing */
  async _deliverWithRetry(
    url: string,
    event: WebhookEvent,
    attempt: number,
  ): Promise<void> {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
    } catch (err) {
      if (attempt <= MAX_RETRIES) {
        const delayMs = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        return this._deliverWithRetry(url, event, attempt + 1);
      }
      this.emit('deliveryFailed', { url, event, error: err instanceof Error ? err.message : String(err), attempts: attempt });
    }
  }

  // ── WebSocket broadcast server ─────────────────────────────────────────────

  startBroadcastServer(port: number): void {
    if (this._httpServer) return;

    this._httpServer = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OpStream WebSocket broadcast server\n');
    });

    this.attachToServer(this._httpServer);
    this._httpServer.listen(port);
  }

  /**
   * Attach WebSocket upgrade handling to an **existing** HTTP server.
   *
   * This is the preferred path for Railway / single-port deployments: the
   * JSON-RPC HTTP server and the WebSocket broadcast share the same port.
   * The server does NOT need to call listen() — that is the caller's job.
   *
   * Multiple calls are safe; each call adds another 'upgrade' listener.
   */
  attachToServer(server: Server): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
      const key = req.headers['sec-websocket-key'];
      if (!key || req.headers['upgrade']?.toLowerCase() !== 'websocket') {
        socket.destroy();
        return;
      }

      const acceptKey = createHash('sha1')
        .update(key + WS_GUID)
        .digest('base64');

      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
        '\r\n',
      );

      if (this._wsSessionManager !== null) {
        this._wsSessionManager.addConnection(socket);
      } else {
        this._wsClients.add(socket);
        socket.on('close', () => this._wsClients.delete(socket));
        socket.on('error', () => this._wsClients.delete(socket));
      }
    });
  }

  stopBroadcastServer(): void {
    for (const client of this._wsClients) {
      try { client.destroy(); } catch { /* ignore */ }
    }
    this._wsClients.clear();
    this._httpServer?.close();
    this._httpServer = null;
  }

  get wsClientCount(): number {
    return this._wsClients.size;
  }

  // ── WebSocket frame encoding ──────────────────────────────────────────────

  private _encodeWsTextFrame(text: string): Buffer {
    const payload = Buffer.from(text, 'utf8');
    const len = payload.length;

    let header: Buffer;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x81;
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(len, 6);
    }

    return Buffer.concat([header, payload]);
  }
}

// ---------------------------------------------------------------------------
// Factory / loader
// ---------------------------------------------------------------------------

export function loadEnvWebhooks(manager: SubscriptionManager): number {
  const raw = process.env['WEBHOOK_URLS'];
  if (!raw) return 0;

  let count = 0;
  for (const url of raw.split(',').map((u) => u.trim()).filter(Boolean)) {
    manager.register({}, url);
    count++;
  }
  return count;
}

/** Singleton manager (shared across the process). */
let _globalManager: SubscriptionManager | null = null;

export function getWebhookManager(): SubscriptionManager {
  if (!_globalManager) {
    _globalManager = new SubscriptionManager();
    loadEnvWebhooks(_globalManager);
  }
  return _globalManager;
}

/** Reset the singleton (for tests). */
export function resetWebhookManager(): void {
  _globalManager?.stopBroadcastServer();
  _globalManager = null;
}
