# Current React MM lifecycle

Base: `2f8a81a359f130dc62d774ab159eea8279470301`.

The original real-MM browser test stopped at `swap-orderbook`, a removed Svelte
widget. React deliberately accepts an explicit cross-network minimum without a
live cross-network quote. The canonical order helper now enters that minimum
through React, using existing exact quantization at the caller's limit price.
It does not recreate a cross-network orderbook or change production admission.

Retired visual expectations: book-row clicks, automatic full-capacity sizing,
old network select widgets and old setup-consent markup. Current token/route
selection, risk disclosure, manual amount persistence and published MM depth
replace those widget-specific assertions. Other callers retain their explicit
amount and limit price; broader suite execution is still required.

The original financial test remains: 300 USDC fully consumed; 25 WETH exceeds
the real best bid, consumes it and leaves a positive remainder; Cancel rest
settles both legs, removes pulls and holds, drains queues, commits matching
Hub/User deltas and preserves positional signed evidence. The partial fill
ratio remains strictly between zero and 65535. Exactly one signed collateral
fee is positive and below received value; a refund fails the test.

## Evidence

Dirty candidate: real Anvil, MM hubs, React and browser Account worker, **1/1**
passed, **55.693s** total (**19.5s** Playwright), capacity-one stand, ordinary
60-second budget. Strict browser-health and runtime fatal scanning enabled.
No skips, retry or assertion-threshold reduction. Cold canonical assets rebuilt.
Full `bun run check`: 38 source + 3 top-level gates, exit 0, **25.792s**.

Reproduce under `bun run stand:run --reason current-mm --timeout-ms 60000 --`:

```sh
bun core/scripts/e2e/runners/run-e2e-parallel-isolated.ts \
  --all --strict-browser-health --shards=1 --workers-per-shard=1 \
  --max-mm-concurrency=1 --video=retain-on-failure --trace=retain-on-failure \
  --screenshot=only-on-failure --max-failures=1 \
  '--pw-files=tests/e2e-cross-j-swap.spec.ts::real MM full fill auto-closes and partial fill closes manually on both legs'
```

Durable records: `/Users/zigota/agent-jobs/xln-mainnet-autonomy-20261017/`,
`evidence/mm-react-explicit-minimum.*` and
`mm-react-explicit-minimum-boundary/`. Final check and clean committed run
records are linked by exact SHA in that directory's handoff.

No production runtime, contracts, bytecode, frozen-core or storage schema edits.
This is not full E2E, aggregate release, public-chain, soak or mainnet readiness.
