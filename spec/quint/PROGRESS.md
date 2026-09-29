# Progress: Quint spec

Handoff format: what is done per layer, what is next, how to pick up.

## Status

| layer | file | state |
|---|---|---|
| Account | `account.qnt` | v1 done: two parties, one token, credit, HTLC clauses, frame protocol with collision, resend, loss. 14 scenario tests, invariants P2 and P4a-c by simulation, 14 mutants killed |
| J / contracts, disputes | `chain.qnt` | v1 done: one Account, one token: reserves, collateral, ondelta, epoch (C1), debt, secret registry, dispute start / counter / three finalize paths, H1 wait, H2 floor, payout with shortfall. 19 scenario tests, P1 P3 by simulation, 20 mutants killed. Apalache: see Evidence |
| Entity | `entity.qnt` | v1 done: a hub with two Accounts, both peers adversarial: the four-phase frame, routing with the deadline arithmetic, fail back, escalation and secret publication, freeze on a dispute, atomic commands, collisions. 14 scenario tests, 9 properties by simulation, 16 mutants killed. Simulation only (one state record) |
| Runtime | `runtime.qnt` | not started |
| Settlement, epoch | `settle.qnt` | v1 done: the off-chain epoch lifecycle over `chain.qnt`: Pay / Lock / Rebase frames, N1 pause, the update (cooperative settlement) with C3 nonce floor, presign+fold vs rebase mode. 13 scenario tests, 6 properties by simulation, 18 mutants killed. S3 (hostage window) closed: presign+fold adopted |

## Evidence

- `./check.sh` from `spec/quint/`: typecheck, 14 scenario tests, `safe` over 500 traces of 40 steps, all 6 witnesses reached.
- `MUTANTS=1 ./check.sh` or `python3 mutants/run.py account`: 14 of 14 killed (7 by invariant, 7 by scenario test).
- Apalache: `quint verify account.qnt --invariant credit_holds --max-steps 3` does not finish inside 250 s at the
  default bounds (`quint verify` reaches "State 3" after ~8 minutes). The Account frame protocol needs about 9 steps to
  reach a collision, so it is checked by simulation, not by Apalache. Apalache is for the smaller models that follow.
- `MODULES=chain ./check.sh`: typecheck, 19 scenario tests, `safe` over 1500 traces of 16 steps (~22 s), 7 witnesses reached.
  `MUTANT_STEPS=14 MUTANT_SAMPLES=2000 python3 mutants/run.py chain`: 20 of 20 killed (6 by invariant, 14 by scenario test).
- `MODULES=settle ./check.sh`: typecheck, 13 scenario tests, `wsafe` (chain's `safe` plus `no_dead_commit`, `no_lost_pay`,
  `claims_conserved`, `book_enforceable`, `hostage_free`, `baseline_clears`) over simulated traces of 25 steps, all settle witnesses reached.
  `MUTANT_STEPS=25 MUTANT_SAMPLES=1500 python3 mutants/run.py settle`: 18 of 18 killed (7 by invariant, 11 by scenario test).
  One invariant hunt (`forged-baseline-invariant`) needs 20000 traces of 30 steps: the schedule that reaches it is long.
- `MODULES=entity ./check.sh`: typecheck, 14 scenario tests, `safe` (no_peer_halt, no_stranded, deadline_chain, dispute_carries_all,
  no_needless_dispute, no_frame_on_frozen, cmd_atomic, credit_holds, route_safe) over 500 traces of 25 steps, 11 witnesses reached.
  `python3 mutants/run.py entity`: 16 of 16 killed (4 by invariant, 12 by scenario test).
- Apalache on `chain.qnt`, `quint verify chain.qnt --init init --step step --invariant safe --max-steps 6`: did not get past step 1
  in 12 minutes (java at 9.5 GB resident) and was killed. A copy with `NREC = 7`: see the line below when it ends.
- Tools: `@informalsystems/quint` 0.33.0, Apalache 0.62.1 (fetched by `quint verify`), Java 21. The rust
  simulator backend cannot be fetched (`Release v0.7.0 not found: Failed to fetch from GitHub: Forbidden`); use
  `--backend typescript`.

## Independence log

Neither spec reads the other. Three leaks, all harmless but recorded:
1. At session start the harness put the team memory `spec-language-arrival-vs-quint` into my context by relevance
   retrieval. I did not open it or act on it. It describes the Arrival page's scope (account frames, order and both-sides
   properties, three planted bugs).
2. After a context reset the continuation loaded the content of that memory file into my context (a Read result). I have
   now seen it: it says Arrival is the proposed main spec, and lists what its Account page covers. Nothing in
   `account.qnt` or `chain.qnt` was derived from it, and both were written before the reset. Recorded so the comparison
   can discount it.
3. My first shell command listed `spec/` once, which showed the directory names of the Arrival spec (`account`,
   `arrival`, `lib`, `mcp`). I have not opened anything there.

## Next

1. Compose entity and chain (E6): the hub's dispute against the real dispute game, so "a clause pays iff revealed by the deadline" is
   checked and not assumed; then account + chain with real Account histories instead of the arena.
2. `jbatch` (J batch lifecycle and failure), `runtime.qnt` (delivery, clock, halt taxonomy, J watching).
3. Entity: several routes per slot and a free-slot rule (E7), several inputs per frame (E1), an offline Entity.
4. v2 proposals: order book, lending, boards.

## Pick-up command

`cd spec/quint && npm install && ./check.sh`
