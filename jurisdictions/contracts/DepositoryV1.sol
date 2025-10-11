// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "hardhat/console.sol";
import "./IDepository.sol";

/**
 * DepositoryV1 - Reference implementation of IDepository interface
 *
 * Self-contained reserve management for simnet/testnet
 * Future: Submit IDepository as ERC for standardization
 *
 * Features:
 * - Bilateral reserve management
 * - Account collateral tracking
 * - Settlement with invariant enforcement
 * - Debug helpers for simulation
 *
 * Note: Implements IDepository interface functions
 */
contract DepositoryV1 {

  // Core state: entity reserves per token
  mapping (bytes32 => mapping (uint => uint)) public _reserves;

  // Account collateral between entity pairs
  mapping (bytes => mapping(uint => ChannelCollateral)) public _collaterals;

  // Token registry
  bytes32[] public _tokens;
  mapping(bytes32 => uint256) public tokenToId;

  // Events
  event ReserveUpdated(bytes32 indexed entity, uint indexed tokenId, uint newBalance);
  event ReserveTransferred(bytes32 indexed from, bytes32 indexed to, uint indexed tokenId, uint amount);
  event SettlementProcessed(
    bytes32 indexed leftEntity,
    bytes32 indexed rightEntity,
    uint indexed tokenId,
    uint leftReserve,
    uint rightReserve,
    uint collateral,
    int ondelta
  );

  struct ChannelCollateral {
    uint collateral;
    int ondelta;
  }

  struct SettlementDiff {
    uint tokenId;
    int leftDiff;
    int rightDiff;
    int collateralDiff;
    int ondeltaDiff;
  }

  constructor() {
    _tokens.push(bytes32(0)); // Index 0 reserved

    // Prefund entities for testing
    debugBulkFundEntities();
  }

  function getTokensLength() public view returns (uint) {
    return _tokens.length;
  }

  // ========== DEBUG FUNCTIONS ==========

  function debugFundReserves(bytes32 entity, uint tokenId, uint amount) public {
    console.log("debugFundReserves: funding entity");
    console.logBytes32(entity);
    console.log("debugFundReserves: tokenId");
    console.logUint(tokenId);
    console.log("debugFundReserves: amount");
    console.logUint(amount);

    _reserves[entity][tokenId] += amount;
    emit ReserveUpdated(entity, tokenId, _reserves[entity][tokenId]);

    console.log("debugFundReserves: new balance");
    console.logUint(_reserves[entity][tokenId]);
  }

  function debugBulkFundEntities() public {
    console.log("debugBulkFundEntities: funding entities 1-500 with USDC and ETH");

    uint256 fundAmount = 100000000000000000000; // 100 units (100e18)

    for (uint256 entityNum = 1; entityNum <= 500; entityNum++) {
      bytes32 entity = bytes32(entityNum);

      // Fund with tokens 1 (USDC), 2 (ETH)
      for (uint256 tokenId = 1; tokenId <= 2; tokenId++) {
        _reserves[entity][tokenId] += fundAmount;
        emit ReserveUpdated(entity, tokenId, _reserves[entity][tokenId]);
      }
    }

    console.log("debugBulkFundEntities: funding complete");
  }

  // ========== RESERVE OPERATIONS ==========

  function reserveToReserve(bytes32 fromEntity, bytes32 toEntity, uint tokenId, uint amount) public returns (bool) {
    require(fromEntity != toEntity, "Cannot transfer to self");
    require(_reserves[fromEntity][tokenId] >= amount, "Insufficient reserves");

    console.log("=== DIRECT R2R TRANSFER ===");
    console.logBytes32(fromEntity);
    console.log("to");
    console.logBytes32(toEntity);
    console.log("amount:");
    console.logUint(amount);

    _reserves[fromEntity][tokenId] -= amount;
    _reserves[toEntity][tokenId] += amount;

    emit ReserveUpdated(fromEntity, tokenId, _reserves[fromEntity][tokenId]);
    emit ReserveUpdated(toEntity, tokenId, _reserves[toEntity][tokenId]);
    emit ReserveTransferred(fromEntity, toEntity, tokenId, amount);

    console.log("=== R2R TRANSFER COMPLETE ===");
    return true;
  }

  // ========== BILATERAL SETTLEMENT ==========

  function settle(bytes32 leftEntity, bytes32 rightEntity, SettlementDiff[] memory diffs) public returns (bool) {
    require(leftEntity != rightEntity, "Cannot settle with self");
    require(leftEntity < rightEntity, "Entities must be in order (left < right)");

    bytes memory ch_key = abi.encodePacked(keccak256(abi.encodePacked(leftEntity, rightEntity)));

    for (uint j = 0; j < diffs.length; j++) {
      SettlementDiff memory diff = diffs[j];
      uint tokenId = diff.tokenId;

      // INVARIANT: leftDiff + rightDiff + collateralDiff == 0
      require(diff.leftDiff + diff.rightDiff + diff.collateralDiff == 0, "Settlement must balance");

      // Update left entity reserves
      if (diff.leftDiff < 0) {
        require(_reserves[leftEntity][tokenId] >= uint(-diff.leftDiff), "Left entity insufficient reserves");
        _reserves[leftEntity][tokenId] -= uint(-diff.leftDiff);
      } else if (diff.leftDiff > 0) {
        _reserves[leftEntity][tokenId] += uint(diff.leftDiff);
      }

      // Update right entity reserves
      if (diff.rightDiff < 0) {
        require(_reserves[rightEntity][tokenId] >= uint(-diff.rightDiff), "Right entity insufficient reserves");
        _reserves[rightEntity][tokenId] -= uint(-diff.rightDiff);
      } else if (diff.rightDiff > 0) {
        _reserves[rightEntity][tokenId] += uint(diff.rightDiff);
      }

      // Update collateral
      ChannelCollateral storage col = _collaterals[ch_key][tokenId];
      if (diff.collateralDiff < 0) {
        require(col.collateral >= uint(-diff.collateralDiff), "Insufficient collateral");
        col.collateral -= uint(-diff.collateralDiff);
      } else if (diff.collateralDiff > 0) {
        col.collateral += uint(diff.collateralDiff);
      }

      // Update ondelta
      col.ondelta += diff.ondeltaDiff;

      // Emit final state
      emit SettlementProcessed(
        leftEntity,
        rightEntity,
        tokenId,
        _reserves[leftEntity][tokenId],
        _reserves[rightEntity][tokenId],
        col.collateral,
        col.ondelta
      );
    }

    return true;
  }

  // ========== ACCOUNT PREFUNDING ==========

  function prefundAccount(bytes32 counterpartyEntity, uint tokenId, uint amount) public returns (bool) {
    bytes32 fundingEntity = bytes32(uint256(uint160(msg.sender)));
    require(fundingEntity != counterpartyEntity, "Cannot prefund account with self");

    bytes32 leftEntity = fundingEntity < counterpartyEntity ? fundingEntity : counterpartyEntity;
    bytes32 rightEntity = fundingEntity < counterpartyEntity ? counterpartyEntity : fundingEntity;

    bytes memory ch_key = abi.encodePacked(keccak256(abi.encodePacked(leftEntity, rightEntity)));

    require(_reserves[fundingEntity][tokenId] >= amount, "Insufficient reserves for prefunding");

    _reserves[fundingEntity][tokenId] -= amount;

    ChannelCollateral storage col = _collaterals[ch_key][tokenId];
    col.collateral += amount;

    emit SettlementProcessed(
      leftEntity,
      rightEntity,
      tokenId,
      _reserves[leftEntity][tokenId],
      _reserves[rightEntity][tokenId],
      col.collateral,
      col.ondelta
    );

    console.log("Account prefunded:");
    console.logBytes32(fundingEntity);
    console.log("funded account with:");
    console.logBytes32(counterpartyEntity);
    console.log("amount:");
    console.logUint(amount);

    return true;
  }

  // ========== COLLATERAL QUERY ==========

  function getCollateral(bytes32 leftEntity, bytes32 rightEntity, uint tokenId) public view returns (uint collateral, int ondelta) {
    require(leftEntity < rightEntity, "Entities must be in order");
    bytes memory ch_key = abi.encodePacked(keccak256(abi.encodePacked(leftEntity, rightEntity)));
    ChannelCollateral storage col = _collaterals[ch_key][tokenId];
    return (col.collateral, col.ondelta);
  }

  // ========== BATCH OPERATIONS (SIMPLIFIED) ==========

  struct ReserveToReserve {
    bytes32 receivingEntity;
    uint tokenId;
    uint amount;
  }

  struct Settlement {
    bytes32 leftEntity;
    bytes32 rightEntity;
    SettlementDiff[] diffs;
  }

  struct Batch {
    ReserveToReserve[] reserveToReserve;
    Settlement[] settlements;
  }

  function processBatch(bytes32 entity, Batch calldata batch) public returns (bool completeSuccess) {
    console.log("=== processBatch ENTRY ===");
    console.logBytes32(entity);

    completeSuccess = true;

    // Process R2R transfers
    for (uint i = 0; i < batch.reserveToReserve.length; i++) {
      ReserveToReserve memory r2r = batch.reserveToReserve[i];
      if (!reserveToReserve(entity, r2r.receivingEntity, r2r.tokenId, r2r.amount)) {
        completeSuccess = false;
      }
    }

    // Process settlements
    for (uint i = 0; i < batch.settlements.length; i++) {
      Settlement memory settlement = batch.settlements[i];
      if (!settle(settlement.leftEntity, settlement.rightEntity, settlement.diffs)) {
        completeSuccess = false;
      }
    }

    return completeSuccess;
  }
}
