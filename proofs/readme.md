# proofs/ — formal proofs and evidential fuzzing

The matrix was re-verified at `b7e3ace82b1c296dff0f646d3bebb120a90a0637`.
Every evidence report must record its own immutable SHA, tool versions, exact
commands, and bounded scope. A result from a dirty worktree is not evidence:
a re-run must come from `git archive` of the declared SHA or another clean
checkout. The machine-readable C1–C10 status is `proofs/program.json`;
`bun run check:proof-program` forbids a completion claim without existing
evidence and two current audits.

## Rules for all tasks

1. **Production code does not change.** Editing `core/**`,
   `rscore/crates/**/src/**`, `jurisdictions/contracts/**` (frozen-core) is
   forbidden. Allowed: new files under `proofs/**`, new test files in their
   native test directories, devDependencies (fast-check), new standalone
   crates under `proofs/**` with path dependencies on rscore.
2. **Claim discipline.** Every report contains: SHA, tool versions, exact run
   commands, bounded assumptions (ranges/depths/sizes), and the exact wording
   of the proven property. The word "impossible" is forbidden for finite
   models — only "within model X".
3. **Vectors are never hand-written.** The parity corpus is generated from a
   single source and committed as an artifact.
4. **Calibration.** A harness that cannot reproduce a known bug is considered
   uncalibrated: once a known bug appears it must become a regression case of
   its harness. (Owner, 2026-08-27: the external B1–B8 lists are undefined in
   context — do not wait and do not invent; self-calibration via sabotage
   tests is already applied in C1/C2.)

## Claim / Evidence matrix

| # | Claim (what is asserted) | Evidence (artifact) | Status |
|---|---|---|---|
| C1 | After exact boundary validation, the TS↔Rust canonical encoders produce identical bytes or both reject the input, within the generated domain | `proofs/fuzz/enc-diff/report.md`: clean post-FX `b7e3ace82`, 80,656 cases, 0 unexpected differences. The unknown-field direct-hash divergence is now a separate calibration and a production-boundary reject. Audits: c1-repro `findings.md` 92/100 at the historical `dfd45cc7c`, adversary 74/100. A new independent repro on the new bytes is required | ⚠️ bounded evidence; post-FX re-audit open |
| C2 | The hot root equals the cold recomputation after the covered mutation sequences | `core/__tests__/proofs/hot-vs-cold.test.ts` + `proofs/ts/report.md`: after hardening, 900 sequences, 325,793 deep checks. Residuals: empty `lendingIntents`/`subcontracts`/`pendingWithdrawals`/shadow maps, no delete for pulls, settlement/dispute/external-finality, double rollback, and boundary tokenIds. **c2-repro**: the original 2026-08-27 report was lost before commit; replaced by the independent re-audit `b043199fe` (**91/100**): clean-extraction `78e07d9a9` — 113,872 default / 325,793 deep, exact; gaps — `proofs/gaps.md` | ⚠️ strong bounded evidence, not closed |
| C3 | In the TLA model Agreement/AckDurability hold; the rollback-duplicate variants violate different liveness properties under `DeliverPartial` | `proofs/tla/report.md`: 8 TLC runs; independently re-run in full by the c3-repro audit (`bdb5733f3`, **93/100**): every distinct-state count exact (337,955 / 1,844×2 / 372,735×2 / 346,333). c3-adversary **89/100**: the model-vs-code encoding verified line-by-line; `DeliverPartial` stays an ASSERTED window → BUG-05 remains CONDITIONAL. Production reachability of `DeliverPartial` is not proven: TS and Rust publish the transition through one atomic WAL boundary; a crash-cutpoint witness is still required | ⚠️ model complete + audited (same-agent); crash-cutpoint open |
| C4 | Contract properties within the Foundry/Halmos models | `proofs/solidity/report.md`: 99 pass + 2 known fails; Halmos 5/5 independently re-run. `jurisdictions/contracts/**`, artifacts/typechain, and `frozen-core.json` unchanged relative to the frozen baseline. Hardening closed A1–A3/A5–A7; A4 partially closed, A8–A12 remain | ⚠️ reproducible, scope not closed |
| C5 | Bounded delta mirror: arithmetic and invariants at 16/8; sampled bridge to production 256/128 | `proofs/kani/report.md`: 16/16 Kani VERIFIED, 2M random + 500k walks + 15,987 boundary + 200k engine cross-check. The W256 rejection branch is effectively never reached; the calibration is 2 mutants + 1 coverage sensor, not 3 mutants. **kani-repro** (`bdb5733f3`, **93/100**): 16/16 VERIFIED (448/448 checks) + 16/16 tests re-run exactly at pin `13f51950a` | ⚠️ bounded evidence; external repro still open |
| C6 | Radix path-independence/round-trip/injectivity in the finite 4-key universe | `proofs/kani/report.md`: 24 permutations, 73 canonical subset orders, 16×15 ordered root pairs; `hash_branch16([])` — a manual census of 11 production call sites, not a machine proof. Re-run by the kani-repro audit (lib tests green) | ✅ bounded exhaustive; external repro still open |
| C7 | Seven parser targets across five crates do not panic/OOM in the executed wave-1 | `proofs/fuzz/parser/report.md`: 57.6M executions, 0 panic/OOM in the covered scope. Adversary grade: 61/100 for the original "all" claim, 84/100 for the narrow scope. Runtime decoders, checkpoint/orderbook assertions, and the wave-2 long run are unfinished | ⚠️ wave-1 scope only |
| C8 | Machine-checked TS↔Rust transition equivalence | The repository has parity digests and test vectors, but no dedicated report with SHA, commands, cardinality, an exact transition claim, and two audits | ❌ not proven as C8 |
| C9 | Trace refinement: one input sequence → equal roots/events/effects/outbox after every transition, with auto-shrink | phase 2 (built on the task-1 generators) | waiting |
| C10 | Crash-cutpoint: recovery after an artificial crash at every WAL→fsync→projection→outbox boundary ≡ bitwise-identical to the uninterrupted run | phase 2; extends `core/__tests__/storage/recovery/recovery-outbox-equivalence.test.ts` | waiting |

## Completion gate

- **12** audit packages are committed under `proofs/audits/`; C1-repro uses the
  name `findings.md`, the rest use `report.md`. C2-repro `b043199fe` replaces
  the original lost before commit; c3-adversary/c3-repro/kani-repro
  (`bdb5733f3`) close the previously missing TLA×2 and Kani-repro — all three
  performed by the same audit agent (external provider quota died 2026-08-27),
  so an external re-run stays on the gap list. Audits landed in git later than
  the pins of their evidence (`9aa5affbe`/`3cbf807da`) — when citing, verify
  the report's SHA, not only the evidence SHA.
- The unified register of audit demands (to 100/100) is `proofs/gaps.md`; the
  "program complete" status requires it to be zeroed or an explicit owner
  decision on every OPEN item.
- Required before "program complete": a real C8, C9/C10, a production
  crash-cutpoint for C3/BUG-05, C7 wave-2, and the Kani W256 rejection fix.
- Final numbers must be corrected in the primary sections of the reports, not
  only in late annotations, and re-run by two independent audits on one
  immutable SHA.
- The release package requires a clean SHA, English sources, `bun run check`,
  and the final claim → proof → adversary → repro → residual risk table.
  Folder-width is already green: `FOLDER_WIDTH_OK` (the grandfathered debt
  does not include `test/foundry`).

## Exact codec-property wordings (for tasks 1, 6, 7)

- `decode(encode(x)) = normalize(x)`
- `encode(decode(canonicalBytes)) = canonicalBytes`
- Every accepted wire input must be canonical (re-encode = input).
- Every rejected input leaves the decoder/replica state unchanged.

Generator sharp edges (mandatory seeds): surrogate pairs/non-BMP (cmp_utf16 vs
JS `<`), the `ryu_js` round trip and the JS_MAX_SAFE_INTEGER boundaries, `-0`,
`1e21`, the zero BigInt (`[0]` magnitude), empty Array/Set/Map, duplicate keys
(both sides must reject), strings of exactly 55/56 bytes (the RLP boundary).

## Owner decision log (2026-08-27)

- **D1** `entity-kernel/commitment.rs` — the canonical authoritative RRS code;
  the comment and the name `with_diagnostic_commitments` were corrected to
  canonical. Closed.
- **D2** `policyVersion` — one range for both engines,
  `0..Number.MAX_SAFE_INTEGER` (9_007_199_254_740_991); TS and Rust reject
  anything larger at admission before the mempool. A full u64 in Rust alone —
  only with a protocol bump. → `proofs/fixes.md` FX-1.
- **D3** `lending_*`/`reserve_to_collateral` — outside the RRS profile
  (profile: pay/HTLC/same-J swap/j-event/rebalance). A loud admission reject
  in both directions, no TS fallback. → FX-2.
- **D4** F1 j-claim — one shared validator for admission and proposal; an
  exact duplicate is idempotent; a conflict with a committed/earlier mempool
  claim is a typed reject; the proposal drops only the conflicting row with a
  typed disposition and the account continues — never a bare `Error`.
  Mandatory TS↔Rust vectors: committed conflict, two conflicts in one batch,
  exact duplicate, stale admitted claim after an incoming frame. →
  `proofs/fixes.md` FX-3. **Hardening landed** (`b8004d939`): 7 non-empty
  collections, delete paths, conflicts and the D4 vectors pinned, the
  entity-overlay layer, 325,793 deep checks. The residual scope is listed in
  `proofs/ts/report.md`; the replacement C2-repro is `b043199fe`, 91/100.
  BUG-13/BUG-14 were found (see bugs.md).
- **D5** Removing the legacy wave/shadow/worker — atomically, after exact RRS
  replay + crash restore TS↔Rust + pay/same-J HLT. Do not touch before the
  gates.
- **D6** Re-ACK — reusing the stored Hanko without a new ECDSA;
  current/previous-board grace; a missing/corrupt cache is a loud refusal.
  Being fixed by a parallel task.
- **Freeze**: no new formal directions are opened; the critical path is exact
  RRS. The current tasks (TLA/foundry/Kani) are being completed.



1. Differential encoder fuzz (the foundation under all the roots) — no new toolchain.
2. Hot-vs-cold properties — no new toolchain.
3. TLA+ bilateral — a narrow machine, not the cascade.
4. Foundry invariants — conservation/allowances/nonce/hanko.
5. Kani (the delta mirror + bounded radix) — last of the "formal" ones.

Kani restriction: no claims about BigInt/SHA/ECDSA/the whole machine — only
bounded fixed-width arithmetic, overflow, routing, and small reducers.

## Rejected/deferred

- **Loom** — rejected: loom verifies atomics/memory orders of small lock-free
  structures; the resident-forest synchronization is Barrier+AtomicBool with a
  simple phase protocol, not loom-scale. Protocol-level phase properties are
  covered by TLA+ (phase 2, optional).
- **Certora** — deferred (no license); foundry-invariants gives ~70% of the
  same for 0 licenses.
- **CI gate** (a change to `core/account/consensus/**` or
  `rscore/crates/engine/src/consensus/**` without a green TLC = red) —
  proposed; enabling it requires an owner decision.

## Known divergence for the TLA variants (verified against the code)

`rollback-duplicate` (a retransmit of the winning frame after a rollback):
TS `core/account/consensus/incoming/collision.ts:198` → `return undefined`
(continue),
Rust `engine/src/consensus/incoming/apply.rs:707` →
`rejected("ACCOUNT_PEER_FRAME_ROLLBACK_DUPLICATE")`
(lines — audited HEAD `b7e3ace82`; at the TLA pin `13f51950a` they are
`:196`/`:652`, see `proofs/tla/report.md`).
The model must encode both variants (`TS_ROLLBACK_DUP == continue | reject`)
and check whether the divergence breaks Agreement. The reachability window is
narrow (post-rollback/pre-commit + retry); if reachable, the Rust path may
suppress a needed re-ack → liveness. This is not a "parity divergence" but a
priority bug candidate (CONDITIONAL until the cutpoint is proven — BUG-05).
