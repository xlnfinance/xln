// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import "../../../contracts/math/WideMath.sol";

contract WideMathTest is Test {
  uint256 internal constant MAX = type(uint256).max;

  function assertSigned(Int768 memory value, int256 high, uint256 middle, uint256 low) internal pure {
    assertEq(value.high, high, "signed high limb");
    assertEq(value.middle, middle, "signed middle limb");
    assertEq(value.low, low, "signed low limb");
  }

  function assertUnsigned(Uint768 memory value, uint256 high, uint256 middle, uint256 low) internal pure {
    assertEq(value.high, high, "unsigned high limb");
    assertEq(value.middle, middle, "unsigned middle limb");
    assertEq(value.low, low, "unsigned low limb");
  }

  function test_signed512RoundTripAndExtension(int256 high, uint256 low) public pure {
    Int768 memory expanded = WideMath.expand(Int512(high, low));
    assertSigned(expanded, high < 0 ? int256(-1) : int256(0), uint256(high), low);
    Int512 memory result = WideMath.narrow(expanded);
    assertEq(result.high, high);
    assertEq(result.low, low);
  }

  function test_int256ConversionsPreserveMinimumAndMaximum() public pure {
    assertEq(WideMath.toInt(WideMath.fromInt(type(int256).min)), type(int256).min);
    assertEq(WideMath.toInt(WideMath.fromInt(type(int256).max)), type(int256).max);
    assertSigned(WideMath.expand(WideMath.fromInt(-1)), -1, MAX, MAX);
    assertSigned(WideMath.expand(WideMath.fromUint(MAX)), 0, 0, MAX);
  }

  function test_narrowRejectsPositiveAndNegativeSigned512Overflow() public {
    vm.expectRevert(WideMath.RepresentationOverflow.selector);
    this.narrowSigned(Int768(0, uint256(1) << 255, 0));
    vm.expectRevert(WideMath.RepresentationOverflow.selector);
    this.narrowSigned(Int768(-1, uint256(type(int256).max), MAX));
  }

  function test_toIntRejectsPositiveAndNegativeSigned256Overflow() public {
    vm.expectRevert(WideMath.RepresentationOverflow.selector);
    this.toIntSigned(Int512(0, uint256(1) << 255));
    vm.expectRevert(WideMath.RepresentationOverflow.selector);
    this.toIntSigned(Int512(-1, uint256(type(int256).max)));
  }

  function test_signedCarryCrossesBothLowerLimbs() public pure {
    assertSigned(WideMath.add(Int768(5, MAX, MAX), Int768(0, 0, 1)), 6, 0, 0);
    assertSigned(WideMath.add(Int768(5, MAX, MAX), Int768(2, MAX, 1)), 8, MAX, 0);
  }

  function test_signedBorrowCrossesBothLowerLimbs() public pure {
    assertSigned(WideMath.sub(Int768(5, 0, 0), Int768(0, 0, 1)), 4, MAX, MAX);
    assertSigned(WideMath.sub(Int768(5, 0, 0), Int768(2, MAX, 1)), 2, 0, MAX);
  }

  function test_signedAdditionRejectsBothOverflowDirections() public {
    vm.expectRevert(WideMath.RepresentationOverflow.selector);
    this.addSigned(Int768(type(int256).max, MAX, MAX), Int768(0, 0, 1));
    vm.expectRevert(WideMath.RepresentationOverflow.selector);
    this.addSigned(Int768(type(int256).min, 0, 0), Int768(-1, MAX, MAX));
  }

  function test_signedSubtractionRejectsBothOverflowDirections() public {
    vm.expectRevert(WideMath.RepresentationOverflow.selector);
    this.subSigned(Int768(type(int256).min, 0, 0), Int768(0, 0, 1));
    vm.expectRevert(WideMath.RepresentationOverflow.selector);
    this.subSigned(Int768(type(int256).max, MAX, MAX), Int768(-1, MAX, MAX));
  }

  function test_oppositeSignedExtremaCancelWithoutIntermediateOverflow() public pure {
    Int768 memory min = Int768(type(int256).min, 0, 0);
    Int768 memory max = Int768(type(int256).max, MAX, MAX);
    assertSigned(WideMath.add(min, max), -1, MAX, MAX);
    assertSigned(WideMath.add(max, min), -1, MAX, MAX);
    assertSigned(WideMath.sub(min, min), 0, 0, 0);
  }

  function test_signed512SumAndDifferenceRoundTrip(int256 ah, uint256 al, int256 bh, uint256 bl) public pure {
    Int768 memory a = WideMath.expand(Int512(ah, al));
    Int768 memory b = WideMath.expand(Int512(bh, bl));
    assertTrue(WideMath.equal(WideMath.sub(WideMath.add(a, b), b), a));
    assertTrue(WideMath.equal(WideMath.add(WideMath.sub(a, b), b), a));
  }

  function test_signedComparisonUsesSignThenUnsignedLowerLimbs() public pure {
    assertEq(WideMath.compare(Int768(-1, MAX, MAX), Int768(0, 0, 0)), -1);
    assertEq(WideMath.compare(Int768(-1, 1, 0), Int768(-1, 0, MAX)), 1);
    assertEq(WideMath.compare(Int768(1, 2, 3), Int768(1, 2, 4)), -1);
    assertEq(WideMath.compare(Int768(1, 2, 3), Int768(1, 2, 3)), 0);
  }

  function test_signedAmountAcceptsFullUint256AndCancelsExactly() public pure {
    Int768 memory positive = WideMath.expand(SignedAmount(false, MAX));
    Int768 memory negative = WideMath.expand(SignedAmount(true, MAX));
    assertSigned(positive, 0, 0, MAX);
    assertSigned(negative, -1, MAX, 1);
    assertSigned(WideMath.add(positive, negative), 0, 0, 0);
    assertSigned(WideMath.expand(SignedAmount(false, 0)), 0, 0, 0);
  }

  function test_signedAmountRejectsNegativeZero() public {
    vm.expectRevert(WideMath.NonCanonicalSign.selector);
    this.expandAmount(SignedAmount(true, 0));
  }

  function test_addAmountPreservesIntMaxThenLeftR2COneAllocation() public pure {
    Int512 memory result = WideMath.addAmount(WideMath.fromInt(type(int256).max), SignedAmount(false, 1));
    assertEq(result.high, 0);
    assertEq(result.low, uint256(1) << 255);
    assertSigned(WideMath.subUint(WideMath.expand(result), 1), 0, 0, uint256(type(int256).max));
    assertSigned(WideMath.addUint(Int768(-1, MAX, MAX), 1), 0, 0, 0);
  }

  function assertOffset(Int512 memory value, int256 high, uint256 low) internal pure {
    assertEq(value.high, high, "offset high limb");
    assertEq(value.low, low, "offset low limb");
  }

  function test_addAmountCarryAcrossLowWordPreservesFullSignedResult() public pure {
    assertOffset(WideMath.addAmount(Int512(5, MAX), SignedAmount(false, 1)), 6, 0);
    assertOffset(WideMath.addAmount(Int512(-1, MAX), SignedAmount(false, 1)), 0, 0);
    assertOffset(WideMath.addAmount(Int512(-2, MAX), SignedAmount(false, MAX)), -1, MAX - 1);
  }

  function test_addAmountBorrowAcrossLowWordPreservesFullSignedResult() public pure {
    assertOffset(WideMath.addAmount(Int512(5, 0), SignedAmount(true, 1)), 4, MAX);
    assertOffset(WideMath.addAmount(Int512(0, 0), SignedAmount(true, 1)), -1, MAX);
    assertOffset(WideMath.addAmount(Int512(-2, 1), SignedAmount(true, MAX)), -3, 2);
  }

  function test_addAmountBothInt512ExtremaAcceptSafeOppositeMovements() public pure {
    int256 min = type(int256).min;
    int256 max = type(int256).max;
    assertOffset(WideMath.addAmount(Int512(min, 0), SignedAmount(false, MAX)), min, MAX);
    assertOffset(WideMath.addAmount(Int512(max, MAX), SignedAmount(true, MAX)), max, 0);
    // Reaching an exact extremum is valid; only crossing it must revert.
    assertOffset(WideMath.addAmount(Int512(max, 0), SignedAmount(false, MAX)), max, MAX);
    assertOffset(WideMath.addAmount(Int512(min, MAX), SignedAmount(true, MAX)), min, 0);
    assertOffset(WideMath.addAmount(Int512(min, 0), SignedAmount(false, 0)), min, 0);
    assertOffset(WideMath.addAmount(Int512(max, MAX), SignedAmount(false, 0)), max, MAX);
  }

  function test_addAmountTrueInt512OverflowPreservesRepresentationError() public {
    vm.expectRevert(WideMath.RepresentationOverflow.selector);
    this.addOffsetAmount(Int512(type(int256).max, MAX), SignedAmount(false, 1));
    vm.expectRevert(WideMath.RepresentationOverflow.selector);
    this.addOffsetAmount(Int512(type(int256).min, 0), SignedAmount(true, 1));
  }

  function test_addAmountRejectsNegativeZero() public {
    vm.expectRevert(WideMath.NonCanonicalSign.selector);
    this.addOffsetAmount(Int512(-1, MAX), SignedAmount(true, 0));
  }

  function test_magnitudePreservesNegativeInt256AndInt512Minima() public pure {
    Uint512 memory intMinimum = WideMath.magnitude(WideMath.expand(WideMath.fromInt(type(int256).min)));
    assertEq(intMinimum.high, 0);
    assertEq(intMinimum.low, uint256(1) << 255);
    Uint512 memory wideMinimum = WideMath.magnitude(WideMath.expand(Int512(type(int256).min, 0)));
    assertEq(wideMinimum.high, uint256(1) << 255);
    assertEq(wideMinimum.low, 0);
    Uint512 memory negativeCrossWord = WideMath.magnitude(Int768(-1, MAX - 1, MAX));
    assertEq(negativeCrossWord.high, 1);
    assertEq(negativeCrossWord.low, 1);
  }

  function test_magnitudeRejectsValuesOutsideUnsigned512() public {
    vm.expectRevert(WideMath.RepresentationOverflow.selector);
    this.absoluteSigned(Int768(1, 0, 0));
    vm.expectRevert(WideMath.RepresentationOverflow.selector);
    this.absoluteSigned(Int768(-1, 0, 0));
    vm.expectRevert(WideMath.RepresentationOverflow.selector);
    this.absoluteSigned(Int768(type(int256).min, 0, 0));
  }

  function test_absIntHandlesMinimumWithoutWrapping() public pure {
    assertEq(WideMath.absInt(type(int256).min), uint256(1) << 255);
    assertEq(WideMath.absInt(type(int256).max), uint256(type(int256).max));
    assertEq(WideMath.absInt(-1), 1);
    assertEq(WideMath.absInt(0), 0);
  }

  function test_unsignedCarryAndBorrowCrossBothLowerLimbs() public pure {
    assertUnsigned(WideMath.add(Uint768(5, MAX, MAX), Uint768(2, MAX, 1)), 8, MAX, 0);
    assertUnsigned(WideMath.sub(Uint768(5, 0, 0), Uint768(2, MAX, 1)), 2, 0, MAX);
    assertUnsigned(WideMath.add(Uint768(0, MAX, MAX), Uint768(0, 0, 1)), 1, 0, 0);
    assertUnsigned(WideMath.sub(Uint768(1, 0, 0), Uint768(0, 0, 1)), 0, MAX, MAX);
  }

  function test_unsignedAdditionRejectsHighAndCarryOverflow() public {
    vm.expectRevert(WideMath.RepresentationOverflow.selector);
    this.addUnsigned(Uint768(MAX, 0, 0), Uint768(1, 0, 0));
    vm.expectRevert(WideMath.RepresentationOverflow.selector);
    this.addUnsigned(Uint768(MAX, MAX, MAX), Uint768(0, 0, 1));
  }

  function test_unsignedSubtractionRejectsUnderflowInEveryLimb() public {
    vm.expectRevert(WideMath.RepresentationOverflow.selector);
    this.subUnsigned(Uint768(0, MAX, MAX), Uint768(1, 0, 0));
    vm.expectRevert(WideMath.RepresentationOverflow.selector);
    this.subUnsigned(Uint768(1, 0, MAX), Uint768(1, 1, 0));
    vm.expectRevert(WideMath.RepresentationOverflow.selector);
    this.subUnsigned(Uint768(1, 1, 0), Uint768(1, 1, 1));
  }

  function test_unsigned512SumRoundTrip(uint256 ah, uint256 al, uint256 bh, uint256 bl) public pure {
    Uint768 memory a = WideMath.expand(Uint512(ah, al));
    Uint768 memory result = WideMath.sub(WideMath.add(a, WideMath.expand(Uint512(bh, bl))), WideMath.expand(Uint512(bh, bl)));
    assertUnsigned(result, 0, ah, al);
  }

  function test_unsigned512AdditionPreservesCarryAndRejectsBothOverflowKinds() public {
    Uint512 memory result = WideMath.add(Uint512(5, MAX), Uint512(2, 1));
    assertEq(result.high, 8);
    assertEq(result.low, 0);
    result = WideMath.add(Uint512(0, MAX), Uint512(0, MAX));
    assertEq(result.high, 1, "two full-width movements preserve their high word");
    assertEq(result.low, MAX - 1);
    vm.expectRevert(WideMath.RepresentationOverflow.selector);
    this.addUnsigned512(Uint512(MAX, 0), Uint512(1, 0));
    vm.expectRevert(WideMath.RepresentationOverflow.selector);
    this.addUnsigned512(Uint512(MAX, MAX), Uint512(0, 1));
  }

  function test_subtractAndPayablePreserveCrossWordDebt() public pure {
    Uint512 memory debt = WideMath.subtract(Uint512(1, 0), 1);
    assertEq(debt.high, 0);
    assertEq(debt.low, MAX);
    assertEq(WideMath.payableAmount(Uint512(1, 0), MAX), MAX);
    assertEq(WideMath.payableAmount(Uint512(0, 17), 12), 12);
    assertEq(WideMath.payableAmount(Uint512(0, 17), 20), 17);
    assertEq(WideMath.spendable(Uint768(0, 0, 17), 20), 3);
    assertEq(WideMath.spendable(Uint768(0, 1, 0), MAX), 0);
    assertEq(WideMath.spendable(Uint768(1, 0, 0), MAX), 0);
    assertEq(WideMath.spendable(Uint768(0, 0, MAX), MAX), 0);
  }

  function test_fillUint256MaxRetainsExactFloor() public pure {
    assertEq(WideMath.fill(MAX, 0), 0);
    assertEq(WideMath.fill(MAX, type(uint16).max), MAX);
    assertEq(WideMath.fill(MAX, 32768), 57896928055670665928733867960092856710703453994410772906766553944782138277888);
    assertEq(WideMath.fill(MAX - 1, 32768), 57896928055670665928733867960092856710703453994410772906766553944782138277887);
    assertEq(WideMath.fill(MAX - 1, 65534), 115790322363291058989674234097190102285133061342459582265382060126261982724093);
  }

  function test_fillMatchesIndependentFullPrecisionOracle(uint256 amount, uint16 ratio) public pure {
    assertEq(WideMath.fill(amount, ratio), Math.mulDiv(amount, uint256(ratio), 65535));
  }

  // Self-call boundaries only expose production library reverts to expectRevert.
  function addUnsigned512(Uint512 memory a, Uint512 memory b) external pure returns (Uint512 memory) {
    return WideMath.add(a, b);
  }
  function addOffsetAmount(Int512 memory value, SignedAmount memory amount) external pure returns (Int512 memory) {
    return WideMath.addAmount(value, amount);
  }
  function narrowSigned(Int768 memory value) external pure returns (Int512 memory) { return WideMath.narrow(value); }
  function toIntSigned(Int512 memory value) external pure returns (int256) { return WideMath.toInt(value); }
  function addSigned(Int768 memory a, Int768 memory b) external pure returns (Int768 memory) { return WideMath.add(a, b); }
  function subSigned(Int768 memory a, Int768 memory b) external pure returns (Int768 memory) { return WideMath.sub(a, b); }
  function expandAmount(SignedAmount memory value) external pure returns (Int768 memory) { return WideMath.expand(value); }
  function absoluteSigned(Int768 memory value) external pure returns (Uint512 memory) { return WideMath.magnitude(value); }
  function addUnsigned(Uint768 memory a, Uint768 memory b) external pure returns (Uint768 memory) { return WideMath.add(a, b); }
  function subUnsigned(Uint768 memory a, Uint768 memory b) external pure returns (Uint768 memory) { return WideMath.sub(a, b); }
}
