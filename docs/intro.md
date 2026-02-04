# XLN in 5 minutes

XLN (Reserve-Credit Provable Account Network) is a bilateral settlement network that makes credit provable and collateral enforceable, so payments settle instantly without blockchain latency.

## The problem XLN solves
- Broadcast consensus does not scale (O(n) cost per transaction).
- Full-reserve channels cannot receive without inbound liquidity.
- Banks scale via credit but are unprovable and bailout-prone.

## The breakthrough: RCPAN invariant
Invariant:
  -L_left <= delta <= C + L_right

Where:
- delta: net balance between two parties (positive = I owe you)
- C: my collateral escrowed on-chain
- L_left: credit I extend to you (my risk)
- L_right: credit you extend to me (your risk)

Interpretation:
- Within credit limits: bank-style netting, instant updates.
- Within collateral bounds: payment-channel safety.
- Beyond both: on-chain FIFO enforcement resolves debts.

## What XLN enables
- Instant bilateral settlement with partial collateral.
- Programmable credit (delta transformers: HTLCs, swaps, limit orders).
- Multi-hop netting that reduces liquidity requirements.
- Deterministic enforcement via on-chain Depository.

## Architecture in one page (RJEA)
- Runtime: deterministic orchestration and routing.
- Entity: BFT consensus for organization state.
- Account: bilateral consensus for pairwise settlement.
- Jurisdiction: on-chain arbitration and collateral enforcement.

## Proof anchors (where to verify)
- jurisdictions/contracts/Depository.sol: RCPAN enforcement + FIFO debt queue.
- runtime/account-consensus.ts: ADD_TX -> PROPOSE -> SIGN -> COMMIT.
- runtime/entity-consensus.ts: PBFT-style 3-phase commit.
- runtime/account-utils.ts: deriveDelta() and invariant math.

## XLN is not
- Not a rollup or DA layer.
- Not a full-reserve payment channel network.
- Not a new L1.
- Not a bank without proofs.

## If you read only 3 files
1. docs/core/12_invariant.md
2. docs/core/rjea-architecture.md
3. jurisdictions/contracts/Depository.sol
