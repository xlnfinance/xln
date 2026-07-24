// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "../../../contracts/EntityTypes.sol";
import "../../../contracts/HankoVerifier.sol";
import "../../../contracts/HankoEncoding.sol";
import "../../../contracts/Types.sol";

/// @notice Solidity mirror of test/helpers/hanko.ts.
/// @dev Lazy ("unregistered") entities are the cheapest authorization surface:
///      HankoVerifier._boardMatches accepts `entityId == boardHash` while
///      EntityProvider has no record for the id, so a single EOA key is a full
///      entity without any registration transaction.
library XlnHanko {
  /// @dev keccak256 of the canonical 1-of-1 board. This IS the entity id.
  function lazyEntityId(address signer) internal pure returns (bytes32) {
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

  /// @dev Packs one secp256k1 signature into HankoVerifier's r||s||recoveryBits layout.
  function packSignature(uint8 v, bytes32 r, bytes32 s) internal pure returns (bytes memory) {
    bytes1 recoveryBits = v == 28 ? bytes1(0x01) : bytes1(0x00);
    return abi.encodePacked(r, s, recoveryBits);
  }

  /// @dev Single-signer, single-claim, zero-placeholder hanko over `hash`.
  function encodeSingleSignerHanko(
    bytes32 entityId,
    uint8 v,
    bytes32 r,
    bytes32 s
  ) internal pure returns (bytes memory) {
    uint256[] memory indexes = new uint256[](1);
    indexes[0] = 0; // no placeholders -> index 0 is the first signature
    uint256[] memory weights = new uint256[](1);
    weights[0] = 1;

    HankoVerifier.HankoClaim[] memory claims = new HankoVerifier.HankoClaim[](1);
    claims[0] = HankoVerifier.HankoClaim({
      entityId: entityId,
      entityIndexes: indexes,
      weights: weights,
      threshold: 1,
      boardChangeDelay: 0,
      controlChangeDelay: 0,
      dividendChangeDelay: 0
    });

    return abi.encode(HankoVerifier.HankoBytes({
      placeholders: new bytes32[](0),
      packedSignatures: packSignature(v, r, s),
      claims: claims
    }));
  }

  // ── payload hashes (must match Account.sol / Depository.sol exactly) ──

  function batchHash(
    bytes32 domainSeparator,
    address depository,
    bytes memory encodedBatch,
    uint256 nonce
  ) internal view returns (bytes32) {
    return keccak256(HankoEncoding.encodeBatch(
      domainSeparator, block.chainid, depository, encodedBatch, nonce
    ));
  }

  function cooperativeUpdateHash(
    address depository,
    bytes memory acctKey,
    uint256 nonce,
    SettlementDiff[] memory diffs,
    uint256[] memory forgiveDebtsInTokenIds
  ) internal view returns (bytes32) {
    return keccak256(HankoEncoding.encodeCooperativeUpdate(
      block.chainid, depository, acctKey, nonce, diffs, forgiveDebtsInTokenIds
    ));
  }

  function disputeProofHash(
    address depository,
    bytes memory acctKey,
    uint256 nonce,
    bytes32 proofbodyHash,
    bytes32 watchSeed
  ) internal view returns (bytes32) {
    return keccak256(HankoEncoding.encodeDisputeProof(
      block.chainid, depository, acctKey, nonce, proofbodyHash, watchSeed
    ));
  }

  function cooperativeDisputeProofHash(
    address depository,
    bytes memory acctKey,
    uint256 nonce,
    bytes32 proofbodyHash,
    bytes32 starterInitialArgumentsHash
  ) internal view returns (bytes32) {
    return keccak256(HankoEncoding.encodeCooperativeDisputeProof(
      block.chainid, depository, acctKey, nonce, proofbodyHash, starterInitialArgumentsHash
    ));
  }

  /// @dev Mirrors Account._argumentCommitment.
  function argumentCommitment(
    bytes memory args,
    bool startedByLeft,
    uint256 disputeStartTimestamp
  ) internal pure returns (bytes32) {
    return keccak256(abi.encode(args, startedByLeft, disputeStartTimestamp));
  }

  function accountKey(bytes32 a, bytes32 b) internal pure returns (bytes memory) {
    return a < b ? abi.encodePacked(a, b) : abi.encodePacked(b, a);
  }

  function emptyBatch() internal pure returns (Batch memory batch) {
    batch.flashloans = new Flashloan[](0);
    batch.reserveToReserve = new ReserveToReserve[](0);
    batch.reserveToCollateral = new ReserveToCollateral[](0);
    batch.collateralToReserve = new CollateralToReserve[](0);
    batch.settlements = new Settlement[](0);
    batch.disputeStarts = new InitialDisputeProof[](0);
    batch.disputeFinalizations = new FinalDisputeProof[](0);
    batch.externalTokenToReserve = new ExternalTokenToReserve[](0);
    batch.reserveToExternalToken = new ReserveToExternalToken[](0);
    batch.revealSecrets = new SecretReveal[](0);
  }
}
