// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {XlnFixture} from "./helpers/XlnFixture.sol";
import {XlnHanko} from "./helpers/XlnHanko.sol";
import {DebtLifecycleHandler} from "./handlers/DebtLifecycleHandler.sol";
import "../../contracts/Types.sol";

/// @notice C4 hardening wave 2 (c4-adversary A1-A3): the debt lifecycle under
///         the conservation oracles, with debts actually existing.
///
/// Wave-1's conservation model could not create debt (no dispute finalization,
/// always-empty forgiveness), and `invariant_debtNeverEntersValuePool` was a
/// byte-identical duplicate of the pool invariant reading no debt state. This
/// suite closes both: DebtLifecycleHandler books real shortfall debts, repays
/// them (chunked and partial), and forgives them (O(1) cursor-head), while a
/// ghost FIFO queue — simulated independently from Account.enforceDebts and
/// Depository._forgiveDebtsBetweenEntities semantics — is checked against the
/// real chain queue after every action.
///
/// Token map: 1 -> ERC20-backed `erc20`, 3 -> unregistered (mint-only).
contract DebtLifecycleInvariants is XlnFixture {
  DebtLifecycleHandler internal handler;

  uint256[2] internal TOKENS = [uint256(1), uint256(3)];

  function setUp() public {
    _deployXln();
    uint256[4] memory keys = [pk[0], pk[1], pk[2], pk[3]];
    handler = new DebtLifecycleHandler(dep, keys, address(this));

    targetContract(address(handler));
    bytes4[] memory selectors = new bytes4[](9);
    selectors[0] = handler.mint.selector;
    selectors[1] = handler.seedCollateral.selector;
    selectors[2] = handler.spend.selector;
    selectors[3] = handler.openDebtDispute.selector;
    selectors[4] = handler.finalizeDebtDispute.selector;
    selectors[5] = handler.enforceDebt.selector;
    selectors[6] = handler.forgiveDebt.selector;
    selectors[7] = handler.advancePastDisputeDelay.selector;
    selectors[8] = handler.advance.selector;
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

  function _externalBacking(uint256 tokenId) internal view returns (uint256) {
    if (tokenId == 1) return erc20.balanceOf(address(dep));
    return 0; // token 3 has no external leg
  }

  // ═══════════════ invariants ═══════════════

  /// @notice INVARIANT (state form). For every token, the internal value pool
  ///         equals exactly what admin minting injected — while debts exist.
  function invariant_valuePoolIsConserved() public view {
    for (uint256 k = 0; k < 2; k++) {
      uint256 t = TOKENS[k];
      assertEq(
        _totalReserves(t) + _totalCollateral(t),
        handler.ghostMinted(t) + _externalBacking(t),
        "value created or destroyed"
      );
    }
  }

  /// @notice INVARIANT (books, ghost-vs-real). For every actor × token the
  ///         real debt book equals the independently simulated FIFO ghost:
  ///         debtOutstanding == Σ live queue, activeDebtsByToken == live
  ///         count, cursor exact, every queue element (creditor, amount)
  ///         equal, and a fully-drained queue deleted with cursor 0. This is
  ///         the stateful port of DebtChunking's `_assertBooksAgree`, plus
  ///         element-wise equality the frozen test never checked.
  function invariant_debtBooksMirrorGhost() public view {
    assertEq(handler.checkDebtBooks(), 0, "real debt book desynced from the ghost FIFO");
    assertEq(handler.bookDesyncs(), 0, "post-action book check desynced");
  }

  /// @notice INVARIANT (debt ↔ pool). Debt is a claim, never an asset:
  ///         (a) the pool identity still holds with debt state present and
  ///             Σ real debtOutstanding equals the ghost live total, and
  ///         (b) no debt-lifecycle action (shortfall booking, enforcement,
  ///             forgiveness, implicit enforcement inside spend/seed) ever
  ///             moved the value pool.
  function invariant_debtNeverEntersValuePool() public view {
    for (uint256 k = 0; k < 2; k++) {
      uint256 t = TOKENS[k];
      assertEq(
        _totalReserves(t) + _totalCollateral(t),
        handler.ghostMinted(t) + _externalBacking(t),
        "debt leaked into the value pool"
      );
      assertEq(
        handler.realOutstandingTotal(t),
        handler.ghostLiveDebt(t),
        "aggregate outstanding desynced from the ghost"
      );
    }
    assertEq(handler.debtPoolViolations(), 0, "a debt lifecycle action moved the value pool");
    assertEq(handler.foreignDebtCreation(), 0, "debt booked outside a dispute finalization");
  }

  /// @notice INVARIANT (lifecycle flow). Every unit of booked debt is exactly
  ///         one of: still outstanding, repaid by enforcement, or forgiven.
  ///         Mirrors the O(1) single-cursor forgiveness accounting.
  function invariant_debtLifecycleFlowsBalance() public view {
    assertEq(
      handler.ghostDebtCreated(),
      handler.ghostLiveDebt(1) + handler.ghostLiveDebt(3) + handler.ghostDebtRepaid()
        + handler.ghostDebtForgiven(),
      "debt flow conservation broken (created != live + repaid + forgiven)"
    );
  }

  /// @notice INVARIANT (admission exactness). Accepted forgiveness removed
  ///         exactly the predicted cursor heads; shortfalls booked exactly
  ///         the predicted uncovered remainder.
  function invariant_debtAdmissionIsExact() public view {
    assertEq(handler.forgivenessDesyncs(), 0, "forgiveness did not remove exactly the head");
    assertEq(handler.shortfallDesyncs(), 0, "shortfall booked a different debt than predicted");
  }

  // ═══════════════ deterministic controls ═══════════════

  /// @dev Actor indexes for the (0,1) pair in canonical LEFT/RIGHT order.
  function _leftActor() internal view returns (uint256) {
    return entity[0] < entity[1] ? 0 : 1;
  }

  function _rightActor() internal view returns (uint256) {
    return entity[0] < entity[1] ? 1 : 0;
  }

  /// @notice CONTROL (lifecycle reach, deterministic): collateral + reserve
  ///         funded, one forced shortfall finalize books the exact uncovered
  ///         remainder as debt against the correct creditor.
  function test_control_shortfallBooksExactDebt() public {
    handler.mint(_leftActor(), 0, 500);
    handler.seedCollateral(_leftActor(), _rightActor(), 0, 300);
    // LEFT debtor: magnitude far beyond spendable(200) → debt 800.
    handler.openDebtDispute(_leftActor(), _rightActor(), 0, 1_000, 0 /*left debtor*/, 1 /*force*/);
    handler.finalizeDebtDispute(0, 1); // non-starter finalizes immediately

    assertEq(handler.disputesFinalized(), 1, "control: finalize not accepted");
    assertEq(dep.debtOutstanding(entity[_leftActor()], 1), 800, "control: exact debt not booked");
    (bytes32 creditor,) = dep._debts(entity[_leftActor()], 1, 0);
    assertEq(creditor, entity[_rightActor()], "control: wrong creditor");
    assertEq(handler.ghostLiveDebt(1), 800, "control: ghost live debt wrong");
    assertEq(handler.checkDebtBooks(), 0, "control: books desynced");
  }

  /// @notice CONTROL (partial enforcement + O(1) forgiveness, deterministic):
  ///         two stacked debts, a capped enforcement pays exactly one, then a
  ///         signed settlement forgives exactly the cursor head — never the
  ///         tail (the production O(1) design the frozen DebtChunking test
  ///         disagrees with).
  function test_control_partialEnforcementThenO1Forgiveness() public {
    // Two independent shortfall debts LEFT→RIGHT on token 1.
    handler.mint(_leftActor(), 0, 100);
    handler.openDebtDispute(_leftActor(), _rightActor(), 0, 300, 0, 1);
    handler.finalizeDebtDispute(0, 1);
    handler.openDebtDispute(_leftActor(), _rightActor(), 0, 400, 0, 1);
    handler.finalizeDebtDispute(0, 1);
    // 300−100 spendable = 200 booked, then 400 with zero spendable = 600 total.
    assertEq(dep.debtOutstanding(entity[_leftActor()], 1), 600, "control: two debts not stacked");
    assertEq(handler.debtsCreated(), 2, "control: debt count");

    // Partial enforcement with cap 1 and reserve for exactly one debt.
    handler.mint(_leftActor(), 0, 300);
    handler.enforceDebt(_leftActor(), 0, 1 /*capSeed 1 → maxIterations 1*/);
    assertEq(dep.debtOutstanding(entity[_leftActor()], 1), 400, "control: partial enforcement wrong");
    assertEq(dep._debtIndex(entity[_leftActor()], 1), 1, "control: cursor must rest on entry 1");

    // Forgiveness removes ONLY the live head (entry 1, amount 400).
    handler.forgiveDebt(_leftActor(), _rightActor(), 0, 0);
    assertEq(dep.debtOutstanding(entity[_leftActor()], 1), 0, "control: head not forgiven");
    assertEq(handler.ghostDebtForgiven(), 400, "control: forgiven amount wrong");
    assertEq(handler.forgivenessSettlements(), 1, "control: settlement not accepted");
    assertEq(handler.checkDebtBooks(), 0, "control: books desynced");
    assertEq(handler.forgivenessDesyncs(), 0, "control: O(1) oracle flagged");
  }

  /// @notice CONTROL (E2 guard, deterministic): a third-party FIFO head must
  ///         fail the whole signed forgiveness settlement.
  function test_control_thirdPartyHeadBlocksForgiveness() public {
    // LEFT owes both RIGHT (token 1) and a third actor (token 3).
    handler.mint(_leftActor(), 0, 50);
    handler.openDebtDispute(_leftActor(), _rightActor(), 1 /*token 3*/, 300, 0, 1);
    handler.finalizeDebtDispute(0, 1);
    handler.openDebtDispute(_leftActor(), _rightActor(), 0 /*token 1*/, 400, 0, 1);
    handler.finalizeDebtDispute(0, 1);

    // Token 1 head creditor is RIGHT → bilateral forgiveness succeeds.
    handler.forgiveDebt(_leftActor(), _rightActor(), 0, 0);
    assertEq(dep.debtOutstanding(entity[_leftActor()], 1), 0, "token-1 head not forgiven");

    // Now stack: RIGHT owes LEFT on token 1 (reverse direction)…
    handler.mint(_rightActor(), 0, 10);
    handler.openDebtDispute(_rightActor(), _leftActor(), 0, 500, 1 /*right debtor*/, 1);
    handler.finalizeDebtDispute(0, 1);
    // …and LEFT owes a THIRD actor on token 1: its head is not RIGHT.
    handler.openDebtDispute(_leftActor(), 2, 0, 600, 0, 1);
    handler.finalizeDebtDispute(pairIndex(_leftActor(), 2), 1);

    // Forgiving (LEFT, RIGHT, token 1): LEFT's head creditor is the third
    // actor → leftHasDebt, not forgivable; RIGHT's head is LEFT → forgivable.
    // The settlement must still succeed through the RIGHT head and forgive
    // exactly RIGHT's debt to LEFT.
    handler.forgiveDebt(_leftActor(), _rightActor(), 0, 0);
    assertEq(dep.debtOutstanding(entity[_rightActor()], 1), 0, "right head not forgiven");
    assertGt(dep.debtOutstanding(entity[_leftActor()], 1), 0, "third-party head must survive");
  }

  function pairIndex(uint256 a, uint256 b) internal pure returns (uint256) {
    (uint256 lo, uint256 hi) = a < b ? (a, b) : (b, a);
    if (lo == 0) return hi - 1;
    if (lo == 1) return 2 + hi - 1;
    return 5;
  }

  // ═══════════════ meta: are the invariants sensitive? ═══════════════

  /// @notice Corrupt the REAL debtOutstanding and confirm the books invariant
  ///         trips (the oracle reads chain state, not two ghosts).
  function test_meta_debtBooksAreSensitive() public {
    handler.mint(_leftActor(), 0, 100);
    handler.openDebtDispute(_leftActor(), _rightActor(), 0, 300, 0, 1);
    handler.finalizeDebtDispute(0, 1);
    assertGt(dep.debtOutstanding(entity[_leftActor()], 1), 0, "meta: no debt to corrupt");

    bytes32 slot = _findOutstandingSlot(entity[_leftActor()], 1);
    vm.store(address(dep), slot, bytes32(uint256(1)));
    vm.expectRevert();
    this.invariant_debtBooksMirrorGhost();
  }

  /// @notice Corrupt the ghost live-debt aggregate and confirm the aggregate
  ///         debt oracle trips (real state vs ghost, both directions).
  function test_meta_ghostDebtIsSensitive() public {
    handler.mint(_leftActor(), 0, 100);
    handler.openDebtDispute(_leftActor(), _rightActor(), 0, 300, 0, 1);
    handler.finalizeDebtDispute(0, 1);
    handler.sabotageGhostOutstanding(1, 0); // ghost says nothing outstanding
    vm.expectRevert();
    this.invariant_debtNeverEntersValuePool();
  }

  /// @dev Locates debtOutstanding[entity][token] by sentinel-writing each
  ///      candidate slot and reading the public getter back (no hardcoded
  ///      layout). mapping(bytes32 => mapping(uint => uint)) nests as
  ///      keccak256(t, keccak256(e, base)).
  function _findOutstandingSlot(bytes32 e, uint256 t) internal returns (bytes32) {
    uint256 real = dep.debtOutstanding(e, t);
    for (uint256 base = 0; base < 60; base++) {
      bytes32 outer = keccak256(abi.encode(e, uint256(base)));
      bytes32 slot = keccak256(abi.encode(t, outer));
      bytes32 original = vm.load(address(dep), slot);
      vm.store(address(dep), slot, bytes32(uint256(987_654_321)));
      if (dep.debtOutstanding(e, t) == 987_654_321) {
        vm.store(address(dep), slot, bytes32(real));
        return slot;
      }
      vm.store(address(dep), slot, original);
    }
    revert("debtOutstanding slot not found");
  }

  // ═══════════════ coverage report ═══════════════

  function invariant_callSummary() public view {
    console.log("disputes started    ", handler.disputesStarted());
    console.log("disputes finalized  ", handler.disputesFinalized());
    console.log("-- debts created    ", handler.debtsCreated());
    console.log("-- debts paid at fin", handler.debtsPaidOff());
    console.log("enforcement calls   ", handler.enforcementCalls());
    console.log("-- partial enforces ", handler.partialEnforcements());
    console.log("forgive settlements ", handler.forgivenessSettlements());
    console.log("-- E2 rejections    ", handler.e2GuardedForgivenessRejections());
    console.log("-- live debt t1/t3  ", handler.ghostLiveDebt(1), handler.ghostLiveDebt(3));
    console.log("-- flow: created    ", handler.ghostDebtCreated());
    console.log("-- flow: repaid     ", handler.ghostDebtRepaid());
    console.log("-- flow: forgiven   ", handler.ghostDebtForgiven());
  }
}
