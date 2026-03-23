// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.24;

import "./Types.sol";

/**
 * IDepository
 *
 * Strict production write surface:
 * - processBatch() for entity-authenticated state changes
 * - explicit admin helpers for bootstrap/dev only
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
  /// @dev TESTNET/DEV ONLY admin helper.
  function mintToReserve(bytes32 entity, uint tokenId, uint amount) external;
  /// @dev TESTNET/DEV ONLY admin helper.
  function mintToReserveBatch(ReserveMint[] calldata mints) external;
  function processBatch(
    bytes calldata encodedBatch,
    address entityProviderAddr,
    bytes calldata hankoData,
    uint256 nonce
  ) external returns (bool);
  /// @dev TESTNET/DEV ONLY admin helper. Production user deposits should use processBatch().
  function adminRegisterExternalToken(ExternalTokenToReserve memory params) external;
  function getCollateral(bytes32 leftEntity, bytes32 rightEntity, uint tokenId) external view returns (uint collateral, int ondelta);
}
