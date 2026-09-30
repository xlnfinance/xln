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
- The results above are before J2 (PR #49); "After J2" below is the re-run.

## After J2 (stale dispute ops skip inside `processBatch`; one file or suite per process)

J2 turns a dispute op the Account has moved past into a `DisputeOpSkipped` event instead of a revert. Seven ported tests
asserted the old revert; each now asserts the skip (the event with its op, reason and nonce) and that the Account nonce,
dispute state, reserves and collateral did not change. Real errors (bad signature, malformed or mismatched evidence, the
wrong sender on a live dispute, an early finalize) still revert and are pinned by `test/vm/j2-skip-stale-dispute-ops.test.ts`
(12) and `test/vm/j2-review-extra.test.ts` (16; the review's 16 tests, which also kill the 28 planted mutants).

| test | was | now |
|---|---|---|
| Hardhat `Depository-part-1` "carries cooperative ondelta diffs into the next dispute exactly once" | replayed start reverts E2 | skipped (op 0, reason 0), nonce, dispute hash, reserves unchanged |
| Hardhat `Depository-part-2` "skips a historical cooperative signature offered as a dispute bypass" | finalize reverts E2 | skipped (op 2, reason 2), nonce and reserves unchanged |
| Hardhat `HashLadderRegistry` "skips a RIGHT same-nonce branch when the initial proposer was LEFT" | counter reverts E2 | skipped (op 1, reason 5), no counter registered, dispute unchanged |
| Hardhat `HashLadderRegistry` "cannot claim twice: a second finalization of the same dispute is skipped and pays nothing" | reverts E5 | skipped (op 2, reason 2), reserves unchanged |
| Foundry `Lifecycle` `test_disputeFinalizeTwiceIsSkipped` | reverts | skipped (op 2, reason 2), pair state unchanged |
| Foundry `Lifecycle` `test_disputeStartOverLiveDisputeIsSkipped` | reverts E6 | skipped (op 0, reason 1), pair state unchanged |
| Foundry `ForkChanges` `test_nonce_startSettlementAndC2RNeedNonceAboveStored`, its two start lines | revert E2 | skipped (op 0, reason 0); the settlement and C2R lines still revert E2 |

Settlement or C2R during a dispute (E6) and the watchtower entrypoint (E5) are unchanged.

Results after J2 (local runs, sandbox with forge 1.7.1, code at b3154a6; the commit after it changes only docs):

- Foundry, one suite per process, 0 failures in all 16: DebtLifecycle 11, Depository.invariants 16, DepositoryConservation 9,
  ForkChanges 10, HalmosLemmas 6, HankoThreshold 7, HashLadder 9, Lifecycle 26, RetiredBoardH3 7, Smoke 1,
  TransformerAllowance 8, TransformerFaultModes 15, WideMath 30, WideTransformer 6, BatchBounds 11, DebtChunking 6.
- Hardhat, one file per process: the same counts as the table above (Depository-part-1 66, Depository-part-2 15,
  HashLadderRegistry 23, every other file unchanged); before the rewrite of the four tests, part-1, part-2 and
  HashLadderRegistry failed 1, 1 and 2.
- `test/vm/`: j2-skip-stale-dispute-ops 12, j2-review-extra 16, c1-epoch 5, c2-batch-entity 3, h1-htlc-deadline 5,
  h2-window-floor 3, h3-retired-board-cap 11, h4-deposit-during-dispute 4, vectors 8; `test/gate/`: contract-size 5,
  deploy-gate 23.

vm vectors (`contracts/vectors/`, regenerated by `bun contracts/scripts/write-vectors.ts` from the deployed bytecode, never
by hand): five start cells moved from `REVERT E2()` to `ok, skipped (reason 0)`. The cell now names the skip, so a plain
`ok` still means that a dispute opened.

| cell | file |
|---|---|
| `reopen.startAtStoredNonce` | lifecycle.json |
| `reopen.startAtOldBaselineNonce` | lifecycle.json |
| `afterTimeoutFinalize.startAtStoredNonce` | baseline.json |
| `baselineOffsets.timeoutFinalize.plus1.start` | baseline.json |
| `baselineOffsets.timeoutFinalize.plus2.start` | baseline.json |

Why they moved: each is a start at a nonce the Account has already passed (equal to the stored nonce, or below it), which J2
skips. The dispute did not open in either version, and the state after is the same. `settleAtStoredNonce` stays `REVERT E2()`:
J2 does not touch cooperative updates.

Invariant handlers: `DepositoryHandler` and `TransformerAllowanceHandler` used "the batch succeeded" to mean "the op acted".
Now a start beside a live dispute and a finalize for a closed one are checked against a state fingerprint (nonce, dispute
hash, both reserves, collateral) instead of a revert, and `TransformerAllowanceHandler` only finalizes a live dispute.
`TransformerAllowance` `test_control_faultModeDisputeOnlyClosesViaCleanCounterState` step 2 had submitted the starter's
finalize with the starter as its own counterentity, so it reverted for the wrong reason; it now names RIGHT and expects
`TransformerExecutionFailed`.

## Follow-ups (out of PR #40)

1. ~~Port the old Hardhat suites~~ Done, see "After the port".
2. **Repoint the walk.** `bun diff/walk.ts` still deploys `jurisdictions/`. Pointing it at `contracts/` needs the pure encoders plus a shim for og's own signing, because og's signers and adapter use the old payloads and ABI.
3. ~~Port the Foundry suites~~ Done, see "Foundry suites" above.
4. H3 is no longer open: it is built in the follow-up branch, test `h3-retired-board-cap`.
5. **Run the TRON deploy path end to end.** `deploy-chain-matrix.cjs` and `compile-tron.cjs` were copied from `jurisdictions/scripts/` and have never been run here; only the deploy gate in front of them is tested (it refuses the testnet floor on TRON mainnet). Run it against TRON Nile before relying on it.

## After J5 (a batch that cannot apply fails soft: nonce spent, `BatchFailed`; one file or suite per process)

J5 (decisions doc, coordinator 21:01, refined 22:31 after the #54 review) runs the ops of a batch with no dispute, reveal,
hash-ladder or external-deposit op through an external self-call in try/catch. A failing batch applies nothing, keeps its
entity nonce spent, and emits `BatchFailed(entityId, nonce, reason)` instead of reverting. What still reverts and takes no
nonce: a failure of the batch's own hanko (E4 in the outer check), a wrong nonce, malformed or oversize batches, the bounds, a transaction that offers less than the gas floor to a batch that failed (`BatchGasStarved`; an empty revert reason is no longer one of these, see the second review below), and any batch that carries a dispute, reveal,
hash-ladder or **deposit** op. A bad counterparty signature inside the ops (a settlement or C2R signed at an old account epoch)
is a failure of the batch like any other: `BatchFailed` with E4, nonce spent. Pinned by `test/vm/j5-batch-failed.test.ts` (13),
`test/vm/j5-review-extra.test.ts` (8, the review's) and `test/foundry/J5Attacks.t.sol` (the review's 6, deposit tests flipped
to the fixed behaviour).

**Measured.** Depository 22772 bytes (J2: 22994), Account 24455 (J2: 24448; 121 bytes under 24576, see the C2R follow-up below; the second review below moves them to 23359 and 24400). The self-call wrapper costs
gas, so `MAX_BATCH_RESERVE_TO_COLLATERAL_PAIRS_TOTAL` goes from 256 to 250: 256 pairs measured 15,059,370, over the 15M
liveness budget. 250 pairs (4 entries of 63, 63, 62, 62) measure **14,763,601** execution gas
(`BatchBounds.test_gas_maxReserveToCollateralProduct`, which also fails if the maximal batch stops landing);
`test_reserveToCollateralAggregatePairCapRejectsTwoHundredFiftyOne` pins 251 rejected.

**Two bugs the ripple and the review found.** (1) Inside the self-call msg.sender is the Depository, so an external deposit pulled
tokens from the Depository itself; `applyBatch` takes the outer caller as `payer` (found by Foundry `Lifecycle` and the Hardhat NFT
tests). (2) Deposits pull from the caller and `processBatch` is permissionless, so as a soft failure a relayer without an allowance
could burn the signer's nonce (review F1, `J5Attacks.test_relayerWithoutAllowanceCannotBurnTheNonceOfADepositBatch`); deposit
batches now revert whole.

**Tests rewritten.** Every plain-batch revert assertion became a `BatchFailed` assertion: the reason selector, the entity nonce
spent, no `HankoBatchProcessed`, and the state unchanged (Foundry `_submitFailed`, `_submitFailedUnmoved`; Hardhat
`test/helpers/batch-failed.ts`). 23 Hardhat tests (Depository-part-1 17, part-2 5, DebtForgiveness 1), 5 Foundry `Lifecycle`
tests, `ForkChanges` (three lines), `BoardRotationGrace` (old-board counterparty signatures; the same intent now goes at a fresh
outer nonce, as F1 requires), `c1-epoch` and one vector cell (`settleAtStoredNonce`: "ok, batch failed (E2)"). The test named
"reverts an underfunded R2C batch without consuming its nonce" is now "fails an underfunded R2C batch soft: the nonce is consumed
and nothing moves". One Hardhat test went back to a revert (token-id allocation through a deposit batch). Follow-up (coordinator, 22:59): a C2R with an empty or malformed counterparty signature is a `BatchFailed` E4 with the nonce spent (`Account.processC2R` catches the empty revert of the signature check and reverts E4, as the settlement path did); pinned by two `j5-batch-failed` tests and the Hardhat "fails an unsigned C2R above the retired 2^200 ceiling soft (E4)".
The four invariant handlers count a `BatchFailed` batch as not landed. **`ConservationHandler`** hashes the whole state before
each batch (every reserve, debt, collateral, offset, account nonce and dispute hash) and requires it equal after a failed or
reverted batch; it also seeds debts (`seedDebt`, on the `DepositoryDebtHarness`) and checks that a batch whose R2R legs overspend
a debtor never lands (`invariant_debtorNeverOverspendsThroughABatch`). The review's planted partial-apply mutant k27 (a failing R2R
returns instead of reverting) survived the old handler and is killed by this one. Mutants checked at this head: k27 (handler),
deposit legs dropped from the hard-fail set (3 of 4 `J5Attacks`), the empty-reason hard revert deleted (superseded: with the gas floor an empty reason is `BatchFailed(0)`).

## After the second review of J5 (G1 gas, S1 stuck nonce, B1 co-signed veto)

The second review of #54 (`review/j5-second-review-2026-09-29.md`, decisions in `plan/contracts-decisions.md`, J5 section) found one
hole and two rule gaps.

- **G1: a relayer's gas decided a signature check.** A starved ERC-1271 member four frames down read as an invalid hanko, `Account`
  reverted E4, the parents still held about 6% of the gas (over the 1/32 guard), so a good co-signed C2R became `BatchFailed E4`
  with the nonce spent. Both reviewers found it (first: burn 150K, 749 swept limits for a C2R; second: a 300k member, 538 limits).
  Fixed by a **gas floor** (coordinator's choice over a 1/8 guard and a per-call stipend, both built and dropped): a failure is
  reported only when the self-call started with at least `BATCH_GAS_FLOOR` = 15,000,000 * 64 / 63 + 2,000 = 15,240,095 gas, so it
  cannot have been starvation at any depth; below it the transaction reverts `BatchGasStarved` and takes no nonce. Pinned by
  `test/foundry/J5Starve.t.sol` (8) and `test/vm/j5-gas-floor.test.ts` (4: 20k, 100k, 300k members and a member that rejects under
  500k gas; every limit 40k to 1.4M: never a `BatchFailed`, the estimateGas-style search lands). **Mutant:** deleting the floor
  fails 5 of the 8 `J5StarveTest` tests. Cost: a failing batch with under ~15.24M gas reverts instead of being reported (relayers
  estimate; the vm rig uses 16M).
- **Empty revert reason** (was a hard revert): with the floor it cannot be starvation, so it is `BatchFailed(0x00000000)`, nonce
  spent (a token paused forever no longer stalls the entity; `J5EmptyReasonTest`). The dead `payer` parameter of `applyBatch` is
  gone (deposits revert whole, so nothing in the self-call reads the caller). The conservation fingerprint covers the whole
  `_accounts` record, the debt queue and cursor and the active-debt count; the planted `ondeltaEpoch` residue mutant r3 now fails
  `invariant_everyBatchConservesValue`. `test/vm/j5b-review-extra.test.ts` (the re-review's 12 probes of bad counterparty
  signatures, and the wrong-entity C2R case).
- **S1: a dispute-class batch that can never succeed pinned the entity nonce** (F1 forbids re-signing at it). Skips now cover what
  another party's move made permanent: a finalize whose nonce or side is not the state that settles once the window is over (reason 8; the body hash is not compared, hashing a maximal proof body broke the MAX_SWAP_BOOK gas budget),
  a finalize or counter naming another opening state (reason 3), a rival body at a registered counter's nonce and side (reason 6),
  and every former `E12` of a hash-ladder registration (op 3: window closed or no dispute, reason 9; conflict or lower replay,
  reason 10). Too early still reverts; bytes-only failures still revert. `test/vm/j5-stuck-nonce.test.ts` (7); the three E12
  tests, the conflicting-counter test and the post-T finalize line in `test/protocol/HashLadderRegistry.test.ts` now assert the
  skip; the Foundry `HashLadder` handler counts a `DisputeOpSkipped` registration as not landed (`XlnHanko.opSkipped`).
- **B1: the counterparty (and the relayer) can fail a batch, not only the signer.** No contract change: R-COSIGN, a batch that
  carries a co-signed op carries only ops for that one Account. `test/vm/j5-cosign-veto.test.ts` (2) pins the veto: R starts a
  dispute, L's `[payment, co-signed C2R]` is `BatchFailed E6`, nonce spent, payment gone; control lands.

- **J6 (deposit legs) and A12 (two co-signed proofs at one nonce), from the Quint model, no contract change.** Deposit legs stay in
  the batch as a hard-revert leg (there is no direct deposit path; adding one was refused by the permission classifier and is
  Arthur's call); rules for the Runtime: a deposit leg travels alone, and is signed only after a successful simulation at the
  head; the residual stall (a token paused after the simulation) is accepted in writing. A12: two different co-signed proofs can
  exist at one nonce only with opposite proposer flags; at one nonce LEFT's proposal outranks RIGHT's in a fixed order, whoever
  starts and whoever counters. `test/a12/a12-two-cosigned-proofs.test.ts` (4) pins all three orderings and the same-flag case;
  rule R-ONE-BODY for the Runtime.

**Size.** Depository 23359, Account 24400 (176 bytes under 24576): the shared `_requireCounterpartySignature` replaced two copies of the try/catch and paid for S1's two counter skips. Account's next change still needs a size plan.

Results after J5 (local runs, sandbox with forge 1.7.1, one file or suite per process; the three E4-flip tests re-run after the
sweep and pass; code and tests as committed):

- Foundry, all 17 suites, 0 failures: DebtLifecycle 11, Depository.invariants 16, DepositoryConservation 10, ForkChanges 10,
  HalmosLemmas 6, HankoThreshold 7, HashLadder 9, J5Attacks 1+4+2 (three contracts), Lifecycle 26, RetiredBoardH3 7, Smoke 1,
  TransformerAllowance 8, TransformerFaultModes 15, WideMath 30, WideTransformer 6, BatchBounds 11, DebtChunking 6.
- Hardhat, all 22 files, 0 failures: Depository-part-1 66, part-2 15, DebtForgiveness 2, BoardRotationGrace 6, the rest unchanged.
- `test/vm/`: j5-batch-failed 13, j5-review-extra 8, j2-skip-stale-dispute-ops 12, j2-review-extra 16, c1-epoch 5,
  c2-batch-entity 3, h1-htlc-deadline 5, h2-window-floor 3, h3-retired-board-cap 11, h4-deposit-during-dispute 4, vectors 8;
  `test/gate/`: contract-size 5, deploy-gate 23.

## After the third round of J5 (signed gas budget, epoch in the dispute start, deploy gate)

The second reviewer's third pass and the first reviewer's re-review at 793e6bc (`review/j5-second-review-2026-09-29.md`,
`review/pr-54-review-2026-09-29.md`) showed that a fixed gas floor is the wrong constant. Decisions are in
`plan/contracts-decisions.md`, J5 section, "Signed gas budget" and "Third round of #54".

- **Signed gas budget.** `Batch.gasBudget` (`uint64`, first field, so it is signed). `processBatch` requires
  `gasleft() >= budget * 64 / 63 + BATCH_POST_CALL_RESERVE` (30,000, outside the budget), else `BatchGasStarved`, no nonce. The
  self-call gets exactly `budget`, so once it started every failure inside it (out-of-gas and gas-burning callees included) is
  `BatchFailed`. The floor, its tail check and the `gasBefore / 32` guard are deleted. `DepositoryBounds.assertBatch` rejects a
  budget under `MIN_BATCH_GAS_BUDGET` (500,000) with E10; batches that revert whole ignore the budget but keep the minimum.
- **Return bomb.** A bare assembly `call` reads only the first 4 bytes of the revert data; 1.5, 2 and 3 MB payloads give `BatchFailed`
  with the nonce spent and the next batch landing (`j5-gas-callee`, `J5BloatTest`).
- **Reserve (30,000, outside the budget) gives the callee the WHOLE signed budget.** Corrected at 0aeb766 after both reviewers: the check runs
  about 160 gas before the CALL, and the CALL costs 100 before the EVM takes its 63/64, so with reserve 0 a transaction just above
  `budget * 64/63` hands the callee about 230 gas less than the budget. A batch signed at its exact need then soft-fails and burns its nonce
  at a limit the relayer chose: 232 consecutive limits (772,110 to 772,341) in `j5-gas-exact`, 3,806,117 gas seen against 3,806,337 in
  `J5BudgetBoundary`. Both tests kill the reserve-0 mutant. The overhead is constant (about 230), so 30,000 is generous on purpose. It is not
  what the code after the self-call needs (that is about 2,000, covered by the 1/64 the caller keeps and the gas the callee hands back; see
  the measurement below).
- **Budget drift accepted.** A batch made dearer by a third party between simulation and inclusion becomes `BatchFailed`, nonce spent,
  entity not stalled. Spec rule R-SIMULATE: sign only after a successful simulation at the head, add a named margin, never exceed the
  chain's transaction gas cap, never sign a time-gated op before its gate opens.
- **Epoch in the start (S1').** `InitialDisputeProof.ondeltaEpoch`; a start signed at an old epoch is skipped with
  `DisputeOpSkipped` reason 11, judged before the signature. Declaring the current epoch over an old signature is a real E4.
- **Deploy gate.** `assertDeployGate` = response-window floor, then `assertBatchGasCap`: required tx gas
  `HANKO_PRELUDE_GAS (4,900,000, measured 4,832,492 with the intrinsic gas) + ceil(500,000 * 64 / 63) + 30,000` = 5,437,937, checked against a per-chain cap table (EIP-7825's
  16,777,216 for chain ids 1 and 11155111; unknown chains refused on a mainnet, allowed on a named testnet). Supported board size: 128
  signing validators.
- **Measured** (outer hanko check, EOA validators all signing; `j5-gas-prelude`): 1 validator 64,391 gas, 64 validators 1,348,965, 128
  validators 4,522,148 (superlinear; execution only, the transaction's intrinsic gas of 21,000 + 16 per calldata byte, 310,344 at K=128, was left out until
  the review at 0aeb766: prelude + intrinsic is 114,639 / 1,528,237 / 4,832,492); a failing batch is reported at 602,327, 1,886,901 and 5,060,084. A board of 256 cannot be
  registered in the rig. F2 (two 8-member ERC-1271 boards) needs 15,623,512 gas, fails at a 15M budget and lands from 16,343,968 at a
  16M budget (`j5-gas-budget`).
- **Sizes** (limit 24,576): Depository 23,116, Account 24,427 (149 under; the epoch skip cost 27 bytes).

Results (local runs, sandbox, forge 1.7.1, one file or suite per process): Hardhat `test/dispute`, `test/governance`, `test/protocol` all
green (three tests read the live epoch now: `Depository-part-1` 66, `BoardRotationGrace` 6). vm: c1-epoch 5, c2 3, h1 5, h2 3, h3 11, h4 4,
j2-review-extra 16, j2-skip 12, j5-batch-failed 15, j5-cosign-veto 2, j5-gas-budget 6, j5-gas-callee 6, j5-gas-prelude 3,
j5-review-extra 8, j5-stuck-nonce 9, j5b-review-extra 12, vectors 8. gate: contract-size 5, deploy-gate 29. Foundry: every suite ok
(J5Starve 8, J5Budget 1+4+6+4, BatchBounds 13 with the two new minimum-budget tests). Vectors regenerated (`lifecycle.json` only).
Mutants killed: budget ignored (`j5-gas-budget`, `j5-gas-callee`), `64/63` dropped (`j5-gas-budget`), minimum budget removed
(`BatchBounds`). The Foundry J5 suites alone do not kill the first two; the vm tests do.

### Post-call gas of the failure path (coordinator 02:20: does the 30,000 reserve pay for anything?)

Measured on the real `Depository.processBatch` with a temporary probe (removed; source is unchanged), a withdrawal whose token
callee burns all its gas (INVALID, endless loop, empty revert, revert with a reason), budget 500,000:
- **Gas used after the self-call returns, through the end of the `BatchFailed` log: 1,957** (same for all four callee modes). That
  covers the 4-byte reason read (`returndatacopy`, mask) and the LOG3.
- **No storage write and no cold slot after the call.** The nonce write (`entityNonces[entityId] = nonce`) happens before the
  self-call and its slot is warm afterwards; the failure path writes nothing. The success path emits `HankoBatchProcessed` and writes
  nothing either.
- **What the caller keeps.** The EVM lets the callee take at most 63/64 of what is left, so after a callee that burns everything the
  caller holds at least `gasleft_at_call / 64`: 7,936 at the smallest allowed budget (500,000 * 64/63 / 64) even with no reserve, 37,936
  with the 30,000 reserve added to the requirement. So the margin is 4.05x without the reserve and 19x with it.
- **Boundary sweep** (`BatchGasStarved` vs `BatchFailed` at every limit from 20 below the first non-starved limit to 400 above it,
  callee INVALID, budget 500,000): the real build and the requirement lowered by 0, 4,000, 6,000 and 7,000 gas (a check below the budget
  itself, which hands the callee less than 63/64 of the left gas) all give 0 out-of-gas, 0 unreported returns, 400 of 400 reported.
- **Reading (corrected, see the next section).** The post-call code is safe without any reserve: it needs about 2,000 and the caller keeps at
  least 1/64 (7,936 at the smallest budget), and the second reviewer's step trace found 44,413 held when the self-call returns, 14,668 even at
  reserve 0. But that is the wrong side of the call. My boundary sweep only asked whether the transaction ended cleanly (it did, 400 of 400),
  not whether the callee got the whole budget, so it could not see what the reserve is for. My 02:20 recommendation to drop the reserve was
  wrong and is withdrawn; the reserve stays.

## Fourth round of J5 (coordinator, from the two reviews at 0aeb766): what the reserve is for, boundary tests, gap tests, prelude with intrinsic gas

- **Reserve stays (30,000); its comment and this file now say what it is for:** the callee gets the whole signed budget at every gas limit the
  check accepts. New tests: `test/vm/j5-gas-exact.test.ts` (second reviewer: an ERC-1271 member burning about 600k, budget bisected to the exact
  need, every limit from the check up lands; P part: post-call need 2,052 against 44,413 held) and `test/foundry/J5BudgetBoundary.t.sol` (first
  reviewer: an NFT that reports its own `gas()`; the callee sees exactly the budget at the lowest passing limit and at a much higher one, and
  the limit below reverts). Mutants: reserve 0 is killed by both; the self-call getting budget + 100k is killed only by `J5BudgetBoundary`.
- **Budget attacks** (`test/vm/j5-fourth-budget.test.ts`, 4): another budget under the same signature is E4 with no nonce; uint64 max and
  budgets over the cap are `BatchGasStarved` with no nonce and no overflow; 500,000 lands, 499,999 and 0 are E10; a revert-whole batch ignores the
  budget but keeps the minimum; a member that reads `gasleft()` sees the signed budget, never the relayer's limit, so a simulation at another
  budget disagrees (R-SIMULATE, decisions doc).
- **No upper bound on `gasBudget`** (accepted): a budget no chain can land never lands, the nonce stays open, the entity signs another batch at
  it. Self-inflicted, costs nothing.
- **Gap-killing tests** (first reviewer): `test/vm/j5e-review-outdated.test.ts` (4: every branch of the outdated-finalize-evidence decision;
  killed t07, t08, t09, t11) and the lower-Target ladder replay in `test/protocol/HashLadderRegistry.test.ts` (skip with reason 10, nothing
  changes; killed l03).
- **Prelude constant includes intrinsic gas.** `j5-gas-prelude.test.ts` adds `21,000 + 16 * calldata bytes` (an upper bound) to the rig's
  execution-only measurement (a read-only call charges none): 4,832,492 at K=128, so `HANKO_PRELUDE_GAS` goes from 4,600,000 to 4,900,000 and
  the gate total from 5,137,937 to 5,437,937 (the earlier label 5,137,943 was wrong by 6: 4,600,000 + 507,937 + 30,000). Headroom under the
  EIP-7825 cap is still about 11.3M; no gate decision changes.

### The rewrite's fork shim (`pure/diff/fork-shim.ts`, `pure/diff/contracts.ts`): the two new ABI fields

#50 and #55 are on main, so the shim that lets og's frozen Runtime talk to the fork's Depository now also speaks the J5 ABI:
- `encodeForkBatch` re-encodes og's batch (after `rebindBatch` re-signed it for the epochs on chain) with the fork's `Batch` type: `gasBudget` in
  front (`SHIM_GAS_BUDGET` = 14,000,000: og's BrowserVM sends every processBatch with 15,000,000 gas, and the Depository needs
  `budget * 64/63 + 30,000` plus the hanko prelude on top) and `ondeltaEpoch` in every dispute start (the epoch `rebindBatch` signed it for).
- The calldata view (og reads dispute evidence back out of the transaction) shows og the batch it sealed, not the fork's bytes, because og
  decodes with its own ABI (`J_DISPUTE_PROOFBODY_CALLDATA_DECODE_FAILED` otherwise).
- `installContracts` also swaps `DepositoryBounds`, `HashLadderRegistry` and `NftCustody`, so the linked bounds check reads the fork's `Batch`.
- Results (local, sandbox): `pure/diff/scenario-cross-j.test.ts` 9 of 9 (8 of 9 failed before, every batch refused with a bare revert);
  `bun diff/walk.ts --area disputes|settlement|core|boards --seeds 3`: 3 walks each, 0 failed (disputes failed 3 of 3 with the calldata error
  before the view fix); `bunx tsc -p pure` clean; `bun style/check.ts` at baseline.

### Fourth-round gate (merged head)

Local runs at the merge of main b471747 into the branch, one file or suite per process: Hardhat dispute, governance and protocol all passing except
one test: `Depository-part-1` "keeps the dispute active when any signed transformer cannot execute exactly" times out at Hardhat's 40 s mocha
limit on this machine, taking about 54 s (the out-of-gas mode alone about 52 s, mostly system time). It times out identically on main's own
contracts here (checked in a clean worktree at b471747, same test alone), and the same file passed in 41 s in the earlier sandbox, so the cause
is the machine, not #54; run on a faster one or raise the timeout for that test. vm 20 files, gate 2 files, `test/a12` (4), Foundry every suite: 0 failures.

### Shim budget pin

`pure/diff/fork-shim-budget.test.ts` reads og's processBatch tx gas limit and the reserve from source and fails if the shim's 14,000,000 budget plus the reserve and the hanko prelude of the walk's largest board (`MAX_BOARD_SIGNERS` in `pure/diff/world.ts`) no longer fits the limit. The prelude bound is a chord between the measured points for 1 and 64 signers, so it is an upper bound. Today a board of up to 29 signers fits by that bound (conservative: the first reviewer measured a real limit of about 38); the walk's largest has 3.

**Measured need (instrument on the BrowserVM submit, not committed):** whole `processBatch` execution gas, prelude included, over the four area walks (disputes, settlement, core, boards; 3 seeds each), `scenario.test.ts` and `scenario-cross-j.test.ts`: the largest is **396,485**, most batches about 376,000. The 14,000,000 budget is a ceiling about 35 times that need, chosen to fit og's fixed 15,000,000 tx gas, not a margin measured from the walks.

## Swallowed failures (fifth pass; stacked on #54)

Coordinator 13:55, from the second reviewer's fourth pass (`review/j5-second/0005-transformer-decode-gas-guard.patch`, `j5-fifth-transformer-gas.test.ts`).
Decisions and the 12-site table: `plan/contracts-decisions.md`, "Swallowed failures".

- **The hole.** `DeltaTransformer._decodeArguments` decodes the party's evidence in a try/catch and reads any failure as "no evidence". A decode that ran
  out of gas was one, so a finalize that should pay could land unpaid at a transaction gas limit the relayer chose. The reviewer's scan with 1,700 junk
  secrets: 53 of the limits (step 1,000) gave logs that were neither the paid ones nor a revert. A dispute batch reverts whole, so the transformer runs
  in `processBatch`'s own frame and the relayer's limit matters (inside `applyBatch` the signed budget fixes it).
- **The first fix was not a bound (round 2).** The pre-call floor `gasleft() >= 50,000 + 8 * length` covers a plain decode (at the 64 KiB a side may pass,
  fill ratios need 490,518 gas, secrets 359,702, against 574,288), but both reviewers broke the claim that it covers everything Account lets through:
  the two arrays of `Arguments` may be read from the same words (913,630 to 930,713 needed, valid evidence landed unpaid at limits 580k to 950k), and
  memory already in use makes the decode dearer (negative margin at 800 payments with 64 KiB of counterparty evidence). **The bound is now the check after
  the catch**: a callee that ran out of gas took 63/64 of what it was handed, so if `gasleft() <= gasBefore / 64 + 1,000` the decode was starved and the call
  reverts `DecodeGasBudgetUnavailable`. No size, shape or memory assumption. The floor stays as a fast path (a starved plain decode reverts before it burns the gas).
  Price, accepted: a decode that fails for real after using more than 63/64 of its gas reverts instead of reading as "no evidence".
- **Killers.** `GasGuardUnpaid.t.sol` (aliased evidence, 27 unpaid limits at df2801a, none now), `ReviewB.t.sol` (overlapped evidence through `applyBatch`,
  19 unpaid at df2801a), `GasSwallow.t.sol` (constants read from the contract: the floor must sit 10% above the plain need at every size; the floor at 7, 6 or
  5 gas a byte, at base 0, or deleted each fail; the post-catch check deleted fails the first two), `j5-fifth-transformer-gas.test.ts` (both shapes, step 1,000,
  about 9 minutes for both).
- **The audit (11 project sites, plus OpenZeppelin).** One hole (this one) and one fault-isolation gap: the control-lane reads of a listed Depository were
  uncapped and copied the answer, so one that burned its gas or returned a bomb bricked the lane at every limit up to 16M (`ControlLaneFaultIsolation.test.ts`; the
  read is now `staticcall{gas: 100,000}` into a one-word buffer). The ERC-1271 member call is a real swallow at the verifier and a revert at every consumer:
  `HankoMemberGasSwallowTest` (a member costing 900k) shows (0, false) answered at every sampled limit in the window below the least gas that verifies,
  and `entityTransferTokens` reverting and moving nothing below its least gas. The rest revert or were guarded. `test/gate/swallowed-failures.test.ts` reads the
  compiled AST (build-info) and compares places (source, function, opcode), OpenZeppelin included (the receiver-hook try/catch rethrows; `Math.tryModExp` is
  never called); it fails on a stale build.
- **Runtime notes (no contract change), in `plan/contracts-decisions.md`:** the decode revert reaches the submitter as the generic `TransformerExecutionFailed`
  (accepted); `HANKO_PRELUDE_GAS` 4.9M excludes ERC-1271 member gas (up to 8 x 1,000,000) so R-SIMULATE must simulate the prelude for boards with contract members.
- Folder width: `contracts/test/foundry` has 17 files and `contracts/test/vm` 23 (the limit is 10). The record of those counts is og's `check-folder-width.ts`, which we do not edit, so `check:folder-width` stays red here until the subfolder split (#61) lands.

