# React peer swap and partial recovery evidence

Two original required same-J peer scenarios now use the current React wallet, actual account credit controls, the hub orderbook and persisted Account execution records. Each user owns a separate browser profile and signer. The isolated stack disables market-maker liquidity. Financial transitions, contracts and storage formats are unchanged.

- Full trade: Alice offers0.03WETH at2500USDC/WETH; Bob permits78USDC at2600. Both persisted resolves require execution at the resting price: maker gives30000000000000000 units and receives75000000, buyer spends75000000 and receives30000000000000000. The buyer saves the unused3USDC source amount; the exact fill ratio is below full source spend and its remainder closes. Both capacities move in the expected direction and the offer/book level disappears.
- Partial/recovery: Alice offers0.04WETH; Bob takes0.02 for50USDC. Exactly0.02WETH remains live, including after authenticated WAL reload. Bob then closes his browser; Alice cancels the remainder. No offer remains, stored executions total exactly20000000000000000 WETH units and50000000 USDC units, and the current Activity history shows these exact amounts on a Closed order. This replaces retired Svelte table/status text with the actual current UI and stronger amount assertions.

Measured intermediate results: full1/1 in37.018s; partial/recovery1/1 in41.867s, zero browser issues. Same-J ordered Account output/economic-limit L1:6/6,26assertions in0.280s. Strict diagnostics for this owned test with current UI compiler options:0 in4.745s. The initial cleance4053c2d baseline failed51.904s in the removed context dropdown. Further old Configure/Swap controls failed51.117s and54.146s. Two attempts reached the60-second stand limit while new selectors incorrectly required a token badge or exact Account label; traces located the waits, exact owned groups ended, and both selectors were corrected. These failed runs are retained, not counted green.

The source port removes retired local Runtime globals, handwritten replica/Delta shapes, Account-owner guessing and zero-on-missing reads. Capacity uses the current typed Runtime and canonical deriveDelta. Faucet calls now fail on the real API response rather than blindly repeating financial commands. Wallet creation reuses ui/tests/wallet-ui.ts; no seed injection or parallel wallet path.

Reproduce each case separately under the existing60-second stand:

```sh
bun run stand:status
bun run stand:run --reason peer-swap --timeout-ms 60000 -- \
  bun core/scripts/e2e/runners/run-e2e-parallel-isolated.ts \
  --all --strict-browser-health --shards=1 --workers-per-shard=1 \
  --max-mm-concurrency=1 --video=retain-on-failure --trace=retain-on-failure \
  --screenshot=only-on-failure --max-failures=1 \
  '--pw-files=tests/e2e/swap/e2e-swap-isolated.spec.ts::two isolated users trade against each other through one hub orderbook without market maker liquidity'
```

For partial/recovery replace the title with `resting maker order can fill partially, stay open, then cancel remainder`. The unchanged final candidate's fullcheck, clean committed browser and installed pre-push verifier are recorded with exact SHA/tree in `/Users/zigota/agent-jobs/xln-mainnet-autonomy-20261017/handoff.json`; command logs/results, build identities and failures use the `peer-swap-*` names. Git also retains clean verification at `xln-verification/<SHA>/`.

This slice does not claim all tests in this file are current or green. Multi-taker, reverse trade and other root browser cases remain separate required work, as do full integrated release, public-chain/operator/rollback, uninterrupted1hsoak and MacBook catch-up. No Rust, contract, frozen-core or production financial change; no TPS/mainnet/parity claim.
