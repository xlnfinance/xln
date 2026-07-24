// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import "../../../contracts/Depository.sol";
import "../../../contracts/EntityProvider.sol";
import {ERC20Mock} from "../../../contracts/ERC20Mock.sol";
import "../../../contracts/Types.sol";
import {XlnHanko} from "./XlnHanko.sol";

/// @notice Deploys the J-layer under test with N lazy single-signer entities.
abstract contract XlnFixture is Test {
  uint256 internal constant ACTORS = 4;
  uint256 internal constant DISPUTE_DELAY = 100; // blocks

  Depository internal dep;
  EntityProvider internal ep;
  ERC20Mock internal erc20;

  uint256[ACTORS] internal pk;
  bytes32[ACTORS] internal entity;
  address[ACTORS] internal signer;

  /// @dev Internal token ids that carry value in this fixture.
  /// tokenId 1 is ERC20-backed; tokenId 2 is mint-only (no external backing),
  /// which keeps a purely internal accounting surface under test.
  uint256 internal constant TOKEN_ERC20 = 1;

  function _deployXln() internal {
    ep = new EntityProvider(address(uint160(0xF0)));
    dep = new Depository(address(ep), DISPUTE_DELAY);

    // registerExternalToken requires a non-zero totalSupply.
    erc20 = new ERC20Mock("Mock", "MCK", 18, 1e30);
    dep.registerExternalToken(0 /* TypeERC20 */, address(erc20), 0);

    for (uint256 i = 0; i < ACTORS; i++) {
      pk[i] = uint256(keccak256(abi.encodePacked("xln.actor", i)));
      signer[i] = vm.addr(pk[i]);
      entity[i] = XlnHanko.lazyEntityId(signer[i]);
    }
  }

  // ── signing ──

  function _hanko(uint256 actorIndex, bytes32 hash) internal view returns (bytes memory) {
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk[actorIndex], hash);
    return XlnHanko.encodeSingleSignerHanko(entity[actorIndex], v, r, s);
  }

  /// @notice Submit `batch` authorized by actor `actorIndex` at its next nonce.
  function _submit(uint256 actorIndex, Batch memory batch) internal returns (bool) {
    bytes memory encoded = abi.encode(batch);
    uint256 nonce = dep.entityNonces(entity[actorIndex]) + 1;
    bytes32 h = XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), encoded, nonce);
    return dep.processBatch(encoded, _hanko(actorIndex, h), nonce);
  }
}
