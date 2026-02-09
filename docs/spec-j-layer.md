# J-Layer: On-Chain Settlement and Jurisdiction Protocol

## 1. Overview

The Jurisdiction layer (J-layer) is xln's on-chain settlement substrate. It provides cryptoeconomic finality for off-chain bilateral state by anchoring reserves, collateral, and dispute resolution in EVM smart contracts. The J-layer enforces invariants that off-chain consensus cannot guarantee: reserve solvency, dispute timeout enforcement, and atomic multi-operation batches with flashloan support.

The J-layer comprises four contracts and a runtime adapter:

| Component | Role | LOC |
|---|---|---|
| `Depository.sol` | Reserve custody, batch execution, dispute finalization, debt/insurance | ~1,210 |
| `EntityProvider.sol` | Entity registry, Hanko signature verification, governance (BCD model) | ~1,180 |
| `Account.sol` | Library for bilateral settlement diffs, dispute starts, cooperative proofs | ~440 |
| `DeltaTransformer.sol` | Programmable delta transforms (HTLCs, atomic swaps) | ~190 |
| `JAdapter` (runtime) | Unified TypeScript interface: browservm / anvil / rpc modes | ~800 |

## 2. On-Chain Data Structures

### 2.1 Reserve State

```solidity
// Entity reserves: entityId -> tokenId -> balance
mapping(bytes32 => mapping(uint => uint)) public _reserves;
```

Reserves are the on-chain solvency anchor. Every entity's reserve balance is the source of truth for what can be withdrawn to external tokens. The canonical event `ReserveUpdated(bytes32 entity, uint tokenId, uint newBalance)` is the single event the J-watcher uses for reserve synchronization.

### 2.2 Bilateral Account State

```solidity
struct AccountInfo {
    uint cooperativeNonce;      // Monotonic counter for replay protection
    bytes32 disputeHash;        // Non-zero when dispute is active
    uint256 disputeTimeout;     // Block number when dispute can be finalized
}

struct AccountCollateral {
    uint collateral;            // Total locked collateral for this token
    int ondelta;                // On-chain component of left entity's allocation
}
```

Account keys are computed as `abi.encodePacked(min(e1,e2), max(e1,e2))`, enforcing canonical ordering (left < right). The `ondelta` tracks on-chain funding events; the off-chain `offdelta` (from `ProofBody`) captures bilateral consensus. Total delta = `ondelta + offdelta`.

### 2.3 Settlement Diff (Conservation Law)

```solidity
struct SettlementDiff {
    uint tokenId;
    int leftDiff;        // Change for left entity reserves
    int rightDiff;        // Change for right entity reserves
    int collateralDiff;   // Change in locked collateral
    int ondeltaDiff;      // Change in ondelta
}
// INVARIANT: leftDiff + rightDiff + collateralDiff == 0
```

The conservation law `leftDiff + rightDiff + collateralDiff = 0` is enforced on-chain (line 348 of Account.sol). Value cannot be created or destroyed during settlement -- it only moves between reserves and collateral.

### 2.4 Dispute Proof Structures

```solidity
struct InitialDisputeProof {
    bytes32 counterentity;
    uint cooperativeNonce;
    uint disputeNonce;
    bytes32 proofbodyHash;
    bytes sig;                  // Counterparty Hanko signature (required)
    bytes initialArguments;
}

struct FinalDisputeProof {
    bytes32 counterentity;
    uint initialCooperativeNonce;
    uint finalCooperativeNonce;
    uint initialDisputeNonce;
    uint finalDisputeNonce;
    bytes32 initialProofbodyHash;
    ProofBody finalProofbody;   // Contains offdeltas + transformer clauses
    bytes finalArguments;
    bytes initialArguments;
    bytes sig;
    bool startedByLeft;
    uint disputeUntilBlock;
    bool cooperative;           // If true, skip timeout (mutual finalization)
}
```

## 3. Settlement Flows

### 3.1 Cooperative Settlement

The normal path. Both entities agree off-chain, then one submits to the Depository:

1. Off-chain: Entities reach bilateral consensus on `SettlementDiff[]`
2. Counterparty signs `keccak256(abi.encode(CooperativeUpdate, depository, ch_key, nonce, diffs, forgiveDebts, insuranceRegs))` via Hanko
3. Initiator calls `Depository.settle()` or includes in `processBatch()`
4. Contract verifies Hanko signature via `EntityProvider.verifyHankoSignature()`
5. Diffs applied atomically; `cooperativeNonce` incremented; `AccountSettled` emitted

Signature binding includes the depository address and chain ID for cross-chain replay protection.

### 3.2 Dispute (Unilateral Close)

When cooperative settlement fails:

**Phase 1 -- Dispute Start:**
1. Disputer submits `InitialDisputeProof` with counterparty's previously-signed state
2. Contract verifies the counterparty Hanko on the `DisputeProof` message type
3. `disputeHash` stored; `disputeTimeout = block.number + disputeDelay`
4. Default delay: 20 blocks (~5 min at 15s blocks); configurable per entity

**Phase 2 -- Response Window:**
- Counterparty can submit a counter-dispute with a *newer* `disputeNonce` (signed by both)
- The counter-dispute replaces the initial proof if `finalDisputeNonce > initialDisputeNonce`

**Phase 3 -- Finalization:**
- After timeout: initiator calls `disputeFinalize()` with the proof body
- Contract verifies `disputeHash` matches, timeout has passed
- `_finalizeAccount()` computes total delta = `ondelta + offdelta`, applies DeltaTransformers, distributes collateral

**Cooperative Finalization:** If both parties agree to close during an active dispute, they can call with `cooperative = true` and a fresh cooperative signature, bypassing the timeout. Requires `cooperativeNonce > 0` (prevents social engineering on virgin accounts).

### 3.3 Delta Application on Finalization

```
totalDelta = collaterals[ch_key][tokenId].ondelta + proofbody.offdeltas[i]
```

Delta interpretation (left entity's perspective):
- `delta <= 0`: Right gets all collateral; left owes `|delta|` (becomes debt if insolvent)
- `0 < delta < collateral`: Split: left gets `delta`, right gets `collateral - delta`
- `delta >= collateral`: Left gets all collateral; right owes `delta - collateral`

Shortfall resolution cascade: reserves -> insurance lines (FIFO) -> debt creation.

## 4. Batch Execution

The `Batch` struct enables atomic multi-operation execution in a single transaction:

```solidity
struct Batch {
    Flashloan[] flashloans;              // Temporary reserve inflation (must be returned)
    ReserveToReserve[] reserveToReserve; // Entity-to-entity transfers
    ReserveToCollateral[] reserveToCollateral;
    CollateralToReserve[] collateralToReserve;  // C2R shortcut
    Settlement[] settlements;
    InitialDisputeProof[] disputeStarts;
    FinalDisputeProof[] disputeFinalizations;
    ExternalTokenToReserve[] externalTokenToReserve;  // ERC20/721/1155 deposits
    ReserveToExternalToken[] reserveToExternalToken;   // Withdrawals
    SecretReveal[] revealSecrets;        // HTLC unlocks
    uint hub_id;
}
```

**Execution order** (intentional -- increases before decreases):
1. Flashloans granted (temporary reserve inflation)
2. External token deposits (increases reserves)
3. Reserve-to-reserve transfers
4. Collateral-to-reserve withdrawals
5. Settlements (bilateral diffs with Hanko verification)
6. Dispute starts
7. Secret reveals (must precede dispute finalizations for HTLC resolution)
8. Dispute finalizations
9. Reserve-to-collateral funding
10. External token withdrawals
11. Flashloan invariant check (reserves >= pre-flashloan + flashloan amount, then burn)

**Authorization:** Batches require entity Hanko authorization via `processBatch()`. The batch hash is `keccak256(solidityPacked(DOMAIN_SEPARATOR, chainId, depository, encodedBatch, nonce))` with sequential nonces per entity.

## 5. EntityProvider and Hanko Signatures

### 5.1 Entity Model

Entities exist in two forms:

- **Registered:** On-chain via `registerNumberedEntity()`. Sequential numbering (Foundation = #1). Board hash stored in `entities[entityId].currentBoardHash`.
- **Lazy (ephemeral):** No registration required. `entityId == boardHash`. Verified purely cryptographically.

### 5.2 Hanko Verification

```solidity
struct HankoBytes {
    bytes32[] placeholders;        // Board members who did NOT sign
    bytes packedSignatures;        // EOA signatures: N*64 bytes (RS) + ceil(N/8) bytes (V bits)
    HankoClaim[] claims;           // Hierarchical entity proofs
}

struct HankoClaim {
    bytes32 entityId;
    uint256[] entityIndexes;       // Maps into: placeholders | signers | claims
    uint256[] weights;
    uint256 threshold;
}
```

**Index zones for `entityIndexes`:**
- `[0, placeholderCount)` -- Placeholder (board member absent, 0 voting power)
- `[placeholderCount, placeholderCount + signerCount)` -- EOA signer (verified, full weight)
- `[placeholderCount + signerCount, ...)` -- Entity claim (optimistic "assume YES")

**Security invariant:** EOA voting power alone must meet the threshold. Entity claims add governance flexibility but cannot be the primary control mechanism. This prevents circular-reference attacks where `EntityA -> EntityB -> EntityA` with zero real signers would otherwise pass.

**Packed signature format:** `N * 64` bytes of concatenated R||S values, followed by `ceil(N/8)` bytes of V-bit flags (bit-packed, 0 = v27, 1 = v28). Signature count is derived from byte length, eliminating count/data mismatch vectors.

### 5.3 Governance (BCD Model)

Three proposer tiers with time-locked board transitions:

| Tier | Priority | Delay | Can Cancel |
|---|---|---|---|
| Control (C) | Highest | `controlDelay` blocks | Board, Dividend |
| Board (B) | Medium | 0 (immediate) | Dividend |
| Dividend (D) | Lowest | `dividendDelay` blocks | None |

Each entity has ERC-1155 control and dividend tokens (fixed supply: 10^15 each). Token IDs: `controlTokenId = entityNumber`, `dividendTokenId = entityNumber | (1 << 255)`.

## 6. DeltaTransformer: Programmable Channel Logic

```solidity
interface IDeltaTransformer {
    function applyBatch(
        int[] memory deltas,
        bytes calldata encodedBatch,
        bytes calldata leftArguments,
        bytes calldata rightArguments
    ) external returns (int[] memory newDeltas);
}
```

Two transform types implemented:

- **Payment (HTLC):** Conditional delta shift based on hashlock preimage reveal. Secret can be provided via calldata arguments or on-chain `hashToBlock` registry. Reveals must occur before `revealedUntilBlock`.
- **Swap (Atomic Exchange):** Cross-token-pair exchange with `fillRatio` (0 to `uint16.max`). Counterparty (not owner) chooses fill ratio, enabling limit-order semantics within bilateral channels.

Allowance bounds (`leftAllowance`, `rightAllowance`) constrain how much each transformer clause can shift deltas, preventing unbounded manipulation.

## 7. JAdapter: Runtime-to-Chain Interface

The JAdapter provides a unified TypeScript interface across three execution modes:

| Mode | Provider | Use Case |
|---|---|---|
| `browservm` | `@ethereumjs/vm` in-memory | Demos, scenarios, browser-only |
| `anvil` | Foundry Anvil (JSON-RPC) | Local development, E2E tests |
| `rpc` | Any JSON-RPC endpoint | Testnets, production (Base L2) |

Key interface methods:
```typescript
interface JAdapter {
    processBatch(encodedBatch: string, hankoData: string, nonce: bigint): Promise<JBatchReceipt>;
    settle(left: string, right: string, diffs: SettlementDiff[], ...): Promise<JTxReceipt>;
    registerNumberedEntity(boardHash: string): Promise<{ entityNumber: number }>;
    debugFundReserves(entityId: string, tokenId: number, amount: bigint): Promise<JEvent[]>;
    submitTx(jTx: JTx, options: { env, signerId, timestamp }): Promise<JSubmitResult>;
    startWatching(env: any): void;  // J-event forwarding to runtime mempool
}
```

**J-Batch aggregation** (runtime/j-batch.ts): Operations accumulate in per-entity `JBatchState` objects. Broadcast triggers: batch full (50 ops max) or 5-second timeout. After broadcast, `pendingBroadcast` flag blocks new operations until `HankoBatchProcessed` event confirms on-chain execution. Pure C2R settlements are automatically compressed into the `CollateralToReserve` shortcut to save calldata.

## 8. Canonical J-Events

The J-watcher processes exactly two event types for state synchronization:

| Event | Source | Purpose |
|---|---|---|
| `ReserveUpdated(entity, tokenId, newBalance)` | Depository | Absolute reserve balance after any change |
| `AccountSettled(Settled[])` | Account (via DELEGATECALL) | Full bilateral state: reserves, collateral, ondelta |

Design principle: one event = one state change. No redundant events. The `ReserveUpdated` event carries absolute balances (not deltas), making idempotent replay safe.

## 9. Cryptoeconomic Guarantees

**Enforced on-chain (J-layer):**
- Reserve solvency: withdrawals revert if reserves insufficient
- Conservation law: `leftDiff + rightDiff + collateralDiff = 0` checked per settlement
- Dispute timeout: unilateral finalization blocked until `block.number >= disputeTimeout`
- Nonce ordering: batch nonces and cooperative nonces are strictly sequential
- Flashloan invariant: reserves must return to pre-flashloan level after batch
- Debt priority: FIFO enforcement with bounded iteration (100/1000 per call)
- Insurance cascade: shortfall -> reserves -> insurance lines -> debt creation

**Enforced off-chain (E/A layers, verified on dispute):**
- Bilateral consensus: both entities must sign every frame
- HTLC timeouts: enforced via DeltaTransformer during dispute finalization
- Credit limits: enforced by off-chain consensus; on-chain only sees final delta
- Frame ordering: `disputeNonce` monotonicity ensures latest state wins disputes

**Trust boundary:** The Depository never trusts off-chain state claims. During dispute finalization, it recomputes deltas from the `ProofBody` (offdeltas + transformer execution), applies them to on-chain `ondelta`, and distributes collateral. The off-chain layers provide liveness; the on-chain layer provides safety.
