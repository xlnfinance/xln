# xln runtime flow (waterfall)

Complete R→E→A execution trace for future agents.

## hierarchy overview

```
RUNTIME (R)                           ENTITY (E)                        ACCOUNT (A)
─────────────────                     ────────────────                  ──────────────
runtime.ts                            entity-consensus.ts               account-consensus.ts
├─ applyRuntimeInput()                ├─ applyEntityInput()             ├─ proposeAccountFrame()
│  └─ RuntimeTx handling              │  └─ EntityInput handling        │  └─ AccountTx handling
│     createXlnomy                    │     EntityTx → mempool          │     direct_payment
│     importReplica                   │     precommits handling         │     add_delta
│                                     │     frame consensus             │     set_credit_limit
│                                     │                                 │
├─ process()                          ├─ applyEntityTx()                ├─ processAccountTx()
│  └─ Main tick loop                  │  └─ entity-tx/apply.ts          │  └─ account-tx/apply.ts
│                                     │     directPayment               │     Route to handler:
│                                     │     openAccount                 │     handlers/direct-payment.ts
│                                     │     extendCredit                │     handlers/add-delta.ts
│                                     │     ...                         │     handlers/set-credit-limit.ts
```

## R-layer: runtime.ts

### entry point: `process(env, inputs?)`
Main tick loop, called every 100ms or manually.

```typescript
process(env: Env, inputs?: EntityInput[]): Promise<EntityInput[]>
```

1. Validates inputs
2. Calls `applyRuntimeInput(env, { runtimeTxs: [], entityInputs: inputs })`
3. Routes outputs recursively until outbox is empty
4. Returns final outbox

### applyRuntimeInput(env, runtimeInput)
Core R-layer processor. Location: `runtime.ts:262`

**INPUT:** `RuntimeInput { runtimeTxs: RuntimeTx[], entityInputs: EntityInput[] }`

**FLOW:**
```
1. VALIDATE inputs (null checks, array validation, resource limits)
2. PROCESS RuntimeTxs (R-layer operations):
   - createXlnomy → jurisdiction-factory.ts
   - importReplica → add to env.eReplicas
3. MERGE EntityInputs (combine inputs for same entity)
4. FOR EACH merged EntityInput:
   → applyEntityInput(env, replica, input)   [E-LAYER]
   → Collect outputs
5. CAPTURE snapshot (if work was done)
6. RETURN entityOutbox
```

**OUTPUT:** `{ entityOutbox: EntityInput[], mergedInputs: EntityInput[] }`

## E-layer: entity-consensus.ts

### applyEntityInput(env, replica, input)
Core E-layer processor. Location: `entity-consensus.ts:185`

**INPUT:** `EntityReplica, EntityInput`

**FLOW:**
```
1. CLONE replica (immutability)
2. VALIDATE input and replica state
3. EXECUTE crontab (periodic tasks)
4. ADD txs to mempool
5. IF non-proposer with mempool:
   → Forward txs to proposer (output)
6. HANDLE precommits (commit notifications):
   → Validate signatures
   → Apply committed frame
   → Clear mempool
7. HANDLE proposed frame (PROPOSE phase):
   → Lock to frame
   → Send precommit to validators (output)
8. IF proposer with quorum:
   → Create frame with applyEntityFrame()
   → Broadcast frame to validators (output)
9. RETURN { newState, outputs }
```

### applyEntityTx(env, entityState, entityTx)
EntityTx dispatcher. Location: `entity-tx/apply.ts:18`

**Supported EntityTx types:**
| Type | Handler | Description |
|------|---------|-------------|
| `chat` | inline | Add message to entity |
| `chatMessage` | inline | Add chat message |
| `propose` | inline | Validator proposal |
| `vote` | inline | Validator vote |
| `profile-update` | inline | Update gossip profile |
| `j_event` | inline | Jurisdiction event |
| `accountInput` | `handlers/account.ts` | Bilateral account frame |
| `openAccount` | inline | Create bilateral account |
| `directPayment` | inline → A-layer | Off-chain payment |
| `deposit_collateral` | `handlers/deposit-collateral.ts` | R2C prefunding |
| `reserve_to_reserve` | `handlers/reserve-to-reserve.ts` | R2R transfer |
| `j_broadcast` | `handlers/j-broadcast.ts` | J-machine broadcast |
| `extendCredit` | inline | Extend credit to peer |
| `requestWithdrawal` | `handlers/request-withdrawal.ts` | C2R request |
| `settleDiffs` | inline | Settlement processing |

## A-layer: account-consensus.ts + account-tx/

### processAccountTx(accountMachine, accountTx, isOurFrame)
AccountTx dispatcher. Location: `account-tx/apply.ts:22`

**Supported AccountTx types:**
| Type | Handler File | Description |
|------|--------------|-------------|
| `add_delta` | `handlers/add-delta.ts` | Set initial delta values |
| `set_credit_limit` | `handlers/set-credit-limit.ts` | Set credit limits |
| `direct_payment` | `handlers/direct-payment.ts` | Process payment |
| `reserve_to_collateral` | `handlers/reserve-to-collateral.ts` | R2C operation |
| `request_withdrawal` | `handlers/request-withdrawal.ts` | C2R request |
| `approve_withdrawal` | `handlers/approve-withdrawal.ts` | C2R approval |
| `request_rebalance` | `handlers/request-rebalance.ts` | Channel rebalance |

### Key AccountTx handlers

#### direct-payment.ts (most important)
Processes off-chain payments with collateral/credit checking.

**CRITICAL LOGIC:**
```typescript
// Determine canonical direction
const senderIsLeft = paymentFromEntity === leftEntity;

// Derive capacity from sender's perspective
const senderDerived = deriveDelta(delta, senderIsLeft);
const senderHasCollateral = senderDerived.collateral > 0n;

// PUSH model (collateral) vs PULL model (credit)
if (senderHasCollateral) {
  canonicalDelta = senderIsLeft ? amount : -amount;
} else {
  canonicalDelta = senderIsLeft ? -amount : amount;
}

// Validate limits based on model
if (senderHasCollateral) {
  // Check collateral limits
} else {
  // Check credit limits from delta.leftCreditLimit/rightCreditLimit
}
```

#### set-credit-limit.ts
Sets per-token credit limits in delta.

```typescript
// side is canonical ('left' or 'right')
if (side === 'left') {
  delta.leftCreditLimit = amount;  // LEFT extends to RIGHT
} else {
  delta.rightCreditLimit = amount; // RIGHT extends to LEFT
}
```

## data types

### Core Types (types.ts)

```typescript
// R-layer
interface Env {
  height: number;
  timestamp: number;
  eReplicas: Map<string, EntityReplica>;  // key: "entityId:signerId"
  jReplicas: Map<string, JReplica>;
  runtimeInput: RuntimeInput;
  history: EnvSnapshot[];
}

// E-layer
interface EntityReplica {
  entityId: string;
  signerId: string;
  state: EntityState;
  mempool: EntityTx[];
  proposal?: EntityFrame;
  isProposer: boolean;
}

interface EntityState {
  entityId: string;
  height: number;
  accounts: Map<string, AccountMachine>;
  reserves: Map<string, bigint>;
  config: ConsensusConfig;
}

// A-layer
interface AccountMachine {
  counterpartyEntityId: string;
  proofHeader: ProofHeader;
  deltas: Map<number, Delta>;  // tokenId → Delta
  mempool: AccountTx[];
  currentFrame: AccountFrame;
  globalCreditLimits: { ownLimit: bigint; peerLimit: bigint };
}

interface Delta {
  tokenId: number;
  collateral: bigint;
  ondelta: bigint;
  offdelta: bigint;
  leftCreditLimit: bigint;   // Credit LEFT extends to RIGHT
  rightCreditLimit: bigint;  // Credit RIGHT extends to LEFT
  leftAllowance: bigint;
  rightAllowance: bigint;
}
```

## delta semantics

```
Delta Sign Meaning:
  totalDelta = ondelta + offdelta

  totalDelta > 0  →  RIGHT owes LEFT
  totalDelta < 0  →  LEFT owes RIGHT
  totalDelta = 0  →  Balanced

Canonical Side:
  LEFT  = entityId < counterpartyEntityId (lexicographic)
  RIGHT = entityId > counterpartyEntityId

Payment Direction:
  LEFT sends  → canonicalDelta = +amount (PUSH) or -amount (PULL)
  RIGHT sends → canonicalDelta = -amount (PUSH) or +amount (PULL)

Credit Limits:
  leftCreditLimit  = Credit LEFT extends TO RIGHT (RIGHT can owe LEFT)
  rightCreditLimit = Credit RIGHT extends TO LEFT (LEFT can owe RIGHT)
```

## derived capacity (account-utils.ts)

`deriveDelta(delta, isLeft)` computes:
- `inCapacity`: How much I can RECEIVE
- `outCapacity`: How much I can SEND
- `inCollateral`: My collateral available to send
- `outCollateral`: Peer's collateral I'm holding

Key formula:
```typescript
outCapacity = inCollateral + outOwnCredit + inPeerCredit - outAllowence
```

## consensus flow

### E-layer BFT (CometBFT-style)
```
1. Proposer collects txs in mempool
2. Proposer creates EntityFrame with applyEntityFrame()
3. Proposer broadcasts frame to validators
4. Validators lock to frame, send precommits
5. When quorum reached, commit frame
6. Clear committed txs from mempool
```

### A-layer Bilateral
```
1. Entity proposes AccountFrame
2. Counterparty validates:
   - Frame chain (prevFrameHash matches)
   - State computation (both sides compute same result)
   - Signatures
3. Counterparty signs and returns
4. Both commit frame to history
```

## debugging tips

1. Enable state dumps:
```typescript
dumpSystemState(env, 'LABEL', true);
```

2. Key log patterns to grep:
```bash
grep -E "(E-MACHINE|A-MACHINE|CONSENSUS|COMMIT)"
```

3. Verify bilateral consistency:
   - Both sides should have identical delta values
   - Both sides should have identical frame hashes

4. Common bugs:
   - Wrong credit limit source (globalCreditLimits vs delta.leftCreditLimit)
   - Wrong isLeft calculation
   - PUSH/PULL model confusion
