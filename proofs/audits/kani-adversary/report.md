# C5+C6 adversary audit — validity of the Kani delta-mirror and bounded-radix proofs

Angle: attack PROOF VALIDITY. Not "did the harnesses pass" but "do the 16 Kani
verdicts, the 200k production-width cross-check, and the bounded-exhaustive C6
universe actually support the claims in `proofs/kani/report.md` and the C5/C6
rows of `proofs/readme.md`". Four attack surfaces: mirror fidelity, bridge
strength, range-scaling honesty, C6 enumeration completeness + pinning.

## Environment of this audit

| Parameter | Value |
|---|---|
| `git rev-parse HEAD` | `aa8cf33bc52499bd4559fcb9f80d1dae70c0e1a0` (72 dirty files, none in kani subjects) |
| Kani report's own pin/HEAD | `13f51950a483dc5b721c722259881fb089768368` |
| Independent pin re-extraction | `git archive 13f5195 rscore` → sha256 of all 5 subject files **matches** `pinned-hashes.txt`, the checked-out `pinned-rscore/` tree, AND the live working tree (radix.rs, persistent.rs, persistent/node.rs, persistent/records.rs, engine delta.rs byte-identical across all three) |
| Toolchain used by audit | cargo-kani 0.67.0 (matches report) |
| Re-run 1: `cargo test --release --tests` | **16/16 green** (8 lib incl. `radix::tests` vectors + 8 equivalence; 23.3s), `CARGO_TARGET_DIR=/tmp` — zero writes to the repo |
| Re-run 2: `cargo kani --harness c5` | **16 successfully verified harnesses, 0 failures** — 448/448 CBMC checks SUCCESS. Headline claim reproduced exactly. |

Bottom line up front: the core evidence is real, the pin is sound, the mirror
is faithful, and every headline reproduction passes. The defects found are
claim-inflation at the bridge edges and census arithmetic — none invalidates a
proof, but a formal-evidence report must not contain them.

## 1. Mirror fidelity (C5) — verified faithful, one modeling caveat

Field-by-field diff of `proofs/kani/src/delta_mirror.rs` against
`rscore/crates/engine/src/state/delta.rs` and `core/account/utils.ts`:

- `apply_transfer`: Left → `offdelta - amount`, Right → `+`; `signed("offdelta", next)`
  before assignment. Matches `delta.rs:153-165`. TS `deriveTransferOffdeltaChange`
  (`core/protocol/transform/delta-movement.ts:2-5`: `senderIsLeft ? -amount : amount`,
  negative throws) applied as `offdelta += change` is the same formula. Confirmed.
- `add_hold`/`release_hold`: compute-then-`unsigned(field, next, uint_max)` then assign.
  Matches `delta.rs:167-193` exactly, including field names `leftHold`/`rightHold`.
- `apply_j_settlement`: `unsigned("collateral")` + `signed("ondelta")` then assign.
  Matches `delta.rs:195-205`.
- `validate`: identical field ORDER (collateral, ondelta, offdelta, L/R credit,
  L/R allowance, L/R hold) and identical bound SHAPES (`value < -B || value >= B`
  signed half-open; `value < 0 || value > max` unsigned). Matches `delta.rs:268-286`.
- `left_perspective`: all 21 fields match `utils.ts:26-61` line-for-line, including
  the TS-only `effectiveOwnCreditWindow`/`effectivePeerCreditWindow`/`totalCapacity`
  and the TS collateral clamp `nonNegative(delta.collateral)` (Rust uses raw
  collateral, identical on the validated domain since `Delta::new` rejects negative
  collateral — mirror documents this). `total.min(collateral)` ≡ TS ternary. Confirmed.
- `flip_perspective`: exactly the 16 directional swaps of `flipDeltaPerspective`
  (`utils.ts:63-80`); the 5 invariant fields (2 windows, totalCapacity, delta,
  collateral) stay fixed, matching the TS destructuring at `utils.ts:140-141`.
  Confirmed. Rust `Delta::perspective` (`delta.rs:207-219`) constructs the 4-field
  right view by the same swaps — consistent.
- Scale mapping is exact, not approximate: `i16`/`u16` are 16-bit-exact, `u8` is
  8-bit-exact for payments, and `MAX_CREDIT_LIMIT = 255_000 > UINT_MAX = 65535`
  preserves the production relation `max_credit_limit > uint_max(256)`.

**No dropped branch found in any modeled function.** The 16 verdicts are
verdicts about a faithful bounded model (see G7 for what the model omits).

## 2. Findings

Severity scale: HIGH = invalidates a documented claim; MED = claim materially
overstated / parity fact wrong; LOW = numeric or wording defect in evidence.

### A1 — The 200k production-width cross-check never exercises a rejection (MED)

`engine_cross_check_w256_random` (`tests/equivalence.rs:1089-1183`) generates
ONLY in-range values: `gen_big_in_range` returns `raw % (max+1)`;
`gen_big_signed` returns `raw % 2^256 - 2^255 ∈ [-2^255, 2^255)`; every
`big_boundary_biased` candidate (0,1,2,max-2,max-1,max; credit max-1000/max-1001)
is in-range. Therefore `Delta::new` always returns `Ok`, and the
`(Err(DeltaFieldOutOfRange), Err(field))` arm comparing rejection field names
(`tests/equivalence.rs:1168-1173`) is **dead code**. The report's evidence row
"200,000 deltas … vs the real `xln-rscore-engine` `Delta::new` (acceptance +
rejection field names)" (`report.md` §2.2) overclaims: rejections are compared
at W16 against the transcription only; the real engine's 256-bit rejection
behavior is never tested. Also dead: `report.md` §2.2's "both sides, 4 fields"
is accurate, but note the exact signed boundaries −2^255 / 2^255−1 are never
sampled at W256 (uniform-only signed generator; boundary bias applies only to
unsigned/credit fields). Fix: add out-of-range operands (max+1, −bound−1,
exactly ±bound) to `big_boundary_biased`/`gen_big_signed` candidates.

### A2 — Mutant calibration is 2 mutants + 1 coverage sensor, not "3 seeded mutants" (MED)

`mutant_detection_calibrates_harness` (`tests/equivalence.rs:926-982`)
implements exactly two mutants: transfer-sign flip (`apply_transfer(.., true)`)
and dropped `- rightHold` in inCapacity (`left_perspective(true)`). The third
item is a SENSOR (`right_credit_limit >= max_credit - 2` reached), not a mutant:
no credit-bound off-by-one implementation is ever run, so the harness never
demonstrates it would DETECT one. Report §2.2 row says "3 seeded mutants must
be detected … PASS" and readme C5 says "3-мутантная калибровка". The evidence
line itself quietly says "credit-bound edge reached" — not "detected".
Additionally, both real mutants are seeded in the transcription side only; no
mirror-side mutant calibration exists (a mirror bug is caught only insofar as
mirror≠transcription comparisons cover it, which the W16 battery does cover,
but that is not demonstrated by calibration).

### A3 — The addHold divergence claim is one-sided; "Rust (stricter)" is false for negative operands (MED)

Report §2.4.3 documents that TS `addHold` lacks Rust's unsigned upper bound
(true: `core/account/tx/hold-utils.ts:9-21` checks only `amount < 0n`, while
`delta.rs:167-179` enforces `≤ uint_max(256)` on the updated hold — line
numbers in the report are accurate). But the divergence is bidirectional and
the report's conclusion "Mirror/proofs follow the Rust (stricter) semantics" is
wrong in the other direction: Rust `add_hold`/`release_hold` ACCEPT negative
operands whenever the result stays in `[0, uint_max]` (e.g. hold=5, amount=−3 →
next=2, Ok), while TS `addHold`/`releaseHold` reject ANY negative amount
(`HOLD_ADD_NEGATIVE` / `HOLD_RELEASE_NEGATIVE`, `hold-utils.ts:10-12, 25-31`).
The mirror inherits the Rust acceptance (`delta_mirror.rs:168-179`), and no Kani
harness generates negative hold operands (`u8`/`u16` generators), so this region
is neither proven nor TS-equivalent. Same theoretical-reachability class as the
flagged one (hold amounts are payment-scale positive in practice), but the
parity-divergence register is incomplete and the "stricter" framing is false.

### A4 — Census count is off by one: 11 make_branch call sites, not 12 (LOW)

Full grep of the pinned protocol crate: `make_branch` is defined at
`persistent/node.rs:62` and called at exactly 11 sites — node.rs:91, 181, 199,
239, 291 and persistent.rs:862, 959, 963, 1058, 1551, 1599. Report §3.3 says
"All 12 `make_branch` call sites". The census CONCLUSION survives — I verified
every site (see §3 below) — but the arithmetic is wrong in a document whose
entire value is precision.

### A5 — C6 subset-order enumeration count is wrong: 73 sequences, not 60 (LOW)

`subset_any_order_matches_canonical_root` enumerates all (i0,i1,i2) ∈ [0,5)³
with no repeated key: exactly **73** sequences over 15 masks (1 empty +
4 singletons ×3 skip placements + 6 pairs ×6 + 4 triples ×6). Report §3.1 and
readme C6 claim "60/60 canonical subset orders" / "all 60 ordered sequences".
The enumeration IS complete for the stated property ("every subset ≤ 3 leaves,
every order" — pairs hit both orders, triples all 6, full set covered by the
separate 24-permutation test, which does assert `count == 24`); the number 60
appears to be derived from nothing in the code. The 16×15 ordered pairs and
16×4 round-trip counts are correct.

### A6 — zero-child make_branch unreachability at persistent.rs:862/963/1058 rests on a callback contract (LOW)

`updated_batch`/`updated_batch_two_levels` pass a caller-supplied `map_slots`
closure; the "≥1 child" argument (entries non-empty → some slot returns
`Some(child)`) assumes the callback honors its contract, which no type enforces.
A contract-violating callback would produce a zero-child root Branch whose hash
aliases `EMPTY_RADIX_ROOT` with `len > 0`. The census words this as "always
retains ≥1 child" without flagging the assumption. Internal callers are
contract-abiding, so the reviewed fact stands for the engine as shipped.

### A7 — Minor wording overclaims in the equivalence table (LOW)

- "per delta: … both perspectives (all 21 fields)": actually left perspective
  (21 fields) always + ONE randomly chosen side per iteration
  (`tests/equivalence.rs:608-614`); right-view coverage is statistical (~1M of
  2M iterations), not per-delta. Effectively harmless; imprecisely stated.
- W256 cross-check compares only the 4 Rust `DeltaPerspective` fields; the 17
  TS-only fields have no production-width machine check against either engine
  (admitted inside report §2.2's bridge paragraph, not surfaced in the table
  or the readme C5 row).

## 3. Census spot-checks (3+3 sites, all pass)

`hash_branch16([]) → EMPTY_RADIX_ROOT` unreachability, per the report's own
census; I verified six sites against the pinned sources:

1. `persistent/node.rs:91` (`ensure_root_branch`): wraps a lone non-root node in
   `make_branch(Vec::new(), &[node])` — exactly 1 child. Confirmed.
2. `persistent.rs:1551`: explicitly guarded — `if root_children.is_empty() {
   Ok(None) } else { make_branch(...) }`. Confirmed ≥1.
3. `radix.rs:213` (builder): branch nodes are built only for groups with
   `len() ≥ 2` (singletons become leaves, `radix.rs:176-186`), bucketed at
   `branch_offset = offset + shared` where `shared` is the maximal group common
   prefix → ≥2 distinct nibbles → ≥2 buckets → ≥2 child hashes. Confirmed.
4. `persistent/node.rs:142` (`node_hash` of Branch): children array is populated
   only by `make_branch` (1:1, slot-collision-rejecting — verified at
   `node.rs:62-82`), so child_hashes ≥1. Confirmed.
5. `persistent/node.rs:199` (put against Branch): `next` = children.clone() with
   one slot set to the recursive put result, which is always `Some` on this
   path → ≥1 child. Confirmed.
6. `persistent.rs:1460` (`make_commitment_branch`): callers are
   `compressed_commitment_parent` (0→None, 1→single, _→branch ≥2) and
   `top_root_hash` (explicit `is_empty → EMPTY_RADIX_ROOT` guard). Confirmed.

`make_branch` mechanics claim ("fills children 1:1 from nodes, rejecting slot
collisions, so a Branch always has ≥1 child") — verified against
`node.rs:62-82`. `hash_branch16` sorts by slot (canonical order, the basis of
permutation independence) and returns `EMPTY_RADIX_ROOT` only for the empty
list (`radix.rs:119-127`). `EMPTY_RADIX_ROOT = [0;32]` — no SHA-256 output can
equal it, so the aliasing concern is exactly the zero-child branch case.

## 4. C6 enumeration completeness + REAL-SHA check

- 24 permutations: nested distinct loops + `assert_eq!(count, 24)` — real.
- Subset orders: complete for ≤3-leaf subsets in every order (73 sequences;
  count misreported, see A5).
- 16×15 ordered mask pairs → pairwise-distinct real roots; empty mask root ==
  `EMPTY_RADIX_ROOT`. Real.
- 16 subsets × 4 keys round-trips with the honest absent/present-key split.
- REAL SHA-256 confirmed: the crate compiles the pinned `radix.rs` via `#[path]`
  (`src/lib.rs:23-30`) with `sha2 = 0.10.9` from Cargo.lock (no `asm` feature —
  functionally identical pure-Rust backend; honestly disclosed in report §0).
  Digest assignment `digest_of` is injective on the universe. No stub, no fake
  hash anywhere in the proof crate.
- Pinning: `#[path]` targets resolve inside `pinned-rscore/`, whose five subject
  files are byte-identical to (a) `pinned-hashes.txt`, (b) a fresh
  `git archive 13f5195` extraction I performed, and (c) the live tree. The
  `crate::persistent_node` shim wiring mirrors the upstream `lib.rs`
  `#[path = "persistent/node.rs"]` declarations exactly. Provenance is solid.
- Symbolic C6 non-convergence (§3.2 of the report) is honestly documented with
  five attempted configurations; the harnesses remain sound in-tree. The C6
  claim in readme is correctly qualified as "bounded exhaustive", not "proved".

## 5. Range-scaling honesty (16/8 mirror vs 256/128 production)

Argued concretely: every proven property is an equation/inequality over total
width-homogeneous operations (field permutation for flip; `max(0,·)` clamps for
non-negativity; linear identities for conservation in the interior; the
`v < -B || v >= B` / `v < 0 || v > max` rejection shapes). None depends on
two's-complement wraparound or on the specific bound magnitudes. The mirror's
i128 intermediates are bounded by `MAX_CREDIT_LIMIT·4 < 2^20` (no host overflow,
Kani overflow checks left on), and production runs in BigInt (no overflow), so
there is no differential-overflow artifact between widths. The one
width-coupled risk — rejection-boundary behavior — is tested at three widths
(16/8 mirror vs transcription; 12/6 and 20/10 transcription self-consistency
with exact boundary rejections), but at 256/128 only on the acceptance side
(A1). The report's wording ("claims within the bounded mirror", bridge by
testing) is honest; my conclusion is that no small-width-only artifact exists
for the specific 16 proven properties, and the residual risk is concentrated
in the untested 256-bit rejection edges, not in the algebra.

## 6. Gap list (0 = fully closed; 100 = nothing done)

| # | Dimension | Score | Basis |
|---|---|---|---|
| 1 | Mirror fidelity to `delta.rs` handlers | 5/100 | field/branch-exact on all modeled functions (§1); only omissions are out-of-scope surfaces (G7) |
| 2 | Mirror fidelity to TS `deriveDelta` | 10/100 | 21 fields + flip exact; negative-hold operand region diverges undocumented (A3) |
| 3 | W16 mirror↔transcription equivalence | 5/100 | 2M + 500k walks + 15,987 boundary battery (count independently re-derived: 3·73² = 15,987 exact) + committed corpus |
| 4 | Cross-width transcription self-consistency | 10/100 | W12/W20 with exact boundary rejections |
| 5 | W256 transcription↔real-engine equivalence | 35/100 | acceptance + 4 perspective fields on 200k inputs; rejection branch dead (A1), signed exact boundaries unsampled |
| 6 | Mutant calibration | 40/100 | 2 real mutants demonstrated; third claimed mutant does not exist (A2) |
| 7 | Kani C5 proofs proper | 5/100 | 16/16 reproduced by this audit (448/448 checks); assumptions limited to stated preconditions; no vacuous assumes found |
| 8 | C6 exhaustive enumeration | 8/100 | complete for the universe; REAL SHA-256; two count misreports (A4, A5) |
| 9 | C6 symbolic (Kani) | 85/100 | does not converge; honestly documented; harnesses sound and retained |
| 10 | `hash_branch16([])` census | 15/100 | 6/6 spot-checked sites verified; count 12 vs 11 (A4); callback-contract caveat unstated (A6) |
| 11 | Pinning/provenance | 2/100 | independently re-extracted and verified byte-identical; report records HEAD + dirty count |
| 12 | Claim discipline (readme rule 2) | 30/100 | A1/A2/A5 overclaims inside an otherwise disciplined report |
| **Aggregate (weighted toward proof cores)** | | **14/100** | |

## 7. Verdict

- C5 **82/100**. The Kani proofs are real, reproducible, and about a faithful
  mirror; the randomized/boundary bridge at W16 is strong; the honest findings
  section (clamp leakage) is a genuine correctness contribution. Deductions:
  dead rejection branch in the only real-engine link (A1), mutant-count
  inflation (A2), one-sided TS-divergence register with a false "stricter"
  conclusion (A3), review-only TS bridge for 17/21 fields.
- C6 **85/100**. Real pinned code, real SHA-256, complete (if small) universe
  enumeration, sound and honestly-documented symbolic fallback. Deductions:
  census off-by-one (A4), fabricated-feeling "60" order count (A5), callback
  caveat (A6); inherent 4-key/2-byte boundedness is disclosed, not penalized.
- **Single grade: 83/100** (C5+C6 combined). No fabricated or stubbed evidence;
  no proof invalidating defect; multiple evidence-text defects that must be
  corrected before the C5/C6 rows are cited as final ("✅ доказано" should
  carry the A1/A2/A3/A5 qualifiers until fixed).

Required corrections (owner triage): A1 (add W256 out-of-range cases or reword
the row), A2 (implement the third mutant or reword to "2 mutants + boundary
sensor"), A3 (correct "stricter" and register the negative-operand divergence),
A4/A5 (fix both counts), A6 (state the callback assumption). All are
report/test-file edits inside `proofs/kani/**` — no production code involved.
