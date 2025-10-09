# 1.0 Unified Financial Theory DRAFT
### Egor Homakov / h@xln.finance

### [Optional Q&A](00_QA.md)

This document challenges fundamental assumptions about financial systems. Sacred cows will be slaughtered. If you're emotionally attached to traditional state channels or rollups, you might want to grab a coffee first. 

Traditionally, whitepapers are dry, boring and overloaded with formulas. 
We're doing the opposite: just 3 invariants, ASCII diagrams, VR scenes, lots of visual thinking, and yes - a soundtrack pairing.

Complex systems deserve rich explanations. Finance is music, not math alone.

Core invariants:
1. FCUAN: −Lₗ ≤ Δ ≤ Lᵣ
2. FRPAN: 0 ≤ Δ ≤ C
3. RCPAN ⊇ FCUAN+FRPAP: −Lₗ ≤ Δ ≤ C + Lᵣ

Everything else is commentary.

# Abstract

[pairing: Nils Frahm - Fundamental Values](https://www.youtube.com/watch?v=mOh73eWIk4Q)

In this flagship whitepaper we propose a series of incremental upgrades and simplifications to the status-quo mental model of how financial & organizational double-layered networks work and reasoned about. 

Unified Financial Theory (UFT) naturally integrates or solves at its core some of the most popular and long-standing monetary theories, including but not limited to:

* **Board/Control/Dividend shares** - many companies use Class A/B shares with rigid 1:10 ratio of Dividend-shares (Economical) to Control-shares (Governance). We suggest to decouple them completely into Board shares (immediate executive power over an entity, non-transferrable), Control shares (publicly tradeable tokens, configurable 51%+ quorum can elect a new Board) and Dividend shares (publicly tradeable tokens that are subject to dividends or buybacks). 

* **Algorithmic Index Funds** - in additional to classic index funds (such as Vanguard/BlackRock/StateStreet-ran in TradFi) which are tradeable through a proxy entity and bleed enormous rent-seeker fees, UFT allows personal programmable indexes in-wallet with automatic rebalances. Sovereign nature 

* **The Quantity Theory of Value** - for centuries population was fooled by inflation, when a controlling party unilaterally increased supply of a fungible token. Not just fiat tokens are subject to this, even securities/shares can inflated by the majority decision, effectively stealing the value from the minority holders. We suggest to optionally cement a fixed (e.g. 100T) supply for all Control/Dividend shares for newly formed entities, establishing long term fairness axiom between the majority and minority shareholders. 

* **All Deposit Insurance Schemes (DIS) are Underfunded and Morally Hazardous** - we sidestep the fundamental underfunded flaw (<1% of M2) of DIS schemes by shifting them from industry-forced to private & strictly optional open insurance & reinsurance markets. DIS all over the planet never were and never will be a sound solution due to their "shared pot" morally hazardous architecture.  . It's merely a double-layered smoke-screen to first pockets of commercial bank clients (through quarterly premiums paid by banks to DIS) and then straight to pockets of taxpayers (any "too-big-to-fail" top20 ) and cosmetic "calm-down" figure.

* **The Coase theorem** - Unicast and permisionless nature of Xln allows transactional fees to race to the bottom: absolute zero or even negative (for auto-rebalancing of cross-hub accounts), allowing first truly frictionless Coasian xlnomy. This never was and never will be feasible with Broadcast O(n) design of big-blocker/sharding/rollups – no matter how optimized/parallelized their software or blobspace is overfloated and DAC trust assumptions increased – making Xln simply impossible to compete with in terms of speed and transactional cost.

* **The "Diamond-Dybvig hub run problem"** – cannot be solved completely as long as counterparty risk exists, but greatly alleviated and contained in Xln. By giving the hub (banks+brokers+CEX superset) and its spokes (all users, companies and institutions connecting to the hubs) a new way to cryptographically dispute bilateral accounts, keep guaranteed 2-of-2 escrow collateral and enforce debts over the collateral limit (see enforceDebt() in Depository.sol), we achieve faster and more seamless way to pull liquidity both from the hub to its "libaility" spokes and from the hub's "asset" spokes to the hub. We believe that eventually total counterparty risk will be reduced to ~1-10% of what is currently exposed with unprovable & franctional reserve model.

In parallel, we suggest a practical reference implementation of the theory: extensible layered network (xln): world's first financial substrate that is both most scalable, most secure and mentally simple at the same time.

This way Xln solves Coase theorem by reaching an absolute theoretical minimum of transactional costs. 

Infinite Unicast O(1) scalability: 1,000,000,000+ tps - same as the underlying Internet. Xln is a netting-account layer, same as banking/ACH, where only net collateral settlements and disputes between entities reach the broadcast J-machine level, keeping 99.99% of value transfers private, instant and practically free.

Xln is also unprecedently secure: while every other Broadcast O(n) architecture (big-blockers/sharding/rollups) have long forgoten the maxima "full node on every laptop", RCPAN allows each and every consumer device will be a fully-verifying node of underlying Jurisdiction-machines (with current focus on EVM J-machines: all public EVM chains and future CBDCs)

We will go carefully and incrementally, explaining the rationale & solutions layer by layer. We avoid any practical innovation in the first two chapters. 

In the first chapter we focus exclusively on reducing the overengineered and incomprehendable terminology of both TradFi and DeFi into sound and elegant hierarchical replicated state machine (HRSM) tri-layer: Jurisdictions - Entities - Accounts (JEA). Any financial system under the sun can be expressed in JEA terms. 

In second chapter we generalize all world's financial Unicast systems into two major categories: full-credit unprovable account networks (FCUAN: all banking, brokers and CEX) and full-reserve provable account networks (FRPAN: Lightning/Raiden/Hydra/other channel networks).

In third chapter, we introduce our main innovation, the superset invariant **reserve-credit provable account network RCPAN ⊇ FCUAN+FRPAP**

`−Lₗ ≤ Δ ≤ C + Lᵣ`

xln is the first RCPAN (Reserve-Credit, Provable Account Network): credit where it scales, collateral where it secures—a principled hybrid of FCUAN and FRPAP.

```
FCUAN invariant:
−leftCreditLimit ≤ Δ ≤ rightCreditLimit
[---.---]

FRPAP invariant:
0 ≤ Δ ≤ collateral
[.===]

RCPAN (xln) superset invariant:
−leftCreditLimit ≤ Δ ≤ collateral + rightCreditLimit
[---.===---]
```

Additional whitepapers that further complement UFT are published separately:

* **2.0 Cascade Security Model**: we extend the credit+collateral RCPAN invariant with "on-jurisdiction reserves" and opt-in Deposit Insurance Schemes forming a waterfall-like security cascade for all fungible value any entity in Xln holds: reserve->collateral->credit->insurance->reinsurance. 

* **3.0 Delta Transformers**: generalized way to Bilateral Unicast DeFi: programmable cascade of hooks `int[] deltas -> Transformer.apply(data, leftArguments, rightArguments) -> int[] deltas` that entities simulate off-J but can routinely enforce with Depository.sol during on-J dispute. Transformers allow Lego-DeFi logic of any complexity but in bilateral 2-party fashion (same as how TradFi worked for centuries).

* **4.0 Entity machine, Hanko signatures & Cascade Control Model**: a deeper dive into Board/Control/Dividend cascade, a novel hierarchical aggregated Hanko-signature for Entity-machines and Merge&Acquisition, index funds and institutional mechanics of Xln. 

* **5.0 BrainVault**: argon2id(username, password, complexityFactor ~5sec...5hours) - in addition to cumbersome randomly generated 16-word seeds users may prefer the longer but easier to handle option. Just like RCPAN accounts are "payment channels done right" we propose a secure evolution of BrainWallet/WarpWallet idea.


* **6.0 Hierarchical Replicated State Machines & Cascade Execution Model**: in this paper we do a deep dive into how Xln is actually built as a tri-layer cascade of Server->Entity->Account machines, which provides unprecedented introspection into the system, ease of debug and reasoning about.  

[1.1 Jurisdiction Machine](11_Jurisdiction_Machine.md)