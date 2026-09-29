# Progress: Quint spec

Handoff format: what is done per layer, what is next, how to pick up.

## Status

| layer | file | state |
|---|---|---|
| Account | `account.qnt` | v1 done: two parties, one token, credit, HTLC clauses, frame protocol with collision, resend, loss. 14 scenario tests, invariants P2 and P4a-c by simulation, 14 mutants killed |
| J / contracts, disputes | `chain.qnt` | v1 done: one Account, one token: reserves, collateral, ondelta, epoch (C1), debt, secret registry, dispute start / counter / three finalize paths, H1 wait, H2 floor, payout with shortfall. 19 scenario tests, P1 P3 by simulation, 20 mutants killed. Apalache: see Evidence |
| Entity frame | `entity.qnt` | not started |
| Runtime | `runtime.qnt` | not started |
| Settlement, epoch | `settle.qnt` | not started (relay N1) |

## Evidence

- `./check.sh` from `spec/quint/`: typecheck, 14 scenario tests, `safe` over 500 traces of 40 steps, all 6 witnesses reached.
- `MUTANTS=1 ./check.sh` or `python3 mutants/run.py account`: 14 of 14 killed (7 by invariant, 7 by scenario test).
- Apalache: `quint verify account.qnt --invariant credit_holds --max-steps 3` does not finish inside 250 s at the
  default bounds (`quint verify` reaches "State 3" after ~8 minutes). The Account frame protocol needs about 9 steps to
  reach a collision, so it is checked by simulation, not by Apalache. Apalache is for the smaller models that follow.
- `MODULES=chain ./check.sh`: typecheck, 19 scenario tests, `safe` over 1500 traces of 16 steps (~22 s), 7 witnesses reached.
  `MUTANT_STEPS=14 MUTANT_SAMPLES=2000 python3 mutants/run.py chain`: 20 of 20 killed (6 by invariant, 14 by scenario test).
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

1. Apalache on `chain.qnt` (running; see Evidence), then compose account + chain: real Account histories instead of
   the arena, so P1 is checked against what the frame protocol can produce.
2. `settle.qnt` first, before Entity: cooperative settlement, C2R, N1 epoch pause, the nonce floor of a new epoch (C3
   in QUESTIONS.md). The chain's epoch bump is only half of C1 until the Account side stops signing for a dead epoch.
3. `entity.qnt`: the frame pipeline (receive, hooks, fold, propose), J batch lifecycle and failure.
4. `runtime.qnt`: delivery, clock, halt taxonomy, J watching.
5. `settle.qnt`: N1 (epoch pause), Q-A1 account open, N3 windows.

## Pick-up command

`cd spec/quint && npm install && ./check.sh`
