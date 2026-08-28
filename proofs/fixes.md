# proofs/fixes.md — landing specs for decisions D2/D3/D4

Status: the specs are ready to execute. DO NOT land while the parallel RRS
tasks keep the target files dirty (as of 2026-08-27: 411 dirty files,
`core/account/consensus/index.ts`, `collision.ts`, `frame/hash.ts`,
`rscore/.../engine/src/consensus/frame/hash.rs` — in WIP).
Before applying: check `git status` for the target files and `git log` —
parallel WIP may already cover some items.

## FX-1 — policyVersion: one admission range (D2)

Semantics: `RebalancePolicy.policyVersion` is admissible only in
`0..=9_007_199_254_740_991` (`Number.MAX_SAFE_INTEGER`). Anything outside the
range is a loud typed reject at admission, before the mempool, in both
engines. Rationale: a TS `number` above 2^53 loses precision silently — TS
currently hashes the distorted value; Rust refuses `UnsafeInteger` — the
engines diverge.

Touch points:
- TS admission: the enqueue branch in `core/account/consensus/index.ts`
  (`applyAccountInput`), before the mempool write; typed rejection following
  the existing pattern (see the neighboring rejects).
- TS hash layer (safety net): `core/account/consensus/frame/hash.ts`
  `canonicalAccountTxForFrameHash` — if an out-of-range value reaches the
  hash, that is an admission bug: throw, do not hash.
- Rust admission: `rscore/crates/engine/src/consensus/frame/hash.rs` — extend
  the `is_frame_hashable`-style admission check in
  `AccountConsensus::admit_txs` (`engine/src/consensus/replica.rs`):
  `policy_version > MAX_SAFE` → an `UnsupportedFrameTx`-class typed error
  with an exact code (a new error code, do not reuse another).
- One constant per engine; document the value in `docs/fints.md` as the
  protocol range.

Vectors: policyVersion = 0 / MAX / MAX+1 / 2^54 / u64::MAX — TS↔Rust verdict
parity (admit reject of identical shape).

## FX-2 — lending_* out of profile: loud reject in both directions (D3)

Semantics: `lending_fund | lending_borrow_request | lending_repay |
lending_credit | lending_close_request | lending_close_payout |
reserve_to_collateral` — admission rejects loudly and typed; incoming peer
frames carrying such txs — a loud typed reject. No TS-fallback execution.
RRS profile: pay/HTLC/same-J swap/j-event/rebalance.

Touch points:
- Rust: admission already rejects (`is_frame_hashable` + `unsupported_kind`,
  `engine/src/consensus/frame/hash.rs`); incoming frames — `canonical_tx_value`
  Err → rejected. Check: the error code distinguishes "unmodelled kind"
  explicitly (a readable kind name), not generic.
- TS: currently admits and hashes passthrough — add an admission filter of
  the same kind list to the `applyAccountInput` enqueue branch; typed reject;
  the incoming direction — reject in preflight before replay.

Vectors: each of the 7 kinds → the same verdict type in both engines (local
admit and incoming frame).

## FX-3 — F1: one shared j-claim validator, no bare Errors (D4)

Semantics (one validator used by both admission and proposal):
1. exact duplicate (same jHeight + same jBlockHash + same eventsHash) —
   idempotent: admission silently skips it (no duplicate in the mempool),
   proposal does not create a second row.
2. conflict with the committed accumulator (same height, different
   blockHash/eventsHash) — admission: typed reject; proposal: drop ONLY the
   conflicting row with a typed disposition (the analogue of Rust's
   `DroppedTx { disposition: Removed }`), the account continues.
3. conflict with an earlier claim in the mempool — admission: typed reject.
4. state changed after admission (e.g. an incoming frame committed a claim) —
   proposal removes only the conflicting row, continuing the window. A bare
   `Error`/throw is forbidden.

Touch points:
- TS: `core/account/j-claims/j-claim-transition.ts` — `assertExactMember`
  (lines 79-122): replace the throw with a returned typed result; the
  admission/proposal call sites; enqueue validation in
  `core/account/consensus/index.ts`.
- Rust: `engine/src/consensus/proposal/propose.rs` `prepare_transaction` →
  `prepare_claim_tx` — classify the conflict (do not propagate with `?`): in
  `execute_window` the conflicting row → `dropped.push(DroppedTx {
  disposition: Removed, rejection: typed })`; other store/decoding errors
  remain fail-loud `Err`. Rust admission (`admit_local_txs` /
  `AccountConsensus::admit_txs`) — the validator for items 1-3.

Mandatory vectors (all four, both engines, verdict parity):
(a) committed conflict; (b) two conflicts in one batch; (c) exact duplicate;
(d) stale admitted claim after an incoming frame.

## Landing gates

- L1: narrow tests for every spec item in the respective engine.
- L2: TS↔Rust verdict parity on all vectors.
- `bun run check` + the respective cargo tests — on a green tree (currently
  red from parallel WIP — not this task's debt).
- Commit: separate atomic commits FX-1/FX-2/FX-3; a `wip:` prefix if L1/L2
  are not green.

## FX-4 — conditional rollback-duplicate candidate (D7 candidate; DO NOT EXECUTE without a reachability proof and an owner decision)

Basis: the TLA+ verdict (`proofs/tla/report.md`, C3) — both variants have a
defect in the abstract model under the `DeliverPartial` action; safety
(Agreement/AckDurability) is violated by neither:

- **reject (Rust)**: CollisionTermination VIOLATED — after the crash window
  (post-rollback/pre-commit, `DeliverPartial`) every retransmit of the winner
  is rejected `ACCOUNT_PEER_FRAME_ROLLBACK_DUPLICATE` without a re-ack, LEFT
  ignores RIGHT's frame → a permanent same-height standoff under full
  delivery+resend fairness.
- **continue (TS)**: liveness holds, but OrphanPending VIOLATED —
  `commitIncomingFrameOnRealState` leaves the same-height pending in place;
  its restored txs are forever outside committed ∪ mempool ∪ removed
  (a terminal NoLostTx violation).

**Mandatory precondition gate:** demonstrate a production cutpoint at which
`lastRollbackFrameHash` becomes durable while the winning state/frame does
not. The current TS and Rust paths publish the whole transition through one
atomic WAL/LevelDB batch boundary; without such a witness BUG-05 stays
CONDITIONAL and the consensus must not be changed.

If a cutpoint is proven, the proposed canonical semantics unifies the engines:
1. Winner retransmit with `lastRollbackFrameHash == stateHash`:
   if the current state already commits that hash → re-ack (the existing
   Duplicate path);
2. if the commit did not happen (crash window) → carry out the winner's
   commit AND explicitly invalidate the stale same-height pending, restoring
   its txs to the mempool — never drop a tx and never stay silent without a
   re-ack.

Mandatory artifacts, in this order: (1) a C10/storage reachability witness;
(2) an owner decision; (3) an updated TLA model with green properties;
(4) TS↔Rust vectors: crash-window retransmit, orphan pending, and a normal
duplicate after a full commit. If item (1) proves atomic unreachability, FX-4
closes as a model counterexample outside production, with no engine change.

## Manifest of FX-1/FX-2 inside the mixed commit `64b41da54`

`64b41da54` ("feat(rscore): add resident runtime parity…", 499 files) carries
parallel replay-WIP; the FX-1/FX-2-relevant subset (for audit/extraction):

- `core/account/tx/admission-policy.ts` — `MAX_POLICY_VERSION = 9_007_199_254_740_991`,
  `OUT_OF_PROFILE_TX_KINDS`, typed `ACCOUNT_TX_POLICY_VERSION_OUT_OF_RANGE` /
  `ACCOUNT_TX_KIND_OUT_OF_PROFILE` (new file).
- `core/account/input/peer-rejection.ts` — peer-frame typed rejects
  `ACCOUNT_PEER_FRAME_TX_POLICY_VERSION_OUT_OF_RANGE` / `..._TX_OUT_OF_PROFILE`.
- `rscore/crates/engine/src/consensus/frame/hash.rs` — the Rust
  `MAX_POLICY_VERSION` admission check.
- `rscore/crates/engine/src/consensus/replica.rs`, `error.rs`, `lib.rs` — the
  typed-error wiring.
- Tests: `core/__tests__/proofs/fx-admission.test.ts`,
  `rscore/crates/engine/tests/fx_admission.rs`.

This violated fixes.md's own gate ("separate atomic commits FX-1/FX-2/FX-3");
FX-3 landed atomically (`190b778e9`), FX-1/FX-2 did not. Noted by the
2026-08-28 audit; do not rewrite history — extract this subset, if ever
needed, by cherry-picking onto a clean tree.
