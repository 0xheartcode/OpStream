# Querying the Database

OpStream's database is the primary interface for historical data. Everything that the
scanner has seen is in there — every event, every transaction, every UTXO output,
every deployed contract. Query it directly with SQL.

---

## Opening the Database

```typescript
import { openDb } from '@opnet-devs/opstream';

const db = openDb('data/opstream.db');
```

`openDb` is a singleton — calling it multiple times with the same path returns the same
adapter instance. The adapter's `rawDb` property exposes the underlying `DatabaseSync`
instance for cases where you need prepared statements.

---

## High-Level API

For the most common query — filtered events — use the typed helper:

```typescript
import { queryEvents } from '@opnet-devs/opstream';

const events = await queryEvents(db, {
  contract:  'bc1qmycontract…',
  eventName: 'Swapped',
  fromBlock: 942000,
  toBlock:   943000,
});
// returns EventRow[]
```

All filters are optional and combined with AND logic.

---

## Direct SQL

The adapter exposes `get<T>()`, `all<T>()`, and `run()` for arbitrary SQL.
Use these for anything `queryEvents` doesn't cover.

### Events

```typescript
// All events for a contract, newest first
const rows = await db.all(
  `SELECT * FROM events
   WHERE contract_address = ?
   ORDER BY block_number DESC, log_index ASC`,
  ['bc1qmycontract…'],
);

// Events by name across all contracts
const swaps = await db.all(
  `SELECT * FROM events WHERE event_name = ?`,
  ['Swapped'],
);

// Count of events per contract
const counts = await db.all(
  `SELECT contract_address, count(*) AS cnt
   FROM events
   GROUP BY contract_address
   ORDER BY cnt DESC`,
);
```

### Transactions

```typescript
// All transactions from a sender
const txs = await db.all(
  `SELECT * FROM transactions
   WHERE from_address = ?
   ORDER BY block_number DESC
   LIMIT 50`,
  ['bc1qsender…'],
);

// Failed transactions in the last 1000 blocks
const failed = await db.all(
  `SELECT tx_hash, block_number, revert_reason
   FROM transactions
   WHERE failed = 1 AND block_number > ?
   ORDER BY block_number DESC`,
  [currentBlock - 1000],
);

// Most gas-hungry transactions
const heavy = await db.all(
  `SELECT tx_hash, gas_used, burned_bitcoin, block_number
   FROM transactions
   ORDER BY CAST(gas_used AS INTEGER) DESC
   LIMIT 20`,
);

// Transactions that touched a specific contract
const interactions = await db.all(
  `SELECT t.*, e.event_name, e.decoded_json
   FROM transactions t
   JOIN events e ON e.tx_hash = t.tx_hash
   WHERE t.contract_address = ?
   ORDER BY t.block_number DESC`,
  ['bc1qmycontract…'],
);
```

### Blocks

```typescript
// Block metadata
const block = await db.get(
  `SELECT * FROM blocks WHERE block_number = ?`,
  [942381],
);

// Blocks in a time range (unix timestamps)
const recent = await db.all(
  `SELECT * FROM blocks
   WHERE timestamp BETWEEN ? AND ?
   ORDER BY block_number ASC`,
  [1718400000, 1718486400],
);
```

### Token Deployments

```typescript
// All contracts deployed by an address
const deployed = await db.all(
  `SELECT * FROM contract_deployments
   WHERE deployer = ?
   ORDER BY block_number ASC`,
  ['bc1qdeployer…'],
);

// Check if a contract is deployed
const exists = await db.get(
  `SELECT 1 FROM contract_deployments WHERE contract_address = ?`,
  ['bc1qcontract…'],
);
```

### UTXO Outputs

```typescript
// All outputs of a transaction (BTC value flow)
const outputs = await db.all(
  `SELECT * FROM tx_outputs WHERE tx_hash = ?`,
  ['a3f8c1…'],
);

// Total BTC received by an address across all transactions
const received = await db.get(
  `SELECT SUM(value_sat) AS total_sat
   FROM tx_outputs
   WHERE address = ?`,
  ['bc1qrecipient…'],
);
```

---

## Schema Reference

### `blocks`

| Column | Type | Description |
|--------|------|-------------|
| `block_number` | INTEGER PK | Block height |
| `block_hash` | TEXT | Block hash |
| `timestamp` | INTEGER | Unix timestamp |
| `tx_count` | INTEGER | Number of transactions |

### `transactions`

| Column | Type | Description |
|--------|------|-------------|
| `tx_hash` | TEXT PK | Transaction ID |
| `block_number` | INTEGER | Block height |
| `tx_index` | INTEGER | Position within block |
| `tx_type` | TEXT | `interaction` \| `deployment` \| `generic` |
| `from_address` | TEXT | Sender address |
| `contract_address` | TEXT | Target contract |
| `gas_used` | TEXT | Gas consumed (decimal string) |
| `special_gas_used` | TEXT | OPNET-specific gas (decimal string) |
| `burned_bitcoin` | TEXT | BTC burned as fee, satoshis (decimal string) |
| `priority_fee` | TEXT | Priority fee (decimal string) |
| `max_gas_sat` | TEXT | Max gas cap, satoshis (decimal string) |
| `failed` | INTEGER | `1` if reverted, `0` otherwise |
| `revert_reason` | TEXT | Revert message (nullable) |
| `calldata` | BLOB | Raw calldata for interaction txs |
| `calldata_length` | INTEGER | Byte count of calldata |
| `sender_pub_key_hash` | TEXT | Bitcoin-native sender identity (hex) |

Gas and fee columns are stored as decimal strings because the on-chain values are
`bigint` and SQLite has no native 64-bit unsigned integer type.

### `events`

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-incremented |
| `block_number` | INTEGER | Block height |
| `tx_hash` | TEXT | Parent transaction |
| `contract_address` | TEXT | Contract that emitted the event |
| `event_name` | TEXT | Event type name |
| `log_index` | INTEGER | Position within the transaction (0-based) |
| `event_raw` | BLOB | Raw event bytes |
| `decoded_json` | TEXT | ABI-decoded fields as JSON (nullable — null if no decoder was provided) |
| `data_length` | INTEGER | Byte count of `event_raw` |

### `tx_outputs`

| Column | Type | Description |
|--------|------|-------------|
| `tx_hash` | TEXT | Parent transaction |
| `output_index` | INTEGER | UTXO index |
| `value_sat` | INTEGER | Value in satoshis |
| `script_type` | TEXT | e.g. `p2wpkh`, `p2pkh`, `p2sh` |
| `address` | TEXT | Recipient Bitcoin address |

### `contract_deployments`

| Column | Type | Description |
|--------|------|-------------|
| `block_number` | INTEGER | Block of deployment |
| `tx_hash` | TEXT | Deployment transaction |
| `contract_address` | TEXT PK | Deployed contract address |
| `deployer` | TEXT | Deployer address |
| `bytecode_hash` | TEXT | First 16 hex chars of SHA-256 of bytecode |

### `scan_checkpoints`

| Column | Type | Description |
|--------|------|-------------|
| `scan_type` | TEXT PK | Always `indexer` |
| `last_block` | INTEGER | Last fully committed block |
| `updated_at` | INTEGER | Unix timestamp of last save |

---

## Useful Compound Queries

### Events with full transaction context

```sql
SELECT
  e.block_number,
  e.tx_hash,
  e.contract_address,
  e.event_name,
  e.log_index,
  e.decoded_json,
  t.from_address,
  t.gas_used,
  t.burned_bitcoin,
  t.failed,
  b.timestamp AS block_timestamp
FROM events e
JOIN transactions t ON t.tx_hash = e.tx_hash
JOIN blocks       b ON b.block_number = e.block_number
WHERE e.contract_address = 'bc1qmycontract…'
  AND e.event_name = 'Swapped'
ORDER BY e.block_number DESC, e.log_index ASC
LIMIT 100;
```

### Daily event volume

```sql
SELECT
  date(b.timestamp, 'unixepoch') AS day,
  count(*) AS event_count
FROM events e
JOIN blocks b ON b.block_number = e.block_number
GROUP BY day
ORDER BY day DESC;
```

### Contracts by activity (last 10 000 blocks)

```sql
SELECT contract_address, count(*) AS event_count
FROM events
WHERE block_number > (SELECT max(block_number) FROM blocks) - 10000
GROUP BY contract_address
ORDER BY event_count DESC
LIMIT 20;
```
