# C3 reproduction audit — independent re-run and verification

- Date: 2026-08-28. Auditor: ZCode audit agent (same agent as the c3-adversary
  companion — NOT an independent external model; flagged for an external re-run
  when provider quota allows).
- Angle: independent RE-RUN — do all eight TLC headline results of
  `proofs/tla/report.md` reproduce on the committed model bytes?

## Environment identity

| Item | Value |
|---|---|
| Audited HEAD | `3c2cb429c`; model = committed `BilateralAccount.tla` + the six `.cfg` files (`9aa5affbe`) |
| Tools | TLC2 2026.08.21.155922 (rev 9787e65) from the committed `tla2tools.jar`, OpenJDK 26.0.2.1, single worker, macOS aarch64 |
| Deep configs | derived exactly per the report: `sed '/RbNotReached/d'` (reject) and additionally `sed '/OrphanPending/d'` (continue) |
| Writes | only this file (+ TLC's own `states/` scratch, wiped per run) |

## Reproduction table (all eight runs)

| Config | Expected (report) | Actual | Verdict |
|---|---|---|---|
| `BC-continue-CrashFALSE` | all invariants hold incl. RbNotReached; 337,955 distinct, complete, 1:39 | **337,955 distinct, 0 on queue, no error, 1:38** | exact |
| `BC-reject-CrashFALSE` | all invariants hold incl. RbNotReached; 337,955 | **337,955, complete, no error** | exact |
| `BC-continue-CrashTRUE` | OrphanPending VIOLATED at depth 9, 1,844 distinct | **violated, 1,844 distinct, depth 9** | exact |
| `BC-reject-CrashTRUE` | only RbNotReached probe fires; 1,844 distinct | **RbNotReached violated, 1,844 distinct, depth 9** | exact |
| `BC-continue-CrashTRUE` deep | Agreement/AckDurability/NoLostTx/RestoreIsNoop hold; 372,735 complete | **372,735, complete, no error** | exact |
| `BC-reject-CrashTRUE` deep | all hold; 346,333 complete | **346,333, complete, no error** | exact |
| `BC-continue-CrashTRUE-Live` | CollisionTermination HOLDS; 372,735 | **372,735 complete, temporal check finished with no violation** | exact |
| `BC-reject-CrashTRUE-Live` | CollisionTermination VIOLATED (standoff) | **violated, counterexample produced** | pass (see N1) |

Every distinct-state count matches the report to the state.

## Notes

- **N1 (LOW):** the report's table says the reject-Live counterexample is "at
  depth ~24"; this run's TLC reports "depth of the complete state graph search
  is 15" at the violation. Same violation, same standoff shape (verified by
  the probe pattern: fair Resend/Deliver cycle, `rbdup` sticky, both pendings
  same-height). The depth annotation in the report is approximate/stale; the
  verdict is unaffected.
- Runtime drift vs the report: within seconds per run (identical hardware
  class, single worker).
- The model bytes were NOT modified by this audit; deep configs were temp
  files (deleted after the runs).

## Residual gaps (reproduction angle)

1. Same-agent audit, not an independent external reviewer.
2. The looser-bounds re-confirmation (MaxHeight=3/MsgId=10/AckId=8, same
   1,844 states) recorded in the report was not re-run here — the uniform
   bounds cover every witness (all at height 1), so this does not weaken any
   cited claim.
3. Production reachability of the `DeliverPartial` window remains a
   storage-layer question (see c3-adversary A3 and FX-4) — out of scope for a
   TLC re-run by construction.

## Grade

**93/100.** All eight configurations reproduce exactly — every state count,
violation identity, probe behavior, and completion status matches the
committed report on the committed model bytes. Deductions: same-agent audit
(−4); the N1 depth-annotation drift (−2); looser-bounds re-confirmation not
repeated (−1).
