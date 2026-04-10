# OpStream

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
  console.log(event.eventName, event.contractAddress, event.blockNumber);
};
```

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

OpKit's `createIndexer` processes raw events from OpStream through registered handlers
into a typed entity store:

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

indexer.on('Transfer', (event, ctx) => {
  if (!event.decoded) return;
  ctx.store.set('Transfer', event.txHash, {
    from:  event.decoded.from,
    to:    event.decoded.to,
    value: BigInt(event.decoded.value),
  });
});

// Backfill from OpStream
const db = openDb('data/opstream.db');
const events = queryEvents(db, { eventName: 'Transfer' });
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
- WebSocket broadcast (no extra deps)
- opnet SDK (`JSONRpcProvider`)
- `@opnet-devs/opkit` (event decoding)
