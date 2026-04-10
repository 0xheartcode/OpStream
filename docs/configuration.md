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

### RPC

| Variable | Default | Description |
|----------|---------|-------------|
| `OPNET_RPC_URL` | `https://mainnet.opnet.org` | OPNET JSON-RPC endpoint. Point this at a local node for production workloads. |

The RPC client has a built-in 5 s timeout per call, exponential backoff on failure (1 s → 2 s → 4 s),
and a circuit breaker that pauses after 3 consecutive failures.

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
# RPC
OPNET_RPC_URL=https://mainnet.opnet.org

# Database — choose one
DB_PATH=data/opstream.db
# DB_URL=postgres://opstream:secret@localhost:5432/opstream

# Bootstrap
BOOTSTRAP_FROM_BLOCK=941400
BOOTSTRAP_RPS=10
BOOTSTRAP_CHUNK_SIZE=500

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
