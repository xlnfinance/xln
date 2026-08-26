# C7 — structure-aware parser fuzz (cargo-fuzz): report

Claim C7 (`proofs/readme.md`): all Rust decoders — no panic, no OOM, limits fire
before allocation, canonical acceptance only (byte-in / byte-out).

## Environment / evidence identity

| Item | Value |
|---|---|
| `git rev-parse HEAD` at run | `dfd45cc7c20f188e3f9c032b7549d3baab52b1de` |
| rscore source actually compiled | pinned extraction of `80924b035f363d4ad8f4a8c08e6f39dcc7736a78` (`git archive`), **byte-identical** to HEAD's committed `rscore/crates/**` (`git diff 80924b035..HEAD -- rscore/crates` is empty) |
| `git status --porcelain \| wc -l` at run | 320 (uncommitted parallel-task edits in the live tree — `rscore/crates/*/src/**` was mid-refactor during the runs; that is why the measured builds use the pinned extraction via `pin-rscore.sh`) |
| cargo-fuzz | 0.13.2 |
| libfuzzer-sys | 0.4.13 (libFuzzer bundled with rustc) |
| rustc (nightly) | 1.100.0-nightly (787af2b8c 2026-08-25), aarch64-apple-darwin |
| Sanitizer | address (cargo-fuzz default) + `-C instrument-coverage` (sancov inline-8bit-counters, pc-table, trace-cmp) |
| Host | darwin 25.6.0, arm64 (Mac Studio class) |
| Production code touched | none (only `proofs/fuzz/parser/**` created) |

Reproduce pinning + runs:

```bash
cd proofs/fuzz/parser
./pin-rscore.sh 80924b035f363d4ad8f4a8c08e6f39dcc7736a78   # or: restore
cd fuzz
cargo fuzz run <target> corpus/<target> seeds/<target> -- \
  -max_total_time=<60..180> -rss_limit_mb=2048 -timeout=10
cargo run --bin gen_seeds        # regenerate the committed seed corpora
./pin-rscore.sh restore
```

## Targets and proven properties

All sessions ran with `-rss_limit_mb=2048 -timeout=10`, `len_control` default
(libFuzzer auto-grows `max_len`; observed `lim` reached 4096 on byte targets and
57334 on `msgpack_value` because of the 64KB blob seed). Inputs in the model are
therefore byte strings up to ~64KB; everything below is claimed **only within
that model**, not "impossible" in an unbounded sense.

| # | Target (file) | Decoder under test | Properties asserted | Execs | Duration | cov / ft |
|---|---|---|---|---|---|---|
| 1 | `hanko_envelope` | `hanko/src/codec.rs::decode_hanko_envelope` (+ `abi.rs` solidity-ABI reader) | no panic; `Ok` ⇒ `encode_hanko_envelope(env) == input` byte-exact | 22,546,145 | 181 s | 358 / 946 |
| 2 | `abi_envelope` | `abi/src/codec.rs::decode_envelope_with_limits` (+ msgpack parser/decode) | no panic; `Ok` ⇒ `encode_envelope(env) == input` byte-exact (total output ≤ input + 0); allocation budget per outcome (below); tight-limit pass rejects before large allocations | 14,019,386 | 151 s | 942 / 2264 |
| 3 | `process_wire` | `process/src/wire/decode.rs` — `decode_account_tx` on raw wire bytes and the full `ProcessSession::handle` command decode (all op tags; wave/peer inputs, frames, ACKs, jobs) | no panic anywhere in decode or error-reply encode; accepted tx re-encodes to the identical `AbiValue` (F1 class excluded and reported); canonical-input bytes re-serialize identically | 7,285,404 | 181 s | 3557 / 8061 |
| 4 | `checkpoint_wire` | `process/src/checkpoint_wire/decode.rs` via `ProcessSession::handle` with op pinned to RestoreExact / BootstrapAccounts / BootstrapEntity / AccountInbound / AccountOutbound | no panic in checkpoint restore-row, consensus-snapshot and entity-snapshot (incl. orderbook page wire) decode; rejections are typed errors | 4,327,717 | 121 s | 1526 / 3333 |
| 5 | `orderbook_page` | `entity-kernel/src/orderbook/page.rs` `page_key`/`page_price`/`page_sequence`/`restore_page` via public `BookState::restore`/`snapshot` | no panic on arbitrary snapshots (price 0/negative/1..255-byte, sequences, counters, slots); accepted restore ⇒ `restore ∘ snapshot = id` (page keys re-encode byte-exactly) — verified on the committed parity fixture and the empty-book seed | 2,782,814 | 121 s | 2218 / 5639 |
| 6 | `msgpack_value` | `abi/src/msgpack_decode.rs` via `decode_value` | no panic; allocation ≤ `len·4·size` on accept and ≤ `32·len·size` on reject; normalizing round-trip `decode(encode(decode(b))) == decode(b)` (F2 boundary excluded and reported) | 5,742,493 | 91 s | 478 / 2462 |
| 7 | `protocol_value` | `protocol/src/value.rs::CanonicalNumber::parse_js_canonical` + encoders `encode_canonical_consensus_bytes` / `encode_account_state_value` / `compute_flat_integrity_root` | `parse_js_canonical` never panics and accepts only ryu-canonical text (`Ok` ⇒ `as_str() == input`); encoders never panic on generated values (duplicate keys, record-shape exhaustion, i128-range bigints) with output ≤ `4·len + 4096`. No byte-level readers exist in this crate (`consensus_msgpack.rs` is documented encoder-only) — verified against `lib.rs` exports | 897,555 | 91 s | 1660 / 9244 |

Total: **57,601,514 executions / 937 s** across the seven recorded sessions
(plus shorter smoke/discovery runs that surfaced the findings below).

### Allocation-budget formulation (targets 2 and 6)

A counting `#[global_allocator]` measures total bytes allocated during one
decode. `size_of::<AbiValue>() == 32` (observed).

- Accepted decode: allocation ≤ `input_len · 128 + 65536` (every accepted value
  consumes ≥ 1 input byte, so the value tree is linear in the input). Never
  violated in 14M+ executions.
- Rejected decode: allocation ≤ `32 · (input_len+1) · 32 + 4·input_len + 65536`.
  `read_nested_tuple` reserves `min(claimed, remaining)` per nesting level and
  at most `max_nesting_depth = 32` reservations are alive on one descent — the
  designed "limits fire before allocation" budget. Observed peak ratio ≈ 348×
  on a 442-byte input (153,800 B), inside the budget.
- Tight-limits pass: budgets shrunk to 64 B text / 64 B blob / 64 tuple fields /
  256 values / depth 8 reject oversized claims before payload allocation.

## Findings (reproducers committed under `fuzz/findings/`)

Production code was **not** modified (rule 1). Severity is a triage proposal;
fix decisions belong to the owner.

### F1 — `decode_account_tx` accepts non-minimal decimal BigInt text (medium)

- Artifact: `fuzz/findings/F1-noncanonical-bigint-text-tx` (91 bytes, a
  TypeScript `htlc_lock/full` vector with the timelock text changed
  `1700000000000` → `0850000000000`).
- Observation: `decode_account_tx` accepts the value; `encode_account_tx`
  returns `Text("850000000000") ≠ Text("0850000000000")` — the accepted-wire
  round trip `encode(decode(x)) == x` is broken at the exported tx boundary
  (`process/tests/tx_wire_vectors.rs` property), because
  `process/src/wire/value.rs::bigint()` uses tolerant `str::parse::<BigInt>()`
  while the encoder (`batch/src/checkpoint_wire/account_tx.rs::encode_bigint`)
  emits `to_string()`. `num-bigint` parse also accepts `+`-prefixed text.
- Mitigation in production: the full envelope decoder re-encodes and compares
  byte-exactly, so a peer cannot smuggle such a spelling through the transport
  envelope. The defect is limited to the public `decode_account_tx` boundary
  used for cross-language vectors.

### F2 — `decode_value`/`encode_value` nesting budget off by one (low)

- Artifact: `fuzz/findings/F2-msgpack-depth-asymmetry` (34 bytes; minimal repro
  is 33 bytes: `0x91`×32 + `0xc0`).
- Observation: a value at exactly the accepted nesting depth 32 decodes
  (`decode_value` Ok) but `encode_value` fails
  `NestingTooDeep { actual: 33, max: 32 }` — `encode_value`
  (`abi/src/digest.rs`) wraps the value in a one-element tuple, consuming one
  depth level from the same budget. No panic; the decode/encode pair is
  inconsistent at the boundary.

### F3 — msgpack value layer accepts non-minimal integer encodings (classified: documented normalization, not a defect)

- Artifact: `fuzz/findings/F3-msgpack-alias-int-bytes` (6 bytes:
  `92 03 d1 03 d1`).
- Observation: `decode_wire_value` decodes `int16(977)` alias encodings to the
  same value as the minimal form; bytes differ on re-encode. This is the
  documented normalizing contract (`decode(encode(x)) = normalize(x)`,
  `proofs/readme.md` codec properties); byte-level canonical-only acceptance is
  enforced one layer up — verified by target 2's built-in re-encode comparison
  in `decode_envelope`. Recorded so the boundary is explicit.

### O1 — body-arity reservation amplification in `read_body_tuple` (observation, low)

- Artifact: `fuzz/findings/O1-body-arity-reservation-amplification` (160 bytes).
- Measured: input of 160 bytes with `expected_body_arity = 65535` and an
  `array32` body-length claim allocates **2,097,138 bytes** (=
  65535 × 32 + 18) before rejecting on EOF. Worst case at
  `AbiLimits::max_tuple_fields = 4,000,000` is ~128 MB from a ~165-byte input.
  The nested-tuple reader reserves `min(claimed, remaining)` (its own comment
  explains why); the **top-level** body reader
  (`abi/src/msgpack_decode.rs::read_body_tuple`) reserves the claimed arity
  outright. Production callers pass small constants (≤ ~20 fields), so the
  production path amplification is bounded at a few hundred bytes; the huge
  case requires a caller passing a huge `expected_body_arity` to the public
  `decode_envelope_with_limits`. Not an OOM within this model (rss 2048 MB);
  flagged as a public-API footgun for the owner.

### Non-findings (explicitly checked)

- No panic, abort, or OOM in any production decoder across all executions.
- Hanko ABI reader: all offsets/lengths bounded by the buffer before any
  reservation (`size()` rejects values > buffer length); no OOB found.
- Orderbook page keys: `page_price`'s `key[1] == 0` non-canonical guard is not
  reachable from the public API (map keys are always produced by `page_key`,
  which emits minimal `BigInt::to_bytes_be` magnitudes) — the guard protects a
  foreign radix store and stayed defensive during all runs.
- Envelope digests make the acceptance path of targets 2–4 unforgeable by
  mutation; accepted-command scaffolds came from committed vectors/seeds, so
  post-decode session dispatch (which requires Hello first) was exercised, not
  bypassed.

## Seed corpora (committed, `fuzz/seeds/<target>/`)

Generated by `cargo run --bin gen_seeds` (vectors are never hand-written —
rule 3):

- `process_wire`: 19 TypeScript tx-wire vectors verbatim from
  `core/__tests__/rscore/tx-wire-vectors.json` (+ accepted-decode command
  scaffolds built with the production encoders).
- `orderbook_page`: the committed parity fixture
  (`rscore/fixtures/entity-kernel/parity-v1.json` `bookHydration`, restored and
  re-snapshotted byte-identically at generation time) + a production-computed
  empty-book snapshot + zero/negative/255-byte price rejection probes.
- `hanko_envelope`, `abi_envelope`, `msgpack_value`: production-encoder outputs
  (empty/claim/signature hanko envelopes; the abi golden envelope from
  `abi/src/tests.rs`; integer 8/16/32/64-bit and RLP-relevant 55/56-byte text
  boundaries; depth/array-claim probes) + the abi golden body hex.
- `protocol_value`: ryu-canonical number texts (`0`, `-1`, `1e+21`, `1e-7`,
  `1.5e-9`, `5e-324`, `1.7976931348623157e+308`, ±`9007199254740991`, …) and
  non-canonical probes (`01`, `+1`, `1.0`, `1E2`, `.5`, `Infinity`, `NaN`).
- `checkpoint_wire`: RestoreExact/AccountInbound/AccountOutbound/Shutdown
  scaffolds that decode successfully.

## Calibration status

The B1–B8 known-bug list from the external audit is still awaited from the
owner (`proofs/readme.md` rule 4). When provided, each B-case must be added to
the matching target's seed corpus; until then the harnesses are calibrated
only against the three findings discovered here, whose artifacts are committed
as permanent corpus members under `fuzz/findings/`.

## Bounded assumptions (model)

- Inputs: arbitrary byte strings up to ~64 KB (libFuzzer-managed).
- Structure-aware generators (targets 3/4/7): depth ≤ 8, tuple fields ≤ 32,
  text ≤ 256 B, blobs ≤ 512 B — tighter than production `AbiLimits`.
- Allocation claims hold for the counted-allocator budget model described
  above; RSS ceiling 2048 MB per process.
- `ProcessSession` harness uses a fresh session per execution (OS entropy for
  the incarnation token; consensus determinism is untouched — decode is pure).
