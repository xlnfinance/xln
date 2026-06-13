# e2e quickstart

Use the isolated runner for normal browser testing. It builds once, starts a dedicated local stack per test target, and tears it down after the run.

## Fast Path

```bash
bun run test:e2e:fast
```

This runs the canonical user flows listed in `runtime/scripts/run-e2e-fast.ts` with:

- isolated Anvil RPCs
- isolated runtime API server
- isolated Vite frontend
- isolated DB root
- Chromium only
- trace/video off by default
- `--max-failures=1`

## One Flow

```bash
bun runtime/scripts/run-e2e-parallel-isolated.ts \
  --pw-project=chromium \
  --pw-files='tests/e2e-payment-smoke.spec.ts::fresh runtimes can open accounts, faucet, pay, and reload persisted state' \
  --video=off --trace=off --screenshot=only-on-failure --max-failures=1
```

Use exact test titles for focused work. The runner expands each title into its own isolated stack.

## Full Browser Sweep

```bash
bun run test:e2e:all
```

Use this after focused L1/L2 failures are fixed. Default local parallelism is capped conservatively for a high-core workstation; market-maker tests still have their own concurrency limiter.

## Manual Dev Server Mode

Manual server mode is for interactive debugging, not the default gate.

```bash
bun run dev
PW_SKIP_WEBSERVER=1 PW_BASE_URL=https://localhost:8080 E2E_BASE_URL=https://localhost:8080 E2E_API_BASE_URL=https://localhost:8080 \
  bunx playwright test tests/e2e-payment-smoke.spec.ts --project=chromium
```

Use this when you need to inspect the browser manually or debug a persistent local process.

## Troubleshooting

- `RUNNER_LOCKED`: another isolated E2E run is active. Wait for it or inspect `.logs/e2e-parallel/.runner-lock.json`.
- `No isolated test targets matched`: the exact title or grep does not match the current spec.
- Port conflicts: the isolated runner reaps stale shard processes during preflight; if this repeats, check `.logs/e2e-parallel/*/e2e-shard-*.log`.
- Browser failure: inspect the shard log, `targets.json`, Playwright output, and failure screenshots under `.logs/e2e-parallel/`.

## Layer Choice

- UI broke or user flow changed: start with L3 Playwright.
- Runtime behavior broke after a long browser repro: add L2 scenario coverage.
- Local algorithm broke: add L1 unit/component coverage.
- Solidity behavior changed: add L4 contract coverage.
