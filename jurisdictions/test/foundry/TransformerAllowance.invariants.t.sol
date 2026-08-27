// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {XlnFixture} from "./helpers/XlnFixture.sol";
import {XlnHanko} from "./helpers/XlnHanko.sol";
import {TransformerAllowanceHandler} from "./handlers/TransformerAllowanceHandler.sol";
import {TransformerLivenessHarness} from "../../contracts/mocks/TransformerLivenessHarness.sol";
import "../../contracts/Types.sol";

/// @notice Task C4, target 2: transformer allowances (Account.sol:996).
///
/// Properties under test, on current bytecode, through the real
/// processBatch dispute path with a signed TransformerClause:
///  (a) GATE  — a transformer request that changes delta j is applied only if
///              the clause carries an allowance for j (Account.sol:996-1000);
///  (b) CLAMP — an allowanced change lands exactly on
///              clamp(requested, prev - rightAllowance, prev + leftAllowance)
///              (Account.sol:_clampTransformerValue);
///  (c) VALUE — dispute finalization moves collateral to reserves and never
///              changes Σreserves + Σcollateral for any token.
contract TransformerAllowanceInvariants is XlnFixture {
  TransformerAllowanceHandler internal handler;
  TransformerLivenessHarness internal transformer;

  uint256[2] internal TOKENS = [uint256(1), uint256(3)];

  function setUp() public {
    _deployXln();

    transformer = new TransformerLivenessHarness();
    uint256[4] memory keys = [pk[0], pk[1], pk[2], pk[3]];
    handler = new TransformerAllowanceHandler(dep, keys, address(this), transformer);

    targetContract(address(handler));

    bytes4[] memory selectors = new bytes4[](7);
    selectors[0] = handler.mint.selector;
    selectors[1] = handler.seedCollateral.selector;
    selectors[2] = handler.startTransformedDispute.selector;
    selectors[3] = handler.finalizeTransformed.selector;
    selectors[4] = handler.advancePastDisputeDelay.selector;
    selectors[5] = handler.repayDebt.selector;
    selectors[6] = handler.advance.selector;
    targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
  }

  // ═══════════════ aggregation helpers ═══════════════

  function _totalReserves(uint256 tokenId) internal view returns (uint256 total) {
    for (uint256 i = 0; i < ACTORS; i++) {
      total += dep._reserves(entity[i], tokenId);
    }
  }

  function _totalCollateral(uint256 tokenId) internal view returns (uint256 total) {
    for (uint256 i = 0; i < ACTORS; i++) {
      for (uint256 j = i + 1; j < ACTORS; j++) {
        (uint256 c,) = dep._collaterals(XlnHanko.accountKey(entity[i], entity[j]), tokenId);
        total += c;
      }
    }
  }

  // ═══════════════ invariants ═══════════════

  /// @notice INVARIANT 2a. Internal value for a token equals exactly what the
  ///         admin minted (this handler has no external legs).
  function invariant_valuePoolIsConserved() public view {
    for (uint256 k = 0; k < 2; k++) {
      uint256 t = TOKENS[k];
      assertEq(
        _totalReserves(t) + _totalCollateral(t),
        handler.ghostMinted(t),
        "transformer path created or destroyed value"
      );
    }
  }

  /// @notice INVARIANT 2b (Account.sol:996). No accepted finalization ever
  ///         applied a transformer change on a delta index without allowance.
  function invariant_noDeltaChangeWithoutAllowance() public view {
    assertEq(
      handler.unallowancedChangeViolations(),
      0,
      "un-allowanced transformer delta change was accepted"
    );
  }

  /// @notice INVARIANT 2c. Every observed allowanced (or no-op) transformer
  ///         result equals the exact clamp of the request inside the signed
  ///         band around the pre-transformer delta.
  function invariant_allowancedChangesAreExactlyClamped() public view {
    assertEq(handler.clampViolations(), 0, "applied delta escaped the signed allowance band");
  }

  /// @notice INVARIANT 2d. Dispute finalization conserves the value pool.
  function invariant_finalizeConservesValue() public view {
    assertEq(handler.finalizeValueViolations(), 0, "finalization changed the value pool");
  }

  // ═══════════════ deterministic controls (vacuity proofs) ═══════════════

  /// @dev Actor indexes for the (0,1) pair in canonical LEFT/RIGHT order.
  function _leftActor() internal view returns (uint256) {
    return entity[0] < entity[1] ? 0 : 1;
  }

  function _rightActor() internal view returns (uint256) {
    return entity[0] < entity[1] ? 1 : 0;
  }

  /// @dev Funds LEFT with 2000 reserve + 1000 collateral (ondelta 1000) and
  ///      RIGHT with 2000 reserve, on token 1.
  function _fundPair() internal {
    uint256 left = _leftActor();
    uint256 right = _rightActor();
    dep.mintToReserve(entity[left], 1, 2_000);
    dep.mintToReserve(entity[right], 1, 2_000);
    Batch memory b = XlnHanko.emptyBatch();
    b.reserveToCollateral = new ReserveToCollateral[](1);
    EntityAmount[] memory pairs = new EntityAmount[](1);
    pairs[0] = EntityAmount({ entity: entity[right], amount: 1_000 });
    b.reserveToCollateral[0] = ReserveToCollateral({
      tokenId: 1,
      receivingEntity: entity[left],
      pairs: pairs
    });
    _submit(left, b);
    (, int256 ondelta) = dep._collaterals(XlnHanko.accountKey(entity[left], entity[right]), 1);
    assertEq(ondelta, 1_000, "control setup: ondelta");
  }

  /// @notice CONTROL (gate fires): collateral 1000, ondelta 1000, offdelta 100
  ///         → prev = 1100; the clause requests Absolute(5000) with NO
  ///         allowance. The counterparty's otherwise-legal immediate accept
  ///         MUST revert the whole batch — only the Account.sol:996 gate can
  ///         cause that here (the harness is not the canonical transformer,
  ///         so no Pull clock applies).
  function test_control_unallowancedChangeRevertsFinalization() public {
    _fundPair();
    handler.startTransformedDispute(
      _leftActor(), _rightActor(), 0, 100, 1, 5_000, 0, 0, 1 /* odd: no allowance */
    );
    bytes32 dh = _disputeHashOf(_leftActor(), _rightActor());
    assertTrue(dh != bytes32(0), "control: dispute did not start");

    // bySeed 1 → the non-starter finalizes: legal immediately when pull-free.
    handler.finalizeTransformed(0, 1);
    assertTrue(
      _disputeHashOf(_leftActor(), _rightActor()) != bytes32(0),
      "gate control failed: un-allowanced change finalized"
    );
    assertEq(handler.unallowancedChangeViolations(), 0, "oracle miscounted the reverted control");
  }

  /// @notice CONTROL (clamp exact): same setup but WITH allowance
  ///         (right=50, left=50) → band [1050, 1150]; requested 5000 must
  ///         apply exactly 1150. LEFT keeps collateral 1000 and collects the
  ///         150 shortfall from RIGHT's reserve.
  function test_control_clampAppliesExactBand() public {
    _fundPair();
    handler.startTransformedDispute(
      _leftActor(), _rightActor(), 0, 100, 1, 5_000, 50, 50, 0 /* even: allowance */
    );
    assertTrue(_disputeHashOf(_leftActor(), _rightActor()) != bytes32(0), "control: dispute did not start");

    handler.finalizeTransformed(0, 1);
    assertEq(_disputeHashOf(_leftActor(), _rightActor()), bytes32(0), "control: did not close");

    // LEFT paid 1000 into collateral during setup, so its reserve baseline is
    // 1000; the clamped delta 1150 returns as 1000 collateral + 150 shortfall.
    assertEq(
      int256(int256(dep._reserves(entity[_leftActor()], 1)) - 1_000),
      1_150,
      "LEFT did not receive the clamped delta"
    );
    assertEq(
      2_000 - dep._reserves(entity[_rightActor()], 1),
      150,
      "RIGHT did not fund the shortfall"
    );
    assertEq(handler.clampObservations(), 1, "clamp oracle did not observe the control");
    assertEq(handler.activeClamps(), 1, "control should have been an active clamp");
    assertEq(handler.clampViolations(), 0, "clamp oracle flagged the correct control");
  }

  function _disputeHashOf(uint256 a, uint256 b) internal view returns (bytes32 h) {
    (, h, , , , , , , , , , , , , ) = dep._accounts(XlnHanko.accountKey(entity[a], entity[b]));
  }

  // ═══════════════ C4-hardening wave 2 (audit A4): fault-mode disputes ═══════════════

  /// @notice CONTROL (fault modes through the REAL processBatch dispute
  ///          path): a dispute whose signed ProofBody carries a fault-mode
  ///          clause (RevertCall; MalformedReturn/WrongLength are covered at
  ///          the harness level in TransformerFaultModes.t.sol) can NEVER
  ///          finalize — not by the non-starter's immediate accept, not by
  ///          the starter after timeout — the Account stays disputed until a
  ///          NEWER counterparty-signed pull-free state replaces it. Closing
  ///          with that clean body must still land inside the signed clamp
  ///          band (the fault clause never silently applied anything).
  function test_control_faultModeDisputeOnlyClosesViaCleanCounterState() public {
    _fundPair();
    uint256 left = _leftActor();
    uint256 right = _rightActor();
    uint256 nonce = _accountNonceOf(left, right) + 1;
    bytes32 watchSeed = keccak256("fault-mode");
    bytes memory key = XlnHanko.accountKey(entity[left], entity[right]);

    // Fault body: offdelta 100 (prev = 1000+100 = 1100), clause RevertCall
    // requesting Add(5000) WITH allowance — the fault is the only blocker.
    ProofBody memory faultPb;
    faultPb.watchSeed = watchSeed;
    faultPb.leftResponseSeconds = 50;
    faultPb.rightResponseSeconds = 50;
    faultPb.offdeltas = new int256[](1);
    faultPb.offdeltas[0] = 100;
    faultPb.tokenIds = new uint256[](1);
    faultPb.tokenIds[0] = 1;
    faultPb.transformers = new TransformerClause[](1);
    Allowance[] memory faultAllowances = new Allowance[](1);
    faultAllowances[0] = Allowance({ deltaIndex: 0, rightAllowance: 50, leftAllowance: 50 });
    faultPb.transformers[0] = TransformerClause({
      transformerAddress: address(transformer),
      encodedBatch: transformer.encode(TransformerLivenessHarness.Mode.RevertCall, 0, 5_000, 1),
      allowances: faultAllowances
    });
    bytes32 faultHash = keccak256(abi.encode(faultPb));

    // Start by LEFT (starter), inner proof authored/signed by RIGHT.
    bool startProposerIsLeft = false; // RIGHT authored the initial proof
    bytes32 startH = XlnHanko.disputeProofHash(address(dep), key, nonce, startProposerIsLeft, faultHash, watchSeed);
    Batch memory start = XlnHanko.emptyBatch();
    start.disputeStarts = new InitialDisputeProof[](1);
    start.disputeStarts[0] = InitialDisputeProof({
      counterentity: entity[right],
      nonce: nonce,
      proposerIsLeft: startProposerIsLeft,
      proofbodyHash: faultHash,
      initialProofbody: faultPb,
      watchSeed: watchSeed,
      sig: _hanko(right, startH),
      starterInitialArguments: "",
      starterCounterArguments: "",
      starterCounterProofCommitment: bytes32(0)
    });
    assertTrue(_submit(left, start), "fault control: dispute start failed");
    assertTrue(_disputeHashOf(left, right) != bytes32(0), "fault control: dispute not live");

    // 1) Non-starter immediate finalize of the fault body: must revert.
    Batch memory finFault = XlnHanko.emptyBatch();
    finFault.disputeFinalizations = new FinalDisputeProof[](1);
    finFault.disputeFinalizations[0] = FinalDisputeProof({
      counterentity: entity[left],
      initialNonce: nonce,
      finalNonce: nonce,
      proposerIsLeft: startProposerIsLeft,
      initialProofbodyHash: faultHash,
      finalProofbody: faultPb,
      starterArguments: "",
      otherArguments: "",
      sig: "",
      startedByLeft: true, // LEFT is the starter
      cooperative: false
    });
    bytes memory finFaultEncoded = abi.encode(finFault);
    uint256 rightNonce = dep.entityNonces(entity[right]) + 1;
    bytes32 rightBatchH =
      XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), finFaultEncoded, rightNonce);
    vm.expectRevert();
    dep.processBatch(finFaultEncoded, _hanko(right, rightBatchH), rightNonce);
    assertTrue(_disputeHashOf(left, right) != bytes32(0), "fault finalize must leave the dispute live");

    // 2) Starter after timeout: still reverts (fault modes are permanent).
    (, , uint256 timeout, , , , , , , , , , , , ) = dep._accounts(key);
    vm.warp(timeout + 1);
    uint256 leftNonce = dep.entityNonces(entity[left]) + 1;
    bytes32 leftBatchH =
      XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), finFaultEncoded, leftNonce);
    vm.expectRevert();
    dep.processBatch(finFaultEncoded, _hanko(left, leftBatchH), leftNonce);
    assertTrue(_disputeHashOf(left, right) != bytes32(0), "timeout fault finalize must leave the dispute live");

    // 3) Close via a NEWER counterparty-signed clean state: authored by LEFT
    //    (proposerIsLeft = true), signed by LEFT's Hanko, submitted by the
    //    non-starter RIGHT. Clause Add(5000) with allowance ±50.
    ProofBody memory cleanPb;
    cleanPb.watchSeed = watchSeed;
    cleanPb.leftResponseSeconds = 50;
    cleanPb.rightResponseSeconds = 50;
    cleanPb.offdeltas = new int256[](1);
    cleanPb.offdeltas[0] = 100;
    cleanPb.tokenIds = new uint256[](1);
    cleanPb.tokenIds[0] = 1;
    cleanPb.transformers = new TransformerClause[](1);
    Allowance[] memory cleanAllowances = new Allowance[](1);
    cleanAllowances[0] = Allowance({ deltaIndex: 0, rightAllowance: 50, leftAllowance: 50 });
    cleanPb.transformers[0] = TransformerClause({
      transformerAddress: address(transformer),
      encodedBatch: transformer.encode(TransformerLivenessHarness.Mode.Add, 0, 5_000, 1),
      allowances: cleanAllowances
    });
    bytes32 cleanHash = keccak256(abi.encode(cleanPb));
    uint256 cleanNonce = nonce + 1;

    bytes32 cleanH =
      XlnHanko.disputeProofHash(address(dep), key, cleanNonce, true, cleanHash, watchSeed);
    Batch memory finClean = XlnHanko.emptyBatch();
    finClean.disputeFinalizations = new FinalDisputeProof[](1);
    finClean.disputeFinalizations[0] = FinalDisputeProof({
      counterentity: entity[left],
      initialNonce: nonce,
      finalNonce: cleanNonce,
      proposerIsLeft: true,
      initialProofbodyHash: faultHash,
      finalProofbody: cleanPb,
      starterArguments: "",
      otherArguments: "",
      sig: _hanko(left, cleanH),
      startedByLeft: true,
      cooperative: false
    });
    assertTrue(
      _submit(right, finClean), "fault control: clean counter-state must close the dispute"
    );
    assertEq(_disputeHashOf(left, right), bytes32(0), "fault control: dispute must be closed");

    // The clean close still clamps exactly: prev 1100, band [1050,1150],
    // requested 1100+5000 -> 1150. LEFT keeps 1000 collateral + 150 shortfall
    // from RIGHT (same economics as the wave-1 clamp control).
    assertEq(
      int256(int256(dep._reserves(entity[left], 1)) - 1_000),
      1_150,
      "clean close did not apply the clamped delta"
    );
    assertEq(2_000 - dep._reserves(entity[right], 1), 150, "RIGHT did not fund the shortfall");
    // The fault clause never moved anything before reverting.
    assertEq(handler.unallowancedChangeViolations(), 0, "fault leaked through the gate oracle");
    assertEq(handler.clampViolations(), 0, "fault leaked through the clamp oracle");
  }

  /// @dev Account nonce helper on raw actor indexes.
  function _accountNonceOf(uint256 a, uint256 b) internal view returns (uint256 n) {
    (n, , , , , , , , , , , , , , ) = dep._accounts(XlnHanko.accountKey(entity[a], entity[b]));
  }

  // ═══════════════ coverage report ═══════════════

  function invariant_callSummary() public view {
    console.log("disputes started   ", handler.disputesStarted());
    console.log("finalizes accepted ", handler.acceptedFinalizes());
    console.log("finalizes rejected ", handler.rejectedFinalizes());
    console.log("-- clamp observed  ", handler.clampObservations());
    console.log("-- actively clamped", handler.activeClamps());
    console.log("-- early attempts  ", handler.starterEarlyAttempts());
    console.log("-- debt repairs     ", handler.debtRepairs());
    console.log("-- minted t1 / t3  ", handler.ghostMinted(1), handler.ghostMinted(3));
  }
}
