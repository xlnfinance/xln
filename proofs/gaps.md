# proofs/gaps.md — register of audit demands (to 100/100)

Rule: every "100/100 gap list" item of every committed audit must have a
status here. Statuses: `CLOSED <commit>` / `WAVE-2026-08-28` (closed by the
post-audit wave, uncommitted at registration time) / `PARTIAL` / `OPEN` /
`OWNER` (needs an owner decision). Registered: 2026-08-28 (program audit);
updated on every closure.

## c1-adversary (74/100)

| # | Demand | Status |
|---|---|---|
| 1 | Re-pin: relabel the seed + rebuild + re-run the 4 corpora at a new immutable SHA | PARTIAL: generator fix `935020a41`; the coordinator's full rerun on clean immutable `b7e3ace82` = 80,656/0. An independent repro audit on the post-FX bytes — OPEN |
| 2 | Repair the shrinker (unique candidate ids) + calibrate ≥3 sabotage modes | WAVE-2026-08-28: unique deterministic IDs, tested-slice restriction, failure-signature preservation; content-hex/class-inversion/field-divergence = 1/1 each |
| 3 | Duplicate parity: a production check in the TS encoder OR reword the property (reference-key asymmetry) | OPEN |
| 4 | Enumerate the asymmetry family: seeds tokenId>65535, timeInForce>255, jHeight>2^53, hashlock/EntityId/envelope | PARTIAL WAVE-2026-08-28: tokenId/timeInForce/jHeight/hashlock/EntityId seeds added and checked; malformed envelope cases — OPEN |
| 5 | Flat duplicate paths: exclude from the model or a contractual tie-break + a ≥21-entry probe | PARTIAL WAVE-2026-08-28: the 21-entry probe passes; contractual tie-break or domain exclusion — OPEN |
| 6 | TS-only kinds: 3/14 → all 14 (or state 3/14 explicitly in the claim) | OPEN |
| 7 | Edge seeds: j_event with 0 events; unknown tx field; `__proto__`; wObj-dup without the driver interceptor | PARTIAL WAVE-2026-08-28: zero-event, unknown-field known-divergence + exact production reject, and `__proto__` added; raw wObj-dup production semantics — OPEN |
| 8 | Coverage ledger: per-pair/per-branch counters | PARTIAL WAVE-2026-08-28: a class/kind/TS↔Rust-outcome/tx-kind ledger is emitted; an internal encoder branch ledger — OPEN |

## c1-repro (92/100; `findings.md` committed at `9aa5affbe`, audited subject `dfd45cc7c`)

| # | Demand | Status |
|---|---|---|
| 1 | The original run on a dirty tree is not recoverable from git | CLOSED by equivalence: c1-repro independently rebuilt and re-ran 80,656/0 from a clean `git archive dfd45cc7c`; the original dirty bytes remain non-reconstructible |
| 2 | Seed 31337 not re-run | WAVE-2026-08-28: clean `e69630fca` + proof-only fix, 10,114/0; an independent repro at an immutable SHA is still required |
| 3 | The minimizer sabotage-calibration wrapper is not committed | OPEN (tied to c1-adv #2) |
| 4–5 | Generator gaps / driver-substituted both-reject | OPEN (= c1-adv #4–7, #3) |
| 6 | Stale corpus label | WAVE-2026-08-28 (corpus `d483605e2` + generate.ts by the wave) |

## c2-adversary (55/100)

| # | Demand | Status |
|---|---|---|
| 1–7 | Non-empty maps, the delete path, instantiating the 4 namespaces, conflict generation + D4 vectors, EntityAccountCandidateMap/leaf-registry, post-finality clock | CLOSED `b8004d939` (7 non-empty collections; lending/subcontracts/shadow — out of profile, see #8) |
| 8 | Dispute/`external_finality`/settle_transition kinds, `settlementWorkspaceHash ≠ null` | OPEN |
| 9 | Double rollback / repeated-collision pin | OPEN |
| 10 | Multi-leaf deltas beyond the 5 registered tokens, boundary tokenIds | OPEN |
| 11 | Honest accounting (900, not 1,200) + per-op-kind counters | CLOSED (report text; matrix — WAVE-2026-08-28) |
| 12 | Reproducibility: commit the artifacts + a clean SHA | CLOSED `d483605e2`+`b8004d939`; re-audit clean extraction `78e07d9a9` — exact |
| A9 | Witness lifecycle (pruning, state-resolution ACK hashes) | OPEN |

## c2-repro replacement (91/100)

| # | Demand | Status |
|---|---|---|
| 1 | The original c2-repro (88/100) was never committed and is unrecoverable | CLOSED by replacement only: the independent re-audit `b043199fe`; the loss of the original report remains a coordinator error |
| 2 | A fresh-seed run beyond the three fixed seeds | OPEN |
| 3 | A commit reproducing the historical pre-FX-3 throw | UNRECOVERABLE: the fix landed before the first C2 evidence commit; do not use as a reproducible claim |
| 4 | C2's inherited coverage gaps | OPEN (= c2-adversary #8–10, A9) |

## c4-adversary (78/100)

| # | Demand | Status |
|---|---|---|
| 1–3 | Debt-lifecycle reach; debt-bookkeeping invariants; a real `invariant_debtNeverEntersValuePool` | CLOSED `aecfed195` |
| 4 | Transformer shapes: multi-index/multi-clause/invalid arrays/fault modes/decoder path | PARTIAL `aecfed195`: 6 fault modes, multi-index, and the decoder closed; multi-clause chaining and invalid allowance arrays — OPEN |
| 5 | Asymmetric windows 50/70 + side-selection + closeDispute + invalid witness | CLOSED `aecfed195` |
| 6 | A repay action (the clamp oracle recovers after a shortfall) | CLOSED `aecfed195` |
| 7 | `check_gateZeroConcrete` committed + single-clause warning | CLOSED `aecfed195` |
| 8 | Halmos breadth: full-domain clamp with sentinel branches, non-representable revert, allowance-validity lemmas | OPEN |
| 9 | Hanko: deep chains (~8–16 claims), the registered-board branch, previous-board grace in the dispute path | OPEN |
| 10 | Historical-batch replay + `FOUNDRY_PROFILE=deep` 1024×128 | OPEN |
| 11 | The false comment at `ConservationHandler.sol:217-219` (the restriction's justification is wrong) | OPEN (editing the test file is allowed, not done) |
| 12 | Entry-point sweep: `watchtowerCounterDispute` (finalize-capable), `adminRegisterExternalToken`, ERC721/1155, public `enforceDebts` | OPEN |

## c4-repro (92/100)

| # | Demand | Status |
|---|---|---|
| 1 | Commit the C4 artifacts | CLOSED `944353c7c` |
| 2 | DebtChunking: reclassify as test-vs-design | CLOSED (BUG-09) |
| 3 | BatchBounds 15,049,243 ≥ 15M | OWNER (BUG-08) |
| 4 | Halmos path-count stability note | CLOSED (in the report) |
| 5 | The typechain/artifacts regeneration reflected in the evidence | OPEN (cosmetic) |
| 6 | Extensions (historical replay, deep profile) | OPEN (= c4-adv #10) |

## kani-adversary (83/100)

| # | Demand | Status |
|---|---|---|
| A1 | W256 cross-check: add out-of-range cases OR reword the row | Wording — WAVE-2026-08-28 (report body); the out-of-range test fix — OPEN |
| A2 | "3 mutants" → 2 mutants + 1 sensor | WAVE-2026-08-28 (body: `mutant_detection_calibrates_harness`) |
| A3 | "Rust is stricter" is false; register the negative-operand divergence | CLOSED (BUG-06 two-sided) |
| A4 | Census 11, not 12 | WAVE-2026-08-28 (body: "All 11") |
| A5 | 73 subset orders, not 60 | WAVE-2026-08-28 (body) |
| A6 | The `map_slots` callback-contract caveat | Partial: report appendix; into body §3.3 — OPEN (minor) |
| — | Kani-repro audit (independent re-run of 16/16 + equivalence) | CLOSED `bdb5733f3` (93/100, same-agent); an external re-run — OPEN |

## c7-adversary (61/100 as "all", 84/100 in scope)

| # | Demand | Status |
|---|---|---|
| 1 | Targets over `xln-rscore-runtime` (storage_msgpack, account_input_json, restore/*, j_watcher/abi, native codec) | OPEN (wave-2 interrupted by the provider quota; the `runtime_wal_input` target is in progress with the coordinator) |
| 2 | The storage_msgpack guard + a regression in the corpus | Guard CLOSED (main, `rscore/crates/runtime/src/codec/storage_msgpack.rs:66,130,140`); the fuzz regression — OPEN (wave-2) |
| 3 | `decode_wal_runtime_input` (RRS replay), `read_frame`, `decode_onion_layer`, radix-key, HTLC boundary | OPEN |
| 4 | `checkpoint_wire`: a real property (typed-error + budget assert) | OPEN |
| 5 | `orderbook_page`: fuzz-earned acceptance (production hasher in the harness) | OPEN |
| 6 | Tight Pass B budget (remove the 65,536 B slack) | OPEN |
| 7 | Generator: adversarial BigInt grammar, depth≈32, huge-arity claims, claim-probes for abi_envelope | OPEN |
| 8 | Narrow the F1 skip to the exact field | OPEN |
| 9 | shutdown-seed mapping / OPS list | OPEN |
| 10 | Reword C7 to the proven scope | CLOSED (matrix narrowed; refined by WAVE-2026-08-28) |

## c7-repro (82/100)

| # | Demand | Status |
|---|---|---|
| 1 | `pin-rscore.sh` unworkable as committed | CLOSED `631c68d37` (v2, extraction into an out-of-tree `mktemp -d`; verified by the 2026-08-28 audit) |
| 2 | The F1-mitigation wording ("the envelope does not let it through") is empirically wrong | CLOSED (report rewritten) |
| 3 | O1 unreachable through the committed harness (public-API only) | OPEN (info) |
| 4 | B1–B8 calibration (the owner's external list) | OWNER (the list was not provided; readme rule 4 — do not invent) |
| 5 | Only 2/7 targets re-run | OPEN (repro incomplete) |
| 6 | libFuzzer logs/cov dumps not committed | OPEN |
| 7 | Non-determinism of exec/cov counters | OPEN (inherent) |

## Program level (not from the audits; residual plan + the 2026-08-28 audit)

| Demand | Status |
|---|---|
| TLA audits ×2 (C3) | CLOSED `bdb5733f3` (c3-adversary 89/100, c3-repro 93/100, same-agent); an external re-run — OPEN |
| Kani-repro audit | CLOSED `bdb5733f3` (93/100, same-agent); an external re-run — OPEN |
| C7 wave-2: runtime decoders + A2 regression + long run | OPEN (interrupted by the provider quota; in progress) |
| C8: a dedicated artifact (report/SHA/commands/cardinality) + 2 audits, or removal from the matrix | OPEN (the matrix already honestly says "❌ not proven as C8" — WAVE-2026-08-28) |
| FX-1/FX-2 manifest inside the mixed `64b41da54` | CLOSED `935020a41` (files: `core/account/tx/admission-policy.ts`, `core/account/input/peer-rejection.ts`, `rscore engine consensus/frame/hash.rs`, `consensus/replica.rs`, `error.rs`, `lib.rs`, tests `core/__tests__/proofs/fx-admission.test.ts`, `engine/tests/fx_admission.rs`) |
| English sources for proofs/** (`check:english-source` red) | CLOSED by this commit (all proofs/** prose translated; the gate re-run is green) |
| folder-width gate | CLOSED on the audited worktree: `FOLDER_WIDTH_OK dirs=7022 sourceFiles=3738 max=10/10`; the current grandfathered debt is `jurisdictions/contracts:16,scripts/dev:12`, not `test/foundry` |
| Final `bun run check` | OPEN: 2026-08-28 stopped at `ESLINT_DEBT_CHANGED expected=341/... actual=343/...`; the proof-only diff does not touch ESLint debt — a clean candidate is needed |
| C9/C10 (trace refinement, crash-cutpoint) | phase 2 |
