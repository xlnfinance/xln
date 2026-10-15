# Wallet-native experimental economy

The standalone `/arrakis` route and its private service were removed following
the owner correction on 2026-10-15. They were the wrong product surface.
Historical evidence in `docs/evidence/arrakis-20261015/` describes that retired
service and is not evidence for the React wallet or mainnet readiness.

Use the React wallet at <http://localhost:5183/>. Accounts, Assets, Pay, Swap,
and Ownership are the only user-facing paths. Experimental companies use the
existing EntityProvider registration, share release and board-change operations;
shares move through the same Account and swapbook as other registered tokens.
No scripted trades, second balance store or private scenario server belongs in
this flow. Spice must remain a separately registered test asset.

Device-encrypted test wallets are limited to local chains and Sepolia. They open
without a password and use the ordinary durable Runtime. Normal wallets retain
their password protection. Companies remain outside the mainnet admission scope.
