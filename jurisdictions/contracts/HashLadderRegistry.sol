// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "./Types.sol";
import "./HashLadder.sol";

/// @notice Proof-independent public hash-ladder reveal registry.
/// @dev Linked library calls execute by DELEGATECALL, so writes and events stay
///      in the owning Depository. The owning Depository authenticates the revealing Entity
///      through Source processBatch or standalone Target publication. This registry deliberately knows nothing about a
///      dispute, but every record is scoped to one ordered Account participant
///      pair: authenticated writer plus declared counterparty. The signed Pull
///      alone assigns financial meaning and an absolute reveal deadline. Both
///      namespaces preserve first-seen evidence, including before a dispute.
library HashLadderRegistry {
  error E1();
  error E9();
  error E12();

  event HashLadderRevealRegistered(
    bytes32 indexed entity,
    bytes32 indexed counterpartyEntity,
    bytes32 ladderHash,
    uint16 fillRatio,
    bytes32 fullSecret,
    bytes32[4] reveals,
    bool targetRole,
    uint256 revealedAt
  );

  function getReveal(
    mapping(bytes32 => mapping(bytes32 => mapping(bytes32 => mapping(bool => uint256)))) storage records,
    bytes32 ownerEntity,
    bytes32 counterpartyEntity,
    bytes32 ladderHash,
    bool targetRole
  ) external view returns (uint16 fillRatio, uint256 revealedAt) {
    uint256 packed = records[ownerEntity][counterpartyEntity][ladderHash][targetRole];
    if (packed == 0) return (0, 0);
    return (uint16(packed), packed >> 16);
  }

  function registerReveal(
    mapping(bytes32 => mapping(bytes32 => mapping(bytes32 => mapping(bool => uint256)))) storage records,
    bytes32 entityId,
    HashLadderRegistration memory registration
  ) external {
    HashLadderWitness memory witness = registration.witness;
    if (witness.fillRatio == 0) revert E1();
    if (witness.fillRatio == type(uint16).max) {
      if (!HashLadder.verifyFull(registration.fullHash, witness.fullSecret)) revert E9();
    } else if (!HashLadder.verifyPartial(registration.partialRoot, witness.fillRatio, witness.reveals)) {
      revert E9();
    }

    bytes32 ladderHash = keccak256(abi.encodePacked(registration.fullHash, registration.partialRoot));
    uint256 existing = records[entityId][registration.counterpartyEntity][ladderHash][registration.targetRole];
    uint16 existingRatio = uint16(existing);
    if (existing != 0) {
      // The Source witness is single-shot. Its Target port has the same ratio:
      // exact retries preserve first-seen evidence even after D; conflicting
      // writes must not replace timely evidence with a late timestamp.
      if (existingRatio == witness.fillRatio) return;
      revert E12();
    }

    uint256 revealedAt = block.timestamp;
    records[entityId][registration.counterpartyEntity][ladderHash][registration.targetRole] =
      (revealedAt << 16) | uint256(witness.fillRatio);
    emit HashLadderRevealRegistered(
      entityId,
      registration.counterpartyEntity,
      ladderHash,
      witness.fillRatio,
      witness.fullSecret,
      witness.reveals,
      registration.targetRole,
      revealedAt
    );
  }
}
