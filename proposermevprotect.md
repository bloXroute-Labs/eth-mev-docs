# Proposer Mev Protect

On Ethereum, proposers typically either accept the most favorable block offered by relays or propose a self-built block. Currently, nothing prevents builders from capturing nearly all of the block value for themselves—as long as other builders offer less favorable bids.

**Proposer MEV Protect** lets validators refuse any block that pays them less than **90%** of the total block profit, unless the builder pays an additional fee. Whitelisted builders may still submit below-threshold blocks but must cover the shortfall. This ensures proposers receive a fair share of MEV.

## Diagram Overview

![Proposer Mev Protect Overview](/mevprotect.png)

## Builder Technical Implementation

### 1. Retrieving MEV Protect Status
Builders can retrieve MEV Protect status via the existing endpoint:

```http
GET /relay/v1/builder/validators
```

**Sample response**:

```json
[
    {
        "slot": "764671",
        "validator_index": "910253",
        "entry": {
        "message": {
            "fee_recipient": "0xE99Ba8bd1Af574a60836981FD7E5E4De0d49eB53",
            "gas_limit": "30000000",
            "timestamp": "1747763488",
            "pubkey": "0x943f5b53be85b0cd471c6bf9162c44ad1bb59b02228d4ecc87cc91e0996149e2be8f3d207024f989545daa0c18b2fd4c"
        },
        "signature": "0x8a178a0386ac9a3a4c576747b99dcc1dab85bab585a8b5f8d0be3d1ac07773604028357adc4f74734aed63f13c37f63b1067ac887f6a5b85179a680c398465e85263caa1f0ea3df814333f2e463fe6c1636daed880f4fa597ebd1ca541db92ef"
        },
        "compliance_list": "ofac",
        "enforced_profit_ratio": 90
    }
]
```

- **`enforced_profit_ratio`**: 64-bit unsigned integer, minimum percent of block profit required for the proposer.

### 2. Building MEV-Protected Blocks

A valid MEV-Protect block must allocate at least 90% of its total profit to the proposer, as defined by the enforced_profit_ratio field. Slots where MEV-Protect is disabled will have `enforced_profit_ratio = 0`. This 64-bit unsigned integer specifies the minimum percentage of the block’s value that must be paid to the proposer. Block profit is calculated as follows with an example provided below:

```
BlockValue   = ETH sent to validator's fee recipient
BuilderValue = Sum of all inflows to the coinbase address minus the BlockValue.
BlockProfit  = BuilderValue + BlockValue
```

If `BlockValue < enforced_profit_ratio%` of `BlockProfit`:

- Builder pays **33% of BuilderValue** to the relay  
- Builder pays **33% of BuilderValue** to the validator  

> ⚠️ Only **whitelisted builders** may submit below-threshold blocks. All others will be rejected.

**Temporary relay payment address**:

```text
0x367DB1AD831E4284ab1381EE6EeC81Eae6BD94a0
```
---

#### Example:

A block contains 4 transactions:
```
TX1: User sends 1 ETH to coinbaseAddress
TX2: User sends 0.4 ETH to another user, pays 0.1 ETH fee (to coinbaseAddress)
TX3: coinbaseAddress sends 0.3 ETH to another address (ignored in builderValue)
TX4: Builder pays 0.6 ETH to the validator
```

In this example: TX1 contains an inflow of 1 ETH, TX2 contains an inflow of 0.1 ETH, TX3 contains 0 inflow, TX4 is a 0.6 ETH transfer to the fee recipient.
```
BlockValue = 0.6 ETH
BuilderValue = (1 + 0.1 + 0) - 0.6 = 0.5 ETH
BlockProfit = 0.6 + 0.5 = 1.1 ETH
Ratio = 0.6/1.1= 54%
```
Since the builder paid 54% of the blockProfit to the validator, this is below the 90% threshold and would be rejected unless the builder was whitelisted and provided additional payment to the validator and relay. 

The minimum accepted block value for non-whitelisted builders is 0.99 ETH in this example. 

### 3. Validating Block Submission

- **Valid block** → `200 OK`  
- **Invalid block** → `406 Not Acceptable`

**Example error messages**:

```text
"Proposer MEV Protect is enabled for this slot duty but the block is invalid: expected >= <expectedValue> (ratio <enforced>), got <value> (ratio <calculated>). This block was accepted but may be rejected in the future. Please contact bloXroute to learn more about supporting MEV Protect feature. "
```

```text
"Proposer MEV Protect is enabled for this slot duty but the block is invalid: expected >= <expectedValue> (ratio <enforced>), got <value> (ratio <calculated>). "
```
---


## Relay Technical Implementation

### 1. Registering MEV Protect Preference
Validators are able to register their proposer mev protect status by including `proposer_mev_protect=true` in the query params in the normal registration api `/eth/v1/builder/validators` 

```http
POST /eth/v1/builder/validators?proposer_mev_protect=true
```

**Go handler example**:

```go
proposerMevProtectQuery := req.URL.Query().Get("proposer_mev_protect")
proposerMevProtect, _ := strconv.ParseBool(proposerMevProtectQuery)
if proposerMevProtect {
    log.Info().Msg("MEV Protect enabled for proposer")
    SaveMevProtectStatus()
} else {
    log.Info().Msg("MEV Protect disabled for proposer")
}
```

### 2. Validating MEV-Protected Blocks

Relays must enforce MEV Protect by only accepting blocks for protected slots that meet or exceed the required profit threshold (calculated with the formula below). Even optimistic builders—those who signal they satisfy the threshold—are still subject to the same validation process.

```go
func ValidateMevProtect(blockValue, enforcedRatio int, txs []Transactions) bool {
    builderValue := {Sum of all txs inflows to the coinbase address minus the BlockValue}
    blockProfit  := builderValue + blockValue
    // Must pay proposer ≥ enforcedRatio% of blockProfit
    return (blockValue * 100 / blockProfit) >= enforcedRatio
}
```

- **`blockValue`**: ETH sent to validator in the last transaction of the block
- **`enforcedRatio`**: required proposer profit ratio (0–100)

#### Example:

A block contains 4 transactions:
```
TX1: User sends 1 ETH to coinbaseAddress
TX2: User sends 0.4 ETH to another user, pays 0.1 ETH fee (to coinbaseAddress)
TX3: coinbaseAddress sends 0.3 ETH to another address (ignored in builderValue)
TX4: Builder pays 0.6 ETH to the validator
```

In this example: TX1 contains an inflow of 1 ETH, TX2 contains an inflow of 0.1 ETH, TX3 contains 0 inflow, TX4 is a 0.6 ETH transfer to the fee recipient.
```
BlockValue = 0.6 ETH
BuilderValue = (1 + 0.1 + 0) - 0.6 = 0.5 ETH
BlockProfit = 0.6 + 0.5 = 1.1 ETH
Ratio = 0.6/1.1= 54%
```
Since the builder paid 54% of the blockProfit to the validator, this is below the 90% threshold and would be rejected unless the builder was whitelisted and provided additional payment to the validator and relay. 

The minimum accepted block value for non-whitelisted builders is 0.99 ETH in this example. 



### 3. Optimistic MEV Protect

To enable optimistic mev protected blocks, builders can signal to the relay that blocks satisfy the expected threshold or additional payment is offered. These blocks are **validated after on-chain inclusion**; failures require a refund.

- **HTTP / WebSocket header**:
  ```
  proposer-mev-protect: true
  ```
- **gRPC**:
  ```go
  SubmitBlockRequest.ProposerMevProtect = true
  ```

---

## Summary

| Component        | Requirement                                                             |
|------------------|-------------------------------------------------------------------------|
| **Builder**      | Must ensure proposer gets ≥ 90% of block profit or pay penalty fees    |
| **Validator**    | Register MEV Protect status on validator registration                  |
| **Relay**        | Validate profit ratio and enforce whitelist for under-threshold blocks |
| **Optimistic**   | Builders opt in; refund if post-inclusion validation fails             |

> For whitelisting or support, contact **bloXroute**.
