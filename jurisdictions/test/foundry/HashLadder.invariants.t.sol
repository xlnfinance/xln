// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {XlnFixture} from "./helpers/XlnFixture.sol";
import {XlnHanko} from "./helpers/XlnHanko.sol";
import {HashLadderHandler} from "./handlers/HashLadderHandler.sol";
import "../../contracts/Types.sol";

/// @notice Task C4, target 5: ordered-pair hash-ladder reveal slots.
///
/// The registry slot is (Hanko-authenticated revealerEntity, counterpartyEntity,
/// ladderHash, role) and the pair is deliberately NEVER sorted — the reverse
/// participant must not write this slot (fints hash-ladder reveal section,
/// mirrored by HashLadderRegistry.registerReveal on Depository storage).
contract HashLadderInvariants is XlnFixture {
  HashLadderHandler internal handler;

  function setUp() public {
    _deployXln();
    uint256[4] memory keys = [pk[0], pk[1], pk[2], pk[3]];
    handler = new HashLadderHandler(dep, keys, address(this));

    targetContract(address(handler));
    bytes4[] memory selectors = new bytes4[](4);
    selectors[0] = handler.openDispute.selector;
    selectors[1] = handler.registerReveal.selector;
    selectors[2] = handler.advance.selector;
    selectors[3] = handler.advanceToWindow.selector;
    targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
  }

  // ═══════════════ invariants ═══════════════

  /// @notice INVARIANT 5a (ordered pair). Every ghost slot matches the chain
  ///         exactly, and the REVERSED slot reads empty unless the reverse
  ///         participant itself registered it: a registration by A against B
  ///         never leaks into (B, A, ladder, role).
  function invariant_orderedPairSlotsAreIsolated() public view {
    assertEq(handler.checkOrderedPairs(), 0, "reveal leaked across the ordered pair");
  }

  /// @notice INVARIANT 5b (Source single-shot). No conflicting Source retry
  ///         (different fillRatio for the same slot) was ever accepted.
  function invariant_sourceRevealsAreSticky() public view {
    assertEq(handler.sourceConflictingRetryAccepted(), 0, "conflicting Source retry accepted");
  }

  /// @notice INVARIANT 5c (Target monotone). No lower Target replay was ever
  ///         accepted; equal/higher publications refresh the timestamp
  ///         (ghost equality in 5a proves the stored ratio/timestamp pair).
  function invariant_targetRevealsNeverDecrease() public view {
    assertEq(handler.targetLowerRetryAccepted(), 0, "lower Target replay accepted");
  }

  /// @notice INVARIANT 5d (Source window). A FIRST Source write was never
  ///         accepted outside its signed account window
  ///         [disputeStart, disputeStart + ownerResponseSeconds] with a live
  ///         dispute — inside the model where windows are 50s/50s.
  function invariant_sourceFirstWriteNeedsWindow() public view {
    assertEq(handler.sourceOutsideWindowAccepted(), 0, "first Source write outside its window");
  }

  // ═══════════════ deterministic controls ═══════════════

  /// @notice CONTROL (ordered pair, concrete): A registers a Target reveal vs
  ///         B; the (B, A) slot must read zero; then B registers its own and
  ///         only then does that slot hold a value.
  function test_control_orderedPairIsolation() public {
    // Target role needs no dispute/window.
    handler.registerReveal(0, 1, 0 /*target*/, 0x0fff, 0, 1);
    (uint16 direct, ) = dep.getHashLadderReveal(
      handler.entityOf(0), handler.entityOf(1), _ladderOf(0, 0x0fff), true
    );
    (uint16 reversed, ) = dep.getHashLadderReveal(
      handler.entityOf(1), handler.entityOf(0), _ladderOf(0, 0x0fff), true
    );
    assertEq(direct, 0x0fff, "direct Target write missing");
    assertEq(reversed, 0, "write leaked into the reversed slot");

    handler.registerReveal(1, 0, 0 /*target*/, 0x7fff, 0, 1);
    (uint16 reversed2, ) = dep.getHashLadderReveal(
      handler.entityOf(1), handler.entityOf(0), _ladderOf(0, 0x7fff), true
    );
    assertEq(reversed2, 0x7fff, "reverse participant cannot write its own slot");
  }

  /// @notice CONTROL (Source window + stickiness, concrete): a Source write
  ///         without a live dispute is rejected; with a live dispute it lands;
  ///         an exact retry is a sticky no-op; a conflicting retry is rejected.
  function test_control_sourceSingleShotSemantics() public {
    // No dispute: first Source write must be rejected (E12). Odd warpSeed so
    // the handler's in-action dispute self-open stays disabled here.
    handler.registerReveal(0, 1, 1 /*source*/, 0x1234, 1, 3);
    (uint16 ratio, uint256 ts) =
      dep.getHashLadderReveal(handler.entityOf(0), handler.entityOf(1), _ladderOf(1, 0x1234), false);
    assertEq(ratio, 0, "Source wrote without a live dispute window");
    assertEq(ts, 0, "Source wrote without a live dispute window");

    // Open the dispute (starts the 50s owner window), then write inside it.
    handler.openDispute(0, 1, 7);
    handler.registerReveal(0, 1, 1 /*source*/, 0x1234, 1, 5 /*no warp*/);
    (ratio, ts) = dep.getHashLadderReveal(handler.entityOf(0), handler.entityOf(1), _ladderOf(1, 0x1234), false);
    assertEq(ratio, 0x1234, "in-window Source write rejected");

    // Exact retry at a later time: sticky — revealedAt must not move.
    handler.advance(1, 10);
    handler.registerReveal(0, 1, 1, 0x1234, 1, 5);
    (uint16 ratio2, uint256 ts2) =
      dep.getHashLadderReveal(handler.entityOf(0), handler.entityOf(1), _ladderOf(1, 0x1234), false);
    assertEq(ratio2, 0x1234, "exact retry changed the ratio");
    assertEq(ts2, ts, "exact retry refreshed the Source timestamp");

    // Conflicting retry: rejected, slot unchanged.
    handler.registerReveal(0, 1, 1, 0x4321, 1, 5);
    (uint16 ratio3, ) = dep.getHashLadderReveal(handler.entityOf(0), handler.entityOf(1), _ladderOf(1, 0x1234), false);
    assertEq(ratio3, 0x1234, "conflicting Source retry replaced the record");
  }

  /// @dev ladderHash for a handler bucket/ratio pair (same derivation as the
  ///      handler's _ladderMaterial).
  function _ladderOf(uint256 bucket, uint16 ratio) internal pure returns (bytes32) {
    bytes32 fullHash = keccak256(abi.encode(keccak256(abi.encode(bucket, "full"))));
    bytes32 partialRoot;
    if (ratio == type(uint16).max) {
      partialRoot = keccak256(abi.encode(bucket, "root"));
    } else {
      bytes32[4] memory reveals;
      for (uint8 i = 0; i < 4; i++) {
        bytes32 base = keccak256(abi.encode(bucket, "nib", i));
        uint8 digit = uint8((uint256(ratio) >> ((3 - i) * 4)) & 0x0f);
        // revealForNibble = H^(15-digit)(base)
        reveals[i] = _hashSteps(base, 15 - digit);
      }
      bytes32[4] memory roots;
      for (uint8 i = 0; i < 4; i++) {
        uint8 digit = uint8((uint256(ratio) >> ((3 - i) * 4)) & 0x0f);
        roots[i] = _hashSteps(reveals[i], digit);
      }
      partialRoot = keccak256(abi.encodePacked(roots[0], roots[1], roots[2], roots[3]));
    }
    return keccak256(abi.encodePacked(fullHash, partialRoot));
  }

  function _hashSteps(bytes32 node, uint8 steps) internal pure returns (bytes32 result) {
    result = node;
    for (uint8 i = 0; i < steps; i++) {
      result = keccak256(abi.encodePacked(result));
    }
  }

  // ═══════════════ coverage report ═══════════════

  function invariant_callSummary() public view {
    console.log("disputes opened      ", handler.disputesStarted());
    console.log("registrations ok     ", handler.registrationsAccepted());
    console.log("registrations rejected", handler.registrationsRejected());
    console.log("-- source writes     ", handler.sourceWrites());
    console.log("-- target writes     ", handler.targetWrites());
    console.log("-- tracked slots     ", handler.slotCount());
  }
}
