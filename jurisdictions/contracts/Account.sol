// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "./Types.sol";
import "./DeltaTransformer.sol";
import "./IEntityProvider.sol";

/**
 * Account.sol - Library for bilateral account operations
 * EXTERNAL functions execute via DELEGATECALL - bytecode doesn't count toward Depository limit
 *
 * NONCE MODEL (unified, non-sequential):
 *   All state-authorizing signatures include a nonce.
 *   Contract checks: signedNonce > storedNonce (strictly greater).
 *   On success: storedNonce = signedNonce (not +1).
 *   Jumps like 10 → 15 → 234 are valid. Replays fail automatically.
 */
library Account {

  // ═══════════════════════════════════════════════════════════════════════════
  // CANONICAL J-EVENTS (Single Source of Truth - must match j-event-watcher.ts)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * @notice Emitted when bilateral account state changes via settlement.
   * @dev Unionified: one entry per account pair, multiple tokens inside.
   *      Includes post-update nonce for watcher correlation.
   */
  event AccountSettled(AccountSettlement[] settled);

  /**
   * @notice Emitted when reserves change during settlement.
   * @dev Mirror of Depository.sol ReserveUpdated - emitted here via DELEGATECALL.
   */
  event ReserveUpdated(bytes32 indexed entity, uint indexed tokenId, uint newBalance);

  // ========== OTHER EVENTS ==========
  event DisputeStarted(
    bytes32 indexed sender,
    bytes32 indexed counterentity,
    uint indexed nonce,
    bytes32 proofbodyHash,
    bytes32 watchSeed,
    bytes starterInitialArguments,
    bytes starterIncrementedArguments
  );
  event DebtCreated(bytes32 indexed debtor, bytes32 indexed creditor, uint256 indexed tokenId, uint256 amount, uint256 debtIndex);
  event DebtForgiven(bytes32 indexed debtor, bytes32 indexed creditor, uint256 indexed tokenId, uint256 amountForgiven, uint256 debtIndex);

  // ========== ERRORS ==========
  error E2(); // Unauthorized / StaleNonce
  error E3(); // InsufficientBalance
  error E4(); // InvalidSigner
  error E5(); // NoActiveDispute / VirginAccount
  error E6(); // DisputeInProgress
  error E7(); // InvalidParty
  error E8(); // LengthMismatch
  error E9(); // HashMismatch
  error E10(); // BatchTooLarge

  uint256 private constant MAX_SETTLEMENT_DIFFS = 32;
  uint256 private constant MAX_SETTLEMENT_FORGIVENESS_IDS = 32;

  // ========== PURE HELPERS ==========

  function accountKey(bytes32 e1, bytes32 e2) external pure returns (bytes memory) {
    return e1 < e2 ? abi.encodePacked(e1, e2) : abi.encodePacked(e2, e1);
  }

  function _accountKey(bytes32 e1, bytes32 e2) internal pure returns (bytes memory) {
    return e1 < e2 ? abi.encodePacked(e1, e2) : abi.encodePacked(e2, e1);
  }

  function encodeDisputeHash(
    uint nonce, bool startedByLeft,
    uint256 timeout,
    bytes32 proofbodyHash,
    bytes memory starterInitialArguments,
    bytes memory starterIncrementedArguments
  ) external pure returns (bytes32) {
    return _encodeDisputeHash(
      nonce,
      startedByLeft,
      timeout,
      proofbodyHash,
      starterInitialArguments,
      starterIncrementedArguments
    );
  }

  function _encodeDisputeHash(
    uint nonce, bool startedByLeft,
    uint256 timeout,
    bytes32 proofbodyHash,
    bytes memory starterInitialArguments,
    bytes memory starterIncrementedArguments
  ) internal pure returns (bytes32) {
    // Current dispute binding:
    // - proofbodyHash binds the signed state at nonce N.
    // - starterInitialArguments binds the starter's calldata for N.
    // - starterIncrementedArguments binds the starter's calldata for one
    //   already-signed newer proof that the counterparty may reveal.
    //
    // Do not replace the incremented bytes with a hash unless the protocol also
    // adds another reveal tx. The current dispute flow is intentionally two txs:
    // start dispute, then finalize/counter-finalize. The bytes are committed by
    // hash here, then later byte-matched in requireStarterArguments.
    //
    // Do not rebuild these arguments from live runtime state on-chain or
    // off-chain. A maker can have fills applied/deleted between nonce N and
    // dispute start; pairing live arguments with an old proofbodyHash would
    // settle the wrong positional swap/pull slots.
    //
    // The runtime may run a local "prepare dispute" cooldown before calling
    // this path: cancel book exposure, collect HTLC secrets, then freeze the
    // exact bytes. Solidity intentionally does not know that lifecycle; adding
    // order IDs, pull IDs, or readiness checks here would duplicate runtime
    // state and make dispute gas depend on off-chain bookkeeping.
    return keccak256(abi.encodePacked(
      nonce,
      startedByLeft,
      timeout,
      proofbodyHash,
      keccak256(starterInitialArguments),
      keccak256(starterIncrementedArguments)
    ));
  }

  function requireStarterArguments(
    bool startedByLeft,
    bytes memory leftArguments,
    bytes memory rightArguments,
    bytes memory expectedStarterArguments
  ) external pure {
    // Finalization uses explicit left/right calldata. The starter side must
    // equal the blob committed at disputeStart; only the non-starter side is
    // free to provide fresh evidence at finalize time.
    //
    // This checks byte identity, not semantic validity. Invalid transformer
    // evidence is handled downstream as "no evidence" so one party cannot DoS
    // finalization with malformed optional args. Signed state, nonces, and
    // proofbody hashes remain strict.
    bytes32 expected = keccak256(expectedStarterArguments);
    bytes32 actual = startedByLeft ? keccak256(leftArguments) : keccak256(rightArguments);
    if (actual != expected) revert E9();
  }

  function computeBatchHankoHash(bytes32 domainSep, uint256 chainId, address depository, bytes memory encodedBatch, uint256 nonce) external pure returns (bytes32) {
    return keccak256(abi.encodePacked(domainSep, chainId, depository, encodedBatch, nonce));
  }

  // ========== HANKO VERIFICATION ==========

  /// @notice Verify dispute proof with hanko (entity-level signature)
  function verifyDisputeProofHanko(
    address entityProvider,
    address depository,
    bytes memory acct_key,
    uint nonce,
    bytes32 proofbodyHash,
    bytes32 watchSeed,
    bytes memory hanko,
    bytes32 expectedEntity
  ) external returns (bool success) {
    bytes memory encoded_msg = abi.encode(MessageType.DisputeProof, depository, acct_key, nonce, proofbodyHash, watchSeed);
    bytes32 hash = keccak256(encoded_msg);
    (bytes32 recoveredEntity, bool valid) = IEntityProvider(entityProvider).verifyHankoSignature(hanko, hash);
    return valid && recoveredEntity == expectedEntity;
  }

  /// @notice Verify final dispute proof with hanko (counter-dispute)
  function verifyFinalDisputeProofHanko(
    address entityProvider,
    address depository,
    bytes memory acct_key,
    uint finalNonce,
    bytes memory hanko,
    bytes32 expectedEntity
  ) external returns (bool success) {
    bytes memory encoded_msg = abi.encode(MessageType.FinalDisputeProof, depository, acct_key, finalNonce);
    bytes32 hash = keccak256(encoded_msg);
    (bytes32 recoveredEntity, bool valid) = IEntityProvider(entityProvider).verifyHankoSignature(hanko, hash);
    return valid && recoveredEntity == expectedEntity;
  }

  /// @notice Verify cooperative proof with hanko
  function verifyCooperativeProofHanko(
    address entityProvider,
    address depository,
    bytes memory acct_key,
    uint nonce,
    bytes32 proofbodyHash,
    bytes32 starterInitialArgumentsHash,
    bytes memory hanko,
    bytes32 expectedEntity
  ) external returns (bool success) {
    bytes memory encoded_msg = abi.encode(MessageType.CooperativeDisputeProof, depository, acct_key, nonce, proofbodyHash, starterInitialArgumentsHash);
    bytes32 hash = keccak256(encoded_msg);
    (bytes32 recoveredEntity, bool valid) = IEntityProvider(entityProvider).verifyHankoSignature(hanko, hash);
    return valid && recoveredEntity == expectedEntity;
  }

  // ========== ENTRY POINTS ==========

  /// @notice Process settlements - diffs only (debt handled by Depository)
  function processSettlements(
    mapping(bytes32 => mapping(uint256 => uint256)) storage _reserves,
    mapping(bytes32 => mapping(uint256 => uint256)) storage debtOutstanding,
    mapping(bytes => AccountInfo) storage _accounts,
    mapping(bytes => mapping(uint256 => AccountCollateral)) storage _collaterals,
    bytes32 entityId,
    Settlement[] memory settlements,
    address entityProvider
  ) external returns (bool completeSuccess) {
    completeSuccess = true;
    for (uint i = 0; i < settlements.length; i++) {
      if (!_settleDiffs(_reserves, debtOutstanding, _accounts, _collaterals, entityId, settlements[i], entityProvider)) {
        completeSuccess = false;
      }
    }
  }

  /// @notice Process C2R shortcut directly (skip Settlement[] allocation)
  function processC2R(
    mapping(bytes32 => mapping(uint256 => uint256)) storage _reserves,
    mapping(bytes => AccountInfo) storage _accounts,
    mapping(bytes => mapping(uint256 => AccountCollateral)) storage _collaterals,
    bytes32 entityId,
    CollateralToReserve memory c2r,
    address entityProvider
  ) external returns (bool) {
    bool isLeft = entityId < c2r.counterparty;
    bytes32 leftEntity = isLeft ? entityId : c2r.counterparty;
    bytes32 rightEntity = isLeft ? c2r.counterparty : entityId;
    bytes memory acct_key = _accountKey(leftEntity, rightEntity);

    if (_accounts[acct_key].disputeHash != bytes32(0)) revert E6();

    // NONCE CHECK: signedNonce > storedNonce (strictly greater)
    if (c2r.nonce <= _accounts[acct_key].nonce) revert E2();

    // Reconstruct diffs for signature verification (C2R is a calldata shortcut)
    SettlementDiff[] memory diffs = new SettlementDiff[](1);
    diffs[0] = SettlementDiff({
      tokenId: c2r.tokenId,
      leftDiff: isLeft ? int(c2r.amount) : int(0),
      rightDiff: isLeft ? int(0) : int(c2r.amount),
      collateralDiff: -int(c2r.amount),
      ondeltaDiff: isLeft ? -int(c2r.amount) : int(0)
    });

    // Verify counterparty signature (hash includes signedNonce, not storedNonce)
    bytes memory encoded_msg = abi.encode(
      MessageType.CooperativeUpdate,
      address(this),
      acct_key,
      c2r.nonce,
      diffs,
      new uint[](0)
    );
    bytes32 hash = keccak256(encoded_msg);

    (bytes32 recoveredEntity, bool valid) = IEntityProvider(entityProvider).verifyHankoSignature(c2r.sig, hash);
    if (!valid || recoveredEntity != c2r.counterparty) {
      return false;
    }

    // Apply diffs
    uint tokenId = c2r.tokenId;
    uint amount = c2r.amount;
    AccountCollateral storage col = _collaterals[acct_key][tokenId];
    if (col.collateral < amount) revert E3();

    _reserves[entityId][tokenId] += amount;
    emit ReserveUpdated(entityId, tokenId, _reserves[entityId][tokenId]);
    col.collateral -= amount;
    if (isLeft) {
      col.ondelta -= int(amount);
    }

    // SET nonce (not increment)
    _accounts[acct_key].nonce = c2r.nonce;

    // Emit unionified AccountSettled
    TokenSettlement[] memory tokens = new TokenSettlement[](1);
    tokens[0] = TokenSettlement({
      tokenId: tokenId,
      leftReserve: _reserves[leftEntity][tokenId],
      rightReserve: _reserves[rightEntity][tokenId],
      collateral: col.collateral,
      ondelta: col.ondelta
    });
    AccountSettlement[] memory settled = new AccountSettlement[](1);
    settled[0] = AccountSettlement({
      left: leftEntity,
      right: rightEntity,
      tokens: tokens,
      nonce: _accounts[acct_key].nonce
    });
    emit AccountSettled(settled);

    return true;
  }

  /// @notice Process dispute starts only
  function processDisputeStarts(
    mapping(bytes => AccountInfo) storage _accounts,
    bytes32 entityId,
    InitialDisputeProof[] memory disputeStarts,
    uint256 defaultDisputeDelay,
    address entityProvider
  ) external returns (bool completeSuccess) {
    completeSuccess = true;
    for (uint i = 0; i < disputeStarts.length; i++) {
      if (!_disputeStart(_accounts, entityId, disputeStarts[i], defaultDisputeDelay, entityProvider)) {
        completeSuccess = false;
      }
    }
  }

  // ========== SETTLEMENT (diffs only - debt handled by Depository) ==========

  function _settleDiffs(
    mapping(bytes32 => mapping(uint256 => uint256)) storage _reserves,
    mapping(bytes32 => mapping(uint256 => uint256)) storage debtOutstanding,
    mapping(bytes => AccountInfo) storage _accounts,
    mapping(bytes => mapping(uint256 => AccountCollateral)) storage _collaterals,
    bytes32 initiator,
    Settlement memory s,
    address entityProvider
  ) internal returns (bool) {
    bytes32 leftEntity = s.leftEntity;
    bytes32 rightEntity = s.rightEntity;
    if (leftEntity == rightEntity || leftEntity >= rightEntity) revert E2();
    if (initiator != leftEntity && initiator != rightEntity) revert E7();

    bytes memory acct_key = _accountKey(leftEntity, rightEntity);
    bytes32 counterparty = (initiator == leftEntity) ? rightEntity : leftEntity;

    if (_accounts[acct_key].disputeHash != bytes32(0)) revert E6();

    if (s.diffs.length > MAX_SETTLEMENT_DIFFS) revert E10();
    if (s.forgiveDebtsInTokenIds.length > MAX_SETTLEMENT_FORGIVENESS_IDS) revert E10();
    for (uint j = 0; j < s.diffs.length; j++) {
      for (uint k = 0; k < j; k++) {
        if (s.diffs[j].tokenId == s.diffs[k].tokenId) revert E2();
      }
    }

    // NONCE CHECK: signedNonce > storedNonce (strictly greater)
    if (s.nonce <= _accounts[acct_key].nonce) revert E2();

    require(s.sig.length > 0, "Signature required for settlement");
    // Hash includes signedNonce (from settlement struct), not storedNonce
    bytes memory encoded_msg = abi.encode(MessageType.CooperativeUpdate, address(this), acct_key, s.nonce, s.diffs, s.forgiveDebtsInTokenIds);
    bytes32 hash = keccak256(encoded_msg);

    try IEntityProvider(entityProvider).verifyHankoSignature(s.sig, hash) returns (bytes32 recoveredEntity, bool valid) {
      if (!valid || recoveredEntity != counterparty) {
        return false;
      }
    } catch {
      return false;
    }

    // Apply diffs
    for (uint j = 0; j < s.diffs.length; j++) {
      SettlementDiff memory diff = s.diffs[j];
      uint tokenId = diff.tokenId;
      if (diff.leftDiff + diff.rightDiff + diff.collateralDiff != 0) revert E2();

      if (diff.leftDiff < 0) {
        if (_spendableReserve(_reserves, debtOutstanding, leftEntity, tokenId) < uint(-diff.leftDiff)) revert E3();
        _reserves[leftEntity][tokenId] -= uint(-diff.leftDiff);
        emit ReserveUpdated(leftEntity, tokenId, _reserves[leftEntity][tokenId]);
      } else if (diff.leftDiff > 0) {
        _reserves[leftEntity][tokenId] += uint(diff.leftDiff);
        emit ReserveUpdated(leftEntity, tokenId, _reserves[leftEntity][tokenId]);
      }

      if (diff.rightDiff < 0) {
        if (_spendableReserve(_reserves, debtOutstanding, rightEntity, tokenId) < uint(-diff.rightDiff)) revert E3();
        _reserves[rightEntity][tokenId] -= uint(-diff.rightDiff);
        emit ReserveUpdated(rightEntity, tokenId, _reserves[rightEntity][tokenId]);
      } else if (diff.rightDiff > 0) {
        _reserves[rightEntity][tokenId] += uint(diff.rightDiff);
        emit ReserveUpdated(rightEntity, tokenId, _reserves[rightEntity][tokenId]);
      }

      AccountCollateral storage col = _collaterals[acct_key][tokenId];
      if (diff.collateralDiff < 0) {
        if (col.collateral < uint(-diff.collateralDiff)) revert E3();
        col.collateral -= uint(-diff.collateralDiff);
      } else if (diff.collateralDiff > 0) {
        col.collateral += uint(diff.collateralDiff);
      }
      col.ondelta += diff.ondeltaDiff;
    }

    // SET nonce = signedNonce (not +1)
    _accounts[acct_key].nonce = s.nonce;

    // Emit unionified AccountSettled (one entry per account, all tokens grouped)
    if (s.diffs.length > 0) {
      TokenSettlement[] memory tokens = new TokenSettlement[](s.diffs.length);
      for (uint i = 0; i < s.diffs.length; i++) {
        uint tokenId = s.diffs[i].tokenId;
        AccountCollateral storage col = _collaterals[acct_key][tokenId];
        tokens[i] = TokenSettlement({
          tokenId: tokenId,
          leftReserve: _reserves[leftEntity][tokenId],
          rightReserve: _reserves[rightEntity][tokenId],
          collateral: col.collateral,
          ondelta: col.ondelta
        });
      }
      AccountSettlement[] memory settled = new AccountSettlement[](1);
      settled[0] = AccountSettlement({
        left: leftEntity,
        right: rightEntity,
        tokens: tokens,
        nonce: _accounts[acct_key].nonce
      });
      emit AccountSettled(settled);
    }

    return true;
  }

  function _spendableReserve(
    mapping(bytes32 => mapping(uint256 => uint256)) storage _reserves,
    mapping(bytes32 => mapping(uint256 => uint256)) storage debtOutstanding,
    bytes32 entity,
    uint256 tokenId
  ) private view returns (uint256) {
    uint256 reserve = _reserves[entity][tokenId];
    uint256 debt = debtOutstanding[entity][tokenId];
    return reserve > debt ? reserve - debt : 0;
  }

  // ========== DISPUTE START ==========

  function _disputeStart(
    mapping(bytes => AccountInfo) storage _accounts,
    bytes32 entityId,
    InitialDisputeProof memory params,
    uint256 defaultDelay,
    address entityProvider
  ) internal returns (bool) {
    bytes memory acct_key = _accountKey(entityId, params.counterentity);

    // Intentionally no explicit self-dispute reject here.
    // If an entity signs a dispute against itself, that is treated as a
    // self-inflicted/degenerate workflow rather than a protocol safety issue.
    // We keep the account-key semantics uniform and prefer not to add another
    // branch unless self-dispute becomes a real operational problem.

    // NONCE CHECK: signedNonce > storedNonce (strictly greater)
    if (params.nonce <= _accounts[acct_key].nonce) revert E2();

    require(params.sig.length > 0, "Signature required for dispute");

    bytes memory encoded_msg = abi.encode(MessageType.DisputeProof, address(this), acct_key, params.nonce, params.proofbodyHash, params.watchSeed);
    bytes32 hash = keccak256(encoded_msg);
    (bytes32 recoveredEntity, bool valid) = IEntityProvider(entityProvider).verifyHankoSignature(params.sig, hash);
    if (!valid || recoveredEntity != params.counterentity) revert E4();

    if (_accounts[acct_key].disputeHash != bytes32(0)) revert E6();

    uint256 timeout = block.number + defaultDelay;
    // Store only the dispute hash, not raw proof bodies. Both starter argument
    // blobs are emitted for observers and repeated at finalize for hash check.
    _accounts[acct_key].disputeHash = _encodeDisputeHash(
      params.nonce, entityId < params.counterentity,
      timeout,
      params.proofbodyHash,
      params.starterInitialArguments,
      params.starterIncrementedArguments
    );
    _accounts[acct_key].disputeTimeout = timeout;
    _accounts[acct_key].disputeStartTimestamp = block.timestamp;

    // SET nonce = signedNonce (any settlement signed at ≤ this nonce is now dead)
    _accounts[acct_key].nonce = params.nonce;

    emit DisputeStarted(
      entityId,
      params.counterentity,
      params.nonce,
      params.proofbodyHash,
      params.watchSeed,
      params.starterInitialArguments,
      params.starterIncrementedArguments
    );
    return true;
  }

  /**
   * DESIGN DECISION: Dispute finalization stays in Depository.sol
   * Reason: requires deep storage access (debt/reserve interactions)
   */
}
