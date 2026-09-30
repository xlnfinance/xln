// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import "../../contracts/DeltaTransformer.sol";

/// Reviewer B, PR 64 (RB-1). Attack on the claim "a guard of 50,000 + 8 * length covers the decode of everything Account lets through". The floor is now only a fast path, the bound is the check after the catch.
/// The array-offset fields of `Arguments` may point at the SAME words: one 64 KiB payload is then decoded twice (as uint16[] and as bytes32[]).
contract ReviewBDecodeOverlap is Test {
  DeltaTransformer internal decoder;
  uint256 internal constant MAX_EVIDENCE_BYTES = 64 * 1024;

  function setUp() public { decoder = new DeltaTransformer(); }

  function _overlapped(uint256 n) internal pure returns (bytes memory out) {
    // word 0: offset of the tuple; tuple head: fillRatios offset, secrets offset (both 0x40: the same array); then length n and n words
    out = new bytes(32 * (4 + n));
    assembly ("memory-safe") {
      let p := add(out, 0x20)
      mstore(p, 0x20)
      mstore(add(p, 0x20), 0x40)
      mstore(add(p, 0x40), 0x40)
      mstore(add(p, 0x60), n)
      for { let i := 0 } lt(i, n) { i := add(i, 1) } { mstore(add(p, add(0x80, mul(i, 0x20))), add(1, mod(i, 65000))) }
    }
  }

  function _ratios(uint256 n) internal pure returns (bytes memory) {
    uint16[] memory fillRatios = new uint16[](n);
    for (uint256 i = 0; i < n; i++) fillRatios[i] = uint16(1 + (i % 65_000));
    return abi.encode(DeltaTransformer.Arguments({fillRatios: fillRatios, secrets: new bytes32[](0)}));
  }

  function _need(bytes memory evidence) internal view returns (uint256 hi) {
    bytes memory callData = abi.encodeCall(decoder.decodeArgumentsStrict, (evidence));
    uint256 lo = 0;
    hi = 30_000_000;
    while (lo + 1 < hi) {
      uint256 mid = (lo + hi) / 2;
      (bool ok,) = address(decoder).staticcall{gas: mid}(callData);
      if (ok) hi = mid; else lo = mid;
    }
  }

  function test_RB_overlappedOffsetsCostMoreThanTheFastPathFloor() public view {
    uint256 n = (MAX_EVIDENCE_BYTES - 128) / 32;
    bytes memory plain = _ratios(n);
    bytes memory overlap = _overlapped(n);
    assertLe(overlap.length, MAX_EVIDENCE_BYTES, "overlap payload is within Account's cap");
    uint256 needPlain = _need(plain);
    uint256 needOverlap = _need(overlap);
    uint256 guard = decoder.DECODE_GAS_BASE() + decoder.DECODE_GAS_PER_BYTE() * overlap.length;
    console.log("plain   len/need/guard", plain.length, needPlain, guard);
    console.log("overlap len/need/guard", overlap.length, needOverlap, guard);
    // Decodes (does not revert) when given enough gas: the two arrays are both valid readings of the same words.
    (bool ok,) = address(decoder).staticcall{gas: 30_000_000}(abi.encodeCall(decoder.decodeArgumentsStrict, (overlap)));
    assertTrue(ok, "the overlapped payload is a valid Arguments");
    // The fast-path floor is NOT the bound (it cannot be: two arrays read from the same words); the bound is the post-catch check. RB-1b below holds it.
    assertGt(needOverlap * 64 / 63, guard, "RB-1: the floor alone is below what the overlapped decode needs, so the bound must be the post-catch check");
  }
}

/// End to end on DeltaTransformer.applyBatch: one Payment (50, paid only when its secret is in the evidence) and ONE evidence that carries the secret and whose two arrays
/// overlap (the fill-ratio array starts inside the secrets array). Every gas limit must be PAID or revert. RB-1b: at df2801a a window of limits is UNPAID.
contract ReviewBApplyBatchScan is Test {
  DeltaTransformer internal t;
  bytes32 internal constant SECRET = keccak256("rb-secret");

  function setUp() public {
    t = new DeltaTransformer();
    vm.warp(2000);
  }

  /// tuple: [fillOff = 0x80][secOff = 0x40][S][SECRET][S-2][small * (S-2)]: secrets = the S words after the length; fillRatios = the S-2 words from the second one on.
  function _evidence(uint256 s) internal pure returns (bytes memory out) {
    out = new bytes(32 * (s + 4));
    bytes32 secret = SECRET;
    assembly ("memory-safe") {
      let p := add(out, 0x20)
      mstore(p, 0x20)
      mstore(add(p, 0x20), 0x80)
      mstore(add(p, 0x40), 0x40)
      mstore(add(p, 0x60), s)
      mstore(add(p, 0x80), secret)
      mstore(add(p, 0xa0), sub(s, 2))
      for { let j := 2 } lt(j, s) { j := add(j, 1) } { mstore(add(p, add(0x80, mul(j, 0x20))), add(1, mod(j, 65000))) }
    }
  }

  function _call(uint256 gas_, bytes memory batch, bytes memory evidence) internal view returns (bool ok, uint256 paid) {
    Int768[] memory deltas = new Int768[](1);
    uint256[] memory ids = new uint256[](1);
    (bool success, bytes memory ret) = address(t).staticcall{gas: gas_}(
      abi.encodeCall(t.applyBatch, (deltas, ids, batch, evidence, "", 500, 500, bytes32(uint256(1)), bytes32(uint256(2)), 0, 0, 0, 0))
    );
    if (!success) return (false, 0);
    Int768[] memory out = abi.decode(ret, (Int768[]));
    return (true, out[0].low);
  }

  function test_RB_overlappedEvidenceIsPaidOrRevertsNeverUnpaid() public view {
    uint256 s = 2040;
    bytes memory evidence = _evidence(s);
    assertLe(evidence.length, 64 * 1024, "within Account's cap");
    DeltaTransformer.Payment[] memory pays = new DeltaTransformer.Payment[](1);
    pays[0] = DeltaTransformer.Payment({deltaIndex: 0, amount: SignedAmount(false, 50), revealedUntilTimestamp: 1000, hash: keccak256(abi.encode(SECRET))});
    bytes memory batch = t.encodeBatch(DeltaTransformer.Batch({payment: pays, swap: new DeltaTransformer.Swap[](0), pull: new DeltaTransformer.Pull[](0)}));
    (bool okFull, uint256 paidFull) = _call(20_000_000, batch, evidence);
    assertTrue(okFull && paidFull == 50, "at full gas the evidence pays");
    (bool okNone, uint256 paidNone) = _call(20_000_000, batch, "");
    assertTrue(okNone && paidNone == 0, "with no evidence nothing is paid");

    uint256 reverted; uint256 unpaid; uint256 paid; uint256 firstUnpaid; uint256 lastUnpaid;
    for (uint256 g = 100_000; g <= 2_600_000; g += 20_000) {
      (bool ok, uint256 amount) = _call(g, batch, evidence);
      if (!ok) reverted++;
      else if (amount == 50) paid++;
      else { if (unpaid == 0) firstUnpaid = g; lastUnpaid = g; unpaid++; }
    }
    console.log("evidence bytes", evidence.length);
    console.log("limits: reverted / paid / UNPAID", reverted, paid, unpaid);
    if (unpaid > 0) console.log("UNPAID window", firstUnpaid, lastUnpaid);
    assertEq(unpaid, 0, "RB-1b: a gas limit turned valid evidence into 'no evidence'");
  }

  /// Fine scan around the least gas that pays (step 100): below it every limit reverts, from it up every limit pays; never UNPAID.
  function test_RB_fineScanAroundTheLeastPayingLimit() public view {
    bytes memory evidence = _evidence(2040);
    DeltaTransformer.Payment[] memory pays = new DeltaTransformer.Payment[](1);
    pays[0] = DeltaTransformer.Payment({deltaIndex: 0, amount: SignedAmount(false, 50), revealedUntilTimestamp: 1000, hash: keccak256(abi.encode(SECRET))});
    bytes memory batch = t.encodeBatch(DeltaTransformer.Batch({payment: pays, swap: new DeltaTransformer.Swap[](0), pull: new DeltaTransformer.Pull[](0)}));
    uint256 lo = 100_000;
    uint256 hi = 6_000_000;
    while (lo + 1 < hi) {
      uint256 mid = (lo + hi) / 2;
      (bool ok, uint256 amount) = _call(mid, batch, evidence);
      if (ok && amount == 50) hi = mid; else lo = mid;
    }
    console.log("least paying limit", hi);
    uint256 unpaid; uint256 revertedAbove; uint256 paidBelow;
    // coarse (step 3,000) over the 105,000 below the least paying limit, fine (step 200) 3,500 either side of it; forge's 300M test gas allows about 100 calls
    for (uint256 k = 0; k < 70; k++) {
      uint256 g = k < 35 ? hi - 105_000 + k * 3_000 : hi - 3_500 + (k - 35) * 200;
      (bool ok, uint256 amount) = _call(g, batch, evidence);
      if (ok && amount != 50) unpaid++;
      if (g >= hi && !(ok && amount == 50)) revertedAbove++;
      if (g < hi && ok && amount == 50) paidBelow++;
    }
    console.log("UNPAID / not-paying-above / paying-below", unpaid, revertedAbove, paidBelow);
    assertEq(unpaid, 0, "RB-1b fine: UNPAID limit");
    assertEq(revertedAbove, 0, "upward closed");
  }
}
