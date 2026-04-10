# WebSocket Broadcast

OpStream can push every indexed event to connected WebSocket clients in real time —
no polling, no shared database required. This is the foundation for OpKit's Tier-2
`WsEventSource`, and it works for any client that speaks RFC 6455.

---

## Enabling the Server

Set `WS_PORT` to a non-zero port before starting:

```bash
WS_PORT=8080 npx tsx src/main.ts start
# or
WS_PORT=8080 just start
```

The server starts alongside the live indexer. Events are broadcast as they are committed
to the database — after each block's transaction is confirmed, not speculatively.

---

## Connecting

Any RFC 6455 WebSocket client works. The server performs a standard HTTP upgrade handshake
(`Sec-WebSocket-Accept` per the spec) — no custom headers or auth tokens needed.

### Browser

```javascript
const ws = new WebSocket('ws://localhost:8080');

ws.addEventListener('message', (msg) => {
  const event = JSON.parse(msg.data);
  console.log(event.eventName, event.contractAddress, event.blockNumber);
});
```

### Node.js (ws package)

```javascript
import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:8080');

ws.on('message', (data) => {
  const event = JSON.parse(data.toString());
  console.log(event);
});
```

### Node.js (built-in, no deps)

```javascript
import { createConnection } from 'net';
import { createHash } from 'crypto';

// Minimal WS client — useful for debugging
const key = Buffer.from(Math.random().toString()).toString('base64');
const accept = createHash('sha1')
  .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
  .digest('base64');

const socket = createConnection(8080, 'localhost', () => {
  socket.write(
    'GET / HTTP/1.1\r\n' +
    'Host: localhost:8080\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Key: ${key}\r\n` +
    'Sec-WebSocket-Version: 13\r\n\r\n'
  );
});

socket.on('data', (chunk) => {
  // Skip the HTTP 101 header, then parse frames
  const text = chunk.toString();
  if (text.startsWith('HTTP/1.1 101')) return; // handshake response
  // Frame parsing: byte[0]=0x81 (text), byte[1]=len, rest=payload
  const payload = chunk.subarray(2, 2 + chunk[1]);
  console.log(JSON.parse(payload.toString()));
});
```

---

## Event Payload

Every message is a JSON-encoded `WebhookEvent`. All fields are present on every event.

```typescript
interface WebhookEvent {
  // ── Core identity ─────────────────────────────────────────────────────────
  blockNumber:     number;        // block height
  txHash:          string;        // transaction ID
  contractAddress: string;        // contract that emitted the event
  eventName:       string;        // e.g. "Swapped", "Transfer", "Synced"
  decodedJson:     string | null; // ABI-decoded fields as JSON, or null

  // ── Position within the block ─────────────────────────────────────────────
  logIndex:        number;        // event's position within its transaction (0-based)
  txIndex:         number;        // transaction's position within the block (0-based)
  blockTimestamp:  number;        // unix timestamp of the block

  // ── Transaction context ───────────────────────────────────────────────────
  fromAddress:     string | null; // address that submitted the transaction
  gasUsed:         string | null; // gas consumed, as a decimal string (satoshi units)
  burnedBitcoin:   string | null; // BTC burned as fee, as a decimal string (satoshi units)
  failed:          boolean;       // true if the transaction reverted
  revertReason:    string | null; // revert message, or null if not reverted

  // ── Raw bytes ─────────────────────────────────────────────────────────────
  eventRaw:        string;        // raw event bytes, hex-encoded, e.g. "0x1a2b3c…"
}
```

`gasUsed` and `burnedBitcoin` are serialised as decimal strings (not numbers) because they
are `bigint` values on-chain and JSON has no native 64-bit integer type.

### Example message

```json
{
  "blockNumber": 942381,
  "txHash": "a3f8c1…",
  "contractAddress": "bc1q…",
  "eventName": "Swapped",
  "decodedJson": "{\"amountIn\":\"500000\",\"amountOut\":\"48231\"}",
  "logIndex": 0,
  "txIndex": 3,
  "blockTimestamp": 1718400123,
  "fromAddress": "bc1qsender…",
  "gasUsed": "12000",
  "burnedBitcoin": "800",
  "failed": false,
  "revertReason": null,
  "eventRaw": "0x0007a120000000000000bc07"
}
```

---

## Filtering Client-Side

The server broadcasts every event to every connected client — there is no server-side
subscription filter on the WebSocket channel. Filter in your client handler:

```javascript
ws.addEventListener('message', (msg) => {
  const event = JSON.parse(msg.data);

  // Only process events from a specific contract
  if (event.contractAddress !== MY_CONTRACT) return;

  // Only process specific event types
  if (event.eventName !== 'Swapped') return;

  // Skip reverted transactions
  if (event.failed) return;

  handle(event);
});
```

If you need server-side filtering, use [webhooks](./webhooks.md) with a pattern subscription instead.

---

## Multiple Clients

Any number of clients can connect simultaneously. The server writes each broadcast to
every connected socket. Dead sockets (write throws) are evicted automatically on the
next dispatch — no memory leak.

---

## OpKit Integration

OpKit's `WsEventSource` (Tier-2 event source) connects to this WebSocket and feeds
events into OpKit handlers without requiring shared filesystem access or database polling.
To use it, point OpKit at OpStream's WS address:

```typescript
import { createEventSource } from '@opnet-devs/opkit';

const source = createEventSource({
  type: 'ws',
  url: 'ws://opstream-host:8080',
});

const indexer = await createIndexer({ schema, sink, source });
await indexer.subscribe(fromBlock);
```

See [opkit-integration.md](./opkit-integration.md) for the full OpKit setup guide.
