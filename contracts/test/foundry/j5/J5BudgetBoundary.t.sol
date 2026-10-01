// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {console, Vm, Test} from "forge-std/Test.sol";
import {XlnHanko} from "../helpers/XlnHanko.sol";
import "../../../contracts/Types.sol";
import {Depository} from "../../../contracts/Depository.sol";
import {DeltaTransformer} from "../../../contracts/DeltaTransformer.sol";
import {HeavyEntityProvider} from "./J5Starve.t.sol";

// Re-review of #54 at 0aeb766, question 2: a Foundry test that pins the BUDGET CONTRACT itself, so the vm scans are not the only thing standing between
// `budget * 64/63`, the budget field and the self-call's gas. The property: from the lowest transaction gas limit that passes the pre-call check upward, the
// self-call's first callee sees the SAME gas (the whole signed budget less the fixed work inside the frame), and never more than the budget.
//   - `64/63` dropped, reserve 0, no check at all: at the lowest passing limit the callee sees LESS than at an ample limit (the 63/64 cap bites);
//   - budget ignored (call(gas())) or budget + 100k: the callee sees MORE than the budget;
//   - half the budget: the callee sees far less than the budget.
// The spy is an NFT (NftCustody's high-level call bubbles the revert data; an ERC20 failure is Depository's own E3). It reverts with the 4 bytes uint32(gas()) it sees, which the batch reports as BatchFailed(reason).
contract EntrySpyNft {
  mapping(uint256 => address) public ownerOf;
  bool public spy;
  function mint(address to, uint256 id) external { ownerOf[id] = to; }
  function setSpy(bool b) external { spy = b; }
  function totalSupply() external pure returns (uint256) { return 1; }
  function balanceOf(address) external pure returns (uint256) { return 1; }
  function supportsInterface(bytes4) external pure returns (bool) { return true; }
  function getApproved(uint256) external view returns (address) { return msg.sender; }
  function isApprovedForAll(address, address) external pure returns (bool) { return true; }
  function transferFrom(address from, address to, uint256 id) external {
    if (spy) { assembly { mstore(0, shl(224, gas())) revert(0, 4) } }
    require(ownerOf[id] == from, "owner");
    ownerOf[id] = to;
  }
}

contract J5BudgetBoundary is Test {
  Depository dep;
  HeavyEntityProvider ep;
  EntrySpyNft tok;
  bytes32 constant A = bytes32(uint256(1));
  /// Large enough that budget/63 is well above BATCH_POST_CALL_RESERVE, so a missing 64/63 shows.
  uint64 constant BUDGET = 4_000_000;
  /// What the frame spends before it reaches the token (decode, bounds, the withdrawal's own reads): measured 193,663 at the head, the callee sees BUDGET - this.
  uint256 constant FRAME_WORK_MAX = 250_000;

  function setUp() public {
    ep = new HeavyEntityProvider();
    dep = new Depository(address(ep), address(new DeltaTransformer()));
    tok = new EntrySpyNft();
    tok.mint(address(this), 7);
    vm.prank(address(ep));
    dep.registerExternalToken(1, address(tok), 7);
    Batch memory dp = XlnHanko.emptyBatch();
    dp.gasBudget = BUDGET;
    dp.externalTokenToReserve = new ExternalTokenToReserve[](1);
    dp.externalTokenToReserve[0] = ExternalTokenToReserve({ entity: A, contractAddress: address(tok), externalTokenId: 7, tokenType: 1, internalTokenId: 1, amount: 1 });
    (bool ok,) = address(dep).call{gas: 30_000_000}(abi.encodeCall(dep.processBatch, (A, abi.encode(dp), abi.encode(A, uint256(0)), 1)));
    assertTrue(ok, "deposit lands");
    tok.setSpy(true);
  }

  function _data() internal view returns (bytes memory) {
    Batch memory wd = XlnHanko.emptyBatch();
    wd.gasBudget = BUDGET;
    wd.reserveToExternalToken = new ReserveToExternalToken[](1);
    wd.reserveToExternalToken[0] = ReserveToExternalToken({ receivingEntity: bytes32(uint256(uint160(address(0xBEEF)))), tokenId: 1, amount: 1 });
    return abi.encodeCall(dep.processBatch, (A, abi.encode(wd), abi.encode(A, uint256(0)), 2));
  }

  /// @return passed the transaction returned; entry the gas the spy saw (0 when it did not run)
  function _run(bytes memory data, uint256 limit) internal returns (bool passed, uint256 entry) {
    uint256 snap = vm.snapshotState();
    vm.recordLogs();
    (passed,) = address(dep).call{gas: limit}(data);
    Vm.Log[] memory logs = vm.getRecordedLogs();
    vm.revertToState(snap);
    for (uint256 i = 0; i < logs.length; i++) {
      if (logs[i].topics[0] == keccak256("BatchFailed(bytes32,uint256,bytes4)")) entry = uint32(abi.decode(logs[i].data, (bytes4)));
    }
  }

  function test_theCalleeSeesTheWholeBudgetFromTheLowestPassingLimitUp() public {
    bytes memory data = _data();
    // the lowest limit at which the transaction returns (the pre-call check passes)
    uint256 lo = 3_000_000; uint256 hi = 5_000_000;
    while (hi - lo > 1) {
      uint256 mid = (lo + hi) / 2;
      (bool ok,) = _run(data, mid);
      if (ok) hi = mid; else lo = mid;
    }
    (bool okLow, uint256 entryLow) = _run(data, hi);
    (bool okHigh, uint256 entryHigh) = _run(data, 30_000_000);
    console.log("lowest passing limit:", hi);
    console.log("callee gas there / at 30M:", entryLow, entryHigh);
    assertTrue(okLow && okHigh, "both return");
    assertGt(entryLow, 0, "the spy ran at the lowest passing limit");
    // never more than the signed budget, and not much less (only the frame's own work)
    assertLe(entryHigh, uint256(BUDGET), "the self-call got more than the budget");
    assertGe(entryHigh, uint256(BUDGET) - FRAME_WORK_MAX, "the self-call got much less than the budget");
    // the pre-call check is what guarantees it: at the lowest passing limit the callee sees exactly what it sees with gas to spare
    assertEq(entryLow, entryHigh, "at the lowest passing limit the callee got less than the whole budget");
    // and one gas below it the transaction reverts (BatchGasStarved), it does not run the ops on less
    (bool okBelow,) = _run(data, hi - 1);
    assertFalse(okBelow, "one below the lowest passing limit still ran");
  }
}
