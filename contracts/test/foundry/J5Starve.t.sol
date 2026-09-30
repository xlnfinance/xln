// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Depository} from "../../contracts/Depository.sol";
import {DeltaTransformer} from "../../contracts/DeltaTransformer.sol";
import {ERC20Mock} from "../../contracts/ERC20Mock.sol";
import {XlnHanko} from "./helpers/XlnHanko.sol";
import "../../contracts/Types.sol";

// G1 and the empty-reason policy of J5 (PR #54), from the re-review at d645df4 (review/pr-54/J5Starve.t.sol), adapted to the gas floor:
// processBatch reports a failed batch only when the self-call started with at least BATCH_GAS_FLOOR (15,240,095), so a relayer choosing
// the gas can never turn a good batch into a BatchFailed, however deep the starved frame sits. An empty revert reason is then a real
// empty revert, reported as BatchFailed(0x00000000) with the nonce spent, so a paused or blacklisted token cannot stall the entity.

/// A stand-in EntityProvider whose hanko check costs a chosen amount of gas: a stand-in for a counterparty whose board is large
/// (many signatures). hanko = abi.encode(entityId, gasToBurn). It is what the review needs to ask "can a relayer choose the gas so
/// that the counterparty-signature check runs out of gas, and the batch is then reported as a failure instead of reverting?"
contract HeavyEntityProvider {
  function verifyCurrentHankoSignature(bytes calldata hanko, bytes32) external view returns (bytes32, bool) {
    (bytes32 id, uint256 burn) = abi.decode(hanko, (bytes32, uint256));
    uint256 target = gasleft() > burn ? gasleft() - burn : 0;
    while (gasleft() > target) {}
    return (id, true);
  }
  function listToken(Depository dep, address token) external returns (uint256) {
    return dep.registerExternalToken(0, token, 0);
  }
}

/// An NFT that can be paused: while paused its transferFrom reverts with no data (a plain `revert()`), like many real pausable tokens.
contract PausableNft {
  mapping(uint256 => address) public ownerOf;
  bool public paused;
  function mint(address to, uint256 id) external { ownerOf[id] = to; }
  function setPaused(bool p) external { paused = p; }
  function totalSupply() external pure returns (uint256) { return 1; }
  function balanceOf(address) external pure returns (uint256) { return 1; }
  function supportsInterface(bytes4) external pure returns (bool) { return true; }
  function getApproved(uint256) external view returns (address) { return msg.sender; }
  function isApprovedForAll(address, address) external pure returns (bool) { return true; }
  function transferFrom(address from, address to, uint256 id) external {
    if (paused) revert();
    require(ownerOf[id] == from, "owner");
    ownerOf[id] = to;
  }
}

contract J5EmptyReasonTest is Test {
  Depository dep;
  HeavyEntityProvider ep;
  PausableNft nft;
  bytes32 constant A = bytes32(uint256(1));

  function setUp() public {
    ep = new HeavyEntityProvider();
    dep = new Depository(address(ep), address(new DeltaTransformer()));
    nft = new PausableNft();
    nft.mint(address(this), 7);
    vm.prank(address(ep));
    dep.registerExternalToken(1, address(nft), 7);
  }

  function _send(Batch memory b, uint256 nonce) internal returns (bool ok, bytes memory ret) {
    (ok, ret) = address(dep).call(abi.encodeCall(dep.processBatch, (A, abi.encode(b), abi.encode(A, uint256(0)), nonce)));
  }

  /// A batch whose op fails with an empty reason for a reason unrelated to gas (a paused token): with the gas floor an empty reason
  /// cannot be starvation, so it is a failure of the batch like any other: BatchFailed(0x00000000), nonce spent, nothing moves.
  function test_pausedNftWithdrawalIsABatchFailedWithReasonZero() public {
    Batch memory dp = XlnHanko.emptyBatch();
    dp.externalTokenToReserve = new ExternalTokenToReserve[](1);
    dp.externalTokenToReserve[0] = ExternalTokenToReserve({ entity: A, contractAddress: address(nft), externalTokenId: 7, tokenType: 1, internalTokenId: 1, amount: 1 });
    (bool ok,) = _send(dp, 1);
    assertTrue(ok, "deposit lands");
    assertEq(dep._reserves(A, 1), 1);
    nft.setPaused(true);
    Batch memory wd = XlnHanko.emptyBatch();
    wd.reserveToExternalToken = new ReserveToExternalToken[](1);
    wd.reserveToExternalToken[0] = ReserveToExternalToken({ receivingEntity: bytes32(uint256(uint160(address(0xBEEF)))), tokenId: 1, amount: 1 });
    vm.recordLogs();
    bytes memory ret;
    (ok, ret) = _send(wd, 2);
    Vm.Log[] memory logs = vm.getRecordedLogs();
    assertTrue(ok, "the batch returns");
    assertTrue(XlnHanko.batchFailed(logs), "BatchFailed emitted");
    assertEq(_failureReason(logs), bytes4(0), "with the empty reason");
    assertEq(dep.entityNonces(A), 2, "the nonce is spent");
    assertEq(dep._reserves(A, 1), 1, "nothing moved");
    assertEq(nft.ownerOf(7), address(dep), "the NFT stays in custody");
    // paused forever does not stall the entity: the next batch at nonce 3 lands
    Batch memory next = XlnHanko.emptyBatch();
    (ok,) = _send(next, 3);
    assertTrue(ok);
    assertEq(dep.entityNonces(A), 3);
  }

  function _failureReason(Vm.Log[] memory logs) internal pure returns (bytes4 reason) {
    bytes32 topic = keccak256("BatchFailed(bytes32,uint256,bytes4)");
    for (uint256 i = 0; i < logs.length; i++) {
      if (logs[i].topics[0] == topic) return abi.decode(logs[i].data, (bytes4));
    }
  }
}

contract J5StarveTest is Test {
  Depository dep;
  HeavyEntityProvider ep;
  ERC20Mock erc20;
  bytes32 constant A = bytes32(uint256(1));
  bytes32 constant B = bytes32(uint256(2));

  function setUp() public {
    ep = new HeavyEntityProvider();
    dep = new Depository(address(ep), address(new DeltaTransformer()));
    erc20 = new ERC20Mock("M", "M", 18, 1e30);
    ep.listToken(dep, address(erc20));
    dep.mintToReserve(A, 1, 1000);
    Batch memory b = XlnHanko.emptyBatch();
    b.reserveToCollateral = new ReserveToCollateral[](1);
    EntityAmount[] memory pairs = new EntityAmount[](1);
    pairs[0] = EntityAmount({ entity: B, amount: 100 });
    b.reserveToCollateral[0] = ReserveToCollateral({ tokenId: 1, receivingEntity: A, pairs: pairs });
    _send(b, 1, 0, 15_000_000);
  }

  function _send(Batch memory b, uint256 nonce, uint256, uint256 g) internal returns (bool ok) {
    bytes memory encoded = abi.encode(b);
    (ok,) = address(dep).call{gas: g}(abi.encodeCall(dep.processBatch, (A, encoded, abi.encode(A, uint256(0)), nonce)));
  }

  function _c2r(uint256 burn, bool settlement) internal view returns (bytes memory data) {
    Batch memory b = XlnHanko.emptyBatch();
    bytes memory sig = abi.encode(B, burn);
    if (settlement) {
      b.settlements = new Settlement[](1);
      SettlementDiff[] memory d = new SettlementDiff[](1);
      d[0] = SettlementDiff({ tokenId: 1, leftDiff: SignedAmount(false, 10), rightDiff: SignedAmount(false, 0), collateralDiff: SignedAmount(true, 10), ondeltaDiff: SignedAmount(true, 10) });
      b.settlements[0] = Settlement({ leftEntity: A, rightEntity: B, diffs: d, forgiveDebtsInTokenIds: new uint256[](0), sig: sig, nonce: 1 });
    } else {
      b.collateralToReserve = new CollateralToReserve[](1);
      b.collateralToReserve[0] = CollateralToReserve({ counterparty: B, tokenId: 1, amount: 10, nonce: 1, sig: sig });
    }
    data = abi.encodeCall(dep.processBatch, (A, abi.encode(b), abi.encode(A, uint256(0)), 2));
  }

  function _sweep(bytes memory data, uint256 hi, uint256 step) internal returns (uint256 soft, uint256 landed, uint256 firstSoft, uint256 reverted) {
    for (uint256 g = 60_000; g <= hi; g += step) {
      uint256 snap = vm.snapshotState();
      vm.recordLogs();
      (bool ok,) = address(dep).call{gas: g}(data);
      bool failedSoft = ok && XlnHanko.batchFailed(vm.getRecordedLogs());
      if (failedSoft) { if (soft == 0) firstSoft = g; soft++; }
      else if (ok) landed++;
      else reverted++;
      vm.revertToState(snap);
    }
  }

  function _run(uint256 burn, bool settlement, string memory label) internal {
    bytes memory data = _c2r(burn, settlement);
    uint256 snap0 = vm.snapshotState();
    vm.recordLogs();
    uint256 before = gasleft();
    (bool ok,) = address(dep).call{gas: 15_000_000}(data);
    uint256 used = before - gasleft();
    assertTrue(ok);
    assertFalse(XlnHanko.batchFailed(vm.getRecordedLogs()), "the good batch lands at full gas");
    vm.revertToState(snap0);
    (uint256 soft, uint256 landed, uint256 first, uint256 reverted) = _sweep(data, used + 30_000, 2_000);
    emit log_named_string("case", label);
    emit log_named_uint("  burn (heavy board stand-in)", burn);
    emit log_named_uint("  full gas used", used);
    emit log_named_uint("  soft-fails at some gas limit", soft);
    emit log_named_uint("  first soft-fail gas limit", first);
    emit log_named_uint("  landed", landed);
    emit log_named_uint("  reverted", reverted);
    assertEq(soft, 0, "a good batch was reported as BatchFailed because of the gas the relayer chose");
  }

  function test_c2r_burn0() public { _run(0, false, "c2r"); }
  function test_c2r_burn60k() public { _run(60_000, false, "c2r"); }
  function test_c2r_burn150k() public { _run(150_000, false, "c2r"); }
  function test_c2r_burn400k() public { _run(400_000, false, "c2r"); }
  function test_settlement_burn150k() public { _run(150_000, true, "settlement"); }
  function test_settlement_burn400k() public { _run(400_000, true, "settlement"); }

  /// A failing batch (the counterparty signature names the wrong entity: E4) at every gas limit below the floor never soft-fails: it
  /// reverts and takes no nonce. This is the property the floor buys, for a check that burns 400k, at any depth.
  function test_failingBatchNeverSoftFailsBelowTheFloor() public {
    Batch memory b = XlnHanko.emptyBatch();
    b.collateralToReserve = new CollateralToReserve[](1);
    b.collateralToReserve[0] = CollateralToReserve({ counterparty: B, tokenId: 1, amount: 10, nonce: 1, sig: abi.encode(bytes32(uint256(99)), uint256(400_000)) });
    bytes memory data = abi.encodeCall(dep.processBatch, (A, abi.encode(b), abi.encode(A, uint256(0)), 2));
    uint256 soft;
    uint256 reverted;
    for (uint256 g = 300_000; g <= 15_200_000; g += 100_000) {
      uint256 snap = vm.snapshotState();
      vm.recordLogs();
      (bool ok, bytes memory ret) = address(dep).call{gas: g}(data);
      if (ok && XlnHanko.batchFailed(vm.getRecordedLogs())) soft++;
      else if (!ok) {
        reverted++;
        assertTrue(ret.length == 0 || bytes4(ret) == Depository.BatchGasStarved.selector, "a revert is starvation, never a batch error");
        assertEq(dep.entityNonces(A), 1, "and takes no nonce");
      }
      vm.revertToState(snap);
    }
    assertEq(soft, 0, "a relayer picked a gas limit under the floor and the batch was reported failed");
    assertGt(reverted, 100);
  }

  /// With the whole budget offered the same failing batch is reported: BatchFailed(E4), nonce spent.
  function test_failingBatchAtTheFloorIsReported() public {
    Batch memory b = XlnHanko.emptyBatch();
    b.collateralToReserve = new CollateralToReserve[](1);
    b.collateralToReserve[0] = CollateralToReserve({ counterparty: B, tokenId: 1, amount: 10, nonce: 1, sig: abi.encode(bytes32(uint256(99)), uint256(400_000)) });
    vm.recordLogs();
    (bool ok,) = address(dep).call{gas: 15_600_000}(abi.encodeCall(dep.processBatch, (A, abi.encode(b), abi.encode(A, uint256(0)), 2)));
    Vm.Log[] memory logs = vm.getRecordedLogs();
    assertTrue(ok);
    assertTrue(XlnHanko.batchFailed(logs));
    assertEq(dep.entityNonces(A), 2);
  }
}
