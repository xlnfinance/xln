# C7 adversary audit — validity angle (decoder-surface completeness, property strength)

- Audited artifact: `proofs/fuzz/parser/report.md` + 7 targets under `proofs/fuzz/parser/fuzz/`
- Audit `git rev-parse HEAD`: `b95e7ee3b6345a296535aeb6a5d375efc1a27c88`, `git status --porcelain | wc -l` = 420
  (C7 report itself records run at `dfd45cc7…` on pinned rscore of `80924b035…` — pinned-extraction
  discipline verified: `pin-rscore.sh` swaps `fuzz/Cargo.toml` paths to `.rscore-pinned/`)
- Method: read-only analysis of rscore decoder surface vs the 7 targets; two spot runs
  (prebuilt binaries, seeds copied to /tmp, ≤60 s); no production or wave-1 writes.
- Grade: **61/100** (proof scoped to its own 5 crates: 84/100). See grading rationale.

---

## 1. Findings (audit findings about the PROOF, numbered A1…)

### A1 — "All Rust decoders" claim excludes the entire `runtime` crate (HIGH, claim-invalidating)

- `proofs/readme.md:33` (C7 row): "All parsers: no panic/OOM …"; `proofs/fuzz/parser/report.md:3`
  restates "all Rust decoders".
- `proofs/fuzz/parser/fuzz/Cargo.toml:12-17` links only `abi`, `hanko`, `process`,
  `entity-kernel`, `protocol`. `xln-rscore-runtime` is not a dependency; none of its decoders
  can be reached by any target.
- Uncovered production decoder sites in `rscore/crates/runtime/**` (grep `pub fn decode|pub fn parse`):
  - `runtime/src/storage_msgpack.rs:414` `decode_storage_payload` — see A2 (likely real OOM).
  - `runtime/src/transport/msgpack.rs:285` `decode_framed` (delegates to the same decoder;
    runtime-socket entry `transport/wire.rs:85` `read_value`).
  - `runtime/src/account_input_json.rs:1569,1766,1788,1108` — WAL/account-input JSON row decoders
    (TS↔Rust persistence boundary), plus ~20 private `decode_*` field readers in the same file.
  - `runtime/src/restore/decode_checkpoint.rs:399,415` (`decode_concrete_runtime_checkpoint`,
    `decode_offline_ts_import_checkpoint`) and the whole `restore/` family
    (`entity_frame_head.rs:373`, `account_checkpoint.rs:293`, `entity_consensus.rs:166`,
    `entity_graph.rs`, `orderbook_graph.rs`, `orderbook_metadata.rs`, `certified_board_registry.rs`,
    `account_canonical.rs`).
  - `runtime/src/j_watcher/abi.rs:26,49` `decode_account_settled`/`decode_settlement` — hand-written
    offset/length ABI reader over **adversarial EVM log bytes** (external chain input; the most
    untrusted decoder in rscore).
  - `runtime/src/machine/types.rs:49` `RuntimeInput::decode`, `entity_context_json.rs:43`.
  - `runtime/src/storage/native/codec.rs:49,96` + `bounded.rs:122` — persisted LevelDB records.
- Also uncovered outside `runtime`: `process/src/runtime_replay/wal_input.rs:76`
  `decode_wal_runtime_input` (the exact-RRS replay path the owner's freeze note calls the
  critical path), `process/src/transport.rs:24` `read_frame`, `entity-kernel/src/prepared_context/htlc.rs:306`
  `decode_onion_layer` (pub export; production reach requires decryption), `engine/src/state/mod.rs:887,907`
  radix-key decoders, `engine/src/tx/handlers/htlc/boundary.rs:49,101` string parsers,
  `engine/src/state/identity.rs:24,59,86`, `engine/src/consensus/frame/hash.rs:456` `parse_root_hex`,
  `entity-kernel/src/consensus/catalog.rs:94`, `process/src/replay_support.rs:13`.
- Consequence: the "no panic / no OOM" part of C7 is proven for 5 crates only. The omitted surface
  is not small print: it is the persistence/replay/transport/watcher layer.

### A2 — Uncovered `decode_storage_payload` contains an O1-class unbounded reservation (HIGH)

`rscore/crates/runtime/src/storage_msgpack.rs`:

- `:14` `MAX_DEPTH = 256`, `:15` `MAX_CONTAINER_ENTRIES = 2_000_000` (length gate at `:99`).
- `:113` `array()` → `Vec::with_capacity(length)`, `:121` `map()` → `Vec::with_capacity(length)` —
  reservation happens **before any remaining-bytes check**; there is no
  `min(claimed, remaining)` guard (unlike `abi/src/msgpack_decode.rs:142`).
- Paper construction (no code run, constants read from source): input `0x03` then N levels of
  `0xdd 00 1e 84 80` (array32 claiming 2,000,000). Each level reserves 2,000,000 ×
  `size_of::<serde_json::Value>()` (32 B) = 64 MiB and stays alive while descending. 8 levels
  (41-byte input) ≈ 512 MiB; 256 levels (~1.3 KB input) ≈ 16 GiB → allocator abort. This is the
  exact class C7's headline "the budget fires before allocation" claims is absent, in a decoder
  the proof never runs. Input reachability: LevelDB-persisted frames/WAL/checkpoints and the
  runtime transport socket — corruption/adversarial-file threat model, same as O1's justification
  for being reported.
- The C7 "no OOM" claim is therefore not merely unproven for this decoder; it is likely false
  within the same 64 KB-input model the report uses.

### A3 — `checkpoint_wire` target asserts no property at all (MEDIUM)

- `fuzz/fuzz_targets/checkpoint_wire.rs:29-52`: builds an envelope, calls `session.handle`,
  discards the reply (`let _reply`). No canonicality, no typed-error, no allocation assertion.
- Report row 4 (`report.md:45`) claims "rejections are typed errors" — nothing in the harness can
  observe that; it is asserted nowhere. Only "no panic" is real for checkpoint restore,
  consensus-snapshot and entity-snapshot decode.

### A4 — `orderbook_page` canonicality property is seed-only, not fuzz-earned (MEDIUM)

- `fuzz/fuzz_targets/orderbook_page.rs:16-18` admits it: acceptance requires page-root hashes a
  fuzzer "cannot guess". The `restore ∘ snapshot = id` assert (`:34-37`) can only fire on inputs
  deriving from `parity-fixture` / `empty-accepted` seeds (2 of 5 seeds).
- The C7 row's "canonicality is accepted only byte-for-byte" rests, for this target, on two
  committed fixtures — regression tests, not a fuzz property. Honest in the comment, but the
  headline wording overstates it.

### A5 — Tight-limits budget pass asserts against the loose budget (MEDIUM)

- `fuzz/fuzz_targets/abi_envelope.rs:94-109` (Pass B): tight `AbiLimits` decode is checked against
  the **loose** `reject_budget` (32 × input × 32 B + slack), not a tight bound. So "limits fire
  before allocation" under tight limits is only demonstrated down to the loose envelope; a tight
  decoder could still amplify ~1000× inside it.
- Pass C (`:116-127`) budget = `claimed × 32 + reject_budget` — ≥ the reservation by construction;
  it documents the O1 amplification rather than bounding it. Fine as evidence, but it does not
  support the C7 headline for the top-level body reader (which O1 itself contradicts).
- Partially mitigating: Pass A/Pass B/Pass C and `msgpack_value.rs:44-64` **do** assert the
  accept/reject budgets on **every execution** with a counting global allocator — the per-execution
  assertion question (audit task 4) is answered positively for targets 2 and 6. Weakness is the
  65,536 B constant: for inputs < ~2 KB the budget is slack-dominated, so "allocation ≈ input" is
  only meaningfully tested on longer inputs.

### A6 — F1 skip predicate is value-wide and can mask unknown canonicality breaks (LOW-MEDIUM)

- `fuzz/fuzz_targets/process_wire.rs:30-43,65-76`: on `encode_account_tx(tx) != value`, the harness
  passes if **any** text leaf in the whole decoded value is non-minimal BigInt text. A second,
  unrelated re-encode bug in a tx that also carries one non-minimal text anywhere would be
  silently swallowed. Sub-decoders use exact-arity (`exact(...)`), which limits ignored-field
  masking, but the whitelist is broader than the failure field.
- Note also: the structure-aware generator cannot produce this class at all — see A8.

### A7 — `checkpoint_wire` "Shutdown scaffold" seed is mislabeled (LOW)

- `fuzz/src/bin/gen_seeds.rs:330-332` writes `shutdown-empty` with leading byte `0`, but the
  target maps byte 0 → `OpTag::RestoreExact` (`fuzz_targets/checkpoint_wire.rs:21-27`, `:31`).
  The report's seed description (`report.md:162-163`: "Shutdown scaffolds that decode
  successfully") is wrong for the committed harness; Shutdown is decoded only via `process_wire`
  mode 1 (op 13, covered by `% 31` = full 31-variant OpTag range, verified in
  `abi/src/types.rs:81-136`).

### A8 — Generator: honest bounds, shallow exploration (LOW-MEDIUM, disclosed)

- `fuzz/src/lib.rs:99-144` `abi_value`: depth ≤ 8, tuple fields ≤ 31/19, text ≤ 256 B, blobs ≤ 512 B
  vs production `AbiLimits` (nesting 32, tuple fields up to 4M hard cap). Depth-boundary structure
  (28–33) is reachable **only** through raw-byte targets 2/6/mode-0 — which is how F2 was found —
  not by the structure-aware grammar. Mode-1/checkpoint bodies realistically explore depth ~2–4.
- `decimal_string` (`lib.rs:75-90`) emits only digits and optional `-`. `+`-prefixed, leading-zero
  ("0850…"), empty, whitespace and hex BigInt texts — the entire F1 class — are ungeneratable
  structurally; F1 was found only by mutating a committed TS-vector seed. Same for adversarial
  varints (array32/map32 with huge claims): raw-byte targets must discover `0xdd/0xdf` markers;
  `msgpack_value` seeds do include `array-claim-huge`/`bin-claim-huge`/`text-claim-huge`, but
  `abi_envelope` seeds contain **no** claim probes (only `boundary-*` + `golden-*`; the report's
  `report.md:156-158` "depth/array-claim probes" overstates for that target).
- 57.6M executions are therefore dominated by cheap rejects on shallow inputs; per-path depth
  actually earned: value layer reaches 32 (F2 evidence), process/checkpoint layer ≤ 8 by design.

### A9 — Report/claim wording vs delivered evidence (LOW)

- `report.md:3` "all Rust decoders" should read "all decoders of the five linked crates" (A1).
- Arithmetic verified: 22,546,145+14,019,386+7,285,404+4,327,717+2,782,814+5,742,493+897,555 =
  57,601,514 execs; durations sum to 937 s. Internally consistent.
- Seeds verified on disk: 19+4+7+32+5+28+26 = **121** across all 7 targets; corpora committed
  (488–3288 entries/target); F1/F2/F3/O1 artifacts exist and replay clean through the prebuilt
  binaries (spot run, /tmp copies).
- Spot run: prebuilt `msgpack_value` over seed copy: 1,793,814 runs / 16 s — consistent with the
  reported 5.7M/91 s rate.

---

## 2. Canonicality property direction (audit task 3) — verified per target

| Target | Claimed | Actually asserted | Verdict |
|---|---|---|---|
| 1 hanko | Ok ⇒ re-encode == input | `encode_hanko_envelope(env) == data` (`hanko_envelope.rs:16-21`); decoder already self-checks (`hanko/src/codec.rs:103-105`) — harness is an independent second check | correct direction |
| 2 abi | Ok ⇒ byte-exact | `encode_envelope(env) == input` (`abi_envelope.rs:84-91`); internal gate at `abi/src/codec.rs:69-71` rejects `NonCanonical` | correct direction |
| 3 process | accepted tx re-encodes to identical `AbiValue`; canonical bytes re-serialize identically | value-level `encode(tx) == decoded value` modulo F1 skip; byte-level only when input was already canonical (`process_wire.rs:58-84`) | correct but value-level (inherent: value codec is normalizing, F3) |
| 4 checkpoint | — | nothing (A3) | property absent |
| 5 orderbook | restore∘snapshot = id | asserted per-execution but acceptance reachable only from 2 seeds (A4) | seed-only regression |
| 6 msgpack | normalizing round-trip | `decode(encode(decode(b))) == decode(b)` (`msgpack_value.rs:79-83`) — this is the *right* property for a documented normalizing codec, not the weak decode∘encode-on-decoded tautology (encode(v) is re-decoded and compared to v) | correct for its contract |
| 7 protocol | parse accepts only canonical | `Ok ⇒ number.as_str() == input` (`protocol_value.rs:104-109`) | correct direction; encoder-only claim for the crate verified against `protocol/src/lib.rs:17-31` exports |

F1/F2/O1/F3 severity review (audit task 5):

- **F1 (medium) — severity sound, containment CONFIRMED on paper.** The only production byte
  entry is `serve()` (`process/src/transport.rs:16-19`) → `decode_envelope(frame, BODY_ARITY=1)`
  with the internal byte-exact canonical gate; text fields are opaque at that layer, so
  "0850000000000" *does* pass the envelope gate, but every consumer (`wire/decode.rs::decode_tx`
  via `wire/value.rs:41-47` tolerant `str::parse`) immediately reduces it to a numeric `BigInt`;
  `AccountTx` carries numbers, not text; checkpoint re-encode (`batch/src/checkpoint_wire/rows.rs:151,234`)
  and WAL replay both operate on the numeric form; no in-repo path hashes the raw tx text
  (no `encode_account_tx` digest consumer exists in `engine`). Leak paths searched and rejected:
  tx re-serialized into checkpoint (minimal encoder, both directions), WAL envelope bytes
  (original canonical bytes, decode→numeric on replay), error strings (`ProcessError::BigInt`
  diagnostic text only), digests (all over numeric/canonical consensus encodings). Residual
  exposure is third-party callers of the exported `decode_account_tx` (`process/src/lib.rs:31`,
  documented as the TS wire contract) — i.e., the vector-test boundary itself. Medium is right.
- **F2 (low) — sound.** Depth-32 decode / depth-33 encode asymmetry is contained at the envelope
  layer (envelope's internal canonical re-encode fails `NestingTooDeep` → typed reject, no panic).
- **O1 (low, observation) — sound and honestly scoped** (production `BODY_ARITY = 1` pins the
  reservation to 32 B). Note the proof's own Pass C encodes the amplification as a passing
  assertion (A5); and the identical pattern, unguarded and uncovered, exists in
  `runtime/src/storage_msgpack.rs` (A2).
- **F3 (documented normalization) — sound**; byte-canonicality genuinely enforced one layer up
  (verified `abi/src/codec.rs:69-71`).

## 3. 100/100 gap list (what it would take to close)

1. Add `xln-rscore-runtime` as a fuzz dependency; targets for at minimum:
   `decode_storage_payload` (with counting allocator, accept/reject budgets),
   `decode_account_input_row` + `decode_account_tx_json` (JSON rows),
   `decode_concrete_runtime_checkpoint` / `decode_offline_ts_import_checkpoint`,
   `decode_account_settled` (j_watcher EVM logs — adversarial input),
   `decode_certified_entity_frame_head`, native storage `decode_head`/`decode_checkpoint`/`decode_manifest`.
2. Fix or bound `storage_msgpack.rs:113,121` (`min(claimed, remaining)` like
   `abi/src/msgpack_decode.rs:142`) or prove the 2M×256 reservation harmless — then make it a
   regression corpus member.
3. Target or explicit in-reach coverage for `decode_wal_runtime_input` (RRS replay path),
   `read_frame`, `decode_onion_layer`, radix-key decoders, HTLC boundary parsers.
4. Give `checkpoint_wire` a real property: typed-error assertion on the reply + budget assert.
5. Make `orderbook_page` acceptance fuzz-reachable (compute valid page roots for generated
   snapshots via the production hasher in the harness) so restore∘snapshot=id is earned, not seeded.
6. Tighten Pass B to a tight allocation bound; shrink/remove the 65,536 B slack for long inputs.
7. Generator upgrades: adversarial BigInt text grammar (`+`, leading zeros, `0x`, whitespace),
   depth-aware generation near 32, huge-arity tuple claims in the structured grammar, claim-probe
   seeds for `abi_envelope`.
8. Narrow the F1 skip to the exact mismatching field; un-masking any second bug class.
9. Fix the `shutdown-empty` seed mapping or add Shutdown to the checkpoint OPS list; correct
   `report.md:162-163`.
10. Reword C7 (`proofs/readme.md:33`) to the proven scope: "all decoders of abi/hanko/process/
    entity-kernel/protocol, ≤64 KB inputs, budgets per-execution on targets 2 and 6".

## 4. Grade

**61/100** for C7 as claimed ("All parsers").

- +34: what is covered is done well — correct canonicality directions on targets 1/2/3/6/7,
  per-execution allocation assertions with a counting allocator on 2/6, committed seed+corpus+
  artifacts with reproducible pinning, honest model bounds, internally consistent numbers,
  verified 121 seeds and replayable findings.
- −24: decoder surface incomplete in a claim-invalidating way (entire `runtime` crate +
  RRS WAL replay + EVM-log ABI reader; A1), including one uncovered decoder with a likely-real
  OOM amplification inside the proof's own threat model (A2).
- −8: property gaps (checkpoint asserts nothing A3; orderbook acceptance seed-only A4;
  tight-budget pass loose A5).
- −7: generator shallowness/masking (A6, A8), seed/report drift (A7, A9).

Scoped to the five crates it actually tests, the proof is solid: **84/100**. The remaining 16
points there are A3–A8. The headline, not the harness, is what fails.
