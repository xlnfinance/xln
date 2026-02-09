# R-Layer: Runtime Orchestration Model

## 1. Global State

The top-level state of an XLN node is a single value of type **Env**:

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

where `ReplicaKey = EntityId : SignerId` (colon-separated). The two replica maps partition the system into an **entity layer** (off-chain BFT consensus) and a **jurisdiction layer** (on-chain EVM settlement). Every other field is orchestration metadata.

### 1.1 EntityReplica

Each entry in `eReplicas` is one signer's view of one entity:

```
EntityReplica = {
  entityId           : EntityId,
  signerId           : SignerId,
  state              : EntityState,
  mempool            : EntityTx[],
  proposal?          : ProposedEntityFrame,
  lockedFrame?       : ProposedEntityFrame,
  validatorComputed? : EntityState,
  isProposer         : Bool,
  hankoWitness?      : Map<String, HankoRecord>
}
```

`EntityState` contains the full entity: reserves, accounts (each an `AccountMachine` with bilateral deltas, locks, swap offers), nonces, governance proposals, HTLC routing tables, J-block observation chain, and crontab state.

### 1.2 JReplica

Each entry in `jReplicas` is one EVM jurisdiction (chain):

```
JReplica = {
  name         : String,
  blockNumber  : N,
  stateRoot    : Bytes32,
  mempool      : JTx[],
  blockDelayMs : N,
  jadapter?    : JAdapter,
  reserves?    : Map<EntityId, Map<TokenId, N>>,
  collaterals? : Map<AccountKey, Map<TokenId, {collateral, ondelta}>>
}
```

## 2. The State Transition Function

The runtime is a discrete-time system with a pure core. Each tick applies:

```
process : Env -> RoutedEntityInput[] -> Env
```

Formally, let E_t denote the environment at tick t. A single tick produces:

```
E_{t+1} = commit(apply(drain(E_t, I_t)))
```

where:

1. **drain** collects all pending work: `I_t = mempool.entityInputs ++ pendingOutputs ++ networkInbox`
2. **apply** = `applyRuntimeInput(E_t, I_t)` processes RuntimeTxs then EntityInputs, producing `(entityOutbox, jOutbox)`
3. **commit** increments height, captures snapshot, persists to LevelDB, dispatches side effects

### 2.1 Tick Scheduling

The runtime loop is a single async chain (no re-entry by construction):

```
while running:
    if hasWork(E):
        E <- process(E)
    await sleep(tickDelayMs)        # default 25ms
```

`hasWork` returns true when any of these are non-empty: mempool.runtimeTxs, mempool.entityInputs, pendingOutputs, networkInbox, pendingNetworkOutputs.

A minimum frame delay (`minFrameDelayMs`) gates how fast ticks can fire. In scenario mode, time advances deterministically by +100ms per tick.

### 2.2 Cascade Prevention (Single-Tick Invariant)

**Rule: E-to-E communication always requires a new tick.**

When entity E_a produces outputs destined for entity E_b during tick t, those outputs are *not* applied in tick t. Instead:

1. `planEntityOutputs` classifies outputs into local, remote, and deferred
2. Local outputs are enqueued into `mempool.entityInputs` for tick t+1
3. Remote outputs are dispatched via P2P (fire-and-forget side effect)
4. Deferred outputs (missing gossip runtimeId) are stored in `pendingNetworkOutputs` for retry

This prevents unbounded recursive cascades and guarantees that each tick's state transition is finite.

## 3. Input Routing

### 3.1 RuntimeInput Structure

```
RuntimeInput = {
  runtimeTxs   : RuntimeTx[],       # R-layer ops (importReplica, importJ)
  entityInputs : RoutedEntityInput[],  # E-layer consensus messages
  jInputs?     : JInput[]           # J-layer batch submissions
}
```

### 3.2 RoutedEntityInput Normalization (R-to-E Boundary)

`RoutedEntityInput` extends `EntityInput` with routing hints:

```
EntityInput = {
  entityId        : EntityId,
  entityTxs?      : EntityTx[],
  proposedFrame?  : ProposedEntityFrame,
  hashPrecommits? : Map<SignerId, String[]>
}

RoutedEntityInput = EntityInput & {
  signerId?  : String,   # routing hint
  runtimeId? : String    # routing hint
}
```

At the R-to-E boundary (runtime.ts line 1209), the runtime strips routing hints:

```
normalizedInput = {
  entityId:        input.entityId,
  entityTxs:       input.entityTxs       if present,
  proposedFrame:   input.proposedFrame   if present,
  hashPrecommits:  input.hashPrecommits  if present
}
```

The `signerId` is resolved separately for replica lookup but never passed into the deterministic consensus function `applyEntityInput`. This ensures REA consensus logic sees only deterministic fields.

### 3.3 Input Merge

Before processing, inputs sharing the same `(entityId, signerId)` key are merged:

- `entityTxs` arrays are concatenated (with j_event deduplication)
- `proposedFrame` takes the latest (or the one with precommits on conflict)
- `hashPrecommits` maps are merged by signerId

### 3.4 Processing Pipeline

Within `applyRuntimeInput`, a single tick processes:

1. **J-inputs** collected into `jOutbox` (not applied to JReplica mempool within tick)
2. **RuntimeTxs** processed sequentially:
   - `importJ` creates a new JReplica with JAdapter
   - `importReplica` creates a new EntityReplica with initial ConsensusConfig
3. **EntityInputs** processed sequentially per merged input:
   - Resolve signerId (default to first validator if missing)
   - Look up EntityReplica by `entityId:signerId`
   - Normalize RoutedEntityInput to EntityInput (strip routing)
   - Call `applyEntityInput(env, replica, normalizedInput)` (E-layer)
   - Update replica in eReplicas map with returned state
   - Collect outputs into entityOutbox and jOutbox
4. **Outputs** validated (`validateEntityOutput`) before routing

## 4. Type Hierarchy

```
Env
 +-- Map<ReplicaKey, EntityReplica>
 |    +-- EntityState
 |    |    +-- Map<AccountKey, AccountMachine>      # bilateral channels
 |    |    |    +-- Map<TokenId, Delta>              # per-token state
 |    |    |    +-- Map<LockId, HtlcLock>            # conditional payments
 |    |    |    +-- Map<String, SwapOffer>            # limit orders
 |    |    |    +-- ProposalState?                    # pending bilateral frame
 |    |    |    +-- SettlementWorkspace?              # on-chain settlement negotiation
 |    |    +-- Map<String, bigint>                   # reserves (tokenId -> amount)
 |    |    +-- Map<String, HtlcRoute>                # HTLC routing table
 |    |    +-- ConsensusConfig                       # validators, threshold, shares
 |    |    +-- JBlockObservation[] / JBlockFinalized[]  # J-block consensus
 |    +-- ProposedEntityFrame?                       # pending BFT proposal
 |    +-- EntityTx[]                                 # entity mempool
 +-- Map<String, JReplica>
 |    +-- JTx[]                                      # jurisdiction mempool
 |    +-- JAdapter?                                  # EVM interface
 +-- EnvSnapshot[]                                   # time-travel history
```

### 4.1 Delta (Leaf State)

The terminal state unit is the per-token `Delta` within a bilateral account:

```
Delta = {
  tokenId          : TokenId,
  collateral       : Z,      # on-chain collateral (J-layer authoritative)
  ondelta          : Z,      # on-chain delta (left's share of collateral)
  offdelta         : Z,      # off-chain delta (bilateral consensus)
  leftCreditLimit  : Z,      # credit extended by left
  rightCreditLimit : Z,      # credit extended by right
  leftAllowance    : Z,      # spending allowance for left
  rightAllowance   : Z,      # spending allowance for right
  leftHtlcHold?    : Z,      # capacity locked in outgoing HTLCs
  rightHtlcHold?   : Z,
  leftSwapHold?    : Z,      # capacity locked in swap offers
  rightSwapHold?   : Z,
  leftSettleHold?  : Z,      # ring-fenced for settlement
  rightSettleHold? : Z
}
```

Conservation law for settlements: `leftDiff + rightDiff + collateralDiff = 0`.

## 5. Branded Types and Identity System

XLN uses TypeScript branded types for compile-time safety on identifiers that are structurally strings but semantically distinct:

| Type | Format | Brand Symbol |
|------|--------|-------------|
| `EntityId` | `0x` + 64 hex chars (32 bytes) | `EntityIdBrand` |
| `SignerId` | non-empty string (wallet address or name) | `SignerIdBrand` |
| `JId` | chain ID string or lazy hash | `JIdBrand` |
| `EntityProviderAddress` | `0x` + 40 hex chars (20 bytes) | `EntityProviderAddressBrand` |
| `TokenId` | non-negative integer | `TokenIdBrand` |
| `LockId` | non-empty string | `LockIdBrand` |
| `AccountKey` | `leftEntityId:rightEntityId` (sorted) | `AccountKeyBrand` |

Each type has a validator (`isValidX`) and a throwing constructor (`toX`). The principle is **validate at source, trust at use**: constructors enforce invariants at the system boundary; downstream code operates on branded types without re-checking.

Entity types are bimodal:
- **Numbered** (entityId < 1,000,000): on-chain registered, displayed as `#42`
- **Lazy** (keccak256 hash): governance-structure-derived, displayed as `a1b2c3d4...`

The `AccountKey` constructor enforces canonical ordering: `toAccountKey(a, b)` always produces `min(a,b):max(a,b)`, ensuring both parties reference the same bilateral state.

## 6. Determinism Rules

Within the RJEA cascade, the following are prohibited:

| Prohibited | Replacement |
|-----------|-------------|
| `Date.now()` | `env.timestamp` (controlled clock) |
| `Math.random()` | Seeded PRNG |
| `setTimeout` / `setInterval` | Tick-based delays via timestamp checks |
| `crypto.randomBytes()` | Seeded generator |

**Pure function contract**: Given identical `(E_t, I_t)`, `process` must produce identical `E_{t+1}`. The runtime enforces this by:

1. Scenario mode advances `env.timestamp` by exactly +100ms per tick
2. `getWallClockMs()` uses `performance.timeOrigin + performance.now()` (not `Date.now()`)
3. All entity/account consensus functions receive `env` (never read wall clock)
4. BrowserVM timestamp is synchronized: `browserVM.setBlockTimestamp(env.timestamp)`

The only non-deterministic operations are side effects executed *after* the commit point: P2P dispatch, LevelDB persistence, JAdapter batch broadcast, and gossip announcements. These are explicitly sequenced after `saveEnvToDB(env)` and failures do not affect consensus state.

## 7. Formal Summary

Let S be the set of all valid Env states, I the set of valid RuntimeInputs, and O the set of (RoutedEntityInput[], JInput[]) output pairs.

The R-layer defines:

```
tau : S x I -> S x O
```

such that for all s in S, i in I:

```
tau(s, i) = (s', (e_out, j_out))
```

where:
- s'.height = s.height + 1
- s'.timestamp = s.timestamp + dt  (dt = 100ms in scenario mode)
- s'.eReplicas reflects all EntityInput applications
- e_out contains only outputs for entities *not* processed in this tick (cascade prevention)
- j_out contains JInputs for post-commit JAdapter execution

The cascade prevention invariant: if entity e_a produces output for entity e_b in tick t, then e_b processes that output no earlier than tick t+1. This is enforced by `planEntityOutputs` routing local outputs to `mempool.entityInputs` rather than processing them inline.
