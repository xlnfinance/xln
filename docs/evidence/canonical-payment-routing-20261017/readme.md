# One payment-route query for embedded and remote wallets

Base: `7641d6f729321017a9d030e75245b0736e4b85d7`.

Alice cached Bob's correctly signed initial profile without an Account. Bob had
already published his committed H1 Account; the relay held that current profile.
The embedded wallet only fetched missing profiles, so its quote failed with
`no payment route` despite available receiving capacity. The actual Pay failure
is preserved in `bidirectional-real-quote-red` (exit1,34.622s), along with both
public signed profiles and relay evidence in `bidirectional-profile-dump.json`.

The existing server query now belongs to RuntimeAdapter reads and is used by
RPC, direct hub RPC and the embedded React wallet. Its verified network refresh,
typed query rejection, committed graph-read barrier and targeted route discovery
are unchanged. The separate embedded implementation is deleted. Network waits
remain outside the committed-read lease. No new freshness cache, durable field,
fee formula, polling policy or protocol format is introduced.

The original isolated Alice/Hub/Bob gate now uses current React identity, Pay,
Account and password-unlock surfaces. It requires the genuinely stale sender
profile before the first real quote and refreshed receive readiness before
submission. Three payments (10,5,3 USDC), all signed durable receipt fields,
exact base-unit debits, overspend rejection and both wallets' current WAL/reload
invariants remain required. First debits are10000010 and5000005; rendered money
uses the current rounding separately. Final reload additionally compares exact
base-unit capacities. The negative overspend step requires its exact endpoint
`GOSSIP_ROUTE_MISS`; no unrelated warning is allowed.

## Evidence

- Related route-capacity, exact quote and committed-read checks:20/20,
  57assertions,0.712s.
- Extended actual browser:1/1,55.432s with strict browser health, capacity-one
  stand and60s outer budget. Zero unexpected console/page/network/HTTP issues;
  one explicitly asserted overspend route-miss diagnostic.
- First combined rebuild+browser attempt timed out60.854s after the final reload
  began; cleanup completed and stand was free. The successful run uses the same
  canonical runtime/Account-worker build input hash
  `45e830494de9b9930300fc7e6ee404bacd3070315e0a7d4ce4f6fd15570677f6`.
- Full check and clean committed browser/publication results are stored beside
  these logs before publication. No Solidity, generated contract artifact,
  frozen-core or financial-engine change. No aggregate release/mainnet claim.

Reproduce after `bun run stand:status`, under
`bun run stand:run --reason canonical-payment-routing --timeout-ms 60000 --`:

```sh
env E2E_LONG=1 bun core/scripts/e2e/runners/run-e2e-parallel-isolated.ts \
  --all --strict-browser-health --shards=1 --workers-per-shard=1 \
  --max-mm-concurrency=1 --video=retain-on-failure --trace=retain-on-failure \
  --screenshot=only-on-failure --max-failures=1 \
  '--pw-files=tests/e2e/runtime/e2e-ahb-isolated.spec.ts::bidirectional payments survive across two isolated browser contexts'
```

Durable logs and browser/build manifests:
`/Users/zigota/agent-jobs/xln-mainnet-autonomy-20261017/evidence/bidirectional-*`,
`evidence/canonical-route-*` and corresponding `*-boundary/` archives.
