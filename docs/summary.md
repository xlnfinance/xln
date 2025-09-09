XLN Protocol — Summary

Core Concepts

XLN is a sovereign Layer2 for EVM, designed around two primitives:
	1.	Reserves — liquid balances held directly in the jurisdiction machine (J).
	2.	Reserve-credit accounts (channels) — bilateral credit contracts between entities, backed by collateral + deltas.

Every channel for a given asset is defined by three numbers:
	•	Deposit (Collateral) — the locked base amount in the jurisdiction.
	•	LedgerShift (ondelta) — a public shift recorded in J, changed by cooperative settle.
	•	PrivateShift (offdelta) — a private shift stored in AccountProof, changed by subcontracts.

The invariant:

Δ = ondelta + offdelta


⸻

AccountProof

An AccountProof is the signed canonical state of a bilateral account:

[Left, Right, Seq, DeltaList, Subcontracts, Signature]

	•	DeltaList: asset deltas (offdelta).
	•	Subcontracts: optional executable logic (HTLC, Swap, CDS, etc.).
	•	Signature: canonical signature by both sides.
Both parties hold the same canonical proof copy.

⸻

Dispute and Delta Derivation

When a dispute is triggered, the jurisdiction machine runs the following pipeline:
	1.	Sum Deltas
For each asset:

Δ = ondelta (public) + offdelta (from AccountProof)


	2.	Execute Subcontracts
Δ values are passed through the external Subcontract array, with inputs (arguments, deadlines, secrets, swap ratios, etc.).
The subcontract provider returns a modified DeltaList, producing the final effective Δ.
	3.	Split Collateral
With the final Δ values:
	•	If 0 ≤ Δ ≤ deposit: left receives Δ, right receives (deposit − Δ).
	•	If Δ > deposit: left takes full deposit, surplus becomes debt of right.
	•	If Δ < 0: right takes full deposit, surplus becomes debt of left.
	4.	Debt Enforcement
Debt is first covered from reserves. If reserves are insufficient, it is added to the entity’s active debt list.

This ensures mechanical, deterministic settlement without third-party trust.

⸻

Asset Flow
	1.	From Jurisdiction Reserve
Assets are first deposited into reserves (reserves[entity][asset]).
	2.	From Reserve to Collateral
Entities can transfer reserves into channel collateral (collaterals[left][right][asset]).
	•	By default, new collateral is attributed to the right.
	•	If the depositor is left, ondelta is increased by the deposit amount (shifting allocation left).
	3.	Cooperative Settle
Both parties can jointly sign a settle transaction to update reserves, collateral, and ondelta atomically.
The invariant leftDiff + rightDiff + collateralDiff == 0 ensures conservation.

⸻

Event Propagation
	•	Jurisdiction Machine (J) emits events for deposits, withdrawals, disputes, and finalizations.
	•	Entity Machines (E) subscribe to J events to update their internal state.
	•	Entities gossip AccountProofs between each other, ensuring canonical sequence numbers (seq).

Thus, entities always track both on-chain public state (ondelta + reserves) and off-chain private state (AccountProof).

⸻

First Payment Flow (Happy Path)
	1.	Initial Channel
Alice and Hub (H1) open a USDT channel with:

deposit = 100, ondelta = 0, offdelta = 0


	2.	Alice Sends 30 USDT
	•	Alice builds an AccountProof: offdelta[USDT] = -30.
	•	She signs and sends it to Hub.
	•	Hub verifies signature, credit limit, and stores the proof.
	3.	Routing
	•	Hub immediately uses its own channel (H1 → Bob) to forward +30.
	•	This creates a second proof in the (H1, Bob) channel.
	4.	State After Payment
	•	Both Alice and Hub hold the same updated proof for (Alice, H1).
	•	No settlement with jurisdiction required.
	•	Reserves and deposits remain untouched until either cooperative settle or dispute.

⸻

Key Properties
	•	Unicast DeFi — all payments are bilateral, no global sequencer.
	•	Billions+ TPS — parallel channels scale unbounded.
	•	Zero DA risk — no dependence on external data storage.
	•	Fully sovereign exits — any user can exit with just their AccountProof.
	•	Programmable subcontracts — advanced logic (HTLC, swaps, derivatives) run off-chain, enforced on dispute.
	•	Simple as banking — user balances are derived from (deposit, ondelta, offdelta) transparently.

⸻

📌 This structure makes XLN mathematically minimal:
	•	One deposit
	•	Two deltas
	•	One invariant equation

From this, all forms of payments, credit, swaps, and disputes are derived.
