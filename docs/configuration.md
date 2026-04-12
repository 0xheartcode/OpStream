# Configuration

OpStream is configured entirely through environment variables. No config file is required —
copy `.env.example` to `.env`, set the values you care about, and run.

```bash
cp .env.example .env
```

---

## Commands

| Command | Description |
|---------|-------------|
| `start` | Bootstrap + live — catch up to chain tip (or `BOOTSTRAP_TO_BLOCK` when set), then follow it continuously. **Recommended for most deployments.** |
| `bootstrap` | Full scan from `BOOTSTRAP_FROM_BLOCK` to chain tip (or `BOOTSTRAP_TO_BLOCK`). Checkpoint-resumable — exits when done. |
| `live` | Follow the chain tip only. Assumes the DB is already caught up; resumes from the last checkpoint. Do not use for a cold start — there's no checkpoint yet and it would try to scan from block 0. |
| `reset [--yes]` | Truncate every scanned table (`events`, `transactions`, `tx_outputs`, `blocks`, `contract_deployments`, `scan_checkpoints`, `mempool_pending`). **Destructive** — prompts for interactive confirmation unless `--yes` or the `FORCE=1` env var is set. Preserves `tokens`, `runtime_metrics`, and `error_log`. Use before a fresh archival bootstrap if the DB was scanned before the archival schema additions. |

```bash
# Cold start from scratch
npx tsx src/main.ts start

# Bounded 100-block test run (fast, deterministic)
BOOTSTRAP_FROM_BLOCK=941400 BOOTSTRAP_TO_BLOCK=941499 npx tsx src/main.ts bootstrap

# Nuke the DB and start over
npx tsx src/main.ts reset --yes
npx tsx src/main.ts start
```

---

## Variables

### Database

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_PATH` | `data/opstream.db` | Path to the SQLite database file. Created automatically on first run. Irrelevant when `DB_URL` is set. |
| `DB_URL` | *(unset)* | Postgres connection URL. When set, Postgres is used instead of SQLite. Example: `postgres://user:pass@localhost:5432/opstream` |

OpStream creates all tables and runs schema migrations automatically on startup — no manual
migration step is needed for either backend.

### Run Mode

| Variable | Default | Description |
|----------|---------|-------------|
| `OPSTREAM_MODE` | `indexer` | `indexer` = block indexing only (default). `mempool` = mempool scanning only. `full` = both in one process. |

When unset, OpStream behaves exactly as before — indexer mode, no mempool scanning.

### RPC

| Variable | Default | Description |
|----------|---------|-------------|
| `OPNET_RPC_URL` | `https://mainnet.opnet.org` | Upstream OPNET JSON-RPC endpoint. Both the scanner (when pulling blocks) and the built-in RPC server (when proxying unsupported methods) use this. Accepts either a bare hostname (`https://mainnet.opnet.org`) or a fully-qualified path (`https://mainnet.opnet.org/api/v1/json-rpc`) — OpStream appends `/api/v1/json-rpc` if it's missing, mirroring the opnet SDK's `JSONRpcProvider.providerUrl()` behavior. |
| `RPC_PORT` | `0` (disabled) | TCP port for OpStream's own JSON-RPC 2.0 HTTP server. Set to e.g. `3001` to expose it. When enabled, any opnet-SDK client pointed at `http://localhost:3001` gets transparent speedup: methods served locally from the archival index (`btc_getBlockByNumber`, `btc_getBlockByHash`, `btc_getTransactionReceipt`) answer in sub-milliseconds; everything else proxies to `OPNET_RPC_URL`. The `opstream_*` extension namespace (`opstream_getLogs`, etc.) is only reachable through this endpoint. |
| `BITCOIN_RPC_URL` | *(unset)* | Bitcoin Core RPC URL. **Required** when `OPSTREAM_MODE` is `mempool` or `full`. Example: `http://user:pass@localhost:8332` |
| `BITCOIN_RPC_USER` | *(unset)* | Bitcoin Core RPC username (fallback if not embedded in URL). |
| `BITCOIN_RPC_PASS` | *(unset)* | Bitcoin Core RPC password (fallback if not embedded in URL). |

The OPNET RPC client has a built-in 5 s timeout per call, exponential backoff on failure (1 s → 2 s → 4 s),
and a circuit breaker that pauses after 3 consecutive failures.

OpStream's own RPC server is a **strict-namespace gateway**: `btc_*` is the OPNET RPC surface (served locally where possible, proxied otherwise), `opstream_*` is the extension surface for queries upstream doesn't support (indexed event lookups, bytecode hash queries, rich block+txs+events responses). See [the README's JSON-RPC section](../README.md#json-rpc-20-server) for the method-by-method breakdown.

### Mempool

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMPOOL_POLL_INTERVAL_MS` | `10000` | How often to poll the Bitcoin mempool (milliseconds). Only used in `mempool` or `full` mode. |

The mempool poller fetches raw transaction hex for every new txid since the last poll, parses
each for OPNET tapscript witness data, and stores only OPNET-related transactions. Non-OPNET
Bitcoin transactions are discarded in memory.

### Bootstrap

| Variable | Default | Description |
|----------|---------|-------------|
| `BOOTSTRAP_FROM_BLOCK` | `941400` | Block to start scanning from. OPNET's first block with on-chain activity. |
| `BOOTSTRAP_TO_BLOCK` | *(unset)* | Stop block (inclusive). Unset scans to chain tip; setting it enables **bounded, deterministic test runs**. `BOOTSTRAP_FROM_BLOCK=941400 BOOTSTRAP_TO_BLOCK=941499` scans exactly 100 blocks regardless of where the live tip is. Clamped to the chain tip if it exceeds it; throws if less than `BOOTSTRAP_FROM_BLOCK`. |
| `BOOTSTRAP_RPS` | `10` | Rate limit in RPC requests per second during bootstrap. Lower this if the node is rate-limiting you. |
| `BOOTSTRAP_CHUNK_SIZE` | `500` | Blocks scanned per DB transaction. Smaller = more frequent checkpoints but slower overall. |
| `OPSTREAM_STORE_GENERIC_TXS` | `false` | Store non-OPNET Bitcoin transactions (plain BTC payments, coinbase, etc.) alongside OPNET interactions and deployments. Off by default — in typical OPNET blocks generics are ~95% of rows (~3,400 of 3,450) and nothing in the query surface uses them, so persisting them bloats the DB ~10× for no practical gain. Set to `true` for a full Bitcoin archive. Events and contract deployments are unaffected either way. |

Bootstrap is checkpoint-resumable. If it crashes, the next run picks up from the last saved
checkpoint — at most one chunk is re-scanned (idempotent due to `ON CONFLICT DO NOTHING`).

#### Generic vs OPNET txs: what gets stored

OPNET blocks are Bitcoin blocks. When OpStream's scanner fetches a block from the OPNET node, the response contains **every Bitcoin transaction in that block**, each tagged by the opnet SDK with an `OPNetType`:

| Type | What it is | Stored by default? |
|---|---|---|
| `Interaction` | OPNET contract call (calldata, gas, events) | ✅ yes |
| `Deployment` | New OPNET contract deployment | ✅ yes |
| `Generic` | Plain Bitcoin transaction (no OPNET payload) | ❌ no (unless `OPSTREAM_STORE_GENERIC_TXS=true`) |

Classification happens regardless of the flag — `blocks.tx_count` always records the raw Bitcoin block size and `blocks.opnet_tx_count` records how many OPNET-relevant txs were persisted, so you can measure the difference without storing everything.

### Real-Time Push

| Variable | Default | Description |
|----------|---------|-------------|
| `WS_PORT` | `0` (disabled) | TCP port for the WebSocket broadcast server. Set to e.g. `8080` to enable. |
| `WEBHOOK_URLS` | *(unset)* | Comma-separated HTTP callback URLs. Each receives a POST for every indexed event. |

See [websocket.md](./websocket.md) and [webhooks.md](./webhooks.md) for payload details.

### Logging

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `INFO` | One of `DEBUG`, `INFO`, `WARN`, `ERROR`. WARN and ERROR are persisted to the `error_log` table. |

---

## Example `.env`

```bash
# Run mode
# OPSTREAM_MODE=indexer             # indexer | mempool | full

# RPC
OPNET_RPC_URL=https://mainnet.opnet.org

# Bitcoin RPC (required for mempool/full mode)
# BITCOIN_RPC_URL=http://rpcuser:rpcpass@localhost:8332
# BITCOIN_RPC_USER=rpcuser
# BITCOIN_RPC_PASS=rpcpass

# Database — choose one
DB_PATH=data/opstream.db
# DB_URL=postgres://opstream:secret@localhost:5432/opstream

# Bootstrap
BOOTSTRAP_FROM_BLOCK=941400
# BOOTSTRAP_TO_BLOCK=941499       # uncomment for bounded test runs
BOOTSTRAP_RPS=10
BOOTSTRAP_CHUNK_SIZE=500
# OPSTREAM_STORE_GENERIC_TXS=true # uncomment for full Bitcoin archive (~10x disk)

# JSON-RPC 2.0 HTTP server (optional)
# RPC_PORT=3001

# Mempool
# MEMPOOL_POLL_INTERVAL_MS=10000

# Real-time push (optional)
WS_PORT=8080
# WEBHOOK_URLS=https://my-app.com/hook,https://another-app.com/hook

# Logging
LOG_LEVEL=INFO
```

---

## Postgres

When `DB_URL` is set, OpStream uses Postgres instead of SQLite.
The same schema is created automatically. No code changes are required.

```bash
DB_URL=postgres://user:pass@localhost:5432/opstream npx tsx src/main.ts start
```

Postgres is recommended when:
- Multiple processes need to read the database concurrently
- The dataset is very large (tens of millions of events)
- You want to run the DB on a separate host

SQLite is fine for single-process use, development, and datasets up to a few hundred million rows.

---

## Docker

```bash
# Build and start with Docker Compose
just docker-build
just docker-up

# Tail logs
just docker-logs
```

The `docker-compose.yml` passes all environment variables from the host's `.env` file into
the container. Mount `./data` as a volume to persist the SQLite database across restarts.

---

## Multi-Instance Deployment (indexer + mempool)

For production, run two OpStream instances from the same image with different `OPSTREAM_MODE`.
This keeps the block indexer isolated from mempool scanning bandwidth.

### Option A: Same machine, shared SQLite (simplest)

Both processes share the same `data/opstream.db` via WAL mode. The indexer writes to
`blocks`, `transactions`, `events`, etc. The mempool poller writes only to `mempool_pending`.
Write contention is minimal since they touch different tables.

```bash
# Terminal 1 — block indexer (default mode, no OPSTREAM_MODE needed)
npx tsx src/main.ts start

# Terminal 2 — mempool scanner
OPSTREAM_MODE=mempool BITCOIN_RPC_URL=http://user:pass@btcnode:8332 npx tsx src/main.ts live
```

Or with Docker Compose:

```bash
docker compose up -d                    # indexer (default)
docker compose up -d opstream-mempool   # mempool scanner
```

### Option B: Same machine, separate SQLite files

Each process writes to its own database. No write contention at all, but downstream consumers
need to query two files.

```bash
# Indexer — default DB_PATH
DB_PATH=data/opstream-indexer.db npx tsx src/main.ts start

# Mempool
OPSTREAM_MODE=mempool DB_PATH=data/opstream-mempool.db BITCOIN_RPC_URL=... npx tsx src/main.ts live
```

### Option C: Different machines, shared Postgres (recommended for production)

Both instances point at the same Postgres database via `DB_URL`. No SQLite contention concerns.
The mempool machine can have fat bandwidth for Bitcoin RPC; the indexer machine stays lean.

```bash
# Machine A — indexer
DB_URL=postgres://opstream:pass@pghost:5432/opstream npx tsx src/main.ts start

# Machine B — mempool scanner
OPSTREAM_MODE=mempool DB_URL=postgres://opstream:pass@pghost:5432/opstream \
  BITCOIN_RPC_URL=http://user:pass@btcnode:8332 npx tsx src/main.ts live
```

### Option D: One process, both modes (`full`)

Good for development or single-server deployments. Both pollers run in the same event loop.

```bash
OPSTREAM_MODE=full BITCOIN_RPC_URL=http://user:pass@btcnode:8332 npx tsx src/main.ts start
```
