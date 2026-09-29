// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import "../../../contracts/DeltaTransformer.sol";
import "../../../contracts/math/WideMath.sol";

contract WideTransformerTest is Test {
  DeltaTransformer internal transformer;
  uint256 internal constant MAX = type(uint256).max;

  function setUp() public {
    transformer = new DeltaTransformer();
  }

  function _assertDelta(Int768 memory actual, int256 high, uint256 middle, uint256 low) internal pure {
    assertEq(actual.high, high, "signed high limb");
    assertEq(actual.middle, middle, "middle limb");
    assertEq(actual.low, low, "low limb");
  }

  function _oppositePayments(bool positiveRevealed, bool negativeRevealed, uint256 argumentTimestamp)
    internal view returns (Int768 memory)
  {
    bytes32 positiveSecret = bytes32("wide-positive");
    bytes32 negativeSecret = bytes32("wide-negative");
    DeltaTransformer.Batch memory batch;
    batch.payment = new DeltaTransformer.Payment[](2);
    batch.payment[0] = DeltaTransformer.Payment(0, SignedAmount(false, MAX), 10, keccak256(abi.encode(positiveSecret)));
    batch.payment[1] = DeltaTransformer.Payment(0, SignedAmount(true, MAX), 10, keccak256(abi.encode(negativeSecret)));
    batch.swap = new DeltaTransformer.Swap[](0);
    batch.pull = new DeltaTransformer.Pull[](0);
    DeltaTransformer.Arguments memory arguments;
    arguments.fillRatios = new uint16[](0);
    arguments.secrets = new bytes32[](2);
    arguments.secrets[0] = positiveRevealed ? positiveSecret : bytes32(0);
    arguments.secrets[1] = negativeRevealed ? negativeSecret : bytes32(0);
    Int768[] memory deltas = new Int768[](1);
    deltas[0] = WideMath.expand(WideMath.fromInt(7));
    uint256[] memory tokenIds = new uint256[](1);
    tokenIds[0] = 1;
    return transformer.applyBatch(
      deltas, tokenIds, abi.encode(batch), abi.encode(arguments), "", argumentTimestamp, 0,
      bytes32(uint256(1)), bytes32(uint256(2)), 0, 0, 0, 0
    )[0];
  }

  /// Each hash grants one signed movement. Revealing only one must preserve
  /// its full amount, even though revealing both cancels their net effect.
  function test_oppositeFullUint256HtlcsPreserveIndependentOutcomes() public view {
    _assertDelta(_oppositePayments(false, false, 1), 0, 0, 7);
    _assertDelta(_oppositePayments(true, false, 1), 0, 1, 6);
    _assertDelta(_oppositePayments(false, true, 1), -1, MAX, 8);
    _assertDelta(_oppositePayments(true, true, 1), 0, 0, 7);
  }

  function test_lateSecretsDoNotApplyEitherFullWidthHtlc() public view {
    _assertDelta(_oppositePayments(true, false, 11), 0, 0, 7);
    _assertDelta(_oppositePayments(false, true, 11), 0, 0, 7);
  }

  function test_unrevealedHtlcRejectsNegativeZeroAndPreservesPositiveZero() public {
    DeltaTransformer.Batch memory batch;
    batch.payment = new DeltaTransformer.Payment[](1);
    batch.payment[0] = DeltaTransformer.Payment(0, SignedAmount(false, 0), 10, bytes32("unrevealed-zero"));
    batch.swap = new DeltaTransformer.Swap[](0);
    batch.pull = new DeltaTransformer.Pull[](0);
    Int768[] memory deltas = new Int768[](1);
    deltas[0] = Int768(0, 1, 7);
    uint256[] memory tokenIds = new uint256[](1);
    tokenIds[0] = 1;
    Int768[] memory result = transformer.applyBatch(
      deltas, tokenIds, abi.encode(batch), "", "", 0, 0,
      bytes32(uint256(1)), bytes32(uint256(2)), 0, 0, 0, 0
    );
    _assertDelta(result[0], 0, 1, 7);

    batch.payment[0].amount.negative = true;
    vm.expectRevert(WideMath.NonCanonicalSign.selector);
    transformer.applyBatch(
      deltas, tokenIds, abi.encode(batch), "", "", 0, 0,
      bytes32(uint256(1)), bytes32(uint256(2)), 0, 0, 0, 0
    );
  }

  function test_fullUint256SwapPartialFillPreservesExactOppositeLegs() public view {
    DeltaTransformer.Batch memory batch;
    batch.payment = new DeltaTransformer.Payment[](0);
    batch.swap = new DeltaTransformer.Swap[](1);
    batch.swap[0] = DeltaTransformer.Swap(true, 0, MAX, 1, MAX);
    batch.pull = new DeltaTransformer.Pull[](0);
    DeltaTransformer.Arguments memory counterparty;
    counterparty.fillRatios = new uint16[](1);
    counterparty.fillRatios[0] = 32768;
    counterparty.secrets = new bytes32[](0);
    uint256[] memory tokenIds = new uint256[](2);
    tokenIds[0] = 1;
    tokenIds[1] = 2;
    Int768[] memory result = transformer.applyBatch(
      new Int768[](2), tokenIds, abi.encode(batch), "", abi.encode(counterparty), 0, 0,
      bytes32(uint256(1)), bytes32(uint256(2)), 0, 0, 0, 0
    );
    uint256 expected = 57896928055670665928733867960092856710703453994410772906766553944782138277888;
    _assertDelta(result[0], -1, MAX, MAX - expected + 1);
    _assertDelta(result[1], 0, 0, expected);
  }
}
