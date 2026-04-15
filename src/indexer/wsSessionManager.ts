/**
 * WebSocket session manager — stateful per-connection subscription state.
 *
 * Replaces the raw `_wsClients: Set<Duplex>` broadcast model for connections
 * that upgrade via `attachToServer()`.  Each connected socket gets a `WsSession`
 * that starts in "broadcast" mode (all events forwarded, plain JSON — identical
 * to the old behaviour) and switches to "subscribed" mode on the first
 * `opstream_subscribe` call.
 *
 * Protocol: JSON-RPC 2.0 over the WebSocket connection (not HTTP).
 *
 *   Client sends:
 *     {"jsonrpc":"2.0","id":1,"method":"opstream_subscribe","params":["logs",{"eventNames":["Swapped"]}]}
 *   Server responds:
 *     {"jsonrpc":"2.0","id":1,"result":"0x<16-hex-char subId>"}
 *   Server pushes on match:
 *     {"jsonrpc":"2.0","method":"opstream_subscription","params":{"subscription":"0x…","result":{...event...}}}
 *
 *   Client sends:
 *     {"jsonrpc":"2.0","id":2,"method":"opstream_unsubscribe","params":["0x<subId>"]}
 *   Server responds:
 *     {"jsonrpc":"2.0","id":2,"result":true}
 *
 * Subscription types:
 *   "logs"      — confirmed contract events, filtered by address and/or eventNames
 *   "newBlocks" — one notification per confirmed block (eventName "NewBlock")
 *   "txStatus"  — mempool lifecycle for a specific txid:
 *                   MempoolPending → MempoolConfirmed | MempoolDropped
 *
 * Backward compatibility:
 *   Sessions that never call opstream_subscribe remain in broadcast mode and
 *   receive every event as a plain JSON object (the original wire format).
 *   This means old WsEventSource clients work unchanged until they opt in.
 */

import { randomBytes } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { WsFrameDecoder } from './wsFrameDecoder.js';
import type { WsFrame } from './wsFrameDecoder.js';
import type { WebhookEvent } from './webhooks.js';

// ---------------------------------------------------------------------------
// Subscription types
// ---------------------------------------------------------------------------

export type SubscriptionKind = 'logs' | 'newBlocks' | 'txStatus';

export interface LogsFilter {
  /** Contract address (case-insensitive exact match). Optional — omit to match all. */
  address?:    string;
  /** Event names to include. Optional — omit to match all. */
  eventNames?: string[];
}

export interface TxStatusFilter {
  /** Transaction ID (hash) to track. */
  txid: string;
}

export interface WsSubscription {
  /** Subscription identifier — "0x" + 16 hex chars. */
  id:     string;
  kind:   SubscriptionKind;
  filter: LogsFilter | TxStatusFilter | Record<string, never>;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

type SessionMode = 'broadcast' | 'subscribed';

interface WsSession {
  socket:        Duplex;
  decoder:       WsFrameDecoder;
  mode:          SessionMode;
  subscriptions: Map<string, WsSubscription>; // subId → sub
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method:  'opstream_subscription';
  params: {
    subscription: string;
    result:       unknown;
  };
}

interface ClientRequest {
  jsonrpc: string;
  id:      string | number | null | undefined;
  method:  string;
  params?: unknown;
}

// ---------------------------------------------------------------------------
// WsSessionManager
// ---------------------------------------------------------------------------

export class WsSessionManager {
  private readonly _sessions = new Map<Duplex, WsSession>();

  // ── Connection lifecycle ──────────────────────────────────────────────────

  addConnection(socket: Duplex): void {
    const decoder = new WsFrameDecoder();
    const session: WsSession = {
      socket,
      decoder,
      mode:          'broadcast',
      subscriptions: new Map(),
    };

    this._sessions.set(socket, session);

    // Feed raw socket bytes into the frame decoder
    socket.on('data', (chunk: Buffer) => { decoder.feed(chunk); });

    // Handle decoded frames
    decoder.on('frame', (frame: WsFrame) => {
      if (frame.opcode === 'ping') {
        this._sendPong(socket, frame.payload);
        return;
      }
      if (frame.opcode === 'text') {
        this._handleTextFrame(session, frame.payload);
      }
    });

    // Cleanup on disconnect
    const cleanup = (): void => { this._sessions.delete(socket); };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  }

  /** Total number of live WebSocket sessions. */
  get sessionCount(): number {
    return this._sessions.size;
  }

  // ── Dispatch ─────────────────────────────────────────────────────────────

  /**
   * Dispatch an event to all connected sessions.
   *
   * Broadcast mode sessions receive the event as a plain JSON text frame
   * (backward-compatible with old WsEventSource clients).
   *
   * Subscribed mode sessions receive only events that match at least one
   * of their registered subscriptions, wrapped in a JSON-RPC notification.
   */
  dispatch(event: WebhookEvent): void {
    for (const session of this._sessions.values()) {
      if (session.mode === 'broadcast') {
        this._sendRaw(session.socket, event);
        continue;
      }
      for (const sub of session.subscriptions.values()) {
        if (this._matches(event, sub)) {
          this._sendNotification(session.socket, sub.id, event);
          break; // send once per session even if multiple subs match
        }
      }
    }
  }

  // ── JSON-RPC frame handling ───────────────────────────────────────────────

  private _handleTextFrame(session: WsSession, payload: Buffer): void {
    let req: ClientRequest;
    try {
      req = JSON.parse(payload.toString('utf8')) as ClientRequest;
    } catch {
      return; // malformed JSON — ignore silently
    }

    if (req.method === 'opstream_subscribe') {
      this._handleSubscribe(session, req);
    } else if (req.method === 'opstream_unsubscribe') {
      this._handleUnsubscribe(session, req);
    }
    // All other methods are silently ignored (WS channel is subscribe-only)
  }

  // ── opstream_subscribe ────────────────────────────────────────────────────

  private _handleSubscribe(session: WsSession, req: ClientRequest): void {
    const params = Array.isArray(req.params) ? req.params : [];
    const kind   = params[0] as SubscriptionKind | undefined;

    if (kind !== 'logs' && kind !== 'newBlocks' && kind !== 'txStatus') {
      this._sendError(session.socket, req.id, -32602,
        `Unknown subscription kind: ${String(kind)}. Expected "logs", "newBlocks", or "txStatus".`);
      return;
    }

    const rawFilter = (params[1] ?? {}) as Record<string, unknown>;

    // Validate txStatus filter has a txid string
    if (kind === 'txStatus') {
      if (typeof rawFilter['txid'] !== 'string' || rawFilter['txid'].length === 0) {
        this._sendError(session.socket, req.id, -32602,
          'txStatus subscription requires { txid: string }.');
        return;
      }
    }

    const subId = '0x' + randomBytes(8).toString('hex');
    const sub: WsSubscription = {
      id:     subId,
      kind,
      filter: rawFilter as LogsFilter | TxStatusFilter | Record<string, never>,
    };

    session.subscriptions.set(subId, sub);
    session.mode = 'subscribed'; // switch out of legacy broadcast on first subscribe

    this._sendResult(session.socket, req.id, subId);
  }

  // ── opstream_unsubscribe ──────────────────────────────────────────────────

  private _handleUnsubscribe(session: WsSession, req: ClientRequest): void {
    const params = Array.isArray(req.params) ? req.params : [];
    const subId  = params[0];

    if (typeof subId !== 'string') {
      this._sendError(session.socket, req.id, -32602, 'First parameter must be the subscription ID string.');
      return;
    }

    const removed = session.subscriptions.delete(subId);

    // If no subscriptions remain, revert to broadcast mode
    if (session.subscriptions.size === 0) {
      session.mode = 'broadcast';
    }

    this._sendResult(session.socket, req.id, removed);
  }

  // ── Filter matching ───────────────────────────────────────────────────────

  private _matches(event: WebhookEvent, sub: WsSubscription): boolean {
    switch (sub.kind) {
      case 'logs': {
        // Skip mempool events (blockNumber -1 = not yet in a block)
        if (event.blockNumber === -1) return false;
        // Skip our own synthetic events
        if (event.eventName === 'NewBlock') return false;

        const f = sub.filter as LogsFilter;
        if (f.address !== undefined &&
            f.address.toLowerCase() !== event.contractAddress.toLowerCase()) {
          return false;
        }
        if (f.eventNames !== undefined &&
            f.eventNames.length > 0 &&
            !f.eventNames.includes(event.eventName)) {
          return false;
        }
        return true;
      }

      case 'newBlocks':
        return event.eventName === 'NewBlock';

      case 'txStatus': {
        const f = sub.filter as TxStatusFilter;
        // Match the txid for any mempool lifecycle event or a confirmed event with this txHash
        return event.txHash === f.txid;
      }
    }
  }

  // ── Wire helpers ──────────────────────────────────────────────────────────

  /** Send raw JSON (plain WebhookEvent) — backward-compat broadcast mode. */
  private _sendRaw(socket: Duplex, event: WebhookEvent): void {
    this._writeText(socket, JSON.stringify(event));
  }

  /** Send a JSON-RPC subscription notification. */
  private _sendNotification(socket: Duplex, subId: string, result: unknown): void {
    const notif: JsonRpcNotification = {
      jsonrpc: '2.0',
      method:  'opstream_subscription',
      params:  { subscription: subId, result },
    };
    this._writeText(socket, JSON.stringify(notif));
  }

  private _sendResult(socket: Duplex, id: unknown, result: unknown): void {
    this._writeText(socket, JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }));
  }

  private _sendError(socket: Duplex, id: unknown, code: number, message: string): void {
    this._writeText(socket, JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }));
  }

  private _sendPong(socket: Duplex, payload: Buffer): void {
    const header = Buffer.alloc(2);
    header[0] = 0x8a; // FIN + pong opcode
    header[1] = payload.length & 0x7f; // no mask on server-side frames
    try {
      socket.write(Buffer.concat([header, payload]));
    } catch {
      this._sessions.delete(socket);
    }
  }

  private _writeText(socket: Duplex, text: string): void {
    const payload = Buffer.from(text, 'utf8');
    const frame   = this._encodeTextFrame(payload);
    try {
      socket.write(frame);
    } catch {
      this._sessions.delete(socket);
    }
  }

  /** RFC 6455 text frame (server→client, no masking). */
  private _encodeTextFrame(payload: Buffer): Buffer {
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
