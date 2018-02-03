[![JavaScript Style Guide](https://cdn.rawgit.com/standard/standard/master/badge.svg)](https://github.com/standard/standard)


# Failsafe Network

Failsafe is a new **scalable blockchain** that comes with Lightning-inspired offchain layer out-of-box. It fixes the liquidity problem - Failsafe state channels support transfering beyond the capacity (insurance), which induces manageable risk and removes scalability caps.

Failsafe has no virtual machine for smart contracts, instead uses onchain governance and  amendments to implement new functionality.

Failsafe has **a native token FSD to pay for transaction fees** and hub fees for transfer mediations, but the goal is to focus on 3rd party issued tokens (just like issuances in Ripple): **to move bank-backed and government-backed fiat currencies to our blockchain** which ensures fairness and security of first layer yet providing all the needed controls and introspection for financial institutions to remain compliant.

Unlike "fake" bloated blockchains with high tps, in Failsafe the tokens are transfered instantly **offchain through the hubs** and hubs are responsible for rebalancing "insurances" onchain to reduce the collective risk over time. **This allows 1,000,000+ transactions per second with a hub-and-spoke topology of hubs.** It is the same how the Internet topology looks like, and it also has no central point of failure.

You can think of it as FDIC insurance, but not up to a specific amount of $250k - instead it can be any user-chosen amount, and the rules are seamlessly enforced by the blockchain instead of the government. You can always enforce and take your money from one hub and send to another.

## High Level Roadmap

Off-chain layers design is a hard problem. Here are some trade-offs to deliver usable product as soon as possible:

* Online payments is the priority. Implement SDKs for all major payment platforms and shops.

* Point-of-Sale terminal are a long-distance idea. 

* Starting with Linux/macOS/Windows clients only. Web clients are insecure and therefore prohibited. Mobile clients are inevitable, but there's no sensible security model for a blockchain to run inside mobile app, so proper mobile full nodes are delayed to ~2020.

* Starting with single asset FSD. Start supporting configurable assets/issuances/tokens by 2019

* Starting with single @1 hub. Introduce hub creation by anyone and multihub network by 2019

* All payments are not hashlocked now (the hub is trusted mediator). By 2019 support hashlocks for high-value transfers.

* Trustless asset exchange (atomic offchain swaps) by 2020


## Simnet

Look into `simulate` and install ttab for convenient debugging. 

Basically it creates new root member and copy-paste the folder into 8001, 8002 etc, folder name is the port for convenience. 

Latest Node.js is a must.

## What is it? Docs?

See <a href="https://github.com/failsafenetwork/failsafe/wiki">Wiki</a>

