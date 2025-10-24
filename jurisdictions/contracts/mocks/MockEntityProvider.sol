// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockEntityProvider {
  bytes32 private immutable entityId;

  constructor(bytes32 _entityId) {
    entityId = _entityId;
  }

  function verifyHankoSignature(bytes calldata, bytes32) external view returns (bytes32, bool) {
    return (entityId, true);
  }
}
