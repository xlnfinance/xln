// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {console, Vm, Test} from "forge-std/Test.sol";
import {XlnFixture} from "./helpers/XlnFixture.sol";
import {XlnHanko} from "./helpers/XlnHanko.sol";
import "../../contracts/Types.sol";
import {Depository} from "../../contracts/Depository.sol";
import {DeltaTransformer} from "../../contracts/DeltaTransformer.sol";
import {HeavyEntityProvider} from "./J5Starve.t.sol";

// J5 signed gas budget (PR #54, third round), from the first reviewer's probes at 793e6bc (review/pr-54-793e6bc/J5CapProbe.t.sol) turned into assertions:
//   G3  a callee that burns all its gas (invalid, an endless loop) or reverts, and G4 a callee that returns megabytes of revert data, are all a
//       BatchFailed with the nonce spent, at a transaction that carries only budget * 64/63 + reserve + prelude;
//   F3  a FAILING maximal batch is reported under the EIP-7825 transaction cap (16,777,216) at the budget its signer measured, calldata included;
//   R   the fixed post-call reserve (30,000) is far above what the code after the self-call needs.

uint256 constant TX_GAS_CAP = 16_777_216;
// BATCH_POST_CALL_RESERVE of Depository.sol.
uint256 constant RESERVE = 30_000;

function requirementOf(uint256 budget) pure returns (uint256) { return budget * 64 / 63 + RESERVE; }

/// The code processBatch runs after the self-call returns, copied as it is (the 4-byte reason read and the log), on a self-call that burned
/// everything it was given: what the reserve has to cover.
contract PostCallProbe {
  event BatchFailed(bytes32 indexed entityId, uint256 indexed nonce, bytes4 reason);
  function burn() external pure { assembly { invalid() } }
  function measure(bytes32 entityId, uint256 nonce) external returns (uint256 used) {
    bytes memory call_ = abi.encodeCall(this.burn, ());
    bool applied;
    assembly ("memory-safe") { applied := call(200000, address(), 0, add(call_, 32), mload(call_), 0, 0) }
    uint256 before = gasleft();
    bytes4 reason;
    assembly ("memory-safe") {
      if iszero(applied) {
        mstore(0, 0)
        let size := returndatasize()
        if gt(size, 4) { size := 4 }
        returndatacopy(0, 0, size)
        reason := and(mload(0), shl(224, 0xffffffff))
      }
    }
    if (!applied) emit BatchFailed(entityId, nonce, reason);
    used = before - gasleft();
  }
}

contract J5ReserveTest is Test {
  function test_postCallCodeIsAFractionOfTheReserve() public {
    uint256 used = new PostCallProbe().measure(bytes32(uint256(1)), 7);
    console.log("gas of the code after the self-call (reason read + log):", used);
    assertLt(used, RESERVE / 5, "the reserve is at least five times what the code after the call needs");
  }
}

/// An ERC20 whose transfer can be switched to burn every unit of gas it is given (an upgradeable token gone bad, or a plain `assert(false)` / `invalid`).
contract BurnerToken {
  mapping(address => uint256) public balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;
  function totalSupply() external pure returns (uint256) { return 1000; }
  uint8 public mode; // 0 fine, 1 invalid() on transfer, 2 loop forever, 3 revert(), 4 revert with a reason
  function mint(address to, uint256 a) external { balanceOf[to] += a; }
  function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
  function setMode(uint8 m) external { mode = m; }
  function _burn() internal view {
    if (mode == 1) { assembly { invalid() } }
    if (mode == 2) { while (true) {} }
    if (mode == 3) { revert(); }
    if (mode == 4) { revert("nope"); }
  }
  function transfer(address to, uint256 a) external returns (bool) { _burn(); balanceOf[msg.sender] -= a; balanceOf[to] += a; return true; }
  function transferFrom(address f, address to, uint256 a) external returns (bool) {
    balanceOf[f] -= a; balanceOf[to] += a; return true;
  }
}

contract J5BurnerTest is Test {
  Depository dep;
  HeavyEntityProvider ep;
  BurnerToken tok;
  bytes32 constant A = bytes32(uint256(1));
  uint64 constant BUDGET = 1_000_000;

  function setUp() public {
    ep = new HeavyEntityProvider();
    dep = new Depository(address(ep), address(new DeltaTransformer()));
    tok = new BurnerToken();
    tok.mint(address(this), 1000);
    tok.approve(address(dep), type(uint256).max);
    vm.prank(address(ep));
    dep.registerExternalToken(0, address(tok), 0);
    Batch memory dp = XlnHanko.emptyBatch();
    dp.externalTokenToReserve = new ExternalTokenToReserve[](1);
    dp.externalTokenToReserve[0] = ExternalTokenToReserve({ entity: A, contractAddress: address(tok), externalTokenId: 0, tokenType: 0, internalTokenId: 1, amount: 100 });
    (bool ok,) = address(dep).call{gas: 30_000_000}(abi.encodeCall(dep.processBatch, (A, abi.encode(dp), abi.encode(A, uint256(0)), 1)));
    assertTrue(ok, "deposit lands");
  }

  /// The withdrawal of the (now hostile) token, at the gas the budget alone requires plus 300k of prelude, and at 30M: reported both times.
  function _withdraw(uint8 mode) internal {
    tok.setMode(mode);
    Batch memory wd = XlnHanko.emptyBatch();
    wd.gasBudget = BUDGET;
    wd.reserveToExternalToken = new ReserveToExternalToken[](1);
    wd.reserveToExternalToken[0] = ReserveToExternalToken({ receivingEntity: bytes32(uint256(uint160(address(0xBEEF)))), tokenId: 1, amount: 1 });
    bytes memory data = abi.encodeCall(dep.processBatch, (A, abi.encode(wd), abi.encode(A, uint256(0)), 2));
    uint256[2] memory limits = [requirementOf(BUDGET) + 300_000, 30_000_000];
    for (uint256 i = 0; i < 2; i++) {
      uint256 snap = vm.snapshotState();
      vm.recordLogs();
      (bool ok,) = address(dep).call{gas: limits[i]}(data);
      Vm.Log[] memory logs = vm.getRecordedLogs();
      assertTrue(ok, "the transaction returns");
      assertTrue(XlnHanko.batchFailed(logs), "BatchFailed emitted");
      assertEq(dep.entityNonces(A), 2, "the nonce is spent");
      assertEq(dep._reserves(A, 1), 100, "nothing moved");
      vm.revertToState(snap);
    }
  }

  function test_mode1_invalid() public { _withdraw(1); }
  function test_mode2_endlessLoop() public { _withdraw(2); }
  function test_mode3_emptyRevert() public { _withdraw(3); }
  function test_mode4_reasonRevert() public { _withdraw(4); }
}

/// An NFT whose transferFrom reverts with a chosen amount of return data (a hostile token). NftCustody's high-level call bubbles it.
contract BloatNft {
  mapping(uint256 => address) public ownerOf;
  uint256 public bloat;
  function mint(address to, uint256 id) external { ownerOf[id] = to; }
  function setBloat(uint256 b) external { bloat = b; }
  function totalSupply() external pure returns (uint256) { return 1; }
  function balanceOf(address) external pure returns (uint256) { return 1; }
  function supportsInterface(bytes4) external pure returns (bool) { return true; }
  function getApproved(uint256) external view returns (address) { return msg.sender; }
  function isApprovedForAll(address, address) external pure returns (bool) { return true; }
  function transferFrom(address from, address to, uint256 id) external {
    uint256 b = bloat;
    if (b != 0) { assembly { revert(0, b) } }
    require(ownerOf[id] == from, "owner");
    ownerOf[id] = to;
  }
}

contract J5BloatTest is Test {
  Depository dep;
  HeavyEntityProvider ep;
  BloatNft nft;
  bytes32 constant A = bytes32(uint256(1));

  function setUp() public {
    ep = new HeavyEntityProvider();
    dep = new Depository(address(ep), address(new DeltaTransformer()));
    nft = new BloatNft();
    nft.mint(address(this), 7);
    vm.prank(address(ep));
    dep.registerExternalToken(1, address(nft), 7);
    Batch memory dp = XlnHanko.emptyBatch();
    dp.externalTokenToReserve = new ExternalTokenToReserve[](1);
    dp.externalTokenToReserve[0] = ExternalTokenToReserve({ entity: A, contractAddress: address(nft), externalTokenId: 7, tokenType: 1, internalTokenId: 1, amount: 1 });
    (bool ok,) = address(dep).call(abi.encodeCall(dep.processBatch, (A, abi.encode(dp), abi.encode(A, uint256(0)), 1)));
    assertTrue(ok, "deposit lands");
  }

  /// The withdrawal of the NFT whose transfer reverts with `bloat` bytes. The catch used to copy them all (quadratic memory gas in
  /// processBatch's own frame): 2 MB ran it out of gas, 3 MB reverted BatchGasStarved, and no nonce was taken. Now only the first 4 bytes are read.
  function _withdraw(uint256 bloat, uint64 budget) internal {
    nft.setBloat(bloat);
    Batch memory wd = XlnHanko.emptyBatch();
    wd.gasBudget = budget;
    wd.reserveToExternalToken = new ReserveToExternalToken[](1);
    wd.reserveToExternalToken[0] = ReserveToExternalToken({ receivingEntity: bytes32(uint256(uint160(address(0xBEEF)))), tokenId: 1, amount: 1 });
    vm.recordLogs();
    uint256 before = gasleft();
    (bool ok,) = address(dep).call{gas: requirementOf(budget) + 300_000}(abi.encodeCall(dep.processBatch, (A, abi.encode(wd), abi.encode(A, uint256(0)), 2)));
    uint256 used = before - gasleft();
    Vm.Log[] memory logs = vm.getRecordedLogs();
    console.log("bloat bytes:", bloat);
    console.log("  gas used:", used);
    assertTrue(ok, "the transaction returns");
    assertTrue(XlnHanko.batchFailed(logs), "BatchFailed emitted");
    assertEq(dep.entityNonces(A), 2, "the nonce is spent");
    assertLe(used, budget + 400_000, "the frame above the callee paid for its own work only, not for the payload");
  }
  function test_bloat_0() public { _withdraw(0x20, 1_000_000); }
  function test_bloat_200k() public { _withdraw(200_000, 3_000_000); }
  function test_bloat_1m() public { _withdraw(1_000_000, 5_000_000); }
  function test_bloat_1500k() public { _withdraw(1_500_000, 14_000_000); }
  function test_bloat_2m() public { _withdraw(2_000_000, 20_000_000); }
  function test_bloat_3m() public { _withdraw(3_000_000, 40_000_000); }
}

/// The reviewer's F3 numbers: a maximal batch that FAILS still gets reported under the EIP-7825 cap, at the budget its signer measured.
contract J5CapTest is XlnFixture {
  uint256 internal constant T = 1;
  /// The measured need of the maximal batch is 14,763,601 (BatchBounds.t.sol); a signer adds its margin.
  uint64 internal constant MAX_BATCH_BUDGET = 15_000_000;

  function setUp() public { _deployXln(); }

  function _maxBatch() internal view returns (Batch memory b) {
    uint256[4] memory pairsIn = [uint256(63), 63, 62, 62];
    b = XlnHanko.emptyBatch();
    b.gasBudget = MAX_BATCH_BUDGET;
    b.reserveToCollateral = new ReserveToCollateral[](4);
    for (uint256 i = 0; i < 4; i++) {
      EntityAmount[] memory pairs = new EntityAmount[](pairsIn[i]);
      for (uint256 j = 0; j < pairsIn[i]; j++) pairs[j] = EntityAmount({ entity: keccak256(abi.encodePacked("cp", i, j)), amount: 1 });
      b.reserveToCollateral[i] = ReserveToCollateral({ tokenId: T, receivingEntity: entity[0], pairs: pairs });
    }
  }

  function _intrinsic(bytes memory data) internal pure returns (uint256 g) {
    g = 21_000;
    for (uint256 i = 0; i < data.length; i++) g += data[i] == 0 ? 4 : 16;
  }

  /// @return status 0 landed, 1 BatchFailed, 2 reverted
  function _run(Batch memory b, uint256 gasOffered) internal returns (uint256 status) {
    bytes memory encoded = abi.encode(b);
    uint256 nonce = dep.entityNonces(entity[0]) + 1;
    bytes32 h = XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), entity[0], encoded, nonce);
    bytes memory hanko = _hanko(0, h);
    vm.recordLogs();
    try dep.processBatch{gas: gasOffered}(entity[0], encoded, hanko, nonce) { status = 0; } catch { status = 2; }
    Vm.Log[] memory logs = vm.getRecordedLogs();
    if (XlnHanko.batchFailed(logs)) status = 1;
  }

  function test_failingMaxBatchIsReportedUnderTheTxGasCap() public {
    Batch memory b = _maxBatch();
    bytes memory encoded = abi.encode(b);
    bytes32 h = XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), entity[0], encoded, 1);
    bytes memory cd = abi.encodeCall(dep.processBatch, (entity[0], encoded, _hanko(0, h), 1));
    uint256 intrinsic = _intrinsic(cd);
    console.log("calldata bytes:", cd.length);
    console.log("intrinsic gas:", intrinsic);
    console.log("the requirement of the budget alone:", requirementOf(MAX_BATCH_BUDGET));
    uint256 snap = vm.snapshotState();
    dep.mintToReserve(entity[0], T, 250);
    assertEq(_run(b, 30_000_000), 0, "with the reserve it lands");
    vm.revertToState(snap);
    // one unit short: fails at the end under implicit flash. Offered exactly what the cap leaves after the intrinsic gas, it is reported.
    dep.mintToReserve(entity[0], T, 249);
    assertEq(_run(b, TX_GAS_CAP - intrinsic), 1, "a failing maximal batch is reported at the cap");
    assertEq(dep.entityNonces(entity[0]), 1, "and its nonce is spent");
  }

  function _settlementBatch(uint256 settlements, uint256 diffsPer, uint64 budget) internal view returns (Batch memory b) {
    b = XlnHanko.emptyBatch();
    b.gasBudget = budget;
    b.settlements = new Settlement[](settlements);
    for (uint256 i = 0; i < settlements; i++) {
      SettlementDiff[] memory diffs = new SettlementDiff[](diffsPer);
      for (uint256 j = 0; j < diffsPer; j++) {
        diffs[j] = SettlementDiff({
          tokenId: j + 1,
          leftDiff: SignedAmount(false, 0), rightDiff: SignedAmount(false, 0),
          collateralDiff: SignedAmount(false, 0), ondeltaDiff: SignedAmount(false, 0)
        });
      }
      b.settlements[i] = Settlement({
        leftEntity: entity[0] < entity[1] ? entity[0] : entity[1],
        rightEntity: entity[0] < entity[1] ? entity[1] : entity[0],
        diffs: diffs, forgiveDebtsInTokenIds: new uint256[](0), sig: hex"00", nonce: i + 1
      });
    }
  }

  /// A settlement batch that fails (every settlement carries a bad counterparty signature) with a lot of calldata: the fixed floor could not
  /// report a failing batch with more than about 80 KB of nonzero calldata under the cap (F3 of the first review, F1 of the third pass); a signer
  /// that sets a small budget can. (32 x 32 diffs is 307 KB, over MAX_ENCODED_BATCH_BYTES: E10 before anything else.)
  function _failingSettlementsAtTheCap(uint256 settlements, uint256 diffsPer) internal {
    dep.mintToReserve(entity[0], 1, 1e18);
    Batch memory b = _settlementBatch(settlements, diffsPer, 2_000_000);
    bytes memory encoded = abi.encode(b);
    bytes32 h = XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), entity[0], encoded, 1);
    uint256 intrinsic = _intrinsic(abi.encodeCall(dep.processBatch, (entity[0], encoded, _hanko(0, h), 1)));
    console.log("settlements x diffs:", settlements, diffsPer);
    console.log("calldata bytes:", encoded.length);
    assertEq(_run(b, TX_GAS_CAP - intrinsic), 1, "reported at the cap");
    assertEq(dep.entityNonces(entity[0]), 1);
  }
  function test_failingSettlementBatch8x32IsReportedUnderTheTxGasCap() public { _failingSettlementsAtTheCap(8, 32); }
  function test_failingSettlementBatch4x16IsReportedUnderTheTxGasCap() public { _failingSettlementsAtTheCap(4, 16); }
  function test_failingSettlementBatch16x32IsReportedUnderTheTxGasCap() public { _failingSettlementsAtTheCap(16, 32); }
}
