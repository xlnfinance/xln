# proofs/bugs.md — unified bug register of the proof wave

Statuses: FIXED-ON-MAIN (commit) / OWNER-DECISION (spec ready, consensus needs
the owner) / CONDITIONAL (model-level finding, production reachability not
proven) / TRIAGE (hygiene, not consensus) / PARALLEL (closed by the owner's
parallel tasks).

## FIXED-ON-MAIN

| ID | Bug | Source | Severity | Fix |
|---|---|---|---|---|
| BUG-01 | TS silently distorts `policyVersion > 2^53` (2^53 and 2^53+1 → identical canonical bytes; Rust refused) → cross-engine frame-hash divergence | C1 enc-diff | **HIGH** (distortion of a monetary parameter without a trace) | FX-1: one range `0..2^53-1`, typed reject at admission in both engines + hash tripwires; commit `64b41da54` |
| BUG-02 | `lending_*`/`reserve_to_collateral`: TS executed and hashed, Rust `UnsupportedFrameTx` → the cross-engine account wedged | C1 enc-diff | MED | FX-2: loud typed reject in both directions, no TS fallback; commit `64b41da54` |
| BUG-03 | A conflicting `j_event_claim` passed enqueue without validation and killed `proposeAccountFrame` with a bare `throw` → permanent account wedge | C2 hot-vs-cold (F1), confirmed by hardening tests, reading the shared admission planner, and the re-audit `proofs/audits/c2-repro/report.md` (`b043199fe`) | **HIGH** (availability, wedge) | FX-3: shared admission planner (admit/duplicate/conflict) in both engines, typed reject/drop of the single row, the account continues; 5 vectors; commit `190b778e9` |
| BUG-04 | OOM amplification in the storage-msgpack decoder: `Vec::with_capacity(up to 2M)` from a wire claim before the remainder check; nested markers → hundreds of MiB from tens of bytes | C7-adversary (A2), confirmed by reading the code | MED (DoS on an adversarial restore input) | Guard `require_fits_input` (array ≥1 byte/element, map ≥2) in `rscore/crates/runtime/src/codec/storage_msgpack.rs:66,130,140`; commit `64b41da54` |

## OWNER-DECISION (spec ready, consensus requires the owner)

| ID | Bug | Source | Severity | Status |
|---|---|---|---|---|
| BUG-05 | **Conditional rollback-duplicate finding:** the TLA model yields a Rust(reject) same-height standoff and a TS(continue) orphan pending only after the abstract `DeliverPartial`. Safety (Agreement/AckDurability) is not violated. In the current TS and Rust the transition is published through one atomic WAL boundary; persisting `lastRollbackFrameHash` without the winning commit has not been shown | C3 TLA+; `proofs/tla/report.md` explicitly leaves production reachability open | **UNKNOWN; HIGH if the cutpoint is reachable** | First C10/crash-cutpoint or a storage-mapping proof. Only if reachable — an owner decision on the FX-4 candidate; until then "a bug in both engines" must not be claimed |
| BUG-06 | `addHold`/`releaseHold` — the divergence is TWO-SIDED (extended by kani-adversary A3): (a) TS rejects any negative amount, Rust accepts a negative one if the result stays in range; (b) TS has no uint256 ceiling, Rust rejects > 2^256 | C5 Kani + kani-adversary A3, verified (`hold-utils.ts:10-31` vs `delta.rs:167-190`) | LOW ((b) astronomically unreachable; (a) — a transition-semantics divergence) | Canonicalize the semantics in both engines (recommendation: negative = reject always + a uint256 ceiling everywhere). AWAITING DECISION |
| BUG-07 | Book `event_hash`: mixes only the low 32 bits of price/qty, LCG mod 2^53; part of the book commitment | our own Rust audit | LOW-MED (collisions reachable without malice at price > 2^32 ticks; the pages-root pins the content) | Owner ruled: a coordinated protocol/domain bump of both engines, not now |
| BUG-08 | BatchBounds: worst-case gas 15,049,243 ≥ the 15M liveness budget (R2C 4×64) | c4-repro/c4-adversary (pre-existing, frozen) | MED (on-chain liveness budget) | Raise the budget or optimize the path — an owner decision |
| BUG-13 | An unregistered tokenId (registry 1..5, protocol ≤65535) with derivable collateral → `TOKEN_METADATA_UNAVAILABLE` throw inside the Entity commit boundary (`PersistentEntityAccountMap.updated`) — the whole commit halts | C2-hardening (C2-H1), verified (`core/account/utils.ts:209`) | MED (availability; the state is protocol-valid yet kills the boundary) | Canonicalize: an admission restriction to registered tokens OR a total lookup with a default policy. AWAITING DECISION |
| BUG-14 | Conflicting `cross_pull_lock`s (same pullId, different bytes) pass enqueue (fingerprint dedup is exact-bytes only) → the proposal hits the intentional `halt_runtime` `CROSS_J_PULL_LOCK_PROPOSAL_FAILED` instead of a typed row reject | C2-hardening (C2-H2), verified (`transactions.ts:239`) | MED (availability, the F1 family) | Same D4 policy: a pullId-conflict admission validator + row drop at proposal. AWAITING DECISION |
| BUG-09 | DebtChunking: the test expects one settlement to clear 3 debts vs the O(1) single-cursor-head forgiveness design (Depository.sol:833-858); the books agree, the money is intact | reclassified by c4-repro, confirmed by us | INFO (test vs design) | Fix the test expectation or change the design to a full drain (gas risk) |

## TRIAGE (hygiene, not consensus)

| ID | Bug | Source | Severity |
|---|---|---|---|
| BUG-10 | `decode_account_tx` accepts non-minimal BigInt text (`"085..."`) — a round-trip gap at the exported boundary; the envelope is spelling-indifferent | C7 (F1), reproduced by c7-repro | MED-LOW |
| BUG-11 | `decode_value`/`encode_value` nesting budget off-by-one (depth 32 decodes, the encoder refuses at +1) | C7 (F2) | LOW |
| BUG-12 | `read_body_tuple` reserves `arity×32B` before reading — a public-API footgun up to ~128MB | C7 (O1) | LOW |

## PARALLEL (closed by the owner's tasks, confirmed)

- `sync_pair_index` O(N) rebuild on an order mutation; `BookPricePageTree::tail()` linear scan (our audit, Rust regressions).
- Re-ACK re-signing → memoized Hanko (D6); the `commitment.rs` canonical rename (D1).

## NON-BUGS (documented refinements)

- Conservation in/out is unconditional only under the covered-transfer precondition (Kani C5).
- Halmos 0.3.3 symbolic `gasleft()` → a false branch (documented, selector tolerance).
- Rollback-duplicate is NOT a bilateral-safety bug in the TLA model; the
  liveness/lost-tx defects are conditional on the `DeliverPartial` fault not
  yet mapped to production — see BUG-05.
