# Mev Protect

Currently on Ethereum, proposers either accept the most favorable block offered by the relays or propose a self-made block. By default, there is nothing preventing builders from retaining as much block value as possible for themselves, as long as other builders provide less favorable blocks. To overcome this, bloXroute relays offer the option for proposers to refuse blocks that pay proposers less than 90% of the block value unless additional payment is offered. This means that the validator will be served blocks with over 90% of block profit. Whitelisted block builders will be subjected to a fee in order to submit blocks paying less than 90% of the block value to the proposer. This payment fee is a payment to the validator and relay in the same block.


## Builder Technical implementation

### Retrieving Mev Protect Status
Builders are able to retrieve the mev_protect status using the normal builder validator data endpoint
`/relay/v1/builder/validators`

The builder receives a JSON array of GetValidatorRelayResponse objects

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

The enforced_profit_ratio 64-bit unsigned integer represents the percent of the block value required to be given to the proposer in the block. 

### Building Mev Protected Blocks

In order for a block to be valid as an MEV-Protect block, it must meet the proposer profit threshold for that block which is 90%, as represented by enforced_profit_ratio. Note that slots not protected by MEV-Protect will have an enforced_profit_ratio value of 0. The enforced_profit_ratio 64-bit unsigned integer represents the percent of the block value required to be given to the proposer in the block. Block Profit is calculated as follows:

```
BlockValue = Value Transferred to Validator's Fee Recipient
BuilderValue = (Coinbase Balance @ Block n) - (Coinbase Balance @ Block n-1)
BlockProfit = BuilderValue + BlockValue
```

If the BlockValue is less than 90% of the BlockProfit, builders will be required to transfer a 33% fee of BuilderValue to the relay and a 33% fee of BuilderValue to the validator. At the start, only whitelisted block builders will be allowed to submit blocks within this range, non-whitelisted builders with blocks in this range will be rejected. Please contact bloXroute to be added to the whitelist.

For bloXroute relay payment fee address , please use 0x367DB1AD831E4284ab1381EE6EeC81Eae6BD94a0. Once more relays join the pilot, we will replace this address with a relay guilt wallet.

### Validating Mev Protected Blocks

When a mev protected block is sent to the relay, the relay return a 200 OK for mev protected blocks and a 406 error code for invalid blocks.

An invalid block will return with a message value of the following:
```
"proposer mev protect is enabled for the slot duty, but the builder did not opt-in to it. Please contact bloxroute to learn more about supporting MEV Protect feature. This block was accepted but may be rejected in the future."

or 

"Mev protected block invalid due to the following: expected value atleast <expectedBlockValue> got <value> with blockProfit <blockProfit>. Expected ratio atleast <enforced_profit_ratio (90)> got <calculated ratio>. 
```


## Relay Technical Implementation

### Validating Mev Protect

Relays are required to validate that mev protect slots only receive blocks that are above the expected threshold using the following formula unless additional payment is offered. Optimistic builders are required to still have their blocks validated:

```
func ValidateMevProtect(blockValue, coinbaseBefore, coinbaseAfter, enforcedProfitRatio int) bool {
	builderValue := coinbaseAfter - coinbaseBefore
	blockProfit := builderValue + blockValue

	if builderValue / blockProfit < enforcedProfitRatio {
		return false
	}
	return true
}
```

- `blockValue` is the usual value that goes to the validator in the last transaction of the block.
- `coinbaseBefore` is the balance of the builder's address at the end of the prior block.
- `coinbaseAfter` is the balance of the builder's address at the end of the current block.
- `enforcedProfitRatio` is a value between 0 and 100 that is the required ratio that the builder must send to the validator. 

### Optimistic Mev Protect

To enable optimistic mev protected blocks, builders can signal to the relay that blocks satisfy the expected threshold or additional payment is offered. Optimistic blocks that land onchain will be validated after the payload has been delivered to the validator. If the block fails validation, the builder is expected to refund the validator the difference. 

Builders can enable optimistic mev protect with the following:

- When submitting via HTTP: attach a proposer-mev-protect header, with the value set to true.
- When submitting via websocket: attach a proposer-mev-protect header, with the value set to true.
- When submitting via gRPC*: you must set the ProposerMevProtect field of the SubmitBlockRequest struct to true.

