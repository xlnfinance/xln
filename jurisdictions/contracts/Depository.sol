// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "./EntityProvider.sol";
import "./DeltaTransformer.sol";
import "./Types.sol";
import "./Account.sol";
import "./HankoEncoding.sol";

abstract contract ReentrancyGuardLite {
  error E0();
  uint256 private constant _NOT_ENTERED = 1;
  uint256 private constant _ENTERED = 2;
  uint256 private _status = _NOT_ENTERED;

  modifier nonReentrant() {
    if (_status == _ENTERED) revert E0();
    _status = _ENTERED;
    _;
    _status = _NOT_ENTERED;
  }
}

interface IERC20 {
  function transfer(address to, uint256 value) external returns (bool);
  function transferFrom(address from, address to, uint256 value) external returns (bool);
  function balanceOf(address account) external view returns (uint256);
}
interface IERC721 {
  function transferFrom(address from, address to, uint256 tokenId) external;
}
// IERC1155 already defined in @openzeppelin/contracts (imported via EntityProvider.sol)

contract Depository is ReentrancyGuardLite {
  struct ReserveMint {
    bytes32 entity;
    uint tokenId;
    uint amount;
  }


  // Custom errors
  error E1(); // ZeroAmount
  error E2(); // Unauthorized
  error E3(); // InsufficientBalance
  error E4(); // InvalidSigner
  error E5(); // NoActiveDispute
  error E6(); // DisputeInProgress
  error E7(); // InvalidParty
  error E8(); // LengthMismatch
  error E9(); // HashMismatch
  error E10(); // BatchTooLarge
  error E11(); // UnsupportedToken

  // Immutable EntityProvider (set in constructor, gas-efficient static calls)
  address public immutable entityProvider;

  mapping (bytes32 => mapping (uint => uint)) public _reserves;

  mapping (bytes => AccountInfo) public _accounts;
  mapping (bytes => mapping(uint => AccountCollateral)) public _collaterals;

  // Immutable dispute timeout policy.
  // Delay selection is agreed off-chain and baked into the deployed jurisdiction,
  // not tuned via mutable admin setters.
  // Fixed dispute window policy. Local tests fast-forward blocks explicitly;
  // production deployments must not ship with a minutes-long challenge window.
  uint256 public immutable defaultDisputeDelay;
  

  mapping (bytes32 => mapping (uint => Debt[])) public _debts;
  // the current debt index to pay
  mapping (bytes32 => mapping (uint => uint)) public _debtIndex;
  // total reserve locked by unpaid debt, scoped by debtor and token
  mapping (bytes32 => mapping (uint => uint)) public debtOutstanding;
  // total number of active debts of an entity for a token
  mapping (bytes32 => mapping (uint => uint)) public _activeDebtsByToken;


  address public immutable admin;
  uint256 private constant LOCAL_DEV_CHAIN_ID = 31337;
  uint256 private constant SECONDARY_LOCAL_DEV_CHAIN_ID = 31338;
  uint256 private constant DEBT_ENFORCEMENT_CHUNK = 32;
  uint256 private constant MAX_BATCH_FLASHLOANS = 8;
  uint256 private constant MAX_BATCH_RESERVE_TO_RESERVE = 64;
  uint256 private constant MAX_BATCH_RESERVE_TO_COLLATERAL = 64;
  uint256 private constant MAX_BATCH_COLLATERAL_TO_RESERVE = 64;
  uint256 private constant MAX_BATCH_SETTLEMENTS = 32;
  uint256 private constant MAX_BATCH_DISPUTE_STARTS = 8;
  uint256 private constant MAX_BATCH_DISPUTE_FINALIZATIONS = 8;
  uint256 private constant MAX_BATCH_EXTERNAL_TO_RESERVE = 64;
  uint256 private constant MAX_BATCH_RESERVE_TO_EXTERNAL = 64;
  uint256 private constant MAX_BATCH_SECRET_REVEALS = 32;
  uint256 private constant MAX_BATCH_TOTAL_OPS = 50;
  // EIP-7623 charges a 40-gas floor per non-zero calldata byte. A 256 KiB
  // batch therefore leaves ~4.5M execution gas inside the protocol's 15M-gas
  // liveness envelope; transformer calls dynamically yield to that reserve.
  uint256 private constant MAX_ENCODED_BATCH_BYTES = 256 * 1024;
  uint256 private constant MAX_RESERVE_TO_COLLATERAL_PAIRS = 64;
  // Runtime permits up to 1,000 open swaps in one account proof. The canonical
  // DeltaTransformer path is regression-tested below this cap; hostile code is
  // still unable to consume the caller's post-call finalization reserve.
  // `length >> 18 != 0` below is the bytecode-cheap 256 KiB allocation cap.
  // A party can otherwise make ABI encoding run out of gas before STATICCALL,
  // where neither its call gas cap nor try/catch can preserve finalization.
  event DebtCreated(bytes32 indexed debtor, bytes32 indexed creditor, uint256 indexed tokenId, uint256 amount, uint256 debtIndex);
  event DebtEnforced(bytes32 indexed debtor, bytes32 indexed creditor, uint256 indexed tokenId, uint256 amountPaid, uint256 remainingAmount, uint256 newDebtIndex);
  event DebtForgiven(bytes32 indexed debtor, bytes32 indexed creditor, uint256 indexed tokenId, uint256 amountForgiven, uint256 debtIndex);
  enum TransformerSkipReason {
    None,
    NoCode,
    InsufficientGas,
    CallFailed,
    MalformedReturn,
    InvalidAllowance,
    UnallowedMutation,
    UnrepresentableBaseDelta
  }
  event TransformerClauseSkipped(
    bytes32 indexed accountKeyHash,
    uint256 indexed clauseIndex,
    address indexed transformer,
    TransformerSkipReason reason
  );
  event TransformerDeltaClamped(
    bytes32 indexed accountKeyHash,
    uint256 indexed clauseIndex,
    address indexed transformer,
    uint256 tokenId,
    int256 requestedValue,
    int256 appliedValue
  );

  modifier onlyLocalDevAdmin() {
    if (
      msg.sender != admin ||
      (block.chainid != LOCAL_DEV_CHAIN_ID && block.chainid != SECONDARY_LOCAL_DEV_CHAIN_ID)
    ) revert E2();
    _;
  }

  modifier onlyAdmin() {
    if (msg.sender != admin) revert E2();
    _;
  }

  // EntityScore tracking removed for size reduction
  // Hub tracking removed for size reduction

  // Events related to disputes and cooperative closures
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
  event DisputeFinalized(bytes32 indexed sender, bytes32 indexed counterentity, uint indexed nonce, bytes32 initialProofbodyHash, bytes32 finalProofbodyHash);
  event CooperativeClose(bytes32 indexed sender, bytes32 indexed counterentity, uint indexed nonce);

  // ═══════════════════════════════════════════════════════════════════════════
  // CANONICAL J-EVENTS (Single Source of Truth - must match j-event-watcher.ts)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // These events are the ONLY events that j-watcher processes for entity state.
  // Each event type has exactly ONE purpose:
  //
  // ReserveUpdated  - Entity reserve balance changed (mint, R2R, settlement)
  // AccountSettled  - Bilateral account state changed (in Account.sol)
  //
  // REMOVED (redundant):
  // - ReserveMinted: redundant with ReserveUpdated (newBalance is sufficient)
  // - ReserveTransferred: redundant with 2x ReserveUpdated (one per entity)
  // - SettlementProcessed: duplicate of AccountSettled
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * @notice Emitted whenever an entity's reserve balance changes.
   * @dev This is THE canonical event for reserve state. Covers: mint, R2R, settlement.
   *      j-watcher uses this to set entity.reserves[tokenId] = newBalance
   * @param entity The entity whose reserve was updated.
   * @param tokenId The internal ID of the token.
   * @param newBalance The absolute new balance of the token for the entity.
   */
  event ReserveUpdated(bytes32 indexed entity, uint indexed tokenId, uint newBalance);
  event SecretRevealed(bytes32 indexed hashlock, bytes32 indexed revealer, bytes32 secret);
  event TokenRegistered(uint256 indexed tokenId, uint8 tokenType, address indexed contractAddress, uint96 externalTokenId);

  //event ChannelUpdated(address indexed receiver, address indexed addr, uint tokenId);


  uint8 constant TypeERC20 = 0;
  uint8 constant TypeERC721 = 1;
  uint8 constant TypeERC1155 = 2;

  struct TokenMetadata {
    address contractAddress;
    uint96 externalTokenId;
    uint8 tokenType;
  }

  TokenMetadata[] public _tokens;
  
  // Efficient token lookup: packedToken -> internalTokenId
  mapping(bytes32 => uint256) public tokenToId;

  constructor(address _entityProvider, uint256 _defaultDisputeDelay) {
    if (_entityProvider == address(0) || _defaultDisputeDelay == 0 || _defaultDisputeDelay > 65_535) revert E7();
    entityProvider = _entityProvider;
    defaultDisputeDelay = _defaultDisputeDelay;
    admin = msg.sender;
    _tokens.push(TokenMetadata({ contractAddress: address(0), externalTokenId: 0, tokenType: TypeERC20 }));
  }

  function decodeTransformerArgumentListStrict(bytes calldata encoded) external pure returns (bytes[] memory) {
    return abi.decode(encoded, (bytes[]));
  }

  function getTokensLength() public view returns (uint) {
    return _tokens.length;
  }

  function registerExternalToken(uint8 tokenType, address contractAddress, uint96 externalTokenId)
    external
    onlyAdmin
    returns (uint256 tokenId)
  {
    return _registerExternalToken(tokenType, contractAddress, externalTokenId);
  }

  function _registerExternalToken(uint8 tokenType, address contractAddress, uint96 externalTokenId)
    private
    returns (uint256 tokenId)
  {
    if (tokenType > TypeERC1155 || contractAddress.code.length == 0) revert E11();
    (, bool validSupply) = Account.readFixedTokenSupply(tokenType, contractAddress, externalTokenId);
    if (!validSupply) revert E11();
    bytes32 packedToken = _packTokenReference(tokenType, contractAddress, externalTokenId);
    tokenId = tokenToId[packedToken];
    if (tokenId != 0) return tokenId;

    _tokens.push(TokenMetadata({
      contractAddress: contractAddress,
      externalTokenId: externalTokenId,
      tokenType: tokenType
    }));
    tokenId = _tokens.length - 1;
    tokenToId[packedToken] = tokenId;
    emit TokenRegistered(tokenId, tokenType, contractAddress, externalTokenId);
  }

  function _safeERC20Call(address token, bytes memory data) private {
    (bool success, bytes memory returndata) = token.call(data);
    if (!success) revert E3();
    if (returndata.length == 0) return;
    if (returndata.length < 32 || !abi.decode(returndata, (bool))) revert E3();
  }

  function _safeERC20TransferFrom(address token, address from, address to, uint256 amount) private {
    _safeERC20Call(token, abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount));
  }

  function _safeERC20Transfer(address token, address to, uint256 amount) private {
    _safeERC20Call(token, abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
  }


  // Batch struct is in Types.sol
  // === HANKO INTEGRATION ===

  /// @notice Sequential nonce for each entity authorising batches via Hanko.
  mapping(bytes32 => uint256) public entityNonces;

  /// @notice Domain separator used when hashing Hanko payloads for verification.
  bytes32 public constant DOMAIN_SEPARATOR = keccak256("XLN_DEPOSITORY_HANKO_V1");
  bytes32 public constant WATCHTOWER_COUNTER_DISPUTE_DOMAIN_SEPARATOR =
    keccak256("XLN_WATCHTOWER_COUNTER_DISPUTE_V1");

  event BatchOperationSkipped(
    bytes32 indexed entityId,
    bytes32 indexed batchHash,
    uint256 indexed nonce,
    BatchOperationType operationType,
    uint256 operationIndex,
    BatchSkipReason reason
  );
  event HankoBatchProcessed(bytes32 indexed entityId, bytes32 indexed batchHash, uint256 nonce);
  event WatchtowerCounterDisputeExecuted(
    address indexed tower,
    bytes32 indexed entityId,
    bytes32 indexed counterentity,
    uint256 finalNonce,
    uint256 appointmentSequence
  );

  /// @notice Process a batch authorized by entity Hanko.
  /// @dev This is the canonical production write path.
  ///      Depository is bound to a single immutable EntityProvider at deploy time.
  function processBatch(
    bytes calldata encodedBatch,
    bytes calldata hankoData,
    uint256 nonce
  ) external nonReentrant returns (bool completeSuccess) {
    if (encodedBatch.length > MAX_ENCODED_BATCH_BYTES) revert E10();
    Batch memory batch = abi.decode(encodedBatch, (Batch));
    _assertBatchBounds(batch);
    Account.validateDisputeProofs(batch.disputeStarts, batch.disputeFinalizations);
    bytes32 batchHash = Account.computeBatchHankoHash(DOMAIN_SEPARATOR, encodedBatch, nonce);
    (bytes32 entityId, bool hankoValid) =
      EntityProvider(entityProvider).verifyCurrentHankoSignature(
        hankoData,
        batchHash
      );
    if (!hankoValid || entityId == bytes32(0)) revert E4();
    if (nonce != entityNonces[entityId] + 1) revert E2();
    entityNonces[entityId] = nonce;
    completeSuccess = _processBatch(entityId, batch, batchHash, nonce);
    if (!completeSuccess) revert E4();
    emit HankoBatchProcessed(entityId, batchHash, nonce);
  }

  /// @notice Hash that an entity authorizes for a tower-only delayed counter-dispute.
  /// @dev The authorization is exact: tower address, account side, counterparty, final nonce,
  ///      proof-body hash, last-resort window, and appointment sequence are all bound.
  function _encodeWatchtowerCounterDisputeHankoPayload(
    address tower,
    bytes32 entityId,
    bytes32 counterentity,
    uint256 finalNonce,
    bytes32 finalProofbodyHash,
    uint256 lastResortWindowBlocks,
    uint256 appointmentSequence
  ) private view returns (bytes memory) {
    return HankoEncoding.encodeWatchtowerCounterDispute(
      WATCHTOWER_COUNTER_DISPUTE_DOMAIN_SEPARATOR,
      block.chainid,
      address(this),
      tower,
      entityId,
      counterentity,
      finalNonce,
      finalProofbodyHash,
      lastResortWindowBlocks,
      appointmentSequence
    );
  }

  function computeWatchtowerCounterDisputeHash(
    address tower,
    bytes32 entityId,
    bytes32 counterentity,
    uint256 finalNonce,
    bytes32 finalProofbodyHash,
    uint256 lastResortWindowBlocks,
    uint256 appointmentSequence
  ) public view returns (bytes32) {
    return keccak256(_encodeWatchtowerCounterDisputeHankoPayload(
      tower,
      entityId,
      counterentity,
      finalNonce,
      finalProofbodyHash,
      lastResortWindowBlocks,
      appointmentSequence
    ));
  }

  /// @notice Delegated last-resort counter-dispute for a designated watchtower.
  /// @dev This path is intentionally narrower than processBatch():
  ///      - tower may only submit newer signed counter-disputes
  ///      - tower may never start disputes
  ///      - tower may never use unilateral timeout finalize
  ///      - tower may never act before the final last-resort window
  function watchtowerCounterDispute(
    bytes32 entityId,
    FinalDisputeProof calldata params,
    uint256 lastResortWindowBlocks,
    uint256 appointmentSequence,
    bytes calldata ownerAuthorizationHanko
  ) external nonReentrant returns (bool) {
    if (msg.data.length > MAX_ENCODED_BATCH_BYTES) revert E10();
    bytes memory acct_key = accountKey(entityId, params.counterentity);
    AccountInfo storage account = _accounts[acct_key];

    if (account.disputeHash == bytes32(0)) revert E5();
    if (params.cooperative) revert E2();
    if (params.sig.length == 0) revert E2();
    if (lastResortWindowBlocks == 0) revert E2();
    if (params.finalNonce <= account.nonce) revert E2();
    if (block.number + lastResortWindowBlocks < account.disputeTimeout) revert E2();

    bytes32 finalProofbodyHash = keccak256(abi.encode(params.finalProofbody));
    (bytes32 recoveredEntity, bool valid) =
      EntityProvider(entityProvider).verifyCurrentHankoSignature(
        ownerAuthorizationHanko,
        computeWatchtowerCounterDisputeHash(
          msg.sender,
          entityId,
          params.counterentity,
          params.finalNonce,
          finalProofbodyHash,
          lastResortWindowBlocks,
          appointmentSequence
        )
      );
    if (!valid || recoveredEntity != entityId) revert E4();

    _disputeFinalizeInternal(entityId, params);
    emit WatchtowerCounterDisputeExecuted(
      msg.sender,
      entityId,
      params.counterentity,
      params.finalNonce,
      appointmentSequence
    );
    return true;
  }

  /**
   * @notice Mint new reserves to an entity (local dev admin only).
   * @dev Local Anvil bootstrap helper. Mainnet/testnet deployments must fund reserves
   *      through processBatch() deposits or a governance-controlled production path.
   * @param entity The entity receiving the minted reserves.
   * @param tokenId The internal token ID.
   * @param amount The amount to mint.
   */
  function mintToReserve(bytes32 entity, uint tokenId, uint amount) external onlyLocalDevAdmin {
    if (amount == 0) revert E1();
    _increaseReserve(entity, tokenId, amount);
  }

  function _assertBatchBounds(Batch memory batch) private pure {
    // Runtime already chunks J-batches at 50 top-level operations. Mirroring
    // that cap on-chain keeps authorized-but-gas-hostile batches from relying
    // only on per-array limits that are individually valid but too large in sum.
    if (
      batch.flashloans.length +
      batch.reserveToReserve.length +
      batch.reserveToCollateral.length +
      batch.collateralToReserve.length +
      batch.settlements.length +
      batch.disputeStarts.length +
      batch.disputeFinalizations.length +
      batch.externalTokenToReserve.length +
      batch.reserveToExternalToken.length +
      batch.revealSecrets.length > MAX_BATCH_TOTAL_OPS
    ) revert E10();

    if (batch.flashloans.length > MAX_BATCH_FLASHLOANS) revert E10();
    if (batch.reserveToReserve.length > MAX_BATCH_RESERVE_TO_RESERVE) revert E10();
    if (batch.reserveToCollateral.length > MAX_BATCH_RESERVE_TO_COLLATERAL) revert E10();
    if (batch.collateralToReserve.length > MAX_BATCH_COLLATERAL_TO_RESERVE) revert E10();
    if (batch.settlements.length > MAX_BATCH_SETTLEMENTS) revert E10();
    if (batch.disputeStarts.length > MAX_BATCH_DISPUTE_STARTS) revert E10();
    if (batch.disputeFinalizations.length > MAX_BATCH_DISPUTE_FINALIZATIONS) revert E10();
    if (batch.externalTokenToReserve.length > MAX_BATCH_EXTERNAL_TO_RESERVE) revert E10();
    if (batch.reserveToExternalToken.length > MAX_BATCH_RESERVE_TO_EXTERNAL) revert E10();
    if (batch.revealSecrets.length > MAX_BATCH_SECRET_REVEALS) revert E10();

    for (uint i = 0; i < batch.reserveToCollateral.length; i++) {
      if (batch.reserveToCollateral[i].pairs.length > MAX_RESERVE_TO_COLLATERAL_PAIRS) revert E10();
    }
  }

  function _processBatch(
    bytes32 entityId,
    Batch memory batch,
    bytes32 batchHash,
    uint256 nonce
  ) private returns (bool completeSuccess) {
    // SECURITY FIX: Aggregate flashloans by tokenId (prevent duplicate tokenId exploit)
    uint256[] memory flashloanTokenIds = new uint256[](batch.flashloans.length);
    uint256[] memory flashloanStarting = new uint256[](batch.flashloans.length);
    uint256[] memory flashloanTotals = new uint256[](batch.flashloans.length);
    uint uniqueCount = 0;

    // Aggregate flashloans per tokenId
    for (uint i = 0; i < batch.flashloans.length; i++) {
      uint tid = batch.flashloans[i].tokenId;
      uint amt = batch.flashloans[i].amount;

      // Find if this tokenId already seen
      uint j = 0;
      for (; j < uniqueCount; j++) {
        if (flashloanTokenIds[j] == tid) break;
      }

      // New tokenId - record starting reserve
      if (j == uniqueCount) {
        flashloanTokenIds[uniqueCount] = tid;
        flashloanStarting[uniqueCount] = _reserves[entityId][tid];
        uniqueCount++;
      }

      // Accumulate total for this tokenId
      flashloanTotals[j] += amt;
    }

    // Grant aggregated flashloans (flash-mint)
    for (uint j = 0; j < uniqueCount; j++) {
      _increaseReserve(entityId, flashloanTokenIds[j], flashloanTotals[j]);
    }

    // the order is important: first go methods that increase entity's balance
    // then methods that deduct from it

    completeSuccess = true;

    // Process external token deposits (increases reserves).
    // params.entity == 0 means "credit batch initiator"; otherwise the
    // signer explicitly authorises depositing into another entity reserve.
    for (uint i = 0; i < batch.externalTokenToReserve.length; i++) {
      ExternalTokenToReserve memory params = batch.externalTokenToReserve[i];
      if (params.entity == bytes32(0)) {
        params.entity = entityId;
      }
      _externalTokenToReserve(params);
    }

    // Process reserveToReserve transfers (the core functionality we need)
    for (uint i = 0; i < batch.reserveToReserve.length; i++) {
      if (!_reserveToReserve(entityId, batch.reserveToReserve[i])) {
        _emitInsufficientBalanceSkip(entityId, batchHash, nonce, BatchOperationType.ReserveToReserve, i);
      }
    }

    // C2R shortcut: direct processing (no Settlement[] allocation)
    // Pure C2R = withdraw `amount` from my share of collateral to my reserve
    for (uint i = 0; i < batch.collateralToReserve.length; i++) {
      BatchItemResult c2rResult =
        Account.processC2R(_reserves, _accounts, _collaterals, entityId, batch.collateralToReserve[i], entityProvider);
      if (c2rResult == BatchItemResult.InvalidSignature) revert E4();
      if (c2rResult == BatchItemResult.InsufficientBalance) {
        _emitInsufficientBalanceSkip(entityId, batchHash, nonce, BatchOperationType.CollateralToReserve, i);
      }
    }

    // Delegate settlement diffs to Account library, handle debt forgiveness in Depository
    if (batch.settlements.length > 0) {
      _enforceSettlementOutflowDebts(batch.settlements);
      BatchItemResult[] memory settlementResults = Account.processSettlements(
        _reserves,
        debtOutstanding,
        _accounts,
        _collaterals,
        entityId,
        batch.settlements,
        entityProvider
      );
      // Handle debt forgiveness (not in Account due to stack limits)
      for (uint i = 0; i < batch.settlements.length; i++) {
        if (settlementResults[i] == BatchItemResult.InvalidSignature) revert E4();
        if (settlementResults[i] == BatchItemResult.InsufficientBalance) {
          _emitInsufficientBalanceSkip(entityId, batchHash, nonce, BatchOperationType.Settlement, i);
          continue;
        }
        Settlement memory s = batch.settlements[i];
        for (uint j = 0; j < s.forgiveDebtsInTokenIds.length; j++) {
          uint tokenId = s.forgiveDebtsInTokenIds[j];
          _forgiveDebtsBetweenEntities(s.leftEntity, s.rightEntity, tokenId);
          _forgiveDebtsBetweenEntities(s.rightEntity, s.leftEntity, tokenId);
        }
      }
    }

    if (batch.disputeStarts.length > 0) {
      if (!Account.processDisputeStarts(_accounts, entityId, batch.disputeStarts, defaultDisputeDelay, entityProvider)) {
        completeSuccess = false;
      }
    }

    // HTLC secret reveals (must run before dispute finalizations)
    for (uint i = 0; i < batch.revealSecrets.length; i++) {
      SecretReveal memory reveal = batch.revealSecrets[i];
      if (reveal.transformer == address(0)) revert E2();
      DeltaTransformer(reveal.transformer).revealSecret(reveal.secret);
      emit SecretRevealed(keccak256(abi.encode(reveal.secret)), entityId, reveal.secret);
    }

    // Dispute finalizations stay in Depository (too many storage refs for Account)
    for (uint i = 0; i < batch.disputeFinalizations.length; i++) {
      _disputeFinalizeInternal(entityId, batch.disputeFinalizations[i]);
    }

    for (uint i = 0; i < batch.reserveToCollateral.length; i++) {
      if(!(_reserveToCollateral(entityId, batch.reserveToCollateral[i]))){
        _emitInsufficientBalanceSkip(entityId, batchHash, nonce, BatchOperationType.ReserveToCollateral, i);
      }
    }

    // Process external token withdrawals (decreases reserves)
    // Security: batch initiator can only withdraw from their own reserves
    for (uint i = 0; i < batch.reserveToExternalToken.length; i++) {
      if (!_reserveToExternalToken(entityId, batch.reserveToExternalToken[i])) {
        _emitInsufficientBalanceSkip(entityId, batchHash, nonce, BatchOperationType.ReserveToExternalToken, i);
      }
    }

    // SECURITY FIX: Check aggregated flashloan return + burn
    for (uint j = 0; j < uniqueCount; j++) {
      uint tid = flashloanTokenIds[j];
      uint expectedFinal = flashloanStarting[j] + flashloanTotals[j];

      // Check entity returned borrowed amount
      if (_reserves[entityId][tid] < expectedFinal) revert E3(); // Flashloan not returned

      // Burn flashloan (remove temporary mint)
      _decreaseReserve(entityId, tid, flashloanTotals[j]);

      // Final check: reserves back to original or higher
      if (_reserves[entityId][tid] < flashloanStarting[j]) revert E3(); // Reserve decreased
    }

    return completeSuccess;

  }

  function _emitInsufficientBalanceSkip(
    bytes32 entityId,
    bytes32 batchHash,
    uint256 nonce,
    BatchOperationType operationType,
    uint256 operationIndex
  ) private {
    emit BatchOperationSkipped(
      entityId,
      batchHash,
      nonce,
      operationType,
      operationIndex,
      BatchSkipReason.InsufficientBalance
    );
  }

  // MessageType enum is in Types.sol

  // ReserveToCollateral and EntityAmount (was AddrAmountPair) are in Types.sol


  // Allowance, TransformerClause, ProofBody, InitialDisputeProof, FinalDisputeProof, Debt are in Types.sol

  // DebtSnapshot moved to DepositoryView.sol

  function _addDebt(bytes32 debtor, uint256 tokenId, bytes32 creditor, uint256 amount) internal {
    if (creditor == bytes32(0)) revert E2();
    if (debtor == creditor) revert E2();
    if (amount == 0) revert E1();
    Account.addDebt(
      _debts,
      _debtIndex,
      debtOutstanding,
      debtor,
      tokenId,
      creditor,
      amount
    );
    _activeDebtsByToken[debtor][tokenId]++;
  }

  function _afterDebtCleared(bytes32 entity, uint256 tokenId) internal {
    if (_activeDebtsByToken[entity][tokenId] > 0) {
      unchecked {
        _activeDebtsByToken[entity][tokenId]--;
      }
    }
  }

  function _reduceDebtOutstanding(bytes32 entity, uint256 tokenId, uint256 amount) internal {
    if (amount == 0) return;
    uint256 outstanding = debtOutstanding[entity][tokenId];
    if (outstanding < amount) revert E3();
    unchecked {
      debtOutstanding[entity][tokenId] = outstanding - amount;
    }
  }

  function _spendableReserve(bytes32 entity, uint256 tokenId) internal view returns (uint256) {
    uint256 reserve = _reserves[entity][tokenId];
    uint256 outstanding = debtOutstanding[entity][tokenId];
    return reserve > outstanding ? reserve - outstanding : 0;
  }

  function _enforceSettlementOutflowDebts(Settlement[] memory settlements) private {
    for (uint i = 0; i < settlements.length; i++) {
      Settlement memory s = settlements[i];
      for (uint j = 0; j < s.diffs.length; j++) {
        SettlementDiff memory diff = s.diffs[j];
        if (diff.leftDiff < 0) enforceDebts(s.leftEntity, diff.tokenId, DEBT_ENFORCEMENT_CHUNK);
        if (diff.rightDiff < 0) enforceDebts(s.rightEntity, diff.tokenId, DEBT_ENFORCEMENT_CHUNK);
      }
    }
  }

  function _packTokenReference(uint8 tokenType, address contractAddress, uint96 externalTokenId) private pure returns (bytes32) {
    return keccak256(abi.encode(tokenType, contractAddress, externalTokenId));
  }

  // registerHub removed for size reduction

  // ExternalTokenToReserve struct is in Types.sol
  // Local Anvil bootstrap helper. User deposits must go through processBatch().
  function adminRegisterExternalToken(ExternalTokenToReserve memory params) external onlyLocalDevAdmin nonReentrant {
    params.internalTokenId = _registerExternalToken(
      params.tokenType,
      params.contractAddress,
      params.externalTokenId
    );
    _externalTokenToReserve(params);
  }

  // Internal version for batch processing (already inside nonReentrant context)
  function _externalTokenToReserve(ExternalTokenToReserve memory params) internal {
    bytes32 targetEntity = params.entity == bytes32(0) ? bytes32(uint256(uint160(msg.sender))) : params.entity;
    if (params.amount == 0) revert E1();

    bytes32 packedToken = _packTokenReference(params.tokenType, params.contractAddress, params.externalTokenId);

    if (params.internalTokenId == 0) {
      params.internalTokenId = tokenToId[packedToken];
      if (params.internalTokenId == 0) revert E11();
    } else {
      TokenMetadata memory meta = _tokens[params.internalTokenId];
      params.contractAddress = meta.contractAddress;
      params.externalTokenId = meta.externalTokenId;
      params.tokenType = meta.tokenType;
    }

    if (params.tokenType == TypeERC20) {
      uint256 balanceBefore = IERC20(params.contractAddress).balanceOf(address(this));
      _safeERC20TransferFrom(params.contractAddress, msg.sender, address(this), params.amount);
      uint256 balanceAfter = IERC20(params.contractAddress).balanceOf(address(this));
      params.amount = balanceAfter - balanceBefore;
      if (params.amount == 0) revert E3();
    } else if (params.tokenType == TypeERC721) {
      IERC721(params.contractAddress).transferFrom(msg.sender, address(this), uint(params.externalTokenId));
      params.amount = 1;
    } else if (params.tokenType == TypeERC1155) {
      IERC1155(params.contractAddress).safeTransferFrom(msg.sender, address(this), uint(params.externalTokenId), params.amount, "");
    }

    _increaseReserve(targetEntity, params.internalTokenId, params.amount);
  }


  // ReserveToExternalToken struct is in Types.sol
  function _reserveToExternalToken(bytes32 entity, ReserveToExternalToken memory params) internal returns (bool) {
    if (params.amount == 0) revert E1();
    enforceDebts(entity, params.tokenId, DEBT_ENFORCEMENT_CHUNK);

    TokenMetadata memory meta = _tokens[params.tokenId];
    if (params.amount > _spendableReserve(entity, params.tokenId)) return false;
    if (uint256(params.receivingEntity) > type(uint160).max) revert E2();
    address recipient = address(uint160(uint256(params.receivingEntity)));
    if (meta.tokenType == TypeERC721 && params.amount != 1) revert E1();
    _decreaseReserve(entity, params.tokenId, params.amount);

    if (meta.tokenType == TypeERC20) {
      uint256 senderBalanceBefore = IERC20(meta.contractAddress).balanceOf(address(this));
      uint256 recipientBalanceBefore = IERC20(meta.contractAddress).balanceOf(recipient);
      _safeERC20Transfer(meta.contractAddress, recipient, params.amount);
      uint256 senderBalanceAfter = IERC20(meta.contractAddress).balanceOf(address(this));
      uint256 recipientBalanceAfter = IERC20(meta.contractAddress).balanceOf(recipient);
      if (
        senderBalanceBefore < params.amount ||
        senderBalanceAfter != senderBalanceBefore - params.amount ||
        recipientBalanceAfter < recipientBalanceBefore ||
        recipientBalanceAfter - recipientBalanceBefore != params.amount
      ) revert E11();
    } else if (meta.tokenType == TypeERC721) {
      IERC721(meta.contractAddress).transferFrom(address(this), recipient, uint(meta.externalTokenId));
    } else if (meta.tokenType == TypeERC1155) {
      IERC1155(meta.contractAddress).safeTransferFrom(address(this), recipient, uint(meta.externalTokenId), params.amount, "");
    }
    return true;
  }
  // ReserveToReserve struct is in Types.sol
  function _reserveToReserve(bytes32 entity, ReserveToReserve memory params) internal returns (bool) {
    enforceDebts(entity, params.tokenId, DEBT_ENFORCEMENT_CHUNK);
    if (params.amount > _spendableReserve(entity, params.tokenId)) return false;
    _decreaseReserve(entity, params.tokenId, params.amount);
    _increaseReserve(params.receivingEntity, params.tokenId, params.amount);
    return true;
  }

  // FIFO debt enforcement. `maxIterations == 0` drains without a slot cap.
  function enforceDebts(bytes32 entity, uint256 tokenId, uint256 maxIterations) public {
    Debt[] storage queue = _debts[entity][tokenId];
    uint256 length = queue.length;
    if (length == 0) {
      _debtIndex[entity][tokenId] = 0;
      return;
    }

    uint256 cursor = _debtIndex[entity][tokenId];
    if (cursor >= length) {
      cursor = 0;
    }

    uint256 available = _reserves[entity][tokenId];
    uint256 iterationCap = maxIterations == 0 ? type(uint256).max : maxIterations;
    uint256 steps = 0;

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

      _decreaseReserve(entity, tokenId, payableAmount);
      _increaseReserve(creditor, tokenId, payableAmount);
      _reduceDebtOutstanding(entity, tokenId, payableAmount);
      available -= payableAmount;
      amount -= payableAmount;

      // Update debt state
      uint256 totalPaid = debt.amount - amount;
      if (amount == 0) {
        debt.amount = 0;
        emit DebtEnforced(entity, creditor, tokenId, totalPaid, 0, cursor + 1);
        _afterDebtCleared(entity, tokenId);
        delete queue[cursor];
        cursor++;
      } else {
        debt.amount = amount;
        emit DebtEnforced(entity, creditor, tokenId, totalPaid, debt.amount, cursor);
      }
    }

    if (cursor >= length) {
      _debtIndex[entity][tokenId] = 0;
      delete _debts[entity][tokenId];
      return;
    }
    _debtIndex[entity][tokenId] = cursor;
  }



  function accountKey(bytes32 e1, bytes32 e2) public pure returns (bytes memory) {
    return e1 < e2 ? abi.encodePacked(e1, e2) : abi.encodePacked(e2, e1);
  }

  function _reserveToCollateral(bytes32 entity, ReserveToCollateral memory params) internal returns (bool completeSuccess) {
    uint tokenId = params.tokenId;
    bytes32 receivingEntity = params.receivingEntity;
   
    // debts must be paid before any transfers from reserve 
    enforceDebts(entity, tokenId, DEBT_ENFORCEMENT_CHUNK);

    uint256 totalAmount = 0;
    for (uint i = 0; i < params.pairs.length; i++) {
      uint256 amount = params.pairs[i].amount;
      if (amount > uint256(type(int256).max)) revert E8();
      totalAmount += amount;
    }
    if (totalAmount > _spendableReserve(entity, tokenId)) return false;

    for (uint i = 0; i < params.pairs.length; i++) {
      bytes32 counterentity = params.pairs[i].entity;
      uint amount = params.pairs[i].amount;

      bytes memory acct_key = accountKey(receivingEntity, counterentity);

      
        AccountCollateral storage col = _collaterals[acct_key][tokenId];
        int256 signedAmount = int256(amount);

        _decreaseReserve(entity, tokenId, amount);
        col.collateral += amount;
        if (receivingEntity < counterentity) { // if receiver is left
          col.ondelta += signedAmount;
        }

        // Emit unionified AccountSettled event (canonical ordering: left < right)
        bytes32 leftEntity = receivingEntity < counterentity ? receivingEntity : counterentity;
        bytes32 rightEntity = receivingEntity < counterentity ? counterentity : receivingEntity;

        // R2C doesn't increment nonce (no bilateral signature required)
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
          nonce: _accounts[accountKey(leftEntity, rightEntity)].nonce
        });
        emit Account.AccountSettled(settled);
    }


    return true;
  }



  function _forgiveDebtsBetweenEntities(bytes32 debtor, bytes32 creditor, uint tokenId) internal {
    uint256 idx = _debtIndex[debtor][tokenId];
    Debt[] storage queue = _debts[debtor][tokenId];
    uint256 len = queue.length;
    uint256 nextLive = type(uint256).max;
    for (uint256 j = idx; j < len; j++) {
      uint256 amount = queue[j].amount;
      if (amount == 0) {
        continue;
      }
      if (queue[j].creditor == creditor) {
        queue[j].amount = 0;
        _reduceDebtOutstanding(debtor, tokenId, amount);
        _afterDebtCleared(debtor, tokenId);
        emit DebtForgiven(debtor, creditor, tokenId, amount, j);
      } else if (nextLive == type(uint256).max) {
        nextLive = j;
      }
    }
    if (idx < len && queue[idx].amount == 0) {
      if (nextLive == type(uint256).max) {
        _debtIndex[debtor][tokenId] = 0;
        delete _debts[debtor][tokenId];
      } else {
        _debtIndex[debtor][tokenId] = nextLive;
      }
    }
  }

  function _increaseReserve(bytes32 entity, uint256 tokenId, uint256 amount) internal {
    Account.increaseReserve(_reserves, entity, tokenId, amount);
  }

  function _decreaseReserve(bytes32 entity, uint256 tokenId, uint256 amount) internal {
    Account.decreaseReserve(_reserves, entity, tokenId, amount);
  }

  /// @notice Internal dispute finalize with full storage access
  function _disputeFinalizeInternal(bytes32 entityId, FinalDisputeProof memory params) private {
    bytes memory acct_key = accountKey(entityId, params.counterentity);
    AccountInfo storage account = _accounts[acct_key];
    (
      bytes memory leftArguments,
      bytes memory rightArguments,
      uint256 leftArgumentsTimestamp,
      uint256 rightArgumentsTimestamp,
      uint256 eventInitialNonce,
      bytes32 finalProofbodyHash
    ) = Account.prepareDisputeFinalization(_accounts, entityId, params, entityProvider);

    _finalizeAccount(
      entityId,
      params.counterentity,
      params.finalProofbody,
      leftArguments,
      rightArguments,
      leftArgumentsTimestamp,
      rightArgumentsTimestamp
    );
    // Cooperative/counter-dispute adopts its signed nonce. A unilateral
    // timeout has no newer signature, so it consumes exactly one nonce.
    account.nonce = params.sig.length > 0 ? params.finalNonce : account.nonce + 1;

    emit DisputeFinalized(
      entityId,
      params.counterentity,
      eventInitialNonce,
      params.initialProofbodyHash,
      finalProofbodyHash
    );
  }

  /// @notice Finalize account - applies deltas and clears collateral
  function _finalizeAccount(
    bytes32 entity1,
    bytes32 entity2,
    ProofBody memory proofbody,
    bytes memory leftArguments,
    bytes memory rightArguments,
    uint256 leftArgumentsTimestamp,
    uint256 rightArgumentsTimestamp
  ) private {
    if (proofbody.tokenIds.length != proofbody.offdeltas.length) revert E8();

    bytes32 leftAddr = entity1 < entity2 ? entity1 : entity2;
    bytes32 rightAddr = entity1 < entity2 ? entity2 : entity1;
    bytes memory leftArgs = leftArguments;
    bytes memory rightArgs = rightArguments;
    uint256 leftArgsTimestamp = leftArgumentsTimestamp;
    uint256 rightArgsTimestamp = rightArgumentsTimestamp;
    bytes memory acct_key = accountKey(leftAddr, rightAddr);

    // NOTE: On-chain settlement must apply TOTAL delta (ondelta + offdelta).
    // - `col.ondelta` tracks the on-chain component (e.g., collateral funding events).
    // - `proofbody.offdeltas` is the off-chain component agreed/derived by parties.
    uint256 tokenCount = proofbody.tokenIds.length;
    int[] memory transformerDeltas = new int[](tokenCount);
    uint256 negativeDeltaBitmap;
    bool exactTransformerInputs = true;
    for (uint256 i = 0; i < tokenCount; i++) {
      uint256 tokenId = proofbody.tokenIds[i];
      if (i > 0 && proofbody.tokenIds[i - 1] >= tokenId) revert E8();
      (bool negative, uint256 rawDelta, bool representable) = _addSignedInt256(
        _collaterals[acct_key][tokenId].ondelta,
        proofbody.offdeltas[i]
      );
      assembly ("memory-safe") {
        mstore(add(add(transformerDeltas, 0x20), mul(i, 0x20)), rawDelta)
      }
      if (negative) negativeDeltaBitmap |= 1 << i;
      if (!representable) exactTransformerInputs = false;
    }

    // Dispute finalization passes transformer arguments directly via calldata.
    // These arguments are adversarial evidence, not signed account state. If an
    // entire side wrapper is malformed, treat that side as empty instead of
    // reverting: otherwise a party could submit garbage left/rightArguments and
    // DoS the honest side's unrelated swap/pull/payment claim. Signed ProofBody
    // hashes, tokenIds, and offdelta shape stay strict. A bad
    // transformer address, encoded batch, or allowance belongs to one optional
    // clause and is isolated below; letting it revert the whole account would
    // give either party a permanent dispute-freeze primitive.

    bytes32 accountKeyHash = keccak256(acct_key);

    // Transformer code and dispute arguments are adversarial optional logic.
    // Every clause is isolated: a bad call keeps the pre-clause deltas, emits
    // forensic evidence, and lets the dispute finish. Signed ProofBody shape,
    // signatures, hashes, and nonces stay strict above this boundary.
    transformerDeltas = Account.applyTransformers(
      accountKeyHash,
      proofbody,
      transformerDeltas,
      exactTransformerInputs,
      leftArgs,
      rightArgs,
      leftArgsTimestamp,
      rightArgsTimestamp
    );

    // Transformer output is authoritative only when every input was exact.
    // Otherwise Account emitted one explicit skip event per optional clause and
    // the wide signed-magnitude base values above remain authoritative.
    if (exactTransformerInputs) {
      negativeDeltaBitmap = 0;
      for (uint256 i = 0; i < tokenCount; i++) {
        if (transformerDeltas[i] < 0) negativeDeltaBitmap |= 1 << i;
      }
    }

    // Apply exact mathematical deltas. The signed-magnitude representation
    // covers every valid same-nonce R2C trajectory even when ondelta+offdelta
    // exceeds int256; no narrowing or saturating financial approximation occurs.
    for (uint256 i = 0; i < tokenCount; i++) {
      bool negativeDelta = negativeDeltaBitmap & (1 << i) != 0;
      uint256 deltaMagnitude;
      assembly ("memory-safe") {
        deltaMagnitude := mload(add(add(transformerDeltas, 0x20), mul(i, 0x20)))
        if negativeDelta { deltaMagnitude := sub(0, deltaMagnitude) }
      }
      _applyAccountDelta(
        acct_key,
        proofbody.tokenIds[i],
        leftAddr,
        rightAddr,
        negativeDelta,
        deltaMagnitude
      );
    }

    // Nonce update is handled by _disputeFinalizeInternal (caller).
  }

  /// @notice Apply delta to account collateral and reserves
  function _applyAccountDelta(
    bytes memory acct_key,
    uint256 tokenId,
    bytes32 leftEntity,
    bytes32 rightEntity,
    bool negativeDelta,
    uint256 deltaMagnitude
  ) private {
    AccountCollateral storage col = _collaterals[acct_key][tokenId];
    uint256 collateral = col.collateral;

    // Δ is LEFT's allocation (ondelta + offdelta), bounded by RCPAN:
    //   −leftCreditLimit ≤ Δ ≤ collateral + rightCreditLimit
    //
    // Collateral only exists on the right side of 0. Therefore:
    // - If Δ ≤ 0: LEFT gets 0, RIGHT gets all collateral, and LEFT owes −Δ (credit/debt).
    // - If 0 < Δ < collateral: split collateral (LEFT = Δ, RIGHT = collateral − Δ).
    // - If Δ ≥ collateral: LEFT gets all collateral and RIGHT owes Δ − collateral (credit/debt).
    if (negativeDelta || deltaMagnitude == 0) {
      if (collateral > 0) _increaseReserve(rightEntity, tokenId, collateral);
      if (deltaMagnitude > 0) {
        _settleShortfall(leftEntity, rightEntity, tokenId, deltaMagnitude);
      }
    } else {
      uint256 desired = deltaMagnitude;
      if (desired >= collateral) {
        if (collateral > 0) _increaseReserve(leftEntity, tokenId, collateral);
        uint256 shortfall = desired - collateral;
        if (shortfall > 0) _settleShortfall(rightEntity, leftEntity, tokenId, shortfall);
      } else {
        _increaseReserve(leftEntity, tokenId, desired);
        _increaseReserve(rightEntity, tokenId, collateral - desired);
      }
    }
    col.collateral = 0;
    col.ondelta = 0;
  }

  /// @dev Exact int256 + int256 using a 257-bit sign/magnitude result. The
  /// modulo sum plus the three sign bits distinguish normal, positive-overflow,
  /// and negative-overflow cases without checked signed arithmetic. Only
  /// -2^256 has no uint256 magnitude and is rejected as corrupt signed state.
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

  /// @notice Settle shortfall via reserves, then debt
  function _settleShortfall(bytes32 debtor, bytes32 creditor, uint256 tokenId, uint256 amount) private {
    if (amount == 0) return;

    enforceDebts(debtor, tokenId, DEBT_ENFORCEMENT_CHUNK);
    uint256 available = _spendableReserve(debtor, tokenId);
    uint256 payAmount = available >= amount ? amount : available;
    if (payAmount > 0) {
      _decreaseReserve(debtor, tokenId, payAmount);
      _increaseReserve(creditor, tokenId, payAmount);
    }

    uint256 remaining = amount - payAmount;
    if (remaining > 0) {
      _addDebt(debtor, tokenId, creditor, remaining);
    }
  }


  function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
    // Depository also holds EntityProvider governance shares. Receipt therefore
    // cannot imply asset support: only admin registration writes tokenToId, and
    // only processBatch credits reserves for a pre-registered token.
    return this.onERC1155Received.selector;
  }
  function onERC1155BatchReceived(address,address,uint256[] calldata,uint256[] calldata,bytes calldata) external pure returns (bytes4) { revert E7(); }
}
