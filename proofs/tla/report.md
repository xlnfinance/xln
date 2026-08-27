# C3 — TLA+/TLC: bilateral Account-frame consensus (BilateralAccount)

- **Pinned run SHA:** `13f51950a483dc5b721c722259881fb089768368` (working tree carries
  uncommitted parallel-task changes; `git status --porcelain | wc -l` = 26 at first
  run / 15 at final run; this task's footprint is exactly `proofs/tla/**`).
  Note: `bun run check` is red at this SHA on rscore clippy lints in
  `rscore/crates/runtime/src/entity_frame/**` + `restore/entity/**` — files modified
  by a parallel task, not by this task (which touches only `proofs/tla/**`).
- **Tools:** TLC2 Version 2026.08.21.155922 (rev 9787e65) from `tla2tools.jar`
  (TLA+ release v1.8.0, sha256
  `eabd140a70f49eb9305a3bd3f3df944eddf87e5a90d329789085f8953a80533a`),
  OpenJDK 26.0.2.1 (Homebrew), single worker, macOS aarch64.
- **Model:** `proofs/tla/BilateralAccount.tla`. Scope is exactly the task's narrow
  machine: one account, replicas L and R; no Runtime→Entity→Account cascade.

## Commands

```bash
export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"
cd /Users/zigota/xln/proofs/tla
# safety (TLC's deadlock check is off: finite terminal states are benign)
java -jar tla2tools.jar -deadlock -config BC-continue-CrashFALSE.cfg BilateralAccount
java -jar tla2tools.jar -deadlock -config BC-reject-CrashFALSE.cfg  BilateralAccount
java -jar tla2tools.jar -deadlock -config BC-continue-CrashTRUE.cfg  BilateralAccount
java -jar tla2tools.jar -deadlock -config BC-reject-CrashTRUE.cfg   BilateralAccount
# liveness (fairness in SpecLive; PROPERTY CollisionTermination)
java -jar tla2tools.jar -deadlock -config BC-continue-CrashTRUE-Live.cfg BilateralAccount
java -jar tla2tools.jar -deadlock -config BC-reject-CrashTRUE-Live.cfg  BilateralAccount
```

`RbNotReached` is a reachability probe, not a defect claim: its VIOLATION is the
proof that the rollback-duplicate guard fired (TLC prints the witness). Deep runs
(reproducible as `sed '/RbNotReached/d' <cfg> > deep.cfg` and additionally
`sed '/OrphanPending/d'` for the continue variant) establish the remaining
invariants over the full state space.

## Model bounds (finite model; all claims are "within the model", never "impossible")

| Constant | Value (all six cfgs uniform) |
|---|---|
| `Tx` | `{t1, t2}` (2 txs) |
| `MaxHeight` | 2 |
| `Cap` (in-flight redundant copies) | 3 |
| `MaxMsgId` (frame/copy/bundle budget) | 6 |
| `MaxAckId` (ACK-emission budget) | 4 |
| `TS_ROLLBACK_DUP` / `CrashEnabled` | per cfg |

State constraint `StateConstraint == nid =< MaxMsgId /\ anid =< MaxAckId` bounds
behaviors. The crash-window witnesses live at height 1 (depth-9 traces), well
inside these bounds; the two crash-TRUE probe runs were additionally confirmed at
looser bounds (`MaxHeight=3`, `MaxMsgId=10`, `MaxAckId=8`) with identical
violations at the same 1,844 distinct states. Additional abstractions:
signature/Hanko validity is environment-granted (no forgery actions);
`stateHash` is an injective `HashOf(side, height, txs, prev)` covering the same
fields as `computeCanonicalAccountFrameHash` / `rscore` frame hashing (height,
prevFrameHash, byLeft, txs; deltas/stateRoot are functions of txs at this
abstraction); `Propose` flushes the whole mempool (mempool order is irrelevant to
every property, so "restore to the front" is set union); ACK responses reuse an
in-flight identical ACK (the `lastOutboundFrameAck` response cache); `Resend`
re-injects the original message record (no budget burn).

## Encoded engine semantics (parity sources)

- GATE A duplicate re-ACK, stale ignore, equal-height-hash reject, height gap,
  prev-hash chain, byLeft proposer check: `core/account/consensus/incoming/replay.ts`
  + `preflight.ts` ↔ `rscore/.../incoming/apply.rs` (identical in both engines).
- LEFT-wins same-height collision ignore: `collision.ts:170` ↔ `apply.rs:646`.
- RIGHT fresh collision: rollback (pending txs → mempool front, `rollbackCount++`,
  `lastRollbackFrameHash := winner hash`) then commit winner + ACK:
  `collision.ts:205` ↔ `apply.rs:726`/`replica.rs:527`.
- **The divergence** (`collision.ts:196` ↔ `apply.rs:652`): on a same-height frame
  whose hash equals `lastRollbackFrameHash`, TS `continue`s normal processing
  (validate, commit, ACK; pending NOT rolled back, NOT cleared) while Rust rejects
  with `ACCOUNT_PEER_FRAME_ROLLBACK_DUPLICATE` (no state change, no ACK).
- ACK commit (proposer): commits pending iff heights and certificate hash match —
  note neither engine guards `pending.height > current.height` here
  (`ack-commit.ts:285` ↔ `apply.rs:874`); `rollbackCount` decrement and
  `lastRollbackFrameHash` drop at 0 (`ack-commit.ts:242` ↔ `replica.rs:495`).
- `frame_ack` bundles process the ACK part first, then the frame — the dispatch
  order of `index.ts` (`handlePendingFrameAck` before `handleIncomingAccountFrame`).
- Crash model: all tracked replica fields are durable in the real engines
  (`core/storage/schema/account-field-tags.ts`: pendingFrame 16, rollbackCount 23,
  lastRollbackFrameHash 24; Rust persisted-fields list in `replica.rs`), so
  crash+restore between actions is a controlled stutter (`RestoreIsNoop`). The only
  observable crash is `DeliverPartial`: the WAL-boundary fault inside the rollback
  handler — rollback envelope persisted, winning-frame commit + ACK lost. This is
  the readme's "post-rollback/pre-commit" window, and it is the ONLY opener of the
  rollback-duplicate guard (a same-height pending needs `current` back at `h-1`,
  which requires losing the winner's commit while `lastRollbackFrameHash` survived).

## Properties (exact names in the module)

- `Agreement` — ∀ side: no two frames in the commit history share a height with
  different stateHash; and whenever both `current` frames sit at the same height,
  their hashes are equal.
- `AckDurability` — every ACK ever emitted (and every in-flight ACK) references a
  frame in the emitter's monotone commit history; with the ACK-before-frame bundle
  order in `Deliver`, a valid committed ACK stays committed even when the bundled
  frame is rejected.
- `NoLostTx` — every admitted tx is at every state in: committed frames ∪ mempools
  ∪ pendings ∪ explicit `removed` (the state-invariant form; the terminal form
  "ends in exactly one of committed ∪ mempool ∪ removed" is discussed below).
- `OrphanPending` (probe) — `pending.height = current.height + 1`; a pending at
  height ≤ current is an orphan.
- `RbNotReached` (probe) — the rollback-duplicate guard never fired.
- `RestoreIsNoop` — every pending/in-flight frame hashes to `HashOf` of its content
  (replay reproduces the identical frame hash/state root).
- `CollisionTermination` (liveness, under explicit fairness): both sides cannot
  hold same-height competing pendings forever. Fairness (in `SpecLive`):
  per-message-id weak fairness of `DeliverById` + per-side weak fairness of
  `Resend`; crashes/WAL faults get NO fairness (liveness must not rest on a fault
  firing). Per-instance fairness is required — WF of the existential disjunction is
  satisfied by one instance cycling while another starves.

## Results

All numbers are from the final module bytes (`git diff` of the working tree shows
only `proofs/tla/**` from this task), uniform bounds above, `-deadlock` (finite-model
terminal states are benign, not TLA deadlocks). "Deep" = same cfg with the probe
invariants removed from the INVARIANT list, so TLC explores the full space past the
expected probe violation.

| Config | Result | States / time |
|---|---|---|
| `BC-continue-CrashFALSE` | **All invariants hold, incl. RbNotReached** (guard unreachable without the window) | 337,955 distinct, complete, 1 min 39 s |
| `BC-reject-CrashFALSE` | **All invariants hold, incl. RbNotReached** | 337,955 distinct, complete, 1 min 39 s |
| `BC-continue-CrashTRUE` | **OrphanPending VIOLATED** at depth 9 through `rbdup = TRUE` | 1,844 distinct at violation |
| `BC-continue-CrashTRUE` deep | Agreement/AckDurability/NoLostTx/RestoreIsNoop **hold** | 372,735 distinct, complete, 1 min 49 s |
| `BC-reject-CrashTRUE` | Only the RbNotReached probe fires (guard reachable, benign for safety) | 1,844 distinct at violation |
| `BC-reject-CrashTRUE` deep | Agreement/AckDurability/NoLostTx/OrphanPending/RestoreIsNoop **hold** | 346,333 distinct, complete, 1 min 43 s |
| `BC-continue-CrashTRUE-Live` | **CollisionTermination HOLDS** | 372,735 distinct, complete, 3 min 59 s |
| `BC-reject-CrashTRUE-Live` | **CollisionTermination VIOLATED** (permanent same-height standoff) | counterexample at depth ~24 |

## The divergence verdict (the C3 question)

Within the model bounds, neither variant violates `Agreement` or `AckDurability`;
the code-level divergence is **not** a bilateral-safety bug. It splits liveness vs.
tx-stranding:

- **`reject` (Rust)**: after the WAL-boundary window, RIGHT re-proposes its restored
  txs at height h while `lastRollbackFrameHash` still equals LEFT's winner hash W.
  Every retry of W is rejected (`ACCOUNT_PEER_FRAME_ROLLBACK_DUPLICATE`, no ACK),
  while LEFT ignores RIGHT's frame (LEFT-wins). Both pendings persist forever
  under full per-instance delivery+resend fairness → **CollisionTermination
  violated** (TLC counterexample: cycle Deliver/Resend, rbdup=FALSE, `lrb[R] = h(W)`,
  both `current` at h−1). The Rust path suppresses the re-ack that would let the
  system converge — exactly the readme's liveness hypothesis.
- **`continue` (TS)**: the same retry is processed normally — RIGHT commits W and
  ACKs, LEFT commits on the ACK, the collision terminates (liveness holds). But
  `commitIncomingFrameOnRealState` does not touch `pendingFrame`, so RIGHT's
  re-proposed pending at h survives while `current` advances to h → **OrphanPending
  violated** (witness: `current[R] = W@1{t1}`, `pending[R] = P@1{t2}`, `rbdup=TRUE`).
  Its txs leave the mempool-rollback cycle: no future same-height collision can
  restore them (frames move to h+1), the orphan can never be ACK-committed (LEFT
  rejects/ignores P@1), so those txs are permanently stranded outside
  committed ∪ mempool ∪ removed — the terminal form of NoLostTx fails for them.
  The orphan cannot escalate to Agreement here: `ack-commit` would install it only
  on an ACK from LEFT, which never comes (LEFT-wins / stale-hash reject), verified
  by the clean deep run.
- **Without the window** (`CrashEnabled = FALSE`) the guard is unreachable
  (RbNotReached holds in both variants): `stateHash` covers height, so a stored
  rollback hash can only match an exact retransmit of the previous winner at a
  height RIGHT has already committed — a same-height pending then requires losing
  that commit while the envelope survived, i.e. the WAL-boundary fault.

**Priority call (within the model):** the Rust `reject` behavior is a liveness bug
candidate with a plausible reachability window (rollback envelope persisted before
the frame-commit projection, plus a retry). The TS `continue` behavior preserves
liveness but strands the restored txs in an orphaned pending. Neither is an
Agreement/AckDurability break; both deserve an owner decision on the canonical
post-rollback-duplicate semantics (re-ack + explicit pending invalidation would fix
both).

## Coverage caveats

- Finite model: heights ≤ 3, |Tx| = 2, message budgets 10/8 — claims are "within
  the model", per readme discipline; no "impossible" wording is claimed beyond it.
- Crypto fully abstracted: signature/Hanko validity, board freshness, dispute
  evidence, transformer execution are environment-granted; hashes are injective
  content functions. Adversarial signing is out of scope.
- The WAL-boundary fault (`DeliverPartial`) is a durability-ordering abstraction
  (envelope fsync before frame-commit projection fsync); whether the real engines
  can persist `lastRollbackFrameHash` without the winning commit is a storage-layer
  question this model does not answer — it only shows what happens if they can.
- `CrashVolatile` (drop-pending) was evaluated and rejected as a fault model: it
  violates Agreement identically in BOTH variants (surviving proposal message +
  post-restore acceptance of the peer's competing frame), but the real engines
  persist `pendingFrame`, so that fault is out of model (documented in the module).
- Liveness and safety use the same bounds; the standoff counterexample needs only
  height 1, so the window is well inside them. Liveness checking is substantially
  slower (3 min 59 s vs ~1 min 45 s for the same space).
- Terminal-state NoLostTx ("ends in exactly one of") is not machine-checked as an
  invariant (any in-flight proposal transiently holds its txs); the stranding
  consequence of the continue-orphan is argued from the witness + enabled-action
  analysis above.
