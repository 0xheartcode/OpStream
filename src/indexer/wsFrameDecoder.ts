/**
 * WebSocket frame decoder — server-side incoming frame parser (RFC 6455).
 *
 * The HTTP→WS upgrade path in webhooks.ts gives us a raw Duplex socket.
 * After the handshake, the browser/client sends WebSocket frames that must
 * be parsed here before we can read JSON-RPC messages from clients.
 *
 * Key RFC 6455 invariants this module relies on:
 *   - Client→server frames MUST be masked (§5.1).  The 4-byte masking key
 *     immediately follows the extended-length field and XORs each payload byte.
 *   - FIN=1 means a complete (unfragmented) message.  We do not support
 *     fragmented messages (continuation frames) — subscription messages are
 *     short and will never be fragmented in practice.
 *   - Opcodes: 0x1 text, 0x2 binary, 0x8 close, 0x9 ping, 0xA pong.
 *
 * Usage:
 *   const decoder = new WsFrameDecoder();
 *   socket.on('data', (chunk) => decoder.feed(chunk));
 *   decoder.on('frame', ({ opcode, payload }) => { ... });
 */

import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WsOpcode = 'text' | 'binary' | 'close' | 'ping' | 'pong' | 'continuation';

export interface WsFrame {
  opcode:  WsOpcode;
  /** Already XOR-unmasked payload bytes. */
  payload: Buffer;
}

// ---------------------------------------------------------------------------
// WsFrameDecoder
// ---------------------------------------------------------------------------

export class WsFrameDecoder extends EventEmitter {
  private _buf: Buffer = Buffer.alloc(0);

  /**
   * Feed raw bytes from the socket into the decoder.
   * Emits 'frame' for each complete frame parsed out of the stream.
   */
  feed(chunk: Buffer): void {
    this._buf = Buffer.concat([this._buf, chunk]);
    this._drain();
  }

  private _drain(): void {
    // Keep parsing frames as long as the buffer has enough bytes for at least a header.
    while (this._buf.length >= 2) {
      const b0 = this._buf[0];
      const b1 = this._buf[1];

      // const _fin = (b0 & 0x80) !== 0; // FIN bit — ignored for now (no fragmentation support)
      const opcodeByte = b0 & 0x0f;
      const masked     = (b1 & 0x80) !== 0;
      let payloadLen   = b1 & 0x7f;
      let headerLen    = 2;

      // Extended length
      if (payloadLen === 126) {
        if (this._buf.length < 4) return; // wait for more data
        payloadLen = this._buf.readUInt16BE(2);
        headerLen  = 4;
      } else if (payloadLen === 127) {
        if (this._buf.length < 10) return;
        // JavaScript can't safely handle 64-bit lengths; read lower 32 bits only.
        // Subscription messages will never exceed 4 GB, so this is safe.
        payloadLen = this._buf.readUInt32BE(6);
        headerLen  = 10;
      }

      // Masking key (4 bytes) follows the length field when MASK bit is set.
      const maskStart    = headerLen;
      const payloadStart = masked ? headerLen + 4 : headerLen;
      const totalLen     = payloadStart + payloadLen;

      if (this._buf.length < totalLen) return; // incomplete frame — wait

      // Extract and unmask payload
      let payload = this._buf.subarray(payloadStart, payloadStart + payloadLen);
      if (masked) {
        const key      = this._buf.subarray(maskStart, maskStart + 4);
        const unmasked = Buffer.allocUnsafe(payloadLen);
        for (let i = 0; i < payloadLen; i++) {
          unmasked[i] = (payload[i] ?? 0) ^ (key[i % 4] ?? 0);
        }
        payload = unmasked;
      } else {
        // Server-to-server or test scenarios without masking — copy to own buffer.
        payload = Buffer.from(payload);
      }

      // Consume the frame from the accumulator buffer.
      this._buf = this._buf.subarray(totalLen);

      const opcode = this._toOpcode(opcodeByte);
      if (opcode !== null) {
        this.emit('frame', { opcode, payload } satisfies WsFrame);
      }
      // Unknown opcodes are silently dropped (reserved extension bits etc.)
    }
  }

  private _toOpcode(byte: number): WsOpcode | null {
    switch (byte) {
      case 0x0: return 'continuation';
      case 0x1: return 'text';
      case 0x2: return 'binary';
      case 0x8: return 'close';
      case 0x9: return 'ping';
      case 0xa: return 'pong';
      default:  return null;
    }
  }
}
