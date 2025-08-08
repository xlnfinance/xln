🧠 XLN Architecture: From Ground to Sky

“Imagine a financial system where every participant runs their own simulation, every action is deterministic, and every entity is sovereign by design.”

Welcome to XLN — a post-rollup, post-Lightning, post-state-channel architecture for the programmable economy. Here, every asset, action, and agreement lives inside nested machines with their own state, time, and truth. There is no single global ledger; instead, each Jurisdiction, Entity, and Account is its own machine with a deterministic, append-only ledger (J/E/A machines). This document takes you from the bottom of the stack — the Server — up to the Signer-Entity-Channel abstraction, covering programmability, DeFi logic, and modular governance.

⸻

## JEA: Jurisdiction → Entity → Account (J/E/A machines)

XLN models the world as layered, composable machines:

- **J-machine (Jurisdiction)**: public truth, reserves, dispute resolution; validates external claims and provides registry semantics.
- **E-machine (Entity)**: corporations, DAOs, banks, and states; programmable governance and policy encoded as proposals and quorums.
- **A-machine (Account)**: user-level channels, identities, and subcontracts executing local logic and producing proofs.

“The machine is the law.” Sovereignty is cryptographic, not geographic.

⸻

🧱 1. Server: The Simulated Ground Layer

Think of the Server as the simulation matrix. It’s not a coordinator. It’s not a validator. It’s your own personal universe where Entities evolve over time.

Role
	•	Hosts and executes Entity Machines
	•	Records every tick of state change in its block loop
	•	Stores the entire machine tree in LevelDB with Merkle-style integrity

Key Components

Component	Description
Mempool	Holds Entity block proposals pending signatures
Outbox	Emits signed blocks or requests (e.g., to gossip, jurisdiction)
Inbox	Accepts messages (gossiped updates, signatures)
Snapshots	Every 100ms, the current state is committed to disk via RLP+Merkle hash
Signers	Deterministically derived from HMAC(secret, index)

Analogy

Like a hypervisor running isolated VMs (Entities), the Server executes without global coordination. You can fork it, replay it, or rewind it. It’s the ultimate sovereign simulation host.

⸻

🏛️ 2. Entity: The Sovereign Machine

The Entity is the real heart of XLN. It’s like a DAO, but it has memory, makes commitments, and progresses in blocks. Think of it as a programmable company, state, or institution.

Anatomy
	•	Storage: Key-value RLP tree (state, proposals, votes, parameters)
	•	Quorum: Fixed-weight signer set (can be updated via proposal)
	•	Actions: Triggered and signed, each action proposes a state change
	•	Block Loop: Aggregates signed actions and finalizes when quorum is reached
	•	Submachines: Channels or Account machines exist as nested submachines

Execution Flow

1. Propose → 2. Collect Signatures → 3. Execute → 4. Finalize in Block

Programmability

Entities can:
	•	Trigger on-chain interactions (reserves, collaterals via jurisdiction)
	•	Enforce logic for DeFi actions (minting, vesting, AMM pools, oracles)
	•	Vote and evolve: Replace quorum, update policies, pause machines
	•	Issue tokens: Represent shares, votes, or programmable assets

XLN decouples the ability to own tokens from the ability to act. Quorum = control, token = ownership. You can fork an Entity without airdrops — it’s just a different simulation.

Analogy

If Ethereum smart contracts are calculators, Entities are living spreadsheets with a board of directors.

⸻

👥 3. Signer: The Flesh and Blood Layer

Signers are the human or device actors powering the system. They:
	•	Hold keys
	•	Propose actions
	•	Approve blocks
	•	Sync state from their server or others

Signers don’t broadcast intents. They sign proposals or actions, and they do so only when state matches expected values. This allows cold, hard determinism.

“No intents, no mempool spam, no MEV. Just machines progressing when quorum agrees.”

⸻

🔄 4. Channels (Coming Later)

While omitted from MVP, Channels are submachines that manage trust-based contracts. They:
	•	Track balances, deltas, subcontracts
	•	Are added via addSubcontract() to an Account
	•	Emit proofs which the Entity signs and commits

Channels allow:
	•	Programmable credit
	•	Netting
	•	Time-locked guarantees
	•	Dispute resolution

⸻

🪙 5. DeFi & Economic Logic

XLN Entities can implement advanced DeFi behaviors natively. Examples:

🔐 Credit & Trust
	•	Credit lines are user-initiated
	•	No reserve required to receive payments
	•	Channels become asymmetric credit contracts

💰 AMMs & Token Swaps
	•	Entities can host internal AMM machines
	•	Token swaps settle instantly via internal state updates

🏦 Reserve & Collateral
	•	Reserve deposits tracked via Jurisdiction
	•	Entities interact with Depository.sol contracts for collateralization

📈 Oracles & Price Feeds
	•	Entity can define setOracle(address)
	•	Price updates come via signed messages from trusted oracle entities

⚖️ DAO Governance
	•	Proposals are actions
	•	Signers are the quorum
	•	Emergency votes via override tokens (e.g., EmergencyShare)

“In XLN, a DAO is not just a voting app — it’s a full machine with a chain of custody, audit logs, and block-by-block state transitions.”

⸻

🔐 Security & Integrity
	•	All actions are signed via Hanko hierarchical signature system
	•	All blocks are replayable and deterministic
	•	State is stored as RLP + Merkle trees
	•	Signature threshold must be met for progression
	•	Real-time Board validation via EntityProvider (BCD governance)
	•	Hanko Bytes enable unlimited organizational complexity with gas efficiency
	•	Lazy entities: No registration required for self-validating boards

⸻

🛰️ Jurisdiction (External Observer)

Entities can publish:
	•	Reserve movements
	•	On-chain collateral updates
	•	External registry claims

But they never depend on these events for internal logic unless explicitly coded. This preserves state sufficiency.

⸻

## Implications and Success Criteria

**Implications**
- Consensus becomes personal: each machine advances with its own quorum, eliminating global MEV and sequencer risk.
- Zero-marginal-cost organization: Hanko makes entities signature schemes; infinite committees at 0 gas.
- Programmable institutions: BCD splits Board/Control/Dividend, matching corporate reality and enabling tradeable control/economics.

**When XLN succeeds**
- Nations deploy digital governance with deterministic accountability.
- DAOs issue passports, shares, and debt via entities.
- Individuals fork jurisdictions and coordinate globally.
- DeFi becomes networks of interlinked machine-states.

⸻

🌍 Final Thoughts

XLN is not a smart contract platform.
It’s not a rollup.
It’s not a channel network.

It’s a machine language for sovereign economic agents, where:
	•	Every Entity is a VM
	•	Every VM has quorum
	•	Every state change is a block

“Blockchains made consensus global. XLN makes consensus personal.”

⸻

For further details, see:
	•	server.ts - reference implementation
	•	EntityProvider.sol - quorum hash & jurisdiction interface
	•	Depository.sol - reserve/collateral tracking
	•	CLI tools (DevTree, BlockValidator, SignatureVerifier)
	•	Memo: docs/memo-to-model.md (tone, positioning, and summary guide)