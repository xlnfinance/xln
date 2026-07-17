// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "./HankoEncoding.sol";

/// @notice Stateless audit surface for exact cross-language Hanko vectors.
/// @dev Production contracts never call this contract. They call HankoEncoding
///      internally and supply block.chainid + address(this) themselves.
contract HankoCodec {
  function encodeBatchHankoPayloadForDomain(
    bytes32 domainSeparator,
    uint256 chainId,
    address contractAddress,
    bytes memory encodedBatch,
    uint256 nonce
  ) external pure returns (bytes memory) {
    return HankoEncoding.encodeBatch(domainSeparator, chainId, contractAddress, encodedBatch, nonce);
  }

  function computeBatchHankoHashForDomain(
    bytes32 domainSeparator,
    uint256 chainId,
    address contractAddress,
    bytes memory encodedBatch,
    uint256 nonce
  ) external pure returns (bytes32) {
    return keccak256(HankoEncoding.encodeBatch(domainSeparator, chainId, contractAddress, encodedBatch, nonce));
  }

  function encodeCooperativeUpdateHankoPayloadForDomain(
    uint256 chainId,
    address contractAddress,
    bytes memory accountKey,
    uint256 nonce,
    SettlementDiff[] memory diffs,
    uint256[] memory forgiveDebtsInTokenIds
  ) external pure returns (bytes memory) {
    return HankoEncoding.encodeCooperativeUpdate(
      chainId, contractAddress, accountKey, nonce, diffs, forgiveDebtsInTokenIds
    );
  }

  function computeCooperativeUpdateHankoHashForDomain(
    uint256 chainId,
    address contractAddress,
    bytes memory accountKey,
    uint256 nonce,
    SettlementDiff[] memory diffs,
    uint256[] memory forgiveDebtsInTokenIds
  ) external pure returns (bytes32) {
    return keccak256(HankoEncoding.encodeCooperativeUpdate(
      chainId, contractAddress, accountKey, nonce, diffs, forgiveDebtsInTokenIds
    ));
  }

  function encodeDisputeProofHankoPayloadForDomain(
    uint256 chainId,
    address contractAddress,
    bytes memory accountKey,
    uint256 nonce,
    bytes32 proofbodyHash,
    bytes32 watchSeed
  ) external pure returns (bytes memory) {
    return HankoEncoding.encodeDisputeProof(
      chainId, contractAddress, accountKey, nonce, proofbodyHash, watchSeed
    );
  }

  function computeDisputeProofHankoHashForDomain(
    uint256 chainId,
    address contractAddress,
    bytes memory accountKey,
    uint256 nonce,
    bytes32 proofbodyHash,
    bytes32 watchSeed
  ) external pure returns (bytes32) {
    return keccak256(HankoEncoding.encodeDisputeProof(
      chainId, contractAddress, accountKey, nonce, proofbodyHash, watchSeed
    ));
  }

  function encodeFinalDisputeProofHankoPayloadForDomain(
    uint256 chainId,
    address contractAddress,
    bytes memory accountKey,
    uint256 finalNonce
  ) external pure returns (bytes memory) {
    return HankoEncoding.encodeFinalDisputeProof(chainId, contractAddress, accountKey, finalNonce);
  }

  function computeFinalDisputeProofHankoHashForDomain(
    uint256 chainId,
    address contractAddress,
    bytes memory accountKey,
    uint256 finalNonce
  ) external pure returns (bytes32) {
    return keccak256(HankoEncoding.encodeFinalDisputeProof(
      chainId, contractAddress, accountKey, finalNonce
    ));
  }

  function encodeCooperativeDisputeProofHankoPayloadForDomain(
    uint256 chainId,
    address contractAddress,
    bytes memory accountKey,
    uint256 nonce,
    bytes32 proofbodyHash,
    bytes32 starterInitialArgumentsHash
  ) external pure returns (bytes memory) {
    return HankoEncoding.encodeCooperativeDisputeProof(
      chainId, contractAddress, accountKey, nonce, proofbodyHash, starterInitialArgumentsHash
    );
  }

  function computeCooperativeDisputeProofHankoHashForDomain(
    uint256 chainId,
    address contractAddress,
    bytes memory accountKey,
    uint256 nonce,
    bytes32 proofbodyHash,
    bytes32 starterInitialArgumentsHash
  ) external pure returns (bytes32) {
    return keccak256(HankoEncoding.encodeCooperativeDisputeProof(
      chainId, contractAddress, accountKey, nonce, proofbodyHash, starterInitialArgumentsHash
    ));
  }

  function encodeWatchtowerCounterDisputeHankoPayloadForDomain(
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
  ) external pure returns (bytes memory) {
    return HankoEncoding.encodeWatchtowerCounterDispute(
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

  function computeWatchtowerCounterDisputeHankoHashForDomain(
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
  ) external pure returns (bytes32) {
    return keccak256(HankoEncoding.encodeWatchtowerCounterDispute(
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
    ));
  }

  function encodeEntityTransferHankoPayloadForDomain(
    uint256 chainId,
    address contractAddress,
    uint256 entityNumber,
    uint256 boardEpoch,
    address to,
    uint256 tokenId,
    uint256 amount,
    uint256 actionNonce
  ) external pure returns (bytes memory) {
    return HankoEncoding.encodeEntityTransfer(
      chainId, contractAddress, entityNumber, boardEpoch, to, tokenId, amount, actionNonce
    );
  }

  function computeEntityTransferHankoHashForDomain(
    uint256 chainId,
    address contractAddress,
    uint256 entityNumber,
    uint256 boardEpoch,
    address to,
    uint256 tokenId,
    uint256 amount,
    uint256 actionNonce
  ) external pure returns (bytes32) {
    return keccak256(HankoEncoding.encodeEntityTransfer(
      chainId, contractAddress, entityNumber, boardEpoch, to, tokenId, amount, actionNonce
    ));
  }

  function encodeReleaseControlSharesHankoPayloadForDomain(
    uint256 chainId,
    address contractAddress,
    uint256 entityNumber,
    uint256 boardEpoch,
    address depository,
    uint256 controlAmount,
    uint256 dividendAmount,
    string memory purpose,
    uint256 actionNonce
  ) external pure returns (bytes memory) {
    return HankoEncoding.encodeReleaseControlShares(
      chainId,
      contractAddress,
      entityNumber,
      boardEpoch,
      depository,
      controlAmount,
      dividendAmount,
      purpose,
      actionNonce
    );
  }

  function computeReleaseControlSharesHankoHashForDomain(
    uint256 chainId,
    address contractAddress,
    uint256 entityNumber,
    uint256 boardEpoch,
    address depository,
    uint256 controlAmount,
    uint256 dividendAmount,
    string memory purpose,
    uint256 actionNonce
  ) external pure returns (bytes32) {
    return keccak256(HankoEncoding.encodeReleaseControlShares(
      chainId,
      contractAddress,
      entityNumber,
      boardEpoch,
      depository,
      controlAmount,
      dividendAmount,
      purpose,
      actionNonce
    ));
  }

  function encodeCancelEntityProviderActionHankoPayloadForDomain(
    uint256 chainId,
    address contractAddress,
    uint256 entityNumber,
    uint256 boardEpoch,
    uint256 actionNonce,
    bytes32 cancelledActionHash,
    uint8 cancelledActionKind
  ) external pure returns (bytes memory) {
    return HankoEncoding.encodeCancelEntityProviderAction(
      chainId,
      contractAddress,
      entityNumber,
      boardEpoch,
      actionNonce,
      cancelledActionHash,
      cancelledActionKind
    );
  }

  function computeCancelEntityProviderActionHankoHashForDomain(
    uint256 chainId,
    address contractAddress,
    uint256 entityNumber,
    uint256 boardEpoch,
    uint256 actionNonce,
    bytes32 cancelledActionHash,
    uint8 cancelledActionKind
  ) external pure returns (bytes32) {
    return keccak256(HankoEncoding.encodeCancelEntityProviderAction(
      chainId,
      contractAddress,
      entityNumber,
      boardEpoch,
      actionNonce,
      cancelledActionHash,
      cancelledActionKind
    ));
  }

  function encodeBoardProposalHankoPayloadForDomain(
    bytes32 domainSeparator,
    uint256 chainId,
    address contractAddress,
    bytes32 entityId,
    uint256 boardEpoch,
    bytes32 newBoardHash,
    uint8 authority,
    uint256 actionNonce
  ) external pure returns (bytes memory) {
    return HankoEncoding.encodeBoardProposal(
      domainSeparator, chainId, contractAddress, entityId, boardEpoch, newBoardHash, authority, actionNonce
    );
  }

  function computeBoardProposalHankoHashForDomain(
    bytes32 domainSeparator,
    uint256 chainId,
    address contractAddress,
    bytes32 entityId,
    uint256 boardEpoch,
    bytes32 newBoardHash,
    uint8 authority,
    uint256 actionNonce
  ) external pure returns (bytes32) {
    return keccak256(HankoEncoding.encodeBoardProposal(
      domainSeparator, chainId, contractAddress, entityId, boardEpoch, newBoardHash, authority, actionNonce
    ));
  }

  function encodeBoardProposalCancelHankoPayloadForDomain(
    bytes32 domainSeparator,
    uint256 chainId,
    address contractAddress,
    bytes32 entityId,
    uint256 boardEpoch,
    bytes32 proposedBoardHash,
    uint8 proposedBy,
    uint8 cancelledBy,
    uint256 actionNonce
  ) external pure returns (bytes memory) {
    return HankoEncoding.encodeBoardProposalCancel(
      domainSeparator,
      chainId,
      contractAddress,
      entityId,
      boardEpoch,
      proposedBoardHash,
      proposedBy,
      cancelledBy,
      actionNonce
    );
  }

  function computeBoardProposalCancelHankoHashForDomain(
    bytes32 domainSeparator,
    uint256 chainId,
    address contractAddress,
    bytes32 entityId,
    uint256 boardEpoch,
    bytes32 proposedBoardHash,
    uint8 proposedBy,
    uint8 cancelledBy,
    uint256 actionNonce
  ) external pure returns (bytes32) {
    return keccak256(HankoEncoding.encodeBoardProposalCancel(
      domainSeparator,
      chainId,
      contractAddress,
      entityId,
      boardEpoch,
      proposedBoardHash,
      proposedBy,
      cancelledBy,
      actionNonce
    ));
  }
}
