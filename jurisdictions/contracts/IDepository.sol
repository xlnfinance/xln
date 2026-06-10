// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.24;

import "./Types.sol";

/**
 * IDepository
 *
 * Strict production write surface:
 * - processBatch() for entity-authenticated state changes
 * - local Anvil-only admin helpers for bootstrap/dev only
 */
interface IDepository {
  event ReserveUpdated(bytes32 indexed entity, uint indexed tokenId, uint newBalance);

  struct ReserveMint {
    bytes32 entity;
    uint tokenId;
    uint amount;
  }

  function _reserves(bytes32 entity, uint tokenId) external view returns (uint);
  function getTokensLength() external view returns (uint);
  /// @dev Local Anvil-only admin helper.
  function mintToReserve(bytes32 entity, uint tokenId, uint amount) external;
  function processBatch(
    bytes calldata encodedBatch,
    bytes calldata hankoData,
    uint256 nonce
  ) external returns (bool);
  /// @dev Local Anvil-only admin helper. Production user deposits should use processBatch().
  function adminRegisterExternalToken(ExternalTokenToReserve memory params) external;
}
