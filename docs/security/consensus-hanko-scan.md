# Consensus And Hanko Production Scan

Last refreshed: 2026-07-09.

Run:

```bash
bun run security:consensus-hanko
```

This is an executable source-shape scan for current consensus and Hanko
production-review invariants. It is not a replacement for adversarial protocol
tests, formal vectors, or independent review.

## Current Result

- Account frame receive keeps `jHeight=0` valid by using nullish fallback, not
  boolean `||`, across proposer, ACK, receiver validation, and receiver commit
  paths.
- Receiver validation runs on a clone before committing the same frame on real
  state, and commit failure throws instead of silently accepting divergence.
- Account frame hashes bind `jHeight`, canonical jurisdiction event bodies,
  deltas, and tx data through `safeStringify()` plus `keccak256`.
- Entity mempool admission is checked before cloning and before
  `push(...entityTxs)`, so oversized batches fail before allocation.
- Entity frame commits verify precommit signature bundles before applying the
  signed frame, build quorum Hankos for signed hashes, attach Hanko witnesses to
  entity/J outputs, and remove committed txs from the mempool.
- Batch Hanko domain is bound to `XLN_DEPOSITORY_HANKO_V1`, chain ID,
  depository, encoded batch, and nonce on both runtime and Solidity paths.
- Hanko verification rejects zero-EOA envelopes and validates lazy-entity board
  reconstruction before accepting the expected target entity.

## Open Manual Review

- `runtime/hanko/signing.ts` still uses dynamic imports inside signing and
  verification helpers. Current consensus callers are statically imported, but
  the helper internals should be reviewed before treating this path as fully
  static.
- Frame hashes still use canonical JSON via `safeStringify()`. Binary canonical
  encoding and golden vectors remain a separate consensus-root migration.
- Multi-validator M-of-N Hanko collection should still be adversarially tested
  against duplicate, reordered, invalid, and threshold-edge signature bundles.
