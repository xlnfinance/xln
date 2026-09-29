// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import "../../../contracts/Depository.sol";
import "../../../contracts/EntityProvider.sol";
import {ERC20Mock} from "../../../contracts/ERC20Mock.sol";
import "../../../contracts/Types.sol";
import {DeltaTransformer} from "../../../contracts/DeltaTransformer.sol";
import {XlnHanko} from "./XlnHanko.sol";

/// @notice Deploys the J-layer under test with N lazy single-signer entities.
abstract contract XlnFixture is Test {
  uint256 internal constant ACTORS = 4;
  uint32 internal constant LEFT_RESPONSE_SECONDS = 50;
  uint32 internal constant RIGHT_RESPONSE_SECONDS = 50;
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
    bytes32 h = XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), encoded, nonce);
    dep.processBatch(encoded, _hanko(actorIndex, h), nonce);
    return true;
  }
}
