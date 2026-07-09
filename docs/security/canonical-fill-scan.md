# Canonical Fill Scan

Last refreshed: 2026-07-09.

Run:

```bash
bun run security:canonical-fill
```

This executable scan protects the cross-jurisdiction fill precision boundary.
Exact bigint amounts are the source of truth. `uint16` fill ratios are one-way
proof projections for hash-ladder and dispute plumbing, not settlement
economics.

## Current Result

- `UINT16_MAX`, `MAX_SWAP_FILL_RATIO`, `HASHLADDER_MAX_FILL_RATIO`, and
  `CROSS_J_MAX_FILL_RATIO` agree on the same uint16 boundary.
- Exact-only cross-j fills derive a coarse proof ratio while committed source
  and target amounts remain exact.
- Fill progress, claim progress, pending fill ACKs, and proof-ratio helpers
  share the same exact-aware boundary.
- Deferred source-hub fill ACK evidence is capped by
  `MAX_PENDING_CROSS_J_FILL_ACKS`, prunes before insertion, and preserves TTL
  expiry as operator evidence instead of silently deleting divergent state.
- Incomplete or out-of-range exact ratio fields fail fast instead of silently
  falling back to a lossy projection.
- Debug/proof/gossip files use named constants instead of raw `65535` literals.

## Open Manual Review

- Full binary frame-hash migration is still outside this scan. This scan only
  locks the current precision boundary until canonical binary vectors exist.
- Cross-j route structs still carry legacy coarse ratio fields for compatibility.
  Auditors should verify every new route lifecycle path treats those as proof
  projections only.
- The source-hub deferred ACK stash is bounded. The book-owner admission stores
  only one pending fill per admitted order; auditors should still check global
  orderbook admission lifecycle limits before raising production market-maker
  limits.
