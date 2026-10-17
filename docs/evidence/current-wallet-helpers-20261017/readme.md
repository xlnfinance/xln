# Current wallet setup through owner admission

Base: `e80d59825a88724909cc58c426f476928b57f2fa`.
This slice ports browser setup to the canonical React wallet and Runtime API.
It does not close the original full/partial MM lifecycle gate.

## Concrete failures and changes

The root MM scenario previously read removed Svelte globals, navigation and
Runtime ingress methods. Public phrase import now uses one shared React UI
helper; P2P, gossip and Account observations read their current owners.
Runtime inputs pass the production decoder and owner adapter once. A lost
browser context fails loudly instead of resubmitting potentially accepted work.

Real hub evidence showed USDC receive capacity stayed zero because setup
assumed the retired wallet had already granted it. The fixture now explicitly
grants every requested token and still verifies positive committed hub capacity.
A second stalled assertion tested persistent Account collections with
`instanceof Map`. It now reads the canonical collection and derives granted
credit through `deriveDelta`, without a separate credit formula.

## Reproduction and results

All runs use the capacity-one stand and a 60-second process limit:

```sh
bun run stand:status
bun run stand:run --reason current-wallet-setup --timeout-ms 60000 -- \
  bun core/scripts/e2e/runners/run-e2e-parallel-isolated.ts \
  --all --strict-browser-health --shards=1 --workers-per-shard=1 \
  --max-mm-concurrency=1 --max-failures=1 \
  --pw-files='tests/e2e-cross-j-swap.spec.ts::current React wallet admits explicit hub credit and reads committed account collections'
bun run stand:run --reason current-wallet-check --timeout-ms 60000 -- bun run check
```

- Actual Anvil/RPC, hub processes, React wallet and browser Runtime: **1/1**, no
  skips or retries, **36.634s**. Explicit credit, both jurisdiction Accounts,
  real 300-USDC funding and current Swap navigation are exercised.
- Full source check: **38 + 3 gates**, exit 0, **25.857s**.
- Original MM lifecycle: still fails at the absent cross-network orderbook in
  React, **57.143s**, exit 1. The current form explicitly accepts a manually
  entered limit; it does not advertise a live cross-network quote. Its full
  lifecycle/depth assertions remain present and unresolved. No release gate
  or selective-rerun ledger was cleared to treat this as a pass.
- One diagnostic attempt failed because the diagnostic itself read removed
  `state.messages`; that attempt is retained and not counted as product evidence.

Exact logs, exit codes, failing traces, snapshots and candidate hashes:
`/Users/zigota/agent-jobs/xln-mainnet-autonomy-20261017/`.
Named records: `current-account-setup-regression`, `current-wallet-helpers-check`,
`mm-hub-capacity-evidence-boundary`, `mm-current-swap-navigation-boundary`.
Clean committed verification and publication evidence are recorded by exact SHA
in that durable directory and the installed verifier's Git common directory.

No production financial transition, persisted format, runtime bundle, contract
source, bytecode or frozen-core hash changes in this slice. Mainnet, full E2E,
public-chain proofs, uninterrupted soak and MacBook synchronization remain
unproved.
