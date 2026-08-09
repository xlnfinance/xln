// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "./Types.sol";

/// @notice Gas/liveness bounds for one Depository batch.
/// @dev Linked to keep the settlement contract below EIP-170 while retaining
///      fail-loud validation before the first financial mutation.
library DepositoryBounds {
  uint256 private constant MAX_BATCH_FLASHLOANS = 8;
  uint256 private constant MAX_BATCH_RESERVE_TO_RESERVE = 64;
  uint256 private constant MAX_BATCH_RESERVE_TO_COLLATERAL = 64;
  uint256 private constant MAX_BATCH_COLLATERAL_TO_RESERVE = 64;
  uint256 private constant MAX_BATCH_SETTLEMENTS = 32;
  uint256 private constant MAX_BATCH_DISPUTE_STARTS = 8;
  uint256 private constant MAX_BATCH_COUNTER_DISPUTES = 8;
  uint256 private constant MAX_BATCH_DISPUTE_FINALIZATIONS = 1;
  uint256 private constant MAX_BATCH_EXTERNAL_TO_RESERVE = 64;
  uint256 private constant MAX_BATCH_RESERVE_TO_EXTERNAL = 64;
  uint256 private constant MAX_BATCH_SECRET_REVEALS = 32;
  uint256 private constant MAX_BATCH_HASH_LADDER_REGISTRATIONS = 32;
  uint256 private constant MAX_BATCH_TOTAL_OPS = 50;
  uint256 private constant MAX_RESERVE_TO_COLLATERAL_PAIRS = 64;
  uint256 private constant MAX_BATCH_RESERVE_TO_COLLATERAL_PAIRS_TOTAL = 256;

  function assertBatch(Batch memory batch) external pure {
    if (
      batch.flashloans.length +
      batch.reserveToReserve.length +
      batch.reserveToCollateral.length +
      batch.collateralToReserve.length +
      batch.settlements.length +
      batch.disputeStarts.length +
      batch.counterDisputes.length +
      batch.disputeFinalizations.length +
      batch.externalTokenToReserve.length +
      batch.reserveToExternalToken.length +
      batch.revealSecrets.length +
      batch.hashLadderRegistrations.length > MAX_BATCH_TOTAL_OPS
    ) revert E10();

    if (batch.flashloans.length > MAX_BATCH_FLASHLOANS) revert E10();
    if (batch.reserveToReserve.length > MAX_BATCH_RESERVE_TO_RESERVE) revert E10();
    if (batch.reserveToCollateral.length > MAX_BATCH_RESERVE_TO_COLLATERAL) revert E10();
    if (batch.collateralToReserve.length > MAX_BATCH_COLLATERAL_TO_RESERVE) revert E10();
    if (batch.settlements.length > MAX_BATCH_SETTLEMENTS) revert E10();
    if (batch.disputeStarts.length > MAX_BATCH_DISPUTE_STARTS) revert E10();
    if (batch.counterDisputes.length > MAX_BATCH_COUNTER_DISPUTES) revert E10();
    if (batch.disputeFinalizations.length > MAX_BATCH_DISPUTE_FINALIZATIONS) revert E10();
    if (batch.externalTokenToReserve.length > MAX_BATCH_EXTERNAL_TO_RESERVE) revert E10();
    if (batch.reserveToExternalToken.length > MAX_BATCH_RESERVE_TO_EXTERNAL) revert E10();
    if (batch.revealSecrets.length > MAX_BATCH_SECRET_REVEALS) revert E10();
    if (batch.hashLadderRegistrations.length > MAX_BATCH_HASH_LADDER_REGISTRATIONS) revert E10();

    uint256 pairCountTotal;
    for (uint256 i = 0; i < batch.reserveToCollateral.length; i++) {
      uint256 pairCount = batch.reserveToCollateral[i].pairs.length;
      if (pairCount > MAX_RESERVE_TO_COLLATERAL_PAIRS) revert E10();
      pairCountTotal += pairCount;
    }
    if (pairCountTotal > MAX_BATCH_RESERVE_TO_COLLATERAL_PAIRS_TOTAL) revert E10();
  }
}
