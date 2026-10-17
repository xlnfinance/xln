# React asset faucet evidence

The root asset-funding browser test stopped at the removed Svelte context switcher
(35.448s), before exercising money. It now uses the current React wallet and the
same financial assertions as the production wallet test. Three isolated cases
retain USDC, WETH and USDT coverage; no old wallet controls are restored.

All changes are test/evidence changes. Runtime, contracts, faucet admission,
server limits and frozen core are unchanged.

## Observed result

- Three strict mesh browser cases pass: USDC24.980s, WETH37.485s including build,
  USDT24.951s. Production-profile USDC1/1 passes30.112s, skipped0.
- Each case starts at zero, then records exactly100 tokens in the external
  signing wallet, Entity reserve and bilateral Account. WETH uses18 decimals;
  USDC/USDT use6. Actual chain gas transaction amount and destination are checked.
- Account funding remains disabled before explicit credit consent. The signed
  limit becomes110 tokens; after the100-token receipt, capacity is10 and no
  Account proposal/mempool work remains. Exactly four successful faucet requests.
- An over-cap request returns413 and leaves all balances unchanged. The mesh's
  existing cap is10^21 tokens; its case requests10^21+1. The production-profile
  caller preserves101 rejection under its100 cap. Neither cap was modified.
  Only that exact asserted HTTP413 and browser resource warning are expected;
  unrelated console/network/HTTP issues still fail the strict gate.
- Related faucet policy/admission/reserve L1:21/21,147 assertions,0.319s.

[Exact receipts and integer balances](proof.json) and [commands/exits/log hashes](results.json).
Durable full logs, traces, screenshots and original source are under
`/Users/zigota/agent-jobs/xln-mainnet-autonomy-20261017/faucet-matrix/` and `../evidence/`.
The clean committed SHA/check/push records are in `faucet-matrix-publication.json`
in that autonomy artifact root.

## Limits and retained failures

The port first exposed a duplicate Playwright runtime import; the shared helper
now accepts the caller's existing Expect instance. It then exposed a fixture-cap
mismatch, followed by the deliberately rejected413 being counted as an unexpected
browser error. All three failed commands are preserved; no test assertion was skipped.

Strict owned-file diagnostics against the preserved baseline are46 before and40
after, with zero added and zero in the new helper. The40 existing diagnostics
belong to the still-unported routed-move test/readers; this is not a claim that
that old suite is type-clean or behaviorally covered.

Before this test-only slice, clean9912b19cb passed the complete76-file runtime
family in four bounded commands:639 tests,3526 assertions. The actual integrated
release command still timed out at60.038s; component passes do not replace it.
Full release/browser, public-chain/operator/rollback, uninterrupted one-hour soak
and MacBook catch-up remain open. No mainnet, TPS or parity claim.
