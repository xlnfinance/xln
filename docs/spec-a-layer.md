# A-Layer: Bilateral 2-of-2 Account Consensus Protocol

## 1. Overview

The A-layer implements bilateral off-chain consensus between exactly two entities (a 2-of-2 channel). Each bilateral relationship is modeled as an **AccountMachine** -- a deterministic state machine that both parties maintain in identical form. State advances through **frames**: atomic bundles of transactions that both parties must sign before commitment. The protocol achieves instant finality for off-chain updates while preserving the ability to enforce the latest agreed state on-chain through dispute proofs.

## 2. AccountMachine State Structure

An AccountMachine M between entities L (left) and R (right) consists of:

**Canonical identity.** The two entities are assigned fixed roles based on lexicographic ordering of their entity IDs: L = min(id_A, id_B), R = max(id_A, id_B). This assignment is immutable for the lifetime of the account and ensures both parties agree on directionality without coordination.

**Delta table.** A map D: TokenId -> Delta, where each Delta is a per-token bilateral balance structure:

    Delta_t = (tokenId, collateral, ondelta, offdelta,
               leftCreditLimit, rightCreditLimit,
               leftAllowance, rightAllowance,
               leftHtlcHold, rightHtlcHold,
               leftSwapHold, rightSwapHold,
               leftSettleHold, rightSettleHold)

The **total delta** for a token is defined as delta_total = ondelta + offdelta. The sign convention is: delta_total > 0 means R owes L; delta_total < 0 means L owes R. The ondelta component reflects on-chain state (set by jurisdiction events), while offdelta reflects off-chain bilateral mutations. Only offdelta is used for frame-level consensus comparison, since ondelta depends on J-event timing which may differ between the two parties' observation windows.

**Frame chain.** A hash-linked sequence of AccountFrames. The machine tracks currentHeight h and currentFrame F_h. Each frame contains a prevFrameHash linking to its predecessor (or the string "genesis" for h=0), creating an immutable audit chain.

**Mempool.** An ordered list of pending AccountTx transactions awaiting inclusion in the next frame, bounded by MEMPOOL_LIMIT = 1000.

**Proposal slot.** At most one outstanding ProposalState = (pendingFrame, pendingSignatures, pendingAccountInput), representing a frame proposed but not yet acknowledged by the counterparty.

**Proof header.** Contains (fromEntity, toEntity, cooperativeNonce, disputeNonce) for on-chain dispute resolution. The cooperativeNonce increments with each bilateral message exchange; the disputeNonce tracks committed frame height.

**Conditional state.** Maps for HTLC locks (lockId -> HtlcLock) and swap offers (offerId -> SwapOffer), representing capacity-reserving conditional payments and limit orders respectively.

## 3. The Delta Model and Conservation Law

### 3.1 Balance Derivation

Given a Delta_t and a perspective (isLeft), the **derived balance** is computed as follows. Let c = max(0, collateral), d = ondelta + offdelta.

From L's perspective:
- **inCollateral** (collateral backing inbound capacity) = c - d if d > 0, else c
- **outCollateral** (collateral backing outbound capacity) = min(d, c) if d > 0, else 0
- **inOwnCredit** (credit L has extended, currently used) = min(max(0, -d), leftCreditLimit)
- **outPeerCredit** (credit R extended, currently used by L) = min(max(0, d - c), rightCreditLimit)

The total channel capacity is: totalCapacity = c + leftCreditLimit + rightCreditLimit.

Outbound capacity (L can send): outCapacity = max(0, outPeerCredit + outCollateral + outOwnCredit - leftAllowance - leftHold) where leftHold = leftHtlcHold + leftSwapHold + leftSettleHold.

Inbound capacity (L can receive): inCapacity = max(0, inOwnCredit + inCollateral + inPeerCredit - rightAllowance - rightHold).

For R's perspective, all in/out quantities and left/right labels are swapped.

### 3.2 Settlement Conservation Law

Every on-chain settlement operation must satisfy the **conservation invariant**:

    leftDiff + rightDiff + collateralDiff = 0

where leftDiff is the change to L's reserve, rightDiff is the change to R's reserve, and collateralDiff is the change to the account's locked collateral. This invariant is enforced at creation time by the createSettlementDiff constructor, which throws on violation. No value is created or destroyed -- it is only redistributed between reserves and collateral.

### 3.3 Payment Semantics

A direct payment of amount a from sender S to receiver on token t modifies offdelta as follows:
- If S = L: offdelta <- offdelta - a (delta moves negative, L owes more)
- If S = R: offdelta <- offdelta + a (delta moves positive, R owes more)

The payment is rejected if a > outCapacity(S). The offdelta modification is identical on both sides regardless of who proposed the frame, since the byLeft flag and explicit fromEntityId/toEntityId fields make the direction unambiguous.

### 3.4 Credit Limit Semantics

When the frame proposer calls set_credit_limit(tokenId, amount):
- If proposer is L (byLeft = true): sets rightCreditLimit = amount (L extends credit to R)
- If proposer is R (byLeft = false): sets leftCreditLimit = amount (R extends credit to L)

The proposer always sets the *counterparty's* credit limit field, meaning each party controls how much the other can borrow.

## 4. Frame Lifecycle

### 4.1 Proposal (Proposer)

When entity P has a non-empty mempool and no outstanding proposal:

1. **Clone** the AccountMachine to M'.
2. **Execute** each tx in the mempool on M', recording valid transactions. Failed transactions are removed from the mempool and skipped (the proposal is not aborted).
3. **Extract state**: collect all (tokenId, delta) pairs from M'.deltas, sorted by tokenId ascending. Filter out tokens where offdelta = 0, all credit limits = 0, and all holds = 0.
4. **Construct frame** F with fields:
   - height = h + 1
   - timestamp = max(env.timestamp, previousFrame.timestamp + 1) [monotonic]
   - jHeight = entity's synced jurisdiction height
   - accountTxs = list of valid transactions (deep-copied)
   - prevFrameHash = F_h.stateHash (or "genesis" if h = 0)
   - byLeft = (P = L)
   - tokenIds, deltas, fullDeltaStates from step 3
5. **Hash** the frame: stateHash = keccak256(deterministicJSON(F)), where the JSON includes height, timestamp, jHeight, prevFrameHash, accountTxs, tokenIds, deltas (as strings), and the full delta states with all hold fields.
6. **Sign**: produce a Hanko signature over stateHash, and separately sign a dispute proof hash (see Section 7).
7. **Clear** the mempool.
8. **Store** the proposal in M.proposal and transmit an AccountInputProposal message containing the frame, Hanko, and dispute metadata.

### 4.2 Verification and ACK (Receiver)

When entity V receives a proposal with frame F' at height h + 1:

1. **Validate structure**: check height >= 0, jHeight >= 0, |accountTxs| <= 100, |tokenIds| = |deltas|, timestamp within 5 minutes of local clock, and timestamp >= previous frame timestamp (with 1s tolerance).
2. **Verify chain linkage**: F'.prevFrameHash must equal F_h.stateHash (or "genesis").
3. **Handle simultaneous proposals** (see Section 5).
4. **Verify sequence**: F'.height must equal h + 1.
5. **Verify Hanko signature** on F'.stateHash against the proposer's entity.
6. **Replay transactions**: clone M to M', execute all F'.accountTxs on M' using F'.timestamp and F'.jHeight for determinism.
7. **Compare state**: extract (tokenIds, deltas, fullDeltaStates) from M' using the same filtering as step 3 of proposal. Compare offdelta values against F'.deltas. Additionally verify bilateral fields (offdelta, creditLimits, allowances) in fullDeltaStates match exactly. ondelta and collateral are permitted to differ due to J-event timing.
8. **Recompute hash**: compute keccak256 over the frame using the verifier's own computed state. This must equal F'.stateHash.
9. **Commit**: re-execute all transactions on the *real* M (not the clone), update M.currentFrame using the verifier's own computed values (never the proposer's claimed state), advance M.currentHeight.
10. **Sign and ACK**: produce a Hanko over the accepted frame's stateHash. Transmit an AccountInputAck. If the verifier has pending mempool items, it may **batch** a new proposal in the same ACK message.

**Security principle**: The receiver NEVER stores counterparty-supplied computed state (tokenIds, deltas, fullDeltaStates, stateHash). It stores only its own independently computed values. This prevents state injection attacks where an attacker could embed poisoned values (e.g., inflated credit limits) that pass transaction-level validation but corrupt stored state.

### 4.3 Confirmation (Proposer receives ACK)

When the original proposer P receives an ACK for its pending frame:

1. **Verify Hanko** on the ACK against the counterparty's entity, confirming they signed the same stateHash.
2. **Re-execute** all transactions from the pending frame on the real M, using the frame's timestamp and jHeight.
3. **Commit**: set M.currentFrame = pendingFrame (deep-copied), advance M.currentHeight, clear M.proposal.
4. **Chained proposal**: if M.mempool is non-empty after clearing the proposal, immediately invoke a new proposal cycle.

### 4.4 Batched ACK + Proposal

To minimize round-trips, the ACK message may include a new proposal (newAccountFrame + newHanko). The receiver processes the ACK commitment first, then treats the embedded proposal as a new incoming frame, following the standard verification flow. The cooperativeNonce increments once for the combined message.

## 5. Simultaneous Proposal Tiebreaker

When both parties propose frames at the same height h + 1 concurrently, a deterministic tiebreaker resolves the conflict without communication:

**Rule**: LEFT always wins.

Formally, when entity E receives a proposal at height h + 1 while holding its own proposal at the same height:

- If E = L (E is the left entity): ignore the received frame, keep own proposal. L waits for R's ACK.
- If E = R (E is the right entity): **roll back** own proposal. Restore the pending frame's transactions to the front of the mempool (preserving order). Clear the proposal slot. Accept L's frame through the standard verification flow. R's restored transactions will be proposed in a subsequent frame after ACK-ing L's frame.

The rollback is bounded: if rollbackCount > 0 on a second consecutive rollback, the protocol signals a consensus failure. A deduplication guard (lastRollbackFrameHash) prevents processing the same rollback twice.

This tiebreaker is **deterministic** because both sides can independently compute isLeft from the lexicographic ordering of entity IDs. No additional coordination is required.

## 6. Frame Hash Computation

The frame hash binds the complete bilateral state to an unforgeable digest. It is computed as:

    stateHash = keccak256(utf8Bytes(deterministicJSON(frameData)))

where frameData includes:
- height, timestamp, jHeight (consensus coordinates)
- prevFrameHash (chain linkage)
- accountTxs (each as {type, data})
- tokenIds (sorted ascending)
- deltas (offdelta values as strings)
- fullDeltaStates (each delta serialized with all fields: tokenId, collateral, ondelta, offdelta, leftCreditLimit, rightCreditLimit, leftAllowance, rightAllowance, and all six hold fields as strings)

The use of deterministicJSON (via safeStringify, which handles BigInt serialization) ensures both parties produce identical byte sequences from identical logical state. The keccak256 hash function is chosen for EVM compatibility, allowing on-chain verification of dispute proofs.

## 7. Dispute Proof System

Each frame exchange produces two signatures: one on the frame stateHash (for bilateral consensus) and one on a **dispute proof hash** (for on-chain enforcement).

### 7.1 Proof Body

The proof body is constructed from the AccountMachine's current state:

    ProofBody = (offdeltas[], tokenIds[], transformers[])

where transformers encode HTLC locks as Payment structs (deltaIndex, signed amount, revealBeforeHeight, hashlock) and swap offers as Swap structs (ownerIsLeft, deltaIndices, amounts). The proof body is ABI-encoded and hashed:

    proofBodyHash = keccak256(abiEncode(ProofBody))

### 7.2 Dispute Message

The full dispute message binds the proof to a specific depository contract and channel:

    disputeHash = keccak256(abiEncode(
        MessageType.DisputeProof,
        depositoryAddress,
        channelKey,            // solidityPacked(leftEntity, rightEntity)
        cooperativeNonce,
        disputeNonce,
        proofBodyHash
    ))

Both parties sign disputeHash with every frame exchange. The depositoryAddress provides cross-chain replay protection. The cooperativeNonce prevents replay of old proofs. The disputeNonce (equal to frame height) orders dispute submissions.

### 7.3 Settlement Hash

Cooperative settlements use a separate message type:

    settlementHash = keccak256(abiEncode(
        MessageType.CooperativeUpdate,
        depositoryAddress,
        channelKey,
        onChainSettlementNonce,
        diffs[],
        forgiveDebtsInTokenIds[],
        insuranceRegs[]
    ))

The conservation law (Section 3.2) is enforced in the diffs array.

## 8. Capacity Holds and Conditional Payments

### 8.1 HTLC Locks

An HTLC lock reserves capacity from the sender's outbound balance:

1. Validate: lockId unique, timelock > currentTimestamp, revealBeforeHeight > currentHeight, amount within bounds, amount <= sender's outCapacity.
2. Create HtlcLock record with senderIsLeft = byLeft.
3. Increment the appropriate hold: if senderIsLeft, leftHtlcHold += amount; otherwise rightHtlcHold += amount.
4. The hold is included in frame hash computation (via fullDeltaStates), preventing over-commitment within a single frame.

Resolution releases the hold and either settles (secret reveal: offdelta adjusted) or cancels (timeout: hold simply removed).

### 8.2 Swap Offers

Swap offers lock capacity in the give-token's hold fields (leftSwapHold or rightSwapHold), following the same pattern as HTLC holds. Partial fills reduce the locked amount proportionally.

### 8.3 Settlement Holds

During on-chain settlement negotiation, both parties' withdrawal amounts are ring-fenced via leftSettleHold and rightSettleHold. These holds prevent double-spending capacity that has been committed to a pending settlement.

## 9. Mempool Management and Transaction Validation

Transactions enter the mempool via addToAccountMempool, which enforces the 1000-entry limit. The auto-propose trigger fires when mempool.length > 0 and no proposal is outstanding.

During proposal construction, each transaction is executed on a **cloned** AccountMachine. Failed transactions are silently dropped (removed from mempool) without aborting the entire proposal. This ensures that a single malformed transaction does not block the channel.

Transaction types supported: direct_payment, set_credit_limit, add_delta, htlc_lock, htlc_resolve, swap_offer, swap_resolve, swap_cancel, settle_hold, settle_release, j_sync, j_event_claim, reserve_to_collateral, request_withdrawal, approve_withdrawal, request_rebalance.

All financial transactions validate amounts against configurable bounds (MIN_PAYMENT_AMOUNT, MAX_PAYMENT_AMOUNT). Credit limits are bounded by MAX_CREDIT_LIMIT. Route lengths for multi-hop payments are bounded by MAX_ROUTE_HOPS.

## 10. Invariants

1. **Identical state**: Both parties maintain byte-identical AccountMachine state after every committed frame (excluding perspective-dependent fields like proofHeader.fromEntity).
2. **Chain integrity**: Every frame F_{h+1} satisfies F_{h+1}.prevFrameHash = F_h.stateHash, forming an unbroken hash chain from genesis.
3. **Monotonic height**: currentHeight strictly increases with each committed frame.
4. **Monotonic timestamps**: Each frame's timestamp >= previous frame's timestamp + 1.
5. **Conservation**: All settlement operations satisfy leftDiff + rightDiff + collateralDiff = 0.
6. **Capacity safety**: No payment or HTLC can exceed the sender's outCapacity, which accounts for all active holds.
7. **No state injection**: Committed state is always derived from local transaction execution, never from counterparty-supplied computed values.
8. **Deterministic tiebreaker**: Simultaneous proposals at the same height are resolved identically by both parties without communication (LEFT wins).
9. **Replay protection**: Frame chain linkage (height + prevFrameHash) prevents replay. ACK replay is prevented because the proposal slot is cleared on commit.
10. **Single outstanding proposal**: At most one proposal may be pending per account at any time. New proposals are blocked until the current one is acknowledged or rolled back.
