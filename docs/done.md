# Done Log

## 2026-03-09

### E2E

- Added isolated two-user swap coverage in [tests/e2e-swap-isolated.spec.ts](/Users/egor/xln/tests/e2e-swap-isolated.spec.ts).
- The test uses separate browser contexts and separate wallet storage, disables market-maker liquidity, and proves:
  - Alice and Bob trade against each other directly through one hub.
  - capacities move on both sides after `swap_resolve`
  - the resolved state survives page reload on both wallets
- Verified pass log:
  - [/Users/egor/xln/.logs/e2e-parallel/20260309-034300-652/e2e-shard-00.log](/Users/egor/xln/.logs/e2e-parallel/20260309-034300-652/e2e-shard-00.log)

### Deploy / Ops

- Restored a tracked root deploy entrypoint in [deploy.sh](/Users/egor/xln/deploy.sh).
- Fixed package scripts in [package.json](/Users/egor/xln/package.json) so `bun run deploy*` points to the same root deploy wrapper.
- Removed `deploy.sh` from `.gitignore` so the deployment entrypoint lives in the repo instead of silently drifting locally.

### Dead Code Removed

- Deleted unused helper [tests/utils/playwright-helpers.ts](/Users/egor/xln/tests/utils/playwright-helpers.ts) after confirming there were no references.

### Runtime / Frontend Readability

- Added a runtime folder map in [runtime/README.md](/Users/egor/xln/runtime/README.md).
- Added a frontend lib folder map in [frontend/src/lib/README.md](/Users/egor/xln/frontend/src/lib/README.md).
- Added a strict cleanup plan in [docs/code-cleanup-plan.md](/Users/egor/xln/docs/code-cleanup-plan.md) that separates:
  - proven removals
  - high-confidence candidates that still need one more proof pass
  - structural moves that should wait until the dirty runtime consensus files are settled
