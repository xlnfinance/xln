// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "./EntityTypes.sol";

library HankoVerifier {
  error HankoProofTooLarge();
  error InvalidHankoWeight();
  error InvalidHankoThreshold();
  error DuplicateHankoSigner();
  error DuplicateHankoEntityIndex();
  error DuplicateHankoBoardMember();
  error DuplicateHankoClaimEntity();
  error DuplicateHankoPlaceholder();
  error InvalidHankoClaimOrder();
  error InvalidHankoClaimShape();
  error InvalidHankoFirstMember();
  error InvalidHankoPackedSignatureLength();
  error InvalidHankoPackedSignaturePadding();
  error NonCanonicalHankoPlaceholder();
  error UnusedHankoPlaceholder();
  error UnusedHankoSignature();
  error UnusedHankoClaim();

  uint256 internal constant MAX_HANKO_BYTES = 64 * 1024;
  uint256 internal constant MAX_HANKO_ENTITIES = 256;
  uint256 internal constant MAX_HANKO_CLAIMS = 64;
  uint256 internal constant MAX_HANKO_MEMBERS_PER_CLAIM = 256;
  uint256 internal constant MAX_HANKO_TOTAL_MEMBERS = 1024;
  uint256 private constant SECP256K1_HALF_ORDER =
    0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

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
    uint32 boardChangeDelay;
    uint32 controlChangeDelay;
    uint32 dividendChangeDelay;
  }

  function verify(
    mapping(bytes32 => Entity) storage entities,
    bytes calldata hankoData,
    bytes32 hash,
    bool currentOnly
  ) external view returns (bytes32 entityId, bool success) {
    if (hankoData.length > MAX_HANKO_BYTES) revert HankoProofTooLarge();
    HankoBytes memory hanko = abi.decode(hankoData, (HankoBytes));
    uint256 signatureCount = _signatureCount(hanko.packedSignatures);
    uint256 totalEntities = hanko.placeholders.length + signatureCount + hanko.claims.length;
    _assertShape(hanko, signatureCount, totalEntities);
    if (signatureCount == 0 || hanko.claims.length == 0) return (bytes32(0), false);

    _assertUniquePlaceholders(hanko.placeholders);
    address[] memory signers = _recoverSigners(hash, hanko.placeholders, hanko.packedSignatures, signatureCount);
    if (signers.length != signatureCount) return (bytes32(0), false);
    bool[] memory usedPlaceholders = new bool[](hanko.placeholders.length);
    bool[] memory usedSignatures = new bool[](signatureCount);

    for (uint256 claimIndex = 0; claimIndex < hanko.claims.length; claimIndex++) {
      HankoClaim memory claim = hanko.claims[claimIndex];
      for (uint256 prior = 0; prior < claimIndex; prior++) {
        if (hanko.claims[prior].entityId == claim.entityId) revert DuplicateHankoClaimEntity();
      }
      (bytes32 boardHash, uint256 votingPower) = _evaluateClaim(
        hanko,
        signers,
        claimIndex,
        totalEntities,
        usedPlaceholders,
        usedSignatures
      );
      if (!_boardMatches(entities[claim.entityId], claim.entityId, boardHash, currentOnly)) {
        return (bytes32(0), false);
      }
      if (votingPower < claim.threshold) return (bytes32(0), false);
    }

    _assertMinimalProof(hanko, signatureCount, usedPlaceholders, usedSignatures);
    return (hanko.claims[hanko.claims.length - 1].entityId, true);
  }

  function _assertShape(
    HankoBytes memory hanko,
    uint256 signatureCount,
    uint256 totalEntities
  ) private pure {
    if (
      hanko.claims.length > MAX_HANKO_CLAIMS ||
      totalEntities > MAX_HANKO_ENTITIES ||
      hanko.placeholders.length > MAX_HANKO_ENTITIES ||
      signatureCount > MAX_HANKO_ENTITIES
    ) revert HankoProofTooLarge();
    uint256 totalMembers;
    for (uint256 i = 0; i < hanko.claims.length; i++) {
      uint256 members = hanko.claims[i].entityIndexes.length;
      if (
        members == 0 ||
        members != hanko.claims[i].weights.length ||
        members > MAX_HANKO_MEMBERS_PER_CLAIM
      ) revert InvalidHankoClaimShape();
      totalMembers += members;
      if (totalMembers > MAX_HANKO_TOTAL_MEMBERS) revert HankoProofTooLarge();
    }
  }

  function _signatureCount(bytes memory packed) private pure returns (uint256 count) {
    if (packed.length == 0) return 0;
    count = packed.length * 8 / 513;
    if (count == 0 || count * 64 + (count + 7) / 8 != packed.length) {
      revert InvalidHankoPackedSignatureLength();
    }
    uint256 usedBits = count % 8;
    if (usedBits != 0 && uint8(packed[packed.length - 1]) >> usedBits != 0) {
      revert InvalidHankoPackedSignaturePadding();
    }
  }

  function _assertUniquePlaceholders(bytes32[] memory placeholders) private pure {
    for (uint256 i = 0; i < placeholders.length; i++) {
      for (uint256 j = 0; j < i; j++) {
        if (placeholders[i] == placeholders[j]) revert DuplicateHankoPlaceholder();
      }
    }
  }

  function _recoverSigners(
    bytes32 hash,
    bytes32[] memory placeholders,
    bytes memory packed,
    uint256 count
  ) private pure returns (address[] memory signers) {
    signers = new address[](count);
    uint256 recoveryOffset = count * 64;
    for (uint256 i = 0; i < count; i++) {
      bytes32 r;
      bytes32 s;
      assembly ("memory-safe") {
        let cursor := add(add(packed, 0x20), mul(i, 0x40))
        r := mload(cursor)
        s := mload(add(cursor, 0x20))
      }
      uint8 recoveryByte = uint8(packed[recoveryOffset + i / 8]);
      uint8 v = ((recoveryByte >> (i % 8)) & 1) == 0 ? 27 : 28;
      if (uint256(s) > SECP256K1_HALF_ORDER) return new address[](0);
      address signer = ecrecover(hash, v, r, s);
      if (signer == address(0)) return new address[](0);
      for (uint256 prior = 0; prior < i; prior++) {
        if (signers[prior] == signer) revert DuplicateHankoSigner();
      }
      bytes32 signerId = bytes32(uint256(uint160(signer)));
      for (uint256 j = 0; j < placeholders.length; j++) {
        if (placeholders[j] == signerId) revert NonCanonicalHankoPlaceholder();
      }
      signers[i] = signer;
    }
  }

  function _evaluateClaim(
    HankoBytes memory hanko,
    address[] memory signers,
    uint256 claimIndex,
    uint256 totalEntities,
    bool[] memory usedPlaceholders,
    bool[] memory usedSignatures
  ) private pure returns (bytes32 boardHash, uint256 votingPower) {
    HankoClaim memory claim = hanko.claims[claimIndex];
    uint256 placeholderCount = hanko.placeholders.length;
    uint256 signatureCount = signers.length;
    bytes32[] memory memberIds = new bytes32[](claim.entityIndexes.length);
    uint16[] memory weights = new uint16[](claim.entityIndexes.length);

    for (uint256 i = 0; i < claim.entityIndexes.length; i++) {
      uint256 index = claim.entityIndexes[i];
      if (index >= totalEntities) revert InvalidHankoClaimOrder();
      for (uint256 prior = 0; prior < i; prior++) {
        if (claim.entityIndexes[prior] == index) revert DuplicateHankoEntityIndex();
      }

      bytes32 memberId;
      if (index < placeholderCount) {
        usedPlaceholders[index] = true;
        memberId = hanko.placeholders[index];
        for (uint256 priorClaim = 0; priorClaim < claimIndex; priorClaim++) {
          if (hanko.claims[priorClaim].entityId == memberId) revert NonCanonicalHankoPlaceholder();
        }
      } else if (index < placeholderCount + signatureCount) {
        uint256 signerIndex = index - placeholderCount;
        usedSignatures[signerIndex] = true;
        memberId = bytes32(uint256(uint160(signers[signerIndex])));
        votingPower += claim.weights[i];
      } else {
        uint256 nestedIndex = index - placeholderCount - signatureCount;
        if (nestedIndex >= claimIndex) revert InvalidHankoClaimOrder();
        memberId = hanko.claims[nestedIndex].entityId;
        votingPower += claim.weights[i];
      }

      if (
        i == 0 &&
        (
          index >= placeholderCount + signatureCount ||
          memberId == bytes32(0) ||
          uint256(memberId) > type(uint160).max
        )
      ) revert InvalidHankoFirstMember();
      for (uint256 prior = 0; prior < i; prior++) {
        if (memberIds[prior] == memberId) revert DuplicateHankoBoardMember();
      }
      uint256 weight = claim.weights[i];
      if (weight == 0 || weight > type(uint16).max) revert InvalidHankoWeight();
      memberIds[i] = memberId;
      weights[i] = uint16(weight);
    }
    if (claim.threshold == 0 || claim.threshold > type(uint16).max) revert InvalidHankoThreshold();
    boardHash = keccak256(abi.encode(Board({
      votingThreshold: uint16(claim.threshold),
      entityIds: memberIds,
      votingPowers: weights,
      boardChangeDelay: claim.boardChangeDelay,
      controlChangeDelay: claim.controlChangeDelay,
      dividendChangeDelay: claim.dividendChangeDelay
    })));
  }

  function _boardMatches(
    Entity storage entity,
    bytes32 entityId,
    bytes32 boardHash,
    bool currentOnly
  ) private view returns (bool) {
    if (entity.currentBoardHash == bytes32(0)) return entityId == boardHash;
    if (boardHash == entity.currentBoardHash) return true;
    return
      !currentOnly &&
      boardHash == entity.previousBoardHash &&
      boardHash != bytes32(0) &&
      block.timestamp < entity.previousBoardValidUntil;
  }

  function _assertMinimalProof(
    HankoBytes memory hanko,
    uint256 signatureCount,
    bool[] memory usedPlaceholders,
    bool[] memory usedSignatures
  ) private pure {
    bool[] memory reachable = new bool[](hanko.claims.length);
    reachable[hanko.claims.length - 1] = true;
    uint256 firstClaimIndex = hanko.placeholders.length + signatureCount;
    for (uint256 cursor = hanko.claims.length; cursor > 0; cursor--) {
      uint256 claimIndex = cursor - 1;
      if (!reachable[claimIndex]) continue;
      uint256[] memory indexes = hanko.claims[claimIndex].entityIndexes;
      for (uint256 i = 0; i < indexes.length; i++) {
        if (indexes[i] >= firstClaimIndex) reachable[indexes[i] - firstClaimIndex] = true;
      }
    }
    for (uint256 i = 0; i < reachable.length; i++) {
      if (!reachable[i]) revert UnusedHankoClaim();
    }
    for (uint256 i = 0; i < usedPlaceholders.length; i++) {
      if (!usedPlaceholders[i]) revert UnusedHankoPlaceholder();
    }
    for (uint256 i = 0; i < usedSignatures.length; i++) {
      if (!usedSignatures[i]) revert UnusedHankoSignature();
    }
  }
}
