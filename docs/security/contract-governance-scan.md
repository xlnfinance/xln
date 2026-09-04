# Contract Governance And Access-Control Scan

Last refreshed: 2026-08-09.

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
- `Depository.registerExternalToken()` is callable only by the immutable
  `EntityProvider`. External tokens are listed through
  `EntityProvider.foundationRegisterExternalToken()` under a replay-protected
  Foundation Hanko (`FOUNDATION_REGISTER_TOKEN`, `entityActionNonces[bytes32(1)]`);
  no deployer key holds listing power on any chain.
- Board preimages are validated on chain: `registerNumberedEntity`,
  `registerNumberedEntitiesBatch` and `foundationRegisterEntity` take
  `abi.encode(Board)`, and `proposeBoard` reverts `BoardNotCommitted` unless
  `commitBoard()` validated the preimage (or the hash is a retired board).
- Governance delays are seconds; `activateBoard` requires
  `block.timestamp >= Entity.activateAt`. Entity treasuries are the namespaced
  `entityTreasury(N)` address, never `address(uint160(N))`.
- Foundation-only naming/quota functions require a replay-protected Hanko
  from the exact current Foundation board; holding one control token grants no admin authority.
- Entity governance mutation paths require either governance caller validation
  or entity Hanko authorization with `entityActionNonces`.
- No `tx.origin`, `selfdestruct`, `Ownable`, or `onlyOwner` usage exists in
  `Depository.sol`, `EntityProvider.sol`, `Account.sol`, or `DeltaTransformer.sol`.

## Open Manual Review

- Validate whether `enforceDebts()` should remain permissionless in production.
  Current design lets anyone progress FIFO debt repayment from existing
  reserves, but an auditor should confirm the gas and griefing bounds.
- Re-check `EntityProvider.verifyHankoSignature()` recursive entity-reference
  semantics against the current Hanko spec and Solidity gas limits.
- Re-check every batch limit in `Depository._assertBatchBounds()` against
  worst-case gas on target chains before raising real-money limits.
