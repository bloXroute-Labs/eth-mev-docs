# Hoodi Spammer (Node.js)

Spam either the **private builder** (only on specified compliance slots) or the **public mempool**.

- **Private mode**: waits for the next `complianceFilter` slot, fires bundles for that slot’s **target block**, and reports whether the tx **landed in that exact slot block**.  
- **Public mode**: sends raw transactions repeatedly until the **time limit**.

---

## Requirements
- Node.js **18+**
- `npm`

## Installation
Clone the repo and install dependencies:
```bash
git clone git@github.com:bloXroute-Labs/eth-mev-docs.git
cd eth-mev-docs/scripts/node
npm install
```

## Quick Start
Update the config.json and replace/update lines as needed

Run with your config:
```bash
# spam the public mempool
node hoodi_spammer.js -c ./config.public.json

# or spam the private mempool
node hoodi_spammer.js -c ./config.private.json
```

Run with a time limit (in seconds):
```bash
# spam the public mempool
node hoodi_spammer.js -c ./config.public.json --duration 900

# spam the private mempool
node hoodi_spammer.js -c ./config.private.json --duration 900
```

Exit codes
- 0 → included
- 2 → not included / time limit reached

## Configuration

Update `config.json` (or create `config.private.json` / `config.public.json`) with the fields below.

### Common
- **`mode`** — `"private"` or `"public"`
- **`readRpcUrl`** — JSON-RPC endpoint for reads/receipts (and public sends)
- **`privateKey`** — 0x-prefixed sender key (keep private)
- **`expectedChainId`** — safety check for the RPC
- **`recipientAddress`** — destination address for the transfer (the final receiver)
- **`transferAmountEth`** — amount (string) in ETH, e.g. `"0.25"`
- **`ethGasLimit`** — gas limit for ETH transfers
- **`asset`** — `"ETH"` or `"WETH"`
  - if `"WETH"`: requires `wethAddress` (the WETH contract), `erc20GasLimit`, and `wrapGasLimit`
- **`minPriorityFeeGwei`**, **`priorityFeeBufferGwei`**, **`retryPriorityFeeBumpGwei`**, **`baseFeeMultiplier`** — fee knobs
- **`runDurationSecs`** — overall time limit in seconds (omit/null = no time limit)
- **`httpTimeoutSecs`** — HTTP timeout seconds for RPC/relay calls

### Private mode
- **`privateRelayUrl`** — builder relay URL
- **`validatorListUrl`** — schedule source
- **`complianceFilter`** — optional string (e.g. `"f_compliance_1"`)
  - present → only target matching slots  
  - omitted/empty → target **all** upcoming slots
- **`compliancePollIntervalSecs`** — refresh cadence while waiting
- **`authorizationHeader`** — optional (e.g., `"Bearer …"`)

### Slot-head sources (optional, for logs/clock)
- **`beaconchainUrl`**
- **`beaconchainLightUrl`**
- **`doraUrl`**

### Performance / timing overrides (optional)
Defaults are sane; override only if needed:
- **`bundleIntervalMs`** — (default `3000`) ms to wait before sending another bundle in a slot
- **`maxBundlePerSlot`** — (default `0`) 0 means no cap on number of bundles to submit per slot
- **`preSlotLeadMs`** — (default `1100`) ms before slot boundary to begin sending
- **`maxSlotsPerCycle`** — (default `8`) cap number of upcoming slots targeted per scheduling cycle (ALL-SLOTS mode)
- **`idleRetryMs`** — (default `1200`) delay between polls when idle
- **`relayPostTimeoutMs`** — (default `400`) timeout for relay POST
- **`postBlockReceiptWaitMs`** — (default `7000`) wait after target block for receipt inclusion
