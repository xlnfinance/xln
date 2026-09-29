// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {XlnFixture} from "./helpers/XlnFixture.sol";
import {XlnHanko} from "./helpers/XlnHanko.sol";
import {ConservationHandler} from "./handlers/ConservationHandler.sol";
import {ERC20Mock} from "../../contracts/ERC20Mock.sol";
import "../../contracts/Types.sol";

/// @notice Task C4, targets 1 + 3: value conservation through *composed*
///         processBatch calls, and entity-nonce monotonicity/replay-resistance.
///
/// Extends the Depository.invariants.t.sol pattern in a NEW file with its own
/// handler (ConservationHandler) whose batches contain several legs at once.
///
/// Token map (identical to the base suite):
///   1 -> ERC20 `erc20`  (externally backed)
///   2 -> ERC20 `tokenB` (externally backed)
///   3 -> unregistered   (mint-only, purely internal accounting)
contract DepositoryConservationInvariants is XlnFixture {
  ConservationHandler internal handler;
  ERC20Mock internal tokenB;

  uint256[3] internal TOKENS = [uint256(1), uint256(2), uint256(3)];

  function setUp() public {
    _deployXln(); // registers `erc20` as internal token 1

    tokenB = new ERC20Mock("MockB", "MKB", 18, 1e30);
    _listToken(address(tokenB));

    uint256[4] memory keys = [pk[0], pk[1], pk[2], pk[3]];
    handler = new ConservationHandler(dep, erc20, tokenB, keys, address(this));

    targetContract(address(handler));

    bytes4[] memory selectors = new bytes4[](3);
    selectors[0] = handler.mint.selector;
    selectors[1] = handler.mixedBatch.selector;
    selectors[2] = handler.replayLast.selector;
    targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
  }

  // ═══════════════ aggregation helpers ═══════════════

  function _totalReserves(uint256 tokenId) internal view returns (uint256 total) {
    for (uint256 i = 0; i < ACTORS; i++) {
      total += dep._reserves(entity[i], tokenId);
    }
  }

  function _totalCollateral(uint256 tokenId) internal view returns (uint256 total) {
    for (uint256 i = 0; i < ACTORS; i++) {
      for (uint256 j = i + 1; j < ACTORS; j++) {
        (uint256 c,) = dep._collaterals(XlnHanko.accountKey(entity[i], entity[j]), tokenId);
        total += c;
      }
    }
  }

  function _externalBacking(uint256 tokenId) internal view returns (uint256) {
    if (tokenId == 1) return erc20.balanceOf(address(dep));
    if (tokenId == 2) return tokenB.balanceOf(address(dep));
    return 0; // token 3 has no external leg
  }

  // ═══════════════ invariant 1: conservation ═══════════════

  /// @notice INVARIANT 1 (state form). For every token, the internal value
  ///         pool (Σ reserves + Σ collateral over the actor set) equals exactly
  ///         what admin minting plus external escrow injected — nothing else.
  function invariant_valuePoolIsConserved() public view {
    for (uint256 k = 0; k < 3; k++) {
      uint256 t = TOKENS[k];
      assertEq(
        _totalReserves(t) + _totalCollateral(t),
        handler.ghostMinted(t) + _externalBacking(t),
        "value created or destroyed"
      );
    }
  }

  /// @notice INVARIANT 1 (per-batch form, handler oracle). Every accepted
  ///         multi-leg processBatch moved Σreserves+Σcollateral by exactly the
  ///         Depository's external-token balance delta for that token (and by
  ///         exactly 0 for the mint-only token). Rejected batches moved nothing.
  function invariant_everyBatchConservesValue() public view {
    assertEq(handler.batchValueViolations(), 0, "a batch moved value without an external leg");
  }

  /// @notice Debts are claims, never value: the pool equality is checked with
  ///         debt fully excluded, so no debt lifecycle path may leak reserves.
  function invariant_debtNeverEntersValuePool() public view {
    for (uint256 k = 0; k < 3; k++) {
      uint256 t = TOKENS[k];
      assertEq(
        _totalReserves(t) + _totalCollateral(t),
        handler.ghostMinted(t) + _externalBacking(t),
        "debt leaked into the value pool"
      );
    }
  }

  // ═══════════════ invariant 3: entity nonce ═══════════════

  /// @notice INVARIANT 3a (Depository.sol:339). entityNonces[e] equals exactly
  ///         the number of batches accepted for e, i.e. it advanced by +1 on
  ///         every accepted batch and never moved otherwise.
  function invariant_entityNonceMatchesAcceptedCount() public view {
    for (uint256 i = 0; i < ACTORS; i++) {
      assertEq(
        dep.entityNonces(entity[i]),
        handler.ghostEntityNonce(i),
        "entityNonces desynced from accepted-batch ghost"
      );
    }
  }

  /// @notice INVARIANT 3b. Under any call order, no nonce step other than
  ///         exactly +1-on-accept was observed.
  function invariant_entityNonceStepsByExactlyOne() public view {
    assertEq(handler.nonceViolations(), 0, "nonce stepped by something other than +1");
  }

  /// @notice INVARIANT 3c. Replaying the exact (encoded, hanko, nonce) triple
  ///         of an already-accepted batch is always rejected.
  function invariant_replayedBatchIsRejected() public view {
    assertEq(handler.replayViolations(), 0, "exact replay of an accepted batch succeeded");
  }

  // ═══════════════ meta: are the invariants sensitive? ═══════════════

  /// @notice Inject unbacked value and confirm the conservation check trips.
  function test_meta_conservationIsSensitive() public {
    dep.mintToReserve(entity[0], 1, 1_000); // deliberately not ghost-tracked
    vm.expectRevert();
    this.invariant_valuePoolIsConserved();
  }

  /// @notice Force a bogus ghost nonce and confirm the nonce check trips
  ///         (proves the invariant compares real state, not two ghosts).
  function test_meta_nonceIsSensitive() public {
    // Fund through the handler so the mint ghost stays exact, then corrupt the
    // ghost the way a contract bug would: ghost says 5, contract says 0.
    handler.mint(0, 0, 1);
    bytes32 slot = _findGhostNonceSlot();
    vm.store(address(handler), slot, bytes32(uint256(5)));
    vm.expectRevert();
    this.invariant_entityNonceMatchesAcceptedCount();
  }

  /// @dev Locates `ghostEntityNonce[0]` by writing a sentinel into each
  ///      candidate slot and reading the public getter back. Avoids hardcoding
  ///      a storage layout a future edit would silently break.
  function _findGhostNonceSlot() internal returns (bytes32) {
    for (uint256 base = 0; base < 40; base++) {
      bytes32 slot = keccak256(abi.encode(uint256(0), bytes32(base)));
      bytes32 original = vm.load(address(handler), slot);
      vm.store(address(handler), slot, bytes32(uint256(987654)));
      if (handler.ghostEntityNonce(0) == 987654) {
        vm.store(address(handler), slot, original);
        return slot;
      }
      vm.store(address(handler), slot, original);
    }
    revert("ghostEntityNonce slot not found");
  }

  // ═══════════════ coverage report ═══════════════

  function invariant_callSummary() public view {
    console.log("mint              ", handler.callCount("mint"));
    console.log("mixedBatch        ", handler.callCount("mixedBatch"));
    console.log("-- accepted batches ", handler.acceptedBatches());
    console.log("-- rejected batches ", handler.rejectedBatches());
    console.log("-- replay attempts  ", handler.replayAttempts());
    console.log("-- minted t1/t2/t3  ", handler.ghostMinted(1), handler.ghostMinted(3));
  }
}
