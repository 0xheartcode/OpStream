# Webhooks & Event Subscriptions

OpStream can deliver indexed events to external HTTP endpoints and in-process listeners
via its `SubscriptionManager`. Unlike the WebSocket broadcast (which sends every event
to every client), webhooks support pattern-based filtering: subscribe to a specific
contract or a specific event name. Payload-aware filters (e.g. minimum token amount)
belong in the consumer — OpStream stores raw event bytes and never decodes them.

---

## HTTP Webhooks via Environment Variable

The simplest setup: set `WEBHOOK_URLS` to a comma-separated list of URLs before starting.
Each URL receives every indexed event as an HTTP POST with a JSON body.

```bash
WEBHOOK_URLS=https://my-bot.com/hook npx tsx src/main.ts start

# Multiple endpoints:
WEBHOOK_URLS=https://bot.com/hook,https://dashboard.com/events npx tsx src/main.ts start
```

These are registered as **catch-all** subscriptions — every event from every contract
triggers a POST to each URL.

---

## Programmatic Subscriptions

For fine-grained control, use the `SubscriptionManager` API directly.

```typescript
import { getWebhookManager } from '@opnet-collective/opstream';

const manager = getWebhookManager();

// Catch-all — every event from every contract
const id1 = manager.register({}, 'https://my-app.com/all-events');

// Filter by contract address (case-insensitive)
const id2 = manager.register(
  { contract: 'bc1qmycontract…' },
  'https://my-app.com/my-contract',
);

// Filter by event name
const id3 = manager.register(
  { eventName: 'Swapped' },
  'https://my-app.com/swaps',
);

// Combined filter — AND logic
const id4 = manager.register(
  { contract: 'bc1qpair…', eventName: 'Synced' },
  'https://my-app.com/pair-syncs',
);

// Unregister when done
manager.unregister(id1);
```

---

## In-Process Listeners (EventEmitter)

`SubscriptionManager` extends `EventEmitter`. Subscribe to `'broadcast'` for zero-overhead
in-process delivery — no HTTP round-trip, no network call:

```typescript
import { getWebhookManager } from '@opnet-collective/opstream';
import type { WebhookEvent } from '@opnet-collective/opstream';

const manager = getWebhookManager();

manager.on('broadcast', (event: WebhookEvent) => {
  if (event.eventName !== 'Swapped') return;
  console.log(`Swap on block ${event.blockNumber}: ${event.eventRaw}`);
});
```

This is useful for building tightly-coupled consumers (dashboards, alerting) that run
in the same process as OpStream.

---

## Delivery Guarantees

HTTP delivery is **fire-and-forget with retries**:

| Attempt | Delay before |
|---------|-------------|
| 1st | immediate |
| 2nd | 1 s |
| 3rd | 2 s |
| 4th (final) | 4 s |

After 4 failed attempts, the delivery is dropped and a `'deliveryFailed'` event is emitted
on the manager. No dead-letter queue is maintained — if your endpoint is down for more than
~7 seconds, that event delivery is lost.

Each POST has a 5 s timeout. Your endpoint must respond within 5 s or the attempt counts
as failed and retries begin.

```typescript
// Monitor failed deliveries
manager.on('deliveryFailed', ({ url, event, error, attempts }) => {
  console.error(`Failed to deliver to ${url} after ${attempts} attempts: ${error}`);
});
```

---

## HTTP POST Payload

Identical to the [WebSocket payload](./websocket.md#event-payload) — a JSON-encoded
`WebhookEvent` with all enriched fields:

```http
POST /your-endpoint HTTP/1.1
Content-Type: application/json

{
  "blockNumber": 942381,
  "txHash": "a3f8c1…",
  "contractAddress": "bc1q…",
  "eventName": "Swapped",
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

Your endpoint should return any `2xx` status to acknowledge receipt.
Any non-2xx status triggers the retry sequence.

---

## Pattern Matching Reference

All pattern fields are optional and combined with AND logic:

| Field | Type | Behaviour |
|-------|------|-----------|
| `contract` | `string` | Case-insensitive exact match on `contractAddress` |
| `eventName` | `string` | Exact match on `eventName` |

An empty pattern `{}` matches every event.
