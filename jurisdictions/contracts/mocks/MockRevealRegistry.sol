// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../DeltaTransformer.sol";

/// @notice Test stand-in for the Depository reveal registry. Forwards
/// applyBatch so msg.sender inside the transformer is a registry-backed
/// contract, and lets tests set arbitrary (entity, ladderHash) records.
contract MockRevealRegistry is IHashLadderRevealRegistry {
  mapping(bytes32 => mapping(bytes32 => uint256)) public packed;

  function getHashLadderReveal(bytes32 entity, bytes32 ladderHash)
    external
    view
    returns (uint16 fillRatio, uint256 revealedAt)
  {
    uint256 record = packed[entity][ladderHash];
    return (uint16(record), record >> 16);
  }

  function setReveal(bytes32 entity, bytes32 ladderHash, uint16 fillRatio, uint256 revealedAt) external {
    packed[entity][ladderHash] = (revealedAt << 16) | uint256(fillRatio);
  }

  function applyBatchViaRegistry(
    DeltaTransformer transformer,
    int[] calldata deltas,
    uint[] calldata tokenIds,
    bytes calldata encodedBatch,
    bytes calldata leftArguments,
    bytes calldata rightArguments,
    uint leftArgumentsTimestamp,
    uint rightArgumentsTimestamp,
    bytes32 leftEntity,
    bytes32 rightEntity,
    uint256 disputeStartTimestamp,
    uint256 disputeTimeout
  ) external view returns (int[] memory) {
    return transformer.applyBatch(
      deltas,
      tokenIds,
      encodedBatch,
      leftArguments,
      rightArguments,
      leftArgumentsTimestamp,
      rightArgumentsTimestamp,
      leftEntity,
      rightEntity,
      disputeStartTimestamp,
      disputeTimeout
    );
  }
}
