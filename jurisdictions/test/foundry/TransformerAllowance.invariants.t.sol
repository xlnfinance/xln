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
    selectors[5] = handler.advance.selector;
    selectors[6] = handler.mint.selector;
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

  // ═══════════════ coverage report ═══════════════

  function invariant_callSummary() public view {
    console.log("disputes started   ", handler.disputesStarted());
    console.log("finalizes accepted ", handler.acceptedFinalizes());
    console.log("finalizes rejected ", handler.rejectedFinalizes());
    console.log("-- clamp observed  ", handler.clampObservations());
    console.log("-- actively clamped", handler.activeClamps());
    console.log("-- early attempts  ", handler.starterEarlyAttempts());
    console.log("-- minted t1 / t3  ", handler.ghostMinted(1), handler.ghostMinted(3));
  }
}
