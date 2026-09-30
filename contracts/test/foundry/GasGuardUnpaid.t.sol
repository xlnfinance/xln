// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import "../../contracts/DeltaTransformer.sol";

/// Reviewer A (PR 64, finding B2): the REAL DeltaTransformer (the PR's guard), no probe. A finalize whose outcome depends on one side's swap fill ratio; that
/// side's evidence is encoded with its two arrays overlapping (a valid encoding: the decoder does not forbid it). Scan every gas limit and
/// classify by the returned deltas: PAID (the fill counted), UNPAID (the evidence was dropped and the call COMPLETED: R-OOG violated), or a revert.
contract GasGuardUnpaidTest is Test {
  DeltaTransformer internal t;

  function setUp() public {
    t = new DeltaTransformer();
  }

  function _swapBatch() internal pure returns (bytes memory) {
    DeltaTransformer.Batch memory b;
    b.payment = new DeltaTransformer.Payment[](0);
    b.swap = new DeltaTransformer.Swap[](1);
    b.swap[0] = DeltaTransformer.Swap(true, 0, 1e18, 1, 1e18); // left-owned: the RIGHT side's evidence chooses the fill ratio
    b.pull = new DeltaTransformer.Pull[](0);
    return abi.encode(b);
  }

  function _aliased(uint256 n) internal pure returns (bytes memory out) {
    // offset of the tuple, fillRatios offset, secrets offset (both 0x40: the same words), length n, then n words (the first one, 60_000, is the fill ratio that decides)
    out = new bytes(32 * (4 + n));
    assembly ("memory-safe") {
      let p := add(out, 0x20)
      mstore(p, 0x20)
      mstore(add(p, 0x20), 0x40)
      mstore(add(p, 0x40), 0x40)
      mstore(add(p, 0x60), n)
      mstore(add(p, 0x80), 60000)
      for { let i := 1 } lt(i, n) { i := add(i, 1) } { mstore(add(p, add(0x80, mul(i, 0x20))), add(1, mod(i, 65000))) }
    }
  }

  function _natural(uint256 n) internal pure returns (bytes memory) {
    uint16[] memory r = new uint16[](n);
    r[0] = 60_000;
    for (uint256 i = 1; i < n; i++) r[i] = uint16(1 + (i % 65_000));
    return abi.encode(DeltaTransformer.Arguments({fillRatios: r, secrets: new bytes32[](0)}));
  }

  function _data(bytes memory right) internal view returns (bytes memory) {
    Int768[] memory deltas = new Int768[](2);
    uint256[] memory ids = new uint256[](2);
    ids[0] = 1;
    ids[1] = 2;
    return abi.encodeCall(t.applyBatch, (deltas, ids, _swapBatch(), "", right, 1, 1, bytes32(uint256(1)), bytes32(uint256(2)), 0, 0, 0, 0));
  }

  function _run(bytes memory data, uint256 g) internal view returns (bool ok, bytes32 h) {
    address a = address(t);
    assembly ("memory-safe") {
      ok := staticcall(g, a, add(data, 0x20), mload(data), 0, 0)
      let sz := returndatasize()
      let p := mload(0x40)
      returndatacopy(p, 0, sz)
      h := keccak256(p, sz)
    }
  }

  function _scan(string memory name, bytes memory right) internal {
    bytes memory data = _data(right);
    (bool okF, bytes32 full) = _run(data, 30_000_000);
    (bool okD, bytes32 drop) = _run(_data(""), 30_000_000);
    require(okF && okD && full != drop, "the fill must decide the outcome");
    uint256 paid = 40_000_000;
    {
      uint256 lo = 0;
      while (lo + 1 < paid) {
        uint256 mid = (lo + paid) / 2;
        (bool ok, bytes32 h) = _run(data, mid);
        if (ok && h == full) paid = mid; else lo = mid;
      }
    }
    uint256 unpaid;
    uint256 first;
    uint256 last;
    // The starved decode completes with the evidence dropped only below the least paying limit, in a window that sits about 520,000 to 600,000 under it at df2801a
    // (A measured 846,990 to 930,834 against 1,446,990); step 5,000 over [paid - 650,000, paid - 450,000) fits forge's 300M test gas, the vm scan does the exhaustive sweep.
    for (uint256 g = paid - 650_000; g < paid - 450_000; g += 5_000) {
      (bool ok, bytes32 h) = _run(data, g);
      if (ok && h == drop) {
        if (unpaid == 0) first = g;
        last = g;
        unpaid++;
      }
    }
    console.log(name);
    console.log("  least gas that pays:", paid);
    console.log("  gas limits (step 5,000) at which the call COMPLETES with the evidence dropped:", unpaid);
    if (unpaid > 0) console.log("  UNPAID range", first, last);
    assertEq(unpaid, 0, name);
  }

  function test_unpaid_natural_cap() public { _scan("canonical encoding, 2000 fill ratios (64 KiB)", _natural(2000)); }
  function test_unpaid_aliased_cap() public { _scan("aliased encoding, 2000 words decoded as uint16[] AND bytes32[]", _aliased(2000)); }
}
