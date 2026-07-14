// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "./Types.sol";

library HankoEncoding {
  function encodeBatch(
    bytes32 domainSeparator,
    uint256 chainId,
    address contractAddress,
    bytes memory encodedBatch,
    uint256 nonce
  ) internal pure returns (bytes memory) {
    return abi.encodePacked(domainSeparator, chainId, contractAddress, encodedBatch, nonce);
  }

  function encodeCooperativeUpdate(
    uint256 chainId,
    address contractAddress,
    bytes memory accountKey,
    uint256 nonce,
    SettlementDiff[] memory diffs,
    uint256[] memory forgiveDebtsInTokenIds
  ) internal pure returns (bytes memory) {
    return abi.encode(
      MessageType.CooperativeUpdate,
      chainId,
      contractAddress,
      accountKey,
      nonce,
      diffs,
      forgiveDebtsInTokenIds
    );
  }

  function encodeDisputeProof(
    uint256 chainId,
    address contractAddress,
    bytes memory accountKey,
    uint256 nonce,
    bytes32 proofbodyHash,
    bytes32 watchSeed
  ) internal pure returns (bytes memory) {
    return abi.encode(
      MessageType.DisputeProof,
      chainId,
      contractAddress,
      accountKey,
      nonce,
      proofbodyHash,
      watchSeed
    );
  }

  function encodeFinalDisputeProof(
    uint256 chainId,
    address contractAddress,
    bytes memory accountKey,
    uint256 finalNonce
  ) internal pure returns (bytes memory) {
    return abi.encode(
      MessageType.FinalDisputeProof,
      chainId,
      contractAddress,
      accountKey,
      finalNonce
    );
  }

  function encodeCooperativeDisputeProof(
    uint256 chainId,
    address contractAddress,
    bytes memory accountKey,
    uint256 nonce,
    bytes32 proofbodyHash,
    bytes32 starterInitialArgumentsHash
  ) internal pure returns (bytes memory) {
    return abi.encode(
      MessageType.CooperativeDisputeProof,
      chainId,
      contractAddress,
      accountKey,
      nonce,
      proofbodyHash,
      starterInitialArgumentsHash
    );
  }

  function encodeWatchtowerCounterDispute(
    bytes32 domainSeparator,
    uint256 chainId,
    address contractAddress,
    address tower,
    bytes32 entityId,
    bytes32 counterentity,
    uint256 finalNonce,
    bytes32 finalProofbodyHash,
    uint256 lastResortWindowBlocks,
    uint256 appointmentSequence
  ) internal pure returns (bytes memory) {
    return abi.encode(
      domainSeparator,
      chainId,
      contractAddress,
      tower,
      entityId,
      counterentity,
      finalNonce,
      finalProofbodyHash,
      lastResortWindowBlocks,
      appointmentSequence
    );
  }

  function encodeEntityTransfer(
    uint256 chainId,
    address contractAddress,
    uint256 entityNumber,
    address to,
    uint256 tokenId,
    uint256 amount,
    uint256 actionNonce
  ) internal pure returns (bytes memory) {
    return abi.encodePacked(
      "ENTITY_TRANSFER",
      chainId,
      contractAddress,
      entityNumber,
      to,
      tokenId,
      amount,
      actionNonce
    );
  }

  function encodeReleaseControlShares(
    uint256 chainId,
    address contractAddress,
    uint256 entityNumber,
    address depository,
    uint256 controlAmount,
    uint256 dividendAmount,
    string memory purpose,
    uint256 actionNonce
  ) internal pure returns (bytes memory) {
    return abi.encodePacked(
      "RELEASE_CONTROL_SHARES",
      chainId,
      contractAddress,
      entityNumber,
      depository,
      controlAmount,
      dividendAmount,
      keccak256(bytes(purpose)),
      actionNonce
    );
  }
}
