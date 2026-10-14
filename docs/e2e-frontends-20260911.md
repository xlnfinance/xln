# Frontend E2E parity review — 2026-09-11

Reviewed from `b055e92d3` plus the Home clarity/scale candidate. Full React/Svelte
functional parity is **not proven**. File discovery, assertions in source and
fresh successful execution are three different kinds of evidence.

## Discovery and execution boundaries

- React discovery: **37 cases in 29 files**, using `ui/playwright.config.ts`.
  Log: `docs/evidence/archive-tmp/xln-react-e2e-list.log`.
- Root Chromium discovery: **144 cases in 53 files**, including Svelte, admin,
  runtime and site tests. This is not a comparable wallet coverage percentage.
  Command: `E2E_BASE_URL=http://localhost:8080 E2E_API_BASE_URL=http://localhost:8082
E2E_RESET_BASE_URL=http://localhost:8082 bunx playwright test '\.spec\.ts$'
--list --reporter=list`. This lists cases only; it does not reset any chain.
  Log: `docs/evidence/archive-tmp/xln-svelte-spec-discovery-final.log`.
- The root isolated runner selects `playwright.config.ts`; fast targets are in
  `core/scripts/e2e/runners/run-e2e-fast.ts`. Neither includes the separate React
  configuration. A successful root run is not React acceptance.
- `core/scripts/checks/policy/check-flow-e2e-coverage.ts` checks source strings,
  mostly in Svelte/core files. It does not execute flows or prove React parity.
- Fresh bounded execution of React faucet plus cross/dispute/journey:
  **1 passed, 3 skipped**, 47.2 seconds. The skipped tests must not count as green.
  Log: `docs/evidence/archive-tmp/xln-home-final-faucet-coverage.log`.

## Financial paths

| Path                     | React evidence                                                                                                                                                                                                          | Svelte/root counterpart and remaining gap                                                                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create/import/unlock     | `ui/tests/e2e-local-password.spec.ts`, `e2e-recovery.spec.ts`; source inspected                                                                                                                                         | `frontend/tests/brainvault-*.spec.ts`, `tests/e2e/recovery/e2e-brainvault-parity.spec.ts`. No single fresh CLI/React/Svelte identity-equality proof established by this review.                                   |
| Faucet                   | `e2e-repeat-faucet.spec.ts`: freshly passed; two double clicks produce exactly 100 then 200 USDC, one request per payment, no pending/mempool                                                                           | Asset faucet tests exist in both suites. React `e2e-assets.spec.ts` checks external/gas/reserve/offchain faucets, not a full deposit/withdraw lifecycle.                                                          |
| Person-to-person payment | `e2e-two-wallets.spec.ts`, `e2e-payment.spec.ts`; earlier exact sender/recipient/fee/reload evidence in `evidence/wallet-transfer-20260911/proof.json`                                                                  | Svelte `e2e-ahb-isolated.spec.ts` includes bidirectional payment and overspend. Fresh full cross-frontend execution remains outstanding.                                                                          |
| QR / payment link        | No React E2E for QR generation/scanning or payment-link parsing found in the discovered suite                                                                                                                           | `tests/e2e/payments/e2e-invoice-qr.spec.ts`, `e2e-pay-deeplink.spec.ts`. Add React recipient/token/amount/network assertions, then actual payment and both receipts.                                              |
| Same-network swap        | `e2e-swap.spec.ts`: one fill, exact gross/fee/net, duplicate-submit prevention and recovery. Recovery freshly passed in 22.0 seconds with matching Account state/history and desktop/mobile scale checks                | Svelte `e2e-swap-isolated.spec.ts` also covers maker/taker, partial fill, cancel remainder, two takers, self-trade prevention and round trip. These branches are missing from React E2E.                          |
| Cross-network swap       | `e2e-cross-swap.spec.ts` has both-leg amounts, roots and recovery assertions; **skipped on current dev stack**                                                                                                          | Needs `XLN_RDB_ROOT` and a local-prod-smoke maker import manifest. Svelte `tests/e2e-cross-j-swap.spec.ts` includes full/partial/disputed flows. No fresh cross-network acceptance here.                          |
| Move                     | `e2e-move.spec.ts` checks both Account orientations, unfunded rejection, reserve → collateral, exact conserved ownership and empty batch/pending/mempool. LEFT freshly passed in 41.8 seconds and RIGHT in 41.0 seconds | Svelte `tests/e2e/payments/e2e-move.spec.ts` covers multiple external/reserve/account routes; `e2e-move-direct.spec.ts` covers direct external transfer. React test does not cover those routes or a Move reload. |
| Dispute                  | `e2e-manage.spec.ts` reaches signed/broadcast dispute start; finality test **skipped**                                                                                                                                  | `e2e-dispute-finality.spec.ts` needs private RPC/origin; no repository stand currently supplies these variables. Start is not finality. Svelte `tests/e2e-dispute.spec.ts` includes reserve return.               |
| Lending                  | `e2e-lending.spec.ts` asserts offer → close → exact principal return; availability test opens Offer/Borrow and then pays                                                                                                | Actual borrow → interest → repay/default/reload is not established by the React tests inspected.                                                                                                                  |
| Ownership                | React `/ownership` route exists; no corresponding React E2E found                                                                                                                                                       | `tests/e2e/product/e2e-entity-ownership.spec.ts` exists. UI availability is not proof of ownership transitions.                                                                                                   |
| Recovery / failure       | React has tower restore, duplicate-session, chain catch-up, hub restart and funded payment/swap reload tests                                                                                                            | Only the named fresh runs and prior committed financial proofs are green evidence in this review. No full fresh failure-suite run was performed.                                                                  |
| Whole journey            | `e2e-stack-journey.spec.ts` is intended to combine payment, both swaps, dispute and Move; **skipped**                                                                                                                   | It requires private-chain setup and maker-side access. It cannot serve as the release gate on today's ordinary dev stack.                                                                                         |

## First acceptance blockers

1. Make cross/dispute stand prerequisites executable in isolation. Preserve the
   shared devnet; signed dispute-window time travel belongs only to the private
   chain. A required release case must fail admission when its stand is absent,
   rather than produce a successful release result with skipped money paths.
2. The known Rust stand contradiction remains in current code:
   `core/scripts/operations/production/local-prod-smoke.ts` sets
   `XLN_MESH_PRIMARY_JURISDICTION_ONLY=1` for Rust HLT, but market-maker startup
   and readiness still default `XLN_MM_CROSS_J` to enabled. An explicit
   `XLN_MM_CROSS_J=0` readiness branch exists; it does not reconcile that default.
   This review did not change the native stand or claim live Rust J coverage.
3. Expand React money-path cases to match actual Svelte behaviors: QR/link pay;
   swap partial/cancel/two-sided fills; all supported Move/deposit/withdraw
   routes; final dispute settlement; actual borrow/repay and ownership.
4. Wire both existing frontend configurations into release acceptance with
   explicit required cases and preserved assertions. Every money flow needs
   both sides, exact fees, terminal status, no holds/duplicate history and
   reload invariants. TS/Rust root/output parity and live Rust J remain separate
   required evidence; UI E2E cannot replace them.

## Home change verified during this review

Home now labels balance backing separately from send/receive capacity, retains
collateral bars, shows token units and exact non-cent amounts, identifies test
money, and keeps technical identity in a disclosure. All Home bars share the
same USD-per-pixel scale. Home measures available widths on resize and balance
updates; bars do not fade or stretch each row independently to 100%.
Three scale regressions pass (growth, resize, large amounts beyond the old
manual scale ceiling). Browser checks compare measured bar lengths to live USD
amounts and check clipping on desktop/mobile. Full wallet amounts and financial
transitions are unchanged.

Fresh Move logs: `docs/evidence/archive-tmp/xln-react-move-coverage.log` and
`docs/evidence/archive-tmp/xln-react-move-right-coverage.log`. Each conserves 100 USDC and ends with
zero draft/sent batch operations, pending Account proposals and mempool entries.

Final candidate checks: `bun run --cwd ui check` and `bun run check` passed
(`docs/evidence/archive-tmp/xln-home-ui-check-final.log`, `docs/evidence/archive-tmp/xln-home-final-check-clean.log`).
The first full check stopped at the 50-GiB generated-workspace budget; removing
rebuildable E2E-build and Rust-incremental caches brought it below the limit.
No wallet or devnet database was removed, and no budget was raised.
Final mixed-wallet browser verification passed in 20.8 seconds, including
unclipped mobile account labels: `docs/evidence/archive-tmp/xln-home-mobile-final.log`.
