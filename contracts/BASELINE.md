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

## After the port (Hardhat suites on the fork, one file per process)

Ported to the C1/C2 interface (entity-first `processBatch`, V2 batch hash, epoch in the proof and cooperative-update payloads), response windows of at least 60 s (H2), and the wide money types (`Int512`/`Int768`/`SignedAmount`) that og's contracts already use. Helpers live in `test/helpers/hanko.ts` (`computeDepositoryBatchHash`, `submitBatch`, `computeCooperativeUpdateHash`, `computeDisputeProofHash`, `encodeForkBatch`, `toForkProofBody`, `toForkSettlementDiffs`). No assertion was deleted or skipped.

| file | passing before | passing after | failing before | failing after |
|---|---|---|---|---|
| test/dispute/DebtForgiveness.test.ts | 0 | 2 | 2 | 0 |
| test/dispute/DeltaTransformer.test.ts | 1 | 10 | 9 | 0 |
| test/dispute/Depository-part-1.ts | 7 | 66 | 43 | 0 |
| test/dispute/Depository-part-2.ts | 1 | 15 | 14 | 0 |
| test/dispute/DisputeHashVector.test.ts | 1 | 1 | 0 | 0 |
| test/dispute/DisputeOndeltaLiveness.test.ts | 0 | 16 | 8 | 0 |
| test/dispute/SecretRevealLiveness.test.ts | 1 | 1 | 0 | 0 |
| test/dispute/SettlementFinality.test.ts | 0 | 1 | 1 | 0 |
| test/governance/BoardRotationAuthority.test.ts | 0 | 6 | 6 | 0 |
| test/governance/BoardRotationGrace.test.ts | 3 | 6 | 3 | 0 |
| test/governance/HankoAuthorization.test.ts | 18 | 23 | 5 | 0 |
| test/governance/OnchainHankoDomain.test.ts | 0 | 7 | 0 (did not load) | 0 |
| test/protocol/CanonicalTransformerReveal.test.ts | 0 | 3 | 3 | 0 |
| test/protocol/HashLadderRegistry.test.ts | 0 | 23 | 23 | 0 |

The other governance and protocol files (ControlShares, EntityProvider, FoundationRegistry, HankoMembers, Redesign, ReleaseHanko, ContractSize, HashLadder) were unaffected and pass as in the first table.

Rewritten for an intended change, with the reason:

- H1, `DeltaTransformer` "uses timestamp deadlines for payment secrets": an unrevealed payment no longer settles to 0 while its deadline is open; finalization reverts `PaymentRevealWindowActive(deadline)` until the deadline passes.
- H2: windows below 60 s were raised to 60 or more; the expectations that follow from the window length moved with it (`disputeTimeout` = start + 120 for 60 + 60).
- C1: the second settlement in one batch signs epoch + 1, because the first advanced the epoch.
- `BoardRotationGrace` watchtower: the last-resort delay must be at least the response window now, so it uses the full window.
- `OnchainHankoDomain`: og's frozen `core/hanko/onchain-domain.ts` still emits the old settlement, dispute and batch payloads, so those three comparisons use independent ethers encoders in the test, plus an assertion that the fork differs from og's. The golden vector is a fork copy (`test/fixtures/onchain-hanko-golden.ts`); og's `tests/` copy is CommonJS-linked by this loader and reports its exports missing.

The 2^200 ceiling tests, eight of them (Arthur approved the overflow-check approach on 2026-09-29). `docs/money-domain.md` (owner-approved 2026-09-06) removed the ceiling, which existed to keep the int256 intermediate `ondelta + offdelta` sums representable, and names no replacement bound. The tests that expected `E8` (or `E11`) above 2^200 now assert what is true: amounts past 2^200 are accepted, and the real edges revert instead of wrapping (reserve and collateral at uint256 max: panic 0x11, nothing changes). Reading the contracts, every `unchecked` block in `WideMath` carries an explicit `RepresentationOverflow` check. The eight, by title:

`Depository-part-1.ts` (five):
1. reserve: "reverts settlement with E8 when a reserve would exceed MAX_MONEY…" became "settles a reserve past the retired 2^200 ceiling and applies both diffs" and "reverts settlement at the uint256 reserve edge instead of wrapping, and leaves no partial diff".
2. collateral: "reverts settlement and R2C with E8 when collateral would exceed MAX_MONEY" became "accepts R2C and settlement collateral past the retired 2^200 ceiling" and "reverts R2C and settlement at the uint256 collateral edge instead of wrapping".
3. C2R: "rejects C2R amounts above MAX_MONEY before mutation" became "refuses an unsigned C2R above the retired 2^200 ceiling by the signature rule, not a ceiling, before mutation" (a weaker statement on its own; the signed C2R at the edges is the new "withdraws collateral A with a signed C2R at A = …" tests).
4. allowance band: "clamps to the maximum legal allowance band (2^200) and rejects allowances above it" became "clamps at a 2^200 allowance band and accepts an allowance above the retired band".
5. proof-body offdelta: "rejects a proof body with |offdelta| above MAX_MONEY at dispute start, accepts the exact bound" became eight cases "starts a dispute with a proof body whose offdelta is …" from 2^200 up to the `Int512` edges.

`DisputeOndeltaLiveness.test.ts` (three):
6. reserve cap: "accepts reserves above the retired 2^200 cap and stops only at the uint256 representation bound".
7. offdelta bound: "settles an offdelta of exactly -MAX_MONEY" and "-(MAX_MONEY + 1), one unit past the retired cap".
8. token supply (was `E11` above int256 max): "rejects a zero fixed supply at token registration and no longer caps the supply at int256".

The edge probe (every path that turns a uint256 amount into a signed delta, at 2^255 - 1, 2^255 and 2^256 - 1, plus 2^200) is `DisputeOndeltaLiveness` "R2C then dispute finalize at …, offdelta +A / -A" (R2C, payout, debt up to 2^256 - 1), and in `Depository-part-1` "settles collateral A back to a reserve at A = …" (settlement) and "withdraws collateral A with a signed C2R at A = …" (C2R). All exact; nothing wraps or flips sign; there is no int256 conversion in the fork.

## v2 input: the largest swap book that finishes one `processBatch` at our batch gas limit

The inherited test asserted that 1,000 swaps fit 4,000,000 gas in the transformer. That figure predates the `Int768` arithmetic, and the batch gas limit is ours to set, not og's (`core/config/constants.ts` has 5,000,000 and nothing reads it yet).

`Account.sol` hands the transformer `gasleft() - 2,000,000` and holds the 2,000,000 back (`TRANSFORMER_POST_CALL_GAS_RESERVE`), so a transaction's limit must cover the transformer's use plus that reserve: gas used understates the limit to send. Measured on the fork, one non-starter dispute finalize with N swaps in one transformer over two tokens (`Depository-part-1.ts`):

| swaps | gas used | limit needed (gas used + 2M reserve, except where measured) |
|---|---|---|
| 382 | 2,965,056 | fits 5,000,000 (largest, by bisection) |
| 383 | | reverts `TransformerExecutionFailed` at 5,000,000 |
| 500 | 3,953,514 | about 6.0 M |
| 615 | 4,997,914 | about 7.06 M |
| 1000 | 9,077,106 | about 11.1 M |

`MAX_SWAP_BOOK = 382`, `PROCESS_BATCH_GAS_LIMIT = 5_000_000n` and `TRANSFORMER_POST_CALL_GAS_RESERVE = 2_000_000n` are named in `test/helpers/hanko.ts`. The tests send the finalize with the stated limit: 382 finalizes, 383 reverts. The exact boundary moves with any compiler, optimizer or contract change; that is intended, update the constant and this table when it does. The `DeltaTransformer` twin asserts the transformer's own estimate plus the 2M reserve fits the limit. Gas grows faster than linearly past about 500 swaps. It depends on the fixture (one Account, two tokens, one transformer). og's runtime caps a book at 50 offers (`MAX_ACCOUNT_SWAP_OFFERS`), so neither number binds in v1; it is an input to the v2 order-book design.

## Foundry suites (`test/foundry/`): ported, all pass

Ported to the fork and run with forge 1.7.1 (`bash contracts/scripts/setup-forge-std.sh` fetches forge-std; then
`forge test` from `contracts/`). Result at SHA 289f801, one contract per process, 0 failures:

| suite | tests |
|---|---|
| Smoke | 1 |
| Lifecycle | 26 |
| stress/BatchBounds | 11 |
| stress/DebtChunking | 6 |
| math/WideMath | 30 |
| math/WideTransformer | 6 |
| TransformerFaultModes | 15 |
| HalmosLemmas | 6 |
| Depository.invariants | 16 |
| DepositoryConservation.invariants | 9 |
| DebtLifecycle.invariants | 11 |
| HashLadder.invariants | 9 |
| HankoThreshold.invariants | 7 |
| TransformerAllowance.invariants | 8 |
| ForkChanges (new: C1, C2, H1, H2) | 10 |
| RetiredBoardH3 (new: H3) | 7 |

What changed in the port: the four-argument `processBatch(entityId, encoded, hanko, nonce)`; `helpers/XlnHanko.sol` builds
the epoch-bound cooperative and dispute payloads and the domain-bound batch payload; every response window is at least
60 s (H2).

Not covered by the Foundry suites (each is covered by `test/vm/` or is a known gap):

- The H3 clamp has directed tests (`RetiredBoardH3`) but no fuzz action in the invariant handlers.
- Two board rotations in a row are not driven.
- Counter-proof grading in Solidity is not driven by a handler.
- `disputeFinalizeCooperative` is dead in og, so it is not driven.
- H1 (the finalize waits for the payment deadline unless the secret is public) is directed-tested in `ForkChanges` but not
  reached by `TransformerAllowanceHandler`.
- The suites were run before J2 (skip stale dispute ops, PR #49). After J2 lands they need a re-run, and any test that
  asserts the old stale-op revert changes to expect the skip.

## Follow-ups (out of PR #40)

1. ~~Port the old Hardhat suites~~ Done, see "After the port".
2. **Repoint the walk.** `bun diff/walk.ts` still deploys `jurisdictions/`. Pointing it at `contracts/` needs the pure encoders plus a shim for og's own signing, because og's signers and adapter use the old payloads and ABI.
3. ~~Port the Foundry suites~~ Done, see "Foundry suites" above.
4. H3 is no longer open: it is built in the follow-up branch, test `h3-retired-board-cap`.
5. **Run the TRON deploy path end to end.** `deploy-chain-matrix.cjs` and `compile-tron.cjs` were copied from `jurisdictions/scripts/` and have never been run here; only the deploy gate in front of them is tested (it refuses the testnet floor on TRON mainnet). Run it against TRON Nile before relying on it.
