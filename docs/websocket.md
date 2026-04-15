# WebSocket API

OpStream's WebSocket server has two operating modes on the same connection:

- **Subscribed mode** — send `opstream_subscribe` on connect; the server pushes only events
  that match your filter. This is the recommended mode for bots, dashboards, and op-index.
- **Broadcast mode** (legacy) — connect without subscribing; every indexed event is pushed to
  you unfiltered. Old clients continue to work unchanged.

The server performs a standard RFC 6455 HTTP upgrade — no custom headers or auth tokens needed.

---

## Endpoints

| Network | URL |
|---|---|
| Testnet | `wss://opstream-testnet-production.up.railway.app` |
| Mainnet | `wss://opstream-mainnet-production.up.railway.app` |
| Local | `ws://localhost:8080` (set `WS_PORT=8080`) |

---

## Enabling the Server (self-hosted)

```bash
WS_PORT=8080 npx tsx src/main.ts start
# or
WS_PORT=8080 just start
```

---

## Subscription Protocol

All messages are JSON-RPC 2.0 frames. Client → server frames must be masked (RFC 6455);
server → client frames are unmasked. Standard WS client libraries handle this automatically.

### Subscribe

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "opstream_subscribe",
  "params": ["<kind>", <filter>]
}
```

**Response:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": "0xa1b2c3d4e5f6g7h8"
}
```

The `result` is the subscription ID. Save it — you need it to unsubscribe.

### Unsubscribe

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "opstream_unsubscribe",
  "params": ["0xa1b2c3d4e5f6g7h8"]
}
```

**Response:**

```json
{"jsonrpc":"2.0","id":2,"result":true}
```

When the last subscription on a connection is removed the server reverts the connection
to broadcast mode.

### Notifications

Every matched event is pushed as:

```json
{
  "jsonrpc": "2.0",
  "method": "opstream_subscription",
  "params": {
    "subscription": "0xa1b2c3d4e5f6g7h8",
    "result": { ...event... }
  }
}
```

---

## Subscription Types

### `logs` — Filtered Contract Events

Receives confirmed on-chain events matching the filter. Mempool events (`blockNumber: -1`)
are excluded — use `txStatus` for those.

**Filter fields** (all optional, AND-combined):

| Field | Type | Description |
|---|---|---|
| `address` | `string` | Only events from this contract address |
| `eventNames` | `string[]` | Only events with these names |

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "opstream_subscribe",
  "params": ["logs", {
    "address": "op1sq…",
    "eventNames": ["Swapped", "Synced"]
  }]
}
```

**No filter** — receive every confirmed event from every contract:

```json
{"jsonrpc":"2.0","id":1,"method":"opstream_subscribe","params":["logs",{}]}
```

**Notification example:**

```json
{
  "jsonrpc": "2.0",
  "method": "opstream_subscription",
  "params": {
    "subscription": "0xa1b2c3d4e5f6g7h8",
    "result": {
      "blockNumber": 14370,
      "txHash": "a3f8c1…",
      "contractAddress": "op1sq…",
      "eventName": "Swapped",
      "logIndex": 0,
      "txIndex": 2,
      "blockTimestamp": 1776248919,
      "fromAddress": "bc1qsender…",
      "gasUsed": "12000",
      "burnedBitcoin": "800",
      "failed": false,
      "revertReason": null,
      "eventRaw": "0x0007a120000000000000bc07"
    }
  }
}
```

---

### `newBlocks` — Block Headers

Receives one notification per confirmed block. No filter object needed.

```json
{"jsonrpc":"2.0","id":1,"method":"opstream_subscribe","params":["newBlocks",{}]}
```

**Notification example:**

```json
{
  "jsonrpc": "2.0",
  "method": "opstream_subscription",
  "params": {
    "subscription": "0xa1b2c3d4e5f6g7h8",
    "result": {
      "blockNumber": 14371,
      "txHash": "",
      "contractAddress": "",
      "eventName": "NewBlock",
      "blockTimestamp": 1776249500,
      "failed": false
    }
  }
}
```

---

### `txStatus` — Mempool Transaction Lifecycle

Tracks a specific transaction from submission through confirmation or eviction.
Pushes `MempoolPending` when the tx appears in the mempool, then either
`MempoolConfirmed` when it lands in a block, or `MempoolDropped` when it is
evicted without confirming.

**Filter:** `{ txid: string }` — required.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "opstream_subscribe",
  "params": ["txStatus", { "txid": "a3f8c1…" }]
}
```

**Notification sequence:**

1. **MempoolPending** — tx first seen in mempool:

```json
{
  "jsonrpc": "2.0",
  "method": "opstream_subscription",
  "params": {
    "subscription": "0xa1b2c3d4e5f6g7h8",
    "result": {
      "blockNumber": -1,
      "txHash": "a3f8c1…",
      "contractAddress": "",
      "eventName": "MempoolPending",
      "failed": false
    }
  }
}
```

2a. **MempoolConfirmed** — tx included in a block:

```json
{
  "jsonrpc": "2.0",
  "method": "opstream_subscription",
  "params": {
    "subscription": "0xa1b2c3d4e5f6g7h8",
    "result": {
      "blockNumber": 14370,
      "txHash": "a3f8c1…",
      "contractAddress": "op1sq…",
      "eventName": "MempoolConfirmed",
      "failed": false
    }
  }
}
```

2b. **MempoolDropped** — tx evicted from mempool without confirming:

```json
{
  "jsonrpc": "2.0",
  "method": "opstream_subscription",
  "params": {
    "subscription": "0xa1b2c3d4e5f6g7h8",
    "result": {
      "blockNumber": -1,
      "txHash": "a3f8c1…",
      "contractAddress": "",
      "eventName": "MempoolDropped",
      "failed": false
    }
  }
}
```

> **HTTP alternative:** If you don't want to maintain a WebSocket connection (scripts,
> serverless functions, CLI), use `opstream_getTransactionStatus` over HTTP instead.
> See [rpc.md](./rpc.md#opstream_gettransactionstatus).

---

## Full Event Payload Shape

All events pushed over WebSocket share the same shape:

```typescript
interface WebhookEvent {
  blockNumber:     number;        // block height; -1 for mempool events
  txHash:          string;        // transaction ID
  contractAddress: string;        // contract that emitted the event
  eventName:       string;        // e.g. "Swapped", "MempoolPending", "NewBlock"
  logIndex?:       number;        // position within tx (0-based); absent for synthetic events
  txIndex?:        number;        // transaction's position in the block
  blockTimestamp?: number;        // unix seconds; absent for mempool events
  fromAddress?:    string | null; // sender address
  gasUsed?:        string | null; // gas consumed (decimal string, satoshi units)
  burnedBitcoin?:  string | null; // BTC fee burned (decimal string, satoshi units)
  failed:          boolean;       // true if the transaction reverted
  revertReason?:   string | null; // revert message (null if not reverted)
  eventRaw?:       string;        // raw event bytes, hex-encoded; absent for synthetic events
}
```

`gasUsed` and `burnedBitcoin` are decimal strings — on-chain values are `bigint` and JSON
has no native 64-bit integer type. OpStream pushes raw event bytes in `eventRaw`; decoding
into structured fields is the consumer's job (op-index applies its decoder registry at read time).

---

## Client Examples

### Node.js — subscribe and filter

```javascript
import WebSocket from 'ws';

const ws = new WebSocket('wss://opstream-testnet-production.up.railway.app');
let subId = null;

ws.on('open', () => {
  // Subscribe to Swapped events from a specific contract
  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'opstream_subscribe',
    params: ['logs', {
      address: 'op1sq…',
      eventNames: ['Swapped'],
    }],
  }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());

  // Handle subscribe response
  if (msg.id === 1 && msg.result) {
    subId = msg.result;
    console.log('subscribed:', subId);
    return;
  }

  // Handle pushed notifications
  if (msg.method === 'opstream_subscription') {
    const event = msg.params.result;
    console.log(event.eventName, event.blockNumber, event.txHash);
  }
});

ws.on('close', () => console.log('disconnected'));
ws.on('error', (err) => console.error('ws error', err));
```

### Node.js — track a tx from broadcast to confirm

```javascript
import WebSocket from 'ws';

const TXID = 'a3f8c1…'; // your submitted txid

const ws = new WebSocket('wss://opstream-testnet-production.up.railway.app');

ws.on('open', () => {
  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'opstream_subscribe',
    params: ['txStatus', { txid: TXID }],
  }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.method !== 'opstream_subscription') return;

  const { eventName, blockNumber } = msg.params.result;

  if (eventName === 'MempoolPending') {
    console.log('tx is in the mempool');
  } else if (eventName === 'MempoolConfirmed') {
    console.log(`confirmed in block ${blockNumber}`);
    ws.close();
  } else if (eventName === 'MempoolDropped') {
    console.log('tx was dropped — resubmit?');
    ws.close();
  }
});
```

### Node.js — subscribe to new blocks

```javascript
import WebSocket from 'ws';

const ws = new WebSocket('wss://opstream-testnet-production.up.railway.app');

ws.on('open', () => {
  ws.send(JSON.stringify({
    jsonrpc: '2.0', id: 1,
    method: 'opstream_subscribe',
    params: ['newBlocks', {}],
  }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.method === 'opstream_subscription') {
    const { blockNumber, blockTimestamp } = msg.params.result;
    console.log(`block ${blockNumber} at ${new Date(blockTimestamp * 1000).toISOString()}`);
  }
});
```

### Browser

```javascript
const ws = new WebSocket('wss://opstream-testnet-production.up.railway.app');

ws.addEventListener('open', () => {
  ws.send(JSON.stringify({
    jsonrpc: '2.0', id: 1,
    method: 'opstream_subscribe',
    params: ['logs', { address: 'op1sq…', eventNames: ['Swapped'] }],
  }));
});

ws.addEventListener('message', ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.method === 'opstream_subscription') {
    const event = msg.params.result;
    // update UI
  }
});
```

---

## Broadcast Mode (Legacy)

Connections that never send `opstream_subscribe` receive every indexed event — same payload
shape, no JSON-RPC wrapper, raw object per message:

```json
{
  "blockNumber": 14370,
  "txHash": "a3f8c1…",
  "contractAddress": "op1sq…",
  "eventName": "Swapped",
  "logIndex": 0,
  "txIndex": 2,
  "blockTimestamp": 1776248919,
  "fromAddress": "bc1qsender…",
  "gasUsed": "12000",
  "burnedBitcoin": "800",
  "failed": false,
  "revertReason": null,
  "eventRaw": "0x0007a120000000000000bc07"
}
```

This is the mode op-index's `WsEventSource` used before 0.1.3 — it still works on all
server versions. New code should use the subscription protocol instead.

---

## op-index Integration

op-index's `WsEventSource` (Tier-2 event source) sends `opstream_subscribe("logs", filter)`
on connect and handles all three message paths transparently — subscribed notifications,
JSON-RPC acks, and legacy broadcast frames — so it works against any server version.

```typescript
import { createEventSource } from '@opnet-collective/op-index';

const source = createEventSource({
  ws: 'wss://opstream-testnet-production.up.railway.app',
});

const indexer = await createIndexer({ schema, sink, source });
await indexer.subscribe(fromBlock);
```

See [op-index-integration.md](./op-index-integration.md) for the full setup guide.
