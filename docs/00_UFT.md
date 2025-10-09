# Unified Financial Theory

`−Lₗ ≤ Δ ≤ C + Lᵣ`

### Egor Homakov / h@xln.finance

## Preface

Lets briefly elaborate my intrinsic motivation to creating UFT/Xln. I started my path in JS/PHP/Ruby on Rails software engineering circa 2007.

In 2012, I've stumbled upon a fundamental insecure-by-default pattern in Rails called mass assignment and inappropriately hacked Github to make my point. Ever since I was addicted to finding not just one-off bugs, but systemic issues in protocols and improving software architecture as a whole.

Then I founded Sakurity, organised boutique audits for some of the big names in the startup industry. Things went good. Around 2017 I've decided to retire from audits and focus on the most important yet most vulnerable and misdesign-ridden protocol on the planet – our financial system, both TradFi and DeFi (I view them as two parts of the whole). 

It all started with reading the Lightning Network whitepaper and realizing: the authors (Joseph Poon, Thaddeus Dryja) invented the genius wheel (proofs + collateral + delta transformer primitives) but tried to make an obviously delusional "unicycle" out of this wheel (full-reserve account network, has no working incentive model, can't scale). 

This is when the core of Xln was formed: molding together the most scalable & used Unicast full-credit architecture (custodial/banking/CEX network of accounts) with the most secure but misunderstood Layer2 technology (full-reserve payment/state channels). The RCPAN invariant `−Lₗ ≤ Δ ≤ C + Lᵣ` was born on Aug 24, 2017.

### Should I read it?

If you're willing to bend your mental models around the status quo, embrace our contrarian yet factually correct rhetoric, ready to research into unknown and question the dogmas from first principles - yes.

If you don't have time for 30-60 min deep reading - **spend 5 minutes on understanding core RCPAN invariant** and save the rest of the document for the future. 

The UFT (theory) and Xln (practical reference implementation) is my magnum opus and quintessence of 9 years of research into TradFi/RTGS/DeFi/DAO/AA/institutional governance/payment channels. 

I believe it's a 1000x times more important than all of my infosec research, combined. Call me delusional, but I just happen to be right eventually.

### How to read it

The documents are a little heavy on technical & financial terminology. This is intentional - instead of making it a tedious long read "for the general crowd", it seemed like a better idea to make it concentrated and to the point, letting readers ask an LLM of their choice to expand on any idea / statement, with targeted prompts like "ELI5?", "I'm a banker, what is it?", "I'm a protocols engineer, what's under the hood?".

There will be more approachable and elaborated versions of it soon. Feel free to create your own adaptaion, though!

**Start with "should I read it and why?" with any frontier language model.** GPT-5/Claude/Grok/Gemini/Qwen/GLM – all have phenomenal understanding of UFT/Xln once you attach the whitepapers as context. 

Feel free to reach out directly if after 3-5 prompts the answers still seem cryptic to you. 

#  Abstract

In this flagship whitepaper we propose a series of incremental upgrades and simplifications to the status-quo mental model of how financial & organizational double-layered networks work and reasoned about. 

Unified Financial Theory (UFT) naturally integrates or solves at its core some of the most popular and long-standing monetary theories, including but not limited to:

* Board/Control/Dividend shares - many companies use Class A/B shares with rigid 1:10 ratio of Dividend-shares (Economical) to Control-shares (Governance). We suggest to decouple them completely into Board shares (immediate executive power over an entity, non-transferrable), Control shares (publicly tradeable tokens, configurable 51%+ quorum can elect a new Board) and Dividend shares (publicly tradeable tokens that are subject to dividends or buybacks). 

* Algorithmic Index Funds - in additional to classic index funds (such as Vanguard/BlackRock/StateStreet-ran in TradFi) which are tradeable through a proxy entity and bleed enormous rent-seeker fees, UFT allows personal programmable indexes in-wallet with automatic rebalances. Sovereign nature 

* Quantity Theory of Value - for centuries population was fooled by inflation, when a controlling party unilaterally increased supply of a fungible token. Not just fiat tokens are subject to this, even securities/shares can inflated by the majority decision, effectively stealing the value from the minority holders. We suggest to optionally cement a fixed (e.g. 100T) supply for all Control/Dividend shares for newly formed entities, establishing long term fairness axiom between the majority and minority shareholders. 

* All Deposit Insurance Schemes (DIS) are Underfunded and Morally Hazardous - we sidestep the fundamental underfunded flaw (<1% of M2) of DIS schemes by shifting them from industry-forced to private & strictly optional open insurance & reinsurance markets. DIS all over the planet never were and never will be a sound solution due to their "shared pot" morally hazardous architecture.  . It's merely a double-layered smoke-screen to first pockets of commercial bank clients (through quarterly premiums paid by banks to DIS) and then straight to pockets of taxpayers (any "too-big-to-fail" top20 ) and cosmetic "calm-down" figure.

* Coase Theorem - Unicast and permisionless nature of Xln allows transactional fees to race to the bottom: absolute zero or even negative (for auto-rebalancing of cross-hub accounts), allowing first truly frictionless Coasian xlnomy. This never was and never will be feasible with Broadcast O(n) design of big-blocker/sharding/rollups – no matter how optimized/parallelized their software or blobspace is overfloated and DAC trust assumptions increased – making Xln simply impossible to compete with in terms of speed and transactional cost.

* Diamond-Dybvig hub run problem is greatly alleviated. By giving the hub (banks+brokers+CEX superset) and its spokes (all users, companies and institutions connecting to the hubs) a new way to cryptographically dispute bilateral accounts, keep guaranteed 2-of-2 escrow collateral and enforce debts over the collateral limit (see enforceDebt() in Depository.sol), we achieve faster and more seamless way to pull liquidity both from the hub to its "libaility" spokes and from the hub's "asset" spokes to the hub. While Diamond-Dybvig cannot mathematically be reduced to 0 risk, we believe that eventually total counterparty risk will be reduced to ~1-10% of what is currently exposed with traditional franctional reserve model.

In parallel, we suggest a practical reference implementation of the theory: extensible layered network (xln): world's first financial substrate that is both most scalable, most secure and mentally simple at the same time.

This way Xln solves Coase theorem by reaching an absolute theoretical minimum of transactional costs. 

Infinite Unicast O(1) scalability: 1,000,000,000+ tps - same as the underlying Internet. Xln is a netting-account layer, same as banking/ACH, where only net collateral settlements and disputes between entities reach the broadcast J-machine level, keeping 99.99% of value transfers private, instant and practically free.

Xln is also unprecedently secure: while every other Broadcast O(n) architecture (big-blockers/sharding/rollups) have long forgoten the maxima "full node on every laptop", RCPAN allows each and every consumer device will be a fully-verifying node of underlying Jurisdiction-machines (with current focus on EVM J-machines: all public EVM chains and future CBDCs)

We will go carefully and incrementally, explaining the rationale & solutions layer by layer. We avoid any practical innovation in the first two chapters. 

In the first chapter we focus exclusively on reducing the overengineered and incomprehendable terminology of both TradFi and DeFi into sound and elegant hierarchical replicated state machine (HRSM) tri-layer: Jurisdictions - Entities - Accounts (JEA). Any financial system under the sun can be expressed in JEA terms. 

In second chapter we generalize all world's financial Unicast systems into two major categories: full-credit unprovable account networks (FCUAN: all banking, brokers and CEX) and full-reserve provable account networks (FRPAN: Lightning/Raiden/Hydra/other channel networks).

In third chapter, we introduce our main innovation superset invariant reserve-credit provable account network RCPAN={FCUAN, FRPAN} 

`−Lₗ ≤ Δ ≤ C + Lᵣ`

Additional whitepapers that further elaborate and complement UFT are published separately:

* **Cascade Security Model**: we extend the credit+collateral RCPAN invariant with "on-jurisdiction reserves" and opt-in Deposit Insurance Schemes forming a waterfall-like security cascade for all fungible value any entity in Xln holds: reserve->collateral->credit->insurance->reinsurance. 

* **Delta Transformers**: generalized way to Bilateral Unicast DeFi: programmable cascade of hooks `int[] deltas -> Transformer.apply(data, leftArguments, rightArguments) -> int[] deltas` that entities simulate off-J but can routinely enforce with Depository.sol during on-J dispute. Transformers allow Lego-DeFi logic of any complexity but in bilateral 2-party fashion (same as how TradFi worked for centuries).

* **Cascade Control Model**: a deeper dive into Board/Control/Dividend cascade, a novel hierarchical aggregated Hanko-signature for Entity-machines and Merge&Acquisition, index funds and institutional mechanics of Xln. 

* **BrainVault**: argon2id(username, password, complexityFactor ~5sec...5hours) - in addition to cumbersome randomly generated 16-word seeds users may prefer the longer but easier to handle option. Just like RCPAN accounts are "payment channels done right" we propose a secure evolution of BrainWallet/WarpWallet idea.






## 1.1 J-Machine

We unify the terminology and design space of both traditional finance (TradFi) and decentralized finance (DeFi) under a single umbrella of hierarchical state machines tri-layer: 

Let's apply Occam's Razor and Duck Typing principle to both DeFi and TradFi, reducing both to an elegant mechanism of replicated state machine talking to each other and progressing in a replayable deterministic mechanical dance.

Namely, in TradFi we superset {RTGS, Central Banks and Central Securities Depositaries} as a single-signer J-machine. Likewise, we claim "blockchains" or "cryptocurrencies" should have never existed as buzzwords: it's a multi-signer J-machine.

The same Occam's Razor princple 



