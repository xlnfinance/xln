# Progress: Quint spec

Handoff format: what is done per layer, what is next, how to pick up.

## Status

| layer | file | state |
|---|---|---|
| Account | `account.qnt` | v1 done: two parties, one token, credit, HTLC clauses, frame protocol with collision, resend, loss. 14 scenario tests, invariants P2 and P4a-c by simulation, 14 mutants killed |
| J / contracts, disputes | `chain.qnt` | next |
| Entity frame | `entity.qnt` | not started |
| Runtime | `runtime.qnt` | not started |
| Settlement, epoch | `settle.qnt` | not started (relay N1) |

## Evidence

- `./check.sh` from `spec/quint/`: typecheck, 14 scenario tests, `safe` over 500 traces of 40 steps, all 6 witnesses reached.
- `MUTANTS=1 ./check.sh` or `python3 mutants/run.py account`: 14 of 14 killed (7 by invariant, 7 by scenario test).
- Apalache: `quint verify account.qnt --invariant credit_holds --max-steps 3` does not finish inside 250 s at the
  default bounds (`quint verify` reaches "State 3" after ~8 minutes). The Account frame protocol needs about 9 steps to
  reach a collision, so it is checked by simulation, not by Apalache. Apalache is for the smaller models that follow.
- Tools: `@informalsystems/quint` 0.33.0, Apalache 0.62.1 (fetched by `quint verify`), Java 21. The rust
  simulator backend cannot be fetched (`Release v0.7.0 not found: Failed to fetch from GitHub: Forbidden`); use
  `--backend typescript`.

## Independence log

Neither spec reads the other. Two leaks, both harmless but recorded:
1. At session start the harness put the team memory `spec-language-arrival-vs-quint` into my context by relevance
   retrieval. I did not open it or act on it. It describes the Arrival page's scope (account frames, order and both-sides
   properties, three planted bugs).
2. My first shell command listed `spec/` once, which showed the directory names of the Arrival spec (`account`,
   `arrival`, `lib`, `mcp`). I have not opened anything there.

## Next

1. `chain.qnt`: the Depository for one Account and one token (reserve, collateral, ondelta, nonce, epoch, debt),
   R2C, cooperative settlement, dispute start, counter, finalize, payout, debt. Fixed contracts: C1 epoch, C2 entity in
   batch, H1 finalize waits for an open HTLC, H2 window floor, H3 retired-board clamp. Apalache is the checker.
   Properties: P1 payout equals belief, P3 conservation, epoch kills old proofs. Mutants for each contract flaw.
2. Compose account + chain: the honest watcher strategy, and check P1 against real Account histories.
3. `entity.qnt`: the frame pipeline (receive, hooks, fold, propose), J batch lifecycle and failure.
4. `runtime.qnt`: delivery, clock, halt taxonomy, J watching.
5. `settle.qnt`: N1 (epoch pause), Q-A1 account open, N3 windows.

## Pick-up command

`cd spec/quint && npm install && ./check.sh`
