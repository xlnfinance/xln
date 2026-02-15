// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/**
 * Types.sol - Shared type definitions for Depository and Account library
 * Both contracts import this to ensure type compatibility
 */

// ========== ACCOUNT STATE ==========

struct AccountInfo {
  uint nonce;              // Unified nonce: increments on settlement OR dispute start
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

// Per-token state snapshot after settlement (used in AccountSettled event)
struct TokenSettlement {
  uint tokenId;
  uint leftReserve;
  uint rightReserve;
  uint collateral;
  int ondelta;
}

// Per-account settlement result (groups all tokens for one bilateral pair)
struct AccountSettlement {
  bytes32 left;
  bytes32 right;
  TokenSettlement[] tokens;
  uint nonce;  // Post-increment nonce for watcher correlation
}

// ========== DEBT ==========

struct Debt {
  bytes32 creditor;
  uint amount;
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
  uint nonce;              // Unified nonce at time of signing
  bytes32 proofbodyHash;
  bytes sig;
  bytes initialArguments;
}

struct FinalDisputeProof {
  bytes32 counterentity;
  uint initialNonce;       // Nonce when dispute was started
  uint finalNonce;         // Nonce of the counter-proof (must be > initialNonce)
  bytes32 initialProofbodyHash;
  ProofBody finalProofbody;
  bytes finalArguments;
  bytes initialArguments;
  bytes sig;
  bool startedByLeft;
  uint disputeUntilBlock;
  bool cooperative;        // if true, skip timeout (mutual agreement)
}

// ========== BATCH OPERATIONS ==========

struct Settlement {
  bytes32 leftEntity;
  bytes32 rightEntity;
  SettlementDiff[] diffs;
  uint[] forgiveDebtsInTokenIds;
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
  address contractAddress;
  uint96 externalTokenId;
  uint8 tokenType;
  uint internalTokenId;
  uint amount;
}

struct ReserveToExternalToken {
  bytes32 receivingEntity;
  uint tokenId;
  uint amount;
}

struct SecretReveal {
  address transformer;
  bytes32 secret;
}

// C2R shortcut - expands to Settlement on-chain (saves calldata)
// Pure C2R: withdraw `amount` from my share of collateral to my reserve
struct CollateralToReserve {
  bytes32 counterparty;
  uint tokenId;
  uint amount;
  uint nonce;   // signed nonce (must be > stored account nonce)
  bytes sig;    // counterparty hanko (still bilateral)
}

struct Batch {
  Flashloan[] flashloans;
  ReserveToReserve[] reserveToReserve;
  ReserveToCollateral[] reserveToCollateral;
  CollateralToReserve[] collateralToReserve;  // C2R shortcut (expands to Settlement)
  Settlement[] settlements;
  InitialDisputeProof[] disputeStarts;
  FinalDisputeProof[] disputeFinalizations;
  ExternalTokenToReserve[] externalTokenToReserve;
  ReserveToExternalToken[] reserveToExternalToken;
  SecretReveal[] revealSecrets;
  uint hub_id;
}

// ========== ENUMS ==========

enum MessageType {
  CooperativeUpdate,
  DisputeProof,
  FinalDisputeProof,
  CooperativeDisputeProof
}
