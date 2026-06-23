# External Wallet State TODO

External ERC20/native wallet balances must be observed through the J-adapter path, not browser-side interval RPC polling.

Done foundation:
- `ExternalWalletSnapshot` is a canonical J-event.
- Entity state persists `externalWallet.owner -> balances/allowances`.
- UI reads observed entity state before requesting a fresh server-side snapshot.

Next steps:
- Add ERC20 `Transfer`/`Approval` watcher deltas after every owner has a finalized baseline snapshot.
- Emit automatic snapshots after `approveErc20`, `transferErc20`, `transferNative`, and `externalTokenToReserve`.
- Surface external wallet observation age and last J-height on health/debug pages.
