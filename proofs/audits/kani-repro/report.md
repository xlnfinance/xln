# C5+C6 reproduction audit — independent re-run and verification

- Date: 2026-08-28. Auditor: ZCode audit agent (same agent as the
  kani-adversary companion's replacement context — NOT an independent external
  model; flagged for an external re-run when provider quota allows).
- Angle: independent RE-RUN — do the committed C5/C6 headline numbers reproduce
  from a verified pin?

## Environment identity

| Item | Value |
|---|---|
| Audited HEAD | `3c2cb429c` (dirty tree: parallel tasks; `proofs/kani/` subjects clean) |
| Pin | `pinned-rscore/` at `13f51950a483dc5b721c722259881fb089768368` (PINNED_SHA file); spot-verified `radix.rs` sha256 `31393b01e929ec6e…` and `engine/src/state/delta.rs` sha256 `e5f16de4e42d150c…` == `pinned-hashes.txt` |
| Tools | cargo-kani 0.67.0 (bundled rustc nightly-2025-11-21, CBMC 6.8.0), cargo 1.94 |
| Writes | only `proofs/audits/kani-repro/**` |

## Reproduction table

| Command | Expected (`proofs/kani/report.md`) | Actual | Verdict |
|---|---|---|---|
| `cargo kani --harness c5` | 16 successfully verified harnesses, 0 failures | **16/16 VERIFIED, 0 failures, 448/448 CBMC checks SUCCESS** | exact |
| `cargo test --release --tests` | 16 tests green (~23 s) | **8 lib + 8 equivalence = 16 passed, 0 failed, 22.56 s** | exact |
| Pin integrity | pinned bytes == recorded hashes | spot-verified 2 of 5 subject files byte-hash equal | pass |
| Corpus artifact | `corpus/delta-w16.jsonl` replays byte-identically | covered by the lib test `corpus_artifact_replays` (green) | pass |

The 8 lib tests carry the complete C6 bounded-exhaustive universe (24
permutations with asserted count, subset-order enumeration, 16×15 ordered root
pairs, round-trips, `EMPTY_RADIX_ROOT` isolation); the 8 equivalence tests
carry the C5 bridge (2M random, 500k walks, 15,987 boundary battery, W12/W20
self-consistency, 200k W256 engine cross-check, mutant calibration, corpus
replay). Symbolic C6 (`cargo kani --harness c6`) non-convergence is documented
in the report §3.2 and was not re-attempted — no claim rests on it.

## Residual gaps (reproduction angle)

1. Same-agent audit, not an independent external reviewer (program standard is
   two independent audits; the adversary side was performed externally at
   `3cbf807da`).
2. Full five-file hash check done as 2-file spot check plus PINNED_SHA record
   (the kani-adversary audit independently verified all five byte-identical).
3. The known claim-inflation corrections (W256 acceptance-only cross-check,
   2 mutants + 1 sensor, census 11/73 orders) are folded into the report body
   as of the 2026-08-28 sync wave — this audit ran against the corrected
   harness sources; the W256 out-of-range test additions remain open in
   `proofs/gaps.md`.

## Grade

**93/100.** Every runnable headline number reproduces exactly at a verified
pin (16/16 Kani, 448/448 checks, 16/16 tests, timing within 2%); the evidence
chain (pin → hashes → committed corpus) is intact. Deductions: same-agent
audit (−4); hash verification by spot-check rather than full re-derivation
(−3).
