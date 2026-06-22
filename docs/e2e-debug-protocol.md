# E2E Debug Protocol

Goal: identify the first real failure quickly, avoid chasing noise, and keep fixes narrow.

## Rules

1. Run one top-level isolated runner at a time.
2. Always use a unique `--base-port` if another run may still exist.
3. Do not use `--skip-build` after frontend changes.
4. Do not start with a full-suite rerun after the first failure. First isolate the failing surface.
5. Treat the first failing shard and first failing assertion as primary. Everything after that is usually fallout.
6. Full e2e is a release gate. Do not use it as the debugger while a narrower L1/L2 probe can still fail.

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

## Fatal Marker Protocol

The isolated runner tails shard logs while tests run and aborts the shard immediately on:

```bash
MISSING_SIGNER_KEY|JADAPTER_MISSING|PENDING-FRAME-STALE|PENDING_FRAME_STALE|MM_READY_TIMEOUT|CROSS_J_
```

When this fires, use the printed file path and last 80 log lines as the primary evidence. Do not wait for the rest of the full run.

## Bootstrap Probe Protocol

Use these before any broad e2e rerun for bootstrap bugs:

```bash
bun run prod:bootstrap:fresh
bun run prod:bootstrap:clone
bun run prod:bootstrap:hydrate
```

Each command writes `bootstrap-metrics.json`, wrapper events in `bootstrap-events.jsonl`, and MM-child events in `mm-bootstrap-events.jsonl`. Query them directly:

```bash
jq -c 'select(.event=="stage" or .event=="stage-budget-exceeded" or .event=="fatal")' .logs/bootstrap-soundcheck/*/*/bootstrap-events.jsonl
jq -c 'select(.event=="phase" or .event=="backlog" or .event=="ready-hash" or .event=="fatal")' .logs/bootstrap-soundcheck/*/*/mm-bootstrap-events.jsonl
```

Stage budgets fail before the global timeout: hub mesh `5s`, same-chain `8s`, cross-ready `25s`, health poll `2s`.

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
