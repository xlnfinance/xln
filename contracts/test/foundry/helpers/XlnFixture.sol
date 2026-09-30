// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import "../../../contracts/Depository.sol";
import "../../../contracts/EntityProvider.sol";
import {ERC20Mock} from "../../../contracts/ERC20Mock.sol";
import "../../../contracts/Types.sol";
import {DeltaTransformer} from "../../../contracts/DeltaTransformer.sol";
import {XlnHanko} from "./XlnHanko.sol";
import {Vm} from "forge-std/Vm.sol";

/// @notice Deploys the J-layer under test with N lazy single-signer entities.
abstract contract XlnFixture is Test {
  uint256 internal constant ACTORS = 4;
  uint32 internal constant LEFT_RESPONSE_SECONDS = 60;
  uint32 internal constant RIGHT_RESPONSE_SECONDS = 60;
  uint256 internal constant DISPUTE_WINDOW_SECONDS =
    uint256(LEFT_RESPONSE_SECONDS) + uint256(RIGHT_RESPONSE_SECONDS);

  Depository internal dep;
  EntityProvider internal ep;
  ERC20Mock internal erc20;
  DeltaTransformer internal deltaTransformer;

  uint256[ACTORS] internal pk;
  bytes32[ACTORS] internal entity;
  address[ACTORS] internal signer;

  /// @dev Internal token ids that carry value in this fixture.
  /// tokenId 1 is ERC20-backed; tokenId 2 is mint-only (no external backing),
  /// which keeps a purely internal accounting surface under test.
  uint256 internal constant TOKEN_ERC20 = 1;

  uint256 internal constant FOUNDATION_PK = uint256(keccak256("xln.foundation"));

  function _deployXln() internal {
    ep = new EntityProvider(vm.addr(FOUNDATION_PK));
    deltaTransformer = new DeltaTransformer();
    dep = new Depository(address(ep), address(deltaTransformer));
    vm.prank(vm.addr(FOUNDATION_PK));
    ep.bindShareDepository(address(dep));

    // registerExternalToken requires a non-zero totalSupply and is callable
    // only through the EntityProvider's Foundation lane.
    erc20 = new ERC20Mock("Mock", "MCK", 18, 1e30);
    _listToken(address(erc20));

    for (uint256 i = 0; i < ACTORS; i++) {
      pk[i] = uint256(keccak256(abi.encodePacked("xln.actor", i)));
      signer[i] = vm.addr(pk[i]);
      entity[i] = XlnHanko.lazyEntityId(signer[i]);
    }
  }

  // ── signing ──

  /// @dev Foundation-lane listing of an ERC20 on `dep` (tokenType 0, externalTokenId 0).
  function _listToken(address token) internal returns (uint256 tokenId) {
    bytes32 foundationId = bytes32(uint256(1));
    uint256 nonce = ep.entityActionNonces(foundationId) + 1;
    bytes32 actionHash = ep.computeFoundationActionHash(
      ep.FOUNDATION_REGISTER_TOKEN(),
      keccak256(abi.encode(address(dep), uint8(0), token, uint256(0))),
      nonce
    );
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(FOUNDATION_PK, actionHash);
    return ep.foundationRegisterExternalToken(
      address(dep), 0, token, 0, XlnHanko.encodeSingleSignerHanko(foundationId, v, r, s), nonce
    );
  }

  function _hanko(uint256 actorIndex, bytes32 hash) internal view returns (bytes memory) {
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk[actorIndex], hash);
    return XlnHanko.encodeSingleSignerHanko(entity[actorIndex], v, r, s);
  }

  /// @notice Submit `batch` authorized by actor `actorIndex` at its next nonce.
  function _submit(uint256 actorIndex, Batch memory batch) internal returns (bool) {
    bytes memory encoded = abi.encode(batch);
    uint256 nonce = dep.entityNonces(entity[actorIndex]) + 1;
    bytes32 h = XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), entity[actorIndex], encoded, nonce);
    dep.processBatch(entity[actorIndex], encoded, _hanko(actorIndex, h), nonce);
    return true;
  }

  // ─────────────── J2: a stale or already-applied dispute op is skipped, not reverted ───────────────

  /// @dev DisputeOpSkipped `op` and `reason` codes (Account.sol DISPUTE_OP_* and DISPUTE_SKIP_*).
  uint8 internal constant OP_START = 0;
  uint8 internal constant OP_COUNTER = 1;
  uint8 internal constant OP_FINALIZE = 2;
  uint8 internal constant SKIP_NONCE_NOT_ABOVE_STORED = 0;
  uint8 internal constant SKIP_DISPUTE_ACTIVE = 1;
  uint8 internal constant SKIP_NO_ACTIVE_DISPUTE = 2;
  uint8 internal constant SKIP_DISPUTE_MOVED = 3;
  uint8 internal constant SKIP_WINDOW_CLOSED = 4;
  uint8 internal constant SKIP_COUNTER_NOT_NEWER = 5;
  uint8 internal constant SKIP_COUNTER_SUPERSEDED = 6;
  uint8 internal constant SKIP_COUNTER_REGISTERED = 7;

  /// @dev Everything a skipped dispute op must leave alone on one pair and token.
  struct PairState {
    uint256 nonce;
    bytes32 disputeHash;
    uint256 reserveA;
    uint256 reserveB;
    uint256 collateral;
  }

  function _pairState(bytes32 a, bytes32 b, uint256 tokenId) internal view returns (PairState memory s) {
    bytes memory key = XlnHanko.accountKey(a, b);
    (s.nonce, s.disputeHash, , , , , , , , , , , , , , , ) = dep._accounts(key);
    s.reserveA = dep._reserves(a, tokenId);
    s.reserveB = dep._reserves(b, tokenId);
    (s.collateral,) = dep._collaterals(key, tokenId);
  }

  /// @notice Submit `batch` from actor `actorIndex`, which must land with exactly one DisputeOpSkipped(op, reason, nonce)
  /// naming `peer`, and leave the pair's nonce, dispute hash, both reserves and the collateral unchanged.
  function _submitSkipped(
    uint256 actorIndex, Batch memory batch, bytes32 peer, uint256 tokenId, uint8 op, uint8 reason, uint256 nonce
  ) internal {
    bytes32 me = entity[actorIndex];
    PairState memory before_ = _pairState(me, peer, tokenId);
    vm.recordLogs();
    _submit(actorIndex, batch);
    Vm.Log[] memory logs = vm.getRecordedLogs();
    bytes32 topic = keccak256("DisputeOpSkipped(bytes32,bytes32,uint8,uint8,uint256)");
    uint256 seen;
    for (uint256 i = 0; i < logs.length; i++) {
      if (logs[i].topics[0] != topic) continue;
      seen++;
      assertEq(logs[i].topics[1], me, "skipped op: sender");
      assertEq(logs[i].topics[2], peer, "skipped op: counterentity");
      (uint8 gotOp, uint8 gotReason, uint256 gotNonce) = abi.decode(logs[i].data, (uint8, uint8, uint256));
      assertEq(gotOp, op, "skipped op: kind");
      assertEq(gotReason, reason, "skipped op: reason");
      assertEq(gotNonce, nonce, "skipped op: nonce");
    }
    assertEq(seen, 1, "exactly one DisputeOpSkipped");
    PairState memory after_ = _pairState(me, peer, tokenId);
    assertEq(after_.nonce, before_.nonce, "skipped op: account nonce unchanged");
    assertEq(after_.disputeHash, before_.disputeHash, "skipped op: dispute state unchanged");
    assertEq(after_.reserveA, before_.reserveA, "skipped op: reserve unchanged");
    assertEq(after_.reserveB, before_.reserveB, "skipped op: peer reserve unchanged");
    assertEq(after_.collateral, before_.collateral, "skipped op: collateral unchanged");
  }
}
