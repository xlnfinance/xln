# XLN Protocol Specification

**Version 0.1 — February 2026**

XLN is a bilateral consensus network for instant off-chain settlement with on-chain finality. The protocol implements a four-layer architecture (R/J/E/A) where the core state machine is a pure function: given identical inputs, all correct nodes produce identical outputs. This specification defines the protocol completely, omitting implementation details (UI, networking transport, visualization) that have no consensus impact.

---

## 1. Runtime Orchestration (R-Layer)

### 1.1 Global State

The top-level state of an XLN node is a single value **Env**:

```
Env = {
  eReplicas : Map<ReplicaKey, EntityReplica>,
  jReplicas : Map<String, JReplica>,
  height    : N,
  timestamp : N,
  mempool   : RuntimeInput,
  pending   : RoutedEntityInput[],
  history   : EnvSnapshot[]
}
```

where ReplicaKey = EntityId:SignerId. The two replica maps partition the system into an **entity layer** (off-chain BFT consensus) and a **jurisdiction layer** (on-chain EVM settlement).

**EntityReplica.** Each entry is one signer's view of one entity:

```
EntityReplica = {
  entityId, signerId, state: EntityState,
  mempool: EntityTx[], proposal?: ProposedEntityFrame,
  lockedFrame?: ProposedEntityFrame,
  validatorComputed?: EntityState, isProposer: Bool,
  hankoWitness?: Map<String, HankoRecord>
}
```

EntityState contains the full entity: reserves, accounts (each an AccountMachine with bilateral deltas, locks, swap offers), nonces, governance proposals, HTLC routing tables, J-block observation chain, and crontab state.

**JReplica.** Each entry is one EVM jurisdiction:

```
JReplica = { name, blockNumber, stateRoot, mempool: JTx[],
             jadapter?: JAdapter, reserves?, collaterals? }
```

### 1.2 State Transition Function

The runtime is a discrete-time system with a pure core:

```
tau : S x I -> S x O
E_{t+1} = commit(apply(drain(E_t, I_t)))
```

where **drain** collects pending work, **apply** processes RuntimeTxs then EntityInputs producing (entityOutbox, jOutbox), and **commit** increments height, captures snapshot, and dispatches side effects.

The runtime loop is a single async chain (no re-entry by construction): `while running: if hasWork(E): E <- process(E); await sleep(tickDelayMs)`. Default tick delay is 25ms; scenario mode advances timestamp deterministically by +100ms per tick.

### 1.3 Cascade Prevention Invariant

**E-to-E communication always requires a new tick.** When entity E_a produces outputs for entity E_b during tick t, those outputs are enqueued into `mempool.entityInputs` for tick t+1, never processed inline. This prevents unbounded recursive cascades and guarantees finite tick duration.

### 1.4 Input Routing and Normalization

**RoutedEntityInput** extends **EntityInput** with routing hints:

```
EntityInput = { entityId, entityTxs?, proposedFrame?, hashPrecommits? }
RoutedEntityInput = EntityInput & { signerId?, runtimeId? }
```

At the R-to-E boundary, the runtime strips routing hints, ensuring deterministic consensus logic never sees transport metadata. Inputs sharing the same (entityId, signerId) key are merged: entityTxs concatenated (with J-event deduplication), hashPrecommits union-merged, proposedFrame conflicts preserved separately.

### 1.5 Type Hierarchy

```
Env
 +-- Map<ReplicaKey, EntityReplica>
 |    +-- EntityState
 |    |    +-- Map<AccountKey, AccountMachine>    (bilateral channels)
 |    |    |    +-- Map<TokenId, Delta>            (per-token state)
 |    |    |    +-- Map<LockId, HtlcLock>          (conditional payments)
 |    |    |    +-- Map<String, SwapOffer>          (limit orders)
 |    |    +-- Map<String, bigint>                 (reserves)
 |    |    +-- Map<String, HtlcRoute>              (HTLC routing)
 |    |    +-- ConsensusConfig
 +-- Map<String, JReplica>
 +-- EnvSnapshot[]                                 (time-travel history)
```

### 1.6 Branded Types

| Type | Format | Purpose |
|------|--------|---------|
| EntityId | 0x + 64 hex (32 bytes) | Entity identity |
| SignerId | non-empty string | Wallet address or name |
| JId | chain ID or hash | Jurisdiction identity |
| TokenId | non-negative integer | Token identity |
| LockId | non-empty string | HTLC lock identity |
| AccountKey | leftEntityId:rightEntityId (sorted) | Bilateral account identity |

Principle: **validate at source, trust at use**. Constructors enforce invariants at system boundaries; downstream code operates on branded types without re-checking.

### 1.7 Determinism Rules

Within the RJEA cascade:

| Prohibited | Replacement |
|-----------|-------------|
| Date.now() | env.timestamp (controlled clock) |
| Math.random() | Seeded PRNG |
| setTimeout/setInterval | Tick-based delays via timestamp checks |
| crypto.randomBytes() | Seeded generator |

Non-deterministic operations (P2P dispatch, persistence, JAdapter broadcast) execute only after the commit point and cannot affect consensus state.

### 1.8 Threat Model

**Network model.** We assume a partially synchronous network: there exists an unknown Global Stabilization Time (GST) and a known bound Delta such that after GST, every message between correct nodes is delivered within Delta time. Before GST, messages may be arbitrarily delayed or reordered.

**Adversary model.** We consider a computationally bounded adversary Adv who may corrupt up to f participants in various protocol layers:

| Layer | Corruption Bound | Safety Guarantee | Liveness Guarantee |
|-------|------------------|------------------|--------------------|
| A-layer (bilateral) | At most 1 of 2 parties | 2-of-2 signatures required for any state change | Counterparty timeout triggers unilateral dispute on J-layer |
| E-layer (entity BFT) | f < T (threshold) validators | No conflicting frames committed at same height (Theorem 1) | Progress when >= T honest validators are online |
| J-layer (on-chain) | Inherits EVM security | Contract logic is immutable trust anchor | Blockchain liveness (assumed) |

**Clock model.** Each node maintains a local clock. The protocol uses `env.timestamp` as a controlled logical clock. A-layer frames enforce monotonicity: `timestamp_h = max(env.timestamp, timestamp_{h-1} + 1)`. Clock skew between nodes does not affect safety (frame hashes bind to agreed timestamps), only liveness (delayed timestamp propagation may delay frame proposals).

**Denial of service.** If the E-layer proposer (v_0) crashes, no new entity frames are produced until recovery. The current protocol does not implement view change or proposer rotation. A-layer liveness depends on counterparty responsiveness; an unresponsive counterparty triggers the dispute path on-chain after a configurable timeout.

**Adversary capabilities.** Adv may: (1) send arbitrary messages on behalf of corrupted parties, (2) delay or reorder messages between correct nodes (subject to partial synchrony bounds), (3) observe all network traffic. Adv may NOT: (1) forge signatures (secp256k1 ECDLP hardness), (2) find hash collisions (keccak256 collision resistance), (3) violate EVM execution semantics.

---

## 2. Jurisdiction Layer (J-Layer)

### 2.1 Architecture

The J-layer provides cryptoeconomic finality via four EVM contracts:

| Contract | Role |
|----------|------|
| Depository.sol | Reserve custody, batch execution, dispute finalization, debt/insurance |
| EntityProvider.sol | Entity registry, Hanko signature verification, governance (BCD model) |
| Account.sol | Bilateral settlement diffs, dispute starts, cooperative proofs |
| DeltaTransformer.sol | Programmable delta transforms (HTLCs, atomic swaps) |

### 2.2 On-Chain Data Structures

**Reserves:** `mapping(bytes32 => mapping(uint => uint)) _reserves` — entity reserves per token, the on-chain solvency anchor.

**Bilateral Account State:**

```
AccountInfo = { cooperativeNonce, disputeHash, disputeTimeout }
AccountCollateral = { collateral, ondelta }
```

Account keys: `abi.encodePacked(min(e1,e2), max(e1,e2))`, enforcing canonical left < right ordering.

**Settlement Diff (Conservation Law):**

```
SettlementDiff = { tokenId, leftDiff, rightDiff, collateralDiff, ondeltaDiff }
INVARIANT: leftDiff + rightDiff + collateralDiff = 0
```

### 2.3 Settlement Flows

**Cooperative Settlement.** Both entities agree off-chain, counterparty signs via Hanko, initiator submits to Depository. Conservation law enforced on-chain. Signature includes depositoryAddress and chainId for cross-chain replay protection.

**Dispute (Unilateral Close).** Three phases:
1. **Start:** Disputer submits InitialDisputeProof with counterparty's previously-signed state. disputeTimeout = block.number + disputeDelay.
2. **Response:** Counterparty can submit counter-dispute with newer disputeNonce.
3. **Finalization:** After timeout, contract recomputes deltas from ProofBody (offdeltas + DeltaTransformer execution), distributes collateral.

**Cooperative Finalization:** During active dispute, both parties can bypass timeout with fresh cooperative signature. Requires cooperativeNonce > 0.

**Delta interpretation on finalization:** Given totalDelta = ondelta + offdelta and collateral c:
- delta <= 0: Right gets all collateral; left owes |delta|
- 0 < delta < c: Left gets delta, right gets c - delta
- delta >= c: Left gets all collateral; right owes delta - c

Shortfall cascade: reserves -> insurance lines (FIFO) -> debt creation.

### 2.4 Batch Execution

The Batch struct enables atomic multi-operation execution:

```
Batch = { flashloans, reserveToReserve, reserveToCollateral,
          collateralToReserve, settlements, disputeStarts,
          disputeFinalizations, externalTokenToReserve,
          reserveToExternalToken, revealSecrets, hub_id }
```

Execution order (increases before decreases): flashloans -> deposits -> R2R -> C2R -> settlements -> disputes -> secret reveals -> dispute finalizations -> R2C -> withdrawals -> flashloan invariant check.

### 2.5 Entity Registration

**Registered entities:** On-chain via registerNumberedEntity(). Sequential numbering. Board hash stored in entities[entityId].currentBoardHash.

**Lazy entities:** No registration. entityId = uint256(keccak256(board)), self-describing governance.

### 2.6 BCD Governance

Three proposer tiers with time-locked board transitions:

| Tier | Priority | Delay | Can Cancel |
|------|----------|-------|------------|
| Control (C) | Highest | controlDelay blocks | Board, Dividend |
| Board (B) | Medium | 0 (immediate) | Dividend |
| Dividend (D) | Lowest | dividendDelay blocks | None |

ERC-1155 control and dividend tokens (fixed supply: 10^15 each).

### 2.7 DeltaTransformer

Programmable delta transforms executed during dispute finalization:

- **Payment (HTLC):** Conditional delta shift based on hashlock preimage reveal.
- **Swap:** Cross-token exchange with fillRatio (counterparty chooses fill ratio).

Allowance bounds constrain how much each transformer clause can shift deltas.

### 2.8 Cryptoeconomic Guarantees

**Enforced on-chain:** Reserve solvency, conservation law, dispute timeouts, nonce ordering, flashloan invariant, debt priority, insurance cascade.

**Enforced off-chain (verified on dispute):** Bilateral consensus signatures, HTLC timeouts (via DeltaTransformer), credit limits, frame ordering via disputeNonce.

**Trust boundary:** The Depository never trusts off-chain state claims. During dispute finalization, it recomputes deltas from ProofBody and applies them to on-chain ondelta.

---

## 3. Entity Consensus (E-Layer)

### 3.1 Consensus Configuration

Each entity carries a ConsensusConfig:

- **validators:** Ordered list V = [v_0, ..., v_{n-1}], where v_0 is the proposer.
- **shares:** Mapping s: V -> Z+ (voting power per validator).
- **threshold:** T in Z+ such that quorum requires Q(S) = sum_{v in S} s(v) >= T.

For standard BFT safety, T = floor(2 * totalShares / 3) + 1. Single-signer entities (|V| = 1, T = 1) bypass full BFT and apply directly.

### 3.2 Entity State

EntityState at height h contains: entityId, height, timestamp, prevFrameHash, config, reserves (Map tokenId -> amount), accounts (Map AccountKey -> AccountMachine), nonces, proposals, htlcRoutes, htlcFeesEarned, lockBook, swapBook, lastFinalizedJHeight, jBatchState, crontabState.

### 3.3 Entity Frame Hash

```
H(f) = keccak256(JSON({
    prevFrameHash, height, timestamp,
    txs: [{type, data}, ...],
    entityId,
    reserves: sorted(entries),
    lastFinalizedJHeight,
    accountHashes: sorted([{cpId, height, stateHash}, ...]),
    htlcRoutesHash, htlcFeesEarned, lockBookHash, swapBookHash
}))
```

Account state committed via A-layer frame hashes (compact). All map entries lexicographically sorted. BigInt serialized as strings.

### 3.4 Frame Lifecycle

**ADD_TX.** Transactions arrive at any replica. Non-proposers forward to v_0.

**PROPOSE.** When proposer has non-empty mempool and no pending proposal:
1. Clone state. Set frame timestamp to env.timestamp.
2. Apply all mempool txs, producing newState, deterministicState (before account proposals), outputs, jOutputs.
3. Compute H(f) from deterministicState.
4. Construct hashesToSign = [entityFrameHash, ...additionalHashes].
5. Self-sign all hashes. Broadcast ProposedEntityFrame.

**SIGN (Precommit).** Validator v_i receiving a proposal:
1. Apply proposal's txs with verifyOnly=true, producing validatorComputedState.
2. Compute H(f) independently. **Reject on hash mismatch.**
3. Sign all hashes. Lock to this frame. Store validatorComputedState.
4. Send hashPrecommits to proposer.

**COMMIT.** When Q(signers) >= T:
1. Build quorum Hankos for each hash.
2. Store hankos in hankoWitness (not in state hash).
3. Update state: height, prevFrameHash. Clear committed txs from mempool.
4. Send commit notifications to validators.

### 3.5 Dual-State Determinism

**Validators never trust the proposer's claimed state.** Two paths:

- Proposer computes newState (full effects) and deterministicState (before account proposals).
- Validators compute state matching deterministicState via verifyOnly=true.

Frame hash computed from deterministicState on both sides. At commit: proposer uses its own newState, validators use validatorComputedState, behind validators use proposer's newState (safe: quorum already verified hash).

### 3.6 Entity Transaction Types

**Governance:** propose, vote (weighted quorum, immediate on threshold). **Accounts:** openAccount, extendCredit. **Payments:** directPayment, htlcPayment. **Consensus bridge:** accountInput (A-layer frames from counterparty). **Jurisdiction:** j_event, j_broadcast, j_clear_batch. **Settlement:** settle_propose/update/approve/execute/reject. **Reserves:** deposit_collateral, reserve_to_reserve, mintReserves. **Maintenance:** processHtlcTimeouts, rollbackTimedOutFrames.

### 3.7 Crontab

Deterministic periodic tasks (based on entity-local timestamp, not wall clock):

| Task | Interval | Purpose |
|------|----------|---------|
| checkAccountTimeouts | 10s | Scan expired HTLC locks, generate rollback txs |
| broadcastBatch | 5s | Submit accumulated jBatch to Depository |
| hubRebalance | 30s | Suggest rebalancing for net imbalances |
| checkHtlcTimeouts | 5s | Scan account lock maps for expired HTLCs |

### 3.8 Invariants

1. Frame chain integrity: f.prevFrameHash = H(f_{h-1}).
2. Deterministic state binding: H(f) identical on proposer and verifying validators.
3. No state injection: validators use own computed state at commit time.
4. Quorum safety: Q(signers) >= T.
5. Single active proposal per entity.
6. Byzantine fault detection: double-signing flagged.
7. Mempool bounded at 1000 txs. Validators bounded at 100.

---

## 4. Account Consensus (A-Layer)

### 4.1 AccountMachine State

An AccountMachine M between entities L (left) and R (right):

**Canonical identity.** L = min(id_A, id_B), R = max(id_A, id_B) by lexicographic ordering. Immutable for the account lifetime.

**Delta table.** Map D: TokenId -> Delta:

```
Delta = (tokenId, collateral, ondelta, offdelta,
         leftCreditLimit, rightCreditLimit,
         leftAllowance, rightAllowance,
         leftHtlcHold, rightHtlcHold,
         leftSwapHold, rightSwapHold,
         leftSettleHold, rightSettleHold)
```

Total delta = ondelta + offdelta. Sign convention: positive means R owes L.

**Frame chain.** Hash-linked AccountFrames. Tracks currentHeight h, currentFrame F_h.

**Mempool.** Ordered pending AccountTx list, bounded at 1000.

**Proposal slot.** At most one outstanding ProposalState.

**Proof header.** (fromEntity, toEntity, cooperativeNonce, disputeNonce) for on-chain enforcement.

### 4.2 Balance Derivation

Given Delta and perspective isLeft, with c = max(0, collateral), d = ondelta + offdelta:

From L's perspective:
- outCapacity = max(0, outPeerCredit + outCollateral + outOwnCredit - leftAllowance - leftHold)
- inCapacity = max(0, inOwnCredit + inCollateral + inPeerCredit - rightAllowance - rightHold)

where leftHold = leftHtlcHold + leftSwapHold + leftSettleHold.

### 4.3 Conservation Law

Every settlement operation satisfies: **leftDiff + rightDiff + collateralDiff = 0**. Enforced at construction. No value created or destroyed.

### 4.4 Frame Lifecycle

**Proposal.** Entity P with non-empty mempool:
1. Clone M to M'. Execute txs on clone (failed txs dropped, not aborted).
2. Extract (tokenIds, deltas, fullDeltaStates) sorted by tokenId.
3. Construct frame: height = h+1, timestamp = max(env.timestamp, prev+1), jHeight, accountTxs, prevFrameHash, byLeft = (P = L).
4. Hash: stateHash = keccak256(deterministicJSON(frameData)).
5. Sign frame hash + dispute proof hash via Hanko.
6. Clear mempool. Store proposal. Transmit.

**Verification (Receiver).** Entity V receives frame F' at h+1:
1. Validate structure, chain linkage, sequence.
2. Handle simultaneous proposals (Section 4.5).
3. Verify Hanko signature on stateHash.
4. Replay all txs on clone. Compare state: bilateral fields must match exactly (ondelta/collateral may differ due to J-event timing).
5. Recompute hash from own state. Must equal F'.stateHash.
6. **Commit using own computed values, never counterparty's claimed state.**
7. Sign and ACK. May batch new proposal in ACK message.

**Confirmation.** Proposer receives ACK: verify Hanko, re-execute txs on real M, commit.

### 4.5 Simultaneous Proposal Tiebreaker

When both parties propose at height h+1: **LEFT always wins.**

- E = L: ignore received frame, keep own proposal, wait for R's ACK.
- E = R: roll back own proposal, restore txs to mempool front, accept L's frame.

Rollback bounded: consecutive rollback signals consensus failure. Deterministic: both sides compute isLeft from lexicographic entity ID ordering.

### 4.6 Frame Hash

```
stateHash = keccak256(UTF8(deterministicJSON({
    height, timestamp, jHeight, prevFrameHash, accountTxs,
    tokenIds, deltas, fullDeltaStates (all 14 fields as strings)
})))
```

### 4.7 Dispute Proofs

Each frame exchange produces two signatures:

**ProofBody:** ABI-encoded (offdeltas[], tokenIds[], transformers[]).
proofBodyHash = keccak256(abiEncode(ProofBody)).

**Dispute hash:**
```
keccak256(ABI(MessageType.DisputeProof, depositoryAddress,
              channelKey, cooperativeNonce, disputeNonce, proofBodyHash))
```

**Settlement hash:**
```
keccak256(ABI(MessageType.CooperativeUpdate, depositoryAddress,
              channelKey, nonce, diffs[], forgiveDebts[], insuranceRegs[]))
```

### 4.8 Invariants

1. Both parties maintain byte-identical state after every committed frame.
2. Chain integrity: F_{h+1}.prevFrameHash = F_h.stateHash.
3. Monotonic heights and timestamps.
4. Conservation: leftDiff + rightDiff + collateralDiff = 0.
5. Capacity safety: no payment/HTLC exceeds outCapacity (including all holds).
6. No state injection: committed state from local execution only.
7. Deterministic tiebreaker: LEFT wins, no communication needed.
8. Single outstanding proposal per account.

---

## 5. HTLC and Multi-Hop Payments

### 5.1 HTLC Lock Structure

```
HtlcLock = { lockId, hashlock, timelock, revealBeforeHeight,
             amount, tokenId, senderIsLeft, createdHeight, envelope }
```

lockId = keccak256(hashlock || height || nonce || timestamp). hashlock = keccak256(abi.encode(secret)).

### 5.2 Delta Hold Mechanism

Locks reserve capacity: senderIsLeft -> leftHtlcHold += amount. outCapacity deducts all holds, preventing double-spend across concurrent HTLCs.

### 5.3 Fee Structure

Micro-basis-points: fee = (amount * FEE_RATE_UBP) / 10,000,000. At 100 ubp (= 1bp), $10,000 payment -> $0.10 fee. Fees accrue to htlcFeesEarned only on successful reveal.

### 5.4 Timelock Cascade

Decreasing along route to prevent griefing:

```
For route [Alice, Hub, Bob] with baseTimelock T:
  Alice: T,      revealBeforeHeight = H + 3
  Hub:   T-10s,  revealBeforeHeight = H + 2
  Bob:   T-20s,  revealBeforeHeight = H + 1
```

General: hopTimelock = baseTimelock - (totalHops - hopIndex - 1) * MIN_TIMELOCK_DELTA_MS.

### 5.5 Multi-Hop Flow

**Lock phase (forward: Alice -> Hub -> Bob):**
1. Alice creates onion envelope (layered encryption), queues htlc_lock to Alice-Hub account.
2. Bilateral frame consensus signs the lock.
3. On commit, Hub decrypts envelope layer, deducts fee, registers htlcRoute, forwards htlc_lock to Hub-Bob account with inner envelope.
4. Bob decrypts final layer, extracts secret.

**Settle phase (backward: Bob -> Hub -> Alice):**
1. Bob submits htlc_resolve(outcome='secret', secret=s) on Hub-Bob account. offdelta shifts.
2. Hub looks up htlcRoutes by hashlock, accrues fee, submits htlc_resolve with secret on Alice-Hub account.
3. Alice's lock settles. Payment complete.

**Cancel/timeout phase:**
- On timelock expiry: htlc_resolve(outcome='error', reason='timeout'). Hold released, no offdelta change. Propagates backward.

### 5.6 Delta Mechanics

- **Lock:** Hold increases, no offdelta change.
- **Settle:** offdelta += senderIsLeft ? -amount : +amount. Hold released.
- **Cancel:** Hold released. No offdelta change.

### 5.7 Atomicity

Hashlock binding (all hops share H(secret)) + timelock ordering (sender has most time) + capacity isolation (holds prevent over-commitment). No global coordinator needed.

---

## 6. Cryptographic Primitives

### 6.1 Notation

| Symbol | Meaning |
|--------|---------|
| H_k(m) | keccak256(m) |
| H_s(m) | SHA-256(m) |
| H_b(m) | BLAKE3(m) |
| Sign_sk(h) | secp256k1 ECDSA over 32-byte hash h |
| Recover(h, sig) | ECDSA public key recovery |
| addr(pk) | Ethereum address: H_k(pk_uncompressed[1:])[12:] |

### 6.2 Signature Scheme

**Curve:** secp256k1. **Signing:** Raw hash (NO EIP-191/712 prefix). sig = ECDSA_Sign(sk, h) -> (r: 32B, s: 32B, v in {27,28}). Matches Solidity ecrecover directly.

### 6.3 Hash Function Usage

| Context | Hash | Rationale |
|---------|------|-----------|
| Frame state hashes | keccak256 | EVM ecrecover compatibility |
| Dispute/settlement proofs | keccak256(ABI(...)) | On-chain verification |
| HTLC hashlock | SHA-256 | Standard lightning-style |
| BrainVault shard salt | BLAKE3 | Speed for iterated KDF |
| BrainVault KDF | Argon2id (256 MB) | Memory-hard resistance |
| Key derivation (named signers) | HMAC-SHA256 | Deterministic, non-invertible |

### 6.4 Key Derivation (BrainVault)

From inputs (name, passphrase, factor):
1. N = 10^(factor-1) shards.
2. Per-shard: salt_i = BLAKE3(NFKD(name) || ALG_ID || N || i).
3. shard_i = Argon2id(NFKD(passphrase), salt_i, mem=256MB, t=1, p=1, out=32B).
4. master = BLAKE3(shard_0 || ... || shard_{N-1} || domain_tag).
5. Mnemonic: 256-bit entropy -> 24-word BIP-39.

**Signer derivation:** Numeric IDs use BIP-44 (m/44'/60'/0'/0/{index}). Named IDs use HMAC-SHA256(seed, name).

### 6.5 Hanko Quorum Signature Format

```
HankoBytes = ABI.encode(placeholders: bytes32[], packedSignatures: bytes, claims: HankoClaim[])
HankoClaim = (entityId: bytes32, entityIndexes: uint256[], weights: uint256[], threshold: uint256)
```

**Index zones:** [0, |placeholders|) = absent members, [|placeholders|, |placeholders|+|signers|) = EOA signers, [|placeholders|+|signers|, ...) = entity claims (optimistic "assume YES").

**Packed signatures:** N * 64 bytes (R||S) + ceil(N/8) bytes (V bits). Total: 64n + ceil(n/8) bytes.

**Verification:** Recover EOA addresses from packed sigs. For each claim, sum weights where indexes point to recovered signers. Accept if sum >= threshold.

**Security:** EOA voting power alone must meet threshold. Entity claims add governance flexibility but cannot be the sole control mechanism (prevents circular-reference attacks).

**Lazy entities:** entityId = uint256(keccak256(board)), self-describing governance.

### 6.6 Deterministic Serialization

safeStringify: BigInt -> "BigInt(N)", Map -> Object.fromEntries, Set -> Array. For on-chain proofs: standard Solidity ABI encoding via ethers.AbiCoder.

### 6.7 Replay Protection

| Mechanism | Scope |
|-----------|-------|
| prevFrameHash chain | A-layer, E-layer frame ordering |
| cooperativeNonce | On-chain settlement replay |
| disputeNonce | Dispute proof versioning |
| depositoryAddress | Cross-chain domain separation |
| channelKey | Cross-account binding |

### 6.8 Security Model

**Adversary assumptions:**
- A-layer: At most 1-of-2 Byzantine. Safety: 2-of-2 signatures. Liveness: counterparty responsiveness (timeout to dispute).
- E-layer: f < threshold Byzantine validators. Safety: quorum agreement. Liveness: >= threshold honest online.
- J-layer: Inherits EVM security model.

**Trust boundaries:**

| Boundary | Verified | Assumed |
|----------|----------|---------|
| Proposer state | Rejected (validators recompute) | Tx ordering within frame |
| EOA signatures | ecrecover on raw hash | secp256k1 hardness |
| Hanko quorum | Weight sum >= threshold | Board membership current |
| Frame chain | prevFrameHash linkage | No keccak256 collisions |
| On-chain settlement | Contract logic + nonces | EVM execution correctness |
| HTLC preimage | H_s(secret) == hashlock | SHA-256 preimage resistance |

**State injection defense:** Validators never accept proposer's newState. They recompute independently, sign only on hash match, and use their own validatorComputedState at commit time.

---

## 7. Related Work

XLN builds on two decades of research in payment channels, state channels, and off-chain scaling. This section situates the protocol among its closest relatives and highlights the design decisions that distinguish XLN's bilateral-mesh, multi-token architecture from prior work.

### 7.1 Payment Channel Networks

**Lightning Network** [Poon and Dryja 2016]. The Lightning Network introduced hash-time-locked contracts (HTLCs) over bidirectional payment channels with a penalty-based revocation mechanism. Its hub-and-spoke routing topology requires pathfinding across a public channel graph, and each channel is denominated in a single token. Watchtowers or continuous online monitoring are necessary to detect revoked commitments. XLN departs from Lightning in several ways: (i) bilateral mesh topology eliminates routing bottlenecks by allowing any two entities to open a direct channel, (ii) per-token delta tables within a single account support multi-asset settlement without additional channels, (iii) entity-level BFT consensus (Section 3) replaces watchtower-dependent revocation with quorum-signed frame chains, and (iv) credit limits (leftCreditLimit, rightCreditLimit) reduce collateral requirements by allowing trust-bounded undercollateralized capacity.

**Sprite Channels** [Miller et al. 2019]. Sprite introduced a preimage manager contract that decouples dispute resolution from individual channel closes, reducing worst-case collateral lockup time from O(n) hops to O(1). XLN adopts a decreasing timelock cascade (Section 5.4) for HTLC griefing prevention but resolves disputes bilaterally rather than through a shared on-chain preimage registry, avoiding the global coordination overhead of the Sprite approach.

### 7.2 State Channel Frameworks

**Perun** [Dziembowski et al. 2019]. The Perun framework provides virtual payment channels with a universally composable (UC) security proof. Perun's virtual channels allow two parties to transact through an intermediary without on-chain interaction, using n-of-n multisignature authorization. XLN takes a different architectural path: rather than constructing virtual channels, entity consensus (Section 3) provides multi-party coordination directly. The Hanko quorum signature format (Section 6.5) replaces n-of-n multisig with threshold-weighted verification, enabling flexible governance (BCD tiers, Section 2.6) without requiring all validators to co-sign every operation.

**Nitro Protocol** [Close et al. 2019]. Nitro introduced a turn-based state channel protocol that supports off-chain virtual channels funded from ledger channels, with an outcome-based on-chain adjudication layer. Participants alternate turns to advance channel state. XLN's account consensus (Section 4) replaces turn-taking with simultaneous proposal capability and a deterministic tiebreaker (Section 4.5): when both parties propose at the same height, the lexicographically smaller entity (LEFT) always wins. This eliminates the need for turn ordering, reduces round trips for bilateral updates, and ensures progress even under concurrent proposals.

### 7.3 Commit Chains and Rollups

**Plasma** [Poon and Buterin 2017]. Plasma introduced a framework for off-chain execution with on-chain fraud proofs, relying on a centralized operator to order transactions and publish commitments. Users must monitor the operator and exit if misbehavior is detected. **Optimistic Rollups** [Kalodner et al. 2018] and **ZK-Rollups** [Ben-Sasson et al. 2019] refine this model with challenge periods or validity proofs, respectively, but retain a centralized sequencer for transaction ordering.

XLN differs from rollup architectures in three fundamental respects. First, there is no central operator or sequencer; bilateral accounts settle peer-to-peer with 2-of-2 consensus, and entity boards achieve agreement via threshold BFT. Second, settlement is on-demand rather than batched: any bilateral pair can cooperatively settle at any time by submitting a signed diff to the Depository (Section 2.3), without waiting for a batch window or challenge period. Third, disputes in XLN are bilateral, not global; a dispute between entities A and B does not affect entities C and D, unlike rollup fraud proofs that may halt the entire chain during a challenge.

### 7.4 Credit Networks

**SilentWhispers** [Malavolta et al. 2017] and **PathShuffle** [Moreno-Sanchez et al. 2015] explored privacy-preserving credit networks where payment capacity derives from bilateral trust lines rather than locked collateral. XLN's credit limit mechanism (leftCreditLimit, rightCreditLimit in the Delta structure, Section 4.1) extends this line of work into a bilateral mesh channel setting. Credit limits allow entities to grant unsecured capacity to trusted counterparties, reducing on-chain collateral requirements while preserving the hold-based capacity isolation (Section 5.2) that prevents over-commitment across concurrent HTLCs.

### 7.5 Comparison

| Feature | XLN | Lightning | Perun | Rollups |
|---------|-----|-----------|-------|---------|
| Topology | Bilateral mesh | Hub-spoke | Star / virtual | Centralized operator |
| Multi-token | Native (per-token deltas) | Single | Per-channel | Native |
| Governance | BCD tiers + Hanko quorum | None | Multisig (n-of-n) | Operator / DAO |
| Dispute mechanism | Bilateral + DeltaTransformer | Penalty / justice tx | Challenge-response | Fraud / validity proof |
| Settlement | Cooperative or unilateral | Cooperative or force-close | Cooperative or dispute | Batch submission |
| Capital efficiency | Credit limits reduce lockup | Full collateral required | Full collateral | Shared pool |
| BFT consensus | T-of-N entity board | None (2-of-2 only) | None (n-of-n) | Single sequencer |
| Concurrency model | Simultaneous proposals + tiebreaker | Turn-based (revocation) | Turn-based | Sequencer-ordered |
| State verification | Validators recompute independently | Watchtower monitoring | On-chain adjudication | Fraud / validity proof |

### 7.6 Key Differentiators

Three design choices distinguish XLN from the systems above:

1. **Simultaneous-proposal tiebreaker** (Section 4.5). Unlike turn-based protocols (Lightning, Nitro, Perun), XLN allows both bilateral parties to propose concurrently. The deterministic LEFT-wins rule resolves conflicts without communication, eliminating the liveness dependency on strict turn alternation.

2. **Validator-recomputed state** (Section 3.5). In entity consensus, validators never trust the proposer's claimed state. Each validator independently applies the proposed transactions and rejects on hash mismatch. This dual-state determinism model is stricter than optimistic approaches (rollups rely on post-hoc fraud proofs) and more efficient than full re-execution schemes (validators only recompute, they do not re-propose).

3. **Hanko quorum without on-chain quorum storage** (Section 6.5). The Hanko format encodes weighted threshold signatures in a self-describing byte layout. Lazy entities derive their identity from the hash of their board configuration, enabling governance verification without prior on-chain registration. This contrasts with multisig schemes (Perun, Gnosis Safe) that require pre-registered signer sets on-chain.

---

## 8. Security Analysis

This section presents formal safety theorems, conservation proofs, and mechanism correctness results for the XLN protocol. Proof sketches are provided; full machine-checked proofs are deferred to a companion technical report.

### 8.1 Cryptographic Assumptions

The security of XLN rests on the following standard cryptographic assumptions:

| Assumption | Primitive | Security Level | Usage |
|------------|-----------|---------------|-------|
| ECDLP hardness over secp256k1 | ECDSA signatures | 128-bit | Frame signing, Hanko quorum, dispute proofs |
| Collision resistance of keccak256 | Hash function | 256-bit | Frame hashes, entity state commitment, ABI encoding |
| Preimage resistance of SHA-256 | Hash function | 256-bit | HTLC hashlocks |
| Memory-hardness of Argon2id | Key derivation | Configurable (256 MB) | BrainVault master key derivation |
| PRF security of HMAC-SHA256 | Key derivation | 256-bit | Named signer derivation from master seed |

We assume all hash functions behave as random oracles in security arguments. Signature unforgeability follows from the ECDLP assumption under the random oracle model.

### 8.2 Theorem 1: E-Layer Safety (No Conflicting Commits)

**Theorem.** Let E be an entity with consensus configuration (V, s, T) where V is the validator set, s: V -> Z+ assigns voting shares, and T is the quorum threshold satisfying T > floor(totalShares / 2). If at most f validators are Byzantine where sum of Byzantine shares < totalShares - T + 1, then no two correct replicas commit conflicting entity frames at the same height h.

**Proof sketch.**

1. **Quorum intersection.** A quorum is any subset Q of V with sum_{v in Q} s(v) >= T. Since T > totalShares / 2, any two quorums Q_1 and Q_2 satisfy: sum(Q_1) + sum(Q_2) >= 2T > totalShares. Therefore Q_1 and Q_2 must share at least one honest validator (their share-weighted intersection is non-empty among honest validators).

2. **Hash binding.** Each honest validator v_i, upon receiving a proposal P at height h, independently applies P.txs to its local state S_{h-1} with verifyOnly=true, producing validatorComputedState. It computes H(f) = keccak256(deterministicJSON(validatorComputedState)) and signs only if H(f) = P.hash. (See entity-consensus.ts, lines 453-480.)

3. **Contradiction.** Suppose two conflicting frames F and F' are both committed at height h, with H(F) != H(F'). Then there exist quorums Q_F and Q_{F'} that signed H(F) and H(F') respectively. By (1), there exists an honest validator v* in Q_F intersect Q_{F'}. By (2), v* signed H(F) only after verifying it against its local computation, and similarly for H(F'). Since v* starts from the same committed state S_{h-1} and applies the same pure function, it cannot produce two different hashes for height h. Moreover, v* locks to the first proposal it signs and rejects subsequent proposals at the same height. Contradiction. QED.

**Remark.** For the standard BFT threshold T = floor(2 * totalShares / 3) + 1, this tolerates up to f < totalShares / 3 Byzantine share-weight, matching classical PBFT safety bounds.

### 8.3 Theorem 2: Bilateral Safety (State Identity)

**Theorem.** Consider a bilateral account between entities L (left) and R (right). If at most one party is Byzantine, then after every committed frame at height h, both correct parties hold byte-identical account state.

**Proof sketch.**

1. **Frame proposal.** The proposer P in {L, R} clones state M, executes pending AccountTxs, computes frameData = (height, timestamp, jHeight, prevFrameHash, accountTxs, tokenIds, deltas, fullDeltaStates), and stateHash = keccak256(deterministicJSON(frameData)). P signs stateHash and transmits the frame.

2. **Verification.** The receiver V replays all accountTxs on its own clone of M, independently computes the same deterministicJSON, and derives stateHash'. V signs and ACKs only if stateHash' = stateHash (account-consensus.ts, verification phase). Thus both parties have verified that applying the same transactions to the same prior state produces the same hash.

3. **Commitment.** P receives V's ACK, verifies the signature on stateHash, then re-executes txs on its real state and commits. V commits using its own computed state. Both committed states are derived from the same (prevState, txs) pair via the same pure function. Since the function is deterministic and both inputs are identical, both outputs are identical.

4. **Simultaneous proposals.** When both L and R propose at height h+1, the tiebreaker rule (Section 4.5) applies deterministically (Lemma 1 below). Exactly one proposal survives; the other party rolls back and processes the winning proposal as receiver. The committed state remains identical on both sides.

5. **2-of-2 requirement.** No frame commits without both signatures. A Byzantine party that refuses to sign stalls the account (liveness failure) but cannot cause state divergence (safety holds). The honest party can escalate to the J-layer dispute mechanism. QED.

### 8.4 Lemma 1: Tiebreaker Determinism

**Lemma.** The function isLeft(A, B) = (normalizeEntityId(A) < normalizeEntityId(B)) is computed identically by both parties in a bilateral account.

**Proof.** Both parties know their own entityId and their counterparty's entityId (established at account opening and immutable thereafter). normalizeEntityId produces a canonical 0x-prefixed 64-character lowercase hex string (entity-id-utils.ts, lines 11-27). The lexicographic comparison on this canonical form is a deterministic total order. Since both parties apply the same function to the same pair of immutable inputs, they compute the same boolean. QED.

**Corollary.** When both parties propose at the same height, both independently determine that L's proposal wins. L keeps its proposal; R rolls back and accepts L's frame. No additional communication is needed to resolve the conflict.

### 8.5 Lemma 2: Dual-State Determinism

**Lemma.** Let S_h be the committed entity state at height h. If the proposer and a verifying validator both apply transaction sequence T = [tx_0, ..., tx_{k-1}] to S_h, the proposer with verifyOnly=false and the validator with verifyOnly=true, then both compute the same entity frame hash H(f_{h+1}).

**Proof sketch.**

1. Both paths start from the same committed state S_h (frame chain integrity guarantees this: f.prevFrameHash = H(f_{h-1})).

2. Both apply the same transactions in the same order (txs are embedded in the ProposedEntityFrame and transmitted to validators).

3. The flag verifyOnly only suppresses bilateral account frame proposals in the A-layer. Specifically, when verifyOnly=true, entity-tx processing skips generating new AccountInput proposals that would use env.timestamp to create lockIds. This divergence occurs AFTER the deterministicState snapshot is taken.

4. The entity frame hash H(f) is computed from the deterministicState (the state BEFORE account proposals diverge), not from the full newState. Both the proposer and validator compute deterministicState identically because it depends only on (S_h, T), which are identical on both paths.

5. Therefore H(f_{h+1}) is identical on both paths, provided that transaction application is a pure function of (state, txs, timestamp) — which is guaranteed by the determinism rules (Section 1.7). QED.

### 8.6 Lemma 3: Cascade Prevention

**Invariant.** If entity E_a produces outputs for entity E_b during tick t, those outputs are processed by E_b no earlier than tick t+1.

**Enforcement.** The runtime's `planEntityOutputs()` function routes entity-to-entity outputs into `mempool.entityInputs`, which is drained only at the start of the next tick's processing loop. Outputs are never processed inline within the same tick. This ensures finite tick duration and prevents unbounded recursive cascades between entities.

### 8.7 Conservation Law

**Theorem (Conservation).** Every settlement operation in XLN satisfies: leftDiff + rightDiff + collateralDiff = 0. No value is created or destroyed.

**Proof by case analysis.** We enumerate all delta-modifying operations and verify the invariant holds for each:

| Operation | leftDiff | rightDiff | collateralDiff | Sum | Mechanism |
|-----------|----------|-----------|----------------|-----|-----------|
| direct_payment | 0 | 0 | 0 | 0 | Modifies offdelta only; no reserve/collateral change |
| htlc_lock | 0 | 0 | 0 | 0 | Increases hold only; no offdelta/reserve change |
| htlc_resolve (secret) | 0 | 0 | 0 | 0 | Shifts offdelta, releases hold; no reserve change |
| htlc_resolve (timeout) | 0 | 0 | 0 | 0 | Releases hold; no offdelta/reserve change |
| settle (cooperative) | +a | +b | -(a+b) | 0 | Enforced by createSettlementDiff (types/settlement.ts:24-31) |
| deposit_collateral (R2C) | -a | 0 | +a | 0 | Left's reserve decreases, collateral increases |
| withdraw (C2R) | +a | 0 | -a | 0 | Left's reserve increases, collateral decreases |
| swap_fill | 0 | 0 | 0 | 0 | Cross-token offdelta shifts; conservation per token pair |

**Dual enforcement.** The conservation law is enforced at two independent layers:

1. **Off-chain (construction time).** `createSettlementDiff()` throws if `leftDiff + rightDiff + collateralDiff !== 0n` before any settlement diff enters the protocol (types/settlement.ts, line 25).

2. **On-chain (execution time).** Account.sol line 348: `if (diff.leftDiff + diff.rightDiff + diff.collateralDiff != 0) revert E2();` — the Depository contract independently verifies every settlement diff during on-chain execution.

**Inductive argument.** The initial state has all reserves, collaterals, and deltas at zero. Each subsequent operation preserves the sum (shown above). By induction, the total value in the system equals the sum of external deposits at all times. QED.

### 8.8 HTLC Atomicity

**Claim.** For a multi-hop HTLC payment along route [v_0, v_1, ..., v_n], either all hops settle (secret revealed) or all hops cancel (timeout), assuming honest endpoints.

**Argument sketch.** Three mechanisms ensure atomicity:

1. **Hashlock binding.** All hops share the same hashlock H(secret). Revealing the secret on any hop makes it available for all other hops (the secret propagates backward from receiver to sender).

2. **Timelock ordering.** Timelocks decrease along the route: hopTimelock_i = baseTimelock - (n - i - 1) * MIN_TIMELOCK_DELTA_MS. This ensures each intermediate node has strictly more time to claim from its upstream hop than its downstream hop has to claim from it.

3. **Hold isolation.** HTLC holds (leftHtlcHold, rightHtlcHold) reserve capacity at lock time, preventing over-commitment across concurrent HTLCs. Each lock's capacity is isolated regardless of other pending locks.

The combination guarantees that if the receiver reveals the secret, each intermediate node can propagate it upstream before its own timelock expires. If the receiver does not reveal, all locks expire and holds are released without offdelta changes.

### 8.9 Capacity Safety

**Invariant.** No payment or HTLC lock exceeds the sender's outCapacity, including all outstanding holds.

**Definition.** outCapacity = max(0, outPeerCredit + outCollateral + outOwnCredit - outAllowance - outHold), where outHold = leftHtlcHold + leftSwapHold + leftSettleHold (from L's perspective; symmetric for R).

**Enforcement.** Every payment and HTLC lock operation checks `amount <= deriveDelta(delta, isLeft).outCapacity` before modifying state. Holds are atomically increased when locks are created and decreased when resolved, ensuring no double-commitment of capacity.

---

## Appendix A: Constants

| Parameter | Value |
|-----------|-------|
| Tick delay (default) | 25 ms |
| Tick delay (scenario) | 100 ms deterministic |
| Mempool limit (account) | 1,000 txs |
| Mempool limit (entity) | 1,000 txs |
| Max validators | 100 |
| Max frame size | 1 MB |
| Dispute delay | 20 blocks |
| HTLC min timelock delta | 10,000 ms per hop |
| HTLC min forward timelock | 20,000 ms |
| HTLC max hops | 20 (protocol), 10 (financial) |
| HTLC default expiry | 30,000 ms |
| Fee rate | 100 ubp (1 basis point) |
| Fee denominator | 10,000,000 |
| Max payment amount | 2^128 - 1 |
| BrainVault Argon2id memory | 256 MB |
| ERC-1155 token supply | 10^15 per entity |
| J-batch max ops | 50 |
| J-batch broadcast timeout | 5 seconds |
