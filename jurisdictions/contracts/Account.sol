// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "./Types.sol";
import "./ECDSA.sol";
import "./DeltaTransformer.sol";
import "./IEntityProvider.sol";

/**
 * Account.sol - Library for bilateral account operations
 * EXTERNAL functions execute via DELEGATECALL - bytecode doesn't count toward Depository limit
 * Single entry point: processBatchAccount() for gas efficiency
 */
library Account {

  // ═══════════════════════════════════════════════════════════════════════════
  // CANONICAL J-EVENTS (Single Source of Truth - must match j-event-watcher.ts)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // AccountSettled  - Bilateral account state changed (reserves, collateral, ondelta)
  // ReserveUpdated  - Entity reserve balance changed (also in Depository.sol)
  //
  // Design: One event = One state change. No redundant events.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * @notice Emitted when bilateral account state changes via settlement.
   * @dev THE canonical event for account state. Contains full state for both entities.
   *      j-watcher uses: entity.accounts[counterparty] = { reserves, collateral, ondelta }
   */
  event AccountSettled(Settled[] settled);

  /**
   * @notice Emitted when reserves change during settlement.
   * @dev Mirror of Depository.sol ReserveUpdated - emitted here via DELEGATECALL.
   */
  event ReserveUpdated(bytes32 indexed entity, uint indexed tokenId, uint newBalance);

  // ========== OTHER EVENTS ==========
  event DisputeStarted(bytes32 indexed sender, bytes32 indexed counterentity, uint indexed disputeNonce, bytes32 proofbodyHash, bytes initialArguments);
  event DebtCreated(bytes32 indexed debtor, bytes32 indexed creditor, uint256 indexed tokenId, uint256 amount, uint256 debtIndex);
  event DebtForgiven(bytes32 indexed debtor, bytes32 indexed creditor, uint256 indexed tokenId, uint256 amountForgiven, uint256 debtIndex);
  event InsuranceRegistered(bytes32 indexed insured, bytes32 indexed insurer, uint256 indexed tokenId, uint256 limit, uint256 expiresAt);

  // ========== ERRORS ==========
  error E2(); // Unauthorized
  error E3(); // InsufficientBalance
  error E4(); // InvalidSigner
  error E5(); // NoActiveDispute
  error E6(); // DisputeInProgress
  error E7(); // InvalidParty
  error E8(); // LengthMismatch
  error E9(); // HashMismatch

  // ========== PURE HELPERS ==========

  function accountKey(bytes32 e1, bytes32 e2) external pure returns (bytes memory) {
    return e1 < e2 ? abi.encodePacked(e1, e2) : abi.encodePacked(e2, e1);
  }

  function _accountKey(bytes32 e1, bytes32 e2) internal pure returns (bytes memory) {
    return e1 < e2 ? abi.encodePacked(e1, e2) : abi.encodePacked(e2, e1);
  }

  function packTokenReference(uint8 tokenType, address contractAddress, uint96 externalTokenId) external pure returns (bytes32) {
    return bytes32(uint256(tokenType)) << 248 | bytes32(uint256(uint160(contractAddress))) << 96 | bytes32(uint256(externalTokenId));
  }

  function unpackTokenReference(bytes32 packed) external pure returns (address contractAddress, uint96 externalTokenId, uint8 tokenType) {
    tokenType = uint8(uint256(packed) >> 248);
    contractAddress = address(uint160(uint256(packed) >> 96));
    externalTokenId = uint96(uint256(packed));
  }

  function encodeDisputeHash(
    uint cooperativeNonce, uint disputeNonce, bool startedByLeft,
    uint256 timeout, bytes32 proofbodyHash, bytes memory initialArguments
  ) external pure returns (bytes32) {
    return keccak256(abi.encodePacked(cooperativeNonce, disputeNonce, startedByLeft, timeout, proofbodyHash, keccak256(abi.encodePacked(initialArguments))));
  }

  function _encodeDisputeHash(
    uint cooperativeNonce, uint disputeNonce, bool startedByLeft,
    uint256 timeout, bytes32 proofbodyHash, bytes memory initialArguments
  ) internal pure returns (bytes32) {
    return keccak256(abi.encodePacked(cooperativeNonce, disputeNonce, startedByLeft, timeout, proofbodyHash, keccak256(abi.encodePacked(initialArguments))));
  }

  function computeBatchHankoHash(bytes32 domainSep, uint256 chainId, address depository, bytes memory encodedBatch, uint256 nonce) external pure returns (bytes32) {
    return keccak256(abi.encodePacked(domainSep, chainId, depository, encodedBatch, nonce));
  }

  // ========== SIGNATURE VERIFICATION (pure, for external callers) ==========

  function verifySettlementSig(
    bytes memory ch_key, uint cooperativeNonce, SettlementDiff[] memory diffs,
    uint[] memory forgiveDebtsInTokenIds, InsuranceRegistration[] memory insuranceRegs,
    bytes memory sig, bytes32 expectedSigner
  ) external pure returns (bool) {
    bytes memory encoded_msg = abi.encode(MessageType.CooperativeUpdate, ch_key, cooperativeNonce, diffs, forgiveDebtsInTokenIds, insuranceRegs);
    bytes32 hash = ECDSA.toEthSignedMessageHash(keccak256(encoded_msg));
    return ECDSA.recover(hash, sig) == address(uint160(uint256(expectedSigner)));
  }

  function verifyDisputeProofSig(
    bytes memory ch_key, uint cooperativeNonce, uint disputeNonce,
    bytes32 proofbodyHash, bytes memory sig, bytes32 expectedSigner
  ) external pure returns (bool) {
    bytes memory encoded_msg = abi.encode(MessageType.DisputeProof, ch_key, cooperativeNonce, disputeNonce, proofbodyHash);
    bytes32 hash = ECDSA.toEthSignedMessageHash(keccak256(encoded_msg));
    return ECDSA.recover(hash, sig) == address(uint160(uint256(expectedSigner)));
  }

  /// @notice Verify dispute proof with hanko (entity-level signature)
  /// @param entityProvider EP contract for hanko verification
  /// @param hanko Hanko signature bytes (or 65-byte ECDSA for backwards compat)
  /// @param expectedEntity Expected entity that should have signed
  /// @return success Whether hanko is valid for this entity
  function verifyDisputeProofHanko(
    address entityProvider,
    bytes memory ch_key,
    uint cooperativeNonce,
    uint disputeNonce,
    bytes32 proofbodyHash,
    bytes memory hanko,
    bytes32 expectedEntity
  ) external view returns (bool success) {
    // Backwards compatibility: 65 bytes = single ECDSA signature
    // Treat as entity with 1 validator where entityId == signer address
    if (hanko.length == 65) {
      bytes memory encoded_msg = abi.encode(MessageType.DisputeProof, ch_key, cooperativeNonce, disputeNonce, proofbodyHash);
      bytes32 hash = ECDSA.toEthSignedMessageHash(keccak256(encoded_msg));
      address recovered = ECDSA.recover(hash, hanko);
      return bytes32(uint256(uint160(recovered))) == expectedEntity;
    }

    // Full hanko verification via EntityProvider
    bytes memory encoded_msg = abi.encode(MessageType.DisputeProof, ch_key, cooperativeNonce, disputeNonce, proofbodyHash);
    bytes32 hash = keccak256(encoded_msg);  // NO toEthSignedMessageHash for hanko

    (bytes32 recoveredEntity, bool valid) = IEntityProvider(entityProvider).verifyHankoSignature(hanko, hash);
    return valid && recoveredEntity == expectedEntity;
  }

  function verifyFinalDisputeProofSig(
    bytes memory ch_key, uint finalCooperativeNonce, uint initialDisputeNonce,
    uint finalDisputeNonce, bytes memory sig, bytes32 expectedSigner
  ) external pure returns (bool) {
    bytes memory encoded_msg = abi.encode(MessageType.FinalDisputeProof, ch_key, finalCooperativeNonce, initialDisputeNonce, finalDisputeNonce);
    bytes32 hash = ECDSA.toEthSignedMessageHash(keccak256(encoded_msg));
    return ECDSA.recover(hash, sig) == address(uint160(uint256(expectedSigner)));
  }

  /// @notice Verify final dispute proof with hanko
  function verifyFinalDisputeProofHanko(
    address entityProvider,
    bytes memory ch_key,
    uint finalCooperativeNonce,
    uint initialDisputeNonce,
    uint finalDisputeNonce,
    bytes memory hanko,
    bytes32 expectedEntity
  ) external view returns (bool success) {
    // Backwards compatibility: 65 bytes = single ECDSA
    if (hanko.length == 65) {
      bytes memory encoded_msg = abi.encode(MessageType.FinalDisputeProof, ch_key, finalCooperativeNonce, initialDisputeNonce, finalDisputeNonce);
      bytes32 hash = ECDSA.toEthSignedMessageHash(keccak256(encoded_msg));
      address recovered = ECDSA.recover(hash, hanko);
      return bytes32(uint256(uint160(recovered))) == expectedEntity;
    }

    // Full hanko verification
    bytes memory encoded_msg = abi.encode(MessageType.FinalDisputeProof, ch_key, finalCooperativeNonce, initialDisputeNonce, finalDisputeNonce);
    bytes32 hash = keccak256(encoded_msg);

    (bytes32 recoveredEntity, bool valid) = IEntityProvider(entityProvider).verifyHankoSignature(hanko, hash);
    return valid && recoveredEntity == expectedEntity;
  }

  function verifyCooperativeProofSig(
    bytes memory ch_key, uint cooperativeNonce, bytes32 proofbodyHash,
    bytes32 initialArgumentsHash, bytes memory sig, bytes32 expectedSigner
  ) external pure returns (bool) {
    bytes memory encoded_msg = abi.encode(MessageType.CooperativeDisputeProof, ch_key, cooperativeNonce, proofbodyHash, initialArgumentsHash);
    bytes32 hash = ECDSA.toEthSignedMessageHash(keccak256(encoded_msg));
    return ECDSA.recover(hash, sig) == address(uint160(uint256(expectedSigner)));
  }

  /// @notice Verify cooperative proof with hanko
  function verifyCooperativeProofHanko(
    address entityProvider,
    bytes memory ch_key,
    uint cooperativeNonce,
    bytes32 proofbodyHash,
    bytes32 initialArgumentsHash,
    bytes memory hanko,
    bytes32 expectedEntity
  ) external view returns (bool success) {
    // Backwards compatibility: 65 bytes = single ECDSA
    if (hanko.length == 65) {
      bytes memory encoded_msg = abi.encode(MessageType.CooperativeDisputeProof, ch_key, cooperativeNonce, proofbodyHash, initialArgumentsHash);
      bytes32 hash = ECDSA.toEthSignedMessageHash(keccak256(encoded_msg));
      address recovered = ECDSA.recover(hash, hanko);
      return bytes32(uint256(uint160(recovered))) == expectedEntity;
    }

    // Full hanko verification
    bytes memory encoded_msg = abi.encode(MessageType.CooperativeDisputeProof, ch_key, cooperativeNonce, proofbodyHash, initialArgumentsHash);
    bytes32 hash = keccak256(encoded_msg);

    (bytes32 recoveredEntity, bool valid) = IEntityProvider(entityProvider).verifyHankoSignature(hanko, hash);
    return valid && recoveredEntity == expectedEntity;
  }

  // ========== STORAGE STRUCT (groups mappings to reduce param count) ==========
  // Note: Can't use struct with storage refs in Solidity, so we pass individually

  // ========== ENTRY POINTS (split to avoid stack too deep) ==========

  /// @notice Process settlements - diffs only (debt/insurance handled by Depository)
  function processSettlements(
    mapping(bytes32 => mapping(uint256 => uint256)) storage _reserves,
    mapping(bytes => AccountInfo) storage _accounts,
    mapping(bytes => mapping(uint256 => AccountCollateral)) storage _collaterals,
    bytes32 entityId,
    Settlement[] memory settlements
  ) external returns (bool completeSuccess) {
    completeSuccess = true;
    for (uint i = 0; i < settlements.length; i++) {
      if (!_settleDiffs(_reserves, _accounts, _collaterals, entityId, settlements[i])) {
        completeSuccess = false;
      }
    }
  }

  /// @notice Process dispute starts only
  function processDisputeStarts(
    mapping(bytes => AccountInfo) storage _accounts,
    bytes32 entityId,
    InitialDisputeProof[] memory disputeStarts,
    uint256 defaultDisputeDelay,
    address entityProvider,
    bool testMode
  ) external returns (bool completeSuccess) {
    completeSuccess = true;
    for (uint i = 0; i < disputeStarts.length; i++) {
      if (!_disputeStart(_accounts, entityId, disputeStarts[i], defaultDisputeDelay, entityProvider, testMode)) {
        completeSuccess = false;
      }
    }
  }

  // processDisputeFinalizations removed - stays in Depository due to storage complexity

  // ========== SETTLEMENT (diffs only - debt/insurance handled by Depository) ==========

  function _settleDiffs(
    mapping(bytes32 => mapping(uint256 => uint256)) storage _reserves,
    mapping(bytes => AccountInfo) storage _accounts,
    mapping(bytes => mapping(uint256 => AccountCollateral)) storage _collaterals,
    bytes32 initiator,
    Settlement memory s
  ) internal returns (bool) {
    bytes32 leftEntity = s.leftEntity;
    bytes32 rightEntity = s.rightEntity;
    if (leftEntity == rightEntity || leftEntity >= rightEntity) revert E2();
    if (initiator != leftEntity && initiator != rightEntity) revert E7();

    bytes memory ch_key = _accountKey(leftEntity, rightEntity);
    bytes32 counterparty = (initiator == leftEntity) ? rightEntity : leftEntity;

    // Counterparty MUST sign when there are changes (skip if no signature - test mode)
    if (s.sig.length > 0 && (s.diffs.length > 0 || s.forgiveDebtsInTokenIds.length > 0 || s.insuranceRegs.length > 0)) {
      bytes memory encoded_msg = abi.encode(MessageType.CooperativeUpdate, ch_key, _accounts[ch_key].cooperativeNonce, s.diffs, s.forgiveDebtsInTokenIds, s.insuranceRegs);

      // Hanko verification with backwards compatibility
      if (s.sig.length == 65) {
        // Backwards compat: single ECDSA signature
        bytes32 hash = ECDSA.toEthSignedMessageHash(keccak256(encoded_msg));
        if (ECDSA.recover(hash, s.sig) != address(uint160(uint256(counterparty)))) revert E4();
      } else {
        // Full hanko verification via settlement's EP address
        bytes32 hash = keccak256(encoded_msg);
        (bytes32 recoveredEntity, bool valid) = IEntityProvider(s.entityProvider).verifyHankoSignature(s.sig, hash);
        if (!valid || recoveredEntity != counterparty) revert E4();
      }
    }

    // Apply diffs
    for (uint j = 0; j < s.diffs.length; j++) {
      SettlementDiff memory diff = s.diffs[j];
      uint tokenId = diff.tokenId;
      if (diff.leftDiff + diff.rightDiff + diff.collateralDiff != 0) revert E2();

      if (diff.leftDiff < 0) {
        if (_reserves[leftEntity][tokenId] < uint(-diff.leftDiff)) revert E3();
        _reserves[leftEntity][tokenId] -= uint(-diff.leftDiff);
      } else if (diff.leftDiff > 0) {
        _reserves[leftEntity][tokenId] += uint(diff.leftDiff);
      }

      if (diff.rightDiff < 0) {
        if (_reserves[rightEntity][tokenId] < uint(-diff.rightDiff)) revert E3();
        _reserves[rightEntity][tokenId] -= uint(-diff.rightDiff);
      } else if (diff.rightDiff > 0) {
        _reserves[rightEntity][tokenId] += uint(diff.rightDiff);
      }

      AccountCollateral storage col = _collaterals[ch_key][tokenId];
      if (diff.collateralDiff < 0) {
        if (col.collateral < uint(-diff.collateralDiff)) revert E3();
        col.collateral -= uint(-diff.collateralDiff);
      } else if (diff.collateralDiff > 0) {
        col.collateral += uint(diff.collateralDiff);
      }
      col.ondelta += diff.ondeltaDiff;
    }

    // Emit settled event
    if (s.diffs.length > 0) {
      Settled[] memory settledEvents = new Settled[](s.diffs.length);
      for (uint i = 0; i < s.diffs.length; i++) {
        uint tokenId = s.diffs[i].tokenId;
        AccountCollateral storage col = _collaterals[ch_key][tokenId];
        settledEvents[i] = Settled({
          left: leftEntity, right: rightEntity, tokenId: tokenId,
          leftReserve: _reserves[leftEntity][tokenId],
          rightReserve: _reserves[rightEntity][tokenId],
          collateral: col.collateral, ondelta: col.ondelta
        });
      }
      emit AccountSettled(settledEvents);
    }

    _accounts[ch_key].cooperativeNonce++;
    return true;
  }

  // ========== DISPUTE START ==========

  function _disputeStart(
    mapping(bytes => AccountInfo) storage _accounts,
    bytes32 entityId,
    InitialDisputeProof memory params,
    uint256 defaultDelay,
    address entityProvider,
    bool testMode
  ) internal returns (bool) {
    bytes memory ch_key = _accountKey(entityId, params.counterentity);

    if (_accounts[ch_key].cooperativeNonce > params.cooperativeNonce) revert E2();

    // Verify counterparty signature
    if (testMode) {
      // testMode: signature optional (for demos without entity registration)
      if (params.sig.length > 0) {
        if (params.sig.length == 65) {
          bytes memory encoded_msg = abi.encode(MessageType.DisputeProof, ch_key, params.cooperativeNonce, params.disputeNonce, params.proofbodyHash);
          bytes32 hash = ECDSA.toEthSignedMessageHash(keccak256(encoded_msg));
          if (ECDSA.recover(hash, params.sig) != address(uint160(uint256(params.counterentity)))) revert E4();
        }
        // Skip hanko verification in testMode (entities may not be registered)
      }
    } else {
      // Production: signature REQUIRED
      require(params.sig.length > 0, "Signature required in production");

      // Backwards compat: 65 bytes = ECDSA, otherwise full hanko
      if (params.sig.length == 65) {
        bytes memory encoded_msg = abi.encode(MessageType.DisputeProof, ch_key, params.cooperativeNonce, params.disputeNonce, params.proofbodyHash);
        bytes32 hash = ECDSA.toEthSignedMessageHash(keccak256(encoded_msg));
        if (ECDSA.recover(hash, params.sig) != address(uint160(uint256(params.counterentity)))) revert E4();
      } else {
        bytes memory encoded_msg = abi.encode(MessageType.DisputeProof, ch_key, params.cooperativeNonce, params.disputeNonce, params.proofbodyHash);
        bytes32 hash = keccak256(encoded_msg);
        (bytes32 recoveredEntity, bool valid) = IEntityProvider(entityProvider).verifyHankoSignature(params.sig, hash);
        if (!valid || recoveredEntity != params.counterentity) revert E4();
      }
    }

    if (_accounts[ch_key].disputeHash != bytes32(0)) revert E6();

    uint256 timeout = block.number + defaultDelay;
    _accounts[ch_key].disputeHash = _encodeDisputeHash(
      params.cooperativeNonce, params.disputeNonce, entityId < params.counterentity,
      timeout, params.proofbodyHash, params.initialArguments
    );
    _accounts[ch_key].disputeTimeout = timeout;

    emit DisputeStarted(entityId, params.counterentity, params.disputeNonce, params.proofbodyHash, params.initialArguments);
    return true;
  }

  /**
   * DESIGN DECISION: Dispute finalization stays in Depository.sol
   *
   * Reason: _disputeFinalizeInternal requires deep storage access:
   * - insuranceLines[debtor] storage array
   * - insuranceCursor[debtor] storage uint
   * - _claimFromInsurance which iterates insurance lines
   * - Complex debt/reserve interactions
   *
   * Passing all these via library params causes "stack too deep" compiler errors.
   * Settlement diffs CAN be delegated because they only need _reserves, _accounts, _collaterals.
   */
}
