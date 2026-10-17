# Remote admin commands and historical frames through the current wallet

Base: `7f9bbf20f29125cca7d239e6f40276b1afcafe3f`.

The required admin-control browser still targeted the retired Svelte wallet.
Its unchanged baseline failed in33.167s waiting for that login screen. This slice
ports the existing test to React financial controls and the retained observer.
No production financial, authority, storage, contract or frozen code changed.

The browser explicitly connects to the same H1 Runtime before and after reload.
Another app's import rows and an H2 session capability cannot silently authorize
React; reopening requires the current endpoint and explicit key. It submits a
real credit command through Account Detail, then publishes a signed profile
through Settings. Actual WebSocket requests/responses are decoded with the
production codec. Their command identities, exact sequence echoes, one Entity
input/transaction and committed observed heights are asserted. No fake adapter
or test-only command path is used; auth messages/keys are not collected.

Existing bounded current/history queries still prove the old profile at the old
height and the new profile at the new height, ordered batch results, account/book
page limits, checkpoint cadence and the profile activity event. The browser then
opens the retained observer, selects the same Runtime/Entity, scans the old frame,
checks the actual history response and rendered Time Machine, reloads its deep
link, and returns to live with the published profile visible in the graph.

## Evidence

- Current real browser1/1,40.071s, exit0 (`admin-control-react-6`).
- Intermediate failures are retained: retired debug getters and desktop/mobile
  selector ambiguity; three60s-budget timeouts while tracing observer selection,
  its absent production debug surface, and cached history. Exact owned processes
  were gone and stand free before subsequent runs. These are not green results.
- The final observer correction retains the response read earlier by its current
  query cache; it does not demand a redundant RPC or change production caching.
- Related history/query guards, final full check, clean committed browser and
  pre-push verifier are recorded as `admin-control-guards`, `admin-control-check`,
  `admin-control-clean-head`, `admin-control-publish` before publication is accepted.

All actual commands, exits, timings, failure traces and current asset/browser
manifests are under `/Users/zigota/agent-jobs/xln-mainnet-autonomy-20261017/` in
`admin-control-*` artifacts. Heavy runs hold the canonical stand with60s budget.

After `bun run stand:status`, reproduce:

```sh
bun run stand:run --reason remote-admin --timeout-ms 60000 -- \
  bun core/scripts/e2e/runners/run-e2e-parallel-isolated.ts \
  --all --strict-browser-health --shards=1 --workers-per-shard=1 \
  --max-mm-concurrency=1 --video=retain-on-failure --trace=retain-on-failure \
  --screenshot=only-on-failure --max-failures=1 \
  '--pw-files=tests/e2e/runtime/e2e-radapter-remote-part-2.spec.ts::admin remote runtime control advances live state and exposes past frames'
```

The retired local receipt debug assertions are replaced by the actual server's
observed command acknowledgment and committed state. Old automatic cross-app
credential rescue expectations are replaced by explicit React consent. There is
no restoration of a second wallet or compatibility reader. Aggregate release,
remaining operator cases, public-chain proofs and soak remain separate gates.
