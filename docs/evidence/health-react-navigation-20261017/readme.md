# Health administration opens the canonical React wallet

Base: `2a5df200b127cba4fc6b1d09eb7e781f8272ed0f`.

The required health-admin browser first failed in24.244s at its retired Svelte
wallet expectation. Tracing the actual producer showed that Open app linked only
to `/app`, losing the authenticated remote endpoint and capability on entry to
React. A focused regression then failed in24.042s on that exact link.

The existing observer panel now captures the connection request before awaiting
server authentication. After admin authentication, Open app passes that exact
endpoint and capability to the canonical React remote-consent fragment. Editing
the form later cannot substitute another endpoint/key. React scrubs the fragment
and still requires explicit Connect; server authentication remains authoritative.
Unauthenticated navigation opens `/ui/` without a capability. No wallet or saved
credential reader was added, and query-token rejection remains mandatory.

## Evidence

- Real health-admin browser1/1,35.223s: QA routes remain link-only; actual Hub
  authentication; edited-form substitution rejected; React connects explicitly
  to the same Runtime/Entity; capability remains session-only; query credential
  injection is rejected without overwriting the authenticated session; bare
  observer redirect does not implicitly reconnect the React wallet.
- Related query/remote-link guards37/37,342 assertions,0.314s.
- Final full check, clean committed browser and mandatory pre-push verification
  are recorded under `health-wallet-final-check`, `health-wallet-clean-head`,
  and `health-wallet-publish` before publication is accepted.

Actual commands, exits, timings, runtime/worker build hashes and browser event
reports are preserved under
`/Users/zigota/agent-jobs/xln-mainnet-autonomy-20261017/` in `health-*` artifacts.
Original failures are retained. Every heavy run holds the capacity-one stand
with a60s wall budget.

After `bun run stand:status`, reproduce:

```sh
bun run stand:run --reason health-wallet --timeout-ms 60000 -- \
  bun core/scripts/e2e/runners/run-e2e-parallel-isolated.ts \
  --all --strict-browser-health --shards=1 --workers-per-shard=1 \
  --max-mm-concurrency=1 --video=retain-on-failure --trace=retain-on-failure \
  --screenshot=only-on-failure --max-failures=1 \
  '--pw-files=tests/e2e/runtime/e2e-radapter-remote-part-1.spec.ts::health admin keeps QA evidence link-only and runtime adapter local'
```

No financial transition, server permission, durable schema, contract or frozen
hash changed. Other remote operator cases, aggregate release and soak remain
separate gates. This is not a mainnet-readiness claim.
