# C2 adversary audit — validity of the hot≡cold property proof

Angle: attack VALIDITY. Not "did the tests pass" but "is hot≡cold actually
proven for the class that matters, by this harness, on a reproducible tree".

## Environment of this audit

| Parameter | Value |
|---|---|
| `git rev-parse HEAD` | `b95e7ee3b6345a296535aeb6a5d375efc1a27c88` |
| `git status --porcelain \| wc -l` | `422` (C2's own report ran at `dfd45cc7` + 313 dirty) |
| C2 artifacts tracked? | **No.** `?? core/__tests__/proofs/`, `?? proofs/ts/` — untracked working-tree files |
| bun | `1.3.14` |
| Harness re-run on this tree | **FAILS TO LOAD** (see A1) — `XLN_C2_RUNS=40 bun test core/__tests__/proofs/hot-vs-cold.test.ts` → `SyntaxError: Export named 'rebaseCertifiedEntityLineageAtRuntimeCheckpoint' not found in module core/storage/replica/entity-lineage.ts` (parallel-task mid-edit, `M core/storage/replica/entity-lineage.ts`) |

## Findings

### A1 — Evidence is unreproducible; report and pin describe different programs (High)

- `proofs/ts/report.md:15-17` records SHA `dfd45cc7` + 313 dirty files. That tree
  state is unrecoverable: C2's own files are untracked, and the production files
  they depended on have since been modified again (422 dirty now).
- The report's F1 section (`proofs/ts/report.md:154-166`) says the FINDING PIN
  "pins the current behavior: throw" and that "up to the halt the committed
  roots … remain hot==cold". The pin in the tree
  (`core/__tests__/proofs/hot-vs-cold.test.ts:484-510`) asserts the **opposite**:
  `await expect(harness.step({kind:'propose',…})).resolves.toBeUndefined()`,
  mempool empties, `pendingTxTypes == ['direct_payment']` — i.e. it pins the
  **D4 fix** (uncommitted edit to `core/account/j-claims/j-claim-transition.ts`:
  `assertExactMember` throw → `exactMemberConflict` typed message, lines 84-116).
  There is no halt anywhere in the current pin, so the report's "hot==cold up to
  the halt" evidence no longer exists in any file.
- On the current tree the harness does not even import (missing export in a
  dirty production file), so "C2 ✅ ready" cannot be re-verified bit-for-bit
  against any committed SHA. Under `proofs/readme.md` rule 2 this is an
  evidence-discipline breach: the report is pinned to a tree that no longer
  exists and its central finding-pin no longer matches its own description.

### A2 — 11 of 12 account Patricia memo surfaces are checked on EMPTY maps only (High)

`checkAll` compares `rootHash()` vs `coldRootHash()` for 9 state + 3 envelope
namespaces (`hot-vs-cold.test.ts:72-75, 416-426`). Quantified against the
generator and genesis (`core/__tests__/helpers/cross-j.ts:115-140`):

| Namespace | State in every run |
|---|---|
| `deltas` | **non-empty** (rows 1..8; only `.updated()` inserts/updates) |
| `locks`, `swapOffers`, `requestedRebalance`, `requestedRebalanceFeeState`, `pendingWithdrawals`, `rebalanceShadowPolicy`, `rebalanceShadowSubmitted` | instantiated empty; checked empty forever (trivially equal) |
| `pulls`, `subcontracts`, `lendingIntents`, `rebalanceFeePolicies` | **never instantiated** — `checkAccountRoots` silently skips them (`if (!isPersistentAccountStateMap(map)) continue;`, `hot-vs-cold.test.ts:418`); only the P1/P3 section level compares `EMPTY vs EMPTY` |

Consequences:
- **No non-empty map is ever `.removed()` from.** The Patricia delete path
  (`deleteRadixNode`, branch collapse/relink and its edgeHash reuse in
  `makeRadixBranch`, `core/protocol/state/persistent-radix-value-ops.ts:110-131`)
  is never exercised on a non-empty tree — a classic stale-node-cache location.
- `j_event_claim` finality touches `deltas` and conditionally
  `requestedRebalance.put/del`
  (`core/account/tx/handlers/j-events/finality.ts:44-64`), but the rebalance
  branch never fires because `requested` is always 0 (no rebalance tx kinds).
- The report discloses empty-only coverage for **P8 (entity collections)** but
  the P4 row reads "for all 9 state maps and 3 envelope ones" without disclosing
  that 11 of 12 never receive a single entry. For an empty map, hot and cold are
  equal by construction — the check has zero discriminating power there.

### A3 — The generator was neutered after F1 and cannot rediscover the bug class (Medium-High)

- `hot-vs-cold.test.ts:345`: `blockByte = 0x11 + (op.jHeight % 5)` — the j-claim
  bytes are a pure function of jHeight, so **any two claims at the same jHeight
  are exact duplicates; a conflict is ungeneratable**. The report admits this
  ("conflicts are excluded from the generator") while simultaneously crediting
  fast-check with finding F1 (seed 42 run 79) — that attribution can only be
  true of a *previous* generator revision that no longer exists. Under readme
  rule 4 (a harness that cannot reproduce a known bug is uncalibrated), the
  fast-check property no longer exercises any conflict machinery; only the
  hand-written pin does.
- Owner decision D4 (`proofs/readme.md:58-63`) mandates four TS↔Rust vectors:
  committed conflict (pin covers this one), **two conflicts in one batch** (absent),
  **exact duplicate after commit / stale admitted claim after incoming frame**
  (absent — enqueue dedup `core/account/input/local-tx-admission.ts:27-47` only
  compares against mempool+pendingFrame, never committed frames), so the
  committed-vs-mempool duplicate window is entirely untested.

### A4 — Entity-frame overlay memo layers bypassed (Medium)

The report claims the Entity commit boundary is reproduced "as
`EntityAccountCandidateMap.getForWrite/sealCandidate` in production". Verified at the
leaf level this holds: harness `PersistentEntityAccountMap.updated()`
(`core/entity/state/persistent-account-map.ts:162-180`) and production
`sealCandidate()→foldDirty(seal=true)` both end in `makeRadixLeaf` with
`ownValue = sealCommittedAccountValue`
(`core/protocol/state/persistent-radix-value-map.ts:495-507`) — same seal+freeze.
But the entire overlay machinery between them is never instantiated by the
harness:
- `EntityAccountCandidateMap` (`persistent-account-map.ts:362-630`):
  `#projection`/`#hashProjection` caches (themselves hot root memos),
  `dropCachedProjection`, re-seal of a frozen shell (`claimed_resealed`,
  `:413-418`), batch multi-account folds;
- engine leaf cache triangle `rememberEngineAccountLeaf`/`peek`/`forget`
  (`core/rscore/cutover/leaf-registry.ts`, consumers `leaf-cache.ts:21`,
  `execute.ts:99`) and `invalidateEntityAccountCommitment`
  (`core/entity/consensus/state-root.ts:706`) — the cache stays empty for the
  whole run, so its staleness-prevention boundary is vacuously untested.

### A5 — Security context diverges from production after the first finalized claim (Medium)

Harness pins `finalizedJHeight: 0` forever (`hot-vs-cold.test.ts:127-129`).
Production resolves `provided ?? context.entityClock?.finalizedJHeight ??
account.state.lastFinalizedJHeight ?? 0`
(`core/account/consensus/index.ts:1185-1189`). A bilaterally finalized claim
sets `account.state.lastFinalizedJHeight = jHeight`
(`core/account/tx/handlers/j-events/claim.ts:67`) — the r3 corpus reaches
finalized status, so every subsequent op in production would carry an advanced
enforcement clock, while the harness keeps 0. The clock feeds per-tx
`{timestamp, jHeight}` enforcement (`index.ts:264-266`) and `enforcementJHeight`
(`index.ts:547`). No memo divergence is observed from this (hot and cold read
the same state), but the claim "drives production boundaries" is weakened for
everything downstream of finality. (The `status:'stale'` prune branch itself IS
reachable — it reads `account.state.lastFinalizedJHeight` directly,
`j-claim-transition.ts:149-156` — via descending jHeights.)

### A6 — Cold oracles share common-mode components with the hot path (Medium)

The cold oracles are cold only at the node-cache/identity-memo level:
- `PersistentAccountStateMap.coldRootHash()` rebuilds via `fromMap` with **the
  same options.valueHash** → the module-global `leafDigests` RecencyMemo
  (`core/account/state/persistent-state-map.ts:109-126, 227-232`) is shared
  between hot and cold. A wrong cached leaf digest is invisible to C2: both
  sides agree on the same wrong bytes.
- `accountStateRootEntries(account, cold)` swaps only `rootHash↔coldRootHash`;
  leaf encoding `encodeAccountStateValue` and the flat-root preimage are shared
  (`core/account/commitment/state-root.ts:177-203`).
- Entity cold path likewise shares the field encoders of
  `projectAccountConsensusState`; only P7 memos (hankoLeafDigest, mempoolRoot,
  input/ACK bindings — `core/entity/consensus/state-root.ts:276-289, 382-392`)
  are genuinely bypassed.

So C2 proves *cache-invalidation correctness of node hashes and identity-keyed
memos*, not *digest-computation correctness*. That is a fine and useful
property, but the report's "every hot root is byte-equal to its
cold oracle" overstates oracle independence; the boundary should be
stated.

### A7 — Statistical accounting errors (Low-Medium)

- "Total: 1,200 sequences" double counts: per seed, the 100-run pass is
  a strict prefix of the 300-run pass (fast-check is deterministic per seed;
  `numRuns` only truncates). Distinct sequences: **900**, not 1,200.
- No coverage accounting: `deliver`/`ack` before any `propose` are silent
  early-returns (`hot-vs-cold.test.ts:360-362, 371-373`), so an unknown and
  unmeasured fraction of the 900 sequences exercises nothing; no per-op-kind
  occurrence assertions, no stateful-command preconditions, no coverage-guided
  shrinking. For a stateful system the honest phrasing is "900 random walks of
  which an unmeasured subset reaches each protocol path", not the implicit
  uniform-coverage reading. The bounded-model wording itself is honest.

### A8 — F1 minimality claim is off by one (Low)

The pin sequence is **7** ops (`admitClaim, propose, deliver, ack, admitClaim,
admit payment, propose` — `hot-vs-cold.test.ts:489-509`), not the "6 operations"
of the report. The `admit payment` op is load-bearing: without a second valid tx
in the mempool, a propose that drops the conflicting claim would return an empty
proposal and the test could not discriminate "typed reject + continue" from
"nothing to propose". 7 is the honest minimal; the report's count and its
throw-era description are both stale.

### A9 — Witness lifecycle not modeled (Low)

Production certifies witnesses with entityHeight binding and prunes them to
reachable state between frames
(`core/entity/consensus/input/hanko-witness.ts:54-81, 101-160`); harness witness
cache is an unbounded per-side Map, never pruned, and `getAckFrameHash`
state-resolution (`hanko-witness.ts:198-207`) is replaced by input-carried
hashes. Certify-once/reuse IS faithfully modeled (attachInPlace mirrors
`attachAccountInputHankos` ordering, including frame_ack ack-before-proposal
hanko order), so this is a scope note, not a soundness break for the checked
property.

## Answers to the five audit questions

1. **Pair enumeration.** grep "Cold" over `core/**` (minus `__tests__`) yields
   the 9 report pairs P1-P9 plus these uncovered surfaces: orderbook cold
   reconstruction (`core/orderbook/order-index.ts:35`), cold page hydration
   (`core/orderbook/pages/page.ts:183`), storage book-graph cold load
   (`core/storage/read/book-graph.ts:74`, `core/storage/schema/book-graph-codec.ts:122`),
   entity-collection candidate map (`core/entity/state/persistent-collection-map.ts:146+`),
   EntityAccountCandidateMap projections, engine leaf registry. Consumers
   (`commit-root.ts:38`, `proposal/start.ts:452`, `replay.ts:53`,
   `account-materializer.ts:641`, `snapshot-wire.ts:298`) are covered insofar as
   the harness drives those code paths — commit-root runs on every delivered
   frame, so the production hot-vs-cold self-audit is exercised. The harness
   covers P1-P9; everything else in the list is out of model, undisclosed in the
   report's pair table.
2. **Fidelity.** Real `applyAccountInput`/`proposeAccountFrame`/`signEntityHashes`/
   `verifyHankoForHash`, real fork+seal at the leaf level (verified
   `forkAccountReplicaShell` → `.updated` → `makeRadixLeaf`+`sealCommittedAccountValue`),
   real frame_ack bundling (`proposal/finalize.ts:60-89` — constructed by
   production code when `lastOutboundFrameAck` matches height-1). Bypassed:
   candidate-map projections and engine-leaf forget boundaries (A4), witness
   pruning (A9), post-finality enforcement clock (A5).
3. **Generator power.** ≤40 ops × ≤5 txs, 4 tx kinds. Unreachable: any
   non-empty `locks`/`pulls`/`swapOffers`/`subcontracts`/`lendingIntents`/
   rebalance/shadow/withdrawal map (A2), `.removed()` on non-empty maps,
   mempool bound (limit 10,000 vs ≤200 txs per run), j-claim conflicts (A3),
   dispute/external_finality/settlement/HTLC/swap input kinds, double rollback
   (single rollback pinned in r2; a second same-height collision is generatable
   but unpinned and unmeasured). Reachable and covered: replay/duplicate ACK,
   same-height collision with LEFT-wins rollback and mempool restoration,
   fork-then-mutate (every op forks from the frozen committed base),
   j-claim idempotent/finalized/stale.
4. **F1 pin.** The current pin asserts the FIXED no-throw behavior with strong
   post-conditions (mempool emptied, pendingFrame carries the surviving payment,
   hot==cold re-checked) — it would catch a regression back to the throw. But it
   no longer pins the throw the report describes, and the "hot==cold up to the
   halt" claim is unbacked by any current artifact (A1, A8).
5. **fast-check depth.** 3 seeds × (100 prefix ⊂ 300) = 900 distinct walks; the
   "1,200" total is wrong (A7); no coverage metrics; single finding found,
   plausibly with a generator revision that was then weakened (A3). As a smoke
   harness: adequate. As statistical evidence for a stateful invariant: it is
   evidence of absence of *reachable-by-random-walk* divergences within the
   model, nothing more — which the report mostly says, minus the arithmetic
   error and the empty-map triviality disclosure.

## 100/100 gap list for C2

1. Non-empty coverage for `locks`, `pulls`, `swapOffers`, `subcontracts`,
   `lendingIntents`, `requestedRebalance*`, `rebalanceFeePolicies`,
   `pendingWithdrawals`, shadow policy/submitted (needs HTLC/swap/rebalance/
   settlement/withdrawal op kinds in the generator).
2. `.removed()` on a non-empty Patricia map (delete-path node/edgeHash caching).
3. Instantiate the four undefined namespaces in genesis so the map-level check
   does not silently skip them.
4. j-claim conflict generation (or at minimum the four D4 vectors as regression
   sequences: two conflicts in one batch, exact duplicate after commit, stale
   admitted claim after incoming frame).
5. `EntityAccountCandidateMap` path: multi-account entity, projection/hash
   projection reuse, `dropCachedProjection`, re-seal of frozen shells.
6. Engine leaf registry remember→mutate→forget triangle.
7. Post-finality security clock (`finalizedJHeight` from state, HTLC
   enforcement windows).
8. Dispute and `external_finality` input kinds; settlement workspace hash
   (`settlementWorkspaceHash` is `null` in every C2 run).
9. Double rollback / repeated collision pin.
10. Multi-leaf `deltas` beyond 8 uniform rows; token keys near radix path
    boundaries (very small/large tokenIds).
11. Correct sequence accounting (900, not 1,200) and per-run op-kind coverage
    report.
12. Reproducibility: commit the artifacts, pin a clean SHA, re-run.

## Grade: 55/100

Justification: the harness is real-integration (production transitions, real
signing, real fork/seal, per-op check density ~229,999 expects) and the report
is more honest than most about model bounds (+15). But validity for "the class
that matters" fails on the money-critical maps beyond `deltas` — 11 of 12
Patricia memo surfaces trivially empty, no non-empty delete path (−15, A2);
the generator was weakened past its own finding and cannot rediscover the bug
class it found (−10, A3); the Entity-frame memo layer the claim nominally covers
is bypassed (−5, A4); the cold oracle is common-mode at the leaf-digest level,
so the proven property is narrower than worded (−5, A6); and the evidence is
unreproducible on any existing tree, with report and pin contradicting each
other on the central finding (−10, A1). What is actually proven: for the
balance/credit/j-claim slice with non-empty `deltas` only, over 900 random
walks and 4 pinned corpora on a now-unrecoverable tree, node-cache and
identity-memo invalidation held hot==cold at every step.
