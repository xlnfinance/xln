# C4: Foundry invariants and Halmos lemmas for `jurisdictions/`

## Claim and scope

The tests cover value conservation, transformer allowances, Entity nonce
monotonicity, Hanko thresholds, and ordered hash-ladder slots on the current
contract bytecode. Claims are bounded by the stated fuzz and symbolic models.
No Solidity production source was changed.

Pinned source: `80924b035f363d4ad8f4a8c08e6f39dcc7736a78`.
Toolchain: Forge 1.7.1, solc 0.8.36 (`via_ir`, optimizer runs 1, Cancun),
Halmos 0.3.3 with Yices 2.6.4.

## Reproduction

```bash
cd jurisdictions
forge test --match-path 'test/foundry/*'
forge test --match-path 'test/foundry/DepositoryConservation.invariants.t.sol'
forge test --match-path 'test/foundry/TransformerAllowance.invariants.t.sol'
forge test --match-path 'test/foundry/HankoThreshold.invariants.t.sol'
forge test --match-path 'test/foundry/HashLadder.invariants.t.sol'
forge test --match-path 'test/foundry/HalmosLemmas.t.sol'

halmos --match-test 'allowanceGate' --loop 20 --solver-timeout-assertion 120s
halmos --match-test 'clampExact' --loop 20 --solver-timeout-assertion 120s
halmos --match-test 'orderedPairIsolation' --loop 20 --solver-timeout-assertion 120s
halmos --match-test 'rootRoundTrip' --loop 20 --solver-timeout-assertion 120s
halmos --match-test 'nibbleReconstruct' --loop 20 --solver-timeout-assertion 120s
```

## Foundry properties

### Value conservation and replay

- For each modeled token, Entity reserves plus bilateral collateral equals
  minted value plus external backing after every accepted operation sequence.
- Every accepted batch changes the internal value pool by exactly the external
  token transfer; rejected batches change nothing.
- Debt is a claim, not an asset, and never enters the conserved value pool.
- An accepted Entity nonce advances exactly once. Replaying the last accepted
  `(batch, Hanko, nonce)` is always rejected.

Model: four lazy entities, three tokens, mixed R2R/R2C/C2R/settlement,
deposit, withdrawal, and flash-loan batches. Result: 128 runs × depth 64,
all invariants pass. Sabotage tests prove that the conservation and nonce
oracles fail when their ghost state is deliberately corrupted.

### Transformer allowances

- A finalized transformer cannot move a delta without the corresponding
  allowance.
- An allowed change equals the exact signed clamp to the permitted band.
- Finalization preserves total reserves plus collateral.

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
- A first Source write is accepted only inside the active response window.

## Halmos results

| Lemma | Paths | Time | Result |
|---|---:|---:|---|
| allowance gate | 95 | 0.80s | pass |
| exact allowance clamp | 953 | 10.44s | pass |
| ordered-pair isolation | 4 | 0.71s | pass |
| hash-ladder root round trip | 17 | 0.48s | pass |
| nibble reconstruction | 2 | 0.00s | pass |

Path counts vary slightly across builds. No 120-second solver timeout fired.
Halmos models `gasleft()` symbolically, so the harness permits only the exact
`TransformerGasBudgetUnavailable` artifact. Concrete EVM controls show that
this branch is unreachable with the configured 300M gas limit.

## Final result and existing issues

- The new suites: **35/35 tests pass**. Halmos: **5/5 lemmas pass**.
- The broad Foundry run had 75 passes and two pre-existing frozen-test failures:
  - `BatchBounds::test_gas_maxReserveToCollateralProduct` uses 15,049,243 gas,
    slightly above its 15,000,000 budget.
  - `DebtChunking::test_forgivenessAfterPartialEnforcementKeepsBooksExact`
    expects one settlement to drain three FIFO debt entries, while production
    intentionally forgives one cursor-head entry per settlement.
- Historical-batch replay beyond the latest accepted batch and the deep
  1024×128 profile remain coverage extensions, not claims of this report.
