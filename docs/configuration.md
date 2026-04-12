# Configuration

OpStream is configured entirely through environment variables. No config file is required —
copy `.env.example` to `.env`, set the values you care about, and run.

```bash
cp .env.example .env
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
| `OPNET_RPC_URL` | `https://mainnet.opnet.org` | OPNET JSON-RPC endpoint. Point this at a local node for production workloads. |
| `BITCOIN_RPC_URL` | *(unset)* | Bitcoin Core RPC URL. **Required** when `OPSTREAM_MODE` is `mempool` or `full`. Example: `http://user:pass@localhost:8332` |
| `BITCOIN_RPC_USER` | *(unset)* | Bitcoin Core RPC username (fallback if not embedded in URL). |
| `BITCOIN_RPC_PASS` | *(unset)* | Bitcoin Core RPC password (fallback if not embedded in URL). |

The OPNET RPC client has a built-in 5 s timeout per call, exponential backoff on failure (1 s → 2 s → 4 s),
and a circuit breaker that pauses after 3 consecutive failures.

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
| `BOOTSTRAP_RPS` | `10` | Rate limit in RPC requests per second during bootstrap. Lower this if the node is rate-limiting you. |
| `BOOTSTRAP_CHUNK_SIZE` | `500` | Blocks scanned per DB transaction. Smaller = more frequent checkpoints but slower overall. |

Bootstrap is checkpoint-resumable. If it crashes, the next run picks up from the last saved
checkpoint — at most one chunk is re-scanned (idempotent due to `ON CONFLICT DO NOTHING`).

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
BOOTSTRAP_RPS=10
BOOTSTRAP_CHUNK_SIZE=500

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
