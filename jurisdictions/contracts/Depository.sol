// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "./ECDSA.sol";
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
}
interface IERC721 {
  function transferFrom(address from, address to, uint256 tokenId) external;
}

contract Depository is ReentrancyGuardLite {

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

  // Multi-provider support
  mapping(address => bool) public approvedEntityProviders;
  address[] public entityProvidersList;
  
  mapping (bytes32 => mapping (uint => uint)) public _reserves;

  mapping (bytes => AccountInfo) public _accounts;
  mapping (bytes => mapping(uint => AccountCollateral)) public _collaterals;

  // Configurable dispute delays (block count) - lower for hubs, higher for end users
  uint256 public defaultDisputeDelay = 20; // ~5 min at 15s blocks
  mapping (bytes32 => uint256) public entityDisputeDelays; // per-entity override 
  

  mapping (bytes32 => mapping (uint => Debt[])) public _debts;
  // the current debt index to pay
  mapping (bytes32 => mapping (uint => uint)) public _debtIndex;
  // total number of debts of an entity  
  mapping (bytes32 => uint) public _activeDebts;


  address public immutable admin;
  bool public emergencyPause;

  // === TEST MODE FOR HANKO BYPASS ===
  // WARNING: Must call disableTestModeForever() before mainnet deployment
  bool public testMode = true;

  // Insurance cursor - tracks iteration position per insured entity
  mapping(bytes32 => uint256) public insuranceCursor;

  event DebtCreated(bytes32 indexed debtor, bytes32 indexed creditor, uint256 indexed tokenId, uint256 amount, uint256 debtIndex);
  event DebtEnforced(bytes32 indexed debtor, bytes32 indexed creditor, uint256 indexed tokenId, uint256 amountPaid, uint256 remainingAmount, uint256 newDebtIndex);
  event DebtForgiven(bytes32 indexed debtor, bytes32 indexed creditor, uint256 indexed tokenId, uint256 amountForgiven, uint256 debtIndex);
  event EmergencyPauseToggled(bool isPaused);
  event TestModeDisabled();

  modifier onlyAdmin() {
    if (msg.sender != admin) revert E2();
    _;
  }

  modifier whenNotPaused() {
    if (emergencyPause) revert E2();
    _;
  }


  // EntityScore tracking removed for size reduction
  // Hub tracking removed for size reduction

  // Events related to disputes and cooperative closures
  event DisputeStarted(bytes32 indexed sender, bytes32 indexed counterentity, uint indexed disputeNonce, bytes initialArguments);
  event CooperativeClose(bytes32 indexed sender, bytes32 indexed counterentity, uint indexed cooperativeNonce);

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

  //event ChannelUpdated(address indexed receiver, address indexed addr, uint tokenId);


  uint8 constant TypeERC20 = 0;
  uint8 constant TypeERC721 = 1;
  uint8 constant TypeERC1155 = 2;   




  bytes32[] public _tokens;
  
  // Efficient token lookup: packedToken -> internalTokenId
  mapping(bytes32 => uint256) public tokenToId;

  // === MULTI-PROVIDER MANAGEMENT ===
  
  event EntityProviderAdded(address indexed provider);
  event EntityProviderRemoved(address indexed provider);
  
  modifier onlyApprovedProvider(address provider) {
    require(approvedEntityProviders[provider], "!provider");
    _;
  }
  
  /**
   * @notice Add an EntityProvider to approved list
   * @param provider EntityProvider contract address
   */
  function addEntityProvider(address provider) external onlyAdmin {
    require(provider != address(0), "!addr");
    require(!approvedEntityProviders[provider], "exists");
    approvedEntityProviders[provider] = true;
    entityProvidersList.push(provider);
    emit EntityProviderAdded(provider);
  }
  
  /**
   * @notice Remove an EntityProvider from approved list  
   * @param provider EntityProvider contract address
   */
  function removeEntityProvider(address provider) external onlyAdmin {
    require(provider != address(0), "!addr");
    require(approvedEntityProviders[provider], "!ok");
    approvedEntityProviders[provider] = false;
    
    // Remove from list
    for (uint i = 0; i < entityProvidersList.length; i++) {
      if (entityProvidersList[i] == provider) {
        entityProvidersList[i] = entityProvidersList[entityProvidersList.length - 1];
        entityProvidersList.pop();
        break;
      }
    }
    emit EntityProviderRemoved(provider);
  }
  
  /**
   * @notice Get all approved EntityProviders
   */
  function getApprovedProviders() external view returns (address[] memory) {
    return entityProvidersList;
  }

  constructor() {
    admin = msg.sender;
    _tokens.push(bytes32(0));

  }

  function setEmergencyPause(bool isPaused) external onlyAdmin {
    if (emergencyPause == isPaused) {
      return;
    }
    emergencyPause = isPaused;
    emit EmergencyPauseToggled(isPaused);
  }

  /**
   * @notice Permanently disable test mode (one-way door)
   * @dev MUST be called before mainnet deployment to enable Hanko verification
   */
  function disableTestModeForever() external onlyAdmin {
    if (!testMode) revert E2();
    testMode = false;
    emit TestModeDisabled();
  }

  /// @notice Set dispute delay for an entity (0 = use default)
  /// @dev Hubs get shorter delays, end users get longer delays
  function setEntityDisputeDelay(bytes32 entity, uint256 delayBlocks) external onlyAdmin {
    entityDisputeDelays[entity] = delayBlocks;
  }

  /// @notice Set default dispute delay for entities without custom setting
  function setDefaultDisputeDelay(uint256 delayBlocks) external onlyAdmin {
    require(delayBlocks > 0, "!delay");
    defaultDisputeDelay = delayBlocks;
  }


  function getTokensLength() public view returns (uint) {
    return _tokens.length;
  }

  function getTokenMetadata(uint256 tokenId) external view returns (address contractAddress, uint96 externalTokenId, uint8 tokenType) {
    require(tokenId < _tokens.length, "!tok");
    return unpackTokenReference(_tokens[tokenId]);
  }





  // Batch struct is in Types.sol
  // === HANKO INTEGRATION ===

  /// @notice Sequential nonce for each entity authorising batches via Hanko.
  mapping(address => uint256) public entityNonces;

  /// @notice Domain separator used when hashing Hanko payloads for verification.
  bytes32 public constant DOMAIN_SEPARATOR = keccak256("XLN_DEPOSITORY_HANKO_V1");

  event HankoBatchProcessed(bytes32 indexed entityId, bytes32 indexed hankoHash, uint256 nonce, bool success);

  function processBatchWithHanko(
    bytes calldata encodedBatch,
    address entityProvider,
    bytes calldata hankoData,
    uint256 nonce
  ) external whenNotPaused nonReentrant onlyApprovedProvider(entityProvider) returns (bool completeSuccess) {
    (bytes32 entityId, bool hankoValid) = EntityProvider(entityProvider).verifyHankoSignature(hankoData, Account.computeBatchHankoHash(DOMAIN_SEPARATOR, block.chainid, address(this), encodedBatch, nonce));
    if (!hankoValid || entityId == bytes32(0)) revert E4();
    address ea = address(uint160(uint256(entityId)));
    if (nonce != entityNonces[ea] + 1) revert E2();
    entityNonces[ea] = nonce;
    completeSuccess = _processBatch(entityId, abi.decode(encodedBatch, (Batch)));
    emit HankoBatchProcessed(entityId, keccak256(hankoData), nonce, completeSuccess);
  }

  /**
   * @notice Mint new reserves to an entity (admin only).
   * @dev In production, minting would be gated by governance. For testnet/demo, admin can mint freely.
   *      Emits both ReserveMinted (for j-watchers tracking mint events) and ReserveUpdated (for balance sync).
   * @param entity The entity receiving the minted reserves.
   * @param tokenId The internal token ID.
   * @param amount The amount to mint.
   */
  function mintToReserve(bytes32 entity, uint tokenId, uint amount) external onlyAdmin {
    if (amount == 0) revert E1();
    
    
    
    
    
    

    _reserves[entity][tokenId] += amount;
    uint newBalance = _reserves[entity][tokenId];

    // Single canonical event for reserve changes
    emit ReserveUpdated(entity, tokenId, newBalance);

    
    
  }


  // TODO: make private - currently public for testing convenience
  function processBatch(bytes32 entity, Batch calldata batch) public whenNotPaused nonReentrant returns (bool completeSuccess) {
    // In production mode, require Hanko authorization via processBatchWithHanko()
    if (!testMode) revert E2();

    
    
    
    
    
    
    
    
    

    if (batch.reserveToReserve.length > 0) {
      
      
      
      
      
      
      

      
      
    }

    
    return _processBatch(entity, batch);
  }


  // ========== DIRECT R2R FUNCTION ==========
  // Simple reserve-to-reserve transfer (simpler than batch)
  // TODO: make private - currently public for testing convenience
  function reserveToReserve(
    bytes32 fromEntity,
    bytes32 toEntity,
    uint tokenId,
    uint amount
  ) public whenNotPaused nonReentrant returns (bool) {
    if (!testMode) revert E2(); // Production: use processBatchWithHanko
    if (fromEntity == toEntity) revert E2();
    if (amount == 0) revert E1();
    enforceDebts(fromEntity, tokenId);
    if (_reserves[fromEntity][tokenId] < amount) revert E3();

    // Simple transfer: subtract from sender, add to receiver
    _reserves[fromEntity][tokenId] -= amount;
    _reserves[toEntity][tokenId] += amount;

    // Single canonical event per entity whose reserve changed
    emit ReserveUpdated(fromEntity, tokenId, _reserves[fromEntity][tokenId]);
    emit ReserveUpdated(toEntity, tokenId, _reserves[toEntity][tokenId]);

    
    return true;
  }

  // ========== SETTLE FUNCTION ==========
  /// @notice External settle - only works in testMode (uses Account library)
  function settle(
    bytes32 leftEntity,
    bytes32 rightEntity,
    SettlementDiff[] memory diffs,
    uint[] memory forgiveDebtsInTokenIds,
    InsuranceRegistration[] memory insuranceRegs,
    bytes memory sig
  ) public whenNotPaused nonReentrant returns (bool) {
    if (!testMode) revert E2();
    // testMode: skip all auth - assume caller authorized
    bytes32 caller = leftEntity;

    Settlement[] memory settlements = new Settlement[](1);
    settlements[0] = Settlement({
      leftEntity: leftEntity,
      rightEntity: rightEntity,
      diffs: diffs,
      forgiveDebtsInTokenIds: forgiveDebtsInTokenIds,
      insuranceRegs: insuranceRegs,
      sig: sig,
      entityProvider: address(0),
      hankoData: "",
      nonce: 0
    });

    // Process diffs via Account library (signature validation skipped if no sig provided)
    if (!Account.processSettlements(_reserves, _accounts, _collaterals, caller, settlements)) {
      return false;
    }
    // Handle debt/insurance in Depository
    _handleSettlementDebtAndInsurance(leftEntity, rightEntity, forgiveDebtsInTokenIds, insuranceRegs);
    return true;
  }

  function _processBatch(bytes32 entityId, Batch memory batch) private returns (bool completeSuccess) {
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
      _reserves[entityId][flashloanTokenIds[j]] += flashloanTotals[j];
    }

    // the order is important: first go methods that increase entity's balance
    // then methods that deduct from it

    completeSuccess = true;

    // Process external token deposits (increases reserves)
    // msg.sender must have approved tokens before calling processBatchWithHanko
    for (uint i = 0; i < batch.externalTokenToReserve.length; i++) {
      ExternalTokenToReserve memory params = batch.externalTokenToReserve[i];
      // If entity is not specified, default to batch initiator
      if (params.entity == bytes32(0)) {
        params.entity = entityId;
      }
      // Security: entity must be the batch initiator (can't credit others arbitrarily)
      if (params.entity != entityId) revert E2();
      _externalTokenToReserve(params);
    }

    // Process reserveToReserve transfers (the core functionality we need)
    
    
    for (uint i = 0; i < batch.reserveToReserve.length; i++) {
      
      
      
      
      
      
      
      
      
      
      reserveToReserve(entityId, batch.reserveToReserve[i]);
    }

    // Delegate settlement diffs to Account library, handle debt/insurance in Depository
    if (batch.settlements.length > 0) {
      if (!Account.processSettlements(_reserves, _accounts, _collaterals, entityId, batch.settlements)) {
        completeSuccess = false;
      }
      // Handle debt forgiveness and insurance registration (not in Account due to stack limits)
      for (uint i = 0; i < batch.settlements.length; i++) {
        Settlement memory s = batch.settlements[i];
        _handleSettlementDebtAndInsurance(s.leftEntity, s.rightEntity, s.forgiveDebtsInTokenIds, s.insuranceRegs);
      }
    }

    if (batch.disputeStarts.length > 0) {
      if (!Account.processDisputeStarts(_accounts, entityId, batch.disputeStarts, defaultDisputeDelay)) {
        completeSuccess = false;
      }
    }

    // Dispute finalizations stay in Depository (too many storage refs for Account)
    for (uint i = 0; i < batch.disputeFinalizations.length; i++) {
      if (!_disputeFinalizeInternal(entityId, batch.disputeFinalizations[i])) {
        completeSuccess = false;
      }
    }

    for (uint i = 0; i < batch.reserveToCollateral.length; i++) {
      if(!(reserveToCollateral(entityId, batch.reserveToCollateral[i]))){
        completeSuccess = false;
      }
    }

    // Process external token withdrawals (decreases reserves)
    // Security: batch initiator can only withdraw from their own reserves
    for (uint i = 0; i < batch.reserveToExternalToken.length; i++) {
      reserveToExternalToken(entityId, batch.reserveToExternalToken[i]);
    }

    // SECURITY FIX: Check aggregated flashloan return + burn
    for (uint j = 0; j < uniqueCount; j++) {
      uint tid = flashloanTokenIds[j];
      uint expectedFinal = flashloanStarting[j] + flashloanTotals[j];

      // Check entity returned borrowed amount
      if (_reserves[entityId][tid] < expectedFinal) revert E3(); // Flashloan not returned

      // Burn flashloan (remove temporary mint)
      _reserves[entityId][tid] -= flashloanTotals[j];

      // Final check: reserves back to original or higher
      if (_reserves[entityId][tid] < flashloanStarting[j]) revert E3(); // Reserve decreased
    }

    return completeSuccess;

  }

  // MessageType enum is in Types.sol

  // ReserveToCollateral and EntityAmount (was AddrAmountPair) are in Types.sol


  // Allowance, TransformerClause, ProofBody, InitialDisputeProof, FinalDisputeProof, Debt are in Types.sol

  // ═══════════════════════════════════════════════════════════════════════════
  //                              INSURANCE
  // ═══════════════════════════════════════════════════════════════════════════

  // InsuranceLine and InsuranceRegistration structs are in Types.sol

  // insured entity => insurance lines (FIFO queue)
  mapping(bytes32 => InsuranceLine[]) public insuranceLines;

  event InsuranceRegistered(bytes32 indexed insured, bytes32 indexed insurer, uint256 indexed tokenId, uint256 limit, uint256 expiresAt);
  event InsuranceClaimed(bytes32 indexed insured, bytes32 indexed insurer, bytes32 indexed creditor, uint256 tokenId, uint256 amount);

  // DebtSnapshot moved to DepositoryView.sol

  function _addDebt(bytes32 debtor, uint256 tokenId, bytes32 creditor, uint256 amount) internal returns (uint256 index) {
    if (creditor == bytes32(0)) revert E2();
    if (amount == 0) revert E1();
    _debts[debtor][tokenId].push(Debt({ amount: amount, creditor: creditor }));
    index = _debts[debtor][tokenId].length - 1;

    if (index == 0) {
      _debtIndex[debtor][tokenId] = 0;
    }

    _activeDebts[debtor]++;
    emit DebtCreated(debtor, creditor, tokenId, amount, index);
  }

  function _afterDebtCleared(bytes32 entity, bool) internal {
    if (_activeDebts[entity] > 0) {
      unchecked {
        _activeDebts[entity]--;
      }
    }
  }


  function _clearDebtAtIndex(bytes32 entity, uint256 tokenId, uint256 index, bool isRepayment) internal returns (uint256 amountCleared, bytes32 creditor) {
    Debt storage debt = _debts[entity][tokenId][index];
    amountCleared = debt.amount;
    creditor = debt.creditor;

    if (amountCleared > 0) {
      _afterDebtCleared(entity, isRepayment);
    }

    delete _debts[entity][tokenId][index];
  }

  function _countRemainingDebts(Debt[] storage queue, uint256 cursor) internal view returns (uint256 count) {
    uint256 length = queue.length;
    if (cursor >= length) {
      return 0;
    }
    for (uint256 i = cursor; i < length; i++) {
      if (queue[i].amount > 0) {
        count++;
      }
    }
  }

  function _syncDebtIndex(bytes32 entity, uint256 tokenId) internal {
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

    while (cursor < length && queue[cursor].amount == 0) {
      cursor++;
    }

    if (cursor >= length) {
      _debtIndex[entity][tokenId] = 0;
      delete _debts[entity][tokenId];
    } else {
      _debtIndex[entity][tokenId] = cursor;
    }
  }

  function packTokenReference(uint8 tokenType, address contractAddress, uint96 externalTokenId) public pure returns (bytes32) {
    return Account.packTokenReference(tokenType, contractAddress, externalTokenId);
  }

  function unpackTokenReference(bytes32 packed) public pure returns (address contractAddress, uint96 externalTokenId, uint8 tokenType) {
    return Account.unpackTokenReference(packed);
  }





  // registerHub removed for size reduction

  // ExternalTokenToReserve struct is in Types.sol
  // Public entry point with reentrancy guard for standalone calls
  function externalTokenToReserve(ExternalTokenToReserve memory params) public nonReentrant {
    _externalTokenToReserve(params);
  }

  // Internal version for batch processing (already inside nonReentrant context)
  function _externalTokenToReserve(ExternalTokenToReserve memory params) internal {
    bytes32 targetEntity = params.entity == bytes32(0) ? bytes32(uint256(uint160(msg.sender))) : params.entity;
    if (params.amount == 0) revert E1();

    if (params.internalTokenId == 0) {
      params.internalTokenId = tokenToId[params.packedToken];
      if (params.internalTokenId == 0) {
        _tokens.push(params.packedToken);
        params.internalTokenId = _tokens.length - 1;
        tokenToId[params.packedToken] = params.internalTokenId;
      }
    } else {
      params.packedToken = _tokens[params.internalTokenId];
    }

    (address contractAddress, uint96 tokenId, uint8 tokenType) = unpackTokenReference(params.packedToken);
    if (tokenType == TypeERC20) {
      if (!IERC20(contractAddress).transferFrom(msg.sender, address(this), params.amount)) revert E3();
    } else if (tokenType == TypeERC721) {
      IERC721(contractAddress).transferFrom(msg.sender, address(this), uint(tokenId));
      params.amount = 1;
    } else if (tokenType == TypeERC1155) {
      IERC1155(contractAddress).safeTransferFrom(msg.sender, address(this), uint(tokenId), params.amount, "");
    }

    _reserves[targetEntity][params.internalTokenId] += params.amount;
    emit ReserveUpdated(targetEntity, params.internalTokenId, _reserves[targetEntity][params.internalTokenId]);
  }


  // ReserveToExternalToken struct is in Types.sol
  function reserveToExternalToken(bytes32 entity, ReserveToExternalToken memory params) internal {
    enforceDebts(entity, params.tokenId);

    (address contractAddress, uint96 tokenId, uint8 tokenType) = unpackTokenReference(_tokens[params.tokenId]);
    if (_reserves[entity][params.tokenId] < params.amount) revert E3();

    _reserves[entity][params.tokenId] -= params.amount;
    emit ReserveUpdated(entity, params.tokenId, _reserves[entity][params.tokenId]);

    if (tokenType == TypeERC20) {
      if (!IERC20(contractAddress).transfer(address(uint160(uint256(params.receivingEntity))), params.amount)) revert E3();
    } else if (tokenType == TypeERC721) {
      IERC721(contractAddress).transferFrom(address(this), address(uint160(uint256(params.receivingEntity))), uint(tokenId));
    } else if (tokenType == TypeERC1155) {
      IERC1155(contractAddress).safeTransferFrom(address(this), address(uint160(uint256(params.receivingEntity))), uint(tokenId), params.amount, "");
    }
  }
  // ReserveToReserve struct is in Types.sol
  function reserveToReserve(bytes32 entity, ReserveToReserve memory params) internal {
    
    
    
    
    
    
    
    
    
    
    

    enforceDebts(entity, params.tokenId);

    
    if (_reserves[entity][params.tokenId] >= params.amount) {
      
    } else {
      
      
      
      
      
    }

    if (_reserves[entity][params.tokenId] < params.amount) revert E3();
    
    
    _reserves[entity][params.tokenId] -= params.amount;
    _reserves[params.receivingEntity][params.tokenId] += params.amount;
    
    
    
    
    
    
    
    // Single canonical event per entity whose reserve changed
    emit ReserveUpdated(entity, params.tokenId, _reserves[entity][params.tokenId]);
    emit ReserveUpdated(params.receivingEntity, params.tokenId, _reserves[params.receivingEntity][params.tokenId]);
    
  }

  // transferControlShares and getControlShareTokenId removed for size




  
  // getDebts moved to DepositoryView.sol

  // FIFO debt enforcement - enforces chronological payment order
  function enforceDebts(bytes32 entity, uint tokenId) public returns (uint256) {
    return _enforceDebts(entity, tokenId, type(uint256).max);
  }

  function _enforceDebts(bytes32 entity, uint256 tokenId, uint256 maxIterations) internal returns (uint256 totalDebts) {
    Debt[] storage queue = _debts[entity][tokenId];
    uint256 length = queue.length;
    if (length == 0) {
      _debtIndex[entity][tokenId] = 0;
      return 0;
    }

    uint256 cursor = _debtIndex[entity][tokenId];
    if (cursor >= length) {
      cursor = 0;
    }

    uint256 available = _reserves[entity][tokenId];
    uint256 iterationCap = maxIterations == 0 ? type(uint256).max : maxIterations;
    uint256 iterations = 0;

    if (available == 0) {
      _debtIndex[entity][tokenId] = cursor;
      _syncDebtIndex(entity, tokenId);

      Debt[] storage untouchedQueue = _debts[entity][tokenId];
      if (untouchedQueue.length == 0) {
        return 0;
      }

      return _countRemainingDebts(untouchedQueue, _debtIndex[entity][tokenId]);
    }

    while (cursor < length && available > 0 && iterations < iterationCap) {
      Debt storage debt = queue[cursor];
      uint256 amount = debt.amount;
      if (amount == 0) {
        cursor++;
        continue;
      }

      bytes32 creditor = debt.creditor;
      uint256 payableAmount = available < amount ? available : amount;

      // Pay from reserves first
      if (payableAmount > 0) {
        _reserves[creditor][tokenId] += payableAmount;
        available -= payableAmount;
        amount -= payableAmount;
      }

      // If reserves exhausted but debt remains, try insurance
      if (amount > 0 && available == 0) {
        uint256 insuranceRemaining = _claimFromInsurance(entity, creditor, tokenId, amount);
        uint256 insurancePaid = amount - insuranceRemaining;
        if (insurancePaid > 0) {
          amount = insuranceRemaining;
        }
      }

      // Update debt state
      uint256 totalPaid = debt.amount - amount;
      if (amount == 0) {
        debt.amount = 0;
        emit DebtEnforced(entity, creditor, tokenId, totalPaid, 0, cursor + 1);
        _afterDebtCleared(entity, true);
        delete queue[cursor];
        cursor++;
      } else {
        debt.amount = amount;
        emit DebtEnforced(entity, creditor, tokenId, totalPaid, debt.amount, cursor);
      }

      iterations++;
    }

    _reserves[entity][tokenId] = available;
    _debtIndex[entity][tokenId] = cursor;
    _syncDebtIndex(entity, tokenId);

    Debt[] storage refreshedQueue = _debts[entity][tokenId];
    if (refreshedQueue.length == 0) {
      return 0;
    }

    return _countRemainingDebts(refreshedQueue, _debtIndex[entity][tokenId]);
  }



  function accountKey(bytes32 e1, bytes32 e2) public pure returns (bytes memory) {
    return e1 < e2 ? abi.encodePacked(e1, e2) : abi.encodePacked(e2, e1);
  }

  function reserveToCollateral(bytes32 entity, ReserveToCollateral memory params) internal returns (bool completeSuccess) {
    uint tokenId = params.tokenId;
    bytes32 receivingEntity = params.receivingEntity;
   
    // debts must be paid before any transfers from reserve 
    enforceDebts(entity, tokenId);

    for (uint i = 0; i < params.pairs.length; i++) {
      bytes32 counterentity = params.pairs[i].entity;
      uint amount = params.pairs[i].amount;

      bytes memory ch_key = accountKey(receivingEntity, counterentity);

      
      if (_reserves[entity][tokenId] >= amount) {
        AccountCollateral storage col = _collaterals[ch_key][tokenId];

        _reserves[entity][tokenId] -= amount;
        col.collateral += amount;
        if (receivingEntity < counterentity) { // if receiver is left
          col.ondelta += int(amount);
        }

        // Emit AccountSettled event (canonical ordering: left < right)
        bytes32 leftEntity = receivingEntity < counterentity ? receivingEntity : counterentity;
        bytes32 rightEntity = receivingEntity < counterentity ? counterentity : receivingEntity;

        Settled[] memory settledEvents = new Settled[](1);
        settledEvents[0] = Settled({
          left: leftEntity,
          right: rightEntity,
          tokenId: tokenId,
          leftReserve: _reserves[leftEntity][tokenId],
          rightReserve: _reserves[rightEntity][tokenId],
          collateral: col.collateral,
          ondelta: col.ondelta
        });
        emit Account.AccountSettled(settledEvents);


      } else {
        
        return false;
      }
      
    }


    return true;
  }


  // Handle debt forgiveness and insurance registration for settlements (separated from Account due to stack limits)
  function _handleSettlementDebtAndInsurance(
    bytes32 leftEntity,
    bytes32 rightEntity,
    uint[] memory forgiveDebtsInTokenIds,
    InsuranceRegistration[] memory insuranceRegs
  ) internal {
    // Forgive debts
    for (uint i = 0; i < forgiveDebtsInTokenIds.length; i++) {
      uint tokenId = forgiveDebtsInTokenIds[i];
      _forgiveDebtsBetweenEntities(leftEntity, rightEntity, tokenId);
      _forgiveDebtsBetweenEntities(rightEntity, leftEntity, tokenId);
    }

    // Register insurance
    for (uint i = 0; i < insuranceRegs.length; i++) {
      InsuranceRegistration memory reg = insuranceRegs[i];
      if (reg.insurer != leftEntity && reg.insurer != rightEntity) revert E7();
      if (reg.insured != leftEntity && reg.insured != rightEntity) revert E7();
      if (reg.insurer == reg.insured || reg.limit == 0) revert E2();
      if (reg.expiresAt <= block.timestamp) revert E2();

      insuranceLines[reg.insured].push(InsuranceLine({
        insurer: reg.insurer,
        tokenId: reg.tokenId,
        remaining: reg.limit,
        expiresAt: reg.expiresAt
      }));
      emit InsuranceRegistered(reg.insured, reg.insurer, reg.tokenId, reg.limit, reg.expiresAt);
    }
  }

  function _forgiveDebtsBetweenEntities(bytes32 debtor, bytes32 creditor, uint tokenId) internal {
    uint256 idx = _debtIndex[debtor][tokenId];
    Debt[] storage queue = _debts[debtor][tokenId];
    uint256 len = queue.length;
    for (uint256 j = idx; j < len; j++) {
      if (queue[j].creditor == creditor && queue[j].amount > 0) {
        uint256 amt = queue[j].amount;
        queue[j].amount = 0;
        if (_activeDebts[debtor] > 0) _activeDebts[debtor]--;
        emit DebtForgiven(debtor, creditor, tokenId, amt, j);
      }
    }
    _syncDebtIndex(debtor, tokenId);
  }

  function _increaseReserve(bytes32 entity, uint256 tokenId, uint256 amount) internal {
    if (amount == 0) return;
    _reserves[entity][tokenId] += amount;
    emit ReserveUpdated(entity, tokenId, _reserves[entity][tokenId]);
  }

  // Claims from debtor's insurance lines in FIFO order
  function _claimFromInsurance(bytes32 debtor, bytes32 creditor, uint256 tokenId, uint256 shortfall) internal returns (uint256 remaining) {
    remaining = shortfall;
    InsuranceLine[] storage lines = insuranceLines[debtor];
    uint256 length = lines.length;
    if (length == 0) return remaining;

    uint256 cursor = insuranceCursor[debtor];
    for (uint256 i = cursor; i < length && remaining > 0; i++) {
      InsuranceLine storage line = lines[i];
      if (line.tokenId != tokenId || block.timestamp > line.expiresAt || line.remaining == 0) continue;

      uint256 insurerReserves = _reserves[line.insurer][tokenId];
      uint256 claimAmount = line.remaining < insurerReserves ? line.remaining : insurerReserves;
      if (claimAmount > remaining) claimAmount = remaining;
      if (claimAmount == 0) continue;

      _reserves[line.insurer][tokenId] -= claimAmount;
      emit ReserveUpdated(line.insurer, tokenId, _reserves[line.insurer][tokenId]);
      _increaseReserve(creditor, tokenId, claimAmount);
      line.remaining -= claimAmount;
      remaining -= claimAmount;
      _addDebt(debtor, tokenId, line.insurer, claimAmount);
      emit InsuranceClaimed(debtor, line.insurer, creditor, tokenId, claimAmount);
      cursor = i + 1;
    }
    insuranceCursor[debtor] = cursor;
  }

  // ========== DISPUTE FUNCTIONS ==========
  /// @notice Start dispute - uses Account library
  function disputeStart(InitialDisputeProof memory params) public nonReentrant returns (bool) {
    bytes32 caller = bytes32(uint256(uint160(msg.sender)));
    InitialDisputeProof[] memory starts = new InitialDisputeProof[](1);
    starts[0] = params;
    return Account.processDisputeStarts(_accounts, caller, starts, defaultDisputeDelay);
  }

  /// @notice Finalize dispute - stays in Depository due to storage complexity
  function disputeFinalize(FinalDisputeProof memory params) public nonReentrant returns (bool) {
    bytes32 caller = bytes32(uint256(uint160(msg.sender)));
    return _disputeFinalizeInternal(caller, params);
  }

  /// @notice Internal dispute finalize with full storage access
  function _disputeFinalizeInternal(bytes32 entityId, FinalDisputeProof memory params) internal returns (bool) {
    bytes memory ch_key = accountKey(entityId, params.counterentity);

    if (params.cooperative) {
      // SECURITY: Prevent cooperative finalize on virgin accounts
      // This prevents social engineering attacks where victim signs over empty account
      // Accounts must have at least one prior settlement (cooperativeNonce > 0)
      if (_accounts[ch_key].cooperativeNonce == 0) revert E5();
      if (!Account.verifyCooperativeProofSig(ch_key, _accounts[ch_key].cooperativeNonce, keccak256(abi.encode(params.finalProofbody)), keccak256(params.initialArguments), params.sig, params.counterentity)) revert E4();
    } else {
      bytes32 storedHash = _accounts[ch_key].disputeHash;
      if (storedHash == bytes32(0)) revert E5();

      bytes32 expectedHash = Account.encodeDisputeHash(
        _accounts[ch_key].cooperativeNonce, params.initialDisputeNonce, params.startedByLeft,
        _accounts[ch_key].disputeTimeout, params.initialProofbodyHash, params.initialArguments
      );
      if (storedHash != expectedHash) revert E9();

      if (params.sig.length > 0) {
        if (!Account.verifyFinalDisputeProofSig(ch_key, params.finalCooperativeNonce, params.initialDisputeNonce, params.finalDisputeNonce, params.sig, params.counterentity)) revert E4();
        if (params.initialDisputeNonce >= params.finalDisputeNonce) revert E2();
      } else {
        bool senderIsCounterparty = params.startedByLeft != (entityId < params.counterentity);
        if (!senderIsCounterparty && block.number < _accounts[ch_key].disputeTimeout) revert E2();
        if (params.initialProofbodyHash != keccak256(abi.encode(params.finalProofbody))) revert E2();
      }
    }

    _accounts[ch_key].disputeHash = bytes32(0);
    _accounts[ch_key].disputeTimeout = 0;

    return _finalizeAccount(entityId, params.counterentity, params.finalProofbody, params.finalArguments, params.initialArguments);
  }

  /// @notice Finalize account - applies deltas and clears collateral
  function _finalizeAccount(
    bytes32 entity1, bytes32 entity2, ProofBody memory proofbody, bytes memory arguments1, bytes memory arguments2
  ) internal returns (bool) {
    if (proofbody.tokenIds.length != proofbody.offdeltas.length) revert E8();

    bytes32 leftAddr = entity1 < entity2 ? entity1 : entity2;
    bytes32 rightAddr = entity1 < entity2 ? entity2 : entity1;
    bytes memory leftArgs = entity1 < entity2 ? arguments1 : arguments2;
    bytes memory rightArgs = entity1 < entity2 ? arguments2 : arguments1;
    bytes memory ch_key = accountKey(leftAddr, rightAddr);

    // NOTE: On-chain settlement must apply TOTAL delta (ondelta + offdelta).
    // - `col.ondelta` tracks the on-chain component (e.g., collateral funding events).
    // - `proofbody.offdeltas` is the off-chain component agreed/derived by parties.
    uint256 tokenCount = proofbody.tokenIds.length;
    int[] memory deltas = new int[](tokenCount);
    for (uint256 i = 0; i < tokenCount; i++) {
      uint256 tokenId = proofbody.tokenIds[i];
      deltas[i] = _collaterals[ch_key][tokenId].ondelta + proofbody.offdeltas[i];
    }

    bytes[] memory decodedLeft = leftArgs.length > 0 ? abi.decode(leftArgs, (bytes[])) : new bytes[](0);
    bytes[] memory decodedRight = rightArgs.length > 0 ? abi.decode(rightArgs, (bytes[])) : new bytes[](0);

    // Apply transformers
    for (uint256 i = 0; i < proofbody.transformers.length; i++) {
      TransformerClause memory tc = proofbody.transformers[i];
      int[] memory newDeltas = DeltaTransformer(tc.transformerAddress).applyBatch(
        deltas, tc.encodedBatch,
        i < decodedLeft.length ? decodedLeft[i] : bytes(""),
        i < decodedRight.length ? decodedRight[i] : bytes("")
      );

      for (uint256 j = 0; j < tc.allowances.length; j++) {
        Allowance memory allow = tc.allowances[j];
        int diff = newDeltas[allow.deltaIndex] - deltas[allow.deltaIndex];
        if (diff > 0 && uint256(diff) > allow.leftAllowance) revert E2();
        if (diff < 0 && uint256(-diff) > allow.rightAllowance) revert E2();
      }
      deltas = newDeltas;
    }

    // Apply deltas
    for (uint256 i = 0; i < proofbody.tokenIds.length; i++) {
      _applyAccountDelta(ch_key, proofbody.tokenIds[i], leftAddr, rightAddr, deltas[i]);
    }

    _accounts[ch_key].cooperativeNonce++;
    return true;
  }

  /// @notice Apply delta to account collateral and reserves
  function _applyAccountDelta(bytes memory ch_key, uint256 tokenId, bytes32 leftEntity, bytes32 rightEntity, int delta) internal {
    AccountCollateral storage col = _collaterals[ch_key][tokenId];
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

  /// @notice Settle shortfall via reserves, insurance, then debt
  function _settleShortfall(bytes32 debtor, bytes32 creditor, uint256 tokenId, uint256 amount) internal {
    if (amount == 0) return;

    uint256 available = _reserves[debtor][tokenId];
    uint256 payAmount = available >= amount ? amount : available;
    if (payAmount > 0) {
      _reserves[debtor][tokenId] -= payAmount;
      emit ReserveUpdated(debtor, tokenId, _reserves[debtor][tokenId]);
      _increaseReserve(creditor, tokenId, payAmount);
    }

    uint256 remaining = amount - payAmount;
    if (remaining == 0) return;

    remaining = _claimFromInsurance(debtor, creditor, tokenId, remaining);
    if (remaining > 0) {
      _addDebt(debtor, tokenId, creditor, remaining);
      _syncDebtIndex(debtor, tokenId);
    }
  }





  // getUsers and getAccounts moved to DepositoryView.sol

  // createDebt removed for size reduction

  function onERC1155Received(address, address from, uint256 id, uint256 value, bytes calldata) external returns (bytes4) {
    // SECURITY FIX: Don't credit here - _externalTokenToReserve:713 already credits
    // This prevents double-crediting when ERC1155.safeTransferFrom triggers this callback
    // If tokens sent directly (not via externalTokenToReserve), they will be stuck but not inflate reserves
    bytes32 packedToken = packTokenReference(TypeERC1155, msg.sender, uint96(id));
    uint256 tid = tokenToId[packedToken];
    if (tid == 0) { _tokens.push(packedToken); tid = _tokens.length - 1; tokenToId[packedToken] = tid; }
    // DO NOT credit reserves here to avoid double-crediting
    // _reserves[entity][tid] += value; // REMOVED
    return this.onERC1155Received.selector;
  }
  function onERC1155BatchReceived(address,address,uint256[] calldata,uint256[] calldata,bytes calldata) external pure returns (bytes4) { revert("!batch"); }
}
