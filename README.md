# OpStream

Pure Layer 2 chain scanner for OPNET.

Scans every block since genesis, stores every event into SQLite, and serves raw data. Knows nothing about what the events mean — that's OpKit's job.

## Architecture

```
Layer 3:  OpKit            Indexer framework — defineSchema, createIndexer, event handlers
Layer 2:  OpStream (this)  Raw data pipeline — scan blocks, store events, push events
Layer 1:  opnet SDK        Client library — talk to one node
Layer 0:  OPNET node
```

OpStream captures everything. OpKit gives it meaning.

## Quick Start

```bash
npm install

# Catch up from genesis, then follow chain tip (recommended)
npx tsx src/main.ts start

# Or run bootstrap and live separately
npx tsx src/main.ts bootstrap   # scan and exit
npx tsx src/main.ts live        # follow tip only
```

## Commands

| Command | Description |
|---------|-------------|
| `start` | Bootstrap + live — catch up to chain tip, then follow it continuously. |
| `bootstrap` | Full scan from `BOOTSTRAP_FROM_BLOCK` to chain tip. Checkpoint-resumable. Exits when done. |
| `live` | Follow chain tip only (assumes already caught up). Includes reorg detection. |
| `db-migration-repair` | Normalize legacy `op1sq` addresses to `0x` hex format. |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPNET_RPC_URL` | `https://mainnet.opnet.org` | OPNET JSON-RPC endpoint |
| `DB_PATH` | `data/opstream.db` | SQLite database file |
| `BOOTSTRAP_FROM_BLOCK` | `941400` | Starting block for bootstrap |
| `BOOTSTRAP_RPS` | `10` | Rate limit (requests per second) |
| `BOOTSTRAP_CHUNK_SIZE` | `500` | Blocks per chunk |
| `WS_PORT` | `0` (disabled) | WebSocket broadcast port. Set to e.g. `8080` to enable. |
| `WEBHOOK_URLS` | (none) | Comma-separated HTTP callback URLs for event notifications |
| `LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARN`, `ERROR` |

## Database

7 tables, all chain-level:

| Table | Purpose |
|-------|---------|
| `events` | Every decoded event from every contract |
| `scan_checkpoints` | Scanner progress (resumable) |
| `tokens` | OP20 token metadata (address, symbol, decimals) |
| `token_deployments` | Contract creation tracking |
| `block_hashes` | Block hash storage for reorg detection |
| `runtime_metrics` | Performance counters |
| `error_log` | Error tracking |

SQLite WAL mode. Single file at `data/opstream.db`.

## Real-Time Event Push

OpStream pushes events to subscribers as they're indexed. Two mechanisms:

### WebSocket

Set `WS_PORT=8080` and connect:

```bash
WS_PORT=8080 npx tsx src/main.ts start
```

```javascript
const ws = new WebSocket('ws://localhost:8080');
ws.onmessage = (msg) => {
  const event = JSON.parse(msg.data);
  console.log(event.eventName, event.contractAddress, event.blockNumber);
};
```

Every indexed event is broadcast as JSON to all connected clients.

### Webhooks

Set `WEBHOOK_URLS` to receive HTTP POST callbacks:

```bash
WEBHOOK_URLS=https://example.com/hook1,https://example.com/hook2 npx tsx src/main.ts start
```

Each matching event triggers a POST with JSON body. 3 retries with exponential backoff.

### Programmatic Subscriptions

```typescript
import { getWebhookManager } from '@opnet-devs/opstream';

const manager = getWebhookManager();

// Subscribe to specific events
manager.register(
  { eventName: 'Swapped', contract: '0xabc...' },
  'https://your-endpoint.com/webhook',
);

// Or listen in-process
manager.on('broadcast', (event) => {
  console.log('New event:', event.eventName);
});
```

## Querying Events

```typescript
import { openDb, queryEvents } from '@opnet-devs/opstream';

const db = openDb('data/opstream.db');

const events = queryEvents(db, {
  contract: '0xabc...',
  eventName: 'Synced',
  fromBlock: 942000,
  toBlock: 943000,
});
```

## How OpKit Consumes OpStream

OpKit's `createIndexer` processes raw events from OpStream through registered handlers into a typed entity store:

```typescript
import { defineSchema, createIndexer } from '@opnet-devs/opkit';
import { openDb, queryEvents } from '@opnet-devs/opstream';

const schema = defineSchema({
  Transfer: {
    from:  { type: 'string' },
    to:    { type: 'string' },
    value: { type: 'bigint' },
  },
});

const indexer = createIndexer({ schema });

indexer.on('Transferred', (event, ctx) => {
  if (!event.decoded) return;
  ctx.store.set('Transfer', event.txHash, {
    from:  event.decoded.from,
    to:    event.decoded.to,
    value: BigInt(event.decoded.value),
  });
});

// Backfill from OpStream
const db = openDb('data/opstream.db');
const events = queryEvents(db, { eventName: 'Transferred' });
// indexer.processEvents(events);
```

OpStream doesn't change when you add a new event type. You add a handler in OpKit.

## Development

```bash
npx vitest run     # tests
npx tsc --noEmit   # type check
npx vitest         # watch mode
```

## Tech Stack

- Node.js 22+ (`node:sqlite` built-in)
- TypeScript ESM (NodeNext)
- SQLite WAL mode
- WebSocket broadcast (built-in, no deps)
- opnet SDK (`JSONRpcProvider`)
- `@opnet-devs/opkit` (event decoding)
