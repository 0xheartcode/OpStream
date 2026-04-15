# JSON-RPC API Reference

OpStream exposes a JSON-RPC 2.0 HTTP server that acts as a **local archival node**.
For any method that can be answered from indexed data it serves the exact upstream
response shape locally — at index speed, no upstream round trip. Methods that require
live chain state are proxied to the upstream OPNET node transparently.

Enable with `RPC_PORT=3001` (default 0 = disabled).

---

## Endpoints

| Network  | HTTP                                                    | WebSocket                                               |
|----------|---------------------------------------------------------|---------------------------------------------------------|
| Testnet  | `https://opstream-testnet-production.up.railway.app`    | `wss://opstream-testnet-production.up.railway.app`      |
| Mainnet  | `https://opstream-mainnet-production.up.railway.app`    | `wss://opstream-mainnet-production.up.railway.app`      |
| Local    | `http://localhost:3001`                                 | `ws://localhost:8080`                                   |

> WebSocket is used for live event subscriptions — see [websocket.md](./websocket.md).
> The HTTP endpoint handles all request/response queries documented here.

---

## Request Format

All methods follow JSON-RPC 2.0:

```bash
curl -X POST https://opstream-testnet-production.up.railway.app \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"<method>","params":[...]}'
```

Batch requests (array of request objects) are supported.

---

## `opstream_*` Methods

These are OpStream extensions — richer response shapes that embed events and
transaction metadata in a single call. They are served exclusively from the
local index and have no upstream equivalent.

---

### `opstream_blockNumber`

Returns the latest fully indexed block (the checkpoint, not the chain tip).

```bash
curl -X POST https://opstream-testnet-production.up.railway.app \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"opstream_blockNumber","params":[]}'
```

```json
{"jsonrpc":"2.0","id":1,"result":14370}
```

---

### `opstream_getLogs`

Paginated event log query. All filter fields are optional and combined with AND logic.

**Params:** `[filter]`

| Field | Type | Description |
|---|---|---|
| `address` / `contractAddress` | `string \| string[]` | Filter by contract address(es) |
| `eventName` | `string \| string[]` | Filter by event name(s) |
| `fromBlock` | `number \| string` | Start block (decimal or `"0x…"` hex) |
| `toBlock` | `number \| string` | End block (decimal, `"0x…"` hex, or `"latest"`) |
| `limit` | `number` | Max results per page (default 1000) |
| `afterId` | `number` | Keyset cursor — pass the last `id` from previous page |

**Response:** `{ items: RpcLog[], hasMore: boolean }`
Pass `items[items.length-1].id` as `afterId` for the next page. Done when `hasMore === false`.

```bash
# Page 1 — last 100 Swapped events from a contract
curl -X POST https://opstream-testnet-production.up.railway.app \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0","id":1,"method":"opstream_getLogs",
    "params":[{
      "contractAddress": "op1sq…",
      "eventName": "Swapped",
      "limit": 100
    }]
  }'
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "items": [
      {
        "id": 48291,
        "blockNumber": 14320,
        "txHash": "a3f8c1…",
        "contractAddress": "op1sq…",
        "eventName": "Swapped",
        "logIndex": 0,
        "txIndex": 2,
        "blockTimestamp": 1776216000,
        "fromAddress": "bc1qsender…",
        "gasUsed": "12000",
        "burnedBitcoin": "800",
        "failed": false,
        "revertReason": null,
        "eventRaw": "0x0007a120…"
      }
    ],
    "hasMore": true
  }
}
```

```bash
# Page 2 — pass afterId from last item
curl -X POST https://opstream-testnet-production.up.railway.app \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"opstream_getLogs","params":[{"contractAddress":"op1sq…","eventName":"Swapped","limit":100,"afterId":48291}]}'
```

---

### `opstream_getBlockRange`

Bulk block fetch — the indexer backfill workhorse. Returns up to 1000 blocks per call
with full event and transaction enrichment. If the server hits its tx/event limit it
returns `-32602` with a suggested smaller `toBlock` — halve the range and retry.

**Params:** `[fromBlock, toBlock, options?]`

| Option | Type | Description |
|---|---|---|
| `includeTx` | `boolean` | Include full transaction objects (default `false`) |
| `includeEvents` | `boolean` | Include events nested under each transaction (default `false`) |

```bash
curl -X POST https://opstream-testnet-production.up.railway.app \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0","id":1,"method":"opstream_getBlockRange",
    "params":[14300, 14310, {"includeTx":true,"includeEvents":true}]
  }'
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": [
    {
      "hash": "00000001ea49…",
      "height": "14300",
      "time": "1776216000000",
      "txCount": 12,
      "transactions": [
        {
          "txHash": "a3f8c1…",
          "blockNumber": 14300,
          "txIndex": 0,
          "txType": "interaction",
          "contractAddress": "op1sq…",
          "gasUsed": "12000",
          "failed": false,
          "events": [
            {
              "eventName": "Swapped",
              "logIndex": 0,
              "eventRaw": "0x0007a120…"
            }
          ]
        }
      ]
    }
  ]
}
```

---

### `opstream_getBlockByNumber`

Rich block by number — header + all transactions + nested events.

**Params:** `[blockNumber, includeTx?, includeEvents?]`

```bash
curl -X POST https://opstream-testnet-production.up.railway.app \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"opstream_getBlockByNumber","params":[14300,true,true]}'
```

---

### `opstream_getBlockByHash`

Same as `opstream_getBlockByNumber` but by block hash.

**Params:** `[blockHash, includeTx?, includeEvents?]`

```bash
curl -X POST https://opstream-testnet-production.up.railway.app \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"opstream_getBlockByHash","params":["00000001ea49…",true,true]}'
```

---

### `opstream_getBlockReceipts`

Every transaction and its events for a given block — equivalent to Alchemy's
`alchemy_getTransactionReceipts` at the block level.

**Params:** `[blockNumber]`

```bash
curl -X POST https://opstream-testnet-production.up.railway.app \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"opstream_getBlockReceipts","params":[14300]}'
```

---

### `opstream_getTransaction`

Transaction metadata + all emitted events by tx hash.

**Params:** `[txHash]`

```bash
curl -X POST https://opstream-testnet-production.up.railway.app \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"opstream_getTransaction","params":["a3f8c1…"]}'
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "txHash": "a3f8c1…",
    "blockNumber": 14300,
    "txIndex": 0,
    "txType": "interaction",
    "contractAddress": "op1sq…",
    "fromAddress": "bc1qsender…",
    "gasUsed": "12000",
    "burnedBitcoin": "800",
    "failed": false,
    "revertReason": null,
    "events": [
      { "eventName": "Swapped", "logIndex": 0, "contractAddress": "op1sq…", "eventRaw": "0x…" }
    ]
  }
}
```

---

### `opstream_getTransactionReceipt`

Rich receipt with tx metadata — superset of `btc_getTransactionReceipt`.
Returns `null` if the tx is not indexed.

**Params:** `[txHash]`

```bash
curl -X POST https://opstream-testnet-production.up.railway.app \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"opstream_getTransactionReceipt","params":["a3f8c1…"]}'
```

---

### `opstream_getTransactionStatus`

Stateless HTTP poll for transaction lifecycle — the CLI / serverless complement to the
`opstream_subscribe("txStatus", …)` WebSocket subscription. Mirrors Alchemy's
`alchemy_getTransactionStatus` pattern.

**Params:** `[txid]`

**Resolution order:**
1. `mempool_pending` table — fast path, covers all states within the 24 h retention window
2. `transactions` table — permanent fallback for confirmed txs after the retention window
3. `"unknown"` — never seen by this node

**Status values:**

| Status | Meaning |
|---|---|
| `"pending"` | In the mempool, not yet in a block |
| `"confirmed"` | Included in a block |
| `"dropped"` | Was in the mempool, then evicted without being confirmed |
| `"unknown"` | Never seen by this OpStream node |

```bash
curl -X POST https://opstream-testnet-production.up.railway.app \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"opstream_getTransactionStatus","params":["a3f8c1…"]}'
```

**Pending:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "txid": "a3f8c1…",
    "status": "pending",
    "blockNumber": null,
    "confirmedAt": null,
    "prunedAt": null
  }
}
```

**Confirmed:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "txid": "a3f8c1…",
    "status": "confirmed",
    "blockNumber": 14300,
    "confirmedAt": 1776216001,
    "prunedAt": null
  }
}
```

**Dropped:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "txid": "a3f8c1…",
    "status": "dropped",
    "blockNumber": null,
    "confirmedAt": null,
    "prunedAt": 1776216050
  }
}
```

> **Note on `confirmedAt`:** If the mempool_pending row was already pruned (older than 24 h)
> and the tx is resolved via the `transactions` table fallback, `confirmedAt` will be `null`
> — the exact confirmation timestamp is no longer available. `blockNumber` will still be set.

> **Use the WS subscription instead** when you have a long-running process (bot, dashboard)
> that is already connected — it pushes the state change the instant it happens rather than
> requiring you to poll. See [websocket.md — txStatus subscription](./websocket.md#txstatus--mempool-lifecycle).

---

### `opstream_getCodeHash`

Returns the bytecode hash for a deployed contract, sourced from the `contract_deployments`
table. Returns `null` if the address is not a known deployment.

**Params:** `[contractAddress]`

```bash
curl -X POST https://opstream-testnet-production.up.railway.app \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"opstream_getCodeHash","params":["op1sq…"]}'
```

```json
{"jsonrpc":"2.0","id":1,"result":"a1b2c3d4e5f6…"}
```

---

## `btc_*` Methods — Served Locally

These use the same method names and response shapes as the upstream OPNET node but are
answered from the local archival index. Any OPNET SDK client can point at OpStream and
get a transparent speedup — no code changes needed.

### `btc_getBlockByNumber`

```bash
curl -X POST https://opstream-testnet-production.up.railway.app \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"btc_getBlockByNumber","params":[14300,false]}'
```

### `btc_getBlockByHash`

```bash
curl -X POST https://opstream-testnet-production.up.railway.app \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"btc_getBlockByHash","params":["00000001ea49…",false]}'
```

### `btc_getTransactionReceipt`

Returns the exact `ITransactionReceipt` shape the OPNET SDK expects.

```bash
curl -X POST https://opstream-testnet-production.up.railway.app \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"btc_getTransactionReceipt","params":["a3f8c1…"]}'
```

---

## `btc_*` Methods — Proxied to Upstream

These require live chain state and are forwarded transparently to the upstream OPNET node.
Any method not in this allowlist returns `-32601 Method not found` locally — no network
round trip wasted on typos.

| Method | Description |
|---|---|
| `btc_blockNumber` | Live chain tip block number |
| `btc_chainId` | Chain ID |
| `btc_call` | Contract read (simulated call, no state change) |
| `btc_getBalance` | Address BTC balance |
| `btc_getStorageAt` | Contract storage slot value |
| `btc_getCode` | Contract bytecode |
| `btc_getTransactionByHash` | Full raw transaction with pow/bytes |
| `btc_sendRawTransaction` | Broadcast a signed transaction |
| `btc_sendRawTransactionPackage` | Broadcast a transaction package |
| `btc_getUTXOs` | UTXOs for an address |
| `btc_getMempoolInfo` | Mempool stats from the Bitcoin node |
| `btc_getPendingTransaction` | Single pending transaction by hash |
| `btc_getLatestPendingTransactions` | Latest batch of pending transactions (Alchemy-style) |
| `btc_preimage` | Preimage lookup |
| `btc_publicKeyInfo` | Public key info |
| `btc_blockWitness` | Block witness data |
| `btc_internal` | Internal OPNET call |
| `btc_latestEpoch` | Latest epoch metadata |
| `btc_getEpochByNumber` | Epoch by number |
| `btc_getEpochByHash` | Epoch by hash |
| `btc_getEpochTemplate` | Current epoch template |
| `btc_submitEpoch` | Submit a new epoch |
| `btc_reorg` | Reorg info |
| `btc_gas` | Gas price estimate |
| `btc_getBlockByChecksum` | Block by OPNET checksum |

```bash
# Example — simulate a contract call
curl -X POST https://opstream-testnet-production.up.railway.app \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0","id":1,"method":"btc_call",
    "params":[{"to":"op1sq…","data":"0x…","from":"bc1q…"}]
  }'

# Example — broadcast a transaction
curl -X POST https://opstream-testnet-production.up.railway.app \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"btc_sendRawTransaction","params":["0200000001…"]}'

# Example — get latest pending OPNET transactions
curl -X POST https://opstream-testnet-production.up.railway.app \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"btc_getLatestPendingTransactions","params":[]}'
```

---

## Error Codes

| Code | Meaning |
|---|---|
| `-32700` | Parse error — malformed JSON |
| `-32600` | Invalid request — not a valid JSON-RPC 2.0 object |
| `-32601` | Method not found |
| `-32602` | Invalid params — also used for range-too-large on `opstream_getBlockRange` |
| `-32603` | Internal error |

When `opstream_getBlockRange` returns `-32602` due to hitting the tx/event limit, the
error message includes a suggested `toBlock` to use as the new upper bound. Halve the
range and retry.

---

## Batch Requests

Send an array of request objects; receive an array of responses in the same order.

```bash
curl -X POST https://opstream-testnet-production.up.railway.app \
  -H "Content-Type: application/json" \
  -d '[
    {"jsonrpc":"2.0","id":1,"method":"opstream_blockNumber","params":[]},
    {"jsonrpc":"2.0","id":2,"method":"opstream_getTransactionStatus","params":["a3f8c1…"]},
    {"jsonrpc":"2.0","id":3,"method":"btc_getMempoolInfo","params":[]}
  ]'
```
