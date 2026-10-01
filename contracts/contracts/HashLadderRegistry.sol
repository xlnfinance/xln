// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "./Types.sol";
import "./HashLadder.sol";

/// @notice Proof-independent public hash-ladder reveal registry.
/// @dev Linked library calls execute by DELEGATECALL, so writes and events stay
///      in the owning Depository. The outer processBatch Hanko authenticates the
///      revealing Entity. This registry deliberately knows nothing about a
///      dispute, but every record is scoped to one ordered Account participant
///      pair: authenticated writer plus declared counterparty. A first Source
///      write additionally uses only AccountInfo's frozen active clock; no
///      ProofBody, Pull index or transformer authorization enters admission.
///      A signed DeltaTransformer.Pull is the sole authority that later assigns
///      financial meaning to an exact (entity, counterparty, ladder, role) record and
///      validates its timestamp against the active dispute window.
library HashLadderRegistry {
  error E1();
  error E9();

  /// @dev S1: same event and codes as Account.sol (DISPUTE_OP_*, DISPUTE_SKIP_*); a library cannot read its constants, so they repeat here.
  ///      `nonce` carries the witness's fillRatio, the only number a reveal has.
  event DisputeOpSkipped(bytes32 indexed sender, bytes32 indexed counterentity, uint8 op, uint8 reason, uint256 nonce);
  uint8 internal constant DISPUTE_OP_REVEAL = 3;
  uint8 internal constant DISPUTE_SKIP_REVEAL_WINDOW = 9;   // a first Source write with no dispute open or after its owner window
  uint8 internal constant DISPUTE_SKIP_REVEAL_CONFLICT = 10; // a conflicting Source retry, or a lower Target replay

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
    mapping(bytes => AccountInfo) storage accounts,
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
    if (!registration.targetRole && existing == 0) {
      bytes memory accountKey = entityId < registration.counterpartyEntity
        ? abi.encodePacked(entityId, registration.counterpartyEntity)
        : abi.encodePacked(registration.counterpartyEntity, entityId);
      AccountInfo storage account = accounts[accountKey];
      uint32 ownerWindow = entityId < registration.counterpartyEntity
        ? account.leftResponseSeconds
        : account.rightResponseSeconds;
      // A first Source write outside [S,S+W_owner] would permanently consume
      // its single-shot slot. Exact retries bypass this gate below and remain
      // sticky no-ops, while Target retains its refresh semantics.
      // S1: the window closes for good with the dispute, so inside a batch such a write is skipped, not reverted:
      // a revert would pin the entity's nonce under F1 and the write is worthless to this dispute anyway.
      if (
        account.disputeHash == bytes32(0)
        || block.timestamp < account.disputeStartTimestamp
        || block.timestamp > account.disputeStartTimestamp + uint256(ownerWindow)
      ) return _skipped(entityId, registration, DISPUTE_SKIP_REVEAL_WINDOW);
    }
    if (existing != 0) {
      if (!registration.targetRole) {
        // A Source reveal is immutable evidence. Its exact retry is a sticky
        // no-op; a conflicting retry must never replace what watchers saw.
        if (existingRatio == witness.fillRatio) return;
        return _skipped(entityId, registration, DISPUTE_SKIP_REVEAL_CONFLICT);
      }
      // Target is the ported namespace. A lower replay cannot erase progress;
      // equal/higher evidence deliberately refreshes the timestamp so an early
      // port can be republished inside the target dispute's signed window.
      if (witness.fillRatio < existingRatio) return _skipped(entityId, registration, DISPUTE_SKIP_REVEAL_CONFLICT);
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

  function _skipped(bytes32 entityId, HashLadderRegistration memory registration, uint8 reason) private {
    emit DisputeOpSkipped(entityId, registration.counterpartyEntity, DISPUTE_OP_REVEAL, reason, registration.witness.fillRatio);
  }
}
