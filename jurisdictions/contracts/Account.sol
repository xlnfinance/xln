// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "./Types.sol";
import "./DeltaTransformer.sol";
import "./IEntityProvider.sol";
import "./HankoEncoding.sol";

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
    bytes starterIncrementedArguments,
    uint256 disputeTimeout
  );
  event DebtCreated(bytes32 indexed debtor, bytes32 indexed creditor, uint256 indexed tokenId, uint256 amount, uint256 debtIndex);
  event DebtForgiven(bytes32 indexed debtor, bytes32 indexed creditor, uint256 indexed tokenId, uint256 amountForgiven, uint256 debtIndex);
  event FatalTokenError(
    uint256 indexed tokenId,
    bytes32 indexed debtor,
    uint256 requestedDebt,
    uint256 acceptedDebt,
    uint256 supply,
    uint256 outstanding
  );
  // These signatures intentionally match Depository's public event ABI. The
  // library executes by DELEGATECALL, so logs are emitted from Depository.
  event TransformerClauseSkipped(
    bytes32 indexed accountKeyHash,
    uint256 indexed clauseIndex,
    address indexed transformer,
    uint8 reason
  );
  event TransformerDeltaClamped(
    bytes32 indexed accountKeyHash,
    uint256 indexed clauseIndex,
    address indexed transformer,
    uint256 tokenId,
    int256 requestedValue,
    int256 appliedValue
  );

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
  uint256 private constant TOKEN_SUPPLY_GAS_LIMIT = 30_000;

  function _readFixedTokenSupply(uint8 tokenType, address token, uint96 externalTokenId)
    private view returns (uint256 supply, bool valid)
  {
    if (tokenType > 2) return (0, false);
    if (tokenType == 1) return (1, true);
    bytes4 selector = tokenType == 0
      ? bytes4(keccak256("totalSupply()"))
      : bytes4(keccak256("totalSupply(uint256)"));
    bytes memory callData = tokenType == 0
      ? abi.encodeWithSelector(selector)
      : abi.encodeWithSelector(selector, uint256(externalTokenId));
    bool success;
    uint256 returnSize;
    uint256 gasLimit = TOKEN_SUPPLY_GAS_LIMIT;
    // A token can be upgraded after registration. Never let its getter consume
    // the finalization gas reserve or make Solidity allocate arbitrary return
    // data: both let the token hold an unrelated bilateral dispute hostage.
    assembly ("memory-safe") {
      let data := add(callData, 0x20)
      success := staticcall(gasLimit, token, data, mload(callData), data, 0x20)
      returnSize := returndatasize()
      supply := mload(data)
    }
    if (!success || returnSize != 32) return (0, false);
    valid = supply > 0 && supply <= uint256(type(int256).max);
  }

  function readFixedTokenSupply(uint8 tokenType, address token, uint96 externalTokenId)
    external view returns (uint256 supply, bool valid)
  {
    return _readFixedTokenSupply(tokenType, token, externalTokenId);
  }

  function addCappedDebt(
    mapping(bytes32 => mapping(uint256 => Debt[])) storage debts,
    mapping(bytes32 => mapping(uint256 => uint256)) storage debtIndex,
    mapping(bytes32 => mapping(uint256 => uint256)) storage debtOutstanding,
    bytes32 debtor,
    uint256 tokenId,
    bytes32 creditor,
    uint256 requested,
    uint8 tokenType,
    address token,
    uint96 externalTokenId
  ) external returns (uint256 accepted) {
    uint256 outstanding = debtOutstanding[debtor][tokenId];
    (uint256 supply, bool validSupply) = _readFixedTokenSupply(tokenType, token, externalTokenId);
    uint256 available = validSupply && supply > outstanding ? supply - outstanding : 0;
    accepted = requested < available ? requested : available;
    if (accepted != requested) {
      emit FatalTokenError(tokenId, debtor, requested, accepted, supply, outstanding);
    }
    if (accepted == 0) return 0;
    debts[debtor][tokenId].push(Debt({ amount: accepted, creditor: creditor }));
    uint256 index = debts[debtor][tokenId].length - 1;
    if (index == 0) debtIndex[debtor][tokenId] = 0;
    debtOutstanding[debtor][tokenId] = outstanding + accepted;
    emit DebtCreated(debtor, creditor, tokenId, accepted, index);
  }

  function increaseReserve(
    mapping(bytes32 => mapping(uint256 => uint256)) storage reserves,
    bytes32 entity,
    uint256 tokenId,
    uint256 amount
  ) external {
    if (amount == 0) return;
    uint256 current = reserves[entity][tokenId];
    uint256 limit = uint256(type(int256).max);
    if (current > limit || amount > limit - current) revert E8();
    reserves[entity][tokenId] = current + amount;
    emit ReserveUpdated(entity, tokenId, current + amount);
  }

  function decreaseReserve(
    mapping(bytes32 => mapping(uint256 => uint256)) storage reserves,
    bytes32 entity,
    uint256 tokenId,
    uint256 amount
  ) external {
    if (amount == 0) return;
    uint256 current = reserves[entity][tokenId];
    if (current < amount) revert E3();
    reserves[entity][tokenId] = current - amount;
    emit ReserveUpdated(entity, tokenId, current - amount);
  }
  uint256 private constant MAX_DISPUTE_PROOF_BODY_BYTES = 176 * 1024;
  uint256 private constant MAX_DISPUTE_STARTER_ARGUMENT_BYTES = 64 * 1024;
  uint256 private constant MAX_DISPUTE_PROOF_TOKENS = 128;
  uint256 private constant MAX_DISPUTE_TRANSFORMERS = 32;
  bytes4 private constant APPLY_TRANSFORMER_BATCH_SELECTOR =
    bytes4(keccak256("applyBatch(int256[],uint256[],bytes,bytes,bytes,uint256,uint256)"));
  bytes4 private constant DECODE_TRANSFORMER_ARGUMENT_LIST_SELECTOR =
    bytes4(keccak256("decodeTransformerArgumentListStrict(bytes)"));
  uint256 private constant TRANSFORMER_CALL_GAS_LIMIT = 4_000_000;
  uint256 private constant TRANSFORMER_POST_CALL_GAS_RESERVE = 150_000;
  uint256 private constant TRANSFORMER_MIN_CALL_GAS = 25_000;
  uint256 private constant TRANSFORMER_PRECALL_GAS_RESERVE = 1_500_000;
  uint256 private constant TRANSFORMER_ARGUMENT_DECODE_GAS_LIMIT = 500_000;
  uint256 private constant TRANSFORMER_TOTAL_GAS_LIMIT = 8_000_000;
  uint256 private constant MAX_TRANSFORMER_CLAUSES = 32;
  uint256 private constant INT256_SIGN_BIT = 1 << 255;

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
    uint256 disputeStartTimestamp,
    bytes memory starterInitialArguments,
    bytes memory starterIncrementedArguments
  ) external pure returns (bytes32) {
    bytes32 initialCommitment = _argumentCommitment(
      starterInitialArguments,
      startedByLeft,
      disputeStartTimestamp
    );
    bytes32 incrementedCommitment = _argumentCommitment(
      starterIncrementedArguments,
      startedByLeft,
      disputeStartTimestamp
    );
    return _encodeDisputeHash(
      nonce,
      startedByLeft,
      timeout,
      proofbodyHash,
      disputeStartTimestamp,
      initialCommitment,
      incrementedCommitment
    );
  }

  function encodeDisputeHashFromCommitments(
    uint nonce, bool startedByLeft,
    uint256 timeout,
    bytes32 proofbodyHash,
    uint256 disputeStartTimestamp,
    bytes32 starterInitialArgumentsCommitment,
    bytes32 starterIncrementedArgumentsCommitment
  ) external pure returns (bytes32) {
    return _encodeDisputeHash(
      nonce,
      startedByLeft,
      timeout,
      proofbodyHash,
      disputeStartTimestamp,
      starterInitialArgumentsCommitment,
      starterIncrementedArgumentsCommitment
    );
  }

  function _encodeDisputeHash(
    uint nonce, bool startedByLeft,
    uint256 timeout,
    bytes32 proofbodyHash,
    uint256 disputeStartTimestamp,
    bytes32 starterInitialArgumentsCommitment,
    bytes32 starterIncrementedArgumentsCommitment
  ) internal pure returns (bytes32) {
    return keccak256(abi.encodePacked(
      nonce,
      startedByLeft,
      timeout,
      proofbodyHash,
      disputeStartTimestamp,
      starterInitialArgumentsCommitment,
      starterIncrementedArgumentsCommitment
    ));
  }

  function _argumentCommitment(
    bytes memory arguments,
    bool startedByLeft,
    uint256 disputeStartTimestamp
  ) internal pure returns (bytes32) {
    return keccak256(abi.encode(arguments, startedByLeft, disputeStartTimestamp));
  }

  function requireStarterArgumentCommitment(
    bytes memory starterArguments,
    bool startedByLeft,
    uint256 disputeStartTimestamp,
    bytes32 expectedCommitment
  ) external pure {
    if (_argumentCommitment(starterArguments, startedByLeft, disputeStartTimestamp) != expectedCommitment) {
      revert E9();
    }
  }

  function _validateProofBody(ProofBody memory proofbody) private pure returns (bytes32 bodyHash) {
    if (proofbody.tokenIds.length != proofbody.offdeltas.length) revert E8();
    if (proofbody.tokenIds.length > MAX_DISPUTE_PROOF_TOKENS) revert E10();
    if (proofbody.transformers.length > MAX_DISPUTE_TRANSFORMERS) revert E10();
    for (uint256 i = 1; i < proofbody.tokenIds.length; i++) {
      if (proofbody.tokenIds[i - 1] >= proofbody.tokenIds[i]) revert E8();
    }
    bytes memory encodedProofbody = abi.encode(proofbody);
    if (encodedProofbody.length > MAX_DISPUTE_PROOF_BODY_BYTES) revert E10();
    bodyHash = keccak256(encodedProofbody);
  }

  function _validateInitialDisputeProof(InitialDisputeProof memory params) private pure {
    if (_validateProofBody(params.initialProofbody) != params.proofbodyHash) revert E9();
    if (params.initialProofbody.watchSeed != params.watchSeed) revert E9();
    if (
      params.starterInitialArguments.length + params.starterIncrementedArguments.length
        > MAX_DISPUTE_STARTER_ARGUMENT_BYTES
    ) revert E10();
  }

  function validateDisputeProofs(
    InitialDisputeProof[] memory disputeStarts,
    FinalDisputeProof[] memory disputeFinalizations
  ) external pure {
    for (uint256 i = 0; i < disputeStarts.length; i++) {
      _validateInitialDisputeProof(disputeStarts[i]);
    }
    for (uint256 i = 0; i < disputeFinalizations.length; i++) {
      _validateProofBody(disputeFinalizations[i].finalProofbody);
      if (
        disputeFinalizations[i].starterArguments.length > MAX_DISPUTE_STARTER_ARGUMENT_BYTES ||
        disputeFinalizations[i].otherArguments.length > MAX_DISPUTE_STARTER_ARGUMENT_BYTES
      ) revert E10();
    }
  }

  function _encodeBatchHankoPayload(
    bytes32 domainSep,
    bytes memory encodedBatch,
    uint256 nonce
  ) private view returns (bytes memory) {
    return HankoEncoding.encodeBatch(
      domainSep,
      block.chainid,
      address(this),
      encodedBatch,
      nonce
    );
  }

  function computeBatchHankoHash(
    bytes32 domainSep,
    bytes memory encodedBatch,
    uint256 nonce
  ) external view returns (bytes32) {
    return keccak256(_encodeBatchHankoPayload(domainSep, encodedBatch, nonce));
  }

  // Account is a linked library, so production entry points execute by
  // DELEGATECALL and address(this) is the Depository. Never pass either domain
  // component into a verifier: a caller-controlled chain/address would make it
  // accept a signature for a different jurisdiction.
  function _encodeCooperativeUpdateHankoPayload(
    bytes memory acct_key,
    uint nonce,
    SettlementDiff[] memory diffs,
    uint[] memory forgiveDebtsInTokenIds
  ) private view returns (bytes memory) {
    return HankoEncoding.encodeCooperativeUpdate(
      block.chainid,
      address(this),
      acct_key,
      nonce,
      diffs,
      forgiveDebtsInTokenIds
    );
  }

  function _cooperativeUpdateHankoHash(
    bytes memory acct_key,
    uint nonce,
    SettlementDiff[] memory diffs,
    uint[] memory forgiveDebtsInTokenIds
  ) private view returns (bytes32) {
    return keccak256(_encodeCooperativeUpdateHankoPayload(acct_key, nonce, diffs, forgiveDebtsInTokenIds));
  }

  function _encodeDisputeProofHankoPayload(
    bytes memory acct_key,
    uint nonce,
    bytes32 proofbodyHash,
    bytes32 watchSeed
  ) private view returns (bytes memory) {
    return HankoEncoding.encodeDisputeProof(
      block.chainid,
      address(this),
      acct_key,
      nonce,
      proofbodyHash,
      watchSeed
    );
  }

  function _disputeProofHankoHash(
    bytes memory acct_key,
    uint nonce,
    bytes32 proofbodyHash,
    bytes32 watchSeed
  ) private view returns (bytes32) {
    return keccak256(_encodeDisputeProofHankoPayload(acct_key, nonce, proofbodyHash, watchSeed));
  }

  function _encodeCooperativeDisputeProofHankoPayload(
    bytes memory acct_key,
    uint nonce,
    bytes32 proofbodyHash,
    bytes32 starterInitialArgumentsHash
  ) private view returns (bytes memory) {
    return HankoEncoding.encodeCooperativeDisputeProof(
      block.chainid,
      address(this),
      acct_key,
      nonce,
      proofbodyHash,
      starterInitialArgumentsHash
    );
  }

  function _cooperativeDisputeProofHankoHash(
    bytes memory acct_key,
    uint nonce,
    bytes32 proofbodyHash,
    bytes32 starterInitialArgumentsHash
  ) private view returns (bytes32) {
    return keccak256(_encodeCooperativeDisputeProofHankoPayload(
      acct_key,
      nonce,
      proofbodyHash,
      starterInitialArgumentsHash
    ));
  }

  // ========== HANKO VERIFICATION ==========

  /// @notice Verify dispute proof with hanko (entity-level signature)
  function verifyDisputeProofHanko(
    address entityProvider,
    bytes memory acct_key,
    uint nonce,
    bytes32 proofbodyHash,
    bytes32 watchSeed,
    bytes memory hanko,
    bytes32 expectedEntity
  ) private view returns (bool success) {
    bytes32 hash = _disputeProofHankoHash(acct_key, nonce, proofbodyHash, watchSeed);
    (bytes32 recoveredEntity, bool valid) = IEntityProvider(entityProvider).verifyHankoSignature(hanko, hash);
    return valid && recoveredEntity == expectedEntity;
  }

  /// @notice Verify cooperative proof with hanko
  function verifyCooperativeProofHanko(
    address entityProvider,
    bytes memory acct_key,
    uint nonce,
    bytes32 proofbodyHash,
    bytes32 starterInitialArgumentsHash,
    bytes memory hanko,
    bytes32 expectedEntity
  ) private view returns (bool success) {
    bytes32 hash = _cooperativeDisputeProofHankoHash(
      acct_key,
      nonce,
      proofbodyHash,
      starterInitialArgumentsHash
    );
    (bytes32 recoveredEntity, bool valid) = IEntityProvider(entityProvider).verifyHankoSignature(hanko, hash);
    return valid && recoveredEntity == expectedEntity;
  }

  /// @notice Validate a finalization against durable dispute commitments and
  /// return the exact left/right transformer evidence to apply.
  /// @dev Kept in the linked library so the Depository remains deployable under
  /// EIP-170. This function executes by DELEGATECALL over Depository storage.
  /// Signed state (body/hash/nonce) is strict; only transformer evidence is
  /// optional and is handled fail-soft later by Depository._finalizeAccount.
  function prepareDisputeFinalization(
    mapping(bytes => AccountInfo) storage _accounts,
    bytes32 entityId,
    FinalDisputeProof memory params,
    address entityProvider
  ) external returns (
    bytes memory leftArguments,
    bytes memory rightArguments,
    uint256 leftArgumentsTimestamp,
    uint256 rightArgumentsTimestamp,
    uint256 eventInitialNonce,
    bytes32 finalProofbodyHash
  ) {
    finalProofbodyHash = _validateProofBody(params.finalProofbody);
    if (
      params.starterArguments.length > MAX_DISPUTE_STARTER_ARGUMENT_BYTES ||
      params.otherArguments.length > MAX_DISPUTE_STARTER_ARGUMENT_BYTES
    ) revert E10();
    bytes memory acct_key = _accountKey(entityId, params.counterentity);
    AccountInfo storage account = _accounts[acct_key];
    uint256 starterArgumentsTimestamp = block.timestamp;
    eventInitialNonce = params.initialNonce;

    if (params.cooperative) {
      if (account.nonce == 0) revert E5();
      if (params.initialNonce != account.nonce) revert E2();
      if (params.finalNonce <= account.nonce) revert E2();
      if (params.sig.length == 0) revert E4();

      // counterentity supplies the inner Hanko, so the selected starter blob
      // is that signer's side. entityId independently authorizes the other side
      // through the outer processBatch Hanko.
      if (params.startedByLeft != (params.counterentity < entityId)) revert E7();
      if (!verifyCooperativeProofHanko(
        entityProvider,
        acct_key,
        params.finalNonce,
        finalProofbodyHash,
        keccak256(params.starterArguments),
        params.sig,
        params.counterentity
      )) revert E4();
    } else {
      bytes32 storedHash = account.disputeHash;
      if (storedHash == bytes32(0)) revert E5();
      if (params.initialNonce != account.nonce) revert E2();
      if (params.initialProofbodyHash != account.disputeInitialProofbodyHash) revert E9();
      if (params.startedByLeft != account.disputeStartedByLeft) revert E9();

      bytes32 expectedHash = _encodeDisputeHash(
        account.nonce,
        account.disputeStartedByLeft,
        account.disputeTimeout,
        account.disputeInitialProofbodyHash,
        account.disputeStartTimestamp,
        account.starterInitialArgumentsCommitment,
        account.starterIncrementedArgumentsCommitment
      );
      if (storedHash != expectedHash) revert E9();

      bytes32 expectedStarterArgumentsCommitment;
      if (params.sig.length > 0) {
        if (params.finalNonce <= account.nonce) revert E2();
        if (params.finalNonce <= params.initialNonce) revert E2();
        if (!verifyDisputeProofHanko(
          entityProvider,
          acct_key,
          params.finalNonce,
          finalProofbodyHash,
          params.finalProofbody.watchSeed,
          params.sig,
          params.counterentity
        )) revert E4();
        expectedStarterArgumentsCommitment = account.starterIncrementedArgumentsCommitment;
      } else {
        if (params.finalNonce != account.nonce) revert E2();
        bool senderIsCounterparty = params.startedByLeft != (entityId < params.counterentity);
        if (!senderIsCounterparty && block.number < account.disputeTimeout) revert E2();
        if (finalProofbodyHash != account.disputeInitialProofbodyHash) revert E9();
        expectedStarterArgumentsCommitment = account.starterInitialArgumentsCommitment;
      }

      if (
        _argumentCommitment(
          params.starterArguments,
          account.disputeStartedByLeft,
          account.disputeStartTimestamp
        ) != expectedStarterArgumentsCommitment
      ) revert E9();
      starterArgumentsTimestamp = account.disputeStartTimestamp;
      eventInitialNonce = account.nonce;
    }

    leftArguments = params.startedByLeft ? params.starterArguments : params.otherArguments;
    rightArguments = params.startedByLeft ? params.otherArguments : params.starterArguments;
    leftArgumentsTimestamp = block.timestamp;
    rightArgumentsTimestamp = block.timestamp;
    if (!params.cooperative) {
      if (params.startedByLeft) {
        leftArgumentsTimestamp = starterArgumentsTimestamp;
      } else {
        rightArgumentsTimestamp = starterArgumentsTimestamp;
      }
    }

    // Publish no partially-cleared dispute state. Any later failure reverts the
    // entire processBatch transaction and restores these fields atomically.
    account.disputeHash = bytes32(0);
    account.disputeTimeout = 0;
    account.disputeStartTimestamp = 0;
    account.disputeInitialProofbodyHash = bytes32(0);
    account.starterInitialArgumentsCommitment = bytes32(0);
    account.starterIncrementedArgumentsCommitment = bytes32(0);
    account.disputeStartedByLeft = false;
  }

  /// @notice Isolated optional transformer evaluation for Depository finalization.
  /// @dev Returns a stable uint8 matching Depository.TransformerSkipReason:
  /// 0=None, 1=NoCode, 2=InsufficientGas, 3=CallFailed, 4=MalformedReturn.
  /// The linked-library boundary keeps hostile-call parsing out of Depository's
  /// EIP-170 budget without changing storage authority or failure semantics.
  function _tryApplyTransformer(
    int[] memory deltas,
    uint[] memory tokenIds,
    TransformerClause memory tc,
    bytes memory leftArguments,
    bytes memory rightArguments,
    uint256 leftArgumentsTimestamp,
    uint256 rightArgumentsTimestamp,
    uint256 transformerGasBudget
  ) private view returns (bool applied, int[] memory newDeltas, uint8 reason) {
    if (tc.transformerAddress.code.length == 0) return (false, newDeltas, 1);
    if (
      transformerGasBudget < TRANSFORMER_MIN_CALL_GAS ||
      gasleft() <= TRANSFORMER_PRECALL_GAS_RESERVE
    ) return (false, newDeltas, 2);
    if (tc.encodedBatch.length + leftArguments.length + rightArguments.length >> 18 != 0) {
      return (false, newDeltas, 2);
    }

    uint256 transformerGasStart = gasleft();
    bytes memory callData = abi.encodeWithSelector(
      APPLY_TRANSFORMER_BATCH_SELECTOR,
      deltas,
      tokenIds,
      tc.encodedBatch,
      leftArguments,
      rightArguments,
      leftArgumentsTimestamp,
      rightArgumentsTimestamp
    );
    uint256 encodingGasUsed = transformerGasStart - gasleft();
    if (encodingGasUsed >= transformerGasBudget) return (false, newDeltas, 2);
    transformerGasBudget -= encodingGasUsed;

    uint256 remainingGas = gasleft();
    if (remainingGas <= TRANSFORMER_POST_CALL_GAS_RESERVE + TRANSFORMER_MIN_CALL_GAS) {
      return (false, newDeltas, 2);
    }
    uint256 callGas = remainingGas - TRANSFORMER_POST_CALL_GAS_RESERVE;
    if (callGas > TRANSFORMER_CALL_GAS_LIMIT) callGas = TRANSFORMER_CALL_GAS_LIMIT;
    if (callGas > transformerGasBudget) callGas = transformerGasBudget;
    if (callGas < TRANSFORMER_MIN_CALL_GAS) return (false, newDeltas, 2);

    bool callOk;
    uint256 returnSize;
    address transformer = tc.transformerAddress;
    assembly ("memory-safe") {
      callOk := staticcall(callGas, transformer, add(callData, 0x20), mload(callData), 0, 0)
      returnSize := returndatasize()
    }
    if (!callOk) return (false, newDeltas, 3);

    uint256 expectedReturnSize = 0x40 + deltas.length * 0x20;
    if (returnSize != expectedReturnSize) return (false, newDeltas, 4);

    bytes memory returnData = new bytes(returnSize);
    assembly ("memory-safe") {
      returndatacopy(add(returnData, 0x20), 0, returnSize)
    }
    uint256 arrayOffset;
    uint256 arrayLength;
    assembly ("memory-safe") {
      arrayOffset := mload(add(returnData, 0x20))
      arrayLength := mload(add(returnData, 0x40))
    }
    if (arrayOffset != 0x20 || arrayLength != deltas.length) return (false, newDeltas, 4);

    newDeltas = new int[](arrayLength);
    for (uint256 i = 0; i < arrayLength; i++) {
      int256 value;
      assembly ("memory-safe") {
        value := mload(add(add(returnData, 0x60), mul(i, 0x20)))
      }
      newDeltas[i] = value;
    }
    return (true, newDeltas, 0);
  }

  function applyTransformers(
    bytes32 accountKeyHash,
    ProofBody memory proofbody,
    int[] memory deltas,
    bool exactTransformerInputs,
    bytes memory leftArguments,
    bytes memory rightArguments,
    uint256 leftArgumentsTimestamp,
    uint256 rightArgumentsTimestamp
  ) external returns (int[] memory) {
    if (!exactTransformerInputs) {
      // A unilateral R2C may move the exact ondelta + signed offdelta outside
      // int256 without changing the Account nonce. Custom transformers expose
      // an int256[] ABI, so there is no truthful value we can pass them. Never
      // substitute a saturated value: custom code could branch on it and turn
      // the approximation into a financial claim. Transformer clauses are
      // optional dispute evidence, therefore skip them loudly while Depository
      // applies the exact wide base delta below.
      for (uint256 i = 0; i < proofbody.transformers.length; i++) {
        emit TransformerClauseSkipped(
          accountKeyHash,
          i,
          proofbody.transformers[i].transformerAddress,
          7
        );
      }
      return deltas;
    }
    bytes[] memory decodedLeft = _decodeTransformerArgumentList(leftArguments);
    bytes[] memory decodedRight = _decodeTransformerArgumentList(rightArguments);
    uint256 remainingTransformerGas = TRANSFORMER_TOTAL_GAS_LIMIT;
    for (uint256 i = 0; i < proofbody.transformers.length; i++) {
      if (i >= MAX_TRANSFORMER_CLAUSES || remainingTransformerGas < TRANSFORMER_MIN_CALL_GAS) {
        emit TransformerClauseSkipped(accountKeyHash, i, address(0), 2);
        break;
      }
      TransformerClause memory tc = proofbody.transformers[i];
      if (!_validTransformerAllowances(tc.allowances, deltas.length)) {
        emit TransformerClauseSkipped(accountKeyHash, i, tc.transformerAddress, 5);
        continue;
      }

      uint256 transformerGasBefore = gasleft();
      (bool applied, int[] memory newDeltas, uint8 skipReason) = _tryApplyTransformer(
        deltas,
        proofbody.tokenIds,
        tc,
        i < decodedLeft.length ? decodedLeft[i] : bytes(""),
        i < decodedRight.length ? decodedRight[i] : bytes(""),
        leftArgumentsTimestamp,
        rightArgumentsTimestamp,
        remainingTransformerGas
      );
      uint256 transformerGasUsed = transformerGasBefore - gasleft();
      remainingTransformerGas = transformerGasUsed >= remainingTransformerGas
        ? 0
        : remainingTransformerGas - transformerGasUsed;
      if (!applied) {
        emit TransformerClauseSkipped(accountKeyHash, i, tc.transformerAddress, skipReason);
        continue;
      }

      bool mutatedUnallowedToken = false;
      for (uint256 j = 0; j < deltas.length; j++) {
        if (newDeltas[j] != deltas[j] && !_hasTransformerAllowance(tc.allowances, j)) {
          mutatedUnallowedToken = true;
          break;
        }
      }
      if (mutatedUnallowedToken) {
        emit TransformerClauseSkipped(accountKeyHash, i, tc.transformerAddress, 6);
        continue;
      }

      for (uint256 j = 0; j < tc.allowances.length; j++) {
        Allowance memory allow = tc.allowances[j];
        uint256 deltaIndex = allow.deltaIndex;
        int256 requestedValue = newDeltas[deltaIndex];
        int256 appliedValue = _clampTransformerValue(
          deltas[deltaIndex],
          requestedValue,
          allow.rightAllowance,
          allow.leftAllowance
        );
        if (appliedValue != requestedValue) {
          emit TransformerDeltaClamped(
            accountKeyHash,
            i,
            tc.transformerAddress,
            proofbody.tokenIds[deltaIndex],
            requestedValue,
            appliedValue
          );
          newDeltas[deltaIndex] = appliedValue;
        }
      }
      deltas = newDeltas;
    }
    return deltas;
  }

  function _decodeTransformerArgumentList(bytes memory encoded) private view returns (bytes[] memory) {
    if (encoded.length == 0) return new bytes[](0);
    if (encoded.length >> 18 != 0 || gasleft() <= TRANSFORMER_PRECALL_GAS_RESERVE) {
      return new bytes[](0);
    }
    (bool ok, bytes memory result) = address(this).staticcall{
      gas: TRANSFORMER_ARGUMENT_DECODE_GAS_LIMIT
    }(abi.encodeWithSelector(DECODE_TRANSFORMER_ARGUMENT_LIST_SELECTOR, encoded));
    if (!ok) return new bytes[](0);
    return abi.decode(result, (bytes[]));
  }

  function _hasTransformerAllowance(Allowance[] memory allowances, uint256 deltaIndex)
    private pure returns (bool)
  {
    for (uint256 i = 0; i < allowances.length; i++) {
      if (allowances[i].deltaIndex == deltaIndex) return true;
    }
    return false;
  }

  function _validTransformerAllowances(Allowance[] memory allowances, uint256 deltaCount)
    private pure returns (bool)
  {
    if (allowances.length > deltaCount) return false;
    for (uint256 i = 0; i < allowances.length; i++) {
      if (allowances[i].deltaIndex >= deltaCount) return false;
      for (uint256 j = 0; j < i; j++) {
        if (allowances[j].deltaIndex == allowances[i].deltaIndex) return false;
      }
    }
    return true;
  }

  function _clampTransformerValue(
    int256 previousValue,
    int256 requestedValue,
    uint256 rightAllowance,
    uint256 leftAllowance
  ) private pure returns (int256) {
    uint256 previousOrdered = uint256(previousValue) ^ INT256_SIGN_BIT;
    uint256 requestedOrdered = uint256(requestedValue) ^ INT256_SIGN_BIT;
    uint256 lowerOrdered = rightAllowance >= previousOrdered ? 0 : previousOrdered - rightAllowance;
    // Ordered zero maps back to int256.min. Depository._applyAccountDelta must
    // negate every negative result, and -type(int256).min always reverts. A
    // hostile transformer with a maximum allowance must not be able to turn an
    // otherwise valid dispute into an unfinalizable one, so the reachable
    // signed range starts at int256.min + 1 (ordered value 1).
    if (lowerOrdered == 0) lowerOrdered = 1;
    uint256 upperOrdered = leftAllowance > type(uint256).max - previousOrdered
      ? type(uint256).max
      : previousOrdered + leftAllowance;

    uint256 appliedOrdered = requestedOrdered;
    if (appliedOrdered < lowerOrdered) appliedOrdered = lowerOrdered;
    if (appliedOrdered > upperOrdered) appliedOrdered = upperOrdered;
    // If legacy/corrupt signed state itself supplied int256.min, upperOrdered
    // can also be zero. Preserve the liveness floor after both bounds so this
    // helper has no path that returns the un-negatable sentinel.
    if (appliedOrdered == 0) appliedOrdered = 1;
    uint256 rawValue = appliedOrdered ^ INT256_SIGN_BIT;
    int256 appliedValue;
    assembly ("memory-safe") {
      appliedValue := rawValue
    }
    return appliedValue;
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
  ) external returns (BatchItemResult[] memory results) {
    results = new BatchItemResult[](settlements.length);
    for (uint i = 0; i < settlements.length; i++) {
      results[i] = _settleDiffs(
        _reserves,
        debtOutstanding,
        _accounts,
        _collaterals,
        entityId,
        settlements[i],
        entityProvider
      );
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
  ) external returns (BatchItemResult) {
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
    bytes32 hash = _cooperativeUpdateHankoHash(acct_key, c2r.nonce, diffs, new uint[](0));

    (bytes32 recoveredEntity, bool valid) = IEntityProvider(entityProvider).verifyHankoSignature(c2r.sig, hash);
    if (!valid || recoveredEntity != c2r.counterparty) {
      return BatchItemResult.InvalidSignature;
    }

    // Apply diffs
    uint tokenId = c2r.tokenId;
    uint amount = c2r.amount;
    AccountCollateral storage col = _collaterals[acct_key][tokenId];
    if (col.collateral < amount) return BatchItemResult.InsufficientBalance;

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

    return BatchItemResult.Applied;
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
  ) internal returns (BatchItemResult) {
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
    // A signed empty settlement would advance the account nonce without any
    // token snapshot for the watcher to finalize. Reject that invisible state
    // transition instead of manufacturing a dummy token event.
    if (s.diffs.length == 0 && s.forgiveDebtsInTokenIds.length == 0) revert E2();
    // Hash includes signedNonce (from settlement struct), not storedNonce
    bytes32 hash = _cooperativeUpdateHankoHash(
      acct_key,
      s.nonce,
      s.diffs,
      s.forgiveDebtsInTokenIds
    );

    try IEntityProvider(entityProvider).verifyHankoSignature(s.sig, hash) returns (bytes32 recoveredEntity, bool valid) {
      if (!valid || recoveredEntity != counterparty) {
        return BatchItemResult.InvalidSignature;
      }
    } catch {
      return BatchItemResult.InvalidSignature;
    }

    // A settlement is one signed bilateral state transition. Check every
    // balance first so an expected state race skips the whole settlement,
    // never a prefix of its token diffs.
    for (uint j = 0; j < s.diffs.length; j++) {
      SettlementDiff memory diff = s.diffs[j];
      uint tokenId = diff.tokenId;
      if (diff.leftDiff + diff.rightDiff + diff.collateralDiff != 0) revert E2();
      if (
        diff.leftDiff < 0 &&
        _spendableReserve(_reserves, debtOutstanding, leftEntity, tokenId) < uint(-diff.leftDiff)
      ) return BatchItemResult.InsufficientBalance;
      if (
        diff.rightDiff < 0 &&
        _spendableReserve(_reserves, debtOutstanding, rightEntity, tokenId) < uint(-diff.rightDiff)
      ) return BatchItemResult.InsufficientBalance;
      if (
        diff.collateralDiff < 0 &&
        _collaterals[acct_key][tokenId].collateral < uint(-diff.collateralDiff)
      ) return BatchItemResult.InsufficientBalance;
    }

    // Apply diffs
    for (uint j = 0; j < s.diffs.length; j++) {
      SettlementDiff memory diff = s.diffs[j];
      uint tokenId = diff.tokenId;

      if (diff.leftDiff < 0) {
        _reserves[leftEntity][tokenId] -= uint(-diff.leftDiff);
        emit ReserveUpdated(leftEntity, tokenId, _reserves[leftEntity][tokenId]);
      } else if (diff.leftDiff > 0) {
        _reserves[leftEntity][tokenId] += uint(diff.leftDiff);
        emit ReserveUpdated(leftEntity, tokenId, _reserves[leftEntity][tokenId]);
      }

      if (diff.rightDiff < 0) {
        _reserves[rightEntity][tokenId] -= uint(-diff.rightDiff);
        emit ReserveUpdated(rightEntity, tokenId, _reserves[rightEntity][tokenId]);
      } else if (diff.rightDiff > 0) {
        _reserves[rightEntity][tokenId] += uint(diff.rightDiff);
        emit ReserveUpdated(rightEntity, tokenId, _reserves[rightEntity][tokenId]);
      }

      AccountCollateral storage col = _collaterals[acct_key][tokenId];
      if (diff.collateralDiff < 0) {
        col.collateral -= uint(-diff.collateralDiff);
      } else if (diff.collateralDiff > 0) {
        col.collateral += uint(diff.collateralDiff);
      }
      col.ondelta += diff.ondeltaDiff;
    }

    // SET nonce = signedNonce (not +1)
    _accounts[acct_key].nonce = s.nonce;

    // Every successful nonce transition must be observable. A pure debt
    // forgiveness has no diffs, but it still invalidates old proofs and must
    // therefore publish AccountSettled with snapshots for the forgiven tokens.
    uint tokenCount = s.diffs.length;
    for (uint i = 0; i < s.forgiveDebtsInTokenIds.length; i++) {
      uint forgiveTokenId = s.forgiveDebtsInTokenIds[i];
      bool alreadyIncluded = false;
      for (uint j = 0; j < s.diffs.length; j++) {
        if (s.diffs[j].tokenId == forgiveTokenId) alreadyIncluded = true;
      }
      for (uint j = 0; j < i; j++) {
        if (s.forgiveDebtsInTokenIds[j] == forgiveTokenId) alreadyIncluded = true;
      }
      if (!alreadyIncluded) tokenCount++;
    }

    TokenSettlement[] memory tokens = new TokenSettlement[](tokenCount);
    uint tokenIndex = 0;
    for (uint i = 0; i < s.diffs.length; i++) {
      uint tokenId = s.diffs[i].tokenId;
      AccountCollateral storage col = _collaterals[acct_key][tokenId];
      tokens[tokenIndex++] = TokenSettlement({
        tokenId: tokenId,
        leftReserve: _reserves[leftEntity][tokenId],
        rightReserve: _reserves[rightEntity][tokenId],
        collateral: col.collateral,
        ondelta: col.ondelta
      });
    }
    for (uint i = 0; i < s.forgiveDebtsInTokenIds.length; i++) {
      uint tokenId = s.forgiveDebtsInTokenIds[i];
      bool alreadyIncluded = false;
      for (uint j = 0; j < s.diffs.length; j++) {
        if (s.diffs[j].tokenId == tokenId) alreadyIncluded = true;
      }
      for (uint j = 0; j < i; j++) {
        if (s.forgiveDebtsInTokenIds[j] == tokenId) alreadyIncluded = true;
      }
      if (alreadyIncluded) continue;
      AccountCollateral storage col = _collaterals[acct_key][tokenId];
      tokens[tokenIndex++] = TokenSettlement({
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

    return BatchItemResult.Applied;
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
    // Validate the full signed body and every gas-bound before touching nonce
    // or dispute storage. Reverts roll back anyway, but this ordering also
    // keeps the mutation boundary auditable and prevents hash-only gas bombs.
    _validateInitialDisputeProof(params);
    bytes memory acct_key = _accountKey(entityId, params.counterentity);

    // Intentionally no explicit self-dispute reject here.
    // If an entity signs a dispute against itself, that is treated as a
    // self-inflicted/degenerate workflow rather than a protocol safety issue.
    // We keep the account-key semantics uniform and prefer not to add another
    // branch unless self-dispute becomes a real operational problem.

    // NONCE CHECK: signedNonce > storedNonce (strictly greater)
    if (params.nonce <= _accounts[acct_key].nonce) revert E2();

    require(params.sig.length > 0, "Signature required for dispute");

    bytes32 hash = _disputeProofHankoHash(
      acct_key,
      params.nonce,
      params.proofbodyHash,
      params.initialProofbody.watchSeed
    );
    (bytes32 recoveredEntity, bool valid) = IEntityProvider(entityProvider).verifyHankoSignature(params.sig, hash);
    if (!valid || recoveredEntity != params.counterentity) revert E4();

    if (_accounts[acct_key].disputeHash != bytes32(0)) revert E6();

    uint256 timeout = block.number + defaultDelay;
    uint256 startTimestamp = block.timestamp;
    bool startedByLeft = entityId < params.counterentity;
    bytes32 initialArgumentsCommitment = _argumentCommitment(
      params.starterInitialArguments,
      startedByLeft,
      startTimestamp
    );
    bytes32 incrementedArgumentsCommitment = _argumentCommitment(
      params.starterIncrementedArguments,
      startedByLeft,
      startTimestamp
    );
    _accounts[acct_key].disputeHash = _encodeDisputeHash(
      params.nonce, startedByLeft,
      timeout,
      params.proofbodyHash,
      startTimestamp,
      initialArgumentsCommitment,
      incrementedArgumentsCommitment
    );
    _accounts[acct_key].disputeTimeout = timeout;
    _accounts[acct_key].disputeStartTimestamp = startTimestamp;
    _accounts[acct_key].disputeInitialProofbodyHash = params.proofbodyHash;
    _accounts[acct_key].starterInitialArgumentsCommitment = initialArgumentsCommitment;
    _accounts[acct_key].starterIncrementedArgumentsCommitment = incrementedArgumentsCommitment;
    _accounts[acct_key].disputeStartedByLeft = startedByLeft;

    // SET nonce = signedNonce (any settlement signed at ≤ this nonce is now dead)
    _accounts[acct_key].nonce = params.nonce;

    emit DisputeStarted(
      entityId,
      params.counterentity,
      params.nonce,
      params.proofbodyHash,
      params.initialProofbody.watchSeed,
      params.starterInitialArguments,
      params.starterIncrementedArguments,
      timeout
    );
    return true;
  }

  /**
   * DESIGN DECISION: Dispute finalization stays in Depository.sol
   * Reason: requires deep storage access (debt/reserve interactions)
   */
}
