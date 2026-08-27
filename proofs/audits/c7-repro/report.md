# C7 parser-fuzz proof — independent reproduction audit

Angle: re-run and verify `proofs/fuzz/parser/report.md` (C7 commit `b95e7ee3b`).
All my writes are confined to `proofs/audits/c7-repro/**`; committed corpora, seeds,
findings and production code untouched (`diff -r` of my copies vs committed: identical).

## Environment identity

| Item | Value |
|---|---|
| Audit date | 2026-08-27 |
| HEAD at audit | `13f51950a483dc5b721c722259881fb089768368` |
| HEAD at C7 commit | `b95e7ee3b6345a296535aeb6a5d375efc1a27c88` |
| Pinned SHA under test | `80924b035f363d4ad8f4a8c08e6f39dcc7736a78` (`git archive` extraction, `pinned/rscore/`) |
| Toolchain | cargo-fuzz 0.13.2, rustc 1.100.0-nightly (787af2b8c 2026-08-25) — byte-identical to report |
| Live tree | 419+ uncommitted entries, 107 under `rscore/` — pinning mandatory, as report claims |

Corrected pin geometry used for every re-run (see A-1): extraction at
`proofs/audits/c7-repro/pinned/rscore` (outside the fuzz workspace root), fuzz-crate
path deps `../../pinned/rscore/crates/*`, everything else byte-copied from the C7
commit (Cargo.lock, rust-toolchain.toml, targets, seeds, findings).

## Task 1 — build discipline / pin verification

- **Pinned bytes == committed bytes at report time: VERIFIED.**
  `git diff 80924b035 b95e7ee3 -- rscore/crates` → 0 lines (commit-to-commit).
- Re-verified NOW against audit HEAD `13f51950a`: no longer empty — +14,507/−1,094
  lines across the five C7 crates (parallel RRS work; runtime crate +A2 guard also
  landed, but runtime is not in the C7 dependency graph — build log compiles only
  abi/protocol/crypto/hanko/engine/batch/entity-kernel/process). Consequence:
  faithful re-runs today REQUIRE the pinned extraction; mine used it.
- Working-tree diff vs pin: 9,615 lines — the mid-refactor story checks out.

### A-1 (medium, provenance): committed `pin-rscore.sh` cannot work

Empirically demonstrated with minimal workspace-geometry tests plus a real build
attempt; two independent defects:

1. Path bug: the script extracts to `parser/.rscore-pinned` but rewrites
   `fuzz/Cargo.toml` deps to `.rscore-pinned/rscore/crates/...`, which cargo
   resolves relative to `fuzz/` → `fuzz/.rscore-pinned/...` (nonexistent) →
   `failed to read .../fuzz/.rscore-pinned/rscore/crates/abi/Cargo.toml`.
2. Even with the path fixed to `../.rscore-pinned/...`: an extraction inside the
   fuzz workspace root's directory tree makes cargo resolve the rscore crates'
   `edition.workspace = true` against the outer workspace root (which has no
   `[workspace.package]`) → `workspace.package.edition was not defined`.

The report's documented reproduce command (`./pin-rscore.sh <sha>` then
`cargo fuzz run ...`) therefore fails as committed. The measured runs must have
used a corrected local variant that was not committed. The archive-and-rewire
*design* is sound; only the committed geometry is broken. Fix: extract outside the
parser workspace tree (as this audit did) or inside `fuzz/`, and commit that.

## Task 2 — short re-runs (pinned bytes, committed seeds)

| Target | Mine | Report | Rate mine/report | Crashes |
|---|---|---|---|---|
| `hanko_envelope` | 7,907,785 execs / 61 s | 22,546,145 / 181 s | ~130K/s vs ~124K/s | 0; artifacts dir empty; corpus 4 seeds → 114 units |
| `orderbook_page` | 1,066,561 execs / 61 s | 2,782,814 / 121 s | ~17.5K/s vs ~23K/s | 0; artifacts dir empty; corpus 5 seeds → 506 units |

Both: `-max_total_time=60 -rss_limit_mb=2048 -timeout=10`, ASAN + sancov, exit 0,
exec counters accumulated monotonically during the session. No crash reproduces.

## Task 3 — F1 reproduced + envelope containment

Reproducer: `run/fuzz/src/bin/repro.rs` (pinned crates). Additive artifacts:
`F1-minimal-repro` (63 B), `F2-minimal-repro` (33 B), `O1-minimal-repro` (160 B).

- Committed artifact (146 B): byte-diff vs seed `tx-htlc_lock_envelope` is exactly
  3 bytes at offsets 46–48 (`"170"`→`"085"`) — the TS vector with only the timelock
  spelling changed, as report says. `decode_account_tx` → `Ok(HtlcLock)`;
  re-encode `Text("850000000000")` ≠ accepted `Text("0850000000000")`; wire bytes
  145 vs 144.
- Crafted minimal 63-B input: same divergence at `tx[3]`.
- `'+'`-prefixed `"+850000000000"` also accepted (tolerant `num-bigint` parse) —
  report side note confirmed. Root cause at pin: `process/src/wire/value.rs:41-47`
  (`value.parse()`) vs the tx encoder's minimal `to_string()`.
- Control with minimal spelling: byte-identical round trip (harness is calibrated).

### Envelope-level containment — verified with a nuance (A-2)

Minimal envelope (Hello/Request, arity-1 body carrying the F1 tx value) built with
the production encoder, 219 B:

- `decode_envelope_with_limits` → **Ok**, 678 B allocated, re-encode == input
  byte-exact, accepted body carries `Text("0850000000000")` verbatim. Control with
  minimal text: likewise Ok, byte-exact.
- So the audited claim — "re-encode of the full envelope == input bytes holds for a
  minimal envelope containing that tx" — **HOLDS**.
- **But** report.md's mitigation sentence "a peer cannot smuggle such a spelling
  through the transport envelope" is wrong at face value: the envelope layer is
  spelling-indifferent (msgpack text round-trips verbatim; the canonicality check
  passes). The spelling crosses the transport envelope and reaches the tolerant
  `decode_account_tx`. Real containment is at the typed-tx boundary (BigInt drops
  the spelling) and digests binding the original wire bytes. Severity: low
  (documentation), but triage must not rely on "envelope rejects it".

## Task 4 — F2 and O1 reproduced

- **F2** minimal 33 B (`0x91`×32 + `0xc0`): `decode_value` Ok; `encode_value` →
  `Err(NestingTooDeep { actual: 33, max: 32 })` — exactly as reported. Boundary 31
  (`0x91`×31): both directions Ok, `decode(encode(v)) == v`. Committed 360-B
  artifact: same asymmetry. Root cause at pin: `abi/src/digest.rs::encode_value`
  wraps the value in a one-element `BodyTuple`.
- **O1** committed 160-B artifact: `decode_envelope_with_limits(input, 65535,
  &AbiLimits::default())` allocates **exactly 2,097,138 B** (report's number to the
  byte; 65535×32+18) then rejects `UnexpectedEof`. With `expected_body_arity=1`:
  rejects `BodyArity` after 18 B. Crafted array32 envelope (160 B): identical.
  Root cause at pin: `abi/src/msgpack_decode.rs:71` — `read_body_tuple` does
  `Vec::with_capacity(actual)` on the claimed arity outright, unlike
  `read_nested_tuple:142` which reserves `length.min(self.remaining())`.
- A-4 (info): the committed `abi_envelope` harness cannot itself drive a 65535
  reservation on any magic-valid input (pass A arity ≤ 18; pass C `claimed` =
  be16(input[0..2]) with input[0] = magic 0x03 ⇒ ≤ 1023, and it must equal the
  declared body arity to pass the `BodyArity` gate). O1 is evidenced by direct
  public-API calls — which the report does state ("public-API footgun"), but the
  harness-coverage boundary is worth recording.

## Task 5 — C7 commit scope

`git show --stat b95e7ee3b`: 141 files, **0 outside `proofs/`** ✓.
`fuzz/Cargo.toml` committed in restored (live-path) state ✓ (pin script's restore
direction is the inverse of its pin direction).

## Reproduction table

| # | Claim in report.md | My result | Verdict |
|---|---|---|---|
| 1 | Pinned rscore == HEAD committed at run time | commit-to-commit diff 0 lines at `b95e7ee3` | REPRODUCED |
| 2 | Live tree mid-refactor, pin required | 107 uncommitted rscore files; 9,615-line working-tree diff vs pin | REPRODUCED |
| 3 | `pin-rscore.sh` mechanism sound | Committed script fails two ways (A-1); corrected geometry builds | REFUTED as committed |
| 4 | hanko_envelope: no panic, canonical accept | 7.9M execs/61 s, 0 crashes | REPRODUCED |
| 5 | orderbook_page: no panic, restore∘snapshot=id | 1.07M execs/61 s, 0 crashes | REPRODUCED |
| 6 | F1: non-minimal BigInt text accepted, re-encode differs | 146-B artifact + crafted 63-B + `'+'` variant; control clean | REPRODUCED |
| 7 | F1 mitigation: envelope blocks the spelling | Envelope ACCEPTS it byte-exactly (verbatim text) | REFUTED (wording) |
| 8 | Envelope canonicality holds for envelope containing F1 tx | Ok, re-encode == input, 219 B | REPRODUCED |
| 9 | F2: depth-32 decodes, encode fails {33,32} | 33-B minimal + committed artifact | REPRODUCED |
| 10 | O1: 160 B input, arity 65535 ⇒ 2,097,138 B | Exact byte count matched | REPRODUCED |
| 11 | C7 commit touches only proofs/** | 141/141 files | REPRODUCED |

## Findings (this audit)

| ID | Severity | Finding |
|---|---|---|
| A-1 | medium (provenance) | Committed `pin-rscore.sh` broken (path resolves into non-existent `fuzz/.rscore-pinned`; workspace-inheritance break when fixed to `../`). Documented reproduce command fails; runs used an uncommitted corrected variant. |
| A-2 | low (report accuracy) | F1 mitigation sentence overstates: the transport envelope accepts the non-minimal spelling byte-exactly; containment is at the typed-tx boundary. |
| A-3 | info | Pin==HEAD equality held at report time but has drifted (current HEAD +14.5K lines in the 5 C7 crates); re-runs must pin — this audit did. |
| A-4 | info | O1 shape unreachable through the committed harness passes (magic caps pass-C arity at ≤1023); evidenced only via direct public-API calls. |
| — | — | F1/F2/F3/O1 themselves all reproduce exactly as described; no new decoder defects found in my short sessions. |

## Gap list (distance to 100/100)

1. Committed pin mechanism broken (A-1) — the reproduce command in report.md fails.
2. Envelope-mitigation wording empirically wrong (A-2).
3. O1 not reachable by the committed harness (A-4); only out-of-band measurement.
4. B1–B8 external calibration list still absent (report admits); harnesses
   calibrated only against self-found findings.
5. Only 2/7 targets re-run by this audit (60 s each); abi/process/checkpoint/
   msgpack/protocol targets verified via committed artifacts, not fresh sessions.
6. Per-run libFuzzer logs/cov dumps not committed; the 57.6M/937 s total is not
   independently re-summable — only rate-consistency spot checks exist.
7. Exec counts and cov are timing-dependent; no deterministic replay of counts.

## Grade

**82 / 100.** Technical substance verifies cleanly — pinned bytes match the
committed tree at report time, both re-run targets are crash-free with consistent
throughput, and F1/F2/O1 reproduce exactly (O1 to the byte). Deductions: broken
committed pin script (−8, provenance discipline is the entire point of pinning),
empirically wrong mitigation wording on F1 (−4), harness-coverage gap on O1 plus
missing external calibration (−4), non-re-summable aggregate evidence (−2).
