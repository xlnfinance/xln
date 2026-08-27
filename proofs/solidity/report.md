# C4: Foundry invariants and Halmos lemmas for `jurisdictions/`

## Claim and scope

The tests cover value conservation, transformer allowances, Entity nonce
monotonicity, Hanko thresholds, and ordered hash-ladder slots on the current
contract bytecode. Claims are bounded by the stated fuzz and symbolic models.
No Solidity production source was changed.

Pinned source: `80924b035f363d4ad8f4a8c08e6f39dcc7736a78`.
Toolchain: Forge 1.7.1, solc 0.8.36 (`via_ir`, optimizer runs 1, Cancun),
Halmos 0.3.3 with Yices 2.6.4.

## Hardening wave 2 (2026-08-26, closes c4-adversary A1-A7)

Scope: test/handler files only; `jurisdictions/contracts/**` untouched
(`bun run frozen-core:check` → FROZEN CORE UNCHANGED, root hash
`0x4eccf4...391946a7`). The two pre-existing frozen failures stay as-is and
remain byte-identical (DebtChunking `200 != 0` gas 18264323; BatchBounds
`15,049,243 >= 15,000,000` gas 15398422).

New/changed files:

- `DebtLifecycle.invariants.t.sol` + `handlers/DebtLifecycleHandler.sol` (new)
- `TransformerFaultModes.t.sol` (new)
- `SettlementDeltasHarness.sol`: `run` untouched (Halmos lemma paths);
  added `runWithArguments` and `runTwoDeltas`
- `TransformerAllowance.{invariants.t.sol,Handler.sol}`: `repayDebt` action,
  fault-mode dispute control
- `HashLadder.{invariants.t.sol,Handler.sol}`: asymmetric windows,
  `closeDispute`, invalid-witness branch
- `HalmosLemmas.t.sol`: `check_gateZeroConcrete` artifact

Per-gap closure:

- **A1/A3 (HIGH, debt lifecycle unreachable / forgiveness never executed):**
  the new DebtLifecycle handler GENERATES debts — dispute starts/finalizations
  whose signed delta exceeds collateral+spendable (both shortfall branches),
  enforced repayment (public `enforceDebts`, capped/uncapped/partial),
  and cooperative settlements with non-empty `forgiveDebtsInTokenIds`
  including the third-party-FIFO-head E2 rejection. Final fuzz run of the
  128×64 gate: 9 disputes started / 7 finalized / 7 debts created / live
  debt > 0 on both tokens / partial enforcements and forgiveness
  settlements executed.
- **A2 (HIGH, duplicate debt invariant):**
  `invariant_debtNeverEntersValuePool` now READS debt state: per-token pool
  identity with debts present, Σ real `debtOutstanding` == ghost live debt,
  plus pool-move and foreign-creation counters. Alongside:
  `invariant_debtBooksMirrorGhost` (element-wise FIFO queue, cursor,
  active-count equality against an independently simulated ghost mirroring
  `Account.enforceDebts` including `delete queue[cursor]` zeroing both
  fields, and the O(1) cursor-head forgiveness of
  `Depository.sol:833-858`) and `invariant_debtLifecycleFlowsBalance`
  (created == live + repaid + forgiven). Sensitivity metas fire both ways
  (corrupted chain slot; corrupted ghost).
- **A4 (MEDIUM, transformer fault modes unused):** all six
  TransformerLivenessHarness fault modes now have foundry coverage through
  the real `Account.prepareSettlementDeltas` bytecode — with and without
  allowance, each failing CLOSED with a real revert (never the tolerated
  gas artifact). Multi-index bodies with partial allowances (two deltas,
  allowance only on the untouched index → gate reverts; allowance on the
  changed index → executes/clamps). The argument-decoder path
  (`Account.sol:1096-1110`) executes with well-formed, malformed, oversized
  (2^18 bound, edge 2^18−1), reverting, and codeless decoders: malformed
  wrappers soft-decode to empty evidence while the gate/clamp hold; a
  codeless decoder is fail-fast (empty success → strict decode reverts). A
  processBatch-level control starts a RevertCall-clause dispute, proves it
  cannot finalize (non-starter immediately, starter after timeout), and
  closes it only through a newer counterparty-signed pull-free state that
  still clamps exactly (1100+5000 → 1150).
- **A5 (MEDIUM, symmetric windows neuter side selection):** windows are now
  LEFT=50 / RIGHT=70. The handler's window oracle uses the WRITER's own
  side, `invariant_windowsAndWitnessesAreSound` checks every live dispute
  stored the windows on the correct `AccountInfo` fields, and a
  deterministic control proves at t=S+60 the RIGHT-side writer is accepted
  while the LEFT-side writer is not. `closeDispute` finalizes live disputes
  so "dispute closed → first Source write is E12" executes (attempted in
  fuzz via `closedDisputeSourceAttempts`), and fuzzed registrations
  sometimes corrupt the witness so the E9 forgery branch is exercised
  (acceptance would be an invariant violation).
- **A6 (MEDIUM, clamp oracle blind after first shortfall):** the
  TransformerAllowance handler gained `repayDebt` (admin mint + uncapped
  `enforceDebts`), so `clean` recovers after a shortfall finalize and clamp
  observation resumes; final gate run showed a debt repair with clamp
  observations continuing across it.
- **A7 (LOW, uncommitted gas-artifact repro):** `check_gateZeroConcrete`
  is now committed in HalmosLemmas.t.sol: forge PASSES (the gate at
  Account.sol:996-1000 reverts with `TransformerExecutionFailed`, never the
  tolerated selector) while halmos FAILS with a counterexample because
  symbolic `gasleft()` makes `TransformerGasBudgetUnavailable`
  (Account.sol:887) feasible — the artifact justifying the single-selector
  tolerance, now reproducible from the tree. A warning documents that the
  tolerance is single-clause/empty-arguments-only (≥2 clauses or a decoder
  site would legitimately emit the selector).

Gates (2026-08-26):

- `forge test --match-path 'test/foundry/*'`: **99 passed, 2 failed** — the
  two pre-existing frozen failures only (35 → 24 new/extended green tests:
  75 → 99 passing).
- Halmos `--loop 20 --solver-timeout-assertion 120s`: **5/5 lemmas PASS**
  (paths 97 / 1016 / 4 / 17 / 2; drift consistent with prior runs);
  `check_gateZeroConcrete`: expected halmos FAIL (artifact) / EVM PASS.

## Reproduction

```bash
cd jurisdictions
forge test --match-path 'test/foundry/*'
forge test --match-path 'test/foundry/DepositoryConservation.invariants.t.sol'
forge test --match-path 'test/foundry/TransformerAllowance.invariants.t.sol'
forge test --match-path 'test/foundry/HankoThreshold.invariants.t.sol'
forge test --match-path 'test/foundry/HashLadder.invariants.t.sol'
forge test --match-path 'test/foundry/HalmosLemmas.t.sol'
forge test --match-path 'test/foundry/DebtLifecycle.invariants.t.sol'
forge test --match-path 'test/foundry/TransformerFaultModes.t.sol'

halmos --match-test 'allowanceGate' --loop 20 --solver-timeout-assertion 120s
halmos --match-test 'clampExact' --loop 20 --solver-timeout-assertion 120s
halmos --match-test 'orderedPairIsolation' --loop 20 --solver-timeout-assertion 120s
halmos --match-test 'rootRoundTrip' --loop 20 --solver-timeout-assertion 120s
halmos --match-test 'nibbleReconstruct' --loop 20 --solver-timeout-assertion 120s
# Expected FAIL (the gas artifact itself):
halmos --match-test 'gateZeroConcrete' --loop 20 --solver-timeout-assertion 120s
```

## Foundry properties

### Value conservation and replay

- For each modeled token, Entity reserves plus bilateral collateral equals
  minted value plus external backing after every accepted operation sequence.
- Every accepted batch changes the internal value pool by exactly the external
  token transfer; rejected batches change nothing.
- Debt is a claim, not an asset, and never enters the conserved value pool
  (wave 2: with debts actually created, repaid, and forgiven in-model).
- An accepted Entity nonce advances exactly once. Replaying the last accepted
  `(batch, Hanko, nonce)` is always rejected.

Model: four lazy entities, three tokens, mixed R2R/R2C/C2R/settlement,
deposit, withdrawal, and flash-loan batches. Result: 128 runs × depth 64,
all invariants pass. Sabotage tests prove that the conservation and nonce
oracles fail when their ghost state is deliberately corrupted.

### Debt lifecycle (wave 2)

- Real shortfall debts exist: dispute finalizations beyond
  collateral+spendable book exactly the predicted uncovered remainder
  against the correct creditor.
- Debt books agree with an independent FIFO ghost simulation element-wise:
  `debtOutstanding == Σ live queue`, active count, cursor, and per-entry
  `(creditor, amount)` equality; a fully enforced entry zeroes both fields
  (`delete queue[cursor]`), a forgiven head keeps its creditor.
- Forgiveness is exactly the O(1) cursor-head when the head belongs to the
  settlement counterparty; a third-party head fails the whole settlement
  (E2) and survives.
- Enforcement (public, chunked, capped, uncapped) pays from reserve, keeps
  books exact, and never moves the value pool; `spendable` is invariant
  under enforcement.
- Flow conservation: created == live + repaid + forgiven.

### Transformer allowances

- A finalized transformer cannot move a delta without the corresponding
  allowance (per-index, including partial-allowance subsets across two
  deltas).
- An allowed change equals the exact signed clamp to the permitted band.
- Finalization preserves total reserves plus collateral.
- Fault modes (RevertCall, ExhaustGas, ShortReturn, WrongLength,
  MalformedReturn, ReturnBomb) fail closed with a real revert — with or
  without allowance — and a faulted dispute only ever closes through a
  newer counterparty-signed pull-free state (wave 2).
- Argument-decoder path: well-formed wrappers decode through the strict
  decoder; malformed/oversized wrappers soft-decode to empty evidence while
  the gate and clamp hold; a codeless decoder is fatal (wave 2).

The deterministic controls prove both rejection without allowance and exact
clamping of an oversized requested value.

### Hanko threshold

- No accepted proof has ECDSA-backed voting power below its threshold.
- The first member of every accepted claim is an EOA signature/placeholder,
  never a nested claim.
- Unsatisfiable and nested-first constructions are rejected; valid canonical
  constructions are accepted.

### Hash-ladder slots

- `(revealer, counterparty, ladder, role)` is ordered; writing A→B never writes
  B→A.
- Source reveals are single-shot and exact retries are sticky no-ops.
- Target reveals never decrease and equal/higher publication refreshes time.
- A first Source write is accepted only inside the active response window —
  under ASYMMETRIC windows (LEFT=50/RIGHT=70), so window side-selection is
  observable: the writer's own side governs, the stored windows sit on the
  correct AccountInfo fields, a closed dispute re-enables the E12 branch,
  and invalid witnesses are rejected (wave 2).

## Halmos results

| Lemma | Paths | Time | Result |
|---|---:|---:|---|
| allowance gate | 97 | 0.79s | pass |
| exact allowance clamp | 1016 | 10.88s | pass |
| ordered-pair isolation | 4 | 0.18s | pass |
| hash-ladder root round trip | 17 | 0.45s | pass |
| nibble reconstruction | 2 | 0.00s | pass |
| gate-zero concrete (artifact) | 4 | 0.15s | **expected fail** |

Path counts vary slightly across builds. No 120-second solver timeout fired.
Halmos models `gasleft()` symbolically, so the harness permits only the exact
`TransformerGasBudgetUnavailable` artifact. Concrete EVM controls show that
this branch is unreachable with the configured 300M gas limit; wave 2 commits
the reproducer (`check_gateZeroConcrete`: halmos FAIL / EVM PASS) and
documents that the tolerance is single-clause/empty-arguments-only.

## Final result and existing issues

- Wave 2 hardening: **99 tests pass** in the broad Foundry run (75 before);
  Halmos: **5/5 lemmas pass**. The broad run's two pre-existing frozen-test
  failures are unchanged:
  - `BatchBounds::test_gas_maxReserveToCollateralProduct` uses 15,049,243 gas,
    slightly above its 15,000,000 budget.
  - `DebtChunking::test_forgivenessAfterPartialEnforcementKeepsBooksExact`
    expects one settlement to drain three FIFO debt entries, while production
    intentionally forgives one cursor-head entry per settlement.
- Historical-batch replay beyond the latest accepted batch and the deep
  1024×128 profile remain coverage extensions, not claims of this report.
