# Prior Art

Xln is built on shoulders of giants.

## Bitcoin

Satoshi Nakamoto is genius for creating the replicated state machine (RSM) movement. For making people even ask and wonder why do we keep our entire net-worth in hands of unprovable custodial state machines. 

## Ethereum

Vitalik Buterin is genius for inventing Turing-complete programmable RSM: EVM (Ethereum Virtual Machine). EVM is our reference adapter Jurisdiction machine in J-REA stack. Its yellowpaper alone changed the course of human history forever. 
Unfortunatelly, we believe his & EF team narrative about plasma, rollups, DAC/DAS are not an endgame. It feels like a costly detour and dead-end research trap. **All broadcast O(n) designs are fundamentally bottlenecked in scalability and mathematically flawed with data availability paradox.**

Their goals are noble: trustless exitable layer2. But their means are mathematically handicapped. Broadcast-J-shared-state just cannot have planetary scale. Neither directly (big blockers) nor through blob-checkpointing surrogates. There is nothing you can do about it. 

The unicast bilateral state approach completely side-steps this problem.

No amount of DAC/DAS/erasure coding assumption cascades can solve that. **Those are very intellectually interesting problems to work on, but they are perpetuum mobile in a nutshell.**


Ethereum: 15 TPS global
XLN on Ethereum: Millions of TPS bilateral (O(1) per entity pair)

Solana: 3000 TPS global  
XLN on Solana: Still millions of TPS bilateral

Conclusion: Base layer TPS is IRRELEVANT for XLN.


## Lightning Network



## Ronald Coase

##  Douglas Diamond, Philip H. Dybvig, Ben Bernanke





We are turn existing RSM into J-REA two-layered stack. 
Banking: "Trust us with your money"
XLN: "Same UX, but you can exit anytime with cryptographic proof"

Binance: "We're totally not fractional reserve"
XLN: "Here's the on-chain collateral, verify yourself"

SWIFT: "$30 fee, 3 days"
XLN: "$0.00001 fee, 3 seconds"
```

## Against Rollups
```
Rollups: "We'll decentralize the sequencer someday™"
XLN: "No sequencer needed"

Rollups: "Trust our data availability committee"
XLN: "Your counterparty IS your data availability"

Rollups: "Pay $0.10 per tx for blob space"
XLN: "Pay $0 until you need to rebalance (rare)"