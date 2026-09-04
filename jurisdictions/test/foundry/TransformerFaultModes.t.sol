// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import "../../contracts/Account.sol";
import "../../contracts/DeltaTransformer.sol";
import "../../contracts/Types.sol";
import "../../contracts/mocks/TransformerLivenessHarness.sol";
import {SettlementDeltasHarness} from "./helpers/SettlementDeltasHarness.sol";

/// @notice C4 hardening wave 2 (c4-adversary A4): the adversarial fault modes
///         the frozen TransformerLivenessHarness ships (RevertCall,
///         ExhaustGas, ShortReturn, WrongLength, MalformedReturn, ReturnBomb)
///         had ZERO foundry coverage, and the argument-decoder path
///         (Account._decodeTransformerArgumentList, Account.sol:1096-1110)
///         never executed with non-empty wrappers.
///
/// Everything here runs the REAL Account.prepareSettlementDeltas bytecode via
/// SettlementDeltasHarness (extended in wave 2 with `runWithArguments` and
/// `runTwoDeltas`; `run` is untouched so the Halmos lemma paths are stable).
///
/// Properties:
/// - Every fault mode collapses to a REAL revert (never the tolerated halmos
///   gas artifact, never a silent clamp/apply) — with or without allowance.
/// - The Account.sol:996 gate stays enforced when the ONLY allowance sits on a
///   delta index the transformer does not touch (partial allowance, 2 deltas).
/// - Non-empty argument wrappers reach the strict decoder: a well-formed
///   bytes[] decodes and executes; malformed/oversized wrappers soft-decode to
///   empty evidence and the gate/clamp still hold.
contract TransformerFaultModes is Test {
  SettlementDeltasHarness internal harness;
  TransformerLivenessHarness internal transformer;
  DeltaTransformer internal decoder;

  function setUp() public {
    transformer = new TransformerLivenessHarness();
    harness = new SettlementDeltasHarness(transformer);
    decoder = new DeltaTransformer();
  }

  // ═══════════════ fault modes vs the allowance gate and clamp ═══════════════

  /// @notice Every fault mode must fail CLOSED: a real revert, not the halmos
  ///         gas artifact, not a bypassed gate.
  function test_faultModesFailClosedWithAllowance() public {
    TransformerLivenessHarness.Mode[6] memory faults = [
      TransformerLivenessHarness.Mode.RevertCall,
      TransformerLivenessHarness.Mode.ExhaustGas,
      TransformerLivenessHarness.Mode.ShortReturn,
      TransformerLivenessHarness.Mode.WrongLength,
      TransformerLivenessHarness.Mode.MalformedReturn,
      TransformerLivenessHarness.Mode.ReturnBomb
    ];
    for (uint256 i = 0; i < faults.length; i++) {
      (int256 delta0, , bool reverted, bool gasArtifact) =
        harness.run(100, 0, 1, faults[i], 5_000, true, 50, 50);
      assertTrue(reverted, "fault mode must revert");
      assertFalse(gasArtifact, "fault mode must NOT hide behind the gas artifact");
      assertEq(delta0, 0, "fault mode must not apply a delta");
    }
  }

  /// @notice Same fault set without any allowance and a CHANGING request: the
  ///         batch must still revert — the gate cannot be bypassed by a fault.
  function test_faultModesFailClosedWithoutAllowance() public {
    TransformerLivenessHarness.Mode[3] memory faults = [
      TransformerLivenessHarness.Mode.RevertCall,
      TransformerLivenessHarness.Mode.MalformedReturn,
      TransformerLivenessHarness.Mode.WrongLength
    ];
    for (uint256 i = 0; i < faults.length; i++) {
      // Add(7) changes delta 0 from 100 -> 107 with no allowance anywhere.
      (, , bool reverted, bool gasArtifact) = harness.run(100, 0, 1, faults[i], 7, false, 0, 0);
      assertTrue(reverted, "fault mode must revert (no allowance)");
      assertFalse(gasArtifact, "fault mode must NOT hide behind the gas artifact (no allowance)");
    }
  }

  /// @notice A well-behaved control proving the harness entry itself is fine:
  ///         Add with allowance applies the exact value (no clamp at 50+50).
  function test_wellBehavedAddAppliesExactValue() public {
    (int256 delta0, uint256 bitmap, bool reverted, bool gasArtifact) =
      harness.run(100, 0, 1, TransformerLivenessHarness.Mode.Add, 7, true, MAX_MONEY, MAX_MONEY);
    assertFalse(reverted, "well-behaved Add must not revert");
    assertFalse(gasArtifact, "no gas artifact on a real EVM run");
    assertEq(delta0, 107, "Add must apply exactly");
    assertEq(bitmap, 0, "positive result must clear the negative bitmap");
  }

  /// @notice MAX_MONEY: an allowance above 2^200 fails _validateAllowances, so
  ///         the signed clause cannot execute and the batch reverts
  ///         (TransformerExecutionFailed), exactly like any other malformed
  ///         clause. The boundary itself is accepted (see the control above).
  function test_allowanceAboveMaxMoneyFailsTheClause() public {
    (int256 delta0, , bool reverted, bool gasArtifact) =
      harness.run(100, 0, 1, TransformerLivenessHarness.Mode.Add, 7, true, MAX_MONEY + 1, 0);
    assertTrue(reverted, "rightAllowance > MAX_MONEY must fail the clause");
    assertFalse(gasArtifact, "cap rejection is not the gas artifact");
    assertEq(delta0, 0);
    (, , reverted, gasArtifact) =
      harness.run(100, 0, 1, TransformerLivenessHarness.Mode.Add, 7, true, 0, MAX_MONEY + 1);
    assertTrue(reverted, "leftAllowance > MAX_MONEY must fail the clause");
    assertFalse(gasArtifact);
  }

  // ═══════════════ partial allowances across two delta indices ═══════════════

  /// @notice The gate is per-index (Account.sol:996-1000): a clause that
  ///         changes delta 0 reverts even though delta 1 carries an allowance.
  function test_partialAllowanceDoesNotAuthorizeOtherIndex() public {
    // Clause targets index 0 (Add 40), allowance sits ONLY on index 1.
    (, , , bool reverted, bool gasArtifact) =
      harness.runTwoDeltas(100, 0, 0, TransformerLivenessHarness.Mode.Add, 40, 0, 2, 10, 10);
    assertTrue(reverted, "change on un-allowanced index 0 must revert the batch");
    assertFalse(gasArtifact, "gate revert is not the gas artifact");

    // Control: the SAME shape with the allowance on the clause's own index
    // (index 1) executes; band ±50 admits the Add 40 unclamped.
    (int256 d0, int256 d1, , bool reverted2, ) =
      harness.runTwoDeltas(100, 0, 0, TransformerLivenessHarness.Mode.Add, 40, 1, 1, 50, 50);
    assertFalse(reverted2, "allowanced index must execute");
    assertEq(d0, 100, "untouched index must keep its delta");
    assertEq(d1, 40, "allowanced index applies the requested Add exactly");
  }

  /// @notice Allowance-window bracket: no allowance anywhere + a change on
  ///         index 1 reverts (gate); an allowance on index 1 + an oversized
  ///         Absolute request clamps to the exact band.
  function test_allowanceValidityWindowIsBracketed() public {
    // No allowance at all + a change on index 1 -> gate revert (valid arrays).
    (, , , bool reverted, ) =
      harness.runTwoDeltas(100, 0, 0, TransformerLivenessHarness.Mode.Add, 40, 1, 0, 0, 0);
    assertTrue(reverted, "un-allowanced change on index 1 must revert");

    // Allowance on index 1 + change on index 1 -> executes and clamps exactly.
    (, int256 d1, , bool reverted2, ) =
      harness.runTwoDeltas(100, 0, 0, TransformerLivenessHarness.Mode.Absolute, 500, 1, 1, 30, 20);
    assertFalse(reverted2, "allowanced absolute change must execute");
    assertEq(d1, 20, "clamp: band is prev(0) [+(-right),+left] = [-30,+20]; 500 -> 20");
  }

  // ═══════════════ the argument-decoder path (Account.sol:1096-1110) ═══════════════

  /// @notice A WELL-FORMED bytes[] wrapper decodes through the strict decoder
  ///         (real DeltaTransformer), the clause executes, and the clamp is
  ///         still exact — non-empty evidence changes nothing about the band.
  function test_wellFormedArgumentsDecodeAndClampExactly() public {
    bytes[] memory leftList = new bytes[](1);
    leftList[0] = hex"deadbeef";
    bytes memory wrapper = abi.encode(leftList);

    (int256 delta0, , bool reverted, bool gasArtifact) = harness.runWithArguments(
      100, 0, 1, TransformerLivenessHarness.Mode.Absolute, 5_000, true, 50, 50, wrapper, "", address(decoder)
    );
    assertFalse(reverted, "well-formed arguments must not revert");
    assertFalse(gasArtifact, "no gas artifact on a real EVM run");
    assertEq(delta0, 150, "clamp: band [50,150]; requested 5000 -> 150");
  }

  /// @notice A MALFORMED wrapper soft-decodes to empty evidence (never a
  ///         revert, never zero-substitution of the delta): the clause still
  ///         executes against the signed band and the gate still holds.
  function test_malformedArgumentsSoftDecodeToEmpty() public {
    // Truncated abi, wrong head, garbage — all must behave identically.
    bytes[3] memory bad;
    bad[0] = hex"00ff";
    bad[1] = hex"0000000000000000000000000000000000000000000000000000000000000020";
    bad[2] = hex"deadbeefdeadbeef";
    for (uint256 i = 0; i < bad.length; i++) {
      // Without allowance + a changing request: the GATE must still revert.
      (, , bool reverted, bool gasArtifact) = harness.runWithArguments(
        100, 0, 1, TransformerLivenessHarness.Mode.Add, 7, false, 0, 0, bad[i], "", address(decoder)
      );
      assertTrue(reverted, "gate must hold under malformed evidence");
      assertFalse(gasArtifact, "gate revert is not the gas artifact");

      // With allowance + no clamp pressure: executes with the empty evidence.
      (int256 delta0, , bool reverted2, ) = harness.runWithArguments(
        100, 0, 1, TransformerLivenessHarness.Mode.Add, 7, true, MAX_MONEY, MAX_MONEY, bad[i], "", address(decoder)
      );
      assertFalse(reverted2, "malformed evidence soft-decodes; clause still runs");
      assertEq(delta0, 107, "Add applies exactly over empty evidence");
    }
  }

  /// @notice An oversized wrapper (≥ 2^18 bytes bound at Account.sol:1098)
  ///         also soft-decodes to empty: no revert, gate intact. A wrapper
  ///         just under the bound decodes normally.
  function test_oversizedArgumentsSoftDecodeToEmpty() public {
    bytes memory oversized = new bytes(1 << 18); // exactly 262144: length >> 18 != 0
    (, , bool revertedGate, ) = harness.runWithArguments(
      100, 0, 1, TransformerLivenessHarness.Mode.Add, 7, false, 0, 0, oversized, "", address(decoder)
    );
    assertTrue(revertedGate, "gate must hold under oversized evidence");

    (int256 delta0, , bool reverted2, ) = harness.runWithArguments(
      100, 0, 1, TransformerLivenessHarness.Mode.Add, 7, true, MAX_MONEY, MAX_MONEY, oversized, "", address(decoder)
    );
    assertFalse(reverted2, "oversized evidence soft-decodes; clause still runs");
    assertEq(delta0, 107, "Add applies exactly over empty (oversized) evidence");

    // Just under the bound: decodes (empty inner list) and still executes.
    bytes memory edge = new bytes((1 << 18) - 1);
    (int256 delta1, , bool reverted3, ) = harness.runWithArguments(
      100, 0, 1, TransformerLivenessHarness.Mode.Add, 7, true, MAX_MONEY, MAX_MONEY, edge, "", address(decoder)
    );
    assertFalse(reverted3, "edge-size evidence must decode, not revert");
    assertEq(delta1, 107, "Add applies exactly over the edge-size evidence");
  }

  /// @notice A decoder that HAS code but fails (wrong contract: the liveness
  ///         harness does not implement decodeTransformerArgumentListStrict)
  ///         soft-decodes to empty evidence: clause still executes, gate still
  ///         holds. By contrast a CODELESS decoder is fail-fast, not soft:
  ///         staticcall succeeds with empty returndata and the strict
  ///         abi.decode then reverts the whole finalization — a misconfigured
  ///         decoder address must never silently erase signed evidence.
  function test_revertingDecoderSoftDecodesButDeadDecoderIsFatal() public {
    // Reverting decoder (has code, unknown selector): soft empty evidence.
    (, , bool revertedGate, ) = harness.runWithArguments(
      100, 0, 1, TransformerLivenessHarness.Mode.Add, 7, false, 0, 0, hex"01", "", address(transformer)
    );
    assertTrue(revertedGate, "gate must hold when the decoder call fails");

    (int256 delta0, , bool reverted2, ) = harness.runWithArguments(
      100, 0, 1, TransformerLivenessHarness.Mode.Add, 7, true, MAX_MONEY, MAX_MONEY, hex"01", "", address(transformer)
    );
    assertFalse(reverted2, "failed decoder call soft-decodes; clause still runs");
    assertEq(delta0, 107, "Add applies exactly over empty evidence");

    // Codeless decoder: staticcall returns success + empty returndata, so the
    // strict decode reverts — fatal, not soft.
    (, , bool reverted3, ) = harness.runWithArguments(
      100, 0, 1, TransformerLivenessHarness.Mode.Add, 7, true, MAX_MONEY, MAX_MONEY, hex"01", "", address(0xdead)
    );
    assertTrue(reverted3, "codeless decoder must be fatal, never silently empty");
  }
}
