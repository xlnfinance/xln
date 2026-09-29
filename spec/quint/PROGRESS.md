# Progress: Quint spec

Handoff format: what is done per layer, what is next, how to pick up.

## Status

| layer | file | state |
|---|---|---|
| Account | `account.qnt` | v1 done: two parties, one token, credit, HTLC clauses, frame protocol with collision, resend, loss. 14 scenario tests, invariants P2 and P4a-c by simulation, 14 mutants killed |
| J / contracts, disputes | `chain.qnt` | v1 done: one Account, one token: reserves, collateral, ondelta, epoch (C1), debt, secret registry, dispute start / counter / three finalize paths, H1 wait, H2 floor, payout with shortfall. 22 scenario tests, P1 P3 by simulation, 26 mutants killed. J latency: the honest side answers REACT = 2 * LAG after an event (C11). Apalache: see Evidence |
| Entity | `entity.qnt` | v1 done: a hub with two Accounts, both peers adversarial: the four-phase frame, routing with the deadline arithmetic, fail back, escalation and secret publication, freeze on a dispute, atomic commands, collisions. 20 scenario tests, 11 properties by simulation, 20 mutants killed. Several inputs per frame (E1); own start and the peer's beside it (E12). Simulation only (one state record) |
| J batch | `jbatch.qnt` | v1 done: the Entity's batch over the chain's strict nonce and atomic revert; urgent ops, forks, nonce burning, what a lost batch holds. 10 scenario tests, 9 properties by simulation, 10 mutants killed. J2 accepted (tolerant dispute ops, with the `DisputeOpSkipped` event the Entity reads); F1 (a signed batch is final at its nonce) is the Entity's rule; J5 accepted (a failed batch takes its nonce and emits `BatchFailed`, which the Entity reads) |
| Runtime | `runtime.qnt` | v1 done: canonical frame order, idle gate, exactly-once J watching, durable before send, crash and restart, the halt taxonomy. 8 scenario tests, 4 properties by simulation, 8 mutants killed; every event kind is read (R7) |
| Settlement, epoch | `settle.qnt` | v1 done: the off-chain epoch lifecycle over `chain.qnt`: Pay / Lock / Rebase frames, N1 pause, the update (cooperative settlement) with C3 nonce floor, presign+fold vs rebase mode. 15 scenario tests, 6 properties by simulation, 20 mutants killed. S3 closed: presign+fold, the baseline rides every frame at nonce + 3 |

## Evidence

- `./check.sh` from `spec/quint/`: typecheck, 14 scenario tests, `safe` over 500 traces of 40 steps, all 6 witnesses reached.
- `MUTANTS=1 ./check.sh` or `python3 mutants/run.py account`: 14 of 14 killed (7 by invariant, 7 by scenario test).
- Apalache: `quint verify account.qnt --invariant credit_holds --max-steps 3` does not finish inside 250 s at the
  default bounds (`quint verify` reaches "State 3" after ~8 minutes). The Account frame protocol needs about 9 steps to
  reach a collision, so it is checked by simulation, not by Apalache. Apalache is for the smaller models that follow.
- `MODULES=chain ./check.sh`: typecheck, 22 scenario tests, `safe` over 1500 traces of 16 steps (~22 s), 7 witnesses reached.
  `MUTANT_STEPS=14 MUTANT_SAMPLES=2000 python3 mutants/run.py chain`: 26 of 26 killed (12 by invariant, 14 by scenario test; the last four: window floor below REACT, REACT longer than the windows, no publish tolerance, publish not forced).
- `MODULES=settle ./check.sh`: typecheck, 15 scenario tests, `wsafe` (chain's `safe` plus `no_dead_commit`, `no_lost_pay`,
  `claims_conserved`, `book_enforceable`, `hostage_free`, `baseline_clears`) over simulated traces of 25 steps, all settle witnesses reached.
  `MUTANT_STEPS=25 MUTANT_SAMPLES=1500 python3 mutants/run.py settle`: 20 of 20 killed (6 by invariant, 14 by scenario test).
  One invariant hunt (`forged-baseline-invariant`) needs 20000 traces of 30 steps: the schedule that reaches it is long.
- `MODULES=entity ./check.sh`: typecheck, 20 scenario tests, `safe` (no_peer_halt, no_stranded, deadline_chain, dispute_carries_all,
  no_needless_dispute, no_frame_on_frozen, cmd_atomic, credit_holds, route_safe, answer_in_window, skip_ends_the_wait) over 500 traces of 25 steps, 12 witnesses reached.
  `python3 mutants/run.py entity`: 20 of 20 killed (6 by invariant, 14 by scenario test).
- `params_test.qnt` (runs first in `check.sh`): LAG, REACT, DWIN, HOP, ESC agree across chain, entity and jbatch; the hub's deadline arithmetic
  pays the hub with the margin (`hopMarginPaysTheHubTest`) and loses without it (`noMarginLosesTheHubTest`) on the real dispute game.
- `MODULES=jbatch ./check.sh`: typecheck, 10 scenario tests, `safe` (urgent_lands, dropped_only_dead, skip_read, failed_read, nonce_final, pay_once, urgent_once, nonce_sequential,
  reserve_sound) over 500 traces of 25 steps, 6 witnesses reached; also 20000 traces of 30 steps, seed 3 (after F1 and the skip event), no violation.
  `MUTANT_STEPS=25 MUTANT_SAMPLES=3000 python3 mutants/run.py jbatch`: 10 of 10 killed.
  Apalache, `quint verify jbatch.qnt --init init --step step --invariant safe --max-steps 4`: no violation in 585 s on the first version; again on the current one (skip event, F1, J5, `failed_read`): no violation in 284 s, all 9 properties. A run to 6 steps is not recorded yet.
  Found while writing it: an older, smaller batch signed for one nonce burns the nonce of the fresher batch (J3), which F1 now rules out by signing every replacement at a fresh nonce; and F1 in turn makes a reverting payment hold every urgent op behind it, which J5 (a failed batch takes its nonce) removes: with `NONCE_ON_FAIL = false` (the contract today) `urgent_lands` is violated within a second of simulation.
- `MODULES=runtime ./check.sh`: typecheck, 8 scenario tests, `safe` (no_equivocation, exactly_once_j, acked_durable, canonical_frames) over 500 traces
  of 30 steps, 6 witnesses reached. `python3 mutants/run.py runtime`: 8 of 8 killed (7 by invariant, 1 by scenario test).
- Apalache on `chain.qnt`, `quint verify chain.qnt --init init --step step --invariant safe --max-steps 6`: did not get past step 1
  in 12 minutes (java at 9.5 GB resident) and was killed. A copy with `NREC = 7` (before the J latency change) held all six
  invariants through state 2 in about 14 minutes and was stopped there. Apalache is not the instrument for the dispute game; simulation with
  mutants is, and its limits are the sampled trace count and length stated above.
- Tools: `@informalsystems/quint` 0.33.0, Apalache 0.62.1 (fetched by `quint verify`), Java 21. The rust
  simulator backend cannot be fetched (`Release v0.7.0 not found: Failed to fetch from GitHub: Forbidden`); use
  `--backend typescript`.

## Independence log

Neither spec reads the other. Four leaks, all harmless but recorded:
1. At session start the harness put the team memory `spec-language-arrival-vs-quint` into my context by relevance
   retrieval. I did not open it or act on it. It describes the Arrival page's scope (account frames, order and both-sides
   properties, three planted bugs).
2. After a context reset the continuation loaded the content of that memory file into my context (a Read result). I have
   now seen it: it says Arrival is the proposed main spec, and lists what its Account page covers. Nothing in
   `account.qnt` or `chain.qnt` was derived from it, and both were written before the reset. Recorded so the comparison
   can discount it.
3. My first shell command listed `spec/` once, which showed the directory names of the Arrival spec (`account`,
   `arrival`, `lib`, `mcp`). I have not opened anything there.
4. At 2026-09-29 ~21:00Z relevance retrieval put the same memory file into my context again, in a newer version. It says the
   Arrival spec now has a page per layer (account frames, money, dispute, Entity consensus, Entity frame, J batch, Runtime tick,
   routing) with planted bugs, and names some of its rule numbers and state counts. I did not use it: everything in this
   spec after that point (DisputeOpSkipped, F1, J5, `failed_read`) came from the coordinator's relays and the sources under `plan/`
   and `contracts/`. Recorded so the comparison can discount it.

## Next

1. Account + chain with real Account histories instead of the arena (the joint state of the hub's two Accounts and the chain, beyond the
   interface and the shared numbers of `params_test.qnt`).
2. Entity: several routes per slot and a free-slot rule (E7), an offline Entity.
3. Apalache on the J modules (`jbatch`, `runtime`, `settle`) where it finishes; v2 models (proposals are in V2.md).
4. Contract-side items: J5 (a failed batch takes its nonce, `BatchFailed`), C11 (window floor above LAG) and J2 (tolerant dispute ops in a batch) accepted by the coordinator 2026-09-29; the contracts thread changes J2 test-first. The chain fact E6 is pinned on the real contracts (#47).

## Pick-up command

`cd spec/quint && npm install && ./check.sh`
