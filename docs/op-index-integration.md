# op-index Integration

OpStream is raw infrastructure. It scans the chain, stores everything, and pushes events.
op-index is the framework that gives those events meaning: define a schema, register handlers,
query derived state.

This document explains the contract between the two — what OpStream provides, what
op-index expects, and how to wire them together.

---

## The Separation of Concerns

```
OpStream  →  scans blocks, stores raw chain data, pushes WebhookEvent
op-index     →  reads OpStream data, applies handlers, writes derived opindex_* tables
Your App  →  queries opindex_* tables for business logic
```

OpStream knows nothing about your application's schema. It stores every event from every
contract, raw. op-index reads that raw data, runs your handlers, and builds the indexed
tables your app actually queries.

Neither package depends on the other at the code level. op-index reads OpStream's database
(or WebSocket) as a data source — it does not import OpStream's TypeScript.

---

## Event Source Options

op-index supports three ways to consume OpStream's data, in order of latency:

### Tier 1 — DB Poll (default)

op-index queries OpStream's `events`, `transactions`, and `blocks` tables directly.
Lowest setup complexity; 10–30 s latency behind chain tip.

```typescript
import { DbEventSource, openSqlite } from '@opnet-collective/op-index';

const source = new DbEventSource(openSqlite('data/opstream.db'));
```

Both packages can share the same SQLite file (OpStream writes, op-index reads — WAL mode
handles concurrent access cleanly). With Postgres, both connect to the same server.

### Tier 2 — WebSocket (recommended for live apps)

op-index connects to OpStream's WebSocket broadcast and receives events as they are indexed.
No shared filesystem required. Suitable for running OpStream and op-index on different hosts.

```typescript
import { createEventSource } from '@opnet-collective/op-index';

const source = createEventSource({
  type: 'ws',
  url: 'ws://opstream-host:8080',
});
```

Start OpStream with `WS_PORT=8080`. See [websocket.md](./websocket.md) for payload details.

### Tier 3 — RPC (fallback / bootstrap)

op-index fetches directly from the OPNET RPC node. No OpStream needed; slowest by far.
Useful only for testing or when OpStream is not available.

```typescript
import { RpcEventSource } from '@opnet-collective/op-index';

const source = new RpcEventSource({ rpcUrl: 'https://mainnet.opnet.org' });
```

---

## Full Setup Example

```typescript
import {
  defineSchema,
  createIndexer,
  DbEventSource,
  openSqlite,
  SqliteAdapter,
} from '@opnet-collective/op-index';

// ── 1. Schema ────────────────────────────────────────────────────────────────
// Define the entities op-index will index and the fields they carry.

const schema = defineSchema({
  Swap: {
    txHash:       { type: 'string' },
    blockNumber:  { type: 'int' },
    blockTime:    { type: 'int' },
    sender:       { type: 'string' },
    amountIn:     { type: 'bigint' },
    amountOut:    { type: 'bigint' },
    gasUsed:      { type: 'bigint' },
    failed:       { type: 'boolean' },
  },
});

// ── 2. Source ────────────────────────────────────────────────────────────────
// Where op-index reads raw chain data from.

const source = new DbEventSource(openSqlite('data/opstream.db'));  // Tier 1
// or:
// const source = createEventSource({ type: 'ws', url: 'ws://localhost:8080' }); // Tier 2

// ── 3. Sink ──────────────────────────────────────────────────────────────────
// Where op-index writes derived, indexed state.
// Can be the same DB as OpStream (opindex_* prefix prevents collisions) or a separate file.

const sink = openSqlite('data/opindex.db');

// ── 4. Indexer ───────────────────────────────────────────────────────────────

const indexer = await createIndexer({ schema, sink, source });

// ── 5. Handlers ──────────────────────────────────────────────────────────────
// Register one handler per event name you care about.
// `event` carries the full enriched WebhookEvent payload.

indexer.on('Swapped', async (event, ctx) => {
  if (!event.decoded) return; // no decoder registered — skip

  await ctx.store.set('Swap', event.txHash, {
    txHash:      event.txHash,
    blockNumber: event.blockNumber,
    blockTime:   event.blockTimestamp,
    sender:      event.fromAddress ?? '',
    amountIn:    BigInt(event.decoded['amountIn'] as string),
    amountOut:   BigInt(event.decoded['amountOut'] as string),
    gasUsed:     BigInt(event.gasUsed ?? '0'),
    failed:      event.failed,
  });
});

// ── 6. Run ───────────────────────────────────────────────────────────────────

// Backfill all history from OpStream's database
await indexer.sync(941400, currentBlock);

// Then subscribe for live updates
const stop = indexer.subscribe(currentBlock + 1);

// To shut down cleanly:
// stop();
```

---

## ABI Decoding

OpStream stores raw event bytes only — `event_raw` is the source of truth and there is
no `decoded_json` column. Decoding happens entirely in op-index, at read time, via the
`DECODER_REGISTRY`. This means:

- **Adding a new decoder is free** — it instantly applies to every historical event in
  the archive without any rewrite of OpStream's database.
- **OpStream is stable** — schema changes for new event types live in op-index, not the
  archival layer.
- **Multiple consumers can decode differently** — each op-index instance owns its own
  registry and is free to interpret the same raw bytes through different ABIs.

### Registering Decoders in op-index

```typescript
import { registerDecoder } from '@opnet-collective/op-index';

// Register a decoder for a specific event type
registerDecoder('Swapped', (data: Buffer) => {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    amountIn:  view.getBigUint64(0).toString(),
    amountOut: view.getBigUint64(8).toString(),
  };
});
```

Once registered, op-index's `event.decoded` field in handlers will be populated.

---

## What op-index Reads from OpStream

When using `DbEventSource`, op-index JOINs OpStream's tables to build the `DecodedEvent`
it passes to your handlers:

| op-index field | OpStream source |
|-------------|----------------|
| `blockNumber` | `events.block_number` |
| `txHash` | `events.tx_hash` |
| `contractAddress` | `events.contract_address` |
| `eventName` | `events.event_name` |
| `logIndex` | `events.log_index` |
| `blockTimestamp` | `blocks.timestamp` |
| `txIndex` | `transactions.tx_index` |
| `fromAddress` | `transactions.from_address` |
| `gasUsed` | `transactions.gas_used` |
| `burnedBitcoin` | `transactions.burned_bitcoin` |
| `failed` | `transactions.failed` |
| `revertReason` | `transactions.revert_reason` |
| `eventRaw` | `events.event_raw` |
| `decoded` | result of registered decoder on `eventRaw` |

When using `WsEventSource` (WebSocket), all of these fields arrive directly in the
broadcast payload — op-index maps them without any additional DB query.

---

## Database Layout

OpStream and op-index can share one database or use separate files:

### Shared SQLite

```
data/
  opstream.db   ← OpStream writes, op-index reads (source) and writes (opindex_* tables)
```

No collision risk: OpStream uses plain table names (`events`, `transactions`, etc.);
op-index prefixes all its tables with `opindex_` (`opindex_entities`, `opindex_cursors`, etc.).

### Separate SQLite files

```
data/
  opstream.db   ← OpStream only
  opindex.db      ← op-index only
```

Configure op-index's source to point at `opstream.db` and its sink at `opindex.db`.
This is cleaner operationally — you can wipe and rebuild `opindex.db` without touching
the raw chain data in `opstream.db`.

### Postgres

Both packages work with the same Postgres database. OpStream uses `DB_URL`;
op-index connects via its own `openPostgres(url)` call. Same table prefix rules apply.
