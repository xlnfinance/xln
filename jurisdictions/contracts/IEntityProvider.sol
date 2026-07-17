// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.24;

interface IEntityProvider {
  function verifyHankoSignature(bytes calldata hankoData, bytes32 hash)
    external
    view
    returns (bytes32 entityId, bool success);
}
