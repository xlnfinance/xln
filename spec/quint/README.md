# XLN protocol spec in Quint

A complete, machine-checked spec of the XLN protocol layers (Account, Entity, J, Runtime) written in
[Quint](https://quint-lang.org). It is written **independently of the Arrival spec** under `../`: nothing in this
directory is derived from it, and it must not read it until the coordinator says both specs are complete. Differences
between the two will then be analysed to find unclear points.

Where a rule is unclear, this spec picks the reading the sources best support and writes the choice down in
[QUESTIONS.md](QUESTIONS.md): the point, the options, the choice, the source.

## Sources

`plan/lessons.md` (rules R-*, questions Q-*, bugs B-*), `plan/xln-inventory.md`, `plan/vision.md`,
`plan/contracts-review.md` (flaws C1, C2, H1-H3), `plan/contracts-decisions.md`, `design/account-model.md`,
`pure/xln.ts`, and the forked contracts under `contracts/` with their encoding vectors. The contracts are ours; this
spec describes the **fixed** contracts (ondelta epoch, entity-bound batch payload, H1 finalize wait, H2 window floor,
H3 clamp) and takes two contract changes as proposals, flagged in QUESTIONS.md: the window floor above LAG (C11) and tolerant
dispute ops in a batch (J2). og is a reference, never the oracle.

## Layout

| file | what it is |
|---|---|
| `account.qnt` | Account layer: the state machine (propose, receive, ack, resend, loss) over `account_core.qnt`, and its properties |
| `account_test.qnt` | scenario tests: exact schedules with exact expected results |
| `chain.qnt` | J layer for one Account: reserves, collateral, epoch, debt, the dispute game (start, counter, three finalize paths), payout |
| `chain_test.qnt` | scenario tests for the dispute game: stale start, tie-break, C1 epoch, H1 wait, H2 floor, debt, deposits, absent party |
| `settle.qnt` | off-chain epoch lifecycle over `chain.qnt`: Pay, Lock and Rebase frames, the N1 pause, the cooperative update, baseline nonce floor |
| `settle_test.qnt` | scenario tests: pause while locked, presign vs rebase, forged baseline, dead-epoch payment, update dies with a finalize |
| `account_core.qnt` | the pure part of the Account layer (types, transition table, replica rules); `account.qnt` and `entity.qnt` build on it |
| `entity.qnt` | Entity layer: a hub with two Accounts, the four-phase frame, routing, fail back, escalation, commands |
| `entity_test.qnt` | scenario tests: forward with margin, fail back at once, escalation, secrets, late reveal, arrivals first, freeze, commands, collisions |
| `jbatch.qnt` | J layer, the Entity's batch: strict nonce, atomic revert, urgent ops, forks and nonce burning, what a lost batch holds |
| `jbatch_test.qnt` | scenario tests: payment lands, urgent behind a payment, fork winners, moved dispute, reverted payment kept, signed batch lands later |
| `runtime.qnt` | Runtime layer: canonical frame order, idle gate, exactly-once J watching, durable before send, crash and restart |
| `runtime_test.qnt` | scenario tests: three-step frame, crash before and after durable, chain event across a crash, canonical order |
| `params_test.qnt` | the numbers the layers share (LAG, REACT, windows, HOP, ESC) and the entity's deadline arithmetic played on the real dispute game |
| `compose.qnt` | the Account layer meets the chain: every RCPAN Body in a small domain and every outcome of its open clauses, settled by the chain's own `payout` (credit holds on the chain, collateral conserved) |
| `mutants/` | deliberately broken copies of the spec; every property must kill its mutants (`mutants/run.py <module>`) |
| `traces/` | ITF traces (Quint's JSON trace format) for replay against another spec |
| `OVERVIEW.md` | the spec in one read: layers, data flow, state machines, properties, what it asks of the contracts |
| `QUESTIONS.md` | every unclear point, the options, the choice made, the source |
| `PROGRESS.md` | what is done per layer and what is next, for a successor after a context reset |
| `check.sh` | everything that must pass before a change |

## Running

```
cd spec/quint && npm install          # installs quint 0.33; Apalache is fetched on the first `verify`
./check.sh                            # typecheck, scenario tests, invariants and witnesses by simulation
MUTANTS=1 ./check.sh                  # also kill every mutant
./node_modules/.bin/quint verify account.qnt --invariant credit_holds --max-steps 3    # Apalache, bounded
```

Use `--backend typescript` for `quint run` and `quint test`. The default rust evaluator is downloaded from GitHub
releases and the sandbox proxy refuses it: `Release v0.7.0 not found: Failed to fetch from GitHub: Forbidden`.
Apalache and Java 21 work.

## How to read a module

1. **Domain types first**: `Body`, `Tx`, `Frame`, `Status`. They are the vocabulary.
2. **Pure transition functions**: `applyTx`, `replay`, `onPropose`, `commit`. Every refusal is a value (`Refused(why)`);
   nothing halts a Runtime.
3. **Actions**: thin wrappers that add the guard and thread the variables. Each has a scripted form taking exact
   arguments (used by tests) and a nondeterministic form (used by `quint run` / `verify`).
4. **Properties**: named `val`s at the bottom, and `safe` = all of them. `w_*` witnesses are false on purpose: each
   must be violated by some trace, which proves the path they name is reachable.

## Encoding rules (so that Apalache can check the module)

- Collections with a small fixed key set are maps over that set (locks by slot, signatures by
  `(signer, nonce, branch)`), never sets of records.
- A nondeterministic tx is built from small independent picks (`mkTx`), never drawn from a set of variants.
- State is a handful of separate variables. One record holding everything makes the checker's input exceed
  Apalache's 20 MB RPC limit (`String value length (20051112) exceeds the maximum allowed (20000000)`).
- Frames live in an arena and messages carry frame ids, as the wire carries hashes.
- Ghost variables (`equivocated`, `diverged`) record a violation at the moment the protocol would cause it, so an
  invariant is a single boolean.

## Properties (what "correct" means here)

| id | property | module |
|---|---|---|
| P2 | credit holds: every committed and in-flight state satisfies RCPAN in the worst case over open clauses | `credit_holds` |
| P4a | agreed: two sides never commit different bodies at one height | `agreed` |
| P4b | no equivocation: a signer never signs two different proofs for one (nonce, branch) | `no_equivocation` |
| P4c | both sign the same proof: at each side's head, both signatures over the proof of the committed body exist | `both_signed` |

P1 (a dispute pays what both sides believed) and P3 (money is conserved) need the chain and belong to `chain.qnt`.
