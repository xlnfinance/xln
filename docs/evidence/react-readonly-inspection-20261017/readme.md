# React diagnostics retain read-only Runtime inspection

Base: `f4cc3dd52e051fc6a8b53c853eb476692bb1f072`.

The required raw-input privacy browser first failed on the retired Svelte login
selector (33.173s). Moving its setup to actual React endpoint/key consent exposed
the real assertion: the diagnostic getter returned the complete RuntimeAdapter,
including `send` (red19.680s, expected false/received true). Account reads and
admin authority already worked. The isolated runner enables UI diagnostics;
normal public production builds disable this hook. This is a diagnostic API
contract defect, not evidence of a public production exploit or an XSS boundary.

The current getter returns a frozen metadata snapshot and a bound canonical
`read`, without the command-bearing adapter or its connection internals. Ordinary
React commands retain the actual private module-owned adapter. Each inspection
gets current metadata; reads remain bound to the same connection.

The local E2E submission helper uses the actual EmbeddedRuntimeAdapter against
the existing live Runtime, with real dependencies. It does not connect/bootstrap
another Runtime. Its `send` still enforces command readiness and admission before
canonical enqueue; a lost browser context cannot repeat the accepted input. No
new queue, reducer, durable state, server fallback or financial formula is added.
Other privileged local QA hooks remain; this does not sandbox same-origin JS.

## Evidence

- Actual React raw-input privacy/account projection:1/1,32.966s; final formatted
  test re-reads connection status after inspection:1/1,33.088s.
- Embedded BrainVault with three real Hub Accounts, signed profile and current
  password reload/recovery:1/1,29.703s; exercises the changed local input helper.
- Remote admin commands through normal React controls plus committed historical
  frames and observer graph:1/1,40.464s.
- Existing EmbeddedRuntimeAdapter admission/publication regressions:4/4,
  19assertions,0.322s. Latest Runtime selection, in-flight publication and stopped
  Runtime rejection assertions remain unchanged.
- Fullcheck, clean committed privacy browser and installed pre-push verifier are
  required before publication, under `raw-input-final-check-2`,
  `raw-input-clean-head`, `raw-input-publish`.

All runs hold the canonical capacity-one stand with60s budgets. Actual command
argv, exits, timings, browser console/network reports, runtime/worker asset hashes
and red/green traces are in `/Users/zigota/agent-jobs/xln-mainnet-autonomy-20261017/`
under `raw-input-*`. All three green browser manifests report zero health issues.

After `bun run stand:status`, reproduce:

```sh
bun run stand:run --reason readonly-inspection --timeout-ms 60000 -- \
  bun core/scripts/e2e/runners/run-e2e-parallel-isolated.ts \
  --all --strict-browser-health --shards=1 --workers-per-shard=1 \
  --max-mm-concurrency=1 --video=retain-on-failure --trace=retain-on-failure \
  --screenshot=only-on-failure --max-failures=1 \
  '--pw-files=tests/e2e/runtime/e2e-radapter-remote-part-1.spec.ts::admin remote runtime keeps raw RuntimeInput send private and account projection readable'
```

Remaining release/operator/public-chain/soak gates are not covered by this slice.
