# Preserve payment requests at the wallet gateway

Base: `480923e6e5a24c558894cbff7785de2cc90b227e`.

A canonical `/app#pay/<invoice>` request entered the Svelte gateway, which
replaced the whole location with `/ui/`. The invoice fragment disappeared;
unlocking the existing wallet landed on Home with no payment request.
The gateway now changes only pathname on the same URL, preserving fragment
and query. The existing observer/embed predicate and runtime authority stay
unchanged. This is the current public payment-link format, not an obsolete
profile/frame reader or alternate wallet implementation.

The original deep-link gate now uses the shared current React wallet import,
existing password unlock, and current Pay controls. It requires the same Runtime
identity and exact recipient, amount5 and note after unlock. Both durable
HtlcFinalized/HtlcReceived receipts must contain5000000 and the selected H1
endpoint. The faucet is confirmed at100 before closing the setup page. The
obsolete hard-coded Arrakis jurisdiction hint is removed from this same-J
fixture; normal invoice binding/validation is unchanged.

## Evidence

- Original immutable480923e6e gate failed35.345s at retired wallet dropdown.
- Current public setup exposed missing Pay after redirect/unlock,34.704s;
  the browser snapshot shows Home and100USDC, not a payment request.
- Minimal gateway fix: real browser1/1,45.535s including fresh build, strict
  browser health/runtime fatal scanning, stand capacity1 and60s wall budget.
- Related observer/graph checks:50/50,565assertions,0.215s. One stale assertion
  demanded a removed Svelte wallet prop; replaced by its required absence while
  retaining every selection-bound live snapshot/authority assertion.
- Coverage guard first rejects retired `#payment-amount-input`, then requires
  exact current recipient, amount and note assertions. No gate removal.

Reproduce under `bun run stand:run --reason invoice-gateway --timeout-ms 60000 --`:

```sh
bun core/scripts/e2e/runners/run-e2e-parallel-isolated.ts \
  --all --strict-browser-health --shards=1 --workers-per-shard=1 \
  --max-mm-concurrency=1 --video=retain-on-failure --trace=retain-on-failure \
  --screenshot=only-on-failure --max-failures=1 \
  '--pw-files=tests/e2e/payments/e2e-pay-deeplink.spec.ts::restores runtime and opens the pay screen from hash params'
```

Logs, exact source hashes and browser artifacts:
`/Users/zigota/agent-jobs/xln-mainnet-autonomy-20261017/evidence/deeplink-*`
and the corresponding `deeplink-*-boundary/` directories. Check and clean
commit-linked results are recorded there before publication. No contract,
financial engine, persisted schema, legacy reader or mainnet activation changes.
