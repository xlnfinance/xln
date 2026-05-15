// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../HashLadder.sol";

contract HashLadderHarness {
  function hashNode(bytes32 node) external pure returns (bytes32) {
    return HashLadder.hashNode(node);
  }

  function nibbleAt(uint16 fillRatio, uint8 index) external pure returns (uint8) {
    return HashLadder.nibbleAt(fillRatio, index);
  }

  function revealForNibble(bytes32 base, uint8 digit) external pure returns (bytes32) {
    return HashLadder.revealForNibble(base, digit);
  }

  function buildCommitment(
    bytes32 fullSecret,
    bytes32[4] calldata nibbleBases
  ) external pure returns (bytes32 fullHash, bytes32 partialRoot) {
    HashLadder.Commitment memory commitment = HashLadder.buildCommitmentCalldata(fullSecret, nibbleBases);
    return (commitment.fullHash, commitment.partialRoot);
  }

  function partialRootFromReveals(
    uint16 fillRatio,
    bytes32[4] calldata reveals
  ) external pure returns (bytes32) {
    return HashLadder.partialRootFromRevealsCalldata(fillRatio, reveals);
  }

  function verifyFull(bytes32 expectedFullHash, bytes32 fullSecret) external pure returns (bool) {
    return HashLadder.verifyFull(expectedFullHash, fullSecret);
  }

  function verifyPartial(
    bytes32 expectedPartialRoot,
    uint16 fillRatio,
    bytes32[4] calldata reveals
  ) external pure returns (bool) {
    return HashLadder.verifyPartialCalldata(expectedPartialRoot, fillRatio, reveals);
  }

  function verify(
    bytes32 expectedFullHash,
    bytes32 expectedPartialRoot,
    uint16 fillRatio,
    bytes32 fullSecret,
    bytes32[4] calldata reveals
  ) external pure returns (bool) {
    HashLadder.Commitment memory commitment = HashLadder.Commitment({
      fullHash: expectedFullHash,
      partialRoot: expectedPartialRoot
    });
    return HashLadder.verifyCalldata(commitment, fillRatio, fullSecret, reveals);
  }
}
