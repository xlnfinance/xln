# Current React same-J payment gate

Base: `dc841499b4be575856af50ab0092f143eaec7eea`.

The original root payment gate used removed Svelte creation, Account, payment,
gossip and history surfaces. It also silently skipped persisted receipt and
history assertions when those removed globals were unavailable. It now imports
both wallets through the shared public React flow, opens the selected H3 Account,
reads the current runtime gossip and requires the current durable journal API.
No old reader, online fallback or financial implementation is added.

The actual React quote exposes its existing ordered path as a DOM attribute.
The test selects the exact sender/H3/recipient path through public controls;
Instant remains selected and all other delivery modes remain unselected.
Both HtlcFinalized and HtlcReceived must have amount7000000 and the selected hub
endpoint. The materialization-gap cursor invariant remains unchanged.

Real faucet100, payment7, sender93/recipient7, durable Activity query/rendered
history, filters/search/date controls, password unlock and exact balances after
reload pass. Restored runtime identity, online connection and drained Runtime
and Account queues remain mandatory. Retired infinite/timeframe toggle markup
is replaced by current directly visible date filters. Browser console/page
errors must be zero. Other root UI suites remain separate open gates.

## Evidence

- Original creation failure50.884s; current gossip fix50.734s reached retired
  Send tab; cold build/payment run timed out60.864s at incorrect token selector.
  The exact group was cleaned up. Accessible token option corrected.
- Payment/mandatory receipts then passed before retired history tab failed52.801s.
- Entire current root payment:1/1,35.793s (browser22.6s), no skipped assertions.
- Shared real MM full/partial/cancel regression:1/1,41.783s.
- Existing startup coverage guard: red on retired conditional reader expectation;
  updated current mandatory checks green1/1,12assertions,0.189s.

All browser runs use real isolated Anvil/mesh, canonical React/runtime/worker
assets, strict browser health and runtime fatal scanning, capacity-one stand
with60s wall budget. No engine/contract/schema changes. Build/check and clean
commit-linked results are recorded separately before publication.

Reproduce under `bun run stand:run --reason current-payment --timeout-ms 60000 --`:

```sh
bun core/scripts/e2e/runners/run-e2e-parallel-isolated.ts \
  --all --strict-browser-health --shards=1 --workers-per-shard=1 \
  --max-mm-concurrency=1 --video=retain-on-failure --trace=retain-on-failure \
  --screenshot=only-on-failure --max-failures=1 \
  '--pw-files=tests/e2e/payments/e2e-payment-smoke.spec.ts::fresh runtimes can open accounts, faucet, pay, and reload persisted state'
```

Full logs and source-bound artifact hashes:
`/Users/zigota/agent-jobs/xln-mainnet-autonomy-20261017/evidence/payment-*`
and corresponding `payment-*-boundary/` directories. These are local private
chain facts, not public-chain or aggregate mainnet readiness evidence.
