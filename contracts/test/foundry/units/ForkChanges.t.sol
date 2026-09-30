// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {XlnFixture} from "../helpers/XlnFixture.sol";
import {XlnHanko} from "../helpers/XlnHanko.sol";
import {DeltaTransformer} from "../../../contracts/DeltaTransformer.sol";
import "../../../contracts/Types.sol";

/// @notice Concrete Foundry coverage of what the fork changed against og: C1 (ondelta epoch), C2 (batch bound to the
///         acting entity), H1 (finalize waits for an open HTLC deadline), H2 (60 s response-window floor) and the nonce
///         rules. The inherited invariant handlers drive the happy paths of these; this file pins the refusals and the
///         exact counters, so a regression in any of them fails a named test instead of only shifting a fuzz mix.
contract ForkChangesTest is XlnFixture {
  uint256 internal constant T = 1;
  uint256 internal constant T0 = 1_800_000_000;

  uint256 internal L; // actor index of the Left entity (smaller entity id)
  uint256 internal R; // actor index of the Right entity

  function setUp() public {
    _deployXln();
    L = entity[0] < entity[1] ? 0 : 1;
    R = 1 - L;
    vm.warp(T0);
  }

  // ───────────────────────── helpers ─────────────────────────

  function _key() internal view returns (bytes memory) {
    return XlnHanko.accountKey(entity[L], entity[R]);
  }

  function _nonce() internal view returns (uint256 n) {
    (n, , , , , , , , , , , , , , , , ) = dep._accounts(_key());
  }

  function _disputeHash() internal view returns (bytes32 h) {
    (, h, , , , , , , , , , , , , , , ) = dep._accounts(_key());
  }

  function _epoch() internal view returns (uint256) {
    return dep.ondeltaEpoch(entity[L], entity[R]);
  }

  function _body(int256 offdelta, uint32 leftWindow, uint32 rightWindow) internal pure returns (ProofBody memory pb) {
    pb.watchSeed = keccak256("fork-changes");
    pb.leftResponseSeconds = leftWindow;
    pb.rightResponseSeconds = rightWindow;
    pb.offdeltas = new Int512[](1);
    pb.offdeltas[0] = WideMath.fromInt(offdelta);
    pb.tokenIds = new uint256[](1);
    pb.tokenIds[0] = T;
    pb.transformers = new TransformerClause[](0);
  }

  function _body(int256 offdelta) internal pure returns (ProofBody memory) {
    return _body(offdelta, 60, 60);
  }

  /// @dev Both parties funded; Left puts `collateral` into the Account (R2C, no epoch change).
  function _fund(uint256 reserve, uint256 collateral) internal {
    dep.mintToReserve(entity[L], T, reserve);
    dep.mintToReserve(entity[R], T, reserve);
    if (collateral == 0) return;
    Batch memory b = XlnHanko.emptyBatch();
    b.reserveToCollateral = new ReserveToCollateral[](1);
    EntityAmount[] memory pairs = new EntityAmount[](1);
    pairs[0] = EntityAmount({entity: entity[R], amount: collateral});
    b.reserveToCollateral[0] = ReserveToCollateral({tokenId: T, receivingEntity: entity[L], pairs: pairs});
    _submit(L, b);
  }

  function _start(
    uint256 starter,
    uint256 nonce,
    ProofBody memory pb,
    bytes32 signedHash
  ) internal view returns (Batch memory b, bytes32 pbHash) {
    uint256 counter = 1 - starter;
    pbHash = keccak256(abi.encode(pb));
    b = XlnHanko.emptyBatch();
    b.disputeStarts = new InitialDisputeProof[](1);
    b.disputeStarts[0] = InitialDisputeProof({
      counterentity: entity[counter],
      nonce: nonce,
      ondeltaEpoch: XlnHanko.currentEpoch(address(dep), _key()),
      proposerIsLeft: counter == L,
      proofbodyHash: pbHash,
      initialProofbody: pb,
      watchSeed: pb.watchSeed,
      sig: _hanko(counter, signedHash),
      starterInitialArguments: "",
      starterCounterArguments: "",
      starterCounterProofCommitment: bytes32(0)
    });
  }

  /// @dev Start signed by the counterparty at the Account's CURRENT epoch.
  function _startNow(uint256 starter, uint256 nonce, ProofBody memory pb) internal view returns (Batch memory b) {
    bytes32 pbHash = keccak256(abi.encode(pb));
    bytes32 h = XlnHanko.disputeProofHash(address(dep), _key(), nonce, (1 - starter) == L, pbHash, pb.watchSeed);
    (b, ) = _start(starter, nonce, pb, h);
  }

  function _timeoutFinalizeBatch(uint256 starter, uint256 nonce, ProofBody memory pb, bytes32 pbHash)
    internal view returns (Batch memory b)
  {
    b = XlnHanko.emptyBatch();
    b.disputeFinalizations = new FinalDisputeProof[](1);
    b.disputeFinalizations[0] = FinalDisputeProof({
      counterentity: entity[1 - starter],
      initialNonce: nonce,
      finalNonce: nonce,
      proposerIsLeft: (1 - starter) == L,
      initialProofbodyHash: pbHash,
      finalProofbody: pb,
      starterArguments: "",
      otherArguments: "",
      sig: "",
      startedByLeft: starter == L,
      cooperative: false
    });
  }

  function _submitExpectRevert(uint256 actor, Batch memory b, bytes memory revertData) internal {
    bytes memory encoded = abi.encode(b);
    uint256 nonce = dep.entityNonces(entity[actor]) + 1;
    bytes32 h = XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), entity[actor], encoded, nonce);
    bytes memory hanko = _hanko(actor, h);
    vm.expectRevert(revertData);
    dep.processBatch(entity[actor], encoded, hanko, nonce);
  }

  function _settlementBatch(SettlementDiff[] memory diffs, uint256 nonce, bytes memory sig)
    internal view returns (Batch memory b)
  {
    b = XlnHanko.emptyBatch();
    b.settlements = new Settlement[](1);
    b.settlements[0] = Settlement({
      leftEntity: entity[L], rightEntity: entity[R], diffs: diffs,
      forgiveDebtsInTokenIds: new uint256[](0), sig: sig, nonce: nonce
    });
  }

  /// @dev Reserve transfer Left -> Right of `amount`; no collateral movement.
  function _transferDiffs(uint256 amount) internal pure returns (SettlementDiff[] memory diffs) {
    diffs = new SettlementDiff[](1);
    diffs[0] = SettlementDiff({
      tokenId: T,
      leftDiff: SignedAmount(true, amount),
      rightDiff: SignedAmount(false, amount),
      collateralDiff: SignedAmount(false, 0),
      ondeltaDiff: SignedAmount(false, 0)
    });
  }

  function _c2rBatch(uint256 amount, uint256 nonce, bytes32 signedHash) internal view returns (Batch memory b) {
    b = XlnHanko.emptyBatch();
    b.collateralToReserve = new CollateralToReserve[](1);
    b.collateralToReserve[0] = CollateralToReserve({
      counterparty: entity[R], tokenId: T, amount: amount, nonce: nonce, sig: _hanko(R, signedHash)
    });
  }

  function _c2rDiffs(uint256 amount) internal pure returns (SettlementDiff[] memory diffs) {
    diffs = new SettlementDiff[](1);
    diffs[0] = SettlementDiff({
      tokenId: T,
      leftDiff: SignedAmount(false, amount),
      rightDiff: SignedAmount(false, 0),
      collateralDiff: SignedAmount(true, amount),
      ondeltaDiff: SignedAmount(true, amount)
    });
  }

  // ───────────────────────── C2: the batch binds the acting entity ─────────────────────────

  function test_c2_batchSignedForOneEntityIsRejectedForAnother() public {
    dep.mintToReserve(entity[0], T, 10);
    Batch memory b = XlnHanko.emptyBatch();
    b.reserveToReserve = new ReserveToReserve[](1);
    b.reserveToReserve[0] = ReserveToReserve({receivingEntity: entity[1], tokenId: T, amount: 1});
    bytes memory encoded = abi.encode(b);

    // Entity 0's key signs the payload for entity 0 ...
    bytes32 h0 = XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), entity[0], encoded, 1);
    bytes memory hanko0 = _hanko(0, h0);

    // ... it authorizes nothing when the caller names entity 1 (the payload differs, the recovered signer is not 1).
    vm.expectRevert(E4.selector);
    dep.processBatch(entity[1], encoded, hanko0, 1);

    // Entity 1 cannot sign entity 0's payload either: the recovered entity is 1, not the named 0.
    bytes memory hanko1 = _hanko(1, h0);
    vm.expectRevert(E4.selector);
    dep.processBatch(entity[0], encoded, hanko1, 1);

    // Nothing moved and no nonce was consumed by the refusals.
    assertEq(dep.entityNonces(entity[0]), 0);
    assertEq(dep.entityNonces(entity[1]), 0);
    assertEq(dep._reserves(entity[0], T), 10);

    // The correctly named batch is accepted.
    dep.processBatch(entity[0], encoded, hanko0, 1);
    assertEq(dep.entityNonces(entity[0]), 1);
    assertEq(dep._reserves(entity[1], T), 1);
  }

  function test_c2_entityIdZeroIsNeverAnActingEntity() public {
    Batch memory b = XlnHanko.emptyBatch();
    bytes memory encoded = abi.encode(b);
    bytes32 h = XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), bytes32(0), encoded, 1);
    bytes memory hanko = _hanko(0, h);
    vm.expectRevert(E4.selector);
    dep.processBatch(bytes32(0), encoded, hanko, 1);
  }

  // ───────────────────────── C1: ondelta epoch ─────────────────────────

  /// @dev Epoch advances on cooperative settlement, C2R and dispute finalize, and NOT on R2C.
  function test_c1_epochAdvancesOnSettlementC2RAndFinalizeNotOnR2C() public {
    assertEq(_epoch(), 0, "fresh account");
    _fund(1_000, 100); // R2C
    assertEq(_epoch(), 0, "R2C must not advance the epoch");

    // C2R (signed by Right at epoch 0, account nonce 1)
    bytes32 h = XlnHanko.cooperativeUpdateHash(address(dep), _key(), 1, _c2rDiffs(10), new uint256[](0));
    _submit(L, _c2rBatch(10, 1, h));
    assertEq(_nonce(), 1);
    assertEq(_epoch(), 1, "C2R advances the epoch");

    // Cooperative settlement (signed by Right at epoch 1, account nonce 2)
    SettlementDiff[] memory diffs = _transferDiffs(5);
    bytes32 sh = XlnHanko.cooperativeUpdateHash(address(dep), _key(), 2, diffs, new uint256[](0));
    _submit(L, _settlementBatch(diffs, 2, _hanko(R, sh)));
    assertEq(_nonce(), 2);
    assertEq(_epoch(), 2, "settlement advances the epoch");

    // A further R2C keeps it
    Batch memory b = XlnHanko.emptyBatch();
    b.reserveToCollateral = new ReserveToCollateral[](1);
    EntityAmount[] memory pairs = new EntityAmount[](1);
    pairs[0] = EntityAmount({entity: entity[R], amount: 1});
    b.reserveToCollateral[0] = ReserveToCollateral({tokenId: T, receivingEntity: entity[L], pairs: pairs});
    _submit(L, b);
    assertEq(_epoch(), 2, "R2C after settlement keeps the epoch");

    // Dispute finalize (unilateral timeout) advances it and leaves nonce = start nonce + 1.
    ProofBody memory pb = _body(-3);
    uint256 startNonce = 3;
    Batch memory start = _startNow(L, startNonce, pb);
    _submit(L, start);
    assertEq(_nonce(), startNonce, "start stores the start nonce");
    assertEq(_epoch(), 2, "start does not advance the epoch");
    vm.warp(T0 + 120);
    Batch memory fin = _timeoutFinalizeBatch(L, startNonce, pb, keccak256(abi.encode(pb)));
    _submit(L, fin);
    assertEq(_disputeHash(), bytes32(0), "dispute closed");
    assertEq(_nonce(), startNonce + 1, "unilateral timeout finalize stores start nonce + 1");
    assertEq(_epoch(), 3, "finalize advances the epoch");
  }

  /// @dev A proof or settlement signed for an earlier baseline is dead after the epoch advances; the same artifact
  ///      re-signed at the new epoch is accepted.
  function test_c1_staleEpochProofAndSettlementAreRejected() public {
    _fund(1_000, 100);
    uint256 e0 = _epoch();
    ProofBody memory stale = _body(-40);
    bytes32 staleHash = keccak256(abi.encode(stale));
    bytes32 staleProofSigned = XlnHanko.disputeProofHashAtEpoch(
      address(dep), _key(), e0, 7, false, staleHash, stale.watchSeed
    );
    SettlementDiff[] memory staleDiffs = _transferDiffs(20);
    bytes32 staleSettlementSigned = XlnHanko.cooperativeUpdateHashAtEpoch(
      address(dep), _key(), e0, 9, staleDiffs, new uint256[](0)
    );

    // Left withdraws 10 at nonce 5, signed at epoch e0: advances the epoch.
    SettlementDiff[] memory first = _c2rDiffs(10);
    bytes32 firstHash = XlnHanko.cooperativeUpdateHashAtEpoch(address(dep), _key(), e0, 5, first, new uint256[](0));
    _submit(L, _c2rBatch(10, 5, firstHash));
    uint256 e1 = _epoch();
    assertEq(e1, e0 + 1);

    // Both stale artifacts carry a nonce above 5 and were signed before the settlement.
    (Batch memory staleStart, ) = _start(L, 7, stale, staleProofSigned);
    _submitExpectRevert(L, staleStart, abi.encodeWithSelector(E4.selector));
    // J5: a stale co-signed settlement is a bad counterparty signature inside the ops: the batch fails E4, its nonce is spent
    _submitFailedUnmoved(L, _settlementBatch(staleDiffs, 9, _hanko(R, staleSettlementSigned)), E4.selector, entity[R], T);

    // Re-signed for the new baseline they are accepted.
    _submit(L, _startNow(L, 7, stale));
    assertEq(_nonce(), 7);
  }

  /// @dev The same is true after a dispute finalize: a higher-nonce proof signed before it cannot start a second dispute.
  function test_c1_preFinalizeProofCannotStartASecondDispute() public {
    _fund(1_000, 100);
    uint256 e0 = _epoch();
    ProofBody memory p3 = _body(-10);
    ProofBody memory p5 = _body(-30);
    bytes32 p5Signed = XlnHanko.disputeProofHashAtEpoch(
      address(dep), _key(), e0, 5, false, keccak256(abi.encode(p5)), p5.watchSeed
    );
    _submit(L, _startNow(L, 3, p3));
    vm.warp(T0 + 120);
    _submit(L, _timeoutFinalizeBatch(L, 3, p3, keccak256(abi.encode(p3))));
    assertEq(_nonce(), 4, "timeout at nonce 3 leaves nonce 4");
    assertEq(_epoch(), e0 + 1);
    (Batch memory again, ) = _start(L, 5, p5, p5Signed);
    _submitExpectRevert(L, again, abi.encodeWithSelector(E4.selector));
  }

  // ───────────────────────── nonces ─────────────────────────

  function test_nonce_startSettlementAndC2RNeedNonceAboveStored() public {
    _fund(1_000, 100);
    // settlement at nonce 3 lifts the stored nonce to 3
    SettlementDiff[] memory diffs = _transferDiffs(5);
    bytes32 sh = XlnHanko.cooperativeUpdateHash(address(dep), _key(), 3, diffs, new uint256[](0));
    _submit(L, _settlementBatch(diffs, 3, _hanko(R, sh)));
    assertEq(_nonce(), 3);

    // start at nonce == stored and below: skipped (J2), not reverted; nothing moves
    _submitSkipped(L, _startNow(L, 3, _body(0)), entity[R], T, OP_START, SKIP_NONCE_NOT_ABOVE_STORED, 3);
    _submitSkipped(L, _startNow(L, 2, _body(0)), entity[R], T, OP_START, SKIP_NONCE_NOT_ABOVE_STORED, 2);

    // settlement at nonce == stored: the batch fails E2 (J5; the signature is valid at the current epoch), nothing moves
    bytes32 sh3 = XlnHanko.cooperativeUpdateHash(address(dep), _key(), 3, diffs, new uint256[](0));
    _submitFailedUnmoved(L, _settlementBatch(diffs, 3, _hanko(R, sh3)), E2.selector, entity[R], T);

    // C2R at nonce == stored: the batch fails E2, nothing moves
    bytes32 ch = XlnHanko.cooperativeUpdateHash(address(dep), _key(), 3, _c2rDiffs(1), new uint256[](0));
    _submitFailedUnmoved(L, _c2rBatch(1, 3, ch), E2.selector, entity[R], T);

    // the strictly greater nonce works
    _submit(L, _startNow(L, 4, _body(0)));
    assertEq(_nonce(), 4);
  }

  // ───────────────────────── H2: response-window floor ─────────────────────────

  function test_h2_responseWindowsBelowSixtySecondsAreRejected() public {
    _fund(1_000, 100);
    bytes memory tooShort = abi.encodeWithSelector(IDepositoryDelegateErrorAbi.ResponseWindowTooShort.selector, uint256(60));
    _submitExpectRevert(L, _startNow(L, 1, _body(0, 59, 60)), tooShort);
    _submitExpectRevert(L, _startNow(L, 1, _body(0, 60, 59)), tooShort);
    _submitExpectRevert(L, _startNow(L, 1, _body(0, 0, 0)), tooShort);
    // exactly 60 on both sides is accepted
    _submit(L, _startNow(L, 1, _body(0, 60, 60)));
    assertTrue(_disputeHash() != bytes32(0));
  }

  // ───────────────────────── H1: finalize waits for an open HTLC deadline ─────────────────────────

  bytes32 internal constant SECRET = keccak256("fork-changes-h1-preimage");

  function _htlcBody(uint256 deadline) internal view returns (ProofBody memory pb) {
    pb = _body(0);
    DeltaTransformer.Payment[] memory payments = new DeltaTransformer.Payment[](1);
    // +50 to Left's allocation: Right pays Left when the secret is revealed in time.
    payments[0] = DeltaTransformer.Payment({
      deltaIndex: 0, amount: SignedAmount(false, 50), revealedUntilTimestamp: deadline,
      hash: keccak256(abi.encode(SECRET))
    });
    DeltaTransformer.Batch memory tb;
    tb.payment = payments;
    tb.swap = new DeltaTransformer.Swap[](0);
    tb.pull = new DeltaTransformer.Pull[](0);
    Allowance[] memory allowances = new Allowance[](1);
    allowances[0] = Allowance({deltaIndex: 0, rightAllowance: 50, leftAllowance: 50});
    pb.transformers = new TransformerClause[](1);
    pb.transformers[0] = TransformerClause({
      transformerAddress: address(deltaTransformer),
      encodedBatch: abi.encode(tb),
      allowances: allowances
    });
  }

  /// @dev Right starts (so Left is the non-starter with the newer-state option); returns the finalize batch.
  function _openHtlcDispute(uint256 deadline) internal returns (Batch memory fin, ProofBody memory pb) {
    _fund(1_000, 0);
    pb = _htlcBody(deadline);
    _submit(R, _startNow(R, 1, pb));
    fin = _timeoutFinalizeBatch(R, 1, pb, keccak256(abi.encode(pb)));
  }

  function _reveal(uint256 actor) internal {
    Batch memory b = XlnHanko.emptyBatch();
    b.revealSecrets = new SecretReveal[](1);
    b.revealSecrets[0] = SecretReveal({transformer: address(deltaTransformer), secret: SECRET});
    _submit(actor, b);
  }

  function test_h1_unrevealedHtlcBlocksFinalizeUntilItsDeadline() public {
    uint256 deadline = T0 + 1_000;
    (Batch memory fin, ) = _openHtlcDispute(deadline);
    // Both response windows are long over (start + 120), but the payment deadline is still open: finalization waits.
    vm.warp(T0 + 200);
    _submitExpectRevert(R, fin, abi.encodeWithSelector(DeltaTransformer.PaymentRevealWindowActive.selector, deadline));
    // the deadline second itself still counts for a reveal, so the wait includes it
    vm.warp(deadline);
    _submitExpectRevert(R, fin, abi.encodeWithSelector(DeltaTransformer.PaymentRevealWindowActive.selector, deadline));
    assertTrue(_disputeHash() != bytes32(0), "dispute must stay open while waiting");
    // after it, an unrevealed payment settles as unpaid and the dispute closes
    vm.warp(deadline + 1);
    _submit(R, fin);
    assertEq(_disputeHash(), bytes32(0));
    assertEq(dep._reserves(entity[L], T), 1_000, "unpaid: Left reserve untouched");
    assertEq(dep._reserves(entity[R], T), 1_000, "unpaid: Right reserve untouched");
  }

  function test_h1_publicSecretEndsTheWaitAndThePaymentSettles() public {
    uint256 deadline = T0 + 1_000;
    (Batch memory fin, ) = _openHtlcDispute(deadline);
    vm.warp(T0 + 200);
    _reveal(L); // anyone may publish the preimage before the deadline
    _submit(R, fin);
    assertEq(_disputeHash(), bytes32(0));
    assertEq(dep._reserves(entity[L], T), 1_050, "paid: Left +50");
    assertEq(dep._reserves(entity[R], T), 950, "paid: Right -50");
  }

  function test_h1_secretRevealedAfterTheDeadlineIsNotPaid() public {
    uint256 deadline = T0 + 1_000;
    (Batch memory fin, ) = _openHtlcDispute(deadline);
    vm.warp(deadline + 1);
    _reveal(L); // too late: sticky first-seen timestamp is after the deadline
    _submit(R, fin);
    assertEq(dep._reserves(entity[L], T), 1_000);
    assertEq(dep._reserves(entity[R], T), 1_000);
  }
}
