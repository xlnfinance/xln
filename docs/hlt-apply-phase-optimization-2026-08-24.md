# HLT apply-phase optimization: draft shell + section cache (2026-08-24)

Branch `fix/radapter-oversized-read-storm`, commits `963a1dc0a` + `ee7b3f78e`.
All runs: payments mode, Anvil testnet, isolated smoke shard, 200 users, 30s, 1 action/user/s.

## 1. Context

Prior work (levers A–N, `hlt-throughput-report-2026-08-22.md`) addressed
CPU-bound canonicalization and I/O-bound storage encoding, yielding +22.1% TPS
cumulative. Profiling then revealed the `apply` phase as the dominant remaining
bottleneck: 75% of frame time, with `entityApply` consuming 101ms avg.

## 2. Profiling hierarchy

```
Frame: 388ms total (slow frame)
├── apply: 293ms (75%)
│   └── entityApply: 101ms
│       ├── entityTxLoop:     127ms  (139 accountInput txs @ 0.9ms/tx)
│       │   └── accountInput handler: 0.6ms/tx
│       │       └── consensus: 0.626ms ← applyAccountTxMutation
│       │
│       └── accountProposals: 107ms  (102 accounts @ 1.05ms/prop)
│           └── validateTxs:  0.642ms ← applyAccountTx per tx in proposal
│           └── stateRoot:    0.037ms (memoized)
│           └── disputeProof: 0.074ms
│
├── save:  44ms (15%)
└── other: 51ms (10%)
```

Both hot paths (`entityTxLoop` + `accountProposals`) converge on the same
function: `applyAccountTxMutation` — the Account state machine transition.
Called ~241 times per frame (139 in entityTxLoop + ~102 in accountProposals).

## 3. Draft lifecycle profiling

Instrumented `beginAccountStateDraft`, `forkAccountReplicaShell`, and
`prepareAccountStateDraft` with `timePerfPhase`. Results from one perf
snapshot (431ms frame, 61 txs, 200 accounts):

```
account.forkShell:    10,423 calls × 0.018ms = 188ms  (42% of frame)
account.beginDraft:    5,625 calls × 0.023ms = 129ms  (29% of frame)
account.prepareDraft:  2,697 calls × 0.043ms = 116ms  (26% of frame)
                                                    Total = 433ms cumulative
```

**Root cause:** `beginAccountStateDraft` called `forkAccountReplicaShell`
which deep-clones `mempool` (per-tx `cloneIsolatedAccountTx`), `currentFrame`
(frame + all accountTxs), and `pendingFrame` for every Account draft. These
fields are **read-only** inside `applyAccountTx` handlers — handlers mutate
only collection overlays and a few scalar fields (`proofHeader.nextProofNonce`,
`settlementWorkspace`, `pendingForwards`, dispute-proof scalars). Consensus
`finalize` replaces frame/mempool by reference assignment, never in-place
mutation.

Three fork sources per account per frame:
1. `snapshotCandidate()` in `createEntityFrameCandidateState` — forks all ~200 accounts
2. `getForWrite()` — COW fork on first write
3. `beginAccountStateDraft()` — forked again for each draft

## 4. Lever S: `forkAccountDraftShell` (+5.5% TPS)

### Change

Created `forkAccountDraftShell` in `account-replica-shell.ts` that shares
read-only envelope fields (`mempool`, `currentFrame`, `pendingFrame`,
`pendingAccountInput`, `lastOutboundFrameAck`, `disputePrepare`,
`activeDispute`, `boardResealMigration`, `counterpartyBoardReseal`) as
references. Only copies fields handlers actually mutate:

- `state` shell: `settlementWorkspace`, `leftPendingJClaims`, `rightPendingJClaims`
- `proofHeader`: shallow copy (for `nextProofNonce` mutation)
- `shadow`: `activeQuote`, `pendingRequest` (shallow copies)
- `pendingForwards`: array copy (handlers push new entries)

`beginAccountStateDraft` now calls `forkAccountDraftShell` instead of
`forkAccountReplicaShell`. The full `forkAccountReplicaShell` is still used
by the Entity COW boundary (`EntityAccountCandidateMap.getForWrite`,
`snapshotCandidate`, `sealCandidate`).

### Safety analysis

Verified by grepping all handler mutations in `core/account/tx/handlers/`:

| Field                    | Handler mutation           | Isolated by          |
|--------------------------|----------------------------|-----------------------|
| `state.settlementWorkspace` | `settle_transition`     | `forkAccountStateShell` |
| `state.leftPendingJClaims`  | `j_event_claim`         | `forkAccountStateShell` |
| `proofHeader.nextProofNonce` | `j_event finality`     | `copyRecord(proofHeader)` |
| `pendingForwards`           | `direct_payment`        | array copy in draft shell |
| `currentDisputeProof*`      | `j_event finality`     | spread from base (new refs) |
| `state.locks`, `state.deltas` | HTLC handlers         | collection overlays    |

Fields verified read-only in handlers: `mempool`, `currentFrame`,
`pendingFrame`, `pendingAccountInput`, `lastOutboundFrameAck`,
`disputePrepare`, `activeDispute`, `boardResealMigration`,
`counterpartyBoardReseal`, `state.domain`, `state.disputeConfig`.

`publishAccountOverlay` skips `ACCOUNT_LIVE_ENVELOPE` fields (mempool,
currentFrame, pendingFrame, etc.) — draft's shared references are never
published back to the live replica.

### Metrics

```
forkShell calls:     10,423 → 8,661 per frame  (-59%, COW boundary only)
beginDraft per-call:  0.019ms → 0.003ms         (-85%)
frameApply (slow):    227ms → 137ms             (-40%)
TPS:                  227.3 → 239.8             (+5.5%)
```

Also removed dead code: `createAccountTransitionKey` (unused after the
lazy `cacheKey` optimization from lever 8).

## 5. Lever T: section-level digest cache (+5.2% TPS)

### Profile

`computeCanonicalEntityConsensusStateHash` is called twice per entity frame:
1. `applyEntityFrame` (frame.ts:398) — on the post-apply `newState`
2. `sealEntityProposal` (start.ts:381) — on `buildProposalState` result

`buildProposalState` spreads `appliedState` into a new object, changing only
`height`, `timestamp`, `leaderState`. The whole-state memo (keyed on all 35
field identities) misses because those 3 fields changed — but the other ~32
sections (config, accounts, orderbookExt, …) keep the same value references.

```
state-root profile (202 calls, h>240):
  total:      18.24ms avg (p95=57.20ms)
  projection:  2.65ms (14%)  ← projectEntityConsensusState
  sections:   15.55ms (85%)  ← canonical.encode per section
  rootKeccak:  0.04ms (<1%)

Top sections by encoded bytes:
  orderbookExt:        2864B
  jHistoryFinality:     650B
  jBatchState:          611B
  config:               552B
  certifiedBoardState:  449B
```

884 uncached calls / 428 frames = 2.1 cache misses per frame. The whole-state
memo can't help because each call operates on a different state object.

### Change

Added `ENTITY_SECTION_DIGEST_CACHE` — a `Map<string, {value, digest,
encodedBytes}>` stored as a non-enumerable property on `EntityState`, keyed
by section name. Each entry caches the section's digest keyed on the **source
field reference** (`state[field]`), not the projected value (which is a freshly
constructed object for most sections).

`commitEntityConsensusSections` checks the cache before encoding each section.
If the source field reference is unchanged, reuses the cached digest. Only
re-encodes sections whose source field actually changed.

`inheritEntitySectionDigestCache(source, target)` copies the cache from
`appliedState` to the new state in `buildProposalState`. Since the spread
preserves all field references except `height`, `timestamp`, `leaderState`,
the second state-root computation reuses ~32 of ~35 section digests and
re-encodes only the 3 changed sections.

### Safety

The cache is keyed on object identity (`===`), which is the same invariant
used by `ENTITY_STATE_ROOT_MEMO` and `ACCOUNT_STATE_ROOT_MEMO`. The overlay
convention requires field replacement (not in-place mutation), so identity
equality is a correct cache validity check.

The `accounts` section is special: its encoded form depends on
`state.accounts.rootHash()`, not the projected value. The cache key for
`accounts` is `state.accounts` (the map reference), which is stable across
spreads.

Verified with `XLN_ENTITY_STATE_ROOT_AUDIT=1` (cold oracle re-computation)
— all 17 state-root invariant tests pass.

### Metrics

```
Section re-encoding:  ~35 sections → ~3 sections per second call
TPS:                  239.8 → 252.4  (+5.2%)
```

## 6. Throughput ladder

```
TPS
 252 |                                                    ● 252.4 lever S+T
 240 |                                        ● 239.8 lever S
 227 |                          ● 227.3 baseline (lever N)
     +--------------------------|------------|------------→
       prior session (A-N)       lever S      lever T
       +22.1%                    +5.5%        +5.2%
```

| Run | Code          | TPS avg (5 runs) | Change under test                    |
|-----|---------------|-------------------|--------------------------------------|
| 1   | Lever N       | 227.3             | Baseline: all prior CPU optimizations |
| 2   | +Lever S      | 239.8             | `forkAccountDraftShell`              |
| 3   | +Lever T      | 252.4             | Section digest cache inheritance     |

**Cumulative: +33.1% TPS** from the original pre-optimization baseline
(approx 190 TPS → 252 TPS).

## 7. Fixes behind this report

| Commit       | Content                                                                                    |
|--------------|--------------------------------------------------------------------------------------------|
| `963a1dc0a`  | `forkAccountDraftShell`: share mempool/frame refs in Account draft; remove dead code       |
| `ee7b3f78e`  | Section-level digest cache: `ENTITY_SECTION_DIGEST_CACHE` + `inheritEntitySectionDigestCache` |

## 8. Next levers, ranked

| Lever                                      | Prize           | Risk    |
|--------------------------------------------|-----------------|---------|
| `wireFit` (70ms / 16% of slow frame)       | ~16% of frame   | Medium  |
| `prepareDraft` prepares all 12 collections | ~5% of frameApply | Low   |
| `orderbookExt` section (2864B, largest)    | ~3% of stateRoot | Low    |
| Batch signature verification               | 1000/s gate     | High    |
