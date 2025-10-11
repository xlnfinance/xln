🏛️ JEA: Jurisdiction-Entity-Account Model

“JEA is not just a technical pattern — it’s a legal operating system for programmable institutions.”

The JEA architecture underpins XLN’s modular trust and execution model. It separates concerns cleanly across three layers:
	•	Jurisdictions: Public, often on-chain arbitration and registry zones
	•	Entities: Sovereign programmable machines (like DAOs or firms)
	•	Accounts (Channels): Bilateral trust relationships or financial instruments

This document outlines the JEA structure in detail, its purpose, flow, and how it replaces traditional consensus-heavy architectures.

⸻

⚖️ 1. Jurisdiction: Public Arbitration Layer

A Jurisdiction is a public smart contract or observable registry that acts as:
	•	Dispute settlement ground
	•	Reserve registry
	•	Oracle of record for shared events

Key Concepts
	•	Jurisdiction is opt-in: Entities choose when to interact
	•	Jurisdiction has no access to internal state
	•	Jurisdiction observes receipts: Signed proofs of action

Contracts
	•	EntityProvider.sol — stores quorum hash (Merkle root of signer structure)
	•	Depository.sol — stores reserve/collateral data
	•	Custom registries — e.g., insurance claims, auctions, licenses

Use Cases

Case	Jurisdiction Role
Reserve deposit	Holds tokens, emits event
Credit collateralization	Verifies locked assets and releases collateral
Token mint claim	Accepts signed receipt from Entity and emits asset

“Jurisdictions are like courts that accept signed, notarized paperwork — but never interfere in private life unless called.”

⸻

🏛️ 2. Entity: Sovereign Organization

An Entity is a self-contained state-time machine with its own quorum, storage, and block history.

Key Properties
	•	Maintains internal logic via deterministic actions
	•	Requires quorum threshold for any state change
	•	Can spawn accounts, tokens, and internal machines
	•	Interacts with Jurisdiction via signed receipts

On Jurisdiction Access
	•	Entity creates a Proposal to mint/reserve/interact externally
	•	Once quorum signs and the state commits, the signed receipt is emitted
	•	Receipt may be submitted to Jurisdiction by any party (watchers)

Security Guarantees
	•	Jurisdiction verifies Merkle proof of quorum hash
	•	Jurisdiction does not need to replay Entity logic — trust is cryptographic

“An Entity is like a company with its own bylaws and board. The state doesn’t care what happens inside — until you file a public claim.”

⸻

💳 3. Account: Channels and Financial Instruments

Accounts represent:
	•	Channels (credit lines, bilateral payments)
	•	Subcontracts (vesting, options, loans)
	•	Internal balances or positions

Structure
	•	Always nested inside an Entity
	•	Follows AccountProof → Subcontract model
	•	Each has its own logic, deltas, and Merkle proof

Execution
	•	Account emits proof of state change (e.g. balance update)
	•	Entity collects and commits proof into its block
	•	Optionally, Jurisdiction may act on this (e.g. insurance trigger)

“Accounts are the atoms. Entities are the molecules. Jurisdiction is the surrounding legal atmosphere.”

⸻

🔁 Flow Summary: Bottom-Up

1. Account: emits change (e.g., collateral unlocked)
2. Entity: signs and commits block containing proof
3. Jurisdiction: optionally accepts receipt, verifies hash chain


⸻

🛡 Why JEA Is Superior

Feature	Traditional Stack	JEA Architecture
Shared State	Global / Bottleneck	Local / Modular
Dispute Resolution	Forks / Governance	Receipt + Quorum
Composability	High coupling	Strong separation
State Integrity	L1-dependent	Self-contained with proofs
Credit / Receivability	Impossible	Native via Accounts

“Rollups try to be courts, states, and wallets all at once. JEA says: split the roles, keep the contracts clean, and let each layer focus on what it’s best at.”

⸻

🧬 Design Ethos
	•	Modularity over Monolith: Each layer is clean, testable, swappable
	•	Paper trail over gossip: All actions leave verifiable receipts
	•	State sufficiency: If your Entity vanishes, your counterparty still has proof
	•	Quorum ≠ Token ownership: Governance and execution are separate vectors

⸻

🧭 Future Directions
	•	Jurisdictions as regulated custodians
	•	Inter-Jurisdiction arbitration via Entity-controlled registries
	•	Reputation-weighted quorum systems
	•	Federated DAOs across multiple Entities

⸻

📌 In Practice
	•	EntityProvider.sol: sets Merkle hash of quorum
	•	Depository.sol: verifies and tracks reserves
	•	Entity: commits actions, emits receipts
	•	Account: executes financial logic, tracks deltas

⸻

JEA is to blockchain what OSI was to networking — a layered abstraction that makes sovereign computation composable, trustable, and legible.

“You don’t need one chain to rule them all. You just need a structure where trust can be scoped, verified, and proven.”