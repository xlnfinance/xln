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
H3 clamp) and the contract changes the coordinator accepted, flagged in QUESTIONS.md: the window floor above LAG (C11), tolerant
dispute ops in a batch (J2), a failed batch that takes its nonce (J5, with the deposit and bad-signature refinements). og is a reference, never the oracle.

## Layout

| file | what it is |
|---|---|
| `account.qnt` | Account layer: the state machine (propose, receive, ack, resend, loss) over `account_core.qnt`, and its properties |
| `account_test.qnt` | scenario tests: exact schedules with exact expected results |
| `chain.qnt` | J layer for one Account: reserves, collateral, epoch, debt (a queue of claims owed to the other side or to a third party), the dispute game (start, counter, three finalize paths), payout, settlement debt forgiveness |
| `chain_test.qnt` | scenario tests for the dispute game: stale start, tie-break, C1 epoch, the implicit proof of an epoch (R-IMPLICIT-BASELINE: start, outrank, the tie trap, deposits, non-canonical bodies), N3 windows never shorten, H1 wait, H2 floor, debt (third-party claims paid out first), settlement debt forgiveness (R-SETTLE-FORGIVE: heads of both queues, revert only when nothing was forgiven, the id cap, no repeats), deposits, absent party |
| `settle.qnt` | off-chain epoch lifecycle over `chain.qnt`: Pay and Lock frames, the N1 pause, the cooperative update (folds the offdelta), the first signed proof of an epoch at stored + 2 |
| `settle_test.qnt` | scenario tests: pause while locked, the next epoch opens with no ceremony, first proof at stored + 2 (the trap refused), dead-epoch payment, update dies with a finalize |
| `account_core.qnt` | the pure part of the Account layer (types, transition table, replica rules); `account.qnt` and `entity.qnt` build on it |
| `entity.qnt` | Entity layer: a hub with two Accounts, the four-phase frame, routing, fail back, escalation, commands |
| `entity_test.qnt` | scenario tests: forward with margin, fail back at once, escalation, secrets, late reveal, arrivals first, freeze, commands, collisions |
| `jbatch.qnt` | J layer, the Entity's batch: strict nonce, atomic revert, urgent ops, forks and nonce burning, what a lost batch holds |
| `jbatch_test.qnt` | scenario tests: payment lands, urgent behind a payment, fork winners, moved dispute, reverted payment kept, signed batch lands later, deposit legs revert whole, stale settlement fails soft, forged and out-of-order batches |
| `runtime.qnt` | Runtime layer: canonical frame order, idle gate, exactly-once J watching, durable before send, crash and restart |
| `runtime_test.qnt` | scenario tests: three-step frame, crash before and after durable, chain event across a crash, canonical order |
| `dispute.qnt` | the dispute lifecycle as a whole: both Entities' chain facts (own start, the dispute against me, my answer), the chain's dispute record, frames in flight, a crash and a transient revert, over a proof that is its nonce; four switches (FREEZE, LIVE, ACCEPT, NOTICE) for the fixes decided or owed, and PAY for the payment path across an epoch move; properties `newest_wins`, `no_lock`, `no_silent_zeroing`, `pay_once`; `dispute_today.qnt` ... `dispute_all.qnt`, `dispute_pay.qnt`, `dispute_paydrop.qnt`, `dispute_payall.qnt` fix them |
| `dispute_test.qnt` | fifteen scenario tests, one per audit finding or mutant (stale start countered, frame after the counter, counter lapses, starter never finalizes, nothing newer, finalize gap, sealed before the start, both start, a signed frame refused and sealed again, a rolled-back frame sealed again, a committed frame acked late, the epoch move stores and rebases, a counter that lands after its window, a counter registered by the watchtower), each run under every switch variant |
| `htlc.qnt` | an HTLC hold across a dispute on a route of two Accounts (payer, hub, payee): the payee's release by frame or the secret on the chain, the finalize that pays or refunds a carried hold, the epoch move, the upstream lock's expiry; four switches (SEE: the chain reveal is a chain fact the paybook uses; DISSOLVE: holds in a finalized proof are dissolved at the epoch move; ARGS: the watcher reads a secret in a dispute's arguments, #167; HIDE: the payee can relay its finalize through a contract the watcher cannot decode) and the invariant that the hub never pays out more than it collects (`paid_once`, `route_safe`) |
| `htlc_test.qnt` | twelve scenario tests (release by frame, the unheard chain reveal F1, the release after the finalize F2, refund, late reveal, release then dispute, finalize after the upstream expiry, a claim that needs room, a secret in the start's arguments, a secret in the payee's finalize, the same finalize relayed through a contract, the payer cannot expire the upstream lock before TU), each run under the switch variants (today, see, dissolve, both, hop0, noargs, wrapped) |
| `params_test.qnt` | the numbers the layers share (LAG, REACT, windows, HOP, ESC) and the entity's deadline arithmetic played on the real dispute game |
| `compose.qnt` | the Account layer meets the chain: every RCPAN Body in a small domain and every outcome of its open clauses, settled by the chain's own `payout` (credit holds on the chain, collateral conserved) |
| `mutants/` | deliberately broken copies of the spec; every property must kill its mutants (`mutants/run.py <module>`) |
| `traces/` | ITF traces (Quint's JSON trace format) for replay against another spec |
| `OVERVIEW.md` | the spec in one read: layers, data flow, state machines, properties, what it asks of the contracts |
| `QUESTIONS.md` | every unclear point, the options, the choice made, the source |
| `PROGRESS.md` | what is done per layer and what is next, for a successor after a context reset |
| `check.sh` | everything that must pass before a change (it also fails on a `run` without the `Test` suffix, which `quint test` would skip) |

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
| P4a | agreed: two sides never commit different bodies at one height, except that with a Byzantine peer a later frame whose rank (nonce * 2 + leftAuthored) is above the earlier commit's supersedes it, as the chain ranks them (A12) | `agreed` |
| P4b | no equivocation: a signer never signs two different proofs for one (nonce, branch) | `no_equivocation` |
| P4c | both sign the same proof: at each side's head, both signatures over the proof of the committed body exist | `both_signed` |
| P4d | a frame is held for an ack only if a correct receiver would accept it (state replays on its own tip and clock, next height, proof nonce above the last) | `no_bad_accept` |
| P4e | a committed frame never spends the other side's funds, raises its own credit, or expires a lock early (R-CLOCK) | `authority` |
| P4f | the proof nonce is its own counter, above the last committed, skipping only nonces a signed proof occupies (N1, A18, A19) | `nonce_climbs` |
| P4g | R-PROOF-NONCE-ABOVE-SIGNED: no proof signed in the epoch outranks the committed head (rank = nonce * 2 + leftAuthored), a yielded or refused attempt included, except the head's own proofs and live proposals on it (A19) | `signed_above_head` |
| P4h | R-SIGNED-IS-LIVE: no lock's notice is released while a signed proof that no commit superseded still holds the lock, unless its deadline plus the reserve has passed (A20) | `no_release_while_signed_live` |
| P4i | R-PROOF-NONCE-ABOVE-SIGNED, the floor a refusal carries: an honest refuser's floor is at most one above what the proposer knows signed (A19) | `refusal_floor_reachable` |
| P4j | R-COSIGN-FREEZE: while a side is frozen by a co-signed fold, its head's offdelta is the fold's and it has no frame in flight (A21) | `cosign_fold_holds` |

The Account model runs a Byzantine side (one key taken at any moment): P4c to P4g are checked on the honest side only. Each of the
independent oracles (`netOf`, `own`/`creditFor`, `creditHolds`, `wellFormed`) states the rule on the effect, not through the guard it checks.

P1 (a dispute pays what both sides believed) and P3 (money is conserved) need the chain and belong to `chain.qnt`.
