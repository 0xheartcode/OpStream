# Changelog

All notable changes to OpStream are documented here.
Format: `## [x.y.z] - YYYY-MM-DD` — newest first.

Versioning:
- **Z (patch)** — small features, fixes, chores, docs, any general commit
- **Y (minor)** — meaningful new capability or consequent improvement
- **X (major)** — breaking API/schema change or major product milestone

---

## [0.1.1] - 2026-04-16
- release: workflow infrastructure, test fixes, mempool vsize_bytes (#4)


## [0.1.0] - 2026-04-16

Initial tracked release. Prior history available via `git log`.

### Added
- Live block indexer with reorg detection (`liveIndexer.ts`)
- Mempool poller — OPNET pending tx detection from Bitcoin Core mempool (`mempoolPoller.ts`)
- Bitcoin tapscript parser — extracts OPNET calldata from raw tx hex (`btcTxParser.ts`)
- SQLite + Postgres dual-backend via `DbAdapter` interface
- JSON-RPC 2.0 HTTP server (`opstream_*` and `btc_*` methods)
- WebSocket broadcast server with stateful subscriptions (`opstream_subscribe`)
- Paginated `opstream_getLogs` with keyset cursor
- `opstream_getTransactionStatus` — mempool → confirmed lifecycle resolution
- Fast-sync via `/sync/export` gzip NDJSON stream
- Bootstrap scanner with progress display and rate limiting
- Batch bootstrap via `opstream_getBlockRange`
- `mempool_pending` TTL pruner (24h resolved-row cleanup)
- Comprehensive RPC and WebSocket API reference (`docs/rpc.md`)
