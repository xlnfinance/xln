# Hub direct delivery across wallet reload

Reloading a newly imported React wallet closed its authenticated inbound Hub socket. The Hub then chose relay for the same endpointless recipient. The relay reported that recipient unavailable after the transport send had already been accepted; fail-fast halted H1 at Runtime height 31. The original browser failure and the real-socket failing regression are retained in `proof.json`.

Hub readiness and dispatch now retain the inbound direct route while that user is offline. Only the existing signed Hub endpoint predicate selects outbound P2P direct. The existing committed outbox and authenticated readiness wake remain the delivery owners. User-to-user relay, error policy, financial assertions, signatures, deadlines and persisted formats are unchanged.

The payment fixture now uses the canonical React import, password unlock, faucet, quote and receipt controls. Its ten HTLC event assertions and both reloads remain; the displayed balance assertion now requires exactly 100 → 75 USDC for the zero-fee 25 USDC route.

Focused results: 30/30 L1 with164 assertions; strict real-browser payment1/1 with zero browser issues. Import5.787s, initial reload5.228s, final reload6.021s, HTLC finalize1.554s. The restored wallet retained its identity, balance75 and journal height at least20 without another receipt. Scope: private EVM31337, not public Ethereum/nativeTRON or mainnet. Full immutable-candidate acceptance remains outstanding.

Formatting preserved byte-identical minified executable output for the three formatted TypeScript files; the formatted L1 was rerun. Detailed source and log hashes, retained failures and local screenshot paths are in `proof.json`.
