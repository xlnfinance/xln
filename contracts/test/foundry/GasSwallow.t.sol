// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import "../../contracts/DeltaTransformer.sol";
import "../../contracts/EntityProvider.sol";
import "../../contracts/EntityTypes.sol";

/// @notice R-OOG: out-of-gas is never evidence (contracts-decisions.md, "Swallowed failures"). DeltaTransformer._decodeArguments has two checks:
///         the BOUND is the post-catch check (a caught failure that left the caller 1/64 of its gas was starved: revert), proved end to end by
///         GasGuardUnpaidTest and ReviewBApplyBatchScan. The pre-call floor `DECODE_GAS_BASE + DECODE_GAS_PER_BYTE * length` is a fast path: it
///         makes a starved plain decode revert before it burns the gas. This file binds both to the DEPLOYED contract (constants read from it,
///         never copied here): the floor covers what a plain decode costs with 10% to spare, at every size and both array shapes up to 64 KiB
///         (a floor within 10% of the need, or below it, is not a fast path: starved calls burn the gas before the post-catch check reverts them),
///         and with the floor present a starved call is cheap (measured through applyBatch).
contract GasSwallowTest is Test {
  DeltaTransformer internal decoder;

  /// Account.sol:362 MAX_DISPUTE_STARTER_ARGUMENT_BYTES: a side's arguments (the `bytes[]` wrapper holding this evidence) are at most 64 KiB.
  uint256 internal constant MAX_EVIDENCE_BYTES = 64 * 1024;
  bytes32 internal constant SECRET = keccak256("gas-swallow-secret");

  function setUp() public {
    decoder = new DeltaTransformer();
    vm.warp(2000);
  }

  function _floor(uint256 length) internal view returns (uint256) {
    return decoder.DECODE_GAS_BASE() + decoder.DECODE_GAS_PER_BYTE() * length;
  }

  function _ratios(uint256 n) internal pure returns (bytes memory) {
    uint16[] memory fillRatios = new uint16[](n);
    for (uint256 i = 0; i < n; i++) fillRatios[i] = uint16(1 + (i % 65_000));
    return abi.encode(DeltaTransformer.Arguments({fillRatios: fillRatios, secrets: new bytes32[](0)}));
  }

  function _secrets(uint256 n) internal pure returns (bytes memory) {
    bytes32[] memory secrets = new bytes32[](n);
    for (uint256 i = 0; i < n; i++) secrets[i] = keccak256(abi.encode(i));
    return abi.encode(DeltaTransformer.Arguments({fillRatios: new uint16[](0), secrets: secrets}));
  }

  /// The least gas the strict decode needs to succeed when it is handed exactly that much (binary search over a raw staticcall).
  function _decodeNeed(bytes memory evidence) internal view returns (uint256 lo) {
    bytes memory callData = abi.encodeCall(decoder.decodeArgumentsStrict, (evidence));
    uint256 hi = 30_000_000;
    lo = 0;
    while (lo + 1 < hi) {
      uint256 mid = (lo + hi) / 2;
      (bool ok,) = address(decoder).staticcall{gas: mid}(callData);
      if (ok) hi = mid; else lo = mid;
    }
    return hi;
  }

  /// The try frame hands the callee 63/64 of what is left at the call; the floor must cover that need with 10% to spare.
  function _assertFloorCovers(bytes memory evidence, string memory shape) internal view {
    uint256 need = _decodeNeed(evidence);
    uint256 floor = _floor(evidence.length);
    console.log(shape, evidence.length, need);
    assertGe(floor * 100, need * 64 / 63 * 110, string.concat(shape, ": the floor is not 10% above what the decode needs"));
  }

  function test_R_OOG_floorCoversEveryFillRatioSize() public view {
    uint256[5] memory sizes = [uint256(1), 10, 100, 1700, (MAX_EVIDENCE_BYTES - 128) / 32];
    for (uint256 i = 0; i < sizes.length; i++) _assertFloorCovers(_ratios(sizes[i]), "fillRatios");
  }

  function test_R_OOG_floorCoversEverySecretSize() public view {
    uint256[5] memory sizes = [uint256(1), 10, 100, 1700, (MAX_EVIDENCE_BYTES - 128) / 32];
    for (uint256 i = 0; i < sizes.length; i++) _assertFloorCovers(_secrets(sizes[i]), "secrets");
  }

  function _applyBatch(uint256 gas_, bytes memory evidence) internal view returns (bool ok, uint256 burned) {
    DeltaTransformer.Payment[] memory pays = new DeltaTransformer.Payment[](1);
    pays[0] = DeltaTransformer.Payment({deltaIndex: 0, amount: SignedAmount(false, 50), revealedUntilTimestamp: 1000, hash: keccak256(abi.encode(SECRET))});
    bytes memory batch = decoder.encodeBatch(DeltaTransformer.Batch({payment: pays, swap: new DeltaTransformer.Swap[](0), pull: new DeltaTransformer.Pull[](0)}));
    Int768[] memory deltas = new Int768[](1);
    uint256[] memory ids = new uint256[](1);
    bytes memory data = abi.encodeCall(decoder.applyBatch, (deltas, ids, batch, evidence, "", 500, 500, bytes32(uint256(1)), bytes32(uint256(2)), 0, 0, 0, 0));
    address target = address(decoder);
    uint256 before_ = gasleft();
    (ok,) = target.staticcall{gas: gas_}(data);
    burned = before_ - gasleft();
  }

  /// A limit just under the floor is refused BEFORE the decode burns the gas: the call costs a few tens of thousands, not the limit. Without the floor
  /// the starved self-call burns 63/64 of the limit before the post-catch check reverts it, so a deleted (or weakened) floor fails here.
  function test_R_OOG_belowTheFloorTheCallRevertsBeforeItBurnsTheGas() public view {
    bytes memory evidence = _ratios((MAX_EVIDENCE_BYTES - 128) / 32);
    uint256 limit = _floor(evidence.length) - 10_000;
    (bool ok, uint256 burned) = _applyBatch(limit, evidence);
    console.log("limit / burned", limit, burned);
    assertFalse(ok, "a call below the floor reverts");
    assertLt(burned, limit / 4, "the floor refuses the call before the decode burns the gas");
  }
}

/// An ERC-1271 board member that costs `burn` gas to say yes: a stand-in for a smart-account or passkey wallet with an expensive check.
contract BurnMember {
  uint256 public immutable burn;
  constructor(uint256 burn_) { burn = burn_; }
  function isValidSignature(bytes32, bytes calldata) external view returns (bytes4) {
    uint256 target = gasleft() > burn ? gasleft() - burn : 0;
    while (gasleft() > target) {}
    return 0x1626ba7e;
  }
}

/// @notice HankoVerifier reads a failed ERC-1271 member call, an out-of-gas one included, as "member invalid" (a gas-capped staticcall,
///         swallowed). At the verifier that is a normal answer, (0, false), at gas limits a relayer can pick. This sweeps those limits with
///         a member that needs 900k gas (the verifier hands a member at most 1M) and pins what the swallow can and cannot become: the verifier answers valid only for the member's own
///         claim; an entity action that consumes the answer reverts at every limit where the verifier says invalid, and passes only where the
///         verifier says valid (upward-closed); so a gas limit can turn a pass into a revert and nothing else.
contract HankoMemberGasSwallowTest is Test {
  uint256 internal constant BURN = 900_000;
  /// The member starves in a window of about BURN / 63 gas below the limit where the proof first verifies; 500 gas samples it.
  uint256 internal constant STEP = 500;
  EntityProvider internal ep;
  BurnMember internal member;
  uint256 internal entityNumber;
  bytes internal hanko;
  bytes32 internal claimedEntity;

  function setUp() public {
    ep = new EntityProvider(address(0xF00D));
    member = new BurnMember(BURN);
    bytes32[] memory ids = new bytes32[](1);
    ids[0] = bytes32(uint256(uint160(address(member))));
    uint16[] memory powers = new uint16[](1);
    powers[0] = 1;
    Board memory board = Board({votingThreshold: 1, entityIds: ids, votingPowers: powers, boardChangeDelay: 0, controlChangeDelay: 0, dividendChangeDelay: 0});
    entityNumber = ep.registerNumberedEntity(abi.encode(board));
    claimedEntity = bytes32(entityNumber);
  }

  function _hanko(bytes32 entityId) internal view returns (bytes memory) {
    bytes32[] memory placeholders = new bytes32[](1);
    placeholders[0] = bytes32(uint256(uint160(address(member))));
    HankoVerifier.HankoClaim[] memory claims = new HankoVerifier.HankoClaim[](1);
    uint256[] memory indexes = new uint256[](1);
    uint256[] memory weights = new uint256[](1);
    weights[0] = 1;
    claims[0] = HankoVerifier.HankoClaim({entityId: entityId, entityIndexes: indexes, weights: weights, threshold: 1, boardChangeDelay: 0, controlChangeDelay: 0, dividendChangeDelay: 0});
    bytes[] memory memberSignatures = new bytes[](1);
    memberSignatures[0] = hex"01";
    return abi.encode(HankoVerifier.HankoBytes({placeholders: placeholders, packedSignatures: "", claims: claims, memberSignatures: memberSignatures}));
  }

  function _verify(bytes memory h, bytes32 hash, uint256 g) internal view returns (bool ok, bytes32 entity, bool valid) {
    (bool success, bytes memory ret) = address(ep).staticcall{gas: g}(abi.encodeCall(ep.verifyCurrentHankoSignature, (h, hash)));
    if (!success) return (false, bytes32(0), false);
    (entity, valid) = abi.decode(ret, (bytes32, bool));
    return (true, entity, valid);
  }

  function test_R_OOG_starvedMemberIsInvalidAtTheVerifierAndARevertAtTheConsumer() public {
    bytes32 hash = keccak256("member-gas");
    bytes memory h = _hanko(claimedEntity);
    (bool okFull, bytes32 entityFull, bool validFull) = _verify(h, hash, 8_000_000);
    assertTrue(okFull && validFull && entityFull == claimedEntity, "the member's proof verifies at full gas");

    // the least gas at which the verifier says valid, by bisection (valid is monotone in gas)
    uint256 lo = 0;
    uint256 hi = 8_000_000;
    while (lo + 1 < hi) {
      uint256 mid = (lo + hi) / 2;
      (bool ok, , bool valid) = _verify(h, hash, mid);
      if (ok && valid) hi = mid; else lo = mid;
    }
    uint256 firstValid = hi;

    // every limit in the window below it, one gas at a time
    uint256 answeredInvalid;
    uint256 reverted;
    for (uint256 g = firstValid - 15_000; g < firstValid + 50; g += STEP) {
      (bool ok, bytes32 entity, bool valid) = _verify(h, hash, g);
      if (g < firstValid) {
        assertFalse(ok && valid, "valid below the least gas that verifies");
        if (ok) { answeredInvalid++; assertEq(entity, bytes32(0), "an invalid answer names no entity"); } else reverted++;
      } else {
        assertTrue(ok && valid && entity == claimedEntity, "valid from the least gas up");
      }
    }
    emit log_named_uint("verifier: gas limits below the first valid one that answered (0, false)", answeredInvalid);
    emit log_named_uint("verifier: gas limits below the first valid one that reverted", reverted);
    assertGt(answeredInvalid, 0, "the sweep must reach the window where a starved member reads as invalid");

    // the consumer: an entity transfer authorised by the same member board
    (uint256 controlTokenId, ) = ep.getTokenIds(entityNumber);
    address to = address(0xBEEF);
    bytes32 transferHash = ep.computeEntityTransferHankoHash(entityNumber, to, controlTokenId, 5, 1);
    bytes memory transferHanko = _hanko(claimedEntity);
    // find where the consumer first passes (bisection: a pass is monotone in gas), then sweep the window below it
    lo = 0;
    hi = 8_000_000;
    while (lo + 1 < hi) {
      uint256 mid = (lo + hi) / 2;
      uint256 snap = vm.snapshotState();
      (bool ok,) = address(ep).call{gas: mid}(abi.encodeCall(ep.entityTransferTokens, (entityNumber, to, controlTokenId, 5, transferHanko)));
      vm.revertToState(snap);
      if (ok) hi = mid; else lo = mid;
    }
    uint256 firstPass = hi;
    transferHash; // the member accepts any hash; the payload above is what the entity signs
    for (uint256 g = firstPass - 15_000; g < firstPass + 50; g += STEP) {
      uint256 snap = vm.snapshotState();
      (bool ok,) = address(ep).call{gas: g}(abi.encodeCall(ep.entityTransferTokens, (entityNumber, to, controlTokenId, 5, transferHanko)));
      bool moved = ep.balanceOf(to, controlTokenId) == 5;
      vm.revertToState(snap);
      assertEq(ok, moved, "a transfer either passes and moves the shares or reverts and moves nothing");
      assertEq(ok, g >= firstPass, "the consumer passes from its least gas up and reverts below it");
    }
  }
}
