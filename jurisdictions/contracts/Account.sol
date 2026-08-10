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
    bool proposerIsLeft,
    bytes32 proofbodyHash,
    bytes32 watchSeed,
    bytes starterInitialArguments,
    bytes starterCounterArguments,
    bytes32 starterCounterProofCommitment,
    uint256 disputeTimeout,
    uint256 disputeStartTimestamp,
    uint32 leftResponseSeconds,
    uint32 rightResponseSeconds
  );
  event CounterDisputeRegistered(
    bytes32 indexed sender,
    bytes32 indexed counterentity,
    uint256 indexed nonce,
    bool proposerIsLeft,
    bytes32 proofbodyHash
  );
  event DebtCreated(bytes32 indexed debtor, bytes32 indexed creditor, uint256 indexed tokenId, uint256 amount, uint256 debtIndex);
  event DebtEnforced(bytes32 indexed debtor, bytes32 indexed creditor, uint256 indexed tokenId, uint256 amountPaid, uint256 remainingAmount, uint256 newDebtIndex);
  // This signature intentionally matches Depository's public event ABI. The
  // library executes by DELEGATECALL, so logs are emitted from Depository.
  event TransformerDeltaClamped(
    bytes32 indexed accountKeyHash,
    uint256 indexed clauseIndex,
    address indexed transformer,
    uint256 tokenId,
    int256 requestedValue,
    int256 appliedValue
  );

  // Shared errors (E2..E10, transformer) live in Types.sol.

  uint256 private constant MAX_SETTLEMENT_DIFFS = 32;
  uint256 private constant MAX_SETTLEMENT_FORGIVENESS_IDS = 32;
  uint256 private constant TOKEN_SUPPLY_GAS_LIMIT = 30_000;
  // Runtime heights/nonces are exact JavaScript safe integers. Keep the top
  // representable value reserved for the one unilateral finalization successor
  // so every live Account state remains closable without emitting an unsafe J
  // event. Financial uint256 values are intentionally not subject to this cap.
  function _requireLiveAccountNonce(uint256 nonce) private pure {
    if (nonce >= JS_SAFE_NONCE_MAX) revert E10();
  }

  function _requireStoredAccountNonce(uint256 nonce) private pure {
    if (nonce > JS_SAFE_NONCE_MAX) revert E10();
  }

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

  function addDebt(
    mapping(bytes32 => mapping(uint256 => Debt[])) storage debts,
    mapping(bytes32 => mapping(uint256 => uint256)) storage debtIndex,
    mapping(bytes32 => mapping(uint256 => uint256)) storage debtOutstanding,
    bytes32 debtor,
    uint256 tokenId,
    bytes32 creditor,
    uint256 amount
  ) external {
    if (amount == 0) return;
    uint256 outstanding = debtOutstanding[debtor][tokenId];
    debts[debtor][tokenId].push(Debt({ amount: amount, creditor: creditor }));
    uint256 index = debts[debtor][tokenId].length - 1;
    if (index == 0) debtIndex[debtor][tokenId] = 0;
    debtOutstanding[debtor][tokenId] = outstanding + amount;
    emit DebtCreated(debtor, creditor, tokenId, amount, index);
  }

  /// @notice Enforce one debtor/token FIFO without exposing Depository internals.
  /// @dev This is account-owned queue logic. The mappings remain in Depository
  ///      storage and are reached through DELEGATECALL, preserving the layout.
  function enforceDebts(
    mapping(bytes32 => mapping(uint256 => uint256)) storage reserves,
    mapping(bytes32 => mapping(uint256 => Debt[])) storage debts,
    mapping(bytes32 => mapping(uint256 => uint256)) storage debtIndex,
    mapping(bytes32 => mapping(uint256 => uint256)) storage debtOutstanding,
    mapping(bytes32 => mapping(uint256 => uint256)) storage activeDebtsByToken,
    bytes32 entity,
    uint256 tokenId,
    uint256 maxIterations
  ) external {
    Debt[] storage queue = debts[entity][tokenId];
    uint256 length = queue.length;
    if (length == 0) {
      debtIndex[entity][tokenId] = 0;
      return;
    }

    uint256 cursor = debtIndex[entity][tokenId];
    if (cursor >= length) cursor = 0;
    uint256 available = reserves[entity][tokenId];
    uint256 iterationCap = maxIterations == 0 ? type(uint256).max : maxIterations;
    uint256 steps;

    while (cursor < length && steps < iterationCap) {
      steps++;
      Debt storage debt = queue[cursor];
      uint256 amount = debt.amount;
      if (amount == 0) {
        cursor++;
        continue;
      }
      if (available == 0) break;

      bytes32 creditor = debt.creditor;
      uint256 payableAmount = available < amount ? available : amount;
      _decreaseReserve(reserves, entity, tokenId, payableAmount);
      _increaseReserve(reserves, creditor, tokenId, payableAmount);
      uint256 outstanding = debtOutstanding[entity][tokenId];
      if (outstanding < payableAmount) revert E3();
      unchecked {
        debtOutstanding[entity][tokenId] = outstanding - payableAmount;
      }
      available -= payableAmount;
      amount -= payableAmount;

      uint256 totalPaid = debt.amount - amount;
      if (amount == 0) {
        debt.amount = 0;
        emit DebtEnforced(entity, creditor, tokenId, totalPaid, 0, cursor + 1);
        uint256 active = activeDebtsByToken[entity][tokenId];
        if (active > 0) {
          unchecked {
            activeDebtsByToken[entity][tokenId] = active - 1;
          }
        }
        delete queue[cursor];
        cursor++;
      } else {
        debt.amount = amount;
        emit DebtEnforced(entity, creditor, tokenId, totalPaid, amount, cursor);
      }
    }

    if (cursor >= length) {
      debtIndex[entity][tokenId] = 0;
      delete debts[entity][tokenId];
    } else {
      debtIndex[entity][tokenId] = cursor;
    }
  }

  function increaseReserve(
    mapping(bytes32 => mapping(uint256 => uint256)) storage reserves,
    bytes32 entity,
    uint256 tokenId,
    uint256 amount
  ) external {
    _increaseReserve(reserves, entity, tokenId, amount);
  }

  function _increaseReserve(
    mapping(bytes32 => mapping(uint256 => uint256)) storage reserves,
    bytes32 entity,
    uint256 tokenId,
    uint256 amount
  ) private {
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
    _decreaseReserve(reserves, entity, tokenId, amount);
  }

  /// @notice Exact int256 + int256 as a 257-bit sign/magnitude result.
  /// @dev Account owns signed delta arithmetic; Depository only applies the
  ///      resulting financial effects to collateral/reserve storage.
  function _addSignedInt256(int256 left, int256 right)
    private pure returns (bool negative, uint256 rawSum, bool transformerRepresentable)
  {
    int256 signedSum;
    assembly ("memory-safe") {
      rawSum := add(left, right)
      signedSum := rawSum
    }
    bool leftNegative = left < 0;
    bool rightNegative = right < 0;
    bool sumNegative = signedSum < 0;
    if (leftNegative == rightNegative && leftNegative != sumNegative) {
      if (!leftNegative) return (false, rawSum, false);
      if (rawSum == 0) revert E8();
      return (true, rawSum, false);
    }
    if (!sumNegative) return (false, rawSum, true);
    return (true, rawSum, signedSum != type(int256).min);
  }

  function _decreaseReserve(
    mapping(bytes32 => mapping(uint256 => uint256)) storage reserves,
    bytes32 entity,
    uint256 tokenId,
    uint256 amount
  ) private {
    if (amount == 0) return;
    uint256 current = reserves[entity][tokenId];
    if (current < amount) revert E3();
    reserves[entity][tokenId] = current - amount;
    emit ReserveUpdated(entity, tokenId, current - amount);
  }

  /// @dev Same int256.max ceiling as `_increaseReserve`: collateral feeds RCPAN
  ///      and off-chain signed mirrors, so it must stay representable as int256.
  function _increaseCollateral(AccountCollateral storage col, uint256 amount) private {
    if (amount == 0) return;
    uint256 current = col.collateral;
    uint256 limit = uint256(type(int256).max);
    if (current > limit || amount > limit - current) revert E8();
    col.collateral = current + amount;
  }

  /// @dev Canonical collateral ceiling shared with Depository's direct R2C path.
  function increaseCollateral(AccountCollateral storage col, uint256 amount) external {
    _increaseCollateral(col, amount);
  }

  function _decreaseCollateral(AccountCollateral storage col, uint256 amount) private {
    if (amount == 0) return;
    uint256 current = col.collateral;
    if (current < amount) revert E3();
    col.collateral = current - amount;
  }
  uint256 private constant MAX_DISPUTE_PROOF_BODY_BYTES = 176 * 1024;
  uint256 private constant MAX_DISPUTE_STARTER_ARGUMENT_BYTES = 64 * 1024;
  uint256 private constant MAX_DISPUTE_PROOF_TOKENS = 128;
  uint256 private constant MAX_DISPUTE_TRANSFORMERS = 32;
  // A bilateral pair may intentionally choose zero or a very long response
  // policy. The sole technical guard rejects only an obviously accidental
  // lock longer than one year; there is deliberately no minimum.
  uint256 private constant MAX_DISPUTE_SECONDS = 365 days;
  // The account's left/right entity ids ride every transformer call: the stock
  // DeltaTransformer resolves cross-j pull ratios from the Depository reveal
  // registry keyed by the pull beneficiary, and a transformer must never derive
  // them from untrusted argument bytes.
  bytes4 private constant APPLY_TRANSFORMER_BATCH_SELECTOR =
    bytes4(keccak256("applyBatch(int256[],uint256[],bytes,bytes,bytes,uint256,uint256,bytes32,bytes32,uint256,uint256,uint32,uint32)"));
  bytes4 private constant DECODE_TRANSFORMER_ARGUMENT_LIST_SELECTOR =
    bytes4(keccak256("decodeTransformerArgumentListStrict(bytes)"));
  bytes4 private constant CONTAINS_PULL_SELECTOR = bytes4(keccak256("containsPull(bytes)"));
  uint256 private constant TRANSFORMER_POST_CALL_GAS_RESERVE = 2_000_000;
  uint256 private constant TRANSFORMER_ARGUMENT_DECODE_GAS_LIMIT = 500_000;
  uint256 private constant INT256_SIGN_BIT = 1 << 255;

  // ========== PURE HELPERS ==========

  function _accountKey(bytes32 e1, bytes32 e2) internal pure returns (bytes memory) {
    return e1 < e2 ? abi.encodePacked(e1, e2) : abi.encodePacked(e2, e1);
  }

  function encodeDisputeHash(
    uint nonce, bool startedByLeft,
    bool initialProposerIsLeft,
    uint256 timeout,
    uint32 leftResponseSeconds,
    uint32 rightResponseSeconds,
    bytes32 proofbodyHash,
    uint256 disputeStartTimestamp,
    bytes memory starterInitialArguments,
    bytes memory starterCounterArguments,
    bytes32 starterCounterProofCommitment
  ) external pure returns (bytes32) {
    bytes32 initialCommitment = _argumentCommitment(
      starterInitialArguments,
      startedByLeft,
      disputeStartTimestamp
    );
    bytes32 counterCommitment = _argumentCommitment(
      starterCounterArguments,
      startedByLeft,
      disputeStartTimestamp
    );
    return _encodeDisputeHash(
      nonce,
      startedByLeft,
      initialProposerIsLeft,
      timeout,
      leftResponseSeconds,
      rightResponseSeconds,
      proofbodyHash,
      disputeStartTimestamp,
      initialCommitment,
      counterCommitment,
      starterCounterProofCommitment,
      0,
      bytes32(0),
      false
    );
  }

  function _encodeDisputeHash(
    uint nonce, bool startedByLeft,
    bool initialProposerIsLeft,
    uint256 timeout,
    uint32 leftResponseSeconds,
    uint32 rightResponseSeconds,
    bytes32 proofbodyHash,
    uint256 disputeStartTimestamp,
    bytes32 starterInitialArgumentsCommitment,
    bytes32 starterCounterArgumentsCommitment,
    bytes32 starterCounterProofCommitment,
    uint256 counterNonce,
    bytes32 counterProofbodyHash,
    bool counterProposerIsLeft
  ) internal pure returns (bytes32) {
    return keccak256(abi.encodePacked(
      nonce,
      startedByLeft,
      initialProposerIsLeft,
      timeout,
      leftResponseSeconds,
      rightResponseSeconds,
      proofbodyHash,
      disputeStartTimestamp,
      starterInitialArgumentsCommitment,
      starterCounterArgumentsCommitment,
      starterCounterProofCommitment,
      counterNonce,
      counterProofbodyHash,
      counterProposerIsLeft
    ));
  }

  function _argumentCommitment(
    bytes memory arguments,
    bool startedByLeft,
    uint256 disputeStartTimestamp
  ) internal pure returns (bytes32) {
    return keccak256(abi.encode(arguments, startedByLeft, disputeStartTimestamp));
  }

  function _counterProofCommitment(
    uint256 counterNonce,
    bool counterProposerIsLeft,
    bytes32 counterProofbodyHash
  ) internal pure returns (bytes32) {
    return keccak256(abi.encode(counterNonce, counterProposerIsLeft, counterProofbodyHash));
  }

  function _counterStarterArgumentsCommitment(
    AccountInfo storage account,
    uint256 counterNonce,
    bool counterProposerIsLeft,
    bytes32 counterProofbodyHash
  ) private view returns (bytes32) {
    // The starter can precommit positional evidence for exactly one known
    // newer branch, but must never gain veto power over another valid newer
    // bilateral proof. A different selected branch therefore receives empty
    // starter-side evidence instead of mismatched positional arguments.
    return _counterProofCommitment(
      counterNonce,
      counterProposerIsLeft,
      counterProofbodyHash
    ) == account.starterCounterProofCommitment
      ? account.starterCounterArgumentsCommitment
      : _argumentCommitment("", account.disputeStartedByLeft, account.disputeStartTimestamp);
  }

  function _validateProofBody(ProofBody memory proofbody) private pure returns (bytes32 bodyHash) {
    if (uint256(proofbody.leftResponseSeconds) + uint256(proofbody.rightResponseSeconds) > MAX_DISPUTE_SECONDS) {
      revert E10();
    }
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
    if (_validateProofBody(params.initialProofbody) != params.proofbodyHash) revert IDepositoryDelegateErrorAbi.E9();
    if (params.initialProofbody.watchSeed != params.watchSeed) revert IDepositoryDelegateErrorAbi.E9();
    if (
      params.starterInitialArguments.length + params.starterCounterArguments.length
        > MAX_DISPUTE_STARTER_ARGUMENT_BYTES
    ) revert E10();
  }

  function validateDisputeProofs(
    InitialDisputeProof[] memory disputeStarts,
    CounterDisputeProof[] memory counterDisputes,
    FinalDisputeProof[] memory disputeFinalizations
  ) external pure {
    for (uint256 i = 0; i < disputeStarts.length; i++) {
      _requireLiveAccountNonce(disputeStarts[i].nonce);
      _validateInitialDisputeProof(disputeStarts[i]);
    }
    for (uint256 i = 0; i < counterDisputes.length; i++) {
      _requireLiveAccountNonce(counterDisputes[i].initialNonce);
      _requireLiveAccountNonce(counterDisputes[i].counterNonce);
      _validateProofBody(counterDisputes[i].counterProofbody);
    }
    for (uint256 i = 0; i < disputeFinalizations.length; i++) {
      _requireLiveAccountNonce(disputeFinalizations[i].initialNonce);
      _requireLiveAccountNonce(disputeFinalizations[i].finalNonce);
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
    bool proposerIsLeft,
    bytes32 proofbodyHash,
    bytes32 watchSeed
  ) private view returns (bytes memory) {
    return HankoEncoding.encodeDisputeProof(
      block.chainid,
      address(this),
      acct_key,
      nonce,
      proposerIsLeft,
      proofbodyHash,
      watchSeed
    );
  }

  function _disputeProofHankoHash(
    bytes memory acct_key,
    uint nonce,
    bool proposerIsLeft,
    bytes32 proofbodyHash,
    bytes32 watchSeed
  ) private view returns (bytes32) {
    return keccak256(_encodeDisputeProofHankoPayload(
      acct_key,
      nonce,
      proposerIsLeft,
      proofbodyHash,
      watchSeed
    ));
  }

  // ========== HANKO VERIFICATION ==========

  /// @notice Verify dispute proof with hanko (entity-level signature)
  function verifyDisputeProofHanko(
    address entityProvider,
    bytes memory acct_key,
    uint nonce,
    bool proposerIsLeft,
    bytes32 proofbodyHash,
    bytes32 watchSeed,
    bytes memory hanko,
    bytes32 expectedEntity
  ) private view returns (bool success) {
    bytes32 hash = _disputeProofHankoHash(
      acct_key,
      nonce,
      proposerIsLeft,
      proofbodyHash,
      watchSeed
    );
    // This verifies historical bilateral evidence. Previous-board signatures
    // must remain valid during the grace window or a board rotation could erase
    // an already signed account state before either side can enforce it.
    (bytes32 recoveredEntity, bool valid) = IEntityProvider(entityProvider).verifyHankoSignature(hanko, hash);
    return valid && recoveredEntity == expectedEntity;
  }

  /// @notice Validate a finalization against durable dispute commitments and
  /// return the exact left/right transformer evidence to apply.
  /// @dev Kept in the linked library so the Depository remains deployable under
  /// EIP-170. This function executes by DELEGATECALL over Depository storage.
  /// Signed state (body/hash/nonce) and transformer execution are strict. Only
  /// a malformed dynamic argument wrapper decodes to empty evidence; the signed
  /// transformer then decides whether that evidence is sufficient.
  function prepareDisputeFinalization(
    mapping(bytes => AccountInfo) storage _accounts,
    bytes32 entityId,
    FinalDisputeProof memory params,
    address entityProvider,
    address canonicalDeltaTransformer
  ) external returns (
    bytes memory leftArguments,
    bytes memory rightArguments,
    uint256 leftArgumentsTimestamp,
    uint256 rightArgumentsTimestamp,
    uint256 eventInitialNonce,
    bytes32 finalProofbodyHash,
    uint256 disputeStartTimestamp,
    uint256 disputeTimeout,
    uint32 leftResponseSeconds,
    uint32 rightResponseSeconds
  ) {
    _requireLiveAccountNonce(params.initialNonce);
    _requireLiveAccountNonce(params.finalNonce);
    finalProofbodyHash = _validateProofBody(params.finalProofbody);
    if (
      params.starterArguments.length > MAX_DISPUTE_STARTER_ARGUMENT_BYTES ||
      params.otherArguments.length > MAX_DISPUTE_STARTER_ARGUMENT_BYTES
    ) revert E10();
    bytes memory acct_key = _accountKey(entityId, params.counterentity);
    AccountInfo storage account = _accounts[acct_key];
    _requireStoredAccountNonce(account.nonce);
    uint256 starterArgumentsTimestamp = block.timestamp;
    eventInitialNonce = params.initialNonce;

    // There is one canonical finalization path: an observed dispute followed by
    // either the non-starter's newer jointly signed state or the committed
    // initial state under the timeout rules below. A historical pair of ordinary
    // state signatures is not fresh consent to bypass the challenge window.
    if (params.cooperative) revert E2();
    {
      bytes32 storedHash = account.disputeHash;
      if (storedHash == bytes32(0)) revert IDepositoryDelegateErrorAbi.E5();
      if (params.initialNonce != account.nonce) revert E2();
      if (params.initialProofbodyHash != account.disputeInitialProofbodyHash) revert IDepositoryDelegateErrorAbi.E9();
      if (params.startedByLeft != account.disputeStartedByLeft) revert IDepositoryDelegateErrorAbi.E9();

      bytes32 expectedHash = _encodeDisputeHash(
        account.nonce,
        account.disputeStartedByLeft,
        account.disputeInitialProposerIsLeft,
        account.disputeTimeout,
        account.leftResponseSeconds,
        account.rightResponseSeconds,
        account.disputeInitialProofbodyHash,
        account.disputeStartTimestamp,
        account.starterInitialArgumentsCommitment,
        account.starterCounterArgumentsCommitment,
        account.starterCounterProofCommitment,
        account.disputeCounterNonce,
        account.disputeCounterProofbodyHash,
        account.disputeCounterProposerIsLeft
      );
      if (storedHash != expectedHash) revert IDepositoryDelegateErrorAbi.E9();
      if (
        params.finalProofbody.leftResponseSeconds != account.leftResponseSeconds ||
        params.finalProofbody.rightResponseSeconds != account.rightResponseSeconds
      ) revert IDepositoryDelegateErrorAbi.E9();
      bool senderIsCounterparty = params.startedByLeft != (entityId < params.counterentity);
      // Dynamic `otherArguments` belong exclusively to the non-starter. A
      // starter timing out its own dispute may execute signed logic, but may
      // never impersonate the peer's live fill/secret choices. A delegated
      // watchtower acts under the non-starter Entity and remains authorized.
      if (!senderIsCounterparty && params.otherArguments.length != 0) revert E2();
      bytes32 expectedStarterArgumentsCommitment;
      bool hasSelectedCounterProof = account.disputeCounterNonce != 0;
      if (hasSelectedCounterProof) {
        // A registered response wins state selection before T. At T either
        // party may execute it, but neither may race the obsolete initial body
        // or substitute another newer body at the mining boundary.
        if (block.timestamp < account.disputeTimeout) revert E2();
        if (params.finalNonce != account.disputeCounterNonce) revert E2();
        if (params.proposerIsLeft != account.disputeCounterProposerIsLeft) {
          revert IDepositoryDelegateErrorAbi.E9();
        }
        if (finalProofbodyHash != account.disputeCounterProofbodyHash) {
          revert IDepositoryDelegateErrorAbi.E9();
        }
        // Counter registration already verified the exact body identity under
        // the starter's inner Hanko and the non-starter's fresh outer Hanko.
        // Requiring that inner signature again against the *finalizer's*
        // counterentity would let the registering non-starter disappear and
        // lock the Account forever. After T either current-board outer caller
        // may execute the stored identity; no second inner authority exists.
        // `sig` is deliberately ignored here: one watchtower transaction can
        // land on either side of T and must carry it for pre-T registration,
        // while the post-T selected path has already authenticated it.
        expectedStarterArgumentsCommitment = _counterStarterArgumentsCommitment(
          account,
          params.finalNonce,
          params.proposerIsLeft,
          finalProofbodyHash
        );
      } else if (params.sig.length > 0) {
        // The starter necessarily holds older counterparty signatures. Letting
        // the starter submit one here would turn any stale N+1 into an immediate
        // close and deny the counterparty its window to reveal N+2. The outer
        // batch signature therefore must belong to the non-starter.
        if (!senderIsCounterparty) revert E2();
        if (params.finalNonce < account.nonce) revert E2();
        if (
          params.finalNonce == account.nonce &&
          (!params.proposerIsLeft || account.disputeInitialProposerIsLeft)
        ) revert E2();
        if (!verifyDisputeProofHanko(
          entityProvider,
          acct_key,
          params.finalNonce,
          params.proposerIsLeft,
          finalProofbodyHash,
          params.finalProofbody.watchSeed,
          params.sig,
          params.counterentity
        )) revert E4();
        // Pull-free mutual consent still closes immediately. A newer state
        // containing Pulls must have been locked by processCounterDisputes
        // before T; accepting it for the first time at T would recreate the
        // exact miner-ordering race this lock exists to remove.
        if (_proofBodyContainsPull(params.finalProofbody, canonicalDeltaTransformer)) revert E2();
        expectedStarterArgumentsCommitment = _counterStarterArgumentsCommitment(
          account,
          params.finalNonce,
          params.proposerIsLeft,
          finalProofbodyHash
        );
      } else {
        if (params.finalNonce != account.nonce) revert E2();
        if (params.proposerIsLeft != account.disputeInitialProposerIsLeft) {
          revert IDepositoryDelegateErrorAbi.E9();
        }
        if (finalProofbodyHash != account.disputeInitialProofbodyHash) revert IDepositoryDelegateErrorAbi.E9();
        // The starter has no fresh response from the non-starter and must wait.
        // The non-starter may immediately accept the exact state the starter
        // chose. Pull still forces both callers to wait for reveal publication.
        if (
          block.timestamp < account.disputeTimeout &&
          (
            !senderIsCounterparty ||
            _proofBodyContainsPull(params.finalProofbody, canonicalDeltaTransformer)
          )
        ) revert E2();
        expectedStarterArgumentsCommitment = account.starterInitialArgumentsCommitment;
      }

      if (
        _argumentCommitment(
          params.starterArguments,
          account.disputeStartedByLeft,
          account.disputeStartTimestamp
        ) != expectedStarterArgumentsCommitment
      ) revert IDepositoryDelegateErrorAbi.E9();
      starterArgumentsTimestamp = account.disputeStartTimestamp;
      eventInitialNonce = account.nonce;
    }

    leftArguments = params.startedByLeft ? params.starterArguments : params.otherArguments;
    rightArguments = params.startedByLeft ? params.otherArguments : params.starterArguments;
    leftArgumentsTimestamp = block.timestamp;
    rightArgumentsTimestamp = block.timestamp;
    if (params.startedByLeft) {
      leftArgumentsTimestamp = starterArgumentsTimestamp;
    } else {
      rightArgumentsTimestamp = starterArgumentsTimestamp;
    }

    // Capture the dispute clock BEFORE clearing. applyPull validates both the
    // lower bound (this dispute's start) and the signed role-specific upper
    // bound; finalization uses the signed sum of the two response windows.
    disputeStartTimestamp = account.disputeStartTimestamp;
    disputeTimeout = account.disputeTimeout;
    leftResponseSeconds = account.leftResponseSeconds;
    rightResponseSeconds = account.rightResponseSeconds;

    // Publish no partially-cleared dispute state. Any later failure reverts the
    // entire processBatch transaction and restores these fields atomically.
    account.disputeHash = bytes32(0);
    account.disputeTimeout = 0;
    account.disputeStartTimestamp = 0;
    account.leftResponseSeconds = 0;
    account.rightResponseSeconds = 0;
    account.disputeInitialProofbodyHash = bytes32(0);
    account.disputeInitialProposerIsLeft = false;
    account.disputeCounterNonce = 0;
    account.disputeCounterProofbodyHash = bytes32(0);
    account.disputeCounterProposerIsLeft = false;
    account.starterInitialArgumentsCommitment = bytes32(0);
    account.starterCounterArgumentsCommitment = bytes32(0);
    account.starterCounterProofCommitment = bytes32(0);
    account.disputeStartedByLeft = false;
  }

  /// @dev Pull is a protocol semantic of the immutable canonical
  /// DeltaTransformer only. Arbitrary signed transformers do not gain an
  /// implicit delay merely by using a similar private ABI. Conversely, a
  /// malformed canonical batch cannot masquerade as pull-free: the strict
  /// decoder failure is converted into the same fatal transformer error used
  /// during execution, leaving the active dispute untouched.
  function _proofBodyContainsPull(ProofBody memory proofbody, address canonicalDeltaTransformer)
    private
    view
    returns (bool)
  {
    for (uint256 i = 0; i < proofbody.transformers.length; i++) {
      TransformerClause memory clause = proofbody.transformers[i];
      if (clause.transformerAddress != canonicalDeltaTransformer) continue;
      (bool ok, bytes memory result) = canonicalDeltaTransformer.staticcall(
        abi.encodeWithSelector(CONTAINS_PULL_SELECTOR, clause.encodedBatch)
      );
      if (!ok || result.length != 32) {
        revert IDepositoryDelegateErrorAbi.TransformerExecutionFailed();
      }
      if (abi.decode(result, (bool))) return true;
    }
    return false;
  }

  /// @notice Execute one user-signed transformer clause.
  /// @dev A transformer is the executable meaning of the signed dispute state,
  /// not optional evidence. Missing code, revert/OOG, or malformed output must
  /// revert the whole finalization and leave the dispute active. We forward all
  /// remaining gas except the fixed Depository settlement reserve.
  function _applyTransformer(
    int[] memory deltas,
    uint[] memory tokenIds,
    TransformerClause memory tc,
    bytes memory leftArguments,
    bytes memory rightArguments,
    uint256 leftArgumentsTimestamp,
    uint256 rightArgumentsTimestamp,
    bytes32 leftEntity,
    bytes32 rightEntity,
    uint256 disputeStartTimestamp,
    uint256 disputeTimeout,
    uint32 leftResponseSeconds,
    uint32 rightResponseSeconds
  ) private view returns (int[] memory newDeltas) {
    if (tc.transformerAddress.code.length == 0) revert IDepositoryDelegateErrorAbi.TransformerExecutionFailed();
    if (tc.encodedBatch.length + leftArguments.length + rightArguments.length >> 18 != 0) {
      revert IDepositoryDelegateErrorAbi.TransformerExecutionFailed();
    }

    bytes memory callData = abi.encodeWithSelector(
      APPLY_TRANSFORMER_BATCH_SELECTOR,
      deltas,
      tokenIds,
      tc.encodedBatch,
      leftArguments,
      rightArguments,
      leftArgumentsTimestamp,
      rightArgumentsTimestamp,
      leftEntity,
      rightEntity,
      disputeStartTimestamp,
      disputeTimeout,
      leftResponseSeconds,
      rightResponseSeconds
    );
    uint256 remainingGas = gasleft();
    if (remainingGas <= TRANSFORMER_POST_CALL_GAS_RESERVE) revert IDepositoryDelegateErrorAbi.TransformerGasBudgetUnavailable();
    uint256 callGas = remainingGas - TRANSFORMER_POST_CALL_GAS_RESERVE;

    bool callOk;
    uint256 returnSize;
    address transformer = tc.transformerAddress;
    assembly ("memory-safe") {
      callOk := staticcall(callGas, transformer, add(callData, 0x20), mload(callData), 0, 0)
      returnSize := returndatasize()
    }
    if (!callOk) {
      // The cross-j reveal-window barrier and a missing registry are scheduling
      // and evidence conditions, not transformer faults. Bubble them verbatim
      // so operators and the runtime's finalize scheduler see the true reason
      // instead of a generic execution failure. Every other transformer
      // failure still collapses to TransformerExecutionFailed.
      if (returnSize >= 4) {
        bytes memory reason = new bytes(returnSize);
        assembly ("memory-safe") {
          returndatacopy(add(reason, 0x20), 0, returnSize)
        }
        bytes4 reasonSelector;
        assembly ("memory-safe") {
          reasonSelector := mload(add(reason, 0x20))
        }
        if (
          reasonSelector == DeltaTransformer.PullRevealWindowActive.selector ||
          reasonSelector == DeltaTransformer.PullRevealRegistryUnavailable.selector
        ) {
          assembly ("memory-safe") {
            revert(add(reason, 0x20), returnSize)
          }
        }
      }
      revert IDepositoryDelegateErrorAbi.TransformerExecutionFailed();
    }

    uint256 expectedReturnSize = 0x40 + deltas.length * 0x20;
    if (returnSize != expectedReturnSize) revert IDepositoryDelegateErrorAbi.TransformerExecutionFailed();

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
    if (arrayOffset != 0x20 || arrayLength != deltas.length) revert IDepositoryDelegateErrorAbi.TransformerExecutionFailed();

    newDeltas = new int[](arrayLength);
    for (uint256 i = 0; i < arrayLength; i++) {
      int256 value;
      assembly ("memory-safe") {
        value := mload(add(add(returnData, 0x60), mul(i, 0x20)))
      }
      newDeltas[i] = value;
    }
    return newDeltas;
  }

  function _applyTransformers(
    bytes32 accountKeyHash,
    ProofBody memory proofbody,
    int[] memory deltas,
    bool exactTransformerInputs,
    bytes memory leftArguments,
    bytes memory rightArguments,
    uint256 leftArgumentsTimestamp,
    uint256 rightArgumentsTimestamp,
    bytes32 leftEntity,
    bytes32 rightEntity,
    address argumentDecoder,
    uint256 disputeStartTimestamp,
    uint256 disputeTimeout,
    uint32 leftResponseSeconds,
    uint32 rightResponseSeconds
  ) private returns (int[] memory) {
    if (proofbody.transformers.length == 0) return deltas;
    // The transformer ABI is int256[]. A wide signed-magnitude base delta has
    // no truthful ABI value; substituting zero or saturation would execute a
    // different contract than the parties signed.
    if (!exactTransformerInputs) revert IDepositoryDelegateErrorAbi.TransformerExecutionFailed();
    bytes[] memory decodedLeft = _decodeTransformerArgumentList(leftArguments, argumentDecoder);
    bytes[] memory decodedRight = _decodeTransformerArgumentList(rightArguments, argumentDecoder);
    for (uint256 i = 0; i < proofbody.transformers.length; i++) {
      TransformerClause memory tc = proofbody.transformers[i];
      if (!_validTransformerAllowances(tc.allowances, deltas.length)) {
        revert IDepositoryDelegateErrorAbi.TransformerExecutionFailed();
      }

      int[] memory newDeltas = _applyTransformer(
        deltas,
        proofbody.tokenIds,
        tc,
        i < decodedLeft.length ? decodedLeft[i] : bytes(""),
        i < decodedRight.length ? decodedRight[i] : bytes(""),
        leftArgumentsTimestamp,
        rightArgumentsTimestamp,
        leftEntity,
        rightEntity,
        disputeStartTimestamp,
        disputeTimeout,
        leftResponseSeconds,
        rightResponseSeconds
      );

      for (uint256 j = 0; j < deltas.length; j++) {
        if (newDeltas[j] != deltas[j] && !_hasTransformerAllowance(tc.allowances, j)) {
          revert IDepositoryDelegateErrorAbi.TransformerExecutionFailed();
        }
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

  /// @notice Derive the exact bilateral settlement deltas before custody effects.
  /// @dev Account owns signed delta arithmetic and execution of every transformer
  ///      clause signed in ProofBody. Depository consumes only the resulting
  ///      signed-magnitude values when moving collateral, reserves, and debt.
  function prepareSettlementDeltas(
    mapping(bytes => mapping(uint256 => AccountCollateral)) storage collaterals,
    bytes memory acctKey,
    ProofBody memory proofbody,
    bytes memory leftArguments,
    bytes memory rightArguments,
    uint256 leftArgumentsTimestamp,
    uint256 rightArgumentsTimestamp,
    bytes32 leftEntity,
    bytes32 rightEntity,
    address argumentDecoder,
    uint256 disputeStartTimestamp,
    uint256 disputeTimeout,
    uint32 leftResponseSeconds,
    uint32 rightResponseSeconds
  ) external returns (int[] memory deltas, uint256 negativeDeltaBitmap) {
    uint256 tokenCount = proofbody.tokenIds.length;
    deltas = new int[](tokenCount);
    bool exactTransformerInputs = true;
    for (uint256 i = 0; i < tokenCount; i++) {
      uint256 tokenId = proofbody.tokenIds[i];
      if (i > 0 && proofbody.tokenIds[i - 1] >= tokenId) revert E8();
      (bool negative, uint256 rawDelta, bool representable) = _addSignedInt256(
        collaterals[acctKey][tokenId].ondelta,
        proofbody.offdeltas[i]
      );
      assembly ("memory-safe") {
        mstore(add(add(deltas, 0x20), mul(i, 0x20)), rawDelta)
      }
      if (negative) negativeDeltaBitmap |= 1 << i;
      if (!representable) exactTransformerInputs = false;
    }

    // Every signed clause must execute. Missing code, revert/OOG, malformed
    // output, or invalid allowances revert the entire dispute finalization.
    deltas = _applyTransformers(
      keccak256(acctKey),
      proofbody,
      deltas,
      exactTransformerInputs,
      leftArguments,
      rightArguments,
      leftArgumentsTimestamp,
      rightArgumentsTimestamp,
      leftEntity,
      rightEntity,
      argumentDecoder,
      disputeStartTimestamp,
      disputeTimeout,
      leftResponseSeconds,
      rightResponseSeconds
    );

    // A transformer requires exact int256 inputs, so after successful execution
    // every returned value can be classified directly by its sign.
    if (exactTransformerInputs) {
      negativeDeltaBitmap = 0;
      for (uint256 i = 0; i < tokenCount; i++) {
        if (deltas[i] < 0) negativeDeltaBitmap |= 1 << i;
      }
    }
  }

  function _decodeTransformerArgumentList(bytes memory encoded, address argumentDecoder) private view returns (bytes[] memory) {
    if (encoded.length == 0) return new bytes[](0);
    if (encoded.length >> 18 != 0) return new bytes[](0);
    // Malformed evidence is optional and decodes to an empty list. Insufficient
    // caller gas is different: it must never silently erase otherwise valid
    // evidence and thereby change the settlement result.
    if (gasleft() <= TRANSFORMER_POST_CALL_GAS_RESERVE + TRANSFORMER_ARGUMENT_DECODE_GAS_LIMIT) {
      revert IDepositoryDelegateErrorAbi.TransformerGasBudgetUnavailable();
    }
    (bool ok, bytes memory result) = argumentDecoder.staticcall{
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

    if (_accounts[acct_key].disputeHash != bytes32(0)) revert IDepositoryDelegateErrorAbi.E6();

    _requireStoredAccountNonce(_accounts[acct_key].nonce);
    _requireLiveAccountNonce(c2r.nonce);
    // NONCE CHECK: signedNonce > storedNonce (strictly greater)
    if (c2r.nonce <= _accounts[acct_key].nonce) revert E2();

    uint amount = c2r.amount;
    if (amount > uint256(type(int256).max)) revert E8();
    int256 signedAmount = int256(amount);

    // Reconstruct diffs for signature verification (C2R is a calldata shortcut).
    // Every financial delta lives in the signed int256 domain. Checking before
    // conversion is consensus-critical: uint256 -> int256 otherwise wraps.
    SettlementDiff[] memory diffs = new SettlementDiff[](1);
    diffs[0] = SettlementDiff({
      tokenId: c2r.tokenId,
      leftDiff: isLeft ? signedAmount : int256(0),
      rightDiff: isLeft ? int256(0) : signedAmount,
      collateralDiff: -signedAmount,
      ondeltaDiff: isLeft ? -signedAmount : int256(0)
    });

    // Verify counterparty signature (hash includes signedNonce, not storedNonce)
    bytes32 hash = _cooperativeUpdateHankoHash(acct_key, c2r.nonce, diffs, new uint[](0));

    // C2R authorizes a fresh movement of funds, not historical evidence. A
    // rotated-out board must never retain spending authority during its grace.
    (bytes32 recoveredEntity, bool valid) = IEntityProvider(entityProvider).verifyCurrentHankoSignature(c2r.sig, hash);
    if (!valid || recoveredEntity != c2r.counterparty) {
      return BatchItemResult.InvalidSignature;
    }

    // Apply diffs
    uint tokenId = c2r.tokenId;
    AccountCollateral storage col = _collaterals[acct_key][tokenId];
    if (col.collateral < amount) return BatchItemResult.InsufficientBalance;

    _increaseReserve(_reserves, entityId, tokenId, amount);
    _decreaseCollateral(col, amount);
    if (isLeft) {
      col.ondelta -= signedAmount;
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
    address entityProvider
  ) external returns (bool completeSuccess) {
    completeSuccess = true;
    for (uint i = 0; i < disputeStarts.length; i++) {
      if (!_disputeStart(_accounts, entityId, disputeStarts[i], entityProvider)) {
        completeSuccess = false;
      }
    }
  }

  /// @notice Lock the highest mutually signed counter-proof before T.
  /// @dev This is deliberately separate from finalization. Pull settlement
  /// cannot execute before its reveal window closes, but rejecting the newer
  /// proof until T would let the starter race an obsolete proof at T. The
  /// compact nonce+hash lock removes that race without extending the dispute.
  function processCounterDisputes(
    mapping(bytes => AccountInfo) storage _accounts,
    bytes32 entityId,
    CounterDisputeProof[] memory counterDisputes,
    address entityProvider
  ) external {
    for (uint256 i = 0; i < counterDisputes.length; i++) {
      _registerCounterDispute(_accounts, entityId, counterDisputes[i], entityProvider);
    }
  }

  /// @dev Compact tower adapter kept in the linked library so Depository stays
  /// below EIP-170. Returns false at/after T, when Depository must execute the
  /// already-selected proof instead of registering it.
  function registerWatchtowerCounterDispute(
    mapping(bytes => AccountInfo) storage _accounts,
    bytes32 watchtowerDomainSeparator,
    address tower,
    bytes32 entityId,
    FinalDisputeProof memory params,
    uint256 lastResortWindowSeconds,
    uint256 appointmentSequence,
    bytes memory ownerAuthorizationHanko,
    address entityProvider
  ) external returns (bool) {
    bytes memory acctKey = _accountKey(entityId, params.counterentity);
    AccountInfo storage account = _accounts[acctKey];
    _requireStoredAccountNonce(account.nonce);
    if (account.disputeHash == bytes32(0)) revert IDepositoryDelegateErrorAbi.E5();
    if (params.cooperative || params.sig.length == 0) revert E2();
    if (
      lastResortWindowSeconds == 0 ||
      lastResortWindowSeconds > account.disputeTimeout - account.disputeStartTimestamp ||
      block.timestamp + lastResortWindowSeconds < account.disputeTimeout
    ) revert E2();
    bool ownerIsNonstarter = account.disputeStartedByLeft != (entityId < params.counterentity);
    if (!ownerIsNonstarter) revert E2();
    if (
      params.finalNonce < account.nonce ||
      (
        params.finalNonce == account.nonce &&
        (!params.proposerIsLeft || account.disputeInitialProposerIsLeft)
      )
    ) revert E2();
    bytes32 finalProofbodyHash = keccak256(abi.encode(params.finalProofbody));
    bytes32 ownerHash = keccak256(HankoEncoding.encodeWatchtowerCounterDispute(
      watchtowerDomainSeparator,
      block.chainid,
      address(this),
      tower,
      entityId,
      params.counterentity,
      params.finalNonce,
      finalProofbodyHash,
      lastResortWindowSeconds,
      appointmentSequence
    ));
    (bytes32 recoveredEntity, bool valid) =
      IEntityProvider(entityProvider).verifyCurrentHankoSignature(ownerAuthorizationHanko, ownerHash);
    if (!valid || recoveredEntity != entityId) revert E4();
    if (block.timestamp >= account.disputeTimeout) return false;
    _registerCounterDispute(
      _accounts,
      entityId,
      CounterDisputeProof({
        counterentity: params.counterentity,
        initialNonce: params.initialNonce,
        initialProofbodyHash: params.initialProofbodyHash,
        counterNonce: params.finalNonce,
        proposerIsLeft: params.proposerIsLeft,
        counterProofbody: params.finalProofbody,
        sig: params.sig
      }),
      entityProvider
    );
    return true;
  }

  function _registerCounterDispute(
    mapping(bytes => AccountInfo) storage _accounts,
    bytes32 entityId,
    CounterDisputeProof memory params,
    address entityProvider
  ) private {
    _requireLiveAccountNonce(params.initialNonce);
    _requireLiveAccountNonce(params.counterNonce);
    bytes32 bodyHash = _validateProofBody(params.counterProofbody);
    bytes memory acctKey = _accountKey(entityId, params.counterentity);
    AccountInfo storage account = _accounts[acctKey];
    if (account.disputeHash == bytes32(0)) revert IDepositoryDelegateErrorAbi.E5();
    if (block.timestamp >= account.disputeTimeout) revert E2();
    if (params.initialNonce != account.nonce) revert E2();
    if (params.initialProofbodyHash != account.disputeInitialProofbodyHash) {
      revert IDepositoryDelegateErrorAbi.E9();
    }
    if (
      params.counterProofbody.leftResponseSeconds != account.leftResponseSeconds ||
      params.counterProofbody.rightResponseSeconds != account.rightResponseSeconds
    ) revert IDepositoryDelegateErrorAbi.E9();
    bool senderIsNonstarter = account.disputeStartedByLeft != (entityId < params.counterentity);
    if (!senderIsNonstarter) revert E2();
    if (params.counterNonce < account.nonce) revert E2();
    if (params.counterNonce == account.nonce) {
      // Equal nonce is not automatically stale: bilateral consensus resolves
      // simultaneous branches by LEFT proposer priority. Only a LEFT proof may
      // replace a RIGHT initial proof at the same nonce.
      if (!params.proposerIsLeft || account.disputeInitialProposerIsLeft) revert E2();
    }
    if (!verifyDisputeProofHanko(
      entityProvider,
      acctKey,
      params.counterNonce,
      params.proposerIsLeft,
      bodyHash,
      params.counterProofbody.watchSeed,
      params.sig,
      params.counterentity
    )) revert E4();

    uint256 selectedNonce = account.disputeCounterNonce;
    if (selectedNonce != 0) {
      if (params.counterNonce < selectedNonce) revert E2();
      if (params.counterNonce == selectedNonce) {
        if (params.proposerIsLeft != account.disputeCounterProposerIsLeft) {
          if (!params.proposerIsLeft) revert E2();
          // LEFT replaces RIGHT at equal nonce; continue to the atomic update.
        } else if (bodyHash != account.disputeCounterProofbodyHash) {
          revert IDepositoryDelegateErrorAbi.E9();
        } else {
          return;
        }
      }
    }
    account.disputeCounterNonce = params.counterNonce;
    account.disputeCounterProofbodyHash = bodyHash;
    account.disputeCounterProposerIsLeft = params.proposerIsLeft;
    account.disputeHash = _encodeDisputeHash(
      account.nonce,
      account.disputeStartedByLeft,
      account.disputeInitialProposerIsLeft,
      account.disputeTimeout,
      account.leftResponseSeconds,
      account.rightResponseSeconds,
      account.disputeInitialProofbodyHash,
      account.disputeStartTimestamp,
      account.starterInitialArgumentsCommitment,
      account.starterCounterArgumentsCommitment,
      account.starterCounterProofCommitment,
      params.counterNonce,
      bodyHash,
      params.proposerIsLeft
    );
    emit CounterDisputeRegistered(
      entityId,
      params.counterentity,
      params.counterNonce,
      params.proposerIsLeft,
      bodyHash
    );
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

    if (_accounts[acct_key].disputeHash != bytes32(0)) revert IDepositoryDelegateErrorAbi.E6();

    if (s.diffs.length > MAX_SETTLEMENT_DIFFS) revert E10();
    if (s.forgiveDebtsInTokenIds.length > MAX_SETTLEMENT_FORGIVENESS_IDS) revert E10();
    for (uint j = 0; j < s.diffs.length; j++) {
      for (uint k = 0; k < j; k++) {
        if (s.diffs[j].tokenId == s.diffs[k].tokenId) revert E2();
      }
    }
    for (uint j = 0; j < s.forgiveDebtsInTokenIds.length; j++) {
      for (uint k = 0; k < j; k++) {
        if (s.forgiveDebtsInTokenIds[j] == s.forgiveDebtsInTokenIds[k]) revert E2();
      }
    }

    _requireStoredAccountNonce(_accounts[acct_key].nonce);
    _requireLiveAccountNonce(s.nonce);
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

    // Cooperative settlement creates a fresh financial state, so only the
    // counterparty's current board may authorize it. Historical board grace is
    // reserved for dispute evidence below.
    try IEntityProvider(entityProvider).verifyCurrentHankoSignature(s.sig, hash) returns (bytes32 recoveredEntity, bool valid) {
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

    // Apply diffs through the same int256.max-capped reserve helpers used by
    // mint/deposit/R2R/C2R. Raw `+=` here used to let a settlement drain two
    // buckets into one and push the target above int256.max (pragma 0.8 still
    // panics at 2^256, but the off-chain signed model would already disagree).
    // Helpers emit ReserveUpdated once — do not re-emit around these calls.
    for (uint j = 0; j < s.diffs.length; j++) {
      SettlementDiff memory diff = s.diffs[j];
      uint tokenId = diff.tokenId;

      if (diff.leftDiff < 0) {
        _decreaseReserve(_reserves, leftEntity, tokenId, uint(-diff.leftDiff));
      } else if (diff.leftDiff > 0) {
        _increaseReserve(_reserves, leftEntity, tokenId, uint(diff.leftDiff));
      }

      if (diff.rightDiff < 0) {
        _decreaseReserve(_reserves, rightEntity, tokenId, uint(-diff.rightDiff));
      } else if (diff.rightDiff > 0) {
        _increaseReserve(_reserves, rightEntity, tokenId, uint(diff.rightDiff));
      }

      AccountCollateral storage col = _collaterals[acct_key][tokenId];
      if (diff.collateralDiff < 0) {
        _decreaseCollateral(col, uint(-diff.collateralDiff));
      } else if (diff.collateralDiff > 0) {
        _increaseCollateral(col, uint(diff.collateralDiff));
      }
      col.ondelta += diff.ondeltaDiff;
    }

    // SET nonce = signedNonce (not +1)
    _accounts[acct_key].nonce = s.nonce;

    // Every successful nonce transition must be observable. A pure debt
    // forgiveness has no diffs, but it still invalidates old proofs and must
    // therefore publish AccountSettled with snapshots for the forgiven tokens.
    // Compute forgiveness dedup once; the emission pass must reuse it so the
    // AccountSettled payload stays byte-identical to the previous dual-scan.
    uint tokenCount = s.diffs.length;
    bool[] memory alreadyIncluded = new bool[](s.forgiveDebtsInTokenIds.length);
    for (uint i = 0; i < s.forgiveDebtsInTokenIds.length; i++) {
      uint forgiveTokenId = s.forgiveDebtsInTokenIds[i];
      bool included = false;
      for (uint j = 0; j < s.diffs.length; j++) {
        if (s.diffs[j].tokenId == forgiveTokenId) included = true;
      }
      for (uint j = 0; j < i; j++) {
        if (s.forgiveDebtsInTokenIds[j] == forgiveTokenId) included = true;
      }
      alreadyIncluded[i] = included;
      if (!included) tokenCount++;
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
      if (alreadyIncluded[i]) continue;
      uint tokenId = s.forgiveDebtsInTokenIds[i];
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
    address entityProvider
  ) internal returns (bool) {
    // Validate the full signed body and every gas-bound before touching nonce
    // or dispute storage. Reverts roll back anyway, but this ordering also
    // keeps the mutation boundary auditable and prevents hash-only gas bombs.
    _requireLiveAccountNonce(params.nonce);
    _validateInitialDisputeProof(params);
    bytes memory acct_key = _accountKey(entityId, params.counterentity);

    // Intentionally no explicit self-dispute reject here.
    // If an entity signs a dispute against itself, that is treated as a
    // self-inflicted/degenerate workflow rather than a protocol safety issue.
    // We keep the account-key semantics uniform and prefer not to add another
    // branch unless self-dispute becomes a real operational problem.

    _requireStoredAccountNonce(_accounts[acct_key].nonce);
    // NONCE CHECK: signedNonce > storedNonce (strictly greater)
    if (params.nonce <= _accounts[acct_key].nonce) revert E2();

    bool startedByLeft = entityId < params.counterentity;
    // The proof author is consensus data, not a caller hint. The current
    // processBatch Hanko authenticates entityId, while the inner historical
    // Hanko binds this bit into the bilateral proof. Both must identify the
    // same proposer or equal-nonce LEFT priority could be forged.

    require(params.sig.length > 0, "Signature required for dispute");

    bytes32 hash = _disputeProofHankoHash(
      acct_key,
      params.nonce,
      params.proposerIsLeft,
      params.proofbodyHash,
      params.initialProofbody.watchSeed
    );
    // The outer processBatch Hanko is current-board-only. This inner Hanko is
    // historical bilateral evidence held by the counterparty, so the current or
    // immediate previous board remains provable for the exact seven-day grace.
    //
    // This is a deliberate asymmetric trade-off, not an oversight. Both sides
    // of it are real and neither can be removed without paying for the other:
    //
    //   grace on  - a quorum of an entity's *retired* board can, for seven
    //               days, sign a proofbody against any counterparty account it
    //               can pair with. The damage is not capped by that account's
    //               collateral: Depository._settleShortfall drains the debtor's
    //               reserves and books the remainder as debt. Nonce choice is
    //               free, so a near-maximum nonce additionally denies the
    //               victim any counter-proof, because finalization requires
    //               finalNonce > account.nonce.
    //
    //   grace off - an entity repudiates every obligation it ever signed simply
    //               by rotating its board, because all outstanding evidence
    //               against it stops verifying at once. For a hub that is every
    //               user it ever promised anything to, unilaterally and free.
    //
    // Grace stays on because the second attack is broader, cheaper, and needs
    // no collusion: one innocent-looking rotation dumps the entire counterparty
    // set, while the first needs a retired quorum, a funded account with the
    // victim, and action inside the window. Seven days is kept because it is a
    // widely understood revocation horizon and long enough for a counterparty
    // to observe a rotation and force its state on-chain.
    //
    // A counterparty that does not trust an entity's retired board must force
    // its latest state within boardChangeDelay instead of relying on this path.
    // Do not narrow this to verifyCurrentHankoSignature without first replacing
    // the repudiation defence it provides.
    (bytes32 recoveredEntity, bool valid) =
      IEntityProvider(entityProvider).verifyHankoSignature(params.sig, hash);
    if (!valid || recoveredEntity != params.counterentity) revert E4();

    if (_accounts[acct_key].disputeHash != bytes32(0)) revert IDepositoryDelegateErrorAbi.E6();

    uint256 startTimestamp = block.timestamp;
    uint32 leftResponseSeconds = params.initialProofbody.leftResponseSeconds;
    uint32 rightResponseSeconds = params.initialProofbody.rightResponseSeconds;
    uint256 timeout = startTimestamp + uint256(leftResponseSeconds) + uint256(rightResponseSeconds);
    bytes32 initialArgumentsCommitment = _argumentCommitment(
      params.starterInitialArguments,
      startedByLeft,
      startTimestamp
    );
    bytes32 counterArgumentsCommitment = _argumentCommitment(
      params.starterCounterArguments,
      startedByLeft,
      startTimestamp
    );
    _accounts[acct_key].disputeHash = _encodeDisputeHash(
      params.nonce, startedByLeft,
      params.proposerIsLeft,
      timeout,
      leftResponseSeconds,
      rightResponseSeconds,
      params.proofbodyHash,
      startTimestamp,
      initialArgumentsCommitment,
      counterArgumentsCommitment,
      params.starterCounterProofCommitment,
      0,
      bytes32(0),
      false
    );
    _accounts[acct_key].disputeTimeout = timeout;
    _accounts[acct_key].disputeStartTimestamp = startTimestamp;
    _accounts[acct_key].leftResponseSeconds = leftResponseSeconds;
    _accounts[acct_key].rightResponseSeconds = rightResponseSeconds;
    _accounts[acct_key].disputeInitialProofbodyHash = params.proofbodyHash;
    _accounts[acct_key].disputeInitialProposerIsLeft = params.proposerIsLeft;
    _accounts[acct_key].disputeCounterNonce = 0;
    _accounts[acct_key].disputeCounterProofbodyHash = bytes32(0);
    _accounts[acct_key].disputeCounterProposerIsLeft = false;
    _accounts[acct_key].starterInitialArgumentsCommitment = initialArgumentsCommitment;
    _accounts[acct_key].starterCounterArgumentsCommitment = counterArgumentsCommitment;
    _accounts[acct_key].starterCounterProofCommitment = params.starterCounterProofCommitment;
    _accounts[acct_key].disputeStartedByLeft = startedByLeft;

    // SET nonce = signedNonce (any settlement signed at ≤ this nonce is now dead)
    _accounts[acct_key].nonce = params.nonce;

    emit DisputeStarted(
      entityId,
      params.counterentity,
      params.nonce,
      params.proposerIsLeft,
      params.proofbodyHash,
      params.initialProofbody.watchSeed,
      params.starterInitialArguments,
      params.starterCounterArguments,
      params.starterCounterProofCommitment,
      timeout,
      startTimestamp,
      leftResponseSeconds,
      rightResponseSeconds
    );
    return true;
  }

  /**
   * DESIGN DECISION: Dispute finalization stays in Depository.sol
   * Reason: requires deep storage access (debt/reserve interactions)
   */
}
