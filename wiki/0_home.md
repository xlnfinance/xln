# Extended Lightning Network and Fairlayer 

## Abstract

In this document we're going to propose a concept and its implementation: a non-opinionated Layer2 scalability technique for blockchains **Extended Lightning Network (XLN)** and opinionated two-layered payment network **Fairlayer**, which is the first blockchain to implement XLN out-of-box.

The novelty of XLN idea is extending the original Lightning Network with credit lines on both sides of a payment channel to solve (or at least significantly alleviate) the capacity problem of LN (the requirement for locking up funds). With credit lines the capacity problem of payment channels is shifted from onchain defined to trust/risk-defined. We believe a payment with higher risk involved is better than no payment at all, which is a common problem with original Lightning.

Fairlayer, on another hand, is a quite opinionated XLN implementation that aims to fix other issues with blockchains other than just scalability. Some parts of Fairlayer such as Proof-of-Authority can come off as controversary, but bear in mind XLN (the generic scaling concept) can be immitated on top of Bitcoin and most of other blockchains albeit in a much more limited fashion than Fairlayer does it.

Our paramount priority is security and censorship resistance even from validator majority, which is why we require absolutely all nodes including consumer devices to be a fully-verifying nodes, Spv. Thankfully, our full node is designed to routinely run on everything from cheap smartphones to cloud servers and the first "Fair" layer is cheap to keep up with.

**This is the reference client** and no formal specification is planned. If you want to learn how something works just look into the code.

Fairlayer is developed entirely as an end-to-end solution having a full-node, layer2 protocol and user wallet all under one roof working seamlessly. Isomorphic codebase covers different use cases: a wallet, an explorer, a hub and a validator node etc. 

There are no smart contracts and no VM to develop upon, but feel free to submit a **smart update** and see if onchain governance approves it.

This wiki intends to be single source of documentation, better read it in this order:

[1. Payment Channels](/wiki/1_channels.md)

[2. Hashlocks for Atomic Transfers](/wiki/2_hashlocks.md)

[3. Rebalance: insure the uninsured](/wiki/3_rebalance.md)

[4. Four balances: onchain, insured, uninsured, trusted](/wiki/4_four_balances.md)

[5. Consensus: Tendermint + PoA](/wiki/5_consensus.md)

[6. Smart contracts? Smart updates!](/wiki/6_smart_updates.md)

[7. What makes Fairlayer different](/wiki/7_other_differences.md)

[8. Roadmap](/wiki/8_roadmap.md)

[9. Receive/Pay API](/wiki/9_receive_and_pay.md)

[10. Development Guide](/wiki/10_genesis.md)



