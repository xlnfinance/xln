# Progress: Quint spec

Handoff format: what is done per layer, what is next, how to pick up.

## Status

| layer | file | state |
|---|---|---|
| Account | `account.qnt` | v1 done: two parties, one token, credit, HTLC clauses, frame protocol with collision, resend, loss; a Byzantine side (forged state, skipped height, stamps, stale or leaping proof nonce, wrong ack); R-CLOCK (own clock decides, `CLOCK_RESERVE`); the proof nonce is its own counter (N1). 36 scenario tests, 7 properties by simulation, 45 mutants, all killed |
| J / contracts, disputes | `chain.qnt` | v1 done: one Account, one token: reserves, collateral, ondelta, epoch (C1), debt, secret registry, dispute start / counter / three finalize paths, H1 wait, H2 floor, payout with shortfall, N3 frozen windows over unequal windows. Independent checks on the outcome: payout amounts (`pay_exact`), deposits, windows, nonces. 29 scenario tests, 11 properties by simulation, 46 mutants, all killed. A dispute start that names a dead ondelta epoch is skipped. J latency: the honest side answers REACT = 2 * LAG after an event (C11). Apalache: see Evidence |
| Entity | `entity.qnt` | v1 done: a hub with two Accounts, both peers adversarial: the four-phase frame, routing with the deadline arithmetic, fail back, escalation and secret publication, freeze on a dispute, atomic commands, collisions. 25 scenario tests, 11 properties by simulation, 23 mutants, all killed. Several inputs per frame (E1); own start and the peer's beside it (E12); the onward lock takes the lowest free OUT slot (E7); expiry waits for the reserve (R-CLOCK); `MAX_LOCK_HORIZON` (N2). Simulation only (one state record) |
| J batch | `jbatch.qnt` | v1 done: the Entity's batch over the chain's strict nonce and atomic revert; urgent ops, forks, nonce burning, what a lost batch holds. 30 scenario tests, 14 properties by simulation, 28 mutants, all killed. Signed gas budget (relay 2026-09-30: under budget reverts with no nonce; inside it every failure is `BatchFailed`), the Runtime's gate rule and gas-cap split (J7). J2 accepted (tolerant dispute ops, with the `DisputeOpSkipped` event the Entity reads); F1 (a signed batch is final at its nonce) and F2 (after an abort only urgent ops go back at once; a payment waits until the abandoned batch's nonce is used) are the Entity's rules; J5 accepted (a failed batch takes its nonce and emits `BatchFailed`), refined by the #54 review: deposit legs revert whole, a bad counterparty signature is a soft fail, a forged hanko reverts without a nonce; an adversarial relayer sends any batch in any order |
| Runtime | `runtime.qnt` | v1 done: canonical frame order, idle gate, exactly-once J watching, durable before send, crash and restart, the halt taxonomy. 8 scenario tests, 4 properties by simulation, 8 mutants killed; every event kind is read (R7) |
| Account to chain | `compose.qnt` | every RCPAN Body in a small domain and every outcome of its open clauses, settled by the chain's `payout`: credit holds on the chain, collateral conserved (C12). 3 tests, 3 mutants |
| Settlement, epoch | `settle.qnt` | v1 done: the off-chain epoch lifecycle over `chain.qnt`: Pay / Lock / Rebase frames, N1 pause, the update (cooperative settlement) with C3 nonce floor, presign+fold vs rebase mode. 15 scenario tests, 6 properties by simulation, 20 mutants killed. S3 closed: presign+fold, the baseline rides every frame at nonce + 3 |

## Evidence

Everything below was run on the head this file is committed with. `MUTANT_*` settings are the `mutants/run.py` environment.

- `./check.sh` from `spec/quint/` (all modules, `SAMPLES=500`): params 3 tests, compose 3 tests; per module typecheck, scenario tests, `safe` by simulation, witnesses each violated.
- Account: 36 scenario tests, `safe` (credit_holds, agreed, no_equivocation, both_signed, no_bad_accept, authority, nonce_climbs) over 1500 traces of 40 steps, 8 witnesses reached.
  `MUTANT_STEPS=40 MUTANT_SAMPLES=1500 python3 mutants/run.py account`: 44 of 44 killed (25 by scenario test, 19 by invariant).
- Chain: 29 scenario tests, `safe` (11 properties) over traces of 16 steps, all witnesses reached. `MUTANT_STEPS=16 MUTANT_SAMPLES=1500 python3 mutants/run.py chain`: 46 of 46 killed (24 by scenario test, 22 by invariant;
  as named in `mutants/chain.json`; boundary and signature rules are pinned by scenario tests because the simulation reaches them too rarely once the windows vary).
- Settle: 15 tests, `wsafe` over 500 traces of 25 steps, all witnesses reached. `MUTANT_STEPS=25 MUTANT_SAMPLES=1500 python3 mutants/run.py settle`: 20 of 20 killed.
- Entity: 25 tests, `safe` over 500 traces of 25 steps, all witnesses reached (expiry waits for `CLOCK_RESERVE`). `MUTANT_STEPS=25 MUTANT_SAMPLES=1500 python3 mutants/run.py entity`: 23 of 23 killed.
- J batch: 30 scenario tests, `safe` (14 properties) over 1500 traces of 25 steps, witnesses reached (`w_no_hostage` is not reachable by simulation: the scenario test is the evidence).
  `MUTANT_STEPS=25 MUTANT_SAMPLES=3000 python3 mutants/run.py jbatch`: 22 of 22 killed (9 by scenario test, 13 by invariant).
  Apalache, `quint verify jbatch.qnt --init init --step step --invariant safe --max-steps 4`, on the version at 966d62c (before the deposit-simulation rule): every invariant holds at states 0 to 3, no violation anywhere,
  and the run reached only part of state 4 before the 3300 s timeout: **not a complete depth-4 check**. The run before R-COSIGN stopped the same way at 2400 s. Older claims of "no violation in 442 s" were for smaller versions.
- Runtime: 8 tests, `safe` over 500 traces of 30 steps, witnesses reached. `MUTANT_STEPS=30 MUTANT_SAMPLES=1500 python3 mutants/run.py runtime`: 8 of 8 killed.
- Apalache on `account.qnt` does not finish at depth 3; on `chain.qnt` it does not get past step 1 in 12 minutes. Simulation with mutants is the instrument there, and its limits are the trace counts above.
- Found by the model while doing this round, all recorded in QUESTIONS.md: A12 (a peer that acks and then equivocates leaves the sides on different bodies; closed by the chain's Left-wins rank), A13 (a free proof-nonce gap lets an abandoned proposal outrank the committed frame),
  J6 (a deposit batch that cannot land holds the urgent ops behind it; accepted with the simulate-first rule), and the earlier J3, F1, J5 interplay.
- Tools: `@informalsystems/quint` 0.33.0, Apalache 0.62.1 (fetched by `quint verify`), Java 21. The rust simulator backend cannot be fetched; use `--backend typescript`.

## Independence log

Neither spec reads the other. Five leaks, all harmless but recorded:
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
5. At the continuation of 2026-09-29 (evening) the harness loaded the team memory index (`MEMORY.md`) into my context. It has lines about the Arrival side:
   "Arrival deep dive" draft PR #41 with 8 pages, that its review said properties must be checked end to end and not by construction, and the spec rules sent to both sides. I did not
   open the Arrival spec or the memory file behind it. The review of PR #44 had already said the same about my own properties, from the reviewer's reading of this spec alone, and the
   fixes here (independent oracles, a Byzantine proposer, mutants that name the rule) follow that review and the coordinator's relays, not the memory line. Recorded so the comparison can discount it.

## Next

1. Account + chain: the link is checked as a predicate over Bodies (`compose.qnt`, C12); a joint state machine of the hub's two Accounts and the chain is still not built.
2. Entity: an offline Entity.
3. Apalache on the J modules (`jbatch`, `runtime`, `settle`) where it finishes; v2 models (proposals are in V2.md).
4. Contract-side items: J5 (a failed batch takes its nonce, `BatchFailed`), C11 (window floor above LAG) and J2 (tolerant dispute ops in a batch) accepted by the coordinator 2026-09-29; the contracts thread changes J2 test-first. The chain fact E6 is pinned on the real contracts (#47).

## Pick-up command

`cd spec/quint && npm install && ./check.sh`
