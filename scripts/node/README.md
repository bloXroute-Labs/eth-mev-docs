# Hoodi Spammer (Node.js)

Spam either the **private builder** (only on specified compliance slots) or the **public mempool**.

- **Private mode**: waits for the next `complianceFilter` slot, fires bundles for that slot’s **target block**, and reports whether the tx **landed in that exact slot block**.  
- **Public mode**: sends raw transactions repeatedly until the **time limit**.

---

## Requirements

- Node.js **18+**
- `npm`
- Script file: `hoodi_spammer.js`

Install dependencies:
```bash
npm install


## Quick Start
Run with your config:
```bash
node hoodi_spammer.js -c ./config.public.json
node hoodi_spammer.js -c ./config.private.json

```

Run with a time limit (in seconds):
```bash
node hoodi_spammer.js -c ./config.public.json --duration 900
```

Exit codes
- 0 → included
- 2 → not included / time limit reached

## Configuration
Update config.json
- `mode` -- Indicates whether to use private or public mempool. Options: `private` or `public`
- `readRpcUrl` — JSON-RPC endpoint for reads/receipts (and public sends)
- `privateKey` — 0x-prefixed sender key
- `expectedChainId` — safety check for the RPC
- `recipientAddress`, `transferAmountEth`, `ethGasLimit`
- `minPriorityFeeGwei`, `priorityFeeBufferGwei`, `retryPriorityFeeBumpGwei`, `baseFeeMultiplier`
- `runDurationSecs` — overall time limit (omit/null = no time limit)
- `httpTimeoutSecs` — HTTP timeout seconds

Private mode extra
- `privateRelayUrl` — builder relay URL
- `complianceFilter` — e.g., "f_compliance_1" (only target those slots)
- `validatorListUrl` — schedule source
- `compliancePollIntervalSecs` — poll cadence while waiting
- `slotOffset` — shift the chosen slot by N (usually 0)
- `authorizationHeader` — optional (e.g., "Bearer …")

(Optional) Slot-head sources for logging
- `beaconchainUrl`, `beaconchainLightUrl`, `doraUrl`