# E-Layer Specification: BFT Entity Consensus Protocol

## 1. Overview

The Entity layer (E-layer) implements a Byzantine Fault Tolerant consensus protocol for multi-party state machines within the XLN network. Each *entity* is a logical participant (individual, DAO, institution) whose state evolves deterministically through sequenced *entity frames*. Entities are managed by a *board* of validators who collectively authorize state transitions through a weighted quorum mechanism.

The E-layer sits between the Runtime (R-layer) orchestrator above and the bilateral Account (A-layer) channels below. It receives external inputs (user transactions, jurisdiction events, inter-entity messages), batches them into proposals, achieves quorum, and commits frames that advance entity state.

## 2. Consensus Configuration

Each entity carries a `ConsensusConfig` that defines its governance structure:

- **validators**: An ordered list V = [v_0, v_1, ..., v_{n-1}] of signer identifiers. By convention, v_0 is the *proposer*.
- **shares**: A mapping s: V -> Z+ assigning each validator a positive integer weight (voting power).
- **threshold**: A value T in Z+ such that a quorum is reached when the sum of shares of signing validators meets or exceeds T.
- **mode**: Either `proposer-based` (validators send precommits only to the proposer) or `gossip-based` (validators broadcast precommits to all peers).

The *quorum power* of a set of signers S is defined as:

    Q(S) = sum_{v in S} s(v)

A quorum is achieved when Q(S) >= T. For standard BFT safety, T is typically set to floor(2 * totalShares / 3) + 1.

An entity with |V| = 1 and T = 1 is a *single-signer entity* that bypasses the full consensus protocol and applies transactions directly.

## 3. Entity Replica

Each validator v_i maintains a local *EntityReplica* consisting of:

- **state**: The current EntityState (see Section 4).
- **mempool**: An ordered queue of pending EntityTx not yet included in a committed frame.
- **proposal**: The currently active ProposedEntityFrame (proposer only, during an open round).
- **lockedFrame**: The frame this validator has precommitted to (CometBFT-style locking).
- **validatorComputedState**: The state computed locally by this validator during precommit verification, used at commit time instead of the proposer's claimed state (state injection defense).
- **isProposer**: Boolean, true iff this replica's signerId equals v_0.
- **hankoWitness**: A mapping from hash -> {hanko, type, entityHeight, createdAt} storing finalized quorum signatures for on-chain use. This storage is *not* included in the state hash.

## 4. Entity State

EntityState captures the full deterministic state of an entity at a given height:

- **entityId**: 32-byte identifier (0x-prefixed hex).
- **height**: Monotonically increasing frame counter (h in N).
- **timestamp**: Entity-local deterministic clock (milliseconds since epoch).
- **prevFrameHash**: keccak256 hash of the previous committed frame, providing chain linkage.
- **config**: The ConsensusConfig governing this entity.
- **reserves**: Map from tokenId -> amount (bigint), representing on-chain reserve balances.
- **accounts**: Map from AccountKey -> AccountMachine, the bilateral A-layer channels.
- **nonces**: Map from SignerId -> integer, replay protection for chat messages.
- **proposals**: Map from proposalId -> Proposal, the governance proposal registry.
- **htlcRoutes**: Map from hashlock -> HtlcRoute, multi-hop HTLC routing state.
- **htlcFeesEarned**: Cumulative routing fees collected (bigint).
- **lockBook**: Map from lockId -> LockBookEntry, aggregated HTLC lock positions.
- **swapBook**: Map from key -> SwapBookEntry, aggregated swap offer positions.
- **lastFinalizedJHeight**: Height of the last finalized jurisdiction block observed by this entity.
- **jBatchState**: Accumulator for pending on-chain batch submissions.
- **crontabState**: Periodic task scheduler state.

## 5. Entity Frame Hash (Cryptographic Commitment)

Each entity frame is cryptographically bound to its contents and the resulting state via a keccak256 hash. The hash input is a deterministic JSON serialization of:

    H(f) = keccak256(JSON({
        prevFrameHash,
        height,
        timestamp,
        txs: [{type, data}, ...],            -- deterministic tx serialization
        entityId,
        reserves: sorted(entries),            -- lexicographic by tokenId
        lastFinalizedJHeight,
        accountHashes: sorted([{cpId, height, stateHash}, ...]),  -- by counterparty
        htlcRoutesHash: keccak256(sorted(entries)) or null,
        htlcFeesEarned,
        lockBookHash: keccak256(sorted(entries)) or null,
        swapBookHash: keccak256(sorted(entries)) or null,
        orderbookHash: keccak256(ext) or null
    }))

Key design choices:
- Account state is committed via A-layer frame hashes (stateHash per account), not full account state, keeping the entity hash compact.
- All map entries are lexicographically sorted before hashing to guarantee determinism across replicas.
- BigInt values are serialized as strings.
- The hash function is keccak256 for EVM compatibility.

The frame chain is linked: each frame's prevFrameHash equals the hash of its predecessor. The genesis frame uses prevFrameHash = "genesis".

## 6. Frame Lifecycle

### 6.1 Transaction Ingestion (ADD_TX)

Transactions arrive at any replica via EntityInput messages containing entityTxs. Non-proposer replicas forward their mempool contents to v_0 (the proposer). The proposer accumulates transactions in its local mempool.

### 6.2 Proposal (PROPOSE)

When the proposer has a non-empty mempool and no pending proposal, it initiates a new round:

1. Clone current state (immutability guarantee).
2. Set frame timestamp to env.timestamp (runtime-controlled deterministic clock).
3. Apply all mempool transactions sequentially via applyEntityFrame, producing:
   - newState: full entity state after all tx effects.
   - deterministicState: state snapshot *before* account frame proposals (for hash computation).
   - outputs: E->E messages and E->A account inputs.
   - jOutputs: E->J jurisdiction submissions.
   - collectedHashes: additional hashes needing entity-quorum signing (account frames, disputes, settlements).
4. Compute frame hash H(f) from deterministicState (not newState), ensuring validators who run in verifyOnly mode produce the same hash.
5. Construct hashesToSign = [entityFrameHash, ...additionalHashes], sorted deterministically.
6. Self-sign all hashes.
7. Store the proposal with collectedSigs initialized to {v_0: selfSigs}.
8. Broadcast the ProposedEntityFrame to all other validators.

### 6.3 Precommit (SIGN)

Upon receiving a ProposedEntityFrame, validator v_i:

1. Verify it can verify (local height >= proposedFrame.height - 1). If behind, skip verification and wait for commit notification (catch-up path).
2. Apply the proposal's transactions to its own state copy with verifyOnly=true and the proposer's timestamp, producing validatorComputedState.
3. Compute H(f) independently from validatorComputedState.
4. **Reject if hash mismatch**: If the validator's computed hash differs from the proposer's claimed hash, the proposal is rejected (potential equivocation attack or state divergence).
5. Sign all hashes in hashesToSign.
6. Lock to this frame (set lockedFrame).
7. Store validatorComputedState for use at commit time.
8. Send hashPrecommits (Map<signerId, signatures[]>) to the proposer (proposer-based mode) or all validators (gossip-based mode).

### 6.4 Commit (COMMIT)

The proposer (or any validator in gossip mode) collects precommits. For each incoming precommit:

1. Verify signature count matches hashesToSign length.
2. Verify the frame hash signature (sigs[0]) cryptographically against the signer's public key.
3. Detect Byzantine faults: if a signer submits a different signature for the same hash, flag as double-signing.
4. Add to proposal.collectedSigs.

When Q(signers) >= T (threshold reached):

1. **Build quorum hankos**: For each hash in hashesToSign, aggregate the collected validator signatures into a single Hanko (see Section 8).
2. Store hankos in hankoWitness (not part of state hash).
3. Attach quorum hankos to stored outputs (account frames get newHanko, disputes get newDisputeHanko, settlements get settlement hanko).
4. Update state: height = proposal.height, prevFrameHash = proposal.hash.
5. Clear committed transactions from mempool (splice the first N, preserving any newly arrived txs).
6. Clear proposal and lockedFrame.
7. In proposer-based mode: send commit notifications (the full ProposedEntityFrame with collectedSigs and hankos) to all other validators.

### 6.5 Commit Reception (Validators)

When a non-proposer validator receives a commit notification with sufficient quorum:

1. Verify all signatures in collectedSigs against the frame hash.
2. If lockedFrame exists, verify the commit hash matches.
3. Apply committed state: use validatorComputedState if available (validator was up-to-date and verified), otherwise use proposer's newState (catch-up path -- safe because the quorum of up-to-date validators already verified).
4. Clear committed txs from mempool, release lockedFrame.

## 7. Dual-State Determinism

A critical security property of the protocol is that validators *never trust the proposer's claimed state*. The protocol maintains two state paths:

- **Proposer path**: Computes newState (includes account frame proposals, which use env.timestamp for lockIds/timelocks) and deterministicState (state before non-deterministic account proposals).
- **Validator path**: Applies transactions with verifyOnly=true (skips account frame proposals), producing a state matching deterministicState.

The frame hash is computed from deterministicState on both sides, ensuring hash agreement. At commit time:

- The proposer uses proposal.newState (its own computation -- safe, no injection risk).
- Validators use validatorComputedState (their own computation from applying the proposer's txs).
- Behind validators (catch-up) use the proposer's newState, which is safe because the quorum of current validators already verified the hash.

This prevents *state injection attacks* where a Byzantine proposer could include correct transactions but claim a different resulting state (e.g., inflated reserves).

## 8. Hanko M-of-N Quorum Signatures

The Hanko system provides entity-level quorum signatures without requiring pre-stored quorum hashes on-chain. A Hanko is an ABI-encoded structure:

    Hanko = (placeholders: bytes32[], packedSignatures: bytes, claims: Claim[])

    Claim = (entityId: bytes32, entityIndexes: uint256[], weights: uint256[], threshold: uint256)

### 8.1 Construction (buildQuorumHanko)

After consensus threshold is reached for a hash:

1. Partition validators into signers (those who provided valid signatures) and non-signers.
2. **Placeholders**: For each non-signing validator, include their Ethereum address as a bytes32 (left-padded). These occupy index positions [0, ..., |placeholders|-1].
3. **Packed signatures**: Concatenate all signing validators' ECDSA signatures (r[32] || s[32] for each, then v-bits packed into ceil(n/8) bytes). These occupy index positions [|placeholders|, ..., |placeholders|+|signers|-1].
4. **Claim**: A single claim for the entity with:
   - entityId: the entity's 32-byte identifier.
   - entityIndexes: one index per validator (in original board order), pointing to either a placeholder or a signature.
   - weights: one weight per validator (from config.shares).
   - threshold: the entity's consensus threshold.

### 8.2 Verification (verifyHankoForHash)

Verification proceeds as follows:

1. ABI-decode the Hanko structure.
2. Unpack ECDSA signatures and recover EOA addresses from the hash.
3. Find the claim matching the expected entityId.
4. If the verifier has access to the entity's board (via local replica or gossip profile), verify each recovered address is a known board member.
5. Sum weights for indexes pointing to actual signers (not placeholders).
6. Accept if summed weight >= claim.threshold.

### 8.3 Flashloan Governance

The Hanko system supports a "flashloan governance" model where entity claims can reference other entity claims in the same Hanko, enabling hierarchical and even circular delegation chains. During verification, claims are processed sequentially with optimistic "assume YES" semantics -- if Claim_i references Claim_j (j > i), Claim_j is assumed to pass. If any claim later fails, the entire Hanko should be invalidated. In XLN's consensus layer, at least one EOA signature is required to prevent purely circular validation.

## 9. Entity Transaction Types

Entity transactions are processed in mempool order within a single frame. The principal transaction types are:

**Governance**: `propose` (create proposal with threshold-based voting), `vote` (cast weighted vote; if yes-power >= threshold, execute immediately).

**Account Management**: `openAccount` (create bilateral A-layer channel with counterparty, LEFT side queues initial add_delta + set_credit_limit), `extendCredit` (queue set_credit_limit to account mempool).

**Payments**: `directPayment` (single-hop or multi-hop payment via account mempools with route validation), `htlcPayment` (HTLC-based multi-hop with hashlock/timelock).

**Account Consensus Bridge**: `accountInput` (incoming A-layer frame from counterparty entity, processed by handleAccountInput).

**Jurisdiction Events**: `j_event` (on-chain event from J-watcher, processed for reserve updates, settlement confirmations, dispute outcomes), `j_broadcast` (submit accumulated jBatch to chain), `j_clear_batch` (abort pending batch).

**Settlement**: `settle_propose`, `settle_update`, `settle_approve`, `settle_execute`, `settle_reject` (full settlement workspace lifecycle for cooperative on-chain settlement).

**Reserve Operations**: `deposit_collateral`, `reserve_to_reserve`, `mintReserves`.

**Maintenance**: `processHtlcTimeouts` (resolve expired HTLC locks), `rollbackTimedOutFrames` (clear stale pending A-layer frames with backward HTLC cancellation).

## 10. Crontab: Periodic Task Execution

Each entity replica runs a deterministic crontab system within entity frame processing. Tasks execute based on entity-local timestamp (not wall clock), ensuring determinism across replicas. Registered tasks:

- **checkAccountTimeouts** (every 10s): Scans pending A-layer frames for expired HTLC locks. Generates rollbackTimedOutFrames transaction for accounts with expired locks. Warns about stale non-HTLC frames (>30s).
- **broadcastBatch** (every 5s): Submits accumulated jBatch to the jurisdiction's Depository contract when the batch is non-empty and ready.
- **hubRebalance** (every 30s): Scans accounts for net-spender/net-receiver imbalances and suggests rebalancing opportunities.
- **checkHtlcTimeouts** (every 5s): Scans all account lock maps for expired HTLCs (by height or timestamp) and generates processHtlcTimeouts transactions.

## 11. Message Passing Between Entities

Inter-entity communication occurs through RoutedEntityInput messages routed by the R-layer:

- **E -> E (tx forwarding)**: Non-proposer validators forward mempool to proposer. Proposer broadcasts proposals and commit notifications.
- **E -> E (account frames)**: After entity consensus, account frame proposals are sent to the counterparty entity's proposer as accountInput transactions.
- **E -> E (account opening)**: openAccount sends mirror-creation request to counterparty. The counterparty's accounts.has() check prevents infinite ping-pong.
- **E -> J (batch submission)**: Entity consensus produces JInput messages queued for on-chain submission.

The R-layer strips routing hints (signerId, runtimeId) at the R->E boundary, ensuring the deterministic consensus logic never sees transport metadata.

## 12. Input Merging

When multiple EntityInputs target the same (entityId, signerId) pair within a single tick, they are merged:

- entityTxs are concatenated (with J-event deduplication by blockNumber+blockHash).
- hashPrecommits are union-merged by signerId.
- proposedFrame conflicts (different hashes) are preserved as separate inputs; the input carrying precommits takes priority.

## 13. Invariants

1. **Frame chain integrity**: For committed frame f at height h, f.prevFrameHash = H(f_{h-1}).
2. **Deterministic state binding**: H(f) is computed from deterministicState, which is identical on proposer and all verifying validators.
3. **No state injection**: Validators use their own computed state at commit time, never the proposer's claimed newState.
4. **Quorum safety**: State transitions require Q(signers) >= T where T is the configured threshold.
5. **Mempool preservation**: Only committed transactions are removed from the mempool; transactions arriving during a round are preserved.
6. **Single active proposal**: A proposer has at most one open proposal at any time.
7. **Lock consistency**: A validator's lockedFrame, if set, must match the commit notification's frame hash.
8. **Byzantine fault detection**: Double-signing (same signerId, different signature for same hash) is flagged.
9. **Voting power bounds**: Voting power must be non-negative and below 2^53 - 1.
10. **Mempool size limit**: Entity mempool is bounded at 1000 transactions.
11. **Validator count limit**: Maximum 100 validators per entity.
12. **Conservation at A-layer boundary**: For any settlement diff, leftDiff + rightDiff + collateralDiff = 0.
