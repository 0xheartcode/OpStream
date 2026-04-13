# OpStream

[![CI](https://github.com/opnet-collective/opstream/actions/workflows/ci.yml/badge.svg)](https://github.com/opnet-collective/opstream/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Self-hosted archival node for OPNET.

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
Layer 3:  Apps           (your-app, OpScope)
Layer 2:  op-index          Indexer framework — defineSchema, createIndexer, event handlers
Layer 1:  OpStream       Self-hosted archival node — scans once, serves btc_* locally, raw event store
Layer 0:  OPNET node     Live chain
```

OpStream is the [Subsquid Archive](https://github.com/subsquid/squid-sdk) of OPNET: a self-hosted archival node that scans once so every consumer queries instantly. It stores raw event bytes and never decodes them — decoding belongs in op-index (Layer 2), where each consumer plugs in its own ABI registry.

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

Run with `npx vitest run` (148 tests across 8 suites):

| Suite | Feature | Coverage |
|-------|---------|----------|
| `eventStore` | `insertEvent` | insert + read-back, raw bytes preserved, duplicate silently ignored |
| `eventStore` | `insertEventsBatch` | multi-event, empty array, within-batch dedup |
| `eventStore` | `queryEvents` | all-events, by contract, by name, by block range, combined filters, empty result, ordering |
| `webhooks` | `dispatch()` → broadcast | all enriched fields delivered via EventEmitter |
| `webhooks` | `dispatch()` → WebSocket | valid RFC 6455 frame, all fields present in parsed JSON |
| `webhooks` | `matchesPattern()` | contract, eventName, combined, no regression from enriched fields |
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
- Detects and stores: blocks, transactions, tx_outputs, raw event bytes, contract deployments

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
- `contract_deployments` captured for every `deployment` tx (deployer address, bytecode SHA-256 hash prefix)

**SubscriptionManager / webhooks** (`src/indexer/webhooks.ts`)
- Pattern matching: `contract` (case-insensitive), `eventName`. Payload-aware filters (e.g. minimum amount) belong in the consumer (op-index handlers) since OpStream stores raw bytes only.
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
- **SQLite write contention** — `openDb()` is a singleton per process. Two processes (e.g., `indexer` + `mempool` mode) can share the same SQLite file via WAL mode, but high-write scenarios should use Postgres (`DB_URL`).

### Not part of OpStream (moved to `src/_pending_extraction/`)

These files exist for reference but **must not be imported** — they belong in op-index (Layer 3):

| File | What it is | Where it belongs |
|------|------------|-----------------|
| `candles.ts` | OHLCV candle aggregation from reserve snapshots | op-index handler |
| `snapshots.ts` | Reserve snapshot storage + implied price math | op-index handler |
| `poolReader.ts` | Raw BinaryWriter/BinaryReader ABI encoding | op-index reader layer |
| `candles.test.ts` | Tests for the above (depend on removed `reserve_snapshots` table) | op-index tests |

Pool discovery logic (`processNativeSwapPools`, `processMotoswapPools`, etc.) was removed from
`bootstrap.ts` in the Layer 2 cleanup and will be reimplemented as op-index event handlers.

## Commands

| Command | Description |
|---------|-------------|
| `start` | Bootstrap + live — catch up to chain tip, then follow it continuously |
| `bootstrap` | Full scan from `BOOTSTRAP_FROM_BLOCK` to chain tip (or `BOOTSTRAP_TO_BLOCK` when set). Checkpoint-resumable. Exits when done. |
| `live` | Follow chain tip only (assumes already caught up). Includes reorg detection. |
| `reset [--yes]` | Truncate all scanned data (blocks, transactions, events, deployments, checkpoints, mempool). Destructive — interactive confirmation unless `--yes` or `FORCE=1`. |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPNET_RPC_URL` | `https://mainnet.opnet.org` | OPNET JSON-RPC endpoint |
| `DB_PATH` | `data/opstream.db` | SQLite database file |
| `BOOTSTRAP_FROM_BLOCK` | `941400` | Starting block for bootstrap |
| `BOOTSTRAP_TO_BLOCK` | (unset) | Stop block (inclusive). Unset scans to chain tip; setting it enables bounded repeatable runs, e.g. `BOOTSTRAP_FROM_BLOCK=941400 BOOTSTRAP_TO_BLOCK=941499` scans exactly 100 blocks regardless of tip. |
| `BOOTSTRAP_RPS` | `10` | Rate limit (requests per second) |
| `BOOTSTRAP_CHUNK_SIZE` | `500` | Blocks per chunk |
| `OPSTREAM_STORE_GENERIC_TXS` | `false` | Store non-OPNET Bitcoin txs in every block (plain BTC payments, miner coinbases, etc.). Off by default — in typical OPNET blocks these are ~95% of rows and nothing queries them, so persisting them bloats the DB ~10× for no practical gain. Set `true` for a full chain archive. |
| `RPC_PORT` | `0` (disabled) | JSON-RPC 2.0 HTTP server port. Set to e.g. `3001` to enable. |
| `WS_PORT` | `0` (disabled) | WebSocket broadcast port. Set to e.g. `8080` to enable. |
| `WEBHOOK_URLS` | (none) | Comma-separated HTTP callback URLs for event notifications |
| `LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARN`, `ERROR` |
| `OPSTREAM_MODE` | `indexer` | Run mode: `indexer`, `mempool`, or `full` (both) |
| `MEMPOOL_POLL_INTERVAL_MS` | `10000` | Mempool poll interval in milliseconds |
| `BITCOIN_RPC_URL` | (none) | Bitcoin Core RPC URL (required for `mempool`/`full` mode) |
| `BITCOIN_RPC_USER` | (none) | Bitcoin Core RPC username |
| `BITCOIN_RPC_PASS` | (none) | Bitcoin Core RPC password |

## Data Model

10 tables, all chain-level:

| Table | Purpose |
|-------|---------|
| `blocks` | Full archival block metadata — hash, timestamp, `tx_count` (raw Bitcoin block size), `opnet_tx_count` (OPNET txs we persisted), plus every `IBlockCommon` field needed to serve `btc_getBlockByNumber` / `btc_getBlockByHash` locally with the exact upstream shape (`previous_block_hash`, `previous_block_checksum`, `bits`, `nonce`, `version`, `size`, `weight`, `stripped_size`, `median_time`, `checksum_root`, `merkle_root`, `storage_root`, `receipt_root`, `ema`, `base_gas`, `block_gas_used`, `checksum_proofs`). |
| `transactions` | OPNET-relevant txs — sender, gas, fees, calldata, revert status, plus `receipt` + `receipt_proofs` for `btc_getTransactionReceipt` archival parity. Non-OPNET Bitcoin txs are skipped by default (see `OPSTREAM_STORE_GENERIC_TXS`). |
| `tx_outputs` | Bitcoin UTXO outputs per tx — value flows in satoshis |
| `events` | Raw event bytes from every contract — decoding is op-index's job, applied at read time |
| `scan_checkpoints` | Scanner progress (resumable) |
| `contract_deployments` | Contract creation tracking |
| `tokens` | OP20 metadata cache — written by op-index, not OpStream |
| `runtime_metrics` | Performance counters |
| `error_log` | Error tracking |
| `mempool_pending` | Pending OPNET txs from Bitcoin mempool (mempool/full mode) |

### What the `transactions` table captures

OPNET blocks are Bitcoin blocks — every block returned by an OPNET node contains every Bitcoin transaction in that block, each tagged with an `OPNetType` of `Interaction`, `Deployment`, or `Generic` (plain BTC payment). With the default `OPSTREAM_STORE_GENERIC_TXS=false`, only `interaction` and `deployment` rows are persisted; generics are classified, counted via `blocks.tx_count`, and then dropped. Set the flag to `true` for a full chain archive.

Every stored transaction exposes these fields via the OPNET SDK — OpStream stores all of them:

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
| `receipt` | Raw receipt bytes from `ITransactionReceipt.receipt` (archival, BLOB) |
| `receipt_proofs` | Receipt merkle proofs, JSON array of hex strings (archival) |

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
import { openDb, queryEvents } from '@opnet-collective/opstream';

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
  `SELECT * FROM contract_deployments WHERE deployer = ? ORDER BY block_number ASC`
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
  // event carries: blockNumber, txHash, contractAddress, eventName,
  // logIndex, txIndex, blockTimestamp, fromAddress, gasUsed, burnedBitcoin,
  // failed, revertReason, eventRaw (hex)
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
import { getWebhookManager } from '@opnet-collective/opstream';

const manager = getWebhookManager();

manager.register(
  { eventName: 'Swapped', contract: '0xabc...' },
  'https://your-endpoint.com/webhook',
);

manager.on('broadcast', (event) => {
  console.log('New event:', event.eventName);
});
```

## How op-index Consumes OpStream

op-index reads directly from OpStream's database (source, read-only) and writes derived,
indexed state into its own database (sink). The two are physically separate: a separate
SQLite file, or — in Docker — a separate logical database on the same Postgres instance
(`CREATE DATABASE opstream` and `CREATE DATABASE opindex`). OpStream is never written to by
op-index, and op-index can be wiped and re-derived from the raw archive without touching it.

Decoding lives entirely in op-index. Each event is decoded at read time via op-index's
`DECODER_REGISTRY` — adding a new ABI decoder instantly applies to all historical raw
events, with no rewrite of the OpStream database required.

```typescript
import { defineSchema, createIndexer, DbEventSource, openSqlite } from '@opnet-collective/op-index';

const schema = defineSchema({
  Transfer: {
    from:  { type: 'string' },
    to:    { type: 'string' },
    value: { type: 'bigint' },
    block: { type: 'int' },
  },
});

// source — reads from OpStream's events/transactions/blocks tables (read-only)
// sink   — op-index's own database for derived opindex_* tables
const source = new DbEventSource(openSqlite('data/opstream.db'));
const sink   = openSqlite('data/opindex.db');

const indexer = await createIndexer({ schema, sink, source });

indexer.on('Transferred', async (event, ctx) => {
  if (!event.decoded) return;
  await ctx.store.set('Transfer', event.txHash, {
    from:  event.decoded['from'] as string,
    to:    event.decoded['to'] as string,
    value: BigInt(event.decoded['value'] as string),
    block: event.blockNumber,
    // event.fromAddress, event.gasUsed, event.failed, event.blockTimestamp
    // are all available — populated by the JOIN op-index runs against OpStream's tables
  });
});

// Backfill all historical blocks
await indexer.sync(941400, currentBlock);

// Then go live — polls OpStream DB every 10s for new events
const stop = indexer.subscribe(currentBlock + 1);
```

OpStream doesn't change when you add a new event type or entity. You add a handler in op-index.
OpStream's raw tables are the stable foundation; op-index's derived tables are what your app queries.

---

## JSON-RPC 2.0 server

OpStream acts as a **local archival node**: for any OPNET RPC method that can be answered from indexed data, it serves the exact upstream shape locally at index speed. Methods that require live chain state or can't be reproduced faithfully are forwarded to the upstream node unchanged. Any opnet-SDK client can point at OpStream and get a transparent speedup with no code changes.

```bash
RPC_PORT=3001 npx tsx src/main.ts start
```

### `btc_*` — real OPNET RPC surface

**Served locally (archival parity — exact upstream shape, sub-ms):**

| Method | Source | Notes |
|---|---|---|
| `btc_getBlockByNumber` | `blocks` table | Full `IBlockCommon` shape incl. `checksumProofs` |
| `btc_getBlockByHash` | `blocks` table | Same, by block hash |
| `btc_getTransactionReceipt` | `transactions` + `events` | Full `ITransactionReceipt` shape with `receipt`, `receiptProofs`, events, hex gas |

Any opnet-SDK client calling `provider.getBlock(n)` / `provider.getTransactionReceipt(hash)` against OpStream gets these responses answered locally. No SDK changes; the speedup is automatic.

**Proxied to upstream (live chain state, tx submission, or too-heavy shapes):**

Everything else in the upstream method list — `btc_blockNumber` (chain tip), `btc_call`, `btc_getBalance`, `btc_getStorageAt`, `btc_getCode`, `btc_sendRawTransaction`, `btc_getUTXOs`, `btc_getTransactionByHash` (20+ fields incl. raw bytes and `pow` we don't store), all mempool and epoch methods, etc. Proxied unchanged to `OPNET_RPC_URL` + `/api/v1/json-rpc`.

The proxy is gated by an **allowlist of 25 known upstream methods**, taken verbatim from `opnet/build/providers/interfaces/JSONRpcMethods.js`. Any `btc_*` name not on the allowlist (typos, deprecated methods, unknown aliases) returns a local `-32601 Method not found` without a network round trip.

### `opstream_*` — OpStream extensions

Queries upstream doesn't support at all, or richer shapes that embed events and tx metadata in one call for indexer consumers.

| Method | Purpose |
|---|---|
| `opstream_getLogs` | Events by contract / event name / block range. O(1) indexed SQL. No upstream equivalent. |
| `opstream_blockNumber` | Latest indexed checkpoint (lags chain tip during catchup). Use `btc_blockNumber` for the live tip. |
| `opstream_getBlockByNumber` | Block header + every OPNET tx in the block + nested events. Richer than upstream's header-only response. |
| `opstream_getBlockByHash` | Same, by block hash. |
| `opstream_getBlockReceipts` | Every tx + its events for a block in one call. |
| `opstream_getTransaction` | Tx metadata + all events by tx hash. |
| `opstream_getTransactionReceipt` | Rich local receipt with tx metadata inline. |
| `opstream_getCodeHash` | 8-byte truncated SHA-256 of contract bytecode from `contract_deployments`. Returns `null` for addresses not in the local index. |

### Archival completeness

Header fields used by `btc_getBlockByNumber` / `ByHash` (`previousBlockHash`, `merkleRoot`, `storageRoot`, `receiptRoot`, `checksumProofs`, etc.) are added to the `blocks` table schema. Receipt fields used by `btc_getTransactionReceipt` (`receipt`, `receiptProofs`) are on `transactions`.

**Rows scanned before the archival schema additions have NULL for these fields** — the response is still valid JSON-RPC but the specific fields come back `null`. A fresh `reset` + `bootstrap` populates everything from the opnet SDK's block / receipt responses, which is where the fields come from in the first place.

### Examples

```bash
# Point any opnet SDK client at OpStream — btc_getBlockByNumber is served locally
curl -s -X POST http://localhost:3001 -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"btc_getBlockByNumber","params":[941400]}' | jq

# btc_getTransactionReceipt — exact upstream shape, no round trip
curl -s -X POST http://localhost:3001 -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"btc_getTransactionReceipt","params":["<tx_hash>"]}' | jq

# opstream_getLogs — fast event query (no upstream equivalent at all)
curl -s -X POST http://localhost:3001 -H 'Content-Type: application/json' -d '{
  "jsonrpc":"2.0","id":3,"method":"opstream_getLogs",
  "params":[{"address":"op1sq...","eventName":"Swap","fromBlock":941400,"toBlock":"latest"}]
}' | jq '.result | length'

# opstream_getBlockByNumber — richer than btc_*: block + full txs + events inline
curl -s -X POST http://localhost:3001 -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":4,"method":"opstream_getBlockByNumber","params":[941400, true]}' | jq
```

Works with both SQLite and Postgres via the `DbAdapter` abstraction.

---

## Mempool Scanning (v0.2 — experimental)

OpStream can now poll the Bitcoin mempool for pending OPNET transactions before they confirm.
This gives downstream consumers (trading bots, dashboards) visibility into what's about to
land on-chain — information asymmetry on a low-competition chain.

### How it works

1. Poll `getrawmempool` from Bitcoin Core every N seconds (default 10s)
2. Diff against an in-memory seen-set — only fetch raw hex for NEW txids
3. Parse each raw Bitcoin tx for taproot witness data containing the OPNET magic bytes (`0x6f70` / "op")
4. Discard non-OPNET transactions (99.9% of the mempool)
5. Decompress the gzip-encoded calldata chunks, store in `mempool_pending` table
6. Dispatch `MempoolPending` webhook/WS events (`blockNumber: -1` sentinel)

### Run modes

```bash
# Default — indexer only (existing behavior, no change)
npx tsx src/main.ts start

# Mempool scanning only (separate server, no block indexing)
OPSTREAM_MODE=mempool BITCOIN_RPC_URL=http://user:pass@btcnode:8332 npx tsx src/main.ts live

# Both in one process (dev / single-server)
OPSTREAM_MODE=full BITCOIN_RPC_URL=http://user:pass@btcnode:8332 npx tsx src/main.ts start
```

For production: run two OpStream instances (same binary, different `OPSTREAM_MODE`) pointing at
the same database (SQLite WAL or Postgres). The mempool scanner can sit on a separate machine
with fat bandwidth, while the block indexer runs lean.

### Current implementation & known limitations

This is a first-pass implementation. It works, it's tested, but several areas are flagged
for iteration:

**OPNET detection heuristic:** The parser searches witness tapscript data for the magic
bytes `0x6f70` ("op") after an `OP_IF` opcode, per `@btc-vision/transaction`'s
`CalldataGenerator` source. This has been verified against the CalldataGenerator code but
**not yet battle-tested against a large volume of real mainnet mempool data**. False positives
are possible if another protocol uses the same magic in the same script position. The pattern
can be tightened iteratively.

**Calldata decompression:** OPNET calldata is gzip-compressed at level 9 before being
chunked into the tapscript. The parser decompresses and returns raw bytes. If decompression
fails (corrupted data, different compression scheme), it falls back to returning the
compressed bytes — downstream consumers can still detect the OPNET tx even without
decoding its payload.

**No calldata ABI decoding here:** OpStream stores `raw_payload_hex` and `contract_selector`
only. Decoding pending calldata into structured function calls (e.g., "this is a
`reserveTokens(tokenX, 5000 sats)`") is op-index's responsibility — it owns the function
selector constants and parameter layouts via its `calldataDecoders.ts` registry, mirroring
the existing `eventDecoders.ts` pattern.

**First-poll burst:** On startup, the poller sees the entire current mempool as "new" and
fetches raw hex for all txids. With a 50-concurrent batch limit this is manageable but
creates a startup spike. A future optimization: persist the seen-set to DB so restarts
don't re-scan everything.

**No verbose mempool pre-filter yet:** Currently fetches raw hex for every new txid and
filters in-memory. A future optimization: use `getrawmempool verbose=true` to pre-filter
for OP_RETURN or taproot-spending txids before fetching full hex. This would dramatically
reduce bandwidth on busy mempool periods.

**Confirmed-at tracking:** The `confirmed_at` column exists but is not yet populated.
When the block indexer confirms a block, it could UPDATE matching `mempool_pending` rows —
giving you mempool-to-confirmation latency metrics. This cross-mode coordination is an
enhancement.

### `mempool_pending` table

| Column | Type | Description |
|--------|------|-------------|
| `txid` | TEXT PK | Bitcoin transaction ID |
| `raw_payload_hex` | TEXT | Decompressed OPNET calldata as hex |
| `contract_selector` | TEXT | First 4 bytes of payload (function selector), e.g. `0xdeadbeef` |
| `first_seen_at` | INTEGER | Unix timestamp when first detected in mempool |
| `confirmed_at` | INTEGER | Unix timestamp when confirmed in a block (NULL = still pending) |
| `pruned_at` | INTEGER | Soft-prune timestamp for old entries |

---

## TODO — Requires separate effort

These features are architecturally feasible given OpStream's existing data — the required information is already indexed — but need non-trivial implementation work before they can ship.

### Stateful log filters (`eth_newFilter` / `eth_getFilterChanges` / `eth_getFilterLogs`)

**Why not done yet:** These methods require the RPC server to maintain state across requests: a filter registry mapping filter IDs to filter params, plus an accumulation buffer of matching events since the filter was created. The live indexer must feed each new event into all active filters as blocks are indexed. This also requires a filter expiry mechanism — idle filters must be garbage-collected — and careful memory management under high event throughput. The foundation is all there (event stream via `onEvent` callback, indexed SQLite). It is purely an implementation effort with some design decisions around filter lifetimes.

### WebSocket `logs` subscription (`btc_subscribe`)

**Why not done yet:** The WS server (`WS_PORT`) already exists but is push-only — the server broadcasts to all clients, clients cannot send messages. Adding subscription support requires making the WS layer bidirectional: the server must parse incoming client frames (client → server), route `btc_subscribe` / `btc_unsubscribe` requests to a per-client subscription registry, and push only matching events to each subscriber. This requires a medium rework of `src/indexer/webhooks.ts` — currently the RFC 6455 framing only handles server-to-client direction — plus routing logic tying per-client subscriptions to the live indexer's event stream.

### Fee history (`eth_feeHistory` equivalent)

**Why not done yet:** The `transactions` table stores `gas_used`, `burned_bitcoin`, `priority_fee`, and `max_gas_sat` per transaction. A per-block fee summary (min/max/percentiles) is fully computable from this data. What is missing is: (a) a spec for the response shape adapted to OPNET's fee model (it is not EIP-1559), and (b) the SQL aggregation query. Once the shape is agreed, implementation is a single SQL query and a new RPC handler.

---

## NOT POSSIBLE in OpStream

These features require capabilities that OpStream fundamentally does not have. They cannot be added by extending the indexer — they require a full OPNET execution node.

### `eth_estimateGas` / gas estimation per call

OpStream is a pure indexer — it records what happened on-chain but has no contract execution engine. Estimating gas for a new transaction requires simulating it against live contract state, which requires a running smart contract VM. This is only possible via the upstream node at `OPNET_RPC_URL`. OpStream can proxy this call but cannot compute it locally.

### `eth_call` with state overrides

Same reason. State-override calls ("simulate as if this address had balance X") require forked state execution with a full VM. Not possible in an indexer.

### `debug_traceTransaction` / `trace_transaction` / Parity-style traces

Opcode-level execution traces require replaying the transaction through a full VM with debug instrumentation enabled. The OPNET ecosystem does not currently expose this capability at all — it is not a gap in OpStream specifically, it is a gap in the OPNET node software.

### `eth_getProof` (EIP-1186 Merkle proofs)

Trustless state verification requires a Merkle trie of all contract state at every block. OpStream stores indexed events and transaction metadata, not the full state trie. An archival full node with trie persistence would be required — this does not exist in the OPNET ecosystem today.

---

## Development

```bash
npx vitest run     # run tests (148 tests)
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
| [docs/op-index-integration.md](./docs/op-index-integration.md) | Tier 1/2/3 event sources, ABI decoder injection, DB layout |

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
