# External Wallet State

External ERC20/native wallet balances are read at a finalized block for display.
They never certify a jurisdiction block: only the watcher can advance the canonical J-prefix after authenticating the block's complete receipt set.

Implemented:
- Local and remote UI snapshots are read-only display data bound to an exact block height/hash.
- A snapshot cannot omit or supersede `ReserveUpdated` or any other authenticated log from the same block.
- UI reads an existing observed cache when available, otherwise it requests a fresh finalized snapshot.
- ERC20 `Transfer`/`Approval` logs become `ExternalWalletDelta` only for keys with a finalized baseline snapshot.
- Snapshot reads fail fast on partial RPC errors instead of minting zero baselines.
- Move allowance approval uses canonical `ExternalWalletDelta` / observed entity state for its postcondition.

Next steps:
- Surface external wallet observation age and last J-height on health/debug pages.
- Native ETH changes still need explicit snapshot boundaries because there is no ERC20-style event log.
