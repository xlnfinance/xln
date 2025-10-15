// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.24;

/**
 * ISubcontractProvider - Standard interface for bilateral logic execution
 *
 * Candidate for ERC standardization (EIP proposal)
 * Defines primitives for programmable delta transformers (HTLCs, swaps, limit orders)
 */
interface ISubcontractProvider {

  // ========== STRUCTS ==========

  struct Batch {
    Payment[] payment;
    Swap[] swap;
  }

  struct Payment {
    uint deltaIndex;
    int amount;
    uint revealedUntilBlock;
    bytes32 hash;
  }

  struct Swap {
    bool ownerIsLeft;
    uint addDeltaIndex;
    uint addAmount;
    uint subDeltaIndex;
    uint subAmount;
  }

  // ========== CORE FUNCTIONS ==========

  /**
   * @notice Apply batch of subcontracts to delta array
   * @param deltas Current delta array
   * @param encodedBatch Encoded batch data
   * @param leftArguments Arguments from left entity
   * @param rightArguments Arguments from right entity
   * @return newDeltas Updated delta array
   */
  function applyBatch(
    int[] memory deltas,
    bytes calldata encodedBatch,
    bytes calldata leftArguments,
    bytes calldata rightArguments
  ) external returns (int[] memory);

  /**
   * @notice Encode batch for off-chain simulation
   * @param b Batch to encode
   * @return Encoded batch bytes
   */
  function encodeBatch(Batch memory b) external pure returns (bytes memory);

  /**
   * @notice Reveal HTLC secret
   * @param secret Secret preimage
   */
  function revealSecret(bytes32 secret) external;

  /**
   * @notice Check if hash was revealed and when
   * @param hash Hash to check
   * @return blockNumber Block when revealed (0 if not revealed)
   */
  function hashToBlock(bytes32 hash) external view returns (uint);
}
