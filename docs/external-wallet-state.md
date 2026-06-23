# External Wallet State

External ERC20/native wallet balances must be observed through the J-adapter path, not browser-side interval RPC polling.

Implemented:
- `ExternalWalletSnapshot` is a canonical J-event.
- Entity state persists `externalWallet.owner -> balances/allowances`.
- UI reads observed entity state before requesting a fresh server-side snapshot.
- ERC20 `Transfer`/`Approval` logs become `ExternalWalletDelta` only for keys with a finalized baseline snapshot.
- Snapshot reads fail fast on partial RPC errors instead of minting zero baselines.
- Move allowance approval uses canonical `ExternalWalletDelta` / observed entity state for its postcondition.

Next steps:
- Surface external wallet observation age and last J-height on health/debug pages.
- Native ETH changes still need explicit snapshot boundaries because there is no ERC20-style event log.
