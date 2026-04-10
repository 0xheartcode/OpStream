# OpStream

[![CI](https://github.com/opnet-devs/opstream/actions/workflows/ci.yml/badge.svg)](https://github.com/opnet-devs/opstream/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Pure Layer 2 chain scanner for OPNET.

## The Problem

**OPNET has no `getLogs`.**

On Ethereum you can call `eth_getLogs` and get all events for a contract across any block range in one request. On OPNET — a Bitcoin Layer 2 — that API does not exist. To find any historical contract event you must fetch every block, walk every transaction, and decode every event payload manually. Every time. On every app restart. For every query.

OpStream solves this by doing that scan once, storing everything in SQLite, and giving you instant SQL queries over the full event history.

```typescript
// Without OpStream — O(N) RPC calls, every time:
for (let block = fromBlock; block <= toBlock; block++) {
  const b = await rpc.getBlock(block);          // one RPC call per block
  for (const tx of b.transactions) {            // walk every tx
    for (const [addr, events] of tx.events) {   // decode every event
      if (addr === myContract) use(events);
    }
  }
}

// With OpStream — one SQL query, sub-millisecond:
const events = queryEvents(db, { contract: myContract, eventName: 'Swapped' });
```

## Architecture

```
Layer 4:  Apps           (your-app, OpScope)
Layer 3:  OpKit          Indexer framework — defineSchema, createIndexer, event handlers
Layer 2:  OpStream       Raw data pipeline — scan blocks, store chain data, push events
Layer 1:  opnet SDK      RPC client — talk to one node
Layer 0:  OPNET node
```

OpStream is the [Subsquid Archive](https://github.com/subsquid/squid-sdk) of OPNET: a self-hosted data layer that scans once so every consumer queries instantly. OpKit is the handler framework (equivalent to Subsquid's SDK or Ponder's handler layer) that gives the raw data meaning.

## Quick Start

```bash
npm install

# Catch up from genesis, then follow chain tip (recommended)
npx tsx src/main.ts start

# Or run separately
npx tsx src/main.ts bootstrap   # scan to chain tip and exit
npx tsx src/main.ts live        # follow tip only (assumes caught up)
```

## Status — What Works

This section records what has been proven to work, what is code-complete, and what is
explicitly out of scope. Updated as the system is tested and evolved.

### Unit-tested and verified

Run with `npx vitest run` (58 tests across 3 suites):

| Suite | Feature | Coverage |
|-------|---------|----------|
| `eventStore` | `insertEvent` | insert + read-back, null `decoded_json`, duplicate silently ignored |
| `eventStore` | `insertEventsBatch` | multi-event, empty array, within-batch dedup, `decoded_json` roundtrip |
| `eventStore` | `queryEvents` | all-events, by contract, by name, by block range, combined filters, empty result, ordering |
| `eventStore` | `backfillDecoded` | decodes + updates, skips already-decoded, null decoder, scoped to contract+event |
| `webhooks` | `dispatch()` → broadcast | all enriched fields delivered via EventEmitter |
| `webhooks` | `dispatch()` → WebSocket | valid RFC 6455 frame, all fields present in parsed JSON |
| `webhooks` | `matchesPattern()` | contract, eventName, minAmount, combined, no regression from enriched fields |
| `webhooks` | HTTP delivery + retry | POST body contains enriched fields; 4-attempt retry sequence |
| `webhooks` | Server lifecycle | idempotent start, client eviction on write error, stop cleans up |
| `scanner` | `onEvent` enrichment | logIndex, blockTimestamp, txIndex, fromAddress, gasUsed, burnedBitcoin, failed, revertReason, eventRaw |
| `scanner` | logIndex sequencing | global counter per tx across all contracts |
| `scanner` | DB side-effects | events, transactions, blocks tables written correctly; idempotent re-scan |
| `scanner` | `ScanResult` | eventsStored, blocksScanned, null block handling |

### Code-complete and proven working end-to-end

These have been run against mainnet and produce correct output:

**Bootstrap scanner** (`just bootstrap` / `npx tsx src/main.ts bootstrap`)
- Scans blocks in configurable chunks (default 500), checkpoint-resumable across restarts
- Two-line TTY progress display (`Overall` / `Chunk` bars with ETA) — degrades to `log()` when not a TTY
- Rate limiting via `BOOTSTRAP_RPS` (default 10 req/s)
- Single SQLite transaction per block — all-or-nothing write; skips block on failure with `WARN` log
- Saves `scan_checkpoints` every chunk end so a crash loses at most one chunk
- Detects and stores: blocks, transactions, tx_outputs, events (raw + decoded), token deployments

**Live indexer** (`just live` / `npx tsx src/main.ts live`)
- Polls `getBlockNumber()` every 30 s, scans `[checkpoint+1, chainTip]` each cycle
- Reorg detection: checks stored block hashes up to 10 blocks deep — rolls back and re-scans from fork point automatically
- Emits per-event callbacks (used for WebSocket/webhook dispatch)
- Returns a `LiveIndexerHandle` with `.stop()` and `.health()`

**SQLite backend** (`src/core/db.ts` + `src/core/sqliteAdapter.ts`)
- WAL mode, `busy_timeout = 5000`, `foreign_keys = ON`
- Schema applied idempotently on every open (safe to re-run)
- Migrations: `alt_address` on `tokens`, `log_index` on `events`, `transactions`, `tx_outputs`, `blocks` — applied automatically on existing DBs
- Singleton pattern (`openDb()` returns the same adapter instance)

**OpnetRpcClient** (`src/rpc/opnetRpc.ts`)
- `getBlock(n)` — 5 s timeout via `Promise.race`, returns `null` on timeout
- Exponential backoff on consecutive failures: 1 s → 2 s → 4 s
- Circuit breaker: after 3 consecutive failures, `getBlock()` returns `null` immediately; resets on next success
- `getBlockNumber()` — same 5 s timeout
- `getLogs(filter)` — scan-based polyfill (OPNET has no native `eth_getLogs`)
- `scanForTransactions()` — preserves full cross-contract event context per tx
- `call(address, calldata)` — simulates contract reads, returns raw bytes or `null` on revert
- `getCode(address)` — returns `true` if a contract is deployed at the address

**Transaction indexing** (`src/indexer/scanner.ts`)
- Every `interaction` tx stores: `calldata` (BLOB), `calldata_length`, `senderPubKeyHash`
- Every tx stores: `gasUsed`, `specialGasUsed`, `burnedBitcoin`, `priorityFee`, `maxGasSat`, `failed`, `revertReason`
- `tx_outputs` captured for every tx (UTXO index, value in satoshis, script type, recipient address)
- `token_deployments` captured for every `deployment` tx (deployer address, bytecode SHA-256 hash prefix)

**SubscriptionManager / webhooks** (`src/indexer/webhooks.ts`)
- Pattern matching: `contract` (case-insensitive), `eventName`, `minAmount` (from `decoded_json`)
- HTTP POST delivery with 3 retries, exponential backoff (1 s → 2 s → 4 s), 5 s per-request timeout
- `WEBHOOK_URLS` env var auto-registers comma-separated URLs as catch-all subscriptions on startup
- Emits `'broadcast'` EventEmitter event for in-process consumers

**WebSocket broadcast server** (`webhooks.ts` — `startBroadcastServer(port)`)
- Minimal Node.js HTTP server, no extra deps
- RFC 6455 handshake (`SHA-1 Sec-WebSocket-Accept`)
- Correct frame encoding for text payloads (handles short, 16-bit, and 64-bit length)
- Enabled by setting `WS_PORT` env var (disabled when `WS_PORT=0`)

**Postgres backend** (`src/core/postgresAdapter.ts`)
- Full `DbAdapter` implementation — `run`, `get`, `all`, `exec`, `transaction`, `close`
- `?` placeholders auto-converted to `$1, $2, ...` (SQLite compatibility shim)
- Schema applied idempotently on `openPostgresDb()`
- `postgres.begin()` for transactions — correctly scopes nested `txSql`
- Enabled by setting `DB_URL=postgres://user:pass@host:5432/dbname`

**Logger** (`src/core/logger.ts`)
- WARN/ERROR rows persisted to `error_log` — synchronously in SQLite mode, async write-behind queue in Postgres mode
- `pruneErrorLog` and `queryRecentErrors` for maintenance

**poolReaderSdk** (`src/readers/poolReaderSdk.ts`) — code complete, not unit-tested
- `readTokenMetadata` — name, symbol, decimals via OP-20 ABI
- `readMotoswapReserves` — `reserve0`, `reserve1` from a Motoswap pair
- `readMotoswapPairTokens` — `token0`, `token1` from a pair contract
- `readMotoswapPairAddress` — look up pair from Motoswap factory for two tokens
- `resolveTokenHexAddress` — normalize `op1sq` bech32m → `0x` 32-byte hex via `getPublicKeysInfoRaw`
- `readNativeSwapReserves` — `btcReserve`, `tokenReserve` from the NativeSwap factory

### Known limitations

- **No native `getLogs` on OPNET** — `getLogs()` is a scan-based polyfill. Always prefer querying the local SQLite DB at runtime.
- **Reorg detection is 10-block max** — deeper reorgs trigger a `WARN` and roll back 10 blocks. Has not occurred on OPNET mainnet in practice.
- **Checkpoint granularity** — saved once per chunk (default 500 blocks). A crash mid-chunk re-scans the whole chunk. `ON CONFLICT DO NOTHING` makes re-scanning idempotent.
- **Single-process only** — `openDb()` is a singleton. Two processes against the same SQLite file will conflict on writes.

### Not part of OpStream (moved to `src/_pending_extraction/`)

These files exist for reference but **must not be imported** — they belong in OpKit (Layer 3):

| File | What it is | Where it belongs |
|------|------------|-----------------|
| `candles.ts` | OHLCV candle aggregation from reserve snapshots | OpKit handler |
| `snapshots.ts` | Reserve snapshot storage + implied price math | OpKit handler |
| `poolReader.ts` | Raw BinaryWriter/BinaryReader ABI encoding | OpKit reader layer |
| `candles.test.ts` | Tests for the above (depend on removed `reserve_snapshots` table) | OpKit tests |

Pool discovery logic (`processNativeSwapPools`, `processMotoswapPools`, etc.) was removed from
`bootstrap.ts` in the Layer 2 cleanup and will be reimplemented as OpKit event handlers.

## Commands

| Command | Description |
|---------|-------------|
| `start` | Bootstrap + live — catch up to chain tip, then follow it continuously |
| `bootstrap` | Full scan from `BOOTSTRAP_FROM_BLOCK` to chain tip. Checkpoint-resumable. Exits when done. |
| `live` | Follow chain tip only (assumes already caught up). Includes reorg detection. |

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

## Data Model

9 tables, all chain-level:

| Table | Purpose |
|-------|---------|
| `blocks` | Block metadata — hash, timestamp, tx count |
| `transactions` | Every tx — sender, gas, fees, calldata, revert status |
| `tx_outputs` | Bitcoin UTXO outputs per tx — value flows in satoshis |
| `events` | Every decoded event from every contract |
| `scan_checkpoints` | Scanner progress (resumable) |
| `token_deployments` | Contract creation tracking |
| `tokens` | OP20 metadata cache — written by OpKit, not OpStream |
| `runtime_metrics` | Performance counters |
| `error_log` | Error tracking |

### What the `transactions` table captures

Every transaction exposes these fields via the OPNET SDK — OpStream stores all of them:

| Column | Description |
|--------|-------------|
| `tx_hash` | Transaction ID |
| `block_number` | Block height |
| `tx_index` | Position within block |
| `tx_type` | `interaction` \| `deployment` \| `generic` |
| `from_address` | Sender address |
| `contract_address` | Target contract |
| `gas_used` | Gas consumed |
| `special_gas_used` | OPNET-specific gas |
| `burned_bitcoin` | BTC burned as gas fee |
| `priority_fee` | Priority fee |
| `max_gas_sat` | Max gas in satoshis |
| `failed` | `1` if tx reverted |
| `revert_reason` | Revert message if failed |
| `calldata` | Raw bytes sent to the contract (interaction txs only) |
| `calldata_length` | Byte count — check before fetching the BLOB |
| `sender_pub_key_hash` | Bitcoin-native sender identity (hex) |

### What the `tx_outputs` table captures

Bitcoin UTXO outputs for every transaction. No other OPNET tool captures this.
Enables BTC value flow analysis alongside contract interactions — critical for MEV analysis.

| Column | Description |
|--------|-------------|
| `tx_hash` | Parent transaction |
| `output_index` | UTXO index |
| `value_sat` | Value in satoshis |
| `script_type` | e.g. `p2wpkh`, `p2pkh`, `p2sh` |
| `address` | Recipient Bitcoin address |

SQLite WAL mode. Single file at `data/opstream.db`.

## Querying

```typescript
import { openDb, queryEvents } from '@opnet-devs/opstream';

const db = openDb('data/opstream.db');

// All Swapped events from a contract in a block range
const events = queryEvents(db, {
  contract: '0xabc...',
  eventName: 'Swapped',
  fromBlock: 942000,
  toBlock: 943000,
});

// All transactions sent by an address (direct SQL)
const txs = db.prepare(
  `SELECT * FROM transactions WHERE from_address = ? ORDER BY block_number DESC LIMIT 50`
).all('0xabc...');

// All contracts deployed by an address
const deploys = db.prepare(
  `SELECT * FROM token_deployments WHERE deployer = ? ORDER BY block_number ASC`
).all('0xabc...');

// Failed transactions in the last 100 blocks
const failed = db.prepare(
  `SELECT * FROM transactions WHERE failed = 1 AND block_number > ? ORDER BY block_number DESC`
).all(currentBlock - 100);
```

## Real-Time Event Push

OpStream pushes events to subscribers as they're indexed.

### WebSocket

```bash
WS_PORT=8080 npx tsx src/main.ts start
```

```javascript
const ws = new WebSocket('ws://localhost:8080');
ws.onmessage = (msg) => {
  const event = JSON.parse(msg.data);
  // event carries: blockNumber, txHash, contractAddress, eventName, decodedJson,
  // logIndex, txIndex, blockTimestamp, fromAddress, gasUsed, burnedBitcoin,
  // failed, revertReason, eventRaw
  console.log(event.eventName, event.contractAddress, event.blockNumber);
};
```

See [docs/websocket.md](./docs/websocket.md) for the full payload schema and client examples.

### Webhooks

```bash
WEBHOOK_URLS=https://example.com/hook npx tsx src/main.ts start
```

Each indexed event triggers a POST with JSON body. 3 retries with exponential backoff.

### Programmatic

```typescript
import { getWebhookManager } from '@opnet-devs/opstream';

const manager = getWebhookManager();

manager.register(
  { eventName: 'Swapped', contract: '0xabc...' },
  'https://your-endpoint.com/webhook',
);

manager.on('broadcast', (event) => {
  console.log('New event:', event.eventName);
});
```

## How OpKit Consumes OpStream

OpKit reads directly from OpStream's database (source) and writes derived, indexed state into
its own tables (sink). The two databases can be separate SQLite files or the same Postgres
database — OpKit's `opkit_*` table prefix prevents collisions either way.

```typescript
import { defineSchema, createIndexer, DbEventSource, openSqlite } from '@opnet-devs/opkit';

const schema = defineSchema({
  Transfer: {
    from:  { type: 'string' },
    to:    { type: 'string' },
    value: { type: 'bigint' },
    block: { type: 'int' },
  },
});

// source — reads from OpStream's events/transactions/blocks tables (read-only)
// sink   — OpKit's own database for derived opkit_* tables
const source = new DbEventSource(openSqlite('data/opstream.db'));
const sink   = openSqlite('data/opkit.db');

const indexer = await createIndexer({ schema, sink, source });

indexer.on('Transferred', async (event, ctx) => {
  if (!event.decoded) return;
  await ctx.store.set('Transfer', event.txHash, {
    from:  event.decoded['from'] as string,
    to:    event.decoded['to'] as string,
    value: BigInt(event.decoded['value'] as string),
    block: event.blockNumber,
    // event.fromAddress, event.gasUsed, event.failed, event.blockTimestamp
    // are all available — populated by the JOIN OpKit runs against OpStream's tables
  });
});

// Backfill all historical blocks
await indexer.sync(941400, currentBlock);

// Then go live — polls OpStream DB every 10s for new events
const stop = indexer.subscribe(currentBlock + 1);
```

OpStream doesn't change when you add a new event type or entity. You add a handler in OpKit.
OpStream's raw tables are the stable foundation; OpKit's derived tables are what your app queries.

## Development

```bash
npx vitest run     # run tests (58 tests)
npx vitest         # watch mode
npx tsc --noEmit   # type check
npx eslint src tests  # lint

just check         # typecheck + lint + test in one shot
```

## Docs

| Guide | What it covers |
|-------|---------------|
| [docs/configuration.md](./docs/configuration.md) | All environment variables, `.env` setup, Postgres, Docker |
| [docs/websocket.md](./docs/websocket.md) | WS client setup, full enriched payload schema, multi-client |
| [docs/webhooks.md](./docs/webhooks.md) | HTTP delivery, programmatic subscriptions, pattern matching, retry |
| [docs/querying.md](./docs/querying.md) | SQL patterns, full schema reference, compound query examples |
| [docs/opkit-integration.md](./docs/opkit-integration.md) | Tier 1/2/3 event sources, ABI decoder injection, DB layout |

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup instructions, coding standards, and PR expectations.
All PRs must pass CI (typecheck + lint + tests) before merge.

## License

[MIT](./LICENSE)

## Tech Stack

- Node.js 22+ (`node:sqlite` built-in)
- TypeScript ESM (NodeNext)
- SQLite WAL mode / Postgres
- WebSocket broadcast (no extra deps — pure `node:http` + `node:stream`)
- opnet SDK (`JSONRpcProvider`)
