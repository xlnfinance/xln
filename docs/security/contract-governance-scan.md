# Contract Governance And Access-Control Scan

Last refreshed: 2026-07-09.

Run:

```bash
bun run security:contract-governance
```

This is an executable source-shape scan for the current external-audit handoff.
It is not a replacement for manual contract review, gas review, or adversarial
tests.

## Current Result

- Depository production write path is `processBatch()`, guarded by Hanko
  verification, chain/depository domain binding, strict entity nonce increment,
  batch bounds, and `nonReentrant`.
- Watchtower delegated counter-dispute is narrower than `processBatch()`: it
  requires an active dispute, rejects cooperative and unsigned final proofs,
  binds the appointed tower address into the entity authorization hash, and only
  runs after the last-resort window.
- Local-dev helpers are chain-gated to Anvil chain IDs `31337` and `31338` and
  require the immutable deployer `admin`.
- Foundation-only naming/quota functions are token-gated through
  `onlyFoundation`, not `Ownable`.
- Entity governance mutation paths require either governance caller validation
  or entity Hanko authorization with `entityActionNonces`.
- No `tx.origin`, `selfdestruct`, `Ownable`, or `onlyOwner` usage exists in
  `Depository.sol`, `EntityProvider.sol`, or `Account.sol`.

## Open Manual Review

- Validate whether `enforceDebts()` should remain permissionless in production.
  Current design lets anyone progress FIFO debt repayment from existing
  reserves, but an auditor should confirm the gas and griefing bounds.
- Re-check `EntityProvider.verifyHankoSignature()` recursive entity-reference
  semantics against the current Hanko spec and Solidity gas limits.
- Re-check every batch limit in `Depository._assertBatchBounds()` against
  worst-case gas on target chains before raising real-money limits.
