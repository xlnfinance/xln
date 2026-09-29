// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
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
/// SettlementDeltasHarness with all three limbs preserved through `run`, `runWithArguments` and
/// `runTwoDeltas`. Historical symbolic path counts require a fresh run.
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

  function _assertDelta(Int768 memory actual, int256 expected, string memory reason) internal pure {
    assertEq(actual.high, expected < 0 ? int256(-1) : int256(0), reason);
    assertEq(actual.middle, expected < 0 ? type(uint256).max : 0, reason);
    assertEq(actual.low, uint256(expected), reason);
  }

  function _maxAllowanceClauses(bool negative) internal view returns (TransformerClause[] memory clauses) {
    clauses = new TransformerClause[](32);
    Int768 memory request = negative
      ? Int768(type(int256).min, 0, 0)
      : Int768(type(int256).max, type(uint256).max, type(uint256).max);
    for (uint256 i = 0; i < clauses.length; i++) {
      Allowance[] memory allowances = new Allowance[](1);
      allowances[0] = Allowance(0, negative ? type(uint256).max : 0, negative ? 0 : type(uint256).max);
      clauses[i] = TransformerClause(
        address(transformer), transformer.encodeWide(TransformerLivenessHarness.Mode.Absolute, 0, request, 1), allowances
      );
    }
  }

  function _assertClampPrefix(Vm.Log memory entry, bool negative, uint256 index) internal view {
    assertEq(entry.emitter, address(harness), "clamp emitter");
    assertEq(entry.topics.length, 4, "clamp indexed fields");
    assertEq(entry.topics[0], keccak256(
      "TransformerDeltaClamped(bytes32,uint256,address,uint256,(int256,uint256,uint256),(int256,uint256,uint256))"
    ), "clamp event signature");
    assertEq(entry.topics[1], keccak256(abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)))), "account key");
    assertEq(entry.topics[2], bytes32(index), "clause must keep its exact input position");
    assertEq(entry.topics[3], bytes32(uint256(uint160(address(transformer)))), "signed transformer");
    (uint256 tokenId, Int768 memory requested, Int768 memory applied) = abi.decode(entry.data, (uint256, Int768, Int768));
    assertEq(tokenId, 1);
    assertEq(requested.high, negative ? type(int256).min : type(int256).max);
    assertEq(requested.middle, negative ? 0 : type(uint256).max);
    assertEq(requested.low, negative ? 0 : type(uint256).max);
    // Base is +/-2^511. The kth clause adds/subtracts k * (2^256 - 1).
    uint256 k = index + 1;
    assertEq(applied.high, negative ? int256(-1) : int256(0));
    assertEq(applied.middle, negative ? (uint256(1) << 255) - k : (uint256(1) << 255) + k - 1);
    assertEq(applied.low, negative ? k : type(uint256).max - k + 1);
  }

  function _assert32ClampSequence(bool negative) internal {
    TransformerClause[] memory clauses = _maxAllowanceClauses(negative);
    Int512 memory ondelta = Int512(0, negative ? 0 : 1);
    Int512 memory offdelta = negative
      ? Int512(type(int256).min, 0) : Int512(type(int256).max, type(uint256).max);
    vm.recordLogs();
    (Int768 memory delta, uint256 bitmap, bool reverted, bool gasArtifact) = harness.runClauses(ondelta, offdelta, 1, clauses);
    Vm.Log[] memory logs = vm.getRecordedLogs();
    assertFalse(reverted, "all 32 signed allowance clauses must remain executable");
    assertFalse(gasArtifact);
    assertEq(logs.length, 32, "every requested extreme must emit its own clamp");
    for (uint256 i = 0; i < logs.length; i++) _assertClampPrefix(logs[i], negative, i);
    assertEq(bitmap, negative ? 1 : 0);
    assertEq(delta.high, negative ? int256(-1) : int256(0));
    assertEq(delta.middle, negative ? (uint256(1) << 255) - 32 : (uint256(1) << 255) + 31);
    assertEq(delta.low, negative ? 32 : type(uint256).max - 31);
    Uint512 memory magnitude = WideMath.magnitude(delta);
    assertEq(magnitude.high, (uint256(1) << 255) + 31, "final debt fits unsigned512 exactly");
    assertEq(magnitude.low, type(uint256).max - 31, "final debt low word");
  }

  function test_32PositiveMaxAllowancesPreserveEveryWideClampPrefix() public {
    _assert32ClampSequence(false);
  }

  function test_32NegativeMaxAllowancesPreserveEveryWideClampPrefix() public {
    _assert32ClampSequence(true);
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
      (Int768 memory delta0, , bool reverted, bool gasArtifact) =
        harness.run(100, 0, 1, faults[i], 5_000, true, 50, 50);
      assertTrue(reverted, "fault mode must revert");
      assertFalse(gasArtifact, "fault mode must NOT hide behind the gas artifact");
      _assertDelta(delta0, 0, "fault mode must not apply a delta");
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
    (Int768 memory delta0, uint256 bitmap, bool reverted, bool gasArtifact) =
      harness.run(100, 0, 1, TransformerLivenessHarness.Mode.Add, 7, true, type(uint256).max, type(uint256).max);
    assertFalse(reverted, "well-behaved Add must not revert");
    assertFalse(gasArtifact, "no gas artifact on a real EVM run");
    _assertDelta(delta0, 107, "Add must apply exactly");
    assertEq(bitmap, 0, "positive result must clear the negative bitmap");
  }

  /// @notice A signed offdelta may precede a unilateral left R2C of one.
  ///         The new ondelta is 1, so settlement owes LEFT exactly +2^255;
  ///         the later top-up must neither invalidate the proof nor flip its sign.
  function test_signedOffdeltaIntMaxThenLeftR2COneMustSettle() public {
    (Int768 memory delta0, uint256 bitmap, bool reverted, bool gasArtifact) = harness.runWide(
      Int512(0, 1), Int512(0, uint256(type(int256).max)), 1,
      TransformerLivenessHarness.Mode.Add, Int768(0, 0, 0), false, 0, 0
    );
    assertFalse(gasArtifact, "boundary settlement is not a gas-model artifact");
    assertFalse(reverted, "signed INT_MAX offdelta plus left R2C(1) must remain settleable");
    assertEq(bitmap, 0, "left R2C must preserve the positive allocation sign");
    assertEq(delta0.high, 0, "allocation must retain its positive sign");
    assertEq(delta0.middle, 0, "allocation must not create an extra word");
    assertEq(delta0.low, uint256(1) << 255, "allocation must retain the exact wide magnitude");
  }

  function test_signed512OffsetsRetainTheirExactSumOutsideSigned512() public {
    Int512 memory maximum = Int512(type(int256).max, type(uint256).max);
    (Int768 memory delta0, uint256 bitmap, bool reverted, bool gasArtifact) = harness.runWide(
      maximum, maximum, 1, TransformerLivenessHarness.Mode.Add, Int768(0, 0, 0), false, 0, 0
    );
    assertFalse(reverted, "two signed512 offsets must have a wide intermediate");
    assertFalse(gasArtifact);
    assertEq(bitmap, 0);
    assertEq(delta0.high, 0);
    assertEq(delta0.middle, type(uint256).max);
    assertEq(delta0.low, type(uint256).max - 1);
  }

  function test_transformerIntermediateSigned768OverflowReverts() public {
    (, , bool reverted, bool gasArtifact) = harness.runWide(
      Int512(0, 1), Int512(0, 0), 1, TransformerLivenessHarness.Mode.Add,
      Int768(type(int256).max, type(uint256).max, type(uint256).max),
      true, type(uint256).max, type(uint256).max
    );
    assertTrue(reverted, "true representation overflow must reject the signed clause");
    assertFalse(gasArtifact, "representation overflow is not a gas artifact");
  }

  /// @notice The full ERC20 magnitude is valid on either allowance side.
  function test_uint256MaxAllowancesPreserveExactSignedRequests() public {
    (Int768 memory delta0, uint256 bitmap, bool reverted, bool gasArtifact) = harness.run(
      100, 0, 1, TransformerLivenessHarness.Mode.Absolute, type(int256).min, true, type(uint256).max, 0
    );
    assertFalse(reverted, "full right allowance must execute");
    assertFalse(gasArtifact, "real execution must not be a gas artifact");
    _assertDelta(delta0, type(int256).min, "right allowance must preserve the exact negative request");
    assertEq(bitmap, 1, "negative request must set its sign bit");
    (delta0, bitmap, reverted, gasArtifact) = harness.run(
      100, 0, 1, TransformerLivenessHarness.Mode.Absolute, type(int256).max, true, 0, type(uint256).max
    );
    assertFalse(reverted, "full left allowance must execute");
    assertFalse(gasArtifact, "real execution must not be a gas artifact");
    _assertDelta(delta0, type(int256).max, "left allowance must preserve the exact positive request");
    assertEq(bitmap, 0, "positive request must clear its sign bit");
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
    (Int768 memory d0, Int768 memory d1, , bool reverted2, ) =
      harness.runTwoDeltas(100, 0, 0, TransformerLivenessHarness.Mode.Add, 40, 1, 1, 50, 50);
    assertFalse(reverted2, "allowanced index must execute");
    _assertDelta(d0, 100, "untouched index must keep its delta");
    _assertDelta(d1, 40, "allowanced index applies the requested Add exactly");
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
    (, Int768 memory d1, , bool reverted2, ) =
      harness.runTwoDeltas(100, 0, 0, TransformerLivenessHarness.Mode.Absolute, 500, 1, 1, 30, 20);
    assertFalse(reverted2, "allowanced absolute change must execute");
    _assertDelta(d1, 20, "clamp: band is prev(0) [+(-right),+left] = [-30,+20]; 500 -> 20");
  }

  // ═══════════════ the argument-decoder path (Account.sol:1096-1110) ═══════════════

  /// @notice A WELL-FORMED bytes[] wrapper decodes through the strict decoder
  ///         (real DeltaTransformer), the clause executes, and the clamp is
  ///         still exact — non-empty evidence changes nothing about the band.
  function test_wellFormedArgumentsDecodeAndClampExactly() public {
    bytes[] memory leftList = new bytes[](1);
    leftList[0] = hex"deadbeef";
    bytes memory wrapper = abi.encode(leftList);

    (Int768 memory delta0, , bool reverted, bool gasArtifact) = harness.runWithArguments(
      100, 0, 1, TransformerLivenessHarness.Mode.Absolute, 5_000, true, 50, 50, wrapper, "", address(decoder)
    );
    assertFalse(reverted, "well-formed arguments must not revert");
    assertFalse(gasArtifact, "no gas artifact on a real EVM run");
    _assertDelta(delta0, 150, "clamp: band [50,150]; requested 5000 -> 150");
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
      (Int768 memory delta0, , bool reverted2, ) = harness.runWithArguments(
        100, 0, 1, TransformerLivenessHarness.Mode.Add, 7, true, type(uint256).max, type(uint256).max, bad[i], "", address(decoder)
      );
      assertFalse(reverted2, "malformed evidence soft-decodes; clause still runs");
      _assertDelta(delta0, 107, "Add applies exactly over empty evidence");
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

    (Int768 memory delta0, , bool reverted2, ) = harness.runWithArguments(
      100, 0, 1, TransformerLivenessHarness.Mode.Add, 7, true, type(uint256).max, type(uint256).max, oversized, "", address(decoder)
    );
    assertFalse(reverted2, "oversized evidence soft-decodes; clause still runs");
    _assertDelta(delta0, 107, "Add applies exactly over empty (oversized) evidence");

    // Just under the bound: decodes (empty inner list) and still executes.
    bytes memory edge = new bytes((1 << 18) - 1);
    (Int768 memory delta1, , bool reverted3, ) = harness.runWithArguments(
      100, 0, 1, TransformerLivenessHarness.Mode.Add, 7, true, type(uint256).max, type(uint256).max, edge, "", address(decoder)
    );
    assertFalse(reverted3, "edge-size evidence must decode, not revert");
    _assertDelta(delta1, 107, "Add applies exactly over the edge-size evidence");
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

    (Int768 memory delta0, , bool reverted2, ) = harness.runWithArguments(
      100, 0, 1, TransformerLivenessHarness.Mode.Add, 7, true, type(uint256).max, type(uint256).max, hex"01", "", address(transformer)
    );
    assertFalse(reverted2, "failed decoder call soft-decodes; clause still runs");
    _assertDelta(delta0, 107, "Add applies exactly over empty evidence");

    // Codeless decoder: staticcall returns success + empty returndata, so the
    // strict decode reverts — fatal, not soft.
    (, , bool reverted3, ) = harness.runWithArguments(
      100, 0, 1, TransformerLivenessHarness.Mode.Add, 7, true, type(uint256).max, type(uint256).max, hex"01", "", address(0xdead)
    );
    assertTrue(reverted3, "codeless decoder must be fatal, never silently empty");
  }
}
