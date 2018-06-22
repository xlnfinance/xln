# Extended Lightning Network and Fairlayer 

## Abstract

In this document we're going to propose a concept and its implementation: a non-opinionated Layer2 scalability technique for blockchains **Extended Lightning Network (XLN)** and opinionated two-layered payment network **Fairlayer**, which is the first blockchain to implement XLN out-of-box.

The novelty of XLN idea is extending the original Lightning Network with credit lines on both sides of a payment channel to solve (or at least significantly alleviate) the capacity problem of LN (the requirement for locking up funds). With credit lines the capacity problem of payment channels is shifted from onchain defined to trust/risk-defined. We believe a payment with higher risk involved is better than no payment at all, which is a common problem with original Lightning.

Fairlayer, on another hand, is a quite opinionated XLN implementation that aims to fix other issues with blockchains other than just scalability. Some parts of Fairlayer such as Proof-of-Authority can come off as controversary, but bear in mind XLN (the generic scaling concept) can be immitated on top of Bitcoin and most of other blockchains albeit in a much more limited fashion than Fairlayer does it.

Our paramount priority is security and censorship resistance even from validator majority, which is why we require absolutely all nodes including consumer devices to be a fully-verifying nodes, Spv. Thankfully, our full node is designed to routinely run on everything from cheap smartphones to cloud servers and the first "Fair" layer is cheap to keep up with.

**This is the reference client** so there is no extensive specification. If you want to learn how something works just look into the code.

[1. Channels](/1_channels.md)

[2. Hashlocks](/2_hashlocks.md)

[3. Rebalance](/3_rebalance.md)

[4. Four balances](/4_four_balances.md)

[5. Consensus](/5_consensus.md)

[6. Smart updates](/6_smart_updates.md)

[7. Other differences](/7_other_differences.md)

[8. Roadmap](/8_roadmap.md)

[9. Receive and Pay API](/9_receive_and_pay.md)

[10. Development](/10_genesis.md)



