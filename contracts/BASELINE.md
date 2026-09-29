# Baseline of the inherited Hardhat suites (before any change here)

Each file run alone with `hardhat test <file>` on this toolchain, on the copy that is byte-identical to og 566c850.
The failures are toolchain drift, not contract behaviour: `hardhat-ethers-chai-matchers` throws
`InvalidParameterError: Unsupported type: object` on `.to.equal(...)` of contract results, and two files import an og
fixture (`tests/fixtures/onchain-hanko-golden.ts`) that no longer exports what they need. Later changes are judged
against these counts: no file may pass fewer tests than here.

| file | passing | failing |
|---|---|---|
| test/dispute/DebtForgiveness.test.ts | 0 passing | 2 failing |
| test/dispute/DeltaTransformer.test.ts | 1 passing | 9 failing |
| test/dispute/Depository-part-1.ts | 28 passing | 22 failing |
| test/dispute/Depository-part-2.ts | 3 passing | 12 failing |
| test/dispute/DisputeHashVector.test.ts | 1 passing | 0 failing |
| test/dispute/DisputeOndeltaLiveness.test.ts | 0 passing | 8 failing |
| test/dispute/SecretRevealLiveness.test.ts | 1 passing | 0 failing |
| test/dispute/SettlementFinality.test.ts | 1 passing | 0 failing |
| test/governance/BoardRotationAuthority.test.ts | 6 passing | 0 failing |
| test/governance/BoardRotationGrace.test.ts | 5 passing | 1 failing |
| test/governance/ControlShares.test.mjs | 6 passing | 0 failing |
| test/governance/EntityProvider.test.mjs | 13 passing | 0 failing |
| test/governance/FoundationRegistry.test.ts | 1 passing | 0 failing |
| test/governance/HankoAuthorization.test.ts | 23 passing | 0 failing |
| test/governance/HankoMembers.test.ts | 7 passing | 0 failing |
| test/governance/OnchainHankoDomain.test.ts | 0 passing | 0 failing |
| test/governance/Redesign.test.ts | 10 passing | 0 failing |
| test/governance/ReleaseHanko.test.ts | 1 passing | 0 failing |
| test/protocol/CanonicalTransformerReveal.test.ts | 3 passing | 0 failing |
| test/protocol/ContractSize.test.ts | 3 passing | 0 failing |
| test/protocol/HashLadder.test.ts | 4 passing | 0 failing |
| test/protocol/HashLadderRegistry.test.ts | 0 passing | 23 failing |

## After C1 and C2 (same runs, same toolchain)

| file | passing before | passing after | failing before | failing after |
|---|---|---|---|---|
| test/dispute/DebtForgiveness.test.ts | 0 | 0 | 2 | 2 |
| test/dispute/DeltaTransformer.test.ts | 1 | 1 | 9 | 9 |
| test/dispute/Depository-part-1.ts | 28 | 7 **drop** | 22 | 43 |
| test/dispute/Depository-part-2.ts | 3 | 1 **drop** | 12 | 14 |
| test/dispute/DisputeHashVector.test.ts | 1 | 1 | 0 | 0 |
| test/dispute/DisputeOndeltaLiveness.test.ts | 0 | 0 | 8 | 8 |
| test/dispute/SecretRevealLiveness.test.ts | 1 | 1 | 0 | 0 |
| test/dispute/SettlementFinality.test.ts | 1 | 0 **drop** | 0 | 1 |
| test/governance/BoardRotationAuthority.test.ts | 6 | 0 **drop** | 0 | 6 |
| test/governance/BoardRotationGrace.test.ts | 5 | 3 **drop** | 1 | 3 |
| test/governance/ControlShares.test.mjs | 6 | 6 | 0 | 0 |
| test/governance/EntityProvider.test.mjs | 13 | 13 | 0 | 0 |
| test/governance/FoundationRegistry.test.ts | 1 | 1 | 0 | 0 |
| test/governance/HankoAuthorization.test.ts | 23 | 18 **drop** | 0 | 5 |
| test/governance/HankoMembers.test.ts | 7 | 7 | 0 | 0 |
| test/governance/OnchainHankoDomain.test.ts | 0 | 0 | 0 | 0 |
| test/governance/Redesign.test.ts | 10 | 10 | 0 | 0 |
| test/governance/ReleaseHanko.test.ts | 1 | 1 | 0 | 0 |
| test/protocol/CanonicalTransformerReveal.test.ts | 3 | 0 **drop** | 0 | 3 |
| test/protocol/ContractSize.test.ts | 3 | 3 | 0 | 0 |
| test/protocol/HashLadder.test.ts | 4 | 4 | 0 | 0 |
| test/protocol/HashLadderRegistry.test.ts | 0 | 0 | 23 | 23 |

The drops come from the two intended interface changes (spot-checked: BoardRotationAuthority and SettlementFinality fail with ethers "no matching fragment" for the old three-argument `processBatch`): `processBatch` now takes the acting entity as its first
argument (C2), and the batch, dispute-proof and cooperative-update payloads changed (C1, C2), so every hash these suites
sign or call `computeBatchHankoHash` with is now the old format. `contracts/test/vm/` covers the same paths against the
new format and is the gate for these changes. Porting the inherited suites to the new interface is a separate change.

Re-measured after H1 and H2: every count is identical to the "after" column, so neither change dropped another inherited test. Those suites already fail on the C1/C2 payloads; H1/H2 cannot be judged by them until they are ported.

## Foundry suites (`test/foundry/`): stale, not run

`forge` is not installed in the environment that produced this baseline, so these suites were not run. They are stale by
inspection, for the same reasons as the Hardhat suites plus the response-window floor:

- Every handler and fixture calls the three-argument `processBatch(encoded, hanko, nonce)` (`helpers/XlnFixture.sol`,
  `handlers/*Handler.sol`, `Lifecycle.t.sol`, `stress/BatchBounds.t.sol`, `TransformerAllowance.invariants.t.sol`). The
  fork's is `processBatch(entityId, encoded, hanko, nonce)`, so they do not compile.
- `helpers/XlnHanko.sol` builds payloads with the old `HankoEncoding.encodeCooperativeUpdate` and `encodeDisputeProof`
  (no `ondeltaEpoch`) and the old batch payload (no entity, domain V1).
- `helpers/SettlementDeltasHarness.sol` builds proof bodies with response windows of 0, and the fixture and handlers use
  `LEFT_RESPONSE_SECONDS` = `RIGHT_RESPONSE_SECONDS` = 50; every window below 60 s is now rejected with
  `ResponseWindowTooShort(60)` (H2).
- The invariants themselves (conservation, debt lifecycle, allowance, hash ladder) still describe the fork, except that
  the H1 wait and the H3 clamp add revert and settlement paths the handlers do not yet drive.

Porting them belongs with the Hardhat port below: same new signatures, windows of at least 60 s, and handler actions for
the H1 wait and the H3 clamp. Until then `test/vm/` is the gate and CI runs only that.

## Follow-ups (out of PR #40)

1. **Port the old Hardhat suites.** The inherited suites above still sign the old payloads and call the old three-argument `processBatch`. Port them to the new interface (entity argument, epoch in proofs, V2 domain), or retire each one once `test/vm/` covers its path.
2. **Repoint the walk.** `bun diff/walk.ts` still deploys `jurisdictions/`. Pointing it at `contracts/` needs the pure encoders plus a shim for og's own signing, because og's signers and adapter use the old payloads and ABI.
3. **Port the Foundry suites** (section above), together with the Hardhat port.
4. H3 is no longer open: it is built in the follow-up branch, test `h3-retired-board-cap`.
