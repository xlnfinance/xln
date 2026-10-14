# React same-network swap and reload proof

The preserved devnet, real H1 and ordinary React RAdapter produced one USDC-to-WETH
order with one terminal execution. No mocked balances or reconstructed seed-only
Runtime were used. `proof.json` uses xln's canonical tagged BigInt JSON encoding.

| Quantity | Confirmed value |
|---|---:|
| Initial USDC | 100 |
| USDC debit | 99.999996 |
| Gross WETH | 0.039992 |
| WETH fee, 1 bps | 0.0000039992 |
| Net WETH | 0.0399880008 |
| Final USDC | 0.000004 |
| Live offers, pending proposal, mempool entries, token holds | 0 |
| Orders / executions | 1 / 1 |

The test explicitly grants WETH receive capacity, rejects invalid give amounts
without changing balances, double-clicks submit, and checks the actual fee against
the published policy using the canonical fee calculation. Stored Account history
amounts reconcile exactly with committed balance changes. After reload the same
identity, Account root, balances and complete order history match; the receipt is
visible and wallet commands are enabled.

## Reproduce

Run the two phases sequentially from the repository root. The first phase creates
a fresh wallet and replaces its own fixture only after successful swap verification
and an actual page reload to the password gate. The second unlocks the exported
post-reload IndexedDB/WAL. Run the second command only after the first succeeds.

```sh
bun run stand:status
XLN_SWAP_E2E_DIR=docs/evidence/archive-tmp/xln-swap-proof bun run stand:run --reason swap-proof --timeout-ms 60000 -- bun ui/node_modules/playwright/cli.js test -c ui/playwright.config.ts ui/tests/e2e-swap.spec.ts --grep 'same-network swap'
bun run stand:status
XLN_SWAP_E2E_DIR=docs/evidence/archive-tmp/xln-swap-proof bun run stand:run --reason swap-recovery-proof --timeout-ms 60000 -- bun ui/node_modules/playwright/cli.js test -c ui/playwright.config.ts ui/tests/e2e-swap.spec.ts --grep 'unlock after swap'
```

Only public identity and financial evidence are committed here. Browser storage
and encrypted-wallet fixture files remain in the temporary test directory.

## Scope

The bounded swap/reload phase passed in 48.7 s and the initial recovery phase in
19.0 s. The combined fresh-login/swap/unlock attempt exceeded the unchanged
60-second process budget. This artifact proves financial correctness and durable
recovery across the two phases, not a fast combined journey, Cross-J swaps,
TS/Rust parity, live TPS or production readiness.

Regression logs: `docs/evidence/archive-tmp/xln-swap-final-regressions.log` (53 tests, 263 assertions),
`docs/evidence/archive-tmp/xln-swap-financial-final.log`, `docs/evidence/archive-tmp/xln-swap-recovery-candidate.log`,
`docs/evidence/archive-tmp/xln-swap-related-faucet.log`. Final gate: `docs/evidence/archive-tmp/xln-swap-final-check.log`.
