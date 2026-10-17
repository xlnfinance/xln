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

The initial two-case slice did not claim all tests in this file current or green. Multi-taker and reverse-trade results follow below; other root browser cases, full integrated release, public-chain/operator/rollback, uninterrupted1hsoak and MacBook catch-up remain separate work. No Rust, contract, frozen-core or production financial change; no TPS/mainnet/parity claim.

## Multi-taker and reverse-trade continuation

The next coherent test slice closes the other two named same-J peer scenarios through the current React Activity history. Production financial code, Runtime, contracts and frozen-core remain unchanged.

- Multi-taker: one maker offers0.06WETH. Bob executes0.02 for50USDC, leaving exactly0.04WETH; Carol executes the remaining0.04 for100USDC. The maker has zero live offers and one Closed order with exactly two stored executions in their original order. Both exact execution pairs are visible in Activity. Initial60.866s timeout occurred after both trades at the retired closed-tab selector; corrected case passed1/1 in42.888s.
- Reverse trade: Alice gives0.01WETH for25USDC; Bob then gives0.0095WETH back for24.7USDC. Both wallets require exactly two closed execution records with the correct reciprocal base-unit amounts, two visible Closed histories, and zero holds for both tokens on both Accounts. Original source quantities and capacity assertions remain. Initial55.737s failure was the retired orderbook toggle; current case passed1/1 in39.296s. An accidental unchanged launch following an editing-script error was explicitly stopped through its exact stand owner after12.799s (exit143), not counted as evidence.

Run the command above with either exact title:

- `one resting maker order can be matched by two isolated takers until fully closed`
- `swap round-trip both directions clears holds and updates closed history on both peers`

Together with the earlier full/partial cases these are4/4 named peer scenarios, not the entire swap file or release gate. Console/page/network health is enforced by the canonical runner. Screenshots and complete run identities are archived under `peer-swap-multi-*-boundary` and `peer-swap-roundtrip-*-boundary`; final type/L1/check/clean-HEAD publication logs use `peer-swap-extra-*`. Required remaining file cases and integrated release/public-chain/operator/soak work remain unproved until exercised. No timeout or assertion was weakened.
