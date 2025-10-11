// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.24;

/**
 * IDepository - Standard interface for bilateral reserve management
 *
 * Candidate for ERC standardization (EIP proposal)
 * Defines primitives for off-chain settlement with on-chain reserves
 */
interface IDepository {

  // ========== EVENTS ==========

  /**
   * @notice Emitted when entity reserves change
   * @param entity Entity identifier (bytes32)
   * @param tokenId Internal token identifier
   * @param newBalance Absolute new balance
   */
  event ReserveUpdated(bytes32 indexed entity, uint indexed tokenId, uint newBalance);

  /**
   * @notice Emitted on R2R transfer
   * @param from Sender entity
   * @param to Recipient entity
   * @param tokenId Token identifier
   * @param amount Transfer amount
   */
  event ReserveTransferred(bytes32 indexed from, bytes32 indexed to, uint indexed tokenId, uint amount);

  /**
   * @notice Emitted on bilateral settlement
   * @param leftEntity First entity (lexicographically lower)
   * @param rightEntity Second entity (lexicographically higher)
   * @param tokenId Token identifier
   * @param leftReserve Final left reserve
   * @param rightReserve Final right reserve
   * @param collateral Final collateral
   * @param ondelta Final ondelta value
   */
  event SettlementProcessed(
    bytes32 indexed leftEntity,
    bytes32 indexed rightEntity,
    uint indexed tokenId,
    uint leftReserve,
    uint rightReserve,
    uint collateral,
    int ondelta
  );

  // ========== CORE FUNCTIONS ==========

  /**
   * @notice Get entity reserves for a token
   * @param entity Entity identifier
   * @param tokenId Token identifier
   * @return Reserve balance
   */
  function _reserves(bytes32 entity, uint tokenId) external view returns (uint);

  /**
   * @notice Get total number of registered tokens
   * @return Token count
   */
  function getTokensLength() external view returns (uint);

  /**
   * @notice Transfer reserves between entities (unilateral)
   * @param from Sender entity
   * @param to Recipient entity
   * @param tokenId Token identifier
   * @param amount Transfer amount
   * @return success Whether transfer succeeded
   */
  function reserveToReserve(bytes32 from, bytes32 to, uint tokenId, uint amount) external returns (bool);

  /**
   * @notice Bilateral settlement between two entities
   * @param leftEntity First entity (must be < rightEntity)
   * @param rightEntity Second entity
   * @param diffs Array of token balance changes
   * @return success Whether settlement succeeded
   */
  function settle(bytes32 leftEntity, bytes32 rightEntity, SettlementDiff[] memory diffs) external returns (bool);

  /**
   * @notice Prefund bilateral account from reserves
   * @param counterpartyEntity Other entity in the account
   * @param tokenId Token identifier
   * @param amount Amount to move from reserves to collateral
   * @return success Whether prefunding succeeded
   */
  function prefundAccount(bytes32 counterpartyEntity, uint tokenId, uint amount) external returns (bool);

  /**
   * @notice Get collateral state for bilateral account
   * @param leftEntity First entity (must be < rightEntity)
   * @param rightEntity Second entity
   * @param tokenId Token identifier
   * @return collateral Total locked collateral
   * @return ondelta Ondelta value (left perspective)
   */
  function getCollateral(bytes32 leftEntity, bytes32 rightEntity, uint tokenId) external view returns (uint collateral, int ondelta);

  // ========== STRUCTS ==========

  struct SettlementDiff {
    uint tokenId;
    int leftDiff;        // Change for left entity reserves
    int rightDiff;       // Change for right entity reserves
    int collateralDiff;  // Change in locked collateral
    int ondeltaDiff;     // Change in ondelta value
    // INVARIANT: leftDiff + rightDiff + collateralDiff == 0
  }
}
