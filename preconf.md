---
description: >-
  bloXroute  now supports  pre-confirmation solutions for both Primev and
  Chainbound. Below is an overview of how our integration works.
---

# Preconfirmations

***

### Primev Integration <a href="#primev-integration" id="primev-integration"></a>

#### About Primev <a href="#about-primev" id="about-primev"></a>

**Primev** is an infrastructure provider offering pre-confirmation capabilities on Ethereum. They operate a custom chain alongside a set of Ethereum smart contracts to coordinate builder and validator participation in their preconf ecosystem.

#### Our Integration <a href="#our-integration" id="our-integration"></a>

**Validator Tracking (Ethereum Mainnet)**

* We reference Primev’s validator opt-in contract on Ethereum Mainnet:\
  `0x821798d7b9d57dF7Ed7616ef9111A616aB19ed64`
* A helper function is used to query validator participation status.
* This contract maintains a list of validators who have opted into Primev’s pre-confirmation program.

**Builder Tracking (Primev Custom Chain)**

* Primev maintains a contract on their own chain to track builder opt-in status:\
  `0xb772Add4718E5BD6Fe57Fb486A6f7f008E52167E`
* Builders are mapped to externally owned accounts (EOAs) via a helper function that converts their public key to an address.
* We query this contract through their public RPC endpoint:\
  `wss://chainrpc-wss.mev-commit.xyz`

**Validation Checks**

* Once per epoch, we validate the opt-in status of all known validators and builders.
* This polling-based model ensures data consistency without requiring persistent event listeners.

***

### Chainbound Integration <a href="#chainbound-integration" id="chainbound-integration"></a>

#### About Chainbound <a href="#about-chainbound" id="about-chainbound"></a>

**Chainbound** is another provider building a pre-confirmation solution for Ethereum, called **Commit-Boost**. Their focus is on enabling block builders to provide pre-confirmations directly to searchers and users, without requiring validator coordination. Chainbound’s architecture is designed to integrate seamlessly with builder workflows, offering lighter-weight guarantees and flexible integration points.

#### Our Integration <a href="#our-integration.1" id="our-integration.1"></a>

We’ve added support for Chainbound’s Commit-Boost protocol within our pre-confirmation infrastructure. It allows validators to manage proposer commitments—such as pre-confirmations—using a modular and extensible framework, without requiring coordination with external contracts or RPC endpoints.

Commit-Boost is designed to:

* Run as a sidecar next to MEV-Boost or without.
* Provide a unified platform for validator commitments (e.g., inclusion guarantees, blockspace futures).
* Be extensible via plug-and-play modules.
* Avoid fragmentation or duplicated infrastructure.

***

### Technical References <a href="#technical-references" id="technical-references"></a>

**Primev:**

* RPC endpoint: `wss://chainrpc-wss.mev-commit.xyz`
* Validator opt-in contract: `0x821798d7b9d57dF7Ed7616ef9111A616aB19ed64`
* Builder opt-in contract (Primev chain): `0xb772Add4718E5BD6Fe57Fb486A6f7f008E52167E`

**Chainbound:**

* No RPC endpoint or smart contract required.
* Uses Commit-Boost sidecar alongside or independent off MEV-Boost.

***

If you're a builder and would like to begin submitting pre-confirmations via bloXroute’s infrastructure, reach out to `support@bloxroute.com` for integration support, specs, and test endpoints.

