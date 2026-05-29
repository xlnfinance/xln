// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "./EntityProvider.sol";
import "./DeltaTransformer.sol";
import "./Types.sol";
import "./Account.sol";

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
  uint256 public constant defaultDisputeDelay = 5760; // ~24h at 15s blocks
  

  mapping (bytes32 => mapping (uint => Debt[])) public _debts;
  // the current debt index to pay
  mapping (bytes32 => mapping (uint => uint)) public _debtIndex;
  // total reserve locked by unpaid debt, scoped by debtor and token
  mapping (bytes32 => mapping (uint => uint)) public debtOutstanding;
  // total number of active debts of an entity for a token
  mapping (bytes32 => mapping (uint => uint)) public _activeDebtsByToken;
  // total number of debts of an entity  
  mapping (bytes32 => uint) public _activeDebts;


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
  uint256 private constant MAX_RESERVE_TO_COLLATERAL_PAIRS = 64;
  bytes4 private constant SUPPORTS_ARGUMENT_TIMESTAMPS_SELECTOR = bytes4(keccak256("supportsArgumentTimestamps()"));
  bytes4 private constant APPLY_BATCH_WITH_ARGUMENT_TIMESTAMPS_SELECTOR =
    bytes4(keccak256("applyBatchWithArgumentTimestamps(int256[],bytes,bytes,bytes,uint256,uint256)"));
  event DebtCreated(bytes32 indexed debtor, bytes32 indexed creditor, uint256 indexed tokenId, uint256 amount, uint256 debtIndex);
  event DebtEnforced(bytes32 indexed debtor, bytes32 indexed creditor, uint256 indexed tokenId, uint256 amountPaid, uint256 remainingAmount, uint256 newDebtIndex);
  event DebtForgiven(bytes32 indexed debtor, bytes32 indexed creditor, uint256 indexed tokenId, uint256 amountForgiven, uint256 debtIndex);

  modifier onlyLocalDevAdmin() {
    if (
      msg.sender != admin ||
      (block.chainid != LOCAL_DEV_CHAIN_ID && block.chainid != SECONDARY_LOCAL_DEV_CHAIN_ID)
    ) revert E2();
    _;
  }

  // EntityScore tracking removed for size reduction
  // Hub tracking removed for size reduction

  // Events related to disputes and cooperative closures
  event DisputeStarted(bytes32 indexed sender, bytes32 indexed counterentity, uint indexed nonce, bytes32 proofbodyHash, bytes initialArguments);
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

  constructor(address _entityProvider) {
    require(_entityProvider != address(0), "EntityProvider cannot be zero address");
    entityProvider = _entityProvider;
    admin = msg.sender;
    _tokens.push(TokenMetadata({ contractAddress: address(0), externalTokenId: 0, tokenType: TypeERC20 }));
  }

  function getTokensLength() public view returns (uint) {
    return _tokens.length;
  }

  function getTokenMetadata(uint256 tokenId) external view returns (address contractAddress, uint96 externalTokenId, uint8 tokenType) {
    require(tokenId < _tokens.length, "!tok");
    TokenMetadata memory meta = _tokens[tokenId];
    return (meta.contractAddress, meta.externalTokenId, meta.tokenType);
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

  event HankoBatchProcessed(bytes32 indexed entityId, bytes32 indexed hankoHash, uint256 nonce, bool success);
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
    (bytes32 entityId, bool hankoValid) =
      EntityProvider(entityProvider).verifyHankoSignature(
        hankoData,
        Account.computeBatchHankoHash(DOMAIN_SEPARATOR, block.chainid, address(this), encodedBatch, nonce)
      );
    if (!hankoValid || entityId == bytes32(0)) revert E4();
    if (nonce != entityNonces[entityId] + 1) revert E2();
    entityNonces[entityId] = nonce;
    completeSuccess = _processBatch(entityId, abi.decode(encodedBatch, (Batch)));
    if (!completeSuccess) revert E4();
    emit HankoBatchProcessed(entityId, keccak256(hankoData), nonce, completeSuccess);
  }

  /// @notice Hash that an entity authorizes for a tower-only delayed counter-dispute.
  /// @dev The authorization is exact: tower address, account side, counterparty, final nonce,
  ///      proof-body hash, last-resort window, and appointment sequence are all bound.
  function computeWatchtowerCounterDisputeHash(
    address tower,
    bytes32 entityId,
    bytes32 counterentity,
    uint256 finalNonce,
    bytes32 finalProofbodyHash,
    uint256 lastResortWindowBlocks,
    uint256 appointmentSequence
  ) public view returns (bytes32) {
    return keccak256(
      abi.encode(
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
      )
    );
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
  ) external nonReentrant returns (bool completeSuccess) {
    bytes memory acct_key = accountKey(entityId, params.counterentity);
    AccountInfo storage account = _accounts[acct_key];

    if (account.disputeHash == bytes32(0)) revert E5();
    if (params.cooperative) revert E2();
    if (params.sig.length == 0) revert E2();
    if (lastResortWindowBlocks == 0) revert E2();
    if (params.finalNonce <= account.nonce) revert E2();
    if (params.finalNonce <= params.initialNonce) revert E2();
    if (block.number + lastResortWindowBlocks < account.disputeTimeout) revert E2();

    bytes32 finalProofbodyHash = keccak256(abi.encode(params.finalProofbody));
    (bytes32 recoveredEntity, bool valid) =
      EntityProvider(entityProvider).verifyHankoSignature(
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

    completeSuccess = _disputeFinalizeInternal(entityId, params);
    if (!completeSuccess) revert E4();
    emit WatchtowerCounterDisputeExecuted(
      msg.sender,
      entityId,
      params.counterentity,
      params.finalNonce,
      appointmentSequence
    );
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

  /**
   * @notice Mint reserves for multiple entity/token pairs in a single local dev tx.
   * @dev Local Anvil bootstrap helper. Disabled outside configured local dev chain IDs.
   */
  function mintToReserveBatch(ReserveMint[] calldata mints) external onlyLocalDevAdmin {
    uint len = mints.length;
    if (len == 0) revert E1();

    for (uint i = 0; i < len; i++) {
      ReserveMint calldata mint = mints[i];
      if (mint.amount == 0) revert E1();

      _increaseReserve(mint.entity, mint.tokenId, mint.amount);
    }
  }


  function _assertBatchBounds(Batch memory batch) private pure {
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

  function _processBatch(bytes32 entityId, Batch memory batch) private returns (bool completeSuccess) {
    _assertBatchBounds(batch);

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
      
      
      
      
      
      
      
      
      
      
      _reserveToReserve(entityId, batch.reserveToReserve[i]);
    }

    // C2R shortcut: direct processing (no Settlement[] allocation)
    // Pure C2R = withdraw `amount` from my share of collateral to my reserve
    for (uint i = 0; i < batch.collateralToReserve.length; i++) {
      if (!Account.processC2R(_reserves, _accounts, _collaterals, entityId, batch.collateralToReserve[i], entityProvider)) {
        completeSuccess = false;
      }
    }

    // Delegate settlement diffs to Account library, handle debt forgiveness in Depository
    if (batch.settlements.length > 0) {
      if (!Account.processSettlements(_reserves, _accounts, _collaterals, entityId, batch.settlements, entityProvider)) {
        completeSuccess = false;
      }
      // Handle debt forgiveness (not in Account due to stack limits)
      for (uint i = 0; i < batch.settlements.length; i++) {
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
      if (!_disputeFinalizeInternal(entityId, batch.disputeFinalizations[i])) {
        completeSuccess = false;
      }
    }

    for (uint i = 0; i < batch.reserveToCollateral.length; i++) {
      if(!(_reserveToCollateral(entityId, batch.reserveToCollateral[i]))){
        completeSuccess = false;
      }
    }

    // Process external token withdrawals (decreases reserves)
    // Security: batch initiator can only withdraw from their own reserves
    for (uint i = 0; i < batch.reserveToExternalToken.length; i++) {
      _reserveToExternalToken(entityId, batch.reserveToExternalToken[i]);
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

  // MessageType enum is in Types.sol

  // ReserveToCollateral and EntityAmount (was AddrAmountPair) are in Types.sol


  // Allowance, TransformerClause, ProofBody, InitialDisputeProof, FinalDisputeProof, Debt are in Types.sol

  // DebtSnapshot moved to DepositoryView.sol

  function _addDebt(bytes32 debtor, uint256 tokenId, bytes32 creditor, uint256 amount) internal returns (uint256 index) {
    if (creditor == bytes32(0)) revert E2();
    if (debtor == creditor) revert E2();
    if (amount == 0) revert E1();
    _debts[debtor][tokenId].push(Debt({ amount: amount, creditor: creditor }));
    index = _debts[debtor][tokenId].length - 1;

    if (index == 0) {
      _debtIndex[debtor][tokenId] = 0;
    }

    debtOutstanding[debtor][tokenId] += amount;
    _activeDebts[debtor]++;
    _activeDebtsByToken[debtor][tokenId]++;
    emit DebtCreated(debtor, creditor, tokenId, amount, index);
  }

  function _afterDebtCleared(bytes32 entity, uint256 tokenId) internal {
    if (_activeDebts[entity] > 0) {
      unchecked {
        _activeDebts[entity]--;
      }
    }
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

  function spendableReserve(bytes32 entity, uint256 tokenId) external view returns (uint256) {
    return _spendableReserve(entity, tokenId);
  }

  function packTokenReference(uint8 tokenType, address contractAddress, uint96 externalTokenId) public pure returns (bytes32) {
    return keccak256(abi.encode(tokenType, contractAddress, externalTokenId));
  }

  function unpackTokenReference(bytes32 packed) public view returns (address contractAddress, uint96 externalTokenId, uint8 tokenType) {
    uint256 tokenId = tokenToId[packed];
    require(tokenId != 0, "!tok");
    TokenMetadata memory meta = _tokens[tokenId];
    return (meta.contractAddress, meta.externalTokenId, meta.tokenType);
  }





  // registerHub removed for size reduction

  // ExternalTokenToReserve struct is in Types.sol
  // Local Anvil bootstrap helper. User deposits must go through processBatch().
  function adminRegisterExternalToken(ExternalTokenToReserve memory params) external onlyLocalDevAdmin nonReentrant {
    _externalTokenToReserve(params);
  }

  // Internal version for batch processing (already inside nonReentrant context)
  function _externalTokenToReserve(ExternalTokenToReserve memory params) internal {
    bytes32 targetEntity = params.entity == bytes32(0) ? bytes32(uint256(uint160(msg.sender))) : params.entity;
    if (params.amount == 0) revert E1();

    bytes32 packedToken = packTokenReference(params.tokenType, params.contractAddress, params.externalTokenId);

    if (params.internalTokenId == 0) {
      params.internalTokenId = tokenToId[packedToken];
      if (params.internalTokenId == 0) {
        _tokens.push(TokenMetadata({
          contractAddress: params.contractAddress,
          externalTokenId: params.externalTokenId,
          tokenType: params.tokenType
        }));
        params.internalTokenId = _tokens.length - 1;
        tokenToId[packedToken] = params.internalTokenId;
      }
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
  function _reserveToExternalToken(bytes32 entity, ReserveToExternalToken memory params) internal {
    if (params.amount == 0) revert E1();
    enforceDebts(entity, params.tokenId, DEBT_ENFORCEMENT_CHUNK);

    TokenMetadata memory meta = _tokens[params.tokenId];
    if (params.amount > _spendableReserve(entity, params.tokenId)) revert E3();
    if (uint256(params.receivingEntity) > type(uint160).max) revert E2();
    address recipient = address(uint160(uint256(params.receivingEntity)));
    if (meta.tokenType == TypeERC721 && params.amount != 1) revert E1();
    _decreaseReserve(entity, params.tokenId, params.amount);

    if (meta.tokenType == TypeERC20) {
      _safeERC20Transfer(meta.contractAddress, recipient, params.amount);
    } else if (meta.tokenType == TypeERC721) {
      IERC721(meta.contractAddress).transferFrom(address(this), recipient, uint(meta.externalTokenId));
    } else if (meta.tokenType == TypeERC1155) {
      IERC1155(meta.contractAddress).safeTransferFrom(address(this), recipient, uint(meta.externalTokenId), params.amount, "");
    }
  }
  // ReserveToReserve struct is in Types.sol
  function _reserveToReserve(bytes32 entity, ReserveToReserve memory params) internal {
    enforceDebts(entity, params.tokenId, DEBT_ENFORCEMENT_CHUNK);
    if (params.amount > _spendableReserve(entity, params.tokenId)) revert E3();
    _decreaseReserve(entity, params.tokenId, params.amount);
    _increaseReserve(params.receivingEntity, params.tokenId, params.amount);
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

    for (uint i = 0; i < params.pairs.length; i++) {
      bytes32 counterentity = params.pairs[i].entity;
      uint amount = params.pairs[i].amount;

      bytes memory acct_key = accountKey(receivingEntity, counterentity);

      
      if (amount <= _spendableReserve(entity, tokenId)) {
        AccountCollateral storage col = _collaterals[acct_key][tokenId];

        _decreaseReserve(entity, tokenId, amount);
        col.collateral += amount;
        if (receivingEntity < counterentity) { // if receiver is left
          col.ondelta += int(amount);
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


      } else {
        
        return false;
      }
      
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
    if (amount == 0) return;
    _reserves[entity][tokenId] += amount;
    emit ReserveUpdated(entity, tokenId, _reserves[entity][tokenId]);
  }

  function _decreaseReserve(bytes32 entity, uint256 tokenId, uint256 amount) internal {
    if (amount == 0) return;
    if (_reserves[entity][tokenId] < amount) revert E3();
    _reserves[entity][tokenId] -= amount;
    emit ReserveUpdated(entity, tokenId, _reserves[entity][tokenId]);
  }

  /// @notice Internal dispute finalize with full storage access
  function _disputeFinalizeInternal(bytes32 entityId, FinalDisputeProof memory params) internal returns (bool) {
    bytes memory acct_key = accountKey(entityId, params.counterentity);

    if (params.cooperative) {
      // SECURITY: Prevent cooperative finalize on virgin accounts
      if (_accounts[acct_key].nonce == 0) revert E5();

      // NONCE CHECK: signedNonce > storedNonce (strictly greater)
      if (params.finalNonce <= _accounts[acct_key].nonce) revert E2();

      require(params.sig.length > 0, "Signature required for cooperative finalize");
      if (!Account.verifyCooperativeProofHanko(entityProvider, address(this), acct_key, params.finalNonce, keccak256(abi.encode(params.finalProofbody)), keccak256(params.initialArguments), params.sig, params.counterentity)) revert E4();
    } else {
      bytes32 storedHash = _accounts[acct_key].disputeHash;
      if (storedHash == bytes32(0)) revert E5();

      bytes32 expectedHash = Account.encodeDisputeHash(
        params.initialNonce, params.startedByLeft,
        _accounts[acct_key].disputeTimeout, params.initialProofbodyHash, params.initialArguments
      );
      if (storedHash != expectedHash) revert E9();

      // Counter-dispute or unilateral finalization
      if (params.sig.length > 0) {
        // Counter-dispute: counterparty provides a NEWER signed proof
        // NONCE CHECK: finalNonce > storedNonce (strictly greater)
        if (params.finalNonce <= _accounts[acct_key].nonce) revert E2();
        if (params.finalNonce <= params.initialNonce) revert E2();

        bytes32 finalProofbodyHash = keccak256(abi.encode(params.finalProofbody));
        if (!Account.verifyDisputeProofHanko(entityProvider, address(this), acct_key, params.finalNonce, finalProofbodyHash, params.sig, params.counterentity)) revert E4();
      } else {
        // Unilateral finalization after timeout (no new signature)
        bool senderIsCounterparty = params.startedByLeft != (entityId < params.counterentity);
        if (!senderIsCounterparty && block.number < _accounts[acct_key].disputeTimeout) revert E2();
        if (params.initialProofbodyHash != keccak256(abi.encode(params.finalProofbody))) revert E2();
      }
    }

    uint256 initialArgumentsTimestamp = block.timestamp;
    if (!params.cooperative) {
      initialArgumentsTimestamp = _accounts[acct_key].disputeStartTimestamp;
    }

    _accounts[acct_key].disputeHash = bytes32(0);
    _accounts[acct_key].disputeTimeout = 0;
    _accounts[acct_key].disputeStartTimestamp = 0;

    bool ok = _finalizeAccount(
      entityId,
      params.counterentity,
      params.finalProofbody,
      params.finalArguments,
      params.initialArguments,
      block.timestamp,
      initialArgumentsTimestamp
    );
    if (ok) {
      // SET nonce based on finalization path
      if (params.sig.length > 0) {
        // Cooperative or counter-dispute: storedNonce = signedNonce
        _accounts[acct_key].nonce = params.finalNonce;
      } else {
        // Unilateral timeout: no new signature, bump by 1
        _accounts[acct_key].nonce++;
      }

      emit DisputeFinalized(
        entityId,
        params.counterentity,
        params.initialNonce,
        params.initialProofbodyHash,
        keccak256(abi.encode(params.finalProofbody))
      );
    }
    return ok;
  }

  /// @notice Finalize account - applies deltas and clears collateral
  function _finalizeAccount(
    bytes32 entity1,
    bytes32 entity2,
    ProofBody memory proofbody,
    bytes memory arguments1,
    bytes memory arguments2,
    uint256 arguments1Timestamp,
    uint256 arguments2Timestamp
  ) internal returns (bool) {
    if (proofbody.tokenIds.length != proofbody.offdeltas.length) revert E8();

    bytes32 leftAddr = entity1 < entity2 ? entity1 : entity2;
    bytes32 rightAddr = entity1 < entity2 ? entity2 : entity1;
    bytes memory leftArgs = entity1 < entity2 ? arguments1 : arguments2;
    bytes memory rightArgs = entity1 < entity2 ? arguments2 : arguments1;
    uint256 leftArgsTimestamp = entity1 < entity2 ? arguments1Timestamp : arguments2Timestamp;
    uint256 rightArgsTimestamp = entity1 < entity2 ? arguments2Timestamp : arguments1Timestamp;
    bytes memory acct_key = accountKey(leftAddr, rightAddr);

    // NOTE: On-chain settlement must apply TOTAL delta (ondelta + offdelta).
    // - `col.ondelta` tracks the on-chain component (e.g., collateral funding events).
    // - `proofbody.offdeltas` is the off-chain component agreed/derived by parties.
    uint256 tokenCount = proofbody.tokenIds.length;
    int[] memory deltas = new int[](tokenCount);
    for (uint256 i = 0; i < tokenCount; i++) {
      uint256 tokenId = proofbody.tokenIds[i];
      for (uint256 j = 0; j < i; j++) {
        if (proofbody.tokenIds[j] == tokenId) revert E8();
      }
      deltas[i] = _collaterals[acct_key][tokenId].ondelta + proofbody.offdeltas[i];
    }

    bytes[] memory decodedLeft = leftArgs.length > 0 ? abi.decode(leftArgs, (bytes[])) : new bytes[](0);
    bytes[] memory decodedRight = rightArgs.length > 0 ? abi.decode(rightArgs, (bytes[])) : new bytes[](0);
    // Dispute finalization passes transformer arguments directly via calldata.
    // For HTLC this includes revealed secrets, so transformers can settle in one call.

    // Apply transformers
    for (uint256 i = 0; i < proofbody.transformers.length; i++) {
      TransformerClause memory tc = proofbody.transformers[i];
      int[] memory newDeltas = _applyTransformer(
        deltas,
        tc,
        i < decodedLeft.length ? decodedLeft[i] : bytes(""),
        i < decodedRight.length ? decodedRight[i] : bytes(""),
        leftArgsTimestamp,
        rightArgsTimestamp
      );
      if (newDeltas.length != deltas.length) revert E8();

      for (uint256 j = 0; j < tc.allowances.length; j++) {
        Allowance memory allow = tc.allowances[j];
        if (allow.deltaIndex >= deltas.length) revert E2();
        int diff = newDeltas[allow.deltaIndex] - deltas[allow.deltaIndex];
        if (diff > 0 && uint256(diff) > allow.leftAllowance) revert E2();
        if (diff < 0 && uint256(-diff) > allow.rightAllowance) revert E2();
      }
      for (uint256 j = 0; j < deltas.length; j++) {
        if (!_hasTransformerAllowance(tc.allowances, j) && newDeltas[j] != deltas[j]) revert E2();
      }
      deltas = newDeltas;
    }

    // Apply deltas
    for (uint256 i = 0; i < proofbody.tokenIds.length; i++) {
      _applyAccountDelta(acct_key, proofbody.tokenIds[i], leftAddr, rightAddr, deltas[i]);
    }

    // Nonce update is handled by _disputeFinalizeInternal (caller)
    return true;
  }

  function _hasTransformerAllowance(Allowance[] memory allowances, uint256 deltaIndex) internal pure returns (bool) {
    for (uint256 i = 0; i < allowances.length; i++) {
      if (allowances[i].deltaIndex == deltaIndex) return true;
    }
    return false;
  }

  function _applyTransformer(
    int[] memory deltas,
    TransformerClause memory tc,
    bytes memory leftArguments,
    bytes memory rightArguments,
    uint256 leftArgumentsTimestamp,
    uint256 rightArgumentsTimestamp
  ) internal view returns (int[] memory) {
    (bool supportOk, bytes memory supportData) = tc.transformerAddress.staticcall(
      abi.encodeWithSelector(SUPPORTS_ARGUMENT_TIMESTAMPS_SELECTOR)
    );
    if (supportOk && supportData.length >= 32 && abi.decode(supportData, (bool))) {
      (bool applyOk, bytes memory applyData) = tc.transformerAddress.staticcall(
        abi.encodeWithSelector(
          APPLY_BATCH_WITH_ARGUMENT_TIMESTAMPS_SELECTOR,
          deltas,
          tc.encodedBatch,
          leftArguments,
          rightArguments,
          leftArgumentsTimestamp,
          rightArgumentsTimestamp
        )
      );
      if (!applyOk) _revertWithData(applyData);
      return abi.decode(applyData, (int[]));
    }

    return DeltaTransformer(tc.transformerAddress).applyBatch(
      deltas,
      tc.encodedBatch,
      leftArguments,
      rightArguments
    );
  }

  function _revertWithData(bytes memory data) internal pure {
    if (data.length == 0) revert E2();
    assembly ("memory-safe") {
      revert(add(data, 32), mload(data))
    }
  }

  /// @notice Apply delta to account collateral and reserves
  function _applyAccountDelta(bytes memory acct_key, uint256 tokenId, bytes32 leftEntity, bytes32 rightEntity, int delta) internal {
    AccountCollateral storage col = _collaterals[acct_key][tokenId];
    uint256 collateral = col.collateral;

    // Δ is LEFT's allocation (ondelta + offdelta), bounded by RCPAN:
    //   −leftCreditLimit ≤ Δ ≤ collateral + rightCreditLimit
    //
    // Collateral only exists on the right side of 0. Therefore:
    // - If Δ ≤ 0: LEFT gets 0, RIGHT gets all collateral, and LEFT owes −Δ (credit/debt).
    // - If 0 < Δ < collateral: split collateral (LEFT = Δ, RIGHT = collateral − Δ).
    // - If Δ ≥ collateral: LEFT gets all collateral and RIGHT owes Δ − collateral (credit/debt).
    if (delta <= 0) {
      if (collateral > 0) _increaseReserve(rightEntity, tokenId, collateral);
      uint256 shortfall = uint256(-delta);
      if (shortfall > 0) _settleShortfall(leftEntity, rightEntity, tokenId, shortfall);
    } else {
      uint256 desired = uint256(delta);
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

  /// @notice Settle shortfall via reserves, then debt
  function _settleShortfall(bytes32 debtor, bytes32 creditor, uint256 tokenId, uint256 amount) internal {
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


  function onERC1155Received(address, address, uint256 id, uint256, bytes calldata) external returns (bytes4) {
    // SECURITY FIX: Don't credit here - _externalTokenToReserve:713 already credits
    // This prevents double-crediting when ERC1155.safeTransferFrom triggers this callback
    // If tokens sent directly (not via externalTokenToReserve), they will be stuck but not inflate reserves
    bytes32 packedToken = packTokenReference(TypeERC1155, msg.sender, uint96(id));
    uint256 tid = tokenToId[packedToken];
    if (tid == 0) {
      _tokens.push(TokenMetadata({ contractAddress: msg.sender, externalTokenId: uint96(id), tokenType: TypeERC1155 }));
      tid = _tokens.length - 1;
      tokenToId[packedToken] = tid;
    }
    // DO NOT credit reserves here to avoid double-crediting
    // _reserves[entity][tid] += value; // REMOVED
    return this.onERC1155Received.selector;
  }
  function onERC1155BatchReceived(address,address,uint256[] calldata,uint256[] calldata,bytes calldata) external pure returns (bytes4) { revert("!batch"); }
}
