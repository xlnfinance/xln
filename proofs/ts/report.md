# C2: hot (memoized) roots ≡ cold recomputation after arbitrary operation sequences

> **Post-fix note (2026-08-27, C2-repro audit):** the F1 pin below is described
> as "pins the throw" — after FX-3 landed (decision D4) the behavior changed:
> a conflicting j_event_claim gets a typed reject / row drop without halting
> the account; the pin test was renamed to
> "conflicting j_event_claim is removed without halting" and asserts the
> resolution, not the throw. The historical wording below describes the state
> at SHA dfd45cc7. The remaining FX-3 tail at audit time: the enqueue-level
> typed reject (`local-tx-admission.ts`) — finding B in
> `proofs/audits/c2-repro/report.md`.

Claim (matrix `proofs/readme.md`, C2): after any (within the model below)
sequence of bilateral Account-consensus operations, every hot
(cached/memoized) root is byte-equal to its cold oracle on both replicas.
Wording without "impossible": the assertion is covered by a finite number of
fast-check runs and the regression corpus; outside the model (other tx
families, multi-signer boards, multiple jurisdictions) — not verified.

## Evidence (environment at run time)

| Parameter | Value |
|---|---|
| `git rev-parse HEAD` | `dfd45cc7c20f188e3f9c032b7549d3baab52b1de` (the readme pin `80924b0…` was stale: a parallel C1 task had committed to `main` during the run) |
| `git status --porcelain \| wc -l` | `313` (uncommitted changes of parallel tasks; the tree moved during the run — see "Observations") |
| This task's changes | only 3 new files: `core/__tests__/proofs/hot-vs-cold.test.ts`, `core/__tests__/proofs/hot-vs-cold.regression.ts`, `proofs/ts/report.md`; plus the devDependency `fast-check` in `package.json`/`bun.lock`. No production code changed |
| bun | `1.3.14` (JavaScriptCore) |
| fast-check | `4.9.0` (devDependency; v4 API: weighted `fc.oneof({weight, arbitrary}, …)`) |

## Harness: real consensus functions, no mocks

`core/__tests__/proofs/hot-vs-cold.test.ts` builds a deterministic two-replica
Account:

- two lazy Entities (`generateLazyEntityId([signer], 1n)` — self-authenticating
  board, exactly like production: `hanko/claims.ts:178` admits the
  `entityId === boardHash` case without a registry), real secp256k1 keys
  (`deriveSignerKeySync`/`registerSignerKey`), RFC 6979 deterministic
  signatures;
- transitions execute production functions: `applyAccountInput`
  (`core/account/consensus/index.ts:1208`), `proposeAccountFrame`
  (`core/account/consensus/proposal/propose.ts:160`), real
  `verifyHankoForHash` through `createAccountConsensusContext` (no test
  verifiers);
- the Entity-frame boundary is reproduced with the production pair:
  `forkAccountReplicaShell` (shell for writing) → operations →
  `PersistentEntityAccountMap.updated` (seal+freeze) — same as
  `EntityAccountCandidateMap.getForWrite/sealCandidate` in production;
- the witness-signature boundary is reproduced per
  `core/entity/consensus/input/hanko-witness.ts`: the `hashesToSign` manifest
  is signed once (`signEntityHashes`) at certification and then only reused
  (including the bundled ACK in `frame_ack` and the `lastOutboundFrameAck`
  cache for the re-ACK path);
- the J-claim node boundary is reproduced per
  `cacheCommittedAccountJClaimNodeChanges` (session overlay → durable store
  on result commit).

## Operation model (bounded)

- ≤ 40 operations per run; weighted choice:
  `admit` 22% / `propose` 30% / `deliver` 20% / `ack` 16% / `jclaim` 12%.
- `admit`: 1–5 txs from {`direct_payment`, `set_credit_limit`, `add_delta`},
  tokenId 1–8, payment amount 0–5000 (0 — expected typed rejection, min 1),
  credit limit 0–1,000,000.
- `jclaim`: the canonical observation flow — exactly one deterministic
  `AccountSettled` event per jHeight 1–5 (duplicates/repeats are legal;
  conflicts are excluded from the generator and pinned by a separate
  finding-pin).
- `deliver`/`ack` — reused deliveries (at-least-once): repeated deliveries
  exercise the replay/stale/duplicate-ACK paths; a same-height collision of
  both sides, the LEFT-wins tiebreak, RIGHT rollback with mempool
  restoration and the subsequent re-propose arise from the sequence
  (see r2 of the corpus).
- Clocks are deterministic: `env.state.timestamp += 1000` per operation;
  no `Date.now`/`Math.random` in the harness.

## Asserted properties (after EVERY operation, both replicas)

1. `computeAccountStateRoot(state) === computeAccountStateRootCold(state)`
   (+ re-reading the hot root and the `peekAccountStateRoot` memo, when
   present, against the cold one).
2. `computeAccountStateSectionHashes === computeAccountStateSectionHashesCold`
   (all 5 sections).
3. `computeAccountCommitmentSectionDetail === …Cold` (5 map roots +
   settlementWorkspaceHash).
4. Every state collection (`deltas`, `locks`, `pulls`, `swapOffers`,
   `subcontracts`, `lendingIntents`, `requestedRebalance`,
   `requestedRebalanceFeeState`, `rebalanceFeePolicies`) and envelope maps
   (`pendingWithdrawals`, shadow-policy, shadow-submitted):
   `rootHash() === coldRootHash()`.
5. `computeCanonicalEntityConsensusStateHash(state) ===
   computeCanonicalEntityConsensusStateHashCold(state)` — transitively covers
   the hot Account leaf (`computeEntityAccountValueHash` vs the private
   `computeEntityAccountValueHashCold` via rebuild of the `accounts` section),
   the `hankoLeafDigest` memo, `mempoolRoot`, the
   `compactAccountInputBindingMemo`/`outboundAckBinding` bindings, and
   `entityCollectionCommitment` and the `transferAccountStateRootMemo` at
   every shell fork.
6. Free replica invariants (fints.md): cold root ==
   `currentFrame.accountStateRoot`; `currentFrame.height ==
   currentHeight`; `pendingFrame ⇒ height == currentHeight+1`;
   `mempool ≤ ACCOUNT_MEMPOOL_SIZE`; at rest (no pending on either side,
   heights equal) — the frames' `stateHash` and the replicas' cold roots match
   (bilateral agreement).

## Exact run commands and results

```bash
bun add -d fast-check                    # fast-check@4.9.0, devDependency
bun test core/__tests__/proofs/hot-vs-cold.test.ts          # default: 100 runs × 3 seeds
XLN_C2_RUNS=300 bun test core/__tests__/proofs/hot-vs-cold.test.ts   # deep run
```

Run 1 (default, 100 runs/seed, seeds 42 / 20260826 / 31337):

```
(pass) regression corpus … [505ms]
(pass) FINDING PIN … [97ms]
(pass) fast-check seed 42 … [8363ms]
(pass) fast-check seed 20260826 … [8499ms]
(pass) fast-check seed 31337 … [8368ms]
5 pass, 0 fail, 77 917 expect() calls, 26.55s
```

Run 2 (deep, 300 runs/seed, same seeds):

```
5 pass, 0 fail, 229 999 expect() calls, 79.10s
```

Total: **900 random sequences** (≤40 operations each) +
4 regression corpora + finding-pin: **0 hot-vs-cold divergences**.
Every sequence is checked after every operation — roughly 22,000+ root
boundary checks in run 2.

`bun run check`: fails on two pre-existing ratchet gates
(`ESLINT_DEBT_CHANGED 342→347`, `NON_NULL_ASSERTION_DEBT_CHANGED
183/682→180/671`) — baseline drift across the whole tree with 313 dirty files
of parallel tasks; both new harness files are ESLint-clean
(`bunx eslint core/__tests__/proofs/*.ts` — 0 remarks); production code was
not touched by this task.

## Covered hot/cold pairs (file:line at SHA `dfd45cc7c`)

| # | Hot path | Cold oracle |
|---|---|---|
| P1 | `core/account/commitment/state-root.ts:424` `computeAccountStateRoot` (memo `accountStateRootMemos`, sameCollections/sameScalarIdentities validation) | `:500` `computeAccountStateRootCold` |
| P2 | `:237` `computeAccountStateSectionHashes` | `:247` `computeAccountStateSectionHashesCold` |
| P3 | `:289` `computeAccountCommitmentSectionDetail` | `:294` `computeAccountCommitmentSectionDetailCold` |
| P4 | `core/account/state/persistent-state-map.ts:222` `rootHash()` (leaf-digest memo `leafDigests` + Patricia node cache) | `:227` `coldRootHash()` — for all 9 state maps and 3 envelope ones |
| P5 | `core/entity/consensus/state-root.ts:770` `computeCanonicalEntityConsensusStateHash` | `:871` `computeCanonicalEntityConsensusStateHashCold` (sections `:891` `computeEntityConsensusSectionDigestsCold` — by the same equality) |
| P6 | `:674` `computeEntityAccountValueHash` (hot leaf) | `:695` `computeEntityAccountValueHashCold` (private; via rebuild of the accounts section in P5) |
| P7 | internal leaf memos: `:278` `hankoLeafDigest`, `:383` `mempoolRoot`, `:414` `compactAccountInputBindingMemo`, `:425` `outboundAckBinding` | cold flags of the same functions (bypassing the memos) |
| P8 | `core/entity/state/persistent-collection-map.ts:98` `rootHash` / `:273` (candidate) | `:101` `coldRootHash` / `:275` — via `entityCollectionCommitment(m, cold)` in P5 |
| P9 | `core/account/commitment/state-root.ts:396` `transferAccountStateRootMemo` (memo transfer through a value-preserving fork) — invoked by the real `forkAccountReplicaShell` on every operation | checked implicitly: transfer + subsequent hot(P1) vs cold |

P8 limitation: entity collections (`htlcRoutes`, `lockBook`, `crontabState`,
cross-j) are always empty in the harness — their hot/cold equality is checked
only on empty maps (trivially equal). Non-empty values require the Entity-tx
machines and stay outside the model.

## Findings (found, not fixed — per the readme rules)

**F1 (the only substantive one).** The sequence
`[admit jclaim(jHeight=H, block A)] → propose → deliver → ack →
[admit jclaim(jHeight=H, block B≠A)] → propose` makes `proposeAccountFrame`
THROW `ACCOUNT_J_CLAIM_LEFT/RIGHT_CONFLICT`
(`core/account/j-claims/j-claim-transition.ts:86-88`, `assertExactMember`)
instead of a typed `ACCOUNT_TX_VALIDATION` rejection. Found by fast-check
(seed 42, run 79; seed 31337, run 43), manually minimized to 6 operations,
pinned by the `FINDING PIN` test in `hot-vs-cold.test.ts` (pins the then-current
behavior: throw; it was verified that up to the halt the committed roots of
both replicas stay hot==cold). Reachability assessment: local enqueue admits
the conflicting claim without validation; whether a hostile PEER frame with
such a tx can halt the receiver on replay was left to the owner (the replay
path does not catch the throw). This is not a hot-vs-cold divergence; an
availability candidate.

**Observations (not findings).** During the run the tree was being actively
edited by a parallel task: transiently observed were (a)
`cloneIsolatedAccountFrame` without `stateHash`/`byLeft`/`deltas` (the
`AccountFrame` type in `core/types/account.ts` no longer contains
`byLeft`/`deltas` — the "remove duplicate frame hashing" migration), and (b)
the deletion of `core/entity/consumption/*` with dangling imports. Both states
were transient; the final runs above are on a settled tree.

## Calibration

The owner's known-bug list B1–B8 was not received; the corpus is calibrated on
our own finding F1 (minimal case in the finding-pin). Once B1–B8 arrive, each
must become a mandatory case of this harness (readme rule 4).

---

# Hardening 2026-08-26 (c2-adversary closure wave, gaps A1–A8)

The audit `proofs/audits/c2-adversary/report.md` (55/100) raised 12 items;
below is what was closed in `core/__tests__/proofs/hot-vs-cold.test.ts` +
`hot-vs-cold.regression.ts`, what remains, and what was newly found.
No production code changed (READ-ONLY for this wave).

## Run evidence

| Parameter | Value |
|---|---|
| `git rev-parse HEAD` at the main run | `d483605e25151709ab09a7e216486b3748887c22` (parallel tasks committed to `main` during the work; control re-run at `3cbf807da97c1e5587640727b9cd30724b1e7b1a`, same 7 pass / 0 fail / 113,872 expects) |
| `git status --porcelain \| wc -l` | 15 at the main run; 72 at the control (including 4 dirty production files `core/entity/consensus/*` of a parallel task — none of them is in the harness import graph) |
| bun / fast-check | 1.3.14 / 4.9.0 |
| Commands | `bun test core/__tests__/proofs/hot-vs-cold.test.ts` (default 100 runs × 3 seeds) → **7 pass, 0 fail, 113,872 expect() calls, 27–30s**; `XLN_C2_RUNS=300` → **7 pass, 0 fail, 325,793 expect() calls, 79.4s** |
| `bun run check` | fails on one pre-existing ratchet gate `NON_NULL_ASSERTION_DEBT_CHANGED expected=179/649 actual=177/645` — whole-tree baseline drift from parallel WIP; stash-controlled: with and without my files the counter is identical (177/645), the wave's files contribute zero; ESLint of both files — 0 remarks |

The 7 tests comprise: regression corpus (9 corpora + coverage floors),
finding-pin F1, D4 vectors, the C2-H2 pin, 3 fast-check seeds. Honest sequence
accounting (A7): fast-check is deterministic per seed, so a 100-run pass is a
strict prefix of the 300-run pass; **there are 900 distinct sequences, not
"1,200"** (the figure in the historical section above was the audit's A7
error, corrected here).

## Closed gaps

- **A2 (audit items 1–3) — non-empty maps + the delete path.** The harness
  genesis instantiates all 4 optional namespaces (`pulls`, `subcontracts`,
  `lendingIntents`, `rebalanceFeePolicies`) with empty persistent maps;
  `checkAccountRoots` no longer silently skips a map — a non-persistent
  collection is a `HARNESS_COLLECTION_NOT_PERSISTENT` fail-fast. The op
  generator was extended with 8 tx kinds: `htlc_lock` (both delivery modes +
  without a mode), `htlc_resolve` (secret — payer, error — beneficiary),
  `swap_offer`, `swap_cancel` (= `swap_resolve` fillRatio 0 + cancelRemainder
  from the other side), `cross_pull_lock` (route+binding built by the
  production builders
  `withCanonicalCrossJurisdictionRouteHash`/`buildCrossJurisdictionPullBinding`),
  `rebalance_policy`, `request_collateral`, `rebalance_refund`. REMOVE paths on
  non-empty trees: `locks.del` (resolve secret+error), `swapOffers.del`
  (cancel), `requestedRebalance/.requestedRebalanceFeeState/.shadowSubmitted.del`
  (full refund + j-finality cleanup as the event's collateral increases).
  Coverage is measured per run (`nonEmpty`/`shrank`/`opCounts`) and pinned by
  deterministic floors in the corpus test: `deltas, locks, pulls, swapOffers,
  requestedRebalance, requestedRebalanceFeeState, rebalanceFeePolicies` are
  non-empty; `locks, swapOffers, requestedRebalance, requestedRebalanceFeeState`
  have shrunk. At 300 runs all 3 seeds yield the same 7 non-empty collections.
  The DELETE path (`deleteRadixNode` + branch collapse) now runs on every r5–r7
  corpus and in random runs.
- **A3 (item 4) — conflicts are generatable again.** The `jclaim` op carries a
  generated `blockByte` (0..255): duplicates and conflicts at the same jHeight
  are both reachable; the conflict goes through the FX-3 typed-admission
  reject (the harness checks hot==cold after every such step). All four D4
  vectors are pinned by a dedicated test in THIS harness (committed conflict —
  the existing F1-pin; two conflicts in one batch → rejection indexes [0,2];
  exact duplicate after commit → idempotent skip without a rejection row;
  stale admitted claim after an incoming frame → proposal-window drop
  `disposition: 'removed'`), with checkAll after every step. The L1-level
  vectors remain in
  `core/__tests__/account/j-claims/j-claim-admission-vectors.test.ts`.
- **A4 (items 5–6) — the entity overlay and leaf registry.**
  `exerciseEntityOverlay` runs 3 times per sequence (after genesis, midway, at
  the end, both sides): leaf-registry remember→peek (digest equality) and
  fold-with-remembered-leaf == fold-with-recomputed-leaf;
  `EntityAccountCandidateMap` hash projection (double read — cache reuse,
  root == committed), multi-account fold (2 dirty leaves) seal==rebuild,
  re-seal of a frozen leaf (`set(committed)`→`getForWrite` → fork, not the
  frozen original), real enqueue on the fork shell +
  `dropCachedProjection` + re-seal (root changed, == rebuild),
  `invalidateEntityAccountCommitment` on a committed and a candidate map.
  The write boundary (`getForWrite`) forgets the engine leaf (peek →
  undefined).
- **A5 (item 7) — the post-finality enforcement clock.** `security(side)` now
  takes `finalizedJHeight` from `account.state.lastFinalizedJHeight ?? 0` —
  the same resolution chain as production (`provided ?? entityClock ?? state
  ?? 0`). The r3 corpus was extended: bilateral finalize at jHeight 3 → a
  descending claim (stale-prune) → ordinary work under the advanced clock →
  finalize jHeight 4; r7 ends with a j-event finalize that cleans up the
  collateral request (the `requestedRebalance` del branch).
- **A6 — the oracle boundary.** Wording of the property (no code change): the
  cold oracles share the leaf-digest encoders with the hot path, so what is
  proven is the "correctness of node-cache and identity-keyed memo
  invalidation", not "correctness of digest computation".
- **A7/A8 (item 11) — accounting.** 900 distinct sequences (not 1,200);
  per-op-kind counters and the nonEmpty/shrank sets are printed for every
  seed; deliver/ack before propose remain deterministic no-ops (the fraction
  of no-op steps is not asserted). The F1-pin is **7 operations** (admitClaim,
  propose, deliver, ack, admitClaim(conflict), admit payment, propose); the
  payment is load-bearing — the comment is in the pin and here.
- **A1 (item 12) — reproducibility.** The wave's artifacts are committed
  atomically (only `core/__tests__/proofs/**` + `proofs/ts/**`); the
  SHA/dirty-state are recorded above. Harness loading on the current tree is
  confirmed by the control run.

## New findings of the wave (production READ-ONLY — for the owner)

- **C2-H1 (availability, environment-dependent halt at the Entity commit
  boundary).** `add_delta` admits tokenId up to 65535, the runtime registry
  knows only 1..5 (`getKnownTokenIds`). If an account acquires a delta row on
  an unregistered tokenId with positive withdrawable collateral (e.g. via
  `j_event_claim`/AccountSettled — `assertSettlementTokenId` admits ≤65535, or
  R→C), then `classifyAccountWork → hasRebalanceWork →
  getDefaultRebalancePolicyForToken → getTokenInfo` throws
  `TOKEN_METADATA_UNAVAILABLE` inside
  `PersistentEntityAccountMap.updated()/fromEntries` — i.e. any Entity-map
  write halts. The harness restricted the fundable genesis and the generator
  to registered ids 1..5 (r4 keeps a zero-collateral row on 7 — the harmless
  case is pinned).
- **C2-H2 (availability, the F1/FX-3 family).** Local enqueue admits two
  `cross_pull_lock`s with the same `pullId` but different bytes
  (fingerprint-dedup catches only exact duplicates); at proposal the second
  one triggers `CROSS_J_PULL_LOCK_PROPOSAL_FAILED` (halt_runtime) instead of a
  per-row typed rejection. Found by the extended generator (seed 20260826,
  100-run pass). In production, pulls are built by the deterministic Entity
  command planner, but the current board can submit an AccountTx directly
  (the F1 authority class). Pinned as the current behavior (hot==cold up to
  the halt); the random model maintains the planner invariant "one live pull
  per order leg".
- **A latent genesis bug of the harness was fixed** (not production): rows
  2..N were copied with the value `tokenId: 1` inside the delta → drafts for
  token N were committed into row 1 (observed as an "evaporating" HTLC-hold).
  Now the value carries its own tokenId.

## Residual gaps (honest)

- `lendingIntents` is never populated: `lending_*` is outside the RRS profile
  (FX-2/D3, loud admission reject in both engines); `subcontracts`,
  `pendingWithdrawals`, shadow-policy/submitted have no in-profile writer in
  the Account machine (Entity-lifecycle machines are outside the model).
  Their map-level hot==cold is checked on empty; non-emptiness is outside the
  model.
- `pulls` has no delete path: `cross_pull_close` requires the hash-ladder
  reveal machinery — outside this wave's model.
- Dispute/`external_finality`/settle_transition input kinds and
  `settlementWorkspaceHash != null` (audit item 8), double rollback (item 9),
  multi-leaf `deltas` beyond the 5 registered tokens + boundary tokenIds
  (item 10) — not covered.
- The witness lifecycle (A9: witness pruning, state-resolution ACK hashes)
  remains outside the model; certify-once/reuse is reproduced faithfully.
