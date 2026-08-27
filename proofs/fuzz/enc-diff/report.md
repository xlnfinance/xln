# C1: TypeScript/Rust canonical-encoding differential fuzzing

## Claim and scope

Within the generated domain below, the TypeScript and Rust canonical encoders
produce identical bytes or both reject the input. This is bounded evidence,
not a claim about values or decoders outside the corpus model.

Pinned run: `80924b035f363d4ad8f4a8c08e6f39dcc7736a78`, Bun 1.3.14,
Rust/Cargo 1.94.1, `ryu-js` 1.0.3.

## Harness

- `generate.ts` is the deterministic corpus source. It generates tagged
  canonical values, Account transactions, flat roots, and radix-16 nodes.
- `enc-diff-rust/` links the production Rust protocol and engine crates and
  emits one `{file, hex|error}` result per case.
- `run.ts` executes both implementations, classifies the result, compares
  exact bytes, and minimizes any disagreement.
- `corpus/` contains 200 committed seeds. Larger corpora are reproducible from
  an explicit seed and case count.

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

The combined runs covered **80,656 cases with zero unexpected differences**.
The primary 10,114-case run contained:

| Class | Cases | Result |
|---|---:|---|
| both encode | 9,353 | exact bytes and radix counters match |
| both reject | 751 | both implementations reject |
| documented Rust rejection | 7 | known domain boundary |
| documented TS-only kind | 3 | intentionally outside the Rust frame domain |

The separate number run checked 50,093 finite binary64 values and found
`String(n)` in JavaScriptCore byte-equivalent to Rust `ryu_js` formatting.

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
- `rebalance_policy.policyVersion > 2^53-1` remains outside the shared domain.
  The TS admission policy must reject it before Rust-authoritative cutover.
- Lending and `reserve_to_collateral` frame forms are not native Rust frame
  kinds in this corpus.
- Rust radix leaf values are typed as 32-byte digests, while the lower-level TS
  helper can accept arbitrary bytes; production uses 32-byte digests.
- Decoder canonicality and parser robustness belong to C7, not this harness.

The minimizer was calibrated by corrupting one Rust result. It reported a byte
difference and reduced it to an empty map in one run. There are no live
minimized failures in the committed corpus.
