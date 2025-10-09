# XLN Protocol

## Core Concepts

XLN is a **sovereign Layer2 for EVM**, designed around two primitives:

1. **Reserves** — liquid balances held directly in the jurisdiction machine (J).
2. **Reserve-credit accounts (channels)** — bilateral credit contracts between entities, backed by **collateral**, **ondelta**, and **offdelta**.

Every channel for a given asset is defined by three numbers:

- **Collateral** — the locked base amount in the jurisdiction.
- **ondelta** — a *public shift* stored in J, updated by cooperative settle.
- **offdelta** — a *private shift* stored in AccountProof, updated off-chain.

The invariant:

Δ = ondelta + offdelta

---

## External Token Flow

1. **Deposit into Reserve**  
   A user deposits external tokens (e.g., USDT) into the jurisdiction.  

reserves[entity][token] += amount

2. **Move Reserve → Collateral**  
The entity transfers tokens from its reserve into a channel with a counterparty.  
- The tokens become **collateral** in the channel.  
- By default, new collateral is attributed to the right side.  
- If the depositor is the left side, `ondelta += amount` to shift part of collateral allocation left.
```
reserves[left][token] -= amount
collaterals[left][right][token].collateral += amount
if depositor == left:
collaterals[left][right][token].ondelta += amount
```
---

## Off-Chain Payments in AccountProof

1. **Proof Creation**  
- The sender (Alice) prepares a new **AccountProof** for channel (Alice, Hub).  
- She increments the sequence number and updates offdelta:  
  ```
  offdelta[token] -= amount
  ```
- The proof may include subcontracts (e.g., HTLC, Swap).  
- Alice signs and sends the proof to Hub.

2. **Proof Acceptance**  
- Hub verifies Alice’s signature, sequence, and credit limits.  
- Hub stores the canonical AccountProof.  
- Both sides now hold the same proof; **no on-chain update is needed**.

3. **Routing**  
- Hub can immediately forward the payment using its own channel (Hub, Bob), creating another AccountProof.  
- This enables multi-hop routing without touching jurisdiction.

---

## Cooperative Settle

At any time, both parties can jointly update their state on-chain:

1. **Prepare Settle**  
Both sign a batch of diffs:
- `leftReserveDiff`
- `rightReserveDiff`
- `collateralDiff`
- `ondeltaDiff`

2. **Invariant**  

leftReserveDiff + rightReserveDiff + collateralDiff == 0

3. **Apply**  
- Reserves, collateral, and ondelta are updated atomically in J.  
- Old AccountProofs remain valid; only the public base has shifted.

---

## Dispute and Delta Derivation

When cooperation fails, either side can trigger a dispute:

1. **Submit Proof**  
Submit the latest signed AccountProof to J.

2. **Sum Deltas**  
For each token:

Δ = ondelta (public in J) + offdelta (from AccountProof)

3. **Execute Subcontracts**  
The DeltaList is passed through the array of external subcontracts with all arguments.  
The subcontract provider returns a **modified DeltaList**.

4. **Split Collateral**  
Using the final Δ:
- If `0 ≤ Δ ≤ collateral`: left gets Δ, right gets (collateral − Δ).
- If `Δ > collateral`: left gets full collateral, surplus becomes **debt of right**.
- If `Δ < 0`: right gets full collateral, surplus becomes **debt of left**.

5. **Debt Enforcement**  
- Debt is first paid from reserves.  
- If reserves are insufficient, it is recorded in the entity’s debt list.

---

## First Payment Example

1. **Channel Setup**  
- Alice deposits 100 USDT.  
- Reserve(Alice) = 100.  
- She moves 100 into collateral with Hub:  
  ```
  collateral = 100, ondelta = 0, offdelta = 0
  ```

2. **Payment of 30 USDT**  
- Alice creates AccountProof#1 with `offdelta = -30`.  
- Alice signs and sends it to Hub.  
- Hub accepts; both now hold canonical proof.

3. **State After Payment**  
- No on-chain action has occurred.  
- Jurisdiction still shows: `collateral = 100, ondelta = 0`.  
- AccountProof offdelta = −30 represents Alice’s transfer.  

4. **Optional Settle**  
- Alice and Hub can later settle on-chain, moving balances.  

5. **Dispute Path**  
- If Hub disappears, Alice submits AccountProof#1.  
- J computes Δ = ondelta (0) + offdelta (−30) = −30.  
- J splits collateral: right (Hub) takes 30, left (Alice) keeps 70.

---

## Key Properties

- **Unicast DeFi** — payments are bilateral, no global sequencer.  
- **Billions+ TPS** — unbounded scalability across parallel channels.  
- **Zero DA risk** — no external data availability assumptions.  
- **Sovereign exits** — any party can exit with AccountProof.  
- **Programmable subcontracts** — HTLCs, swaps, derivatives.  
- **Simple as banking** — user balances are derived from `(collateral, ondelta, offdelta)`.
