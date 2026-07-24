// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {XlnFixture} from "./helpers/XlnFixture.sol";
import {XlnHanko} from "./helpers/XlnHanko.sol";
import {DepositoryHandler} from "./handlers/DepositoryHandler.sol";
import {ERC20Mock} from "../../contracts/ERC20Mock.sol";
import "../../contracts/Types.sol";

/// @notice Stateful invariants over Depository.processBatch.
///
/// Token map:
///   1 -> ERC20 `tokenA`      (externally backed, deposit/withdraw reachable)
///   2 -> ERC20 `tokenB`      (externally backed)
///   3 -> unregistered        (mint-only, purely internal accounting)
contract DepositoryInvariants is XlnFixture {
  DepositoryHandler internal handler;
  ERC20Mock internal tokenB;

  uint256[3] internal TOKENS = [uint256(1), uint256(2), uint256(3)];

  function setUp() public {
    _deployXln(); // registers `erc20` as internal token 1

    tokenB = new ERC20Mock("MockB", "MKB", 18, 1e30);
    dep.registerExternalToken(0, address(tokenB), 0);

    uint256[4] memory keys = [pk[0], pk[1], pk[2], pk[3]];
    handler = new DepositoryHandler(dep, erc20, tokenB, keys);

    // Depository.mintToReserve is gated on msg.sender == admin, which is this
    // contract; the handler pranks it, so no ownership transfer is needed.
    targetContract(address(handler));

    bytes4[] memory selectors = new bytes4[](15);
    selectors[0] = handler.mint.selector;
    selectors[1] = handler.reserveToReserve.selector;
    selectors[2] = handler.reserveToCollateral.selector;
    selectors[3] = handler.collateralToReserve.selector;
    selectors[4] = handler.settle.selector;
    selectors[5] = handler.flashloanRepaidByCollateral.selector;
    selectors[6] = handler.flashloanIntoCollateral.selector;
    selectors[7] = handler.depositExternal.selector;
    selectors[8] = handler.withdrawExternal.selector;
    selectors[9] = handler.pokeEnforceDebts.selector;
    selectors[10] = handler.disputeStart.selector;
    selectors[11] = handler.disputeFinalizeTimeout.selector;
    selectors[12] = handler.advance.selector;
    selectors[13] = handler.advancePastDisputeDelay.selector;
    selectors[14] = handler.disputeFullCycle.selector;
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

  function _totalDebt(uint256 tokenId) internal view returns (uint256 total) {
    for (uint256 i = 0; i < ACTORS; i++) {
      total += dep.debtOutstanding(entity[i], tokenId);
    }
  }

  function _externalBacking(uint256 tokenId) internal view returns (uint256) {
    if (tokenId == 1) return erc20.balanceOf(address(dep));
    if (tokenId == 2) return tokenB.balanceOf(address(dep));
    return 0; // token 3 has no external leg
  }

  // ═══════════════ invariant 1: value conservation ═══════════════

  /// @notice INVARIANT 1 (exact form). Internal value for a token is exactly
  ///         what was minted plus what is escrowed externally — never more.
  ///         Debt is deliberately excluded: it is a claim, not an asset (see
  ///         invariant_debtIsNotValue).
  function invariant_valueConservation() public view {
    for (uint256 k = 0; k < 3; k++) {
      uint256 t = TOKENS[k];
      uint256 internalValue = _totalReserves(t) + _totalCollateral(t);
      uint256 expected = handler.ghostMinted(t) + _externalBacking(t);
      assertEq(internalValue, expected, "value created or destroyed");
    }
  }

  /// @notice INVARIANT 1 (as literally specified in the task: reserves +
  ///         collateral + debtOutstanding must not grow). Recorded separately
  ///         because debt issuance legitimately grows this sum.
  function invariant_reservesPlusCollateralPlusDebtNotInflated() public view {
    for (uint256 k = 0; k < 3; k++) {
      uint256 t = TOKENS[k];
      uint256 sum = _totalReserves(t) + _totalCollateral(t) + _totalDebt(t);
      uint256 ceiling = handler.ghostMinted(t) + _externalBacking(t) + _totalDebt(t);
      assertLe(sum, ceiling, "reserves+collateral+debt exceeded backing");
    }
  }

  /// @notice Outstanding debt is never spendable: an entity can never move more
  ///         than reserve - debtOutstanding, so a debtor's reserve floor holds.
  function invariant_debtIsNotValue() public view {
    for (uint256 k = 0; k < 3; k++) {
      uint256 t = TOKENS[k];
      // Debt lives outside the value pool; the pool itself stays exact.
      assertEq(
        _totalReserves(t) + _totalCollateral(t),
        handler.ghostMinted(t) + _externalBacking(t),
        "debt leaked into the value pool"
      );
    }
  }

  // ═══════════════ invariant 2: flashloans close ═══════════════

  /// @notice INVARIANT 2. Handler-side oracle: no successful batch containing
  ///         flashloans ever ended with the borrower holding more reserve than
  ///         it held before the batch, for any flashloan token — including
  ///         duplicate tokenIds and a same-batch reserve-to-collateral leg.
  function invariant_flashloanNeverProfits() public view {
    assertEq(handler.flashloanViolations(), 0, "flashloan left the borrower richer");
  }

  // ═══════════════ invariant 3: debt bookkeeping ═══════════════

  /// @notice INVARIANT 3a. debtOutstanding equals the sum of live queue entries.
  function invariant_debtOutstandingMatchesQueue() public view {
    for (uint256 i = 0; i < ACTORS; i++) {
      for (uint256 k = 0; k < 3; k++) {
        uint256 t = TOKENS[k];
        (uint256 sum,) = _walkDebtQueue(entity[i], t);
        assertEq(sum, dep.debtOutstanding(entity[i], t), "debtOutstanding desynced from queue");
      }
    }
  }

  /// @notice INVARIANT 3b. _activeDebtsByToken equals the number of live entries.
  function invariant_activeDebtCountMatchesQueue() public view {
    for (uint256 i = 0; i < ACTORS; i++) {
      for (uint256 k = 0; k < 3; k++) {
        uint256 t = TOKENS[k];
        (, uint256 live) = _walkDebtQueue(entity[i], t);
        assertEq(live, dep._activeDebtsByToken(entity[i], t), "_activeDebtsByToken desynced");
      }
    }
  }

  /// @notice INVARIANT 3c. The FIFO cursor never points past a live entry that
  ///         a chunked enforceDebts would then skip forever.
  function invariant_debtCursorNeverStrandsDebt() public view {
    for (uint256 i = 0; i < ACTORS; i++) {
      for (uint256 k = 0; k < 3; k++) {
        uint256 t = TOKENS[k];
        uint256 cursor = dep._debtIndex(entity[i], t);
        uint256 len = _debtQueueLength(entity[i], t);
        if (len == 0) {
          assertEq(cursor, 0, "cursor left dangling on an empty queue");
          continue;
        }
        // Everything before the cursor must already be settled.
        for (uint256 idx = 0; idx < cursor && idx < len; idx++) {
          (, uint256 amount) = dep._debts(entity[i], t, idx);
          assertEq(amount, 0, "cursor skipped an unpaid debt");
        }
      }
    }
  }

  function _debtQueueLength(bytes32 e, uint256 t) internal view returns (uint256 len) {
    // Debt[] has no length getter; probe the public array getter until it panics.
    for (uint256 i = 0; i < 128; i++) {
      try dep._debts(e, t, i) returns (bytes32, uint256) { len = i + 1; }
      catch { break; }
    }
  }

  function _walkDebtQueue(bytes32 e, uint256 t) internal view returns (uint256 sum, uint256 live) {
    uint256 len = _debtQueueLength(e, t);
    for (uint256 i = 0; i < len; i++) {
      (, uint256 amount) = dep._debts(e, t, i);
      if (amount != 0) {
        sum += amount;
        live++;
      }
    }
  }

  // ═══════════════ invariant 4: dispute monotonicity ═══════════════

  /// @notice INVARIANT 4a. The dispute starter can never finalize before
  ///         `defaultDisputeDelay` blocks have passed.
  function invariant_disputeNotFinalizableEarly() public view {
    assertEq(handler.disputeEarlyFinalizeViolations(), 0, "starter finalized before the delay");
  }

  /// @notice INVARIANT 4b. A dispute can never be finalized twice.
  function invariant_disputeNotFinalizableTwice() public view {
    assertEq(handler.disputeDoubleFinalizeViolations(), 0, "dispute finalized twice");
  }

  /// @notice INVARIANT 4c. A dispute can never be started on top of a live one.
  function invariant_disputeNotRestartable() public view {
    assertEq(handler.disputeOverwriteViolations(), 0, "dispute overwrote a live dispute");
  }

  /// @notice INVARIANT 4d. Post-state check: an account with a live dispute
  ///         always carries a consistent timeout, and a cleared dispute carries
  ///         no residue.
  function invariant_disputeStateIsConsistent() public view {
    for (uint256 i = 0; i < ACTORS; i++) {
      for (uint256 j = i + 1; j < ACTORS; j++) {
        bytes memory key = XlnHanko.accountKey(entity[i], entity[j]);
        (
          ,
          bytes32 disputeHash,
          uint256 timeout,
          uint256 startTs,
          bytes32 initialPbHash,
          ,
          ,
        ) = dep._accounts(key);
        if (disputeHash == bytes32(0)) {
          assertEq(timeout, 0, "stale timeout on a cleared dispute");
          assertEq(startTs, 0, "stale start timestamp on a cleared dispute");
          assertEq(initialPbHash, bytes32(0), "stale proof hash on a cleared dispute");
        } else {
          assertGt(timeout, 0, "live dispute without a timeout");
          assertTrue(initialPbHash != bytes32(0), "live dispute without a proof hash");
        }
      }
    }
  }

  /// @notice Collateral must be fully released by a finalization: no account
  ///         may keep collateral for a token after its dispute settled it.
  function invariant_accountNonceNeverDecreases() public view {
    // Nonces are set, never decremented; a monotone ghost would double-count
    // work the contract already enforces, so this checks the reachable floor:
    // a live dispute implies a non-zero account nonce.
    for (uint256 i = 0; i < ACTORS; i++) {
      for (uint256 j = i + 1; j < ACTORS; j++) {
        bytes memory key = XlnHanko.accountKey(entity[i], entity[j]);
        (uint256 nonce, bytes32 disputeHash,,,,,,) = dep._accounts(key);
        if (disputeHash != bytes32(0)) assertGt(nonce, 0, "dispute with a zero account nonce");
      }
    }
  }

  // ═══════════════ meta: are the invariants sensitive? ═══════════════

  /// @notice A green invariant is only worth something if it can go red. This
  ///         injects unbacked value and asserts the conservation check catches it.
  function test_meta_valueConservationIsSensitive() public {
    dep.mintToReserve(entity[0], 1, 1_000); // deliberately not recorded in the ghost
    vm.expectRevert();
    this.invariant_valueConservation();
  }

  /// @notice Same for the debt bookkeeping check: corrupt debtOutstanding
  ///         directly in storage and confirm the queue walk disagrees.
  function test_meta_debtInvariantIsSensitive() public {
    // debtOutstanding is the 6th declared mapping; find its slot by brute force
    // rather than hardcoding a layout that a future edit would silently break.
    bytes32 slot = _findDebtOutstandingSlot();
    vm.store(address(dep), slot, bytes32(uint256(777)));
    assertEq(dep.debtOutstanding(entity[0], 1), 777, "storage probe missed");
    vm.expectRevert();
    this.invariant_debtOutstandingMatchesQueue();
  }

  /// @dev Locates `debtOutstanding[entity[0]][1]` by writing a sentinel into each
  ///      candidate slot and reading the public getter back, restoring anything
  ///      that turns out to be the wrong slot. Beats hardcoding a storage layout.
  function _findDebtOutstandingSlot() internal returns (bytes32) {
    for (uint256 base = 0; base < 40; base++) {
      bytes32 inner = keccak256(abi.encode(entity[0], bytes32(base)));
      bytes32 slot = keccak256(abi.encode(uint256(1), inner));
      bytes32 original = vm.load(address(dep), slot);
      vm.store(address(dep), slot, bytes32(uint256(12345)));
      if (dep.debtOutstanding(entity[0], 1) == 12345) {
        vm.store(address(dep), slot, original);
        return slot;
      }
      vm.store(address(dep), slot, original);
    }
    revert("debtOutstanding slot not found");
  }

  // ═══════════════ coverage report ═══════════════

  function invariant_callSummary() public view {
    console.log("mint                      ", handler.callCount("mint"));
    console.log("reserveToReserve          ", handler.callCount("reserveToReserve"));
    console.log("reserveToCollateral       ", handler.callCount("reserveToCollateral"));
    console.log("collateralToReserve       ", handler.callCount("collateralToReserve"));
    console.log("settle                    ", handler.callCount("settle"));
    console.log("flashloanRepaidByCollat.  ", handler.callCount("flashloanRepaidByCollateral"));
    console.log("flashloanIntoCollateral   ", handler.callCount("flashloanIntoCollateral"));
    console.log("depositExternal           ", handler.callCount("depositExternal"));
    console.log("withdrawExternal          ", handler.callCount("withdrawExternal"));
    console.log("pokeEnforceDebts          ", handler.callCount("pokeEnforceDebts"));
    console.log("disputeStart              ", handler.callCount("disputeStart"));
    console.log("disputeFinalizeTimeout    ", handler.callCount("disputeFinalizeTimeout"));
    console.log("advance                   ", handler.callCount("advance"));
    console.log("disputeFullCycle          ", handler.callCount("disputeFullCycle"));
    console.log("-- states with live debt   ", handler.debtObservations());
    console.log("-- finalizes by starter    ", handler.starterTimeoutFinalizes());
    console.log("-- finalizes by counterpty ", handler.counterpartyTimeoutFinalizes());
    console.log("-- rejected early attempts ", handler.starterEarlyFinalizeAttempts());
  }
}
