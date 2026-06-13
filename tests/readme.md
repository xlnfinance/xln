# xln test strategy

This directory contains the browser-facing tests and shared Playwright helpers. The current source of truth is the layered gate model below, not the removed proof-suite layout.

## Layers

| Layer | Purpose | Command |
| --- | --- | --- |
| L1 unit/component | Pure or near-pure runtime/frontend/native checks with no browser stack. Use for orderbook, serialization, storage projections, recovery builders, guards. | `bun test runtime/__tests__ tests/unit tests/frontend native/__tests__` |
| L2 runtime scenarios | Deterministic runtime behavior through scenario execution, including non-network and isolated RPC/relay paths. Use when behavior crosses entity/account/jurisdiction boundaries. | `bun run test:scenarios:parallel:isolated` |
| L3 browser e2e | Real user flows in Playwright against isolated local stacks. Use for clicks, onboarding, payments, swaps, disputes, recovery, custody. | `bun run test:e2e:fast` |
| L4 contracts | Solidity jurisdiction contracts and runtime/contract proof compatibility. | `bun run test:contracts:full` |

## Daily Commands

```bash
bun run check
bun run test
bun run test:e2e:fast
```

For one browser flow:

```bash
bun runtime/scripts/run-e2e-parallel-isolated.ts \
  --pw-project=chromium \
  --pw-files='tests/e2e-swap-isolated.spec.ts::two isolated users trade against each other through one hub orderbook without market maker liquidity' \
  --video=off --trace=off --screenshot=only-on-failure --max-failures=1
```

For one runtime scenario:

```bash
bun runtime/scenarios/run.ts dispute-lifecycle
bun runtime/scenarios/run.ts --set=smoke --workers=4
```

For one contract area:

```bash
cd jurisdictions && bunx hardhat test --grep DeltaTransformer
```

## Test Placement

- Put user-click coverage in `tests/e2e-*.spec.ts`.
- Put shared Playwright operations in `tests/utils/`.
- Put runtime behavior without browser clicks in `runtime/scenarios/`.
- Put isolated runtime units in `runtime/__tests__/`.
- Put frontend pure utility tests in `tests/frontend/`.
- Put contract tests in `jurisdictions/test/`.

## Policy

- Prefer the full e2e flow first when adding a user-visible feature.
- After a slow e2e exposes a bug, add the shortest deterministic regression below it: runtime scenario if the bug crosses machines, unit/component if the bug is local.
- Keep Playwright assertions user-visible where possible. Use runtime debug reads only to prove consensus, persistence, or chain state that the UI cannot faithfully expose.
- Do not add silent skips. `runtime/__tests__/test-skip-discipline.test.ts` enforces this.
- Always run `bun run check` before reporting completion.

## Current Fast Gates

- `bun run test` runs quick all-tests: smoke scenarios plus one focused E2E path.
- `bun run test:e2e:fast` runs the canonical isolated browser flow set from `runtime/scripts/run-e2e-fast.ts`.
- `bun run gate:quick` runs source checks, selected runtime/native tests, soundcheck, and whitespace checks.
- `bun run gate:ci` adds frontend check, contracts, persistence/watchtower smoke, coverage markers, and fast E2E.
- `bun run gate:release` adds soak, core E2E, RPC scenarios, storage benchmark, and production health smoke.
