# C1 reproduction audit — independent re-run and verification

Auditor angle: independent RE-RUN and VERIFY (do the artifacts and numbers hold?).
Audited artifacts: `proofs/readme.md` (C1 row), `proofs/fuzz/enc-diff/` (report.md,
generate.ts, run.ts, enc-diff-rust/, corpus/, corpus-full/), commit `dfd45cc7c`.

Environment of this audit: faithful state = `git archive dfd45cc7c` extracted to
`/tmp/c1-faithful` (read-only for the repo; `node_modules` symlinked, `bun.lock`/`package.json`
unchanged since dfd45cc7c so the symlink is version-faithful). Live state = working tree
during concurrent FX-1/FX-2 landing (HEAD moved 944353c7c → 631c68d37 mid-audit).
Tools: bun 1.3.14, cargo/rustc 1.94.1 (29ea6fb6a / e408947bf) — identical to the report.
Writes: only `proofs/audits/c1-repro/**` (this file + two reproducers).

## 1. Artifact-vs-report consistency — all verified

| Claim in report | Verified |
|---|---|
| `git rev-parse HEAD` at run = `80924b035…`, 243 dirty | consistent: C1 commit `dfd45cc7c` is proofs-only, parent is `80924b035` |
| committed corpus = 200 files (114 seed + 86 random) | `ls` = 200 = 114 `seed-*` + 86 `case-*` |
| main corpus-full = 10,114 cases (114 + 10,000) | 10,114 files = 114 seed + 10,000 case |
| versions bun 1.3.14 / cargo 1.94.1 / rustc 1.94.1 / ryu-js 1.0.3 / serde_json 1.0.151 / num-bigint 0.4.8 / sha2 0.10.9 | all match (`--version` + Cargo.lock) |
| report committed = working tree | SHA-256 `c1000039…` identical for `git show dfd45cc7c:report.md` and worktree |
| total 80,656 = 3×10,114 + 50,114 + 200 | arithmetic verified; re-executed at equal scale (below) |
| `Cargo.lock` committed | consistent: faithful `cargo build --release` left it byte-identical (md5 `5dbc885a…`) |

Production untouched: `git show --name-only dfd45cc7c` = 207 files, all under
`proofs/fuzz/enc-diff/` (zero outside `proofs/`). `git diff dfd45cc7c..944353c7c -- core/
rscore/crates/ jurisdictions/contracts/` = empty. Later commit 944353c7c (C4) touches only
`proofs/solidity` + `proofs/audits` — irrelevant to C1, confirmed.

## 2. Reproduction table (command → expected vs actual)

All faithful runs in `/tmp/c1-faithful` (dfda45cc→dfd45cc7c extract, fresh `cargo build --release`).

| Command | Expected (report) | Actual |
|---|---|---|
| `generate.ts --count 10000 --seed 20260826` then `run.ts` | 10,114 cases, 0 divergences; 9,353/751/7/3; byKind 4,444/2,634/1,006/552/494/500/484 | **exactly reproduced**, exit 0, 0 minimized |
| regenerated corpus-full vs wave-1 artifact `corpus-full/` | deterministic | **byte-identical** (`diff -r` exit 0) |
| `generate.ts --count 86 --seed 20260826` vs committed `corpus/` | corpus provenance | **byte-identical** (200 files) |
| `run.ts` (committed corpus, no args) | 200 cases, 0 failures | **200 / 0 failures**, exit 0 |
| `generate.ts --count 10000 --seed 777` + run (report repeat seed) | 10,114 / 0 | **10,114 / 0** |
| `generate.ts --count 10000 --seed 987653` (fresh seed) + run | ≥ fresh, 0 expected | **10,114 / 0** |
| `generate.ts --numbers-only --count 50000 --seed 424242` + run | 50,114 cases; 50,093 ryu-identical | **50,114 / 0 failures; both-encode = 50,093** (the report's figure is this count) |
| live-tree `run.ts` (committed corpus, prebuilt binary) | — | 200 cases, **1 failure**: `seed-tx-policy-unsafe-version` → TS tripwire `ACCOUNT_TX_POLICY_VERSION_OUT_OF_RANGE` — the FX-1 fix landing, not a C1 divergence (199/200 otherwise identical tallies) |

Re-executed faithful total: 10,114 + 200 + 10,114 + 10,114 + 50,114 = **80,656 cases, 0 divergences**
(seed mix 20260826/777/987653 vs report's 20260826/777/31337).

## 3. Boundary findings — reproduced in both states

Reproducers: `repro-policy-version.ts`, `repro-ts-only-kinds.ts` (this directory).
Run with `--root`/`--binary` pointing at `/tmp/c1-faithful` for the historical state,
no args for the live tree.

### policyVersion > 2^53−1 (report asymmetry #2)
- Historical (dfd45cc7c): TS `canonicalAccountTxForFrameHash` = passthrough → encodes
  `String(number)`. Observed: policyVersion 2^53 and **2^53+1 hash to IDENTICAL canonical
  bytes** (silent double rounding — distortion, not just asymmetry). Rust: `number(*policy_version)?`
  (hash.rs:255 at dfd45cc7c) → `CanonicalNumber::try_from_u64` → **`ACCOUNT_STATE_ROOT:
  CANONICAL_NUMBER_UNSAFE_INTEGER:9007199254740992`** — matches the report's "(UnsafeInteger)".
- Current (FX-1/D2 landed in parallel): TS throws `ACCOUNT_TX_POLICY_VERSION_OUT_OF_RANGE:
  rebalance_policy:…` (`core/account/tx/admission-policy.ts` + tripwire in hash.ts);
  Rust reports its own typed range error. Asymmetry closed on both sides. Confirms the
  task note: the typed TS reject is the fix landing, not absence of the historical behavior.

### TS-only tx kinds (report asymmetry #3)
- Both states: TS encodes `lending_fund`, `request_collateral`, `reserve_to_collateral`
  passthrough (live tree intentionally keeps them hashable so committed historical frames
  stay verifiable; admission/front door is where FX-2 rejects).
- Rust refuses: `ACCOUNT_FRAME_TX_UNSUPPORTED:lending_fund` /
  `ACCOUNT_FRAME_TX_UNSUPPORTED:reserve_to_collateral` (production `StateError::UnsupportedFrameTx`)
  and `TX_KIND_NOT_MODELED_IN_RUST:request_collateral` (driver-level: no Rust variant).
  Matches the report.

## 4. Concurrent-churn observations (not C1 defects)

- `minimized/` contained `min-probe-bign-set-dup.json` + `min-probe-tokenid.json` (01:35,
  after the report commit) early in this audit; both later vanished — `run.ts:465` wipes
  `minimized/` on every run and concurrent agents run the harness. The report's
  "minimized/ пуст" held at write time.
- Working tree carries heavy FX edits (incl. `core/account/consensus/frame/hash.ts`,
  `core/account/input/local-tx-admission.ts`, rscore engine files); HEAD moved during the
  audit. Faithful results above are isolated from all of this via the /tmp extract.
- The prebuilt `enc-diff-rust` binary (01:36) already contains post-C1 rscore FX edits;
  the faithful binary was rebuilt inside `/tmp/c1-faithful` and differs (old error string),
  which is exactly why the historical state was extract-verified.

## 5. Gap list (what keeps this from 100/100)

1. The report's run executed on a dirty tree (243 files); the exact TS-side bytes at run
   time are not reconstructable from git alone. Exact-tally reproduction makes drift unlikely.
2. Seed 31337 repeat not re-run here (777 verified + a fresh seed added; two of three repeats).
3. Sabotage-oracle calibration of the minimizer is not independently re-executable (wrapper
   not committed); wave-1 (proofs/audits/c1-adversary F4) shows the shrinker is broken for
   content-dependent divergences anyway — detection (fail/exit 1) is unaffected.
4. Coverage gaps inherited from the generator (wave-1 F2/F6/F7): TS-accepts/Rust-rejects
   family probed at one point (policyVersion) though siblings (tokenId u16, u8 timeInForce,
   format-parsing) share the pattern; ts-only kinds 3 of 14; empty j-events never generated.
5. "Both-reject parity for duplicates" is enforced by the driver (`assertNoDuplicates`),
   not by the TS production encoder, which has no duplicate check (wave-1 F3) — the report
   presents this parity as a codec property of both sides.
6. Committed corpus case `seed-tx-policy-unsafe-version` class label is now stale on the
   live tree (FX-1 makes TS reject) — per readme rule 4 it should be relabeled when FX-1 lands.

## 6. Grade

**92/100.** Every artifact count, class tally, kind tally, tool version, and the 80,656
total reproduce exactly at the pinned state; determinism is byte-identical; the commit is
proofs-only; both boundary findings are real and reproduced historically and currently.
Deductions: driver-substituted both-reject semantics presented as codec parity, single-point
coverage of the validation-asymmetry family, unverifiable minimizer calibration, stale class
label during the FX transition.
