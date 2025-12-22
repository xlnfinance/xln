// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/**
 * Types.sol - Shared type definitions for Depository and Account library
 * Both contracts import this to ensure type compatibility
 */

// ========== ACCOUNT STATE ==========

struct AccountInfo {
  uint cooperativeNonce;
  bytes32 disputeHash;
  uint256 disputeTimeout;
}

struct AccountCollateral {
  uint collateral;
  int ondelta;
}

// ========== SETTLEMENT ==========

struct SettlementDiff {
  uint tokenId;
  int leftDiff;
  int rightDiff;
  int collateralDiff;
  int ondeltaDiff;
}

struct Settled {
  bytes32 left;
  bytes32 right;
  uint tokenId;
  uint leftReserve;
  uint rightReserve;
  uint collateral;
  int ondelta;
}

// ========== DEBT & INSURANCE ==========

struct Debt {
  bytes32 creditor;
  uint amount;
}

struct InsuranceLine {
  bytes32 insurer;
  uint256 tokenId;
  uint256 remaining;
  uint256 expiresAt;
}

struct InsuranceRegistration {
  bytes32 insured;
  bytes32 insurer;
  uint256 tokenId;
  uint256 limit;
  uint256 expiresAt;
}

// ========== TRANSFORMERS (was Subcontracts) ==========

struct Allowance {
  uint deltaIndex;
  uint rightAllowance;
  uint leftAllowance;
}

struct TransformerClause {
  address transformerAddress;
  bytes encodedBatch;
  Allowance[] allowances;
}

struct ProofBody {
  int[] offdeltas;
  uint[] tokenIds;
  TransformerClause[] transformers;
}

// ========== DISPUTE ==========

struct InitialDisputeProof {
  bytes32 counterentity;
  uint cooperativeNonce;
  uint disputeNonce;
  bytes32 proofbodyHash;
  bytes sig;
  bytes initialArguments;
}

struct FinalDisputeProof {
  bytes32 counterentity;
  uint finalCooperativeNonce;
  uint initialDisputeNonce;
  uint finalDisputeNonce;
  bytes32 initialProofbodyHash;
  ProofBody finalProofbody;
  bytes finalArguments;
  bytes initialArguments;
  bytes sig;
  bool startedByLeft;
  uint disputeUntilBlock;
  bool cooperative; // NEW: if true, skip timeout (mutual agreement)
}

// ========== BATCH OPERATIONS ==========

struct Settlement {
  bytes32 leftEntity;
  bytes32 rightEntity;
  SettlementDiff[] diffs;
  uint[] forgiveDebtsInTokenIds;
  InsuranceRegistration[] insuranceRegs;
  bytes sig;
  address entityProvider;
  bytes hankoData;
  uint256 nonce;
}

struct Flashloan {
  uint tokenId;
  uint amount;
}

struct ReserveToReserve {
  bytes32 receivingEntity;
  uint tokenId;
  uint amount;
}

struct ReserveToCollateral {
  uint tokenId;
  bytes32 receivingEntity;
  EntityAmount[] pairs;
}

struct EntityAmount {
  bytes32 entity;
  uint amount;
}

struct ExternalTokenToReserve {
  bytes32 entity; // The entity to credit. If bytes32(0), defaults to msg.sender
  bytes32 packedToken;
  uint internalTokenId;
  uint amount;
}

struct ReserveToExternalToken {
  bytes32 receivingEntity;
  uint tokenId;
  uint amount;
}

struct Batch {
  Flashloan[] flashloans;
  ReserveToReserve[] reserveToReserve;
  ReserveToCollateral[] reserveToCollateral;
  Settlement[] settlements;
  InitialDisputeProof[] disputeStarts;
  FinalDisputeProof[] disputeFinalizations;
  ExternalTokenToReserve[] externalTokenToReserve;
  ReserveToExternalToken[] reserveToExternalToken;
  uint hub_id;
}

// ========== ENUMS ==========

enum MessageType {
  CooperativeUpdate,
  DisputeProof,
  FinalDisputeProof,
  CooperativeDisputeProof
}
