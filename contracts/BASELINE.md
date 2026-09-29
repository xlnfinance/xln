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
