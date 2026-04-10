# OpKit Integration

OpStream is raw infrastructure. It scans the chain, stores everything, and pushes events.
OpKit is the framework that gives those events meaning: define a schema, register handlers,
query derived state.

This document explains the contract between the two — what OpStream provides, what
OpKit expects, and how to wire them together.

---

## The Separation of Concerns

```
OpStream  →  scans blocks, stores raw chain data, pushes WebhookEvent
OpKit     →  reads OpStream data, applies handlers, writes derived opkit_* tables
Your App  →  queries opkit_* tables for business logic
```

OpStream knows nothing about your application's schema. It stores every event from every
contract, raw. OpKit reads that raw data, runs your handlers, and builds the indexed
tables your app actually queries.

Neither package depends on the other at the code level. OpKit reads OpStream's database
(or WebSocket) as a data source — it does not import OpStream's TypeScript.

---

## Event Source Options

OpKit supports three ways to consume OpStream's data, in order of latency:

### Tier 1 — DB Poll (default)

OpKit queries OpStream's `events`, `transactions`, and `blocks` tables directly.
Lowest setup complexity; 10–30 s latency behind chain tip.

```typescript
import { DbEventSource, openSqlite } from '@opnet-devs/opkit';

const source = new DbEventSource(openSqlite('data/opstream.db'));
```

Both packages can share the same SQLite file (OpStream writes, OpKit reads — WAL mode
handles concurrent access cleanly). With Postgres, both connect to the same server.

### Tier 2 — WebSocket (recommended for live apps)

OpKit connects to OpStream's WebSocket broadcast and receives events as they are indexed.
No shared filesystem required. Suitable for running OpStream and OpKit on different hosts.

```typescript
import { createEventSource } from '@opnet-devs/opkit';

const source = createEventSource({
  type: 'ws',
  url: 'ws://opstream-host:8080',
});
```

Start OpStream with `WS_PORT=8080`. See [websocket.md](./websocket.md) for payload details.

### Tier 3 — RPC (fallback / bootstrap)

OpKit fetches directly from the OPNET RPC node. No OpStream needed; slowest by far.
Useful only for testing or when OpStream is not available.

```typescript
import { RpcEventSource } from '@opnet-devs/opkit';

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
} from '@opnet-devs/opkit';

// ── 1. Schema ────────────────────────────────────────────────────────────────
// Define the entities OpKit will index and the fields they carry.

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
// Where OpKit reads raw chain data from.

const source = new DbEventSource(openSqlite('data/opstream.db'));  // Tier 1
// or:
// const source = createEventSource({ type: 'ws', url: 'ws://localhost:8080' }); // Tier 2

// ── 3. Sink ──────────────────────────────────────────────────────────────────
// Where OpKit writes derived, indexed state.
// Can be the same DB as OpStream (opkit_* prefix prevents collisions) or a separate file.

const sink = openSqlite('data/opkit.db');

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

OpStream stores `event_raw` (the raw bytes) and optionally `decoded_json` (ABI-decoded
fields as JSON). `decoded_json` is only populated if a decoder was injected at scan time.

### Injecting a Decoder into OpStream

OpStream's `scanBlockRange` accepts an optional `decode` function via `ScanOptions`.
When provided, it is called for each event and the result is stored in `decoded_json`.

```typescript
import { scanBlockRange } from '@opnet-devs/opstream';
import { decodeEvent } from '@opnet-devs/opkit';

await scanBlockRange(db, client, fromBlock, toBlock, {
  // Inject OpKit's decoder so decoded_json is populated at index time
  decode: (eventType, data) => decodeEvent(eventType, data),
});
```

When running OpStream as a **standalone scanner** (the common case), leave `decode`
unset. `decoded_json` will be `null` in the database. OpKit reads `event_raw` and
decodes it on the fly inside its handlers — this is the recommended pattern because
it keeps the decoder logic in the application layer, not the infrastructure layer.

### Registering Decoders in OpKit

```typescript
import { registerDecoder } from '@opnet-devs/opkit';

// Register a decoder for a specific event type
registerDecoder('Swapped', (data: Buffer) => {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    amountIn:  view.getBigUint64(0).toString(),
    amountOut: view.getBigUint64(8).toString(),
  };
});
```

Once registered, OpKit's `event.decoded` field in handlers will be populated.

---

## What OpKit Reads from OpStream

When using `DbEventSource`, OpKit JOINs OpStream's tables to build the `DecodedEvent`
it passes to your handlers:

| OpKit field | OpStream source |
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
broadcast payload — OpKit maps them without any additional DB query.

---

## Database Layout

OpStream and OpKit can share one database or use separate files:

### Shared SQLite

```
data/
  opstream.db   ← OpStream writes, OpKit reads (source) and writes (opkit_* tables)
```

No collision risk: OpStream uses plain table names (`events`, `transactions`, etc.);
OpKit prefixes all its tables with `opkit_` (`opkit_entities`, `opkit_cursors`, etc.).

### Separate SQLite files

```
data/
  opstream.db   ← OpStream only
  opkit.db      ← OpKit only
```

Configure OpKit's source to point at `opstream.db` and its sink at `opkit.db`.
This is cleaner operationally — you can wipe and rebuild `opkit.db` without touching
the raw chain data in `opstream.db`.

### Postgres

Both packages work with the same Postgres database. OpStream uses `DB_URL`;
OpKit connects via its own `openPostgres(url)` call. Same table prefix rules apply.
