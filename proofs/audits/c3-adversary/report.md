# C3 adversary audit — validity of the BilateralAccount TLA+ model

- Date: 2026-08-28. Auditor: ZCode audit agent (same agent as the c3-repro
  companion — NOT an independent external model; flagged for an external re-run
  when provider quota allows. The 2026-08-27 external quota died at 02:39).
- Angle: attack MODEL VALIDITY — does `proofs/tla/BilateralAccount.tla` encode
  both engines' semantics faithfully enough that the C3 verdict (Agreement and
  AckDurability hold in both variants; `reject` violates CollisionTermination;
  `continue` violates OrphanPending) is a statement about the real divergence
  and not a modeling artifact?
- Environment: HEAD `3c2cb429c`, model as committed by `9aa5affbe`, dirty
  working tree (parallel tasks; none touch `proofs/tla/` or the audited engine
  files' consensus semantics). Read-only audit; writes confined to this file.

## Code-vs-model verification performed

1. **TS divergence semantics VERIFIED.**
   `resolveSameHeightIncomingFrame` returns `undefined` from the
   rollback-duplicate guard (`core/account/consensus/incoming/collision.ts:198`).
   The consumer (`core/account/consensus/incoming/preflight.ts:340-352`) treats
   a falsy non-`true` result as `kind: 'continue'` with
   `rollbackPendingFrame: false` — the frame proceeds to normal validation,
   commit and ACK while `pendingFrame` is untouched. The model's
   continue-branch (`BilateralAccount.tla:152-158`: `cur := F`, `pend`
   unchanged, `sendAck`) is faithful. The LEFT-wins branch returns a truthy
   applied-result consumed as `kind: 'return'` (whole-input no-op) — matches
   `NoopR` for that path.
2. **Rust divergence semantics VERIFIED.**
   `rscore/crates/engine/src/consensus/incoming/apply.rs:705-710`:
   `last_rollback_frame_hash() == Some(&state_hash)` →
   `rejected("ACCOUNT_PEER_FRAME_ROLLBACK_DUPLICATE")`, no state change, no
   ACK — exactly the model's reject-branch (`:149-151`, `rbdup := TRUE`).
3. **Fresh-collision rollback VERIFIED.** TS `collision.ts:207-240`: pending
   txs restored to the mempool front, pending deleted,
   `rollbackCount = Math.max(1, rollbackCount + 1)`,
   `lastRollbackFrameHash := winner hash`; Rust `replica.rs::rollback_pending`
   (parity source listed in the module header). Model `:162-165` matches
   (set-union restore ≡ order-insensitive properties; see A2).
4. **LEFT-wins tiebreak VERIFIED in both engines.** TS `collision.ts:170-194`
   (lexicographic `isLeftEntity`, ignore + wait for ACK); Rust `apply.rs:697-701`
   (`owner_side() == Side::Left → CollisionIgnored`), with identical
   "each side may propose once at a height; LEFT wins" rationale comments.
   Only RIGHT ever reaches rollback in either engine — the model's RIGHT-only
   `DeliverPartial` asymmetry is forced by the encoded semantics, not an
   artifact.
5. **ACK-commit height-guard absence VERIFIED.**
   `ack-commit.ts:295-297` gates the pending commit only on
   `pendingFrame && ackHeight === pendingFrame.height && ack` — there is no
   `pending.height > current.height` check, so an orphaned same-height pending
   is installable by a matching ACK. The model's `DoAck` (`:187-194`) encodes
   exactly this; the OrphanPending verdict rests on real engine behavior, and
   the deep-run Agreement hold confirms the orphan cannot escalate (LEFT never
   ACKs it: LEFT-wins ignore / stale-hash reject).
6. **Gate order parity VERIFIED.** The model's dup → stale → same-height-diff
   → gap → prev → byLeft → collision order matches Rust
   (`HEIGHT_GAP`/`PREV_MISMATCH`, `apply.rs:657-667`) and TS preflight (full
   chain/deadline validation before the collision decision — the parity is
   stated in the apply.rs comment at `:693-695`). `HashOf` covers the proposer
   side, so a `dup` (hash equal to a committed frame) implies the same
   proposer; checking `dup` before the `byLeft` test is sound.

## Findings

- **A1 (LOW, exactness): `Math.max(1, rc + 1)` vs model `rc + 1`.** Equivalent
  on reachable states (`rc ≥ 0` always); recorded for completeness.
- **A2 (LOW, disclosed abstraction): rollback restores the mempool FRONT
  (ordered prepend with dedup) vs the model's set union.** Every checked
  property is order-insensitive (NoLostTx is a set property; mempool ordering
  is out of model). Disclosed in the report; no property depends on order.
- **A3 (MEDIUM, scope honesty — already disclosed by the report):
  `DeliverPartial` ASSERTS the crash window; it does not prove the window is
  reachable in production.** The action models "rollback envelope persisted,
  winner commit + ACK lost" as an enabled fault. Whether real TS/Rust
  persistence can split that transaction (vs publishing the whole transition
  through one atomic WAL/LevelDB batch boundary) is a storage-layer question
  TLC cannot answer. The report discloses this, and `proofs/fixes.md` FX-4
  (2026-08-28 rewrite) correctly gates any engine change on a production
  cutpoint witness. Consequence: BUG-05 must remain CONDITIONAL; the model
  proves *conditional* defects, exactly as registered.
- **A4 (LOW, fairness): per-instance `WF(DeliverById)` + `WF(Resend)` is the
  right strength.** The reject-variant standoff cycle uses only fair actions
  (L's `Resend` re-injects W without budget burn by design; each delivered W is
  consumed and rejected by R; R's re-proposed pending is ignored by LEFT-wins).
  The violation therefore does not rest on unfair retransmission. `Bundle` and
  `Retransmit` correctly receive no fairness.
- **A5 (LOW, bounds):** `Tx = {t1,t2}`, `MaxHeight = 2` (deep confirmation at
  3), `MaxMsgId 6 / MaxAckId 4` (deep 10/8). All witnesses live at height 1
  (depth-9 traces; standoff at height 1, counterexample depth ~24), well
  inside the bounds. Adequate for the checked claims.
- **A6 (INFO): `CrashVolatile` is a controlled stutter** — every tracked
  replica field is durable (TS `account-field-tags.ts` pendingFrame 16 /
  rollbackCount 23 / lastRollbackFrameHash 24; Rust persisted-fields list in
  `replica.rs`), and restore re-derives the pending bit-for-bit. The stronger
  drop-pending fault violates Agreement identically in BOTH variants and is
  correctly excluded as out-of-model; the module comment is accurate.

## What the model does NOT claim (verified honest)

No Runtime→Entity→Account cascade, no multi-account, signature/Hanko validity
environment-granted, injective content hash instead of crypto, mempool
ordering out of model, WAL fsync granularity out of model (A3), terminal-form
NoLostTx argued from the witness + enabled-action analysis rather than
machine-checked.

## Grade: **89/100**

The encoding is faithful: every divergence-critical branch was traced to both
engines' code lines during this audit; properties are precisely named; the
probe-invariant methodology (a `RbNotReached` violation IS the reachability
witness) is sound and clearly documented. Deductions: A3 — the verdict's
real-world force is conditional on an unproven storage window (disclosed,
−6); same-agent audit rather than an independent external reviewer (−3);
A1/A2 exactness notes (−2).

## Gap list (to 100/100)

1. Storage-layer cutpoint witness (FX-4 precondition) — decides whether BUG-05
   is production-reachable at all.
2. Once the owner decides the canonical semantics: extend the model with the
   FX-4 fix (re-ack the winner + explicit pending invalidation) and show both
   CollisionTermination and OrphanPending green.
3. External independent re-run of both C3 audits (provider quota permitting).
