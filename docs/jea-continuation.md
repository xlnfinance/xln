# J/E/A implementation handoff — 2026-09-30

## Current SHA

Read `git rev-parse HEAD` for this documentation commit. The verified implementation
baseline is `1d39fe8e6caa5a5d6873001c57e687a3c8eb5626`, on `main`.
All earlier code and Markdown changes are already committed:

- `5d89c1ebb`: J/E/A terminology, MML = accounts supporting 51% of world GDP
  provable by 2050, accepted timing policy and wallet walkthrough requirements.
- `66aa3f827`: ordinary stateful EVM XLNC design, strict transformer failure
  semantics and pinned [provable-account research](research/provable-account-mechanisms.md).
- `0b25d54ca`: TS/Rust secret-ACK deadlines preserve the signed enforcement
  reserve; bounded retry deferral; real-RPC `htlc-ack-recovery`; stateful paid-gas
  Besu prototype; maximum mixed-proof gas regression.
- `1d39fe8e6`: ScenarioPlayer reads canonical persistent Account maps and stops
  Runtime-owned J adapters; local AI paths use the current home/workspace.
  E2E follows hydrated incident hooks, explicit Closed-order history, current
  MML docs, chronological RCPAN playback and completed real AI answers.
  The hot-shard W1/W8 test uses the existing 30-second eight-worker budget.
  The ownership map shrank from 329 to 102 lines.

## Last green command

`bun run check` passed at the implementation baseline, with local Cargo/Foundry
available on PATH. Frozen core was unchanged; frontend had 0 errors/0 warnings.
The following evidence is dated to that baseline, not a future release:

- Canonical Chromium E2E: 138/138 unique targets, 97 functional + 41 resilience,
  0 skipped or flaky tests. Full catalog runs and focused reruns were combined;
  this was not one uninterrupted full-suite run.
- Payments, same-J/cross-J swaps, market-maker cases and recovery are included.
  The six-user routing stand covers 18 cases; repeated swap cycles retain all
  economic assertions. The final rebuilt ScenarioPlayer E2E also passed.
- Real AI is one additional assistant test using installed `gpt-oss:20b` through
  the production proxy. Related scenario units: 6/6, 66 assertions.

## First red command / error

The maximum mixed defensive-finalization vector
`test_gas_mixedDefensiveFinalizeWithMaxAccountDimensions` in
`jurisdictions/test/foundry/stress/BatchBounds.t.sol` used 17,363,517 execution
gas plus intrinsic gas. It exceeds its 15M assertion and the prototype's 6M
block ceiling. The normal `check:contract-invariants` gate runs
`DepositoryInvariants`, not this stress contract; its green result does not close
the XLNC capacity blocker. Do not raise the assertion to manufacture a pass.

## Artifact path

[Committed E2E evidence](evidence/jea-20260930/e2e.json) identifies every target,
successful run/report path, implementation SHA and both build fingerprints.
The final cleanup change is separately bound to its rebuilt player regression.
Detailed local runs remain under `.logs/e2e-parallel/`; those generated stacks
and upstream source checkouts are not source files to commit.

The original [Raiden account findings](research/archive/20260930/raiden-account-findings.md)
are preserved against their older `5d89c1ebb` baseline. Their fixed 120-second
scheduler observation predates the committed deadline correction.
XLNC's first green prototype artifact is
`/tmp/xlnc-stateful-paid-gas-evidence/evidence.json`; later restart repeats timed out.

## Next single command

Ensure Cargo/Foundry are available and check `bun run stand:status` first.
Reproduce the first failing capacity boundary under the canonical stand lease:

```sh
bun core/scripts/e2e/runners/run-with-test-cleanup.ts --reason=xlnc-proof-envelope --child-cwd=jurisdictions --keep-test-artifacts -- forge test --match-contract BatchBounds --match-test test_gas_mixedDefensiveFinalizeWithMaxAccountDimensions -vv
```

## Remaining final gates

Resolve the real owner choice between XLNC execution capacity and enforceable
Account admission before changing either. Solidity changes require synchronized
artifacts and explicit bytecode/hash review; never approve frozen core yourself.
Then prove complete deadline-safe recovery/payout under congestion, correlated
remedy inclusion, full-verifier restart/catch-up and phone resource budgets.
The automatic exposure schedule and wallet walkthrough remain governed by
[launch-design.md](launch-design.md) and [wallet-journey-plan.md](wallet-journey-plan.md).
Do not claim a billion TPS, mainnet readiness or GDP coverage from these E2E runs.
Keep root `todo.md` as the only live checklist; follow `AGENTS.md` before execution.
