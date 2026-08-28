# C1: TypeScript/Rust canonical-encoding differential fuzzing

## Claim and scope

Within the validated generated domain below, the TypeScript and Rust canonical
encoders produce identical bytes or both reject the input. This is bounded
evidence, not a claim about values or decoders outside the corpus model.

An explicit `known-divergence` calibration proves why the word “validated” is
necessary: direct TS hashing preserves an unknown transaction field while the
typed Rust projection drops it. The production TS boundary rejects that shape
with `requireExactBoundaryKeys` before consensus; `run.test.ts` pins the reject.
The harness must keep this case visible and must not count it as parity evidence.

Pinned run: `80924b035f363d4ad8f4a8c08e6f39dcc7736a78`, Bun 1.3.14,
Rust/Cargo 1.94.1, `ryu-js` 1.0.3.

Post-FX-1 audit (2026-08-28): the committed corpus vector had been changed to
`both-reject`, but `generate.ts` still regenerated `tx-policy-unsafe-version`
as `rust-rejects`. A clean run at
`78e07d9a92b5a022cb55a9a32519f10341148d0e` therefore failed 1/10,114. The
generator classification is now corrected in `935020a41`. The full
80,656-case suite passes without overlay on clean immutable
`b7e3ace82b1c296dff0f646d3bebb120a90a0637` (fresh Rust release build: 9.84s;
all five corpus runs: 0 failures). This is coordinator reproduction evidence;
an independent repro audit on the post-FX bytes is still required.

## Harness

- `generate.ts` is the deterministic corpus source. It generates tagged
  canonical values, Account transactions, flat roots, and radix-16 nodes.
- `enc-diff-rust/` links the production Rust protocol and engine crates and
  emits one `{file, hex|error}` result per case.
- `run.ts` executes both implementations, records class/kind/outcome/tx-kind
  coverage, compares exact bytes, and minimizes any unexpected disagreement.
- `corpus/` contains 210 committed cases: 124 sharp seeds plus 86 deterministic
  generated cases. One seed is an explicit boundary-rejected known divergence,
  not parity evidence. Larger corpora are reproducible from an explicit seed
  and case count.

## Reproduction

```bash
bun proofs/fuzz/enc-diff/generate.ts --count 10000 --seed 20260826 --out proofs/fuzz/enc-diff/corpus-full
cd proofs/fuzz/enc-diff/enc-diff-rust && cargo build --release && cd -
bun proofs/fuzz/enc-diff/run.ts --corpus proofs/fuzz/enc-diff/corpus-full
bun proofs/fuzz/enc-diff/generate.ts --numbers-only --count 50000 --seed 424242 --out /tmp/corpus-numbers
bun proofs/fuzz/enc-diff/run.ts --corpus /tmp/corpus-numbers
```

Two additional 10,000-case runs used seeds `777` and `31337`.

## Results

The original pinned runs covered **80,656 cases with zero unexpected
differences**. After FX-1 and the generator correction, a clean independent
rerun again covered **80,656 cases with zero failures**. Its primary
10,114-case run contained:

| Class | Cases | Result |
|---|---:|---|
| both encode | 9,353 | exact bytes and radix counters match |
| both reject | 752 | both implementations reject |
| documented Rust rejection | 6 | known domain boundary |
| documented TS-only kind | 3 | intentionally outside the Rust frame domain |

The separate number run checked 50,093 finite binary64 values and found
`String(n)` in JavaScriptCore byte-equivalent to Rust `ryu_js` formatting.

The hardened 210-case corpus adds validation boundaries and emits an exact
coverage ledger. Its immutable SHA and clean-extraction result are recorded in
the post-hardening note below once the proof-only commit exists; it does not
retroactively change the 80,656-case result above.

Covered production pairs:

1. `encodeAccountStateValue` / `encode_account_state_value`, including encoded
   map/set ordering and UTF-16 object-key ordering.
2. `computeFlatIntegrityRoot` / `compute_flat_integrity_root`.
3. Radix-16 leaf, branch, extension, and full-tree construction.
4. Canonical Account transaction values for the ten native transaction kinds,
   including all optional HTLC and swap fields and J-event claims.

The harness also checks the TypeScript fast writer against its oracle and the
Rust streaming writer against the allocating encoder on every value case.

## Required edge cases

- JavaScript safe-integer limits, `-0`, exponent-rendering thresholds, minimum
  subnormal, and maximum finite binary64.
- Empty and nested containers, duplicate map/set/object entries, 55/56-byte
  RLP boundaries, non-BMP UTF-16 ordering, and omitted `undefined` properties.
- Empty/full-fanout radix trees, common prefixes, duplicate and mixed-width
  keys, invalid extension slots, and 32-byte leaf digests.
- Every native Account transaction with optional fields both present and
  absent.

## Documented boundaries

- Rust rejects noncanonical numeric text; TypeScript never emits it.
- `rebalance_policy.policyVersion > 2^53-1` is now a symmetric protocol-boundary
  rejection in both implementations (FX-1/D2), not a Rust-only corpus class.
- Lending and `reserve_to_collateral` frame forms are not native Rust frame
  kinds in this corpus.
- Rust radix leaf values are typed as 32-byte digests, while the lower-level TS
  helper can accept arbitrary bytes; production uses 32-byte digests.
- Decoder canonicality and parser robustness belong to C7, not this harness.

The original filename-keyed minimizer calibration was invalid. The current
calibrator uses unique candidate IDs, preserves the original failure signature,
and checks three content-dependent modes: byte corruption, class inversion and
single-field divergence. There are no live unexpected minimized failures in
the committed corpus.
