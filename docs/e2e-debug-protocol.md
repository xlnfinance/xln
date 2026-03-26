# E2E Debug Protocol

Goal: identify the first real failure quickly, avoid chasing noise, and keep fixes narrow.

## Rules

1. Run one top-level isolated runner at a time.
2. Always use a unique `--base-port` if another run may still exist.
3. Do not use `--skip-build` after frontend changes.
4. Do not start with a full-suite rerun after the first failure. First isolate the failing surface.
5. Treat the first failing shard and first failing assertion as primary. Everything after that is usually fallout.

## Failure Classification

Every failure must be classified before any patch:

- `build`: stale preview assets, missing selectors, wrong generated frontend bundle
- `runner`: bad `pw-files` or `pw-grep`, wrong shard targeting, port collision
- `boot`: stack never becomes healthy, `MM_EXITED_EARLY`, API health timeout
- `runtime`: bad state transition, wrong balances, wrong orderbook, nonce drift
- `ui`: selector drift, modal drift, wrong tab state, stale render
- `contract`: ABI mismatch, event mismatch, on-chain revert

If classification is not explicit, stop and classify first.

## Standard Flow

### 1. First Pass

Run the narrowest honest command:

```bash
bun runtime/scripts/run-e2e-parallel-isolated.ts --shards=8 --workers-per-shard=1 --base-port=20000 --video=off --trace=off --screenshot=only-on-failure --max-failures=1
```

Then read only:

- `E2E Summary`
- first failing shard log
- Playwright `error-context.md`
- failed screenshot

Ignore later shards until the first failure is understood.

### 2. Determine Phase

Use the summary phases:

- `health=0 vite=0 pw=0` means boot/orchestration failure
- `vite>0 pw=0` means preview or harness failure
- `pw>0` means actual test/runtime/ui failure

This cuts most wasted time.

### 3. Reproduce Narrowly

Only after classification:

- same file, fresh build, isolated stack
- same file with a different `--base-port`
- never parallelize two top-level runners on the same default port range

If targeted reproduction uses `pw-files` or `pw-grep`, verify the runner is not rewriting file targets into `file:line` incorrectly.

## Mandatory Artifact Review

For any failing Playwright test:

1. Read `error-context.md`
2. Read the last 150 lines of the shard log
3. Read the screenshot
4. Read the related runtime debug dump if the test prints one
5. Check whether the UI state already proves success and the test is waiting on stale UX

Example: orderbook fill completed, order moved to `Closed/Filled`, but test still waited on an optional modal. That is a test bug, not an engine bug.

## Boot Failure Protocol

If `health=0` or `MM_EXITED_EARLY`:

1. Search the shard log for the first runtime error, not the last one.
2. Search for:

```bash
rg -n "MM_EXITED_EARLY|initial reset failed|Too many open swap offers|revert|throw|FAILED" <log>
```

3. If the failure is in setup/reset, debug setup code first, not the product UI.
4. If all shards fail before Playwright starts, it is not a frontend selector bug.

## Product vs Test Decision

Use this rule:

- if balances/state/orderbook/proof are wrong, fix product code
- if the page already shows the desired terminal state and the test waits on optional UI, fix the test
- if only stale assets are served, rerun without `--skip-build`
- if targeting is wrong, fix the runner

## Narrow Patch Rule

Do not redesign while debugging.

Allowed:

- fix one selector
- fix one readiness gate
- fix one runtime invariant
- fix one runner targeting bug

Not allowed during triage:

- broad refactors
- unrelated cleanup
- speculative “improvements”

## Verification Ladder

After each narrow fix:

1. `soundcheck` on touched scope
2. `bun x tsc --noEmit --pretty false`
3. narrow targeted rerun
4. full isolated e2e
5. scenarios if runtime or orchestration changed

Do not skip straight from local patch to full suite without the narrow rerun.

## Repo-Specific Smells To Check Immediately

- stale preview bundle after frontend changes
- `pw-files` rewriting into bad `file:line` targets
- duplicate top-level isolated runners sharing port ranges
- `MM_EXITED_EARLY` during market-maker reset
- direct frontend jurisdiction bypasses
- receipt-driven event delivery bypassing watcher flow
- optional UX surfaces used as canonical test assertions

## Better Tooling To Add Next

1. `--pw-lines` support in `run-e2e-parallel-isolated.ts`
   Exact file:line targeting without breaking `--grep`.
2. auto-summary extractor
   First failing shard, first failing assertion, first runtime error, one command.
3. artifact classifier
   Emit `build|runner|boot|runtime|ui|contract` in summary.
4. stale-build detector
   Compare preview asset hash with current source hash before `--skip-build`.
5. boot guard summary
   Explicit counts for market-maker seeded offers, hubs ready, orderbooks ready.

## Acceptance Bar

A bug is not closed until:

- targeted reproduction is green
- full isolated e2e is green
- no new earlier-phase failure replaced the old one

