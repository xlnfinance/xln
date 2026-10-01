// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// A single asset movement has the ERC20 uint256 magnitude domain.
struct SignedAmount { bool negative; uint256 magnitude; }
/// Persisted cumulative offsets and signed proofs use two's-complement limbs.
struct Int512 { int256 high; uint256 low; }
/// Intermediate execution is wider than either signed operand.
struct Int768 { int256 high; uint256 middle; uint256 low; }
struct Uint512 { uint256 high; uint256 low; }
struct Uint768 { uint256 high; uint256 middle; uint256 low; }

/// Exact radix-2^256 arithmetic. Every checked boundary is the representation,
/// never a monetary policy ceiling. Unchecked limbs propagate carry/borrow and
/// reject overflow of the complete integer; no operation wraps its result.
library WideMath {
  error RepresentationOverflow();
  error NonCanonicalSign();

  function fromInt(int256 value) internal pure returns (Int512 memory) {
    return Int512(value < 0 ? int256(-1) : int256(0), uint256(value));
  }

  function fromUint(uint256 value) internal pure returns (Int512 memory) {
    return Int512(0, value);
  }

  function movement(int256 value) internal pure returns (SignedAmount memory) {
    return SignedAmount(value < 0, absInt(value));
  }

  function add(Uint512 memory a, Uint512 memory b) internal pure returns (Uint512 memory result) {
    unchecked {
      result.low = a.low + b.low;
      uint256 carry = result.low < a.low ? 1 : 0;
      result.high = a.high + b.high;
      if (result.high < a.high) revert RepresentationOverflow();
      uint256 high = result.high + carry;
      if (high < result.high) revert RepresentationOverflow();
      result.high = high;
    }
  }

  function expand(Int512 memory value) internal pure returns (Int768 memory) {
    return Int768(value.high < 0 ? int256(-1) : int256(0), uint256(value.high), value.low);
  }

  function expand(SignedAmount memory value) internal pure returns (Int768 memory result) {
    if (value.negative && value.magnitude == 0) revert NonCanonicalSign();
    result = Int768(0, 0, value.magnitude);
    if (value.negative) result = sub(Int768(0, 0, 0), result);
  }

  function narrow(Int768 memory value) internal pure returns (Int512 memory result) {
    result = Int512(int256(value.middle), value.low);
    if (value.high != (result.high < 0 ? int256(-1) : int256(0))) revert RepresentationOverflow();
  }

  function toInt(Int512 memory value) internal pure returns (int256 result) {
    result = int256(value.low);
    if (value.high != (result < 0 ? int256(-1) : int256(0))) revert RepresentationOverflow();
  }

  function equal(Int768 memory a, Int768 memory b) internal pure returns (bool) {
    return a.high == b.high && a.middle == b.middle && a.low == b.low;
  }

  function compare(Int768 memory a, Int768 memory b) internal pure returns (int256) {
    if (a.high != b.high) return a.high < b.high ? int256(-1) : int256(1);
    if (a.middle != b.middle) return a.middle < b.middle ? int256(-1) : int256(1);
    if (a.low != b.low) return a.low < b.low ? int256(-1) : int256(1);
    return 0;
  }

  function add(Int768 memory a, Int768 memory b) internal pure returns (Int768 memory result) {
    unchecked {
      result.low = a.low + b.low;
      uint256 carry = result.low < a.low ? 1 : 0;
      uint256 middle = a.middle + b.middle;
      uint256 highCarry = middle < a.middle ? 1 : 0;
      result.middle = middle + carry;
      if (result.middle < middle) highCarry = 1;
      result.high = int256(uint256(a.high) + uint256(b.high) + highCarry);
    }
    if ((a.high < 0) == (b.high < 0) && (result.high < 0) != (a.high < 0)) {
      revert RepresentationOverflow();
    }
  }

  function sub(Int768 memory a, Int768 memory b) internal pure returns (Int768 memory result) {
    unchecked {
      result.low = a.low - b.low;
      uint256 borrow = a.low < b.low ? 1 : 0;
      uint256 middle = a.middle - b.middle;
      uint256 highBorrow = a.middle < b.middle ? 1 : 0;
      result.middle = middle - borrow;
      if (middle < borrow) highBorrow = 1;
      result.high = int256(uint256(a.high) - uint256(b.high) - highBorrow);
    }
    if ((a.high < 0) != (b.high < 0) && (result.high < 0) != (a.high < 0)) {
      revert RepresentationOverflow();
    }
  }

  function addAmount(Int512 memory value, SignedAmount memory amount) internal pure returns (Int512 memory result) {
    if (amount.negative && amount.magnitude == 0) revert NonCanonicalSign();
    result.high = value.high;
    if (amount.negative) {
      unchecked { result.low = value.low - amount.magnitude; }
      if (value.low < amount.magnitude) {
        if (value.high == type(int256).min) revert RepresentationOverflow();
        result.high -= 1;
      }
    } else {
      unchecked { result.low = value.low + amount.magnitude; }
      if (result.low < value.low) {
        if (value.high == type(int256).max) revert RepresentationOverflow();
        result.high += 1;
      }
    }
  }

  function addUint(Int768 memory value, uint256 amount) internal pure returns (Int768 memory) {
    return add(value, Int768(0, 0, amount));
  }

  function subUint(Int768 memory value, uint256 amount) internal pure returns (Int768 memory) {
    return sub(value, Int768(0, 0, amount));
  }

  function magnitude(Int768 memory value) internal pure returns (Uint512 memory result) {
    Uint768 memory absolute;
    if (value.high >= 0) {
      absolute = Uint768(uint256(value.high), value.middle, value.low);
    } else {
      // This unsigned negation also handles the signed minimum exactly.
      unchecked {
        absolute.low = 0 - value.low;
        uint256 borrow = value.low == 0 ? 0 : 1;
        absolute.middle = 0 - value.middle - borrow;
        uint256 highBorrow = value.middle != 0 || borrow != 0 ? 1 : 0;
        absolute.high = 0 - uint256(value.high) - highBorrow;
      }
    }
    if (absolute.high != 0) revert RepresentationOverflow();
    return Uint512(absolute.middle, absolute.low);
  }

  function isZero(Uint512 memory value) internal pure returns (bool) {
    return value.high == 0 && value.low == 0;
  }

  function isZero(Uint768 memory value) internal pure returns (bool) {
    return value.high == 0 && value.middle == 0 && value.low == 0;
  }

  function expand(Uint512 memory value) internal pure returns (Uint768 memory) {
    return Uint768(0, value.high, value.low);
  }

  function add(Uint768 memory a, Uint768 memory b) internal pure returns (Uint768 memory result) {
    unchecked {
      result.low = a.low + b.low;
      uint256 carry = result.low < a.low ? 1 : 0;
      uint256 middle = a.middle + b.middle;
      uint256 highCarry = middle < a.middle ? 1 : 0;
      result.middle = middle + carry;
      if (result.middle < middle) highCarry = 1;
      result.high = a.high + b.high;
      if (result.high < a.high) revert RepresentationOverflow();
      uint256 high = result.high + highCarry;
      if (high < result.high) revert RepresentationOverflow();
      result.high = high;
    }
  }

  function sub(Uint768 memory a, Uint768 memory b) internal pure returns (Uint768 memory result) {
    if (a.high < b.high || (a.high == b.high &&
      (a.middle < b.middle || (a.middle == b.middle && a.low < b.low)))) revert RepresentationOverflow();
    unchecked {
      result.low = a.low - b.low;
      uint256 borrow = a.low < b.low ? 1 : 0;
      uint256 middle = a.middle - b.middle;
      uint256 highBorrow = a.middle < b.middle ? 1 : 0;
      result.middle = middle - borrow;
      if (middle < borrow) highBorrow = 1;
      result.high = a.high - b.high - highBorrow;
    }
  }

  function subtract(Uint512 memory value, uint256 amount) internal pure returns (Uint512 memory) {
    Uint768 memory result = sub(expand(value), Uint768(0, 0, amount));
    return Uint512(result.middle, result.low);
  }

  function payableAmount(Uint512 memory value, uint256 available) internal pure returns (uint256) {
    return value.high != 0 || value.low > available ? available : value.low;
  }

  function spendable(Uint768 memory debt, uint256 reserve) internal pure returns (uint256) {
    if (debt.high != 0 || debt.middle != 0 || debt.low >= reserve) return 0;
    return reserve - debt.low;
  }

  function absInt(int256 value) internal pure returns (uint256) {
    unchecked { return value < 0 ? uint256(-(value + 1)) + 1 : uint256(value); }
  }

  /// floor(amount * ratio / 65535), without overflowing the multiplication.
  function fill(uint256 amount, uint16 ratio) internal pure returns (uint256) {
    uint256 denominator = type(uint16).max;
    return (amount / denominator) * ratio + ((amount % denominator) * ratio) / denominator;
  }
}
