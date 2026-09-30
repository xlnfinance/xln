// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import "../../contracts/DeltaTransformer.sol";
import "../../contracts/EntityProvider.sol";
import "../../contracts/EntityTypes.sol";

/// @notice R-OOG: out-of-gas is never evidence (contracts-decisions.md, "Swallowed failures"). DeltaTransformer._decodeArguments guards its
///         swallowing try/catch with `gasleft() >= 50_000 + 8 * length`. This measures what the decode really costs, for both array
///         shapes of the evidence, up to the size Account lets through (64 KiB per side), and fails if the guard is ever smaller than
///         the need: a decode that runs out of gas below the guard would read as "no evidence" at a gas limit the relayer chose.
///         The fill-ratio shape (uint16[], validated and copied per element) is the dearer one per byte, and the one the vm scan
///         (`j5-fifth-transformer-gas.test.ts`) does not use.
contract GasSwallowTest is Test {
  DeltaTransformer internal decoder;

  uint256 internal constant GUARD_BASE = 50_000;
  uint256 internal constant GUARD_PER_BYTE = 8;
  /// Account.sol:362 MAX_DISPUTE_STARTER_ARGUMENT_BYTES: a side's arguments (the `bytes[]` wrapper holding this evidence) are at most 64 KiB.
  uint256 internal constant MAX_EVIDENCE_BYTES = 64 * 1024;

  function setUp() public {
    decoder = new DeltaTransformer();
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

  /// The try frame hands the callee 63/64 of what is left at the call, so the guard covers the decode when guard * 63/64 is above the need.
  function _assertGuardCovers(bytes memory evidence, string memory shape) internal view {
    uint256 need = _decodeNeed(evidence);
    uint256 guard = GUARD_BASE + GUARD_PER_BYTE * evidence.length;
    console.log(shape, evidence.length, need);
    assertLe(need * 64 / 63, guard, string.concat(shape, ": the guard is below what the decode needs"));
  }

  function test_R_OOG_guardCoversEveryFillRatioSize() public view {
    uint256[5] memory sizes = [uint256(0), 1, 100, 1700, (MAX_EVIDENCE_BYTES - 128) / 32];
    for (uint256 i = 0; i < sizes.length; i++) _assertGuardCovers(_ratios(sizes[i]), "fillRatios");
  }

  function test_R_OOG_guardCoversEverySecretSize() public view {
    uint256[5] memory sizes = [uint256(0), 1, 100, 1700, (MAX_EVIDENCE_BYTES - 128) / 32];
    for (uint256 i = 0; i < sizes.length; i++) _assertGuardCovers(_secrets(sizes[i]), "secrets");
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
