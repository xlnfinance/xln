# C1 adversary audit — validity of the differential-encoder fuzz proof

Auditor angle: attack proof validity (schema fidelity, coverage claims, reject-parity
semantics, shrinker calibration, branch stress, boundary-findings reasoning).
Audited artifacts: `proofs/readme.md` (C1 row), `proofs/fuzz/enc-diff/{report.md,
generate.ts, run.ts, enc-diff-rust/, corpus/, corpus-full/}`.

Audit environment: HEAD `b95e7ee3b6345a296535aeb6a5d375efc1a27c88`, 439 dirty files
(report pinned `80924b035f…` + 243 dirty). bun 1.3.14, cargo 1.94.1. Read-only on
production code and wave-1 artifacts; probes were written only to `/tmp`.

## Reproduction performed (not just read)

| Action | Result |
|---|---|
| `bun run.ts` (committed 200-case corpus, prebuilt binary) | green, exit 0 |
| `bun run.ts --corpus corpus-full` (10,114, prebuilt binary) | green; tallies match report exactly (9,353 / 751 / 7 / 3; byKind 4,444/2,634/1,006/552/494/500/484) |
| regenerate `--count 86 --seed 20260826` → diff vs committed `corpus/` | byte-identical (determinism claim verified) |
| numbers-only 50,000 @ seed 424242 → run | 50,114 cases, 0 failures; both-encode 50,093 (explains the report's "50,093": 50,000 random + 11 canonical number seeds, not 50,000 random) |
| `cargo build --release` (fresh) + rerun corpus-full | **1 failure**: `seed-tx-policy-unsafe-version` (see F1) |
| hand probes in `/tmp` (tokenId 70000; bign hex text) | see F2; malformed bign correctly flagged |

## Findings

### F1 — MED: evidence chain stale; committed corpus is RED on a fresh build
- `proofs/fuzz/enc-diff/corpus/seed-tx-policy-unsafe-version.json` is labeled class
  `rust-rejects`. The uncommitted FX-1/D2 fix (TS now rejects policyVersion > 2^53−1,
  `core/account/tx/admission-policy.ts:38`, wired via `core/account/consensus/frame/hash.ts`,
  +13 uncommitted lines) makes TS reject too. Fresh `cargo build` + run:
  `FAIL … TS_ERROR:ACCOUNT_TX_POLICY_VERSION_OUT_OF_RANGE…` → exit 1.
- The Rust side was also reworked after the report (`rscore/crates/engine/src/consensus/frame/hash.rs`,
  140 uncommitted lines; binary mtime 01:25 < source mtime 01:34 of the report date).
  The prebuilt binary the green tallies came from predates current sources.
- Impact: "80,656 cases, 0 divergences" is not reproducible at HEAD by following the
  report's own commands. Mitigating: after rebuild 10,113/10,114 still pass — parity
  survived the change; only the seed's class label is stale. Per `proofs/readme.md`
  rule 4 the regression case should have been relabeled when the fix landed.

### F2 — MED: asymmetry inventory incomplete — the TS-accepts/Rust-rejects family is probed at exactly one point
- The report discloses policyVersion > 2^53−1 but not its siblings, all excluded by
  generator construction rather than verified:
  - `tokenId > 65535` on TokenId-typed fields (direct_payment/set_credit_limit/htlc_lock/
    j_event events): generator uses `u16` only (`generate.ts:220`); Rust `TokenId::new`
    rejects (`rscore/crates/engine/src/state/delta.rs:17-19`). Live probe: TS encodes
    bytes, Rust → `TX_FIELD_INVALID:tokenId:ACCOUNT_DELTA_FIELD_OUT_OF_RANGE:tokenId:70000`.
    TS contains it at payment admission (`core/entity/htlc/payment-admission.ts:53`), so
    blast radius ≈ policyVersion — but it is not in the report's asymmetry list.
  - Same family, never generated: `timeInForce > 255` (u8), `revealBeforeHeight`/`jHeight`
    > 2^53−1 (`number()` → UnsafeInteger), hashlock/EntityId/base64-envelope format
    validation (`HtlcHashlock::parse`, `EntityId::parse`, `OpaqueHtlcCiphertext::parse`).
- The report states the fuzz domain is "fields in valid-for-Rust domains" — i.e., the
  intersection domain is reached by *not generating* Rust-invalid values. Only one member
  of the whole validation-asymmetry class is evidenced.

### F3 — MED: "both-reject parity" for duplicates is driver-fabricated; the TS production encoder never rejects duplicates
- TS production `encodeAccountStateValue` Map/Set paths sort by encoded bytes and have
  **no duplicate check** (`core/account/commitment/account-state-value.ts:191-199, 201-203`;
  oracle path `:140-156` likewise). Rust rejects (`rscore/crates/protocol/src/value.rs:144-147, 161-163`).
- The harness substitutes a driver-level check (`run.ts:82-117 assertNoDuplicates`) for
  the nonexistent TS boundary. That is defensible for scalar keys (JS Map/Set SameValueZero
  collapses them, so production TS genuinely cannot receive duplicates), but it is
  **wrong for reference keys**: two structurally-equal-but-distinct arrays/objects survive
  in a runtime `Map`/`Set`, and production TS would then happily emit two identical encoded
  keys (accept-with-duplication) where Rust rejects. The wire schema *can* express this
  (two identical `wArr`/`wObj` map keys — `seed-dup-map-key-nested` is exactly this shape),
  and the driver intercepts it before production code runs, converting a real
  accept-vs-reject asymmetry into a "both-reject" pass.
- Also incoherent corner (not generated): `[['a',undef],['a',undef]]` — driver rejects
  (dup check before undef-drop) while Rust drops `undef` first and accepts; TS production
  accepts. Driver and Rust normalize in different orders.
- Production reachability today is low (account maps keyed by scalars), but the readme
  property "дубли ключей map/set/object — обе стороны обязаны отказаться" is verified
  against a test driver, not against the TS encoder, and is factually false for
  reference-typed keys on the TS side.

### F4 — LOW/MED: shrinker is functionally broken for content-dependent divergences; the sabotage calibration passed by accident
- `run.ts:313` `clone` preserves the case `id`; `shrinKCheck` writes every candidate to
  the same `${id}.json` (`run.ts:382`) — one file survives per batch, so only the
  **last-written** candidate is ever tested, and its single result is attributed to all
  candidates (`candidates.find` at `run.ts:404` then selects the **first** candidate,
  unverified; additionally `find` scans past the `slice(0, 96)` batch that was run).
- The calibration sabotage corrupted by *filename* (`seed-map-mixed-keys`), so every
  candidate "reproduced" regardless of content — the shrink marched through
  drop-first-element candidates to `{t:'map',v:[]}` without ever testing the candidate
  it followed. For a real divergence that reproduces only on some candidates, the shrink
  stops at round 0 (if the last candidate happens not to reproduce) or chases an
  untested candidate. Detection cannot be masked (failures always reported, exit 1), but
  the "авто-минимизирует" capability is uncalibrated for the realistic failure mode.
- Single sabotage mode (hex corruption) only; class-inversion and content-keyed
  divergence modes were never calibrated.

### F5 — LOW: flat-root duplicate-path parity relies on unspecified Rust sort behavior
- TS sorts leaves with stable `Array.prototype.sort` (`core/account/commitment/state-root.ts:151`);
  Rust uses `sort_unstable_by_key` on the digest (`rscore/crates/protocol/src/flat.rs:32`).
  Duplicate paths ⇒ equal sort keys ⇒ the relative order of their value pairs is
  **unspecified in Rust**, and the digest interleaves key‖value pairs, so order changes
  the root. Within the model (≤6 entries) current rustc uses insertion sort for small
  slices, so parity holds de facto, not de jure; at ≥21 entries with duplicate paths
  pdqsort may legitimately reorder.
- The corpus *includes* duplicate paths as `both-encode` (`seed-flat-duplicate-path`;
  `randomFlatCase` can emit duplicate `'identity'` paths), i.e., the model asserts
  byte-parity on inputs whose cross-engine output is implementation-defined. Production
  callers pass unique paths today (fixed 5/6 sections; shadow root keyed by Map keys).

### F6 — LOW: ts-only tx coverage is 3 of 14 TS-only kinds
- Corpus ts-only seeds: `lending_fund`, `reserve_to_collateral` (Rust variant exists,
  `canonical_tx_value` → `UnsupportedFrameTx` at `hash.rs:380-382` — production rejection
  exercised), `request_collateral` (driver-level `TX_KIND_NOT_MODELED_IN_RUST`,
  `main.rs:392` — driver rejection only). The TS `AccountTx` union
  (`core/types/account.ts:760+`) has 24 kinds; the remaining 11 TS-only kinds
  (cross_pull_lock/close/progress, cross_swap_fill_ack, lending_borrow/close_*/credit/repay,
  rebalance_refund, settle_transition) are never constructed. Their treatment is
  structurally identical and D3 excludes them from the RRS profile, but the evidence
  covers 3/14 and the report's "и прочие" hides the count.

### F7 — LOW: small generator blind spots
- `j_event_claim` events always ≥1 (`generate.ts:304` `1 + rng.int(3)`) — empty-events
  edge (eventsHash over `[]`) never generated.
- Unknown/extra tx fields never generated: Rust driver silently ignores unknown JSON
  fields (`to_tx` reads only known names) while TS `structuredClone` passes them through
  — would surface as BYTES_DIFFER if generated, so no false parity, but the class is
  untested. Same for several driver coercions (`as_u64().unwrap_or_default()` at
  `main.rs:104`, `to_jurisdiction_event` metadata, `bit`) — divergence-revealing, not
  divergence-hiding, yet they bypass production Rust validation for malformed wire.
- `__proto__` as object key never generated (benign: `Object.fromEntries` defines an own
  property; encoder would treat it as a plain key on both sides — reasoning only, untested).

### F8 — INFO: verified sound (positives worth recording)
- Number funnel is sound: Rust `CanonicalNumber` retains the wire text after ryu
  round-trip validation (`value.rs:34-46`); TS funnels `Number(text)→String()`; both
  parsers correctly rounded ⇒ acceptance ⟺ text = canonical rendering ⇒ byte equality
  on the both-encode path proves text ≡ `String(double)`. ryu-vs-JSC differential
  independently reproduced (50,114 cases, 0 failures) incl. `5e-324`, `±1.797…e+308`,
  `1e+21`/`1e-7` thresholds.
- Ordering traps genuinely exercised: `compareStableText` = JS `<` (UTF-16 code units,
  `core/protocol/serialization/index.ts:117`) ↔ `cmp_utf16` (`value.rs:120-122`);
  737 corpus-full random files contain flip/non-BMP key material beyond the 4 seeds.
  Map/Set order derived from each side's own encoded bytes — self-checking.
- `hash_extension16` ↔ EdgeHash dummy-slot trick is faithful: `run.ts:190` slices off
  exactly the dummy slot (`radix-merkle.ts:282-295`), preimage = domain ‖ radix ‖
  packed path ‖ child (`radix.rs:139-147`) — identical on both sides; empty-path
  divergence honestly documented as out-of-model.
- Free internal invariants are real: TS fast-vs-oracle (`run.ts:157-161`), Rust
  streaming-vs-allocating (`main.rs:67-72`, mismatch ⇒ RUST_ERROR failure).
- Lone-surrogate exclusion is a genuine domain boundary, correctly modeled.
- Committed corpus is deterministic (regeneration byte-identical) and all report tallies
  reproduce exactly against the pinned binary.
- Boundary-findings reasoning (Q6): sound. The report does *not* claim non-exploitability
  for policyVersion — it flags the consensus risk (Rust cannot reproduce a TS frame-hash)
  and escalates; D2/FX-1 then aligned both engines. Same reasoning shape applies to the
  F2 siblings, which is precisely why they belong in the inventory. TS-only kinds
  reasoning (out-of-RRS-profile, loud admission reject both directions per D3) is sound.

## 100/100 gap list — what a skeptical external expert would still demand

1. **Re-pin the evidence**: relabel `seed-tx-policy-unsafe-version` (rust-rejects →
   both-reject), rebuild, rerun all four corpora at a new immutable SHA, and record the
   binary's sha256 + toolchain fingerprints. Today the report's own commands fail (F1).
2. **Repair + recalibrate the shrinker**: unique candidate ids (or per-candidate files),
   `find` restricted to the tested slice; calibrate with ≥3 sabotage modes —
   content-keyed hex corruption, class inversion (Rust accepts where label says reject),
   and a content-dependent divergence (only one field triggers) with demonstrated
   minimization to that field. Current calibration is provably blind to F4 (F3/F4).
3. **Close the duplicate-parity semantics gap**: either (a) add duplicate detection to
   the TS production encoder (map/set path) so "обе стороны обязаны отказаться" becomes
   a production-vs-production fact, or (b) restate the property as "Rust rejects; TS
   driver stands in for a receiving boundary that TS does not have" and document the
   reference-key accept-with-duplication asymmetry (F3).
4. **Enumerate the validation-asymmetry family**: deliberate rust-rejects seeds for
   tokenId>65535, timeInForce>255, revealBeforeHeight/jHeight>2^53, malformed hashlock/
   EntityId/envelope — plus admission-containment evidence per field on the TS side (F2).
5. **Flat duplicate paths**: exclude from the model with loud both-reject, or make the
   order contractual (stable tiebreak on both sides) and add a ≥21-entry duplicate-path
   probe; document that current parity depends on rustc's small-slice insertion sort (F5).
6. **Enumerate TS-only kinds**: minimal ts-only seeds for all 14 (or state 3/14 in the
   claim), including at least one cross_pull_* and settle_transition (F6).
7. **Edge seeds**: j_event_claim with zero events; tx data with an unknown extra field;
   object key `__proto__`; two identical `wObj` map keys run *without* the driver
   interceptor to document true TS production behavior (F7).
8. **Coverage ledger**: publish per-pair case counts that stress each branch family
   (optional-field matrices per tx kind, radix shared-prefix depth distribution), not
   just per-kind totals, so "reaches the sharp edges" is auditable from artifacts.

## Grade: 74/100

The engineering core is genuinely strong: single-source deterministic committed corpus,
exact reproducible tallies, real ryu differential, ordering traps (UTF-16 flips, RLP
boundaries, −0/1e21, [0]-magnitude) actually present and exercised, honest disclosure of
the two boundary findings, and correct escalation — the differential method itself has no
schema-level normalization hole on the both-encode path. But validity-as-a-proof takes
three real hits: the evidence chain is stale and currently red on a fresh build (F1);
the claimed both-reject parity for duplicates is enforced by a test driver standing in
for a TS production check that does not exist, and misclassifies the reference-key
accept-with-duplication case (F3); and the asymmetry inventory — central to the "no
divergence on the common domain" claim — is probed at one member of a whole family of
TS-accepts/Rust-rejects boundaries excluded by generator construction (F2), with the
shrinker (F4) and flat duplicate-path order (F5) further weakening confidence in the
claimed tooling and model edges. None of these invalidate parity on the actually
generated intersection domain, which reproduces cleanly — hence mid-B, not lower.
