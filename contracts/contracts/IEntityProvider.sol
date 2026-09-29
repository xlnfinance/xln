// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.24;

interface IEntityProvider {
  function verifyHankoSignature(bytes calldata hankoData, bytes32 hash)
    external
    view
    returns (bytes32 entityId, bool success);

  function verifyCurrentHankoSignature(bytes calldata hankoData, bytes32 hash)
    external
    view
    returns (bytes32 entityId, bool success);

  /// @notice Minimum watchtower appointment sequence an entity still honours.
  function watchtowerMinSequence(bytes32 entityId) external view returns (uint256);
}
