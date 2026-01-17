// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.24;

/**
 * IEntityProvider - Standard interface for entity governance and verification
 *
 * Candidate for ERC standardization (EIP proposal)
 * Defines primitives for ephemeral entities, Hanko signatures, and hierarchical governance
 */
interface IEntityProvider {

  // ========== STRUCTS ==========

  struct Entity {
    bytes32 currentBoardHash;
    bytes32 proposedBoardHash;
    uint256 activateAtBlock;
    uint256 registrationBlock;
    ProposerType proposerType;
    bytes32 articlesHash;
  }

  struct Board {
    uint16 votingThreshold;
    bytes32[] entityIds;
    uint16[] votingPowers;
    uint32 boardChangeDelay;
    uint32 controlChangeDelay;
    uint32 dividendChangeDelay;
  }

  struct EntityArticles {
    uint32 controlDelay;
    uint32 dividendDelay;
    uint32 foundationDelay;
    uint16 controlThreshold;
  }

  enum ProposerType { BOARD, CONTROL, DIVIDEND }

  struct HankoBytes {
    bytes32[] placeholders;
    bytes packedSignatures;
    HankoClaim[] claims;
  }

  struct HankoClaim {
    bytes32 entityId;
    uint256[] entityIndexes;
    uint256[] weights;
    uint256 threshold;
  }

  // ========== EVENTS ==========

  event EntityRegistered(bytes32 indexed entityId, uint256 indexed entityNumber, bytes32 boardHash);
  event BoardProposed(bytes32 indexed entityId, bytes32 proposedBoardHash);
  event BoardActivated(bytes32 indexed entityId, bytes32 newBoardHash);
  event HankoVerified(bytes32 indexed entityId, bytes32 indexed hash);

  // ========== CORE FUNCTIONS ==========

  /**
   * @notice Register a new entity with board and articles
   * @param board Board configuration
   * @param articles Governance articles
   * @return entityId The registered entity ID
   */
  function registerEntity(Board calldata board, EntityArticles calldata articles) external returns (bytes32);

  /**
   * @notice Get entity details
   * @param entityId Entity identifier
   * @return Entity data
   */
  function getEntity(bytes32 entityId) external view returns (Entity memory);

  /**
   * @notice Verify Hanko signature (ephemeral entity verification)
   * @param hankoData Encoded Hanko signature data
   * @param hash Hash that was signed
   * @return entityId Recovered entity ID
   * @return success Whether verification succeeded
   */
  function verifyHankoSignature(bytes calldata hankoData, bytes32 hash) external returns (bytes32, bool);

  /**
   * @notice Recover entity from encoded board and signature
   * @param encodedBoard Board data
   * @param encodedSignature Signature data
   * @param hash Hash to verify
   * @return entityId Entity ID (0 if invalid)
   */
  function recoverEntity(bytes calldata encodedBoard, bytes calldata encodedSignature, bytes32 hash) external view returns (uint256);

  /**
   * @notice Propose new board for entity
   * @param entityId Entity to update
   * @param newBoard New board configuration
   * @param articles Entity articles (for verification)
   * @param proposerType Type of proposer (BOARD/CONTROL/DIVIDEND)
   */
  function proposeNewBoard(bytes32 entityId, Board calldata newBoard, EntityArticles calldata articles, ProposerType proposerType) external;

  /**
   * @notice Activate proposed board after delay
   * @param entityId Entity to update
   */
  function activateBoard(bytes32 entityId) external;
}
