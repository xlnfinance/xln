# C2 reproduction audit — independent re-run and verification (re-audit)

> **Provenance note.** An original c2-repro audit was performed 2026-08-27
> (coordinator-claimed grade 88/100; its finding B — the still-open enqueue-level
> typed-reject tail of FX-3 — was folded into commit `190b778e9`). That report
> file was never committed and is unrecoverable from any git ref (verified
> `git log --all -- proofs/audits/c2-repro/` = empty); this is a fresh,
> independent reproduction audit (2026-08-28) that replaces it. The lost-file
> event is registered as a coordinator error in the 2026-08-28 program audit.

Auditor angle: independent RE-RUN and VERIFY — do the committed C2 artifacts
reproduce their headline numbers on a clean extraction of a committed SHA?

## Environment identity

| Item | Value |
|---|---|
| Audited HEAD | `78e07d9a92b5a022cb55a9a32519f10341148d0e` (committed state; harness unchanged since hardening commit `b8004d939` — `git log b8004d939..HEAD -- core/__tests__/proofs/` is empty) |
| Faithful state | `git archive 78e07d9a9` extracted to `/tmp/c2-faithful`, `node_modules` symlinked (fast-check 4.9.0 = devDependency at this SHA) |
| Live tree during audit | 143 dirty files (parallel-task WIP; none in `core/__tests__/proofs/`) |
| Tools | bun 1.3.14 (JavaScriptCore), fast-check 4.9.0 |
| Writes by this audit | only `proofs/audits/c2-repro/**` |

## Reproduction table

| Command | Expected (`proofs/ts/report.md`) | Actual | Verdict |
|---|---|---|---|
| faithful `bun test core/__tests__/proofs/hot-vs-cold.test.ts` (default 100 runs × 3 seeds) | 7 pass, 0 fail, 113,872 expect() calls, 27–30 s | **7 pass, 0 fail, 113,872 expects, 26.98 s** | exact |
| faithful `XLN_C2_RUNS=300` (deep) | 7 pass, 0 fail, **325,793** expects, 79.4 s | **7 pass, 0 fail, 325,793 expects, 79.74 s** | exact |
| live dirty tree, default | loads and passes despite parallel WIP | 7 pass / 0 fail / 113,872 expects / 28.52 s | pass |
| sequence accounting (report §hardening A7) | 900 distinct sequences (100-run ⊂ 300-run per seed), NOT «1,200» | consistent: per-seed determinism makes the default run a strict prefix; report's corrected figure is the honest one | verified |

## Artifact-vs-report consistency

- Composition of the 7 tests matches the report: regression corpus (9 corpora +
  coverage floors), finding-pin F1 (post-FX-3 semantics: conflicting j_event_claim
  removed without halting), D4 vectors, C2-H2 pin, 3 fast-check seeds.
- The report's post-fix note (top of `proofs/ts/report.md`) accurately describes
  the committed pin: `hot-vs-cold.test.ts` asserts typed resolution
  (propose resolves, mempool empties, surviving payment in pending), not the
  historical throw.
- FX-3 tail (original audit's finding B) closed on main: enqueue-level typed
  reject present in `core/account/input/local-tx-admission.ts` (commit
  `190b778e9`), Rust mirror in `engine/src/consensus/replica.rs`; L1 vectors
  committed as `core/__tests__/account/j-claims/j-claim-admission-vectors.test.ts`
  (445 lines) and `rscore/crates/engine/tests/fx3_j_claim_admission.rs` (452 lines).
- Hardening claims cross-checked against the harness: 8 new tx kinds, 7
  non-empty collections on 300-run, entity-overlay exercise, `finalizedJHeight`
  from state — all present in the committed test source.

## Residual gaps (reproduction angle)

1. The original 2026-08-27 evidence runs executed on dirty trees (313/15/72
   dirty at various points); the exact TS-side bytes at those runs are not
   reconstructable from git alone. Mitigated: this re-audit's clean-extraction
   runs match every headline number exactly, and the harness is
   byte-trackable since `b8004d939`.
2. Seed diversity is 3 fixed seeds; a fresh-seed run was not performed here
   (c1-repro's fresh-seed discipline on C1 suggests low risk).
3. The throw-era historical pin ("hot==cold up to the halt") exists only in prose —
   no committed SHA reproduces the pre-FX-3 behavior (the fix landed before
   the first C2 commit reached git).
4. Inherited coverage residuals are tracked in `proofs/gaps.md`
   (c2-adversary items 8–10, A9).

## Grade

**91/100.** Every committed headline number — 7/0 test composition, 113,872
default and 325,793 deep expects, runtimes, determinism accounting — reproduces
exactly on a clean extraction of a committed SHA, and the harness survives a
dirty parallel-WIP tree unchanged. Deductions: the original audit event itself
is unrecoverable (this file re-derives its conclusion; −4), original runs on
non-reconstructable dirty states (−3), no fresh-seed sample (−2).
