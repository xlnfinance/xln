# 1.1 Jurisdiction Machine / J-machine

## 1.1.1 TradFi J-machine

Imagine for now, the year is 2008. Blockchains/cryptocurrencies/DLT never existed. Forget about DAOs, BFT and payment channels, lets focus exclusively on the traditional financial world (TradFi). We are going to apply Occam's Razor and Duck Typing principle to each component of TradFi, to remove the legacy fluff and extract the essence.

Let's start with our fundamental primitive: a replicated state machine.

What is a state machine? It's an abstract concept from Automata theory. A state machine is a system that moves between defined states based on inputs — each tx (transaction) changes behavior predictably. It’s how you turn chaos into logic.

Say, you have `{Alice: 10, Bob: 5}`. Tx `alice-bob pay 2` would turn it into `{Alice: 8, Bob: 7}`

TradFi can be expressed as a myriad of interconnected state machines. At first glance it seems that every country has their own unique financial system with different acronyms and legal quirks. But after a closer look, we immediately see a pattern: there always is a root sovereign settlement court state machine that rules all state machines beneath it: the Jurisdiction State Machine.

For historical reasons, tradfi J-machines are fragmented:

* the oldest component – Central Bank, where **the currency (fiat) token** is minted in a form of debt to commercial banks.
* the second component, Real Time Gross Settlement (RTGS) appeared later with advances in computers and networking. It allows commercial banks to move high value instantly (real time) without trusting each other with netting accounts (ACH). Technically, an account in Fedwire is an account in Fed. Therefore RTGS === Central Bank.
* the third is central securities depository. That's where other **tokens are minted and stored**. 
* plus multiple land registries where non-fungible tokens such as land and apartments are assigned to entities

This fragmentation brings nothing but pain and reconcillation hell. 

Storing fiat token in one ledger and security tokens in another is like keeping count of bananas in one spreadsheat and using a whole another book for other fruits. The benefits are marginal, the downsides are glorious. 

Applying Occam's Razor, we suggest from now on to conceptually treat all fragmented tradfi central banks/RTGS/depositories as a unified J-machine. 

## 1.1.2 TradFi E-machine

Beneath the J-machine there always is a layer of commercial banks, brokers, end users, merchants, companies and non-jurisdictional institutions. 

We suggest to superset those as an Entity machine. 







Namely, in TradFi we superset {RTGS, Central Banks and Central Securities Depositaries} as a single-signer J-machine. Likewise, we claim "blockchains" or "cryptocurrencies" should have never existed as buzzwords: it's a multi-signer J-machine.

The same Occam's Razor princple 
