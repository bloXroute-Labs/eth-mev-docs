# Region Locking Builder Submission

Builders can now **lock their bids** to specific relay instances or regions by including a `share` header in their HTTP or gRPC block submissions.

---

## `share` Header Options

### Global Sharing Options
- `"share": "all"`     - Shares the bid with **all relay/rproxy**.
- `"share": "none"`.   - Shares the bid **only** with the relay or rproxy where it was submitted.
- `"share": "proxies"` - Shares the bid with the **submitted relay/rproxy instance** and **all rproxies**.
- `"share": "closest"` - Shares the bid with the **closest rproxy instances**, but **not** with the main US relay.

### Specific Regions
You can target individual instances by specifying the region name:
- `"share": "virginia"` - Shares the bid with both virginia rproxy and virginia main relay.
- `"share": "oregon"`
- `"share": "frankfurt"`
- `"share": "paris"`
- `"share": "dublin"`
- `"share": "hongkong"`
- `"share": "singapore"`
- `"share": "tokyo"`
- `"share": "sydney"`

### Grouped Regions
- `"share": "na"` - Shares the bid with virginia and oregon relay/rproxy instances
- `"share": "eu"` - Shares the bid with paris, dublin, and frankfurt relay/rproxy instances
- `"share": "as"` - Shares the bid with tokyo, hongkong, and singapore relay/rproxy instances
- `"share": "oc"` - Shares the bid with sydney relay/rproxy instances

### Combining Multiple Targets
You can submit to **multiple locations** by separating values with commas:
```json
"share": "tokyo,singapore,virginia"
```
or 
```json
"share": "eu,singapore,virginia"
```

### Default Behavior

If no `share` header is specified in the block submission, it will **default to**:

```json
"share": "all"
```

This means the bid will be shared with **all relays and rproxies**.

### FAQ
1. If a block submission is sent directly to the main relay with no share value, will it be shared outside of the US?

Yes, a bid sent to the main relay with no share value will by default be shared to all rproxies/relays. 

2. If a block submission is sent directly to frankfurt rproxy with a share value of "share"="none" will it still be shared to other rproxies?

No, any bid sent to a relay/rproxy with a share value of "share"="none" will be region locked to that relay/rproxy and not shared to any other relay/rproxy.



---
