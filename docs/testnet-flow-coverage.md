# Public Testnet Flow Coverage

This is the blocking user-flow matrix for the public testnet. BrowserVM is not a
release blocker; these checks target the server/RPC runtime and the shared app
UI.

## Pay

Required E2E coverage:

- Fresh runtime creation, account opening, faucet, payment, and reload.
- Bidirectional HTLC payment through a hub across isolated browser contexts.
- Sender debit and recipient credit are checked against committed state.
- Overspend is rejected without changing balances.
- Persisted HTLC receipts and balances survive reload.
- Pay deeplink opens the same Pay surface with prefilled intent.

Primary specs:

- `tests/e2e-payment-smoke.spec.ts`
- `tests/e2e-ahb-isolated.spec.ts`
- `tests/e2e-pay-deeplink.spec.ts`

## Same-Account Swap

Required E2E coverage:

- Same-account swap orders are placed from the shared swap builder.
- Orderbook liquidity is visible to both users.
- Immediate fill, partial fill, remainder cancel, multi-taker fill, and round
  trip buy/sell are asserted through committed account state and visible order
  history.
- UI rejects unsafe prices beyond the orderbook deviation band.
- Manual price override after a book click uses the edited limit price.

Primary specs:

- `tests/e2e-swap-isolated.spec.ts`
- `tests/e2e-swap.spec.ts`

## Cross-J Swap

Required E2E coverage:

- Cross-j swaps are placed through the same `SwapPanel` as same-account swaps.
- The route selector exposes same-account and cross-j targets in one builder.
- Full fill, partial fill, clear/cancel, salvage/dispute path, and closed order
  history are asserted.
- Cross-j actions use `requestCrossJurisdictionSwap`,
  `requestCrossJurisdictionClear`, and hashledger pull settlement, not legacy
  cross-j HTLC or plain `swap_resolve`.

Primary specs:

- `tests/e2e-cross-j-swap.spec.ts`
- `runtime/__tests__/cross-jurisdiction-swap.test.ts`

## Enforced Contract

The static coverage contract is:

```bash
bun run test:e2e:coverage
```

The behavioral release gate is:

```bash
bun run test:e2e:core
```

`test:e2e:core` intentionally runs the blocking Pay, Swap, and Cross-j titles.
The broader `test:e2e:full` matrix remains useful for nightly/demo regression
work, but it is not part of the public-testnet release blocker.
