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
  error InvalidHankoMemberSignatures();
  error NonCanonicalHankoPlaceholder();
  error UnusedHankoPlaceholder();
  error UnusedHankoSignature();
  error UnusedHankoClaim();

  uint256 internal constant MAX_HANKO_BYTES = 64 * 1024;
  uint256 internal constant MAX_HANKO_ENTITIES = 256;
  uint256 internal constant MAX_HANKO_CLAIMS = 64;
  uint256 internal constant MAX_HANKO_MEMBERS_PER_CLAIM = 256;
  uint256 internal constant MAX_HANKO_TOTAL_MEMBERS = 1024;
  // Contract (ERC-1271) members per proof. Each costs one capped STATICCALL.
  uint256 internal constant MAX_HANKO_MEMBER_SIGNATURES = 8;
  // Enough for software P-256 today and precompile-backed schemes later; the
  // batch submitter pays it, and MAX_HANKO_MEMBER_SIGNATURES bounds the total.
  uint256 internal constant MEMBER_SIGNATURE_GAS_LIMIT = 1_000_000;
  bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;
  uint256 private constant SECP256K1_HALF_ORDER =
    0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

  struct HankoBytes {
    bytes32[] placeholders;
    bytes packedSignatures;
    HankoClaim[] claims;
    // Aligned with placeholders (or empty). A non-empty entry lets the
    // placeholder, which must then be a CONTRACT address, prove its vote via
    // ERC-1271 and count its full weight. Signature agility lives here: smart
    // accounts, P-256/passkey wallets and future post-quantum wrapper contracts
    // join a board with no new EntityProvider and no new identities.
    bytes[] memberSignatures;
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

  /// @notice Verify a Hanko proof.
  /// @dev Two shapes, one model ("everything is an entity, an EOA too"):
  ///      - 65 bytes r||s||v: the EOA's own lazy entity, id = keccak256 of its
  ///        canonical 1-of-1 board. Same result as the full envelope for that
  ///        board at a fraction of the calldata; the common wallet case.
  ///      - abi.encode(HankoBytes): the general recursive proof.
  ///      ERC-1271 validity is contract state; a wallet that rotates its keys
  ///      may stop validating old dispute evidence, exactly like a Safe owner in
  ///      any channel construction. Boards opt in per member.
  function verify(
    mapping(bytes32 => Entity) storage entities,
    bytes calldata hankoData,
    bytes32 hash,
    bool currentOnly
  ) external view returns (bytes32 entityId, bool success) {
    if (hankoData.length > MAX_HANKO_BYTES) revert HankoProofTooLarge();
    if (hankoData.length == 65) {
      address signer = _recoverRaw(hash, hankoData);
      if (signer == address(0)) return (bytes32(0), false);
      entityId = singleSignerEntityId(signer);
      if (!_boardMatches(entities[entityId], entityId, entityId, currentOnly)) return (bytes32(0), false);
      return (entityId, true);
    }
    HankoBytes memory hanko = abi.decode(hankoData, (HankoBytes));
    bytes[] memory memberSignatures = hanko.memberSignatures;
    if (memberSignatures.length != 0 && memberSignatures.length != hanko.placeholders.length) {
      revert InvalidHankoMemberSignatures();
    }
    uint256 signatureCount = _signatureCount(hanko.packedSignatures);
    uint256 totalEntities = hanko.placeholders.length + signatureCount + hanko.claims.length;
    _assertShape(hanko, signatureCount, totalEntities);
    if (hanko.claims.length == 0) return (bytes32(0), false);

    _assertUniquePlaceholders(hanko.placeholders);
    (bool[] memory memberValid, uint256 memberCount, bool membersOk) =
      _validateMemberSignatures(hash, hanko.placeholders, memberSignatures);
    if (!membersOk) return (bytes32(0), false);
    if (signatureCount == 0 && memberCount == 0) return (bytes32(0), false);
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
        memberValid,
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

  /// @notice Lazy entity id of an EOA: keccak256 of its canonical 1-of-1 board.
  function singleSignerEntityId(address signer) internal pure returns (bytes32) {
    bytes32[] memory members = new bytes32[](1);
    members[0] = bytes32(uint256(uint160(signer)));
    uint16[] memory powers = new uint16[](1);
    powers[0] = 1;
    return keccak256(abi.encode(Board({
      votingThreshold: 1,
      entityIds: members,
      votingPowers: powers,
      boardChangeDelay: 0,
      controlChangeDelay: 0,
      dividendChangeDelay: 0
    })));
  }

  /// @dev 65-byte r||s||v (v = 27/28 or 0/1), low-s enforced, zero on failure.
  function _recoverRaw(bytes32 hash, bytes calldata signature) private pure returns (address) {
    bytes32 r = bytes32(signature[0:32]);
    bytes32 s = bytes32(signature[32:64]);
    uint8 v = uint8(signature[64]);
    if (v < 27) v += 27;
    if (v != 27 && v != 28) return address(0);
    if (uint256(s) > SECP256K1_HALF_ORDER) return address(0);
    return ecrecover(hash, v, r, s);
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

  /// @dev A non-empty memberSignatures[i] asserts that placeholder i is a
  /// contract account that validates `hash` under ERC-1271. Verification is a
  /// gas-capped STATICCALL with exactly 32 return bytes; any other outcome fails
  /// the whole proof (soft, like a bad EOA signature). Empty entries keep the
  /// legacy zero-power placeholder semantics.
  function _validateMemberSignatures(
    bytes32 hash,
    bytes32[] memory placeholders,
    bytes[] memory memberSignatures
  ) private view returns (bool[] memory memberValid, uint256 memberCount, bool ok) {
    memberValid = new bool[](placeholders.length);
    if (memberSignatures.length == 0) return (memberValid, 0, true);
    for (uint256 i = 0; i < placeholders.length; i++) {
      bytes memory signature = memberSignatures[i];
      if (signature.length == 0) continue;
      memberCount++;
      if (memberCount > MAX_HANKO_MEMBER_SIGNATURES) revert HankoProofTooLarge();
      uint256 rawId = uint256(placeholders[i]);
      if (rawId == 0 || rawId > type(uint160).max) return (memberValid, memberCount, false);
      address member = address(uint160(rawId));
      if (member.code.length == 0) return (memberValid, memberCount, false);
      bytes memory callData = abi.encodeWithSelector(ERC1271_MAGIC, hash, signature);
      bool callOk;
      uint256 returnSize;
      bytes32 magic;
      uint256 gasLimit = MEMBER_SIGNATURE_GAS_LIMIT;
      assembly ("memory-safe") {
        let data := add(callData, 0x20)
        callOk := staticcall(gasLimit, member, data, mload(callData), data, 0x20)
        returnSize := returndatasize()
        magic := mload(data)
      }
      if (!callOk || returnSize != 32 || magic != bytes32(ERC1271_MAGIC)) {
        return (memberValid, memberCount, false);
      }
      memberValid[i] = true;
    }
    return (memberValid, memberCount, true);
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
    bool[] memory memberValid,
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
        // A contract member that validated `hash` under ERC-1271 votes with
        // its full weight, exactly like a recovered EOA signer.
        if (memberValid[index]) votingPower += claim.weights[i];
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

  /// @dev Historical boards verify dispute evidence only (`currentOnly=false`)
  /// and only until their own expiry. Two slots exist so an emergency rotation
  /// never erases a still-live retired board (see EntityTypes.Entity).
  function _boardMatches(
    Entity storage entity,
    bytes32 entityId,
    bytes32 boardHash,
    bool currentOnly
  ) private view returns (bool) {
    if (entity.currentBoardHash == bytes32(0)) return entityId == boardHash;
    if (boardHash == entity.currentBoardHash) return true;
    if (currentOnly || boardHash == bytes32(0)) return false;
    if (boardHash == entity.previousBoardHash && block.timestamp < entity.previousBoardValidUntil) return true;
    return boardHash == entity.previousBoardHash2 && block.timestamp < entity.previousBoardValidUntil2;
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
