# React funded tower recovery evidence

The original required standalone-tower recovery test now follows the current React wallet. It derives BrainVault credentials through the real UI/native oracle, funds an Account with100USDC, requires an encrypted durable tower receipt covering that committed Runtime height, destroys the test-owned browser profile, and restores into a demonstrably empty profile using the same credentials. The exact nonzero Account delta and100USDC balance must survive. No old decoder, schema rescue, seeded browser storage or recovery implementation is added.

After restoration, the original additional100USDC faucet and3USDC payment remain. Both parties must have durable HTLC receipts; sender debit equals the actual selected quote including fees, recipient receives exactly3USDC, and authenticated closed-tab restart preserves identity, encrypted credentials, exact Account delta and both balances. Runtime networking is checked after React finishes unlock, rather than while its gate is still booting.

The isolated runner leases the tower's port and configures that exact endpoint in the existing proxy allowlist. The original random port was correctly rejected with `WATCHTOWER_PROXY_PORT_NOT_ALLOWED`; no production proxy restriction changes. Removed retired Svelte creation/reset/global-reader paths, arbitrary Account selection, native-Map representation assumptions, broad faucet retries and503 browser-error exemptions. Normal current checkpoint plus ordered WAL remains the production recovery path.

Measured intermediate checks:

- Original3036981d4 baseline: exit1,46.597s at retired `#name` before recovery.
- Exact proxy denial: exit1,23.553s. Two setup/reader attempts reached the60-second stand limit; they are failures, preserved with exact cleanup evidence.
- Current-wallet full flow:1/1,49.129s. Funded/exact-money extension:1/1,48.938s; restoration completed4.722s after closing the old profile, including UI seed entry/derivation.
- Runner isolation and existing proxy restrictions:25/25,141assertions,0.622s. Strict owned-test diagnostics with current UI compiler options:0,4.729s. These are scoped checks, not whole-engine semantic parity.

Reproduce with the capacity-one stand and60-second wall budget:

```sh
bun run stand:status
bun run stand:run --reason tower-funded-recovery --timeout-ms 60000 -- \
  bun core/scripts/e2e/runners/run-e2e-parallel-isolated.ts \
  --all --strict-browser-health --shards=1 --workers-per-shard=1 \
  --max-mm-concurrency=1 --video=retain-on-failure --trace=retain-on-failure \
  --screenshot=only-on-failure --max-failures=1 \
  '--pw-files=tests/e2e/recovery/e2e-watchtower-recovery.spec.ts::restores a wiped runtime from standalone tower backup and continues channel payments'
```

Final clean-commit browser, build/runtime/worker identities, fullcheck, verifier/push result and failed boundaries are preserved under `/Users/zigota/agent-jobs/xln-mainnet-autonomy-20261017/`, named `tower-*`; `handoff.json` links the exact published SHA and Git's `xln-verification/<SHA>/` evidence. No Rust, Solidity, frozen-core, financial transition or persisted-format changes belong to this slice. This local-chain component does not establish the aggregate release/fullE2E gate, public-chain operations, rollback or uninterrupted1hsoak. MacBook synchronization remains independently unconfirmed.
