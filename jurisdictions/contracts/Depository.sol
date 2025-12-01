// SPDX-License-Identifier: unknown
pragma solidity ^0.8.24;

import "./ECDSA.sol";
import "./console.sol";
import "./EntityProvider.sol";
import "./SubcontractProvider.sol";

abstract contract ReentrancyGuardLite {
  uint256 private constant _NOT_ENTERED = 1;
  uint256 private constant _ENTERED = 2;
  uint256 private _status = _NOT_ENTERED;

  modifier nonReentrant() {
    require(_status != _ENTERED, "ReentrancyGuard: reentrant call");
    _status = _ENTERED;
    _;
    _status = _NOT_ENTERED;
  }
}

// Add necessary interfaces
interface IERC20 {
  function transfer(address to, uint256 value) external returns (bool);
  function transferFrom(address from, address to, uint256 value) external returns (bool);
}
interface IERC721 {
  function transferFrom(address from, address to, uint256 tokenId) external;
}
//interface IERC1155 {
//  function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata data) external;
//}
// IERC1155 already imported from EntityProvider.sol

/* The mechanism:
  - Collateral bounds max exposure (like Lightning)
  - But credit can extend beyond (unlike Lightning)
  - Debt enforcement is mechanical (FIFO queue + liquidity trap)
  - No "please pay me back" - enforceDebts() is called on every reserve withdrawal

  First in history: No system combines escrowed collateral + credit extension + mechanical enforcement. Traditional finance has credit but it's
  social/legal enforcement. Crypto has collateral but no credit extension. You have both.
*/
contract Depository is Console, ReentrancyGuardLite {

  // Multi-provider support  
  mapping(address => bool) public approvedEntityProviders;
  address[] public entityProvidersList;
  
  mapping (bytes32 => mapping (uint => uint)) public _reserves;

  mapping (bytes => ChannelInfo) public _channels;
  mapping (bytes => mapping(uint => ChannelCollateral)) public _collaterals; 
  

  mapping (bytes32 => mapping (uint => Debt[])) public _debts;
  // the current debt index to pay
  mapping (bytes32 => mapping (uint => uint)) public _debtIndex;
  // total number of debts of an entity  
  mapping (bytes32 => uint) public _activeDebts;

  struct TokenDebtStats {
    uint256 outstandingAmount;
    uint64 since;
    uint64 lastUpdated;
  }

  mapping(bytes32 => mapping(uint256 => TokenDebtStats)) private _tokenDebtStats;

  address public immutable admin;
  bool public emergencyPause;

  // Insurance gas threshold - stop iterating if gasleft() drops below this
  uint256 public minGasForInsurance = 50000;

  // Insurance cursor - tracks iteration position per insured entity
  mapping(bytes32 => uint256) public insuranceCursor;

  event DebtCreated(bytes32 indexed debtor, bytes32 indexed creditor, uint256 indexed tokenId, uint256 amount, uint256 debtIndex);
  event DebtEnforced(bytes32 indexed debtor, bytes32 indexed creditor, uint256 indexed tokenId, uint256 amountPaid, uint256 remainingAmount, uint256 newDebtIndex);
  event DebtForgiven(bytes32 indexed debtor, bytes32 indexed creditor, uint256 indexed tokenId, uint256 amountForgiven, uint256 debtIndex);
  event EmergencyPauseToggled(bool isPaused);

  modifier onlyAdmin() {
    require(msg.sender == admin, "Depository: admin only");
    _;
  }

  modifier whenNotPaused() {
    require(!emergencyPause, "Depository: paused");
    _;
  }


  // === REPUTATION SCORES ===

  struct EntityScore {
    // Total gas used by the entity in `processBatch` calls. Tracks overall activity.
    uint64 totalGasUsed;
    // Timestamp when the entity first acquired an active debt. Resets to 0 when all debts are cleared.
    uint48 inDebtSince;
    // The total number of outstanding debts across all tokens.
    uint32 totalActiveDebts;
    // Counter for how many times the entity has been involved in a dispute.
    uint32 totalDisputes;
    // A counter for successfully paid-off debts. A measure of reliability.
    uint32 successfulRepayments;
    // A counter for successful cooperative settlements. A measure of good-faith participation.
    uint32 cooperativeActions;
  }

  mapping(bytes32 => EntityScore) public entityScores;


  struct Settled {
      bytes32 left;
      bytes32 right;
      uint tokenId;
      uint leftReserve;
      uint rightReserve;
      uint collateral;
      int ondelta;
  }
  event ChannelSettled(Settled[]);

  struct Hub {
    bytes32 entityId;
    uint gasused;
    string uri;
  }
  Hub[] public _hubs;
  
  event TransferReserveToCollateral(bytes32 indexed receivingEntity, bytes32 indexed counterentity, uint collateral, int ondelta, uint tokenId);
  event DisputeStarted(bytes32 indexed sender, bytes32 indexed counterentity, uint indexed disputeNonce, bytes initialArguments);
  event CooperativeClose(bytes32 indexed sender, bytes32 indexed counterentity, uint indexed cooperativeNonce);
  
  event ReserveTransferred(bytes32 indexed from, bytes32 indexed to, uint indexed tokenId, uint amount);

  /**
   * @notice Emitted when reserves are minted (created from thin air) to an entity.
   * @dev This is distinct from ReserveTransferred (which moves existing reserves).
   * @param entity The entity receiving the minted reserves.
   * @param tokenId The internal ID of the token.
   * @param amount The amount minted.
   * @param newBalance The absolute new balance after minting.
   */
  event ReserveMinted(bytes32 indexed entity, uint indexed tokenId, uint amount, uint newBalance);

  /**
   * @notice Emitted whenever an entity's reserve balance for a specific token changes.
   * @dev This is the primary event for j-watchers to sync entity state.
   * @param entity The entity whose reserve was updated.
   * @param tokenId The internal ID of the token.
   * @param newBalance The absolute new balance of the token for the entity.
   */
  event ReserveUpdated(bytes32 indexed entity, uint indexed tokenId, uint newBalance);

  /**
   * @notice Emitted when entities settle off-chain account differences
   * @dev This event contains final absolute values after settlement processing
   * @param leftEntity The first entity in the settlement
   * @param rightEntity The second entity in the settlement
   * @param tokenId The token being settled
   * @param leftReserve Final absolute reserve balance for left entity
   * @param rightReserve Final absolute reserve balance for right entity
   * @param collateral Final absolute collateral amount
   * @param ondelta Final ondelta value
   */
  event SettlementProcessed(
    bytes32 indexed leftEntity,
    bytes32 indexed rightEntity,
    uint indexed tokenId,
    uint leftReserve,
    uint rightReserve,
    uint collateral,
    int ondelta
  );

  //event ChannelUpdated(address indexed receiver, address indexed addr, uint tokenId);


  // Token type identifiers
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
    require(approvedEntityProviders[provider], "Provider not approved");
    _;
  }
  
  /**
   * @notice Add an EntityProvider to approved list
   * @param provider EntityProvider contract address
   */
  function addEntityProvider(address provider) external onlyAdmin {
    require(provider != address(0), "Invalid provider");
    require(!approvedEntityProviders[provider], "Already approved");
    approvedEntityProviders[provider] = true;
    entityProvidersList.push(provider);
    emit EntityProviderAdded(provider);
  }
  
  /**
   * @notice Remove an EntityProvider from approved list  
   * @param provider EntityProvider contract address
   */
  function removeEntityProvider(address provider) external onlyAdmin {
    require(provider != address(0), "Invalid provider");
    require(approvedEntityProviders[provider], "Not approved");
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

    // empty record, hub_id==0 means not a hub
    _hubs.push(Hub({
      entityId: bytes32(0),
      uri: '',
      gasused: 0
    }));
  }

  function setEmergencyPause(bool isPaused) external onlyAdmin {
    if (emergencyPause == isPaused) {
      return;
    }
    emergencyPause = isPaused;
    emit EmergencyPauseToggled(isPaused);
  }

  function setMinGasForInsurance(uint256 _minGas) external onlyAdmin {
    minGasForInsurance = _minGas;
  }

  function getTokensLength() public view returns (uint) {
    return _tokens.length;
  }

  function getTokenMetadata(uint256 tokenId) external view returns (address contractAddress, uint96 externalTokenId, uint8 tokenType) {
    require(tokenId < _tokens.length, "Invalid tokenId");
    return unpackTokenReference(_tokens[tokenId]);
  }





  struct Batch {
    // tokens move Token <=> Reserve <=> Collateral
    // but never Token <=> Collateral. 'reserve' acts as an intermediary balance
    ReserveToExternalToken[] reserveToExternalToken;
    ExternalTokenToReserve[] externalTokenToReserve;

    // don't require a signature
    ReserveToReserve[] reserveToReserve;
    ReserveToCollateral[] reserveToCollateral;

    // NEW: Simple settlements between entities (no signature verification for now)
    Settlement[] settlements;
    
    // DEPRECATED: Keep for backwards compatibility but will be replaced
    CooperativeUpdate[] cooperativeUpdate;
    CooperativeDisputeProof[] cooperativeDisputeProof;

    // initialDisputeProof is signed by the peer, but could be outdated
    // another peer has time to respond with a newer proof
    InitialDisputeProof[] initialDisputeProof;
    FinalDisputeProof[] finalDisputeProof;


    TokenAmountPair[] flashloans;

    //bytes32[] revealSecret;
    //bytes32[] cleanSecret;
    uint hub_id;
  }
  // === HANKO INTEGRATION ===

  /// @notice Sequential nonce for each entity authorising batches via Hanko.
  mapping(address => uint256) public entityNonces;

  /// @notice Domain separator used when hashing Hanko payloads for verification.
  bytes32 public constant DOMAIN_SEPARATOR = keccak256("XLN_DEPOSITORY_HANKO_V1");

  event HankoBatchProcessed(bytes32 indexed entityId, bytes32 indexed hankoHash, uint256 nonce, bool success);

  /**
   * @notice Process a batch that carries an off-chain Hanko authorisation.
   * @dev Signature verification is performed on-chain against an approved EntityProvider.
   */
  function processBatchWithHanko(
    bytes calldata encodedBatch,
    address entityProvider,
    bytes calldata hankoData,
    uint256 nonce
  ) external whenNotPaused nonReentrant onlyApprovedProvider(entityProvider) returns (bool completeSuccess) {
    bytes32 domainSeparatedHash = keccak256(
      abi.encodePacked(
        DOMAIN_SEPARATOR,
        block.chainid,
        address(this),
        encodedBatch,
        nonce
      )
    );

    (bytes32 entityId, bool hankoValid) = EntityProvider(entityProvider).verifyHankoSignature(
      hankoData,
      domainSeparatedHash
    );

    require(hankoValid, "Depository: invalid hanko");
    require(entityId != bytes32(0), "Depository: empty entity");

    address entityAddress = address(uint160(uint256(entityId)));
    require(nonce == entityNonces[entityAddress] + 1, "Depository: stale nonce");
    entityNonces[entityAddress] = nonce;

    Batch memory batch = abi.decode(encodedBatch, (Batch));
    bytes32 hankoHash = keccak256(hankoData);

    completeSuccess = _processBatch(entityId, batch);
    emit HankoBatchProcessed(entityId, hankoHash, nonce, completeSuccess);
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
    require(amount > 0, "Amount zero");
    console.log("mintToReserve: minting to entity");
    console.logBytes32(entity);
    console.log("mintToReserve: tokenId");
    console.logUint(tokenId);
    console.log("mintToReserve: amount");
    console.logUint(amount);

    _reserves[entity][tokenId] += amount;
    uint newBalance = _reserves[entity][tokenId];

    emit ReserveMinted(entity, tokenId, amount, newBalance);
    emit ReserveUpdated(entity, tokenId, newBalance);

    console.log("mintToReserve: new balance");
    console.logUint(newBalance);
  }

  // @deprecated Use mintToReserve instead. Kept for backwards compatibility.
  function debugFundReserves(bytes32 entity, uint tokenId, uint amount) external onlyAdmin {
    require(amount > 0, "Amount zero");
    _reserves[entity][tokenId] += amount;
    uint newBalance = _reserves[entity][tokenId];
    emit ReserveMinted(entity, tokenId, amount, newBalance);
    emit ReserveUpdated(entity, tokenId, newBalance);
  }

  // DEBUG: Bulk fund top 1000 entities with test reserves
  function debugBulkFundEntities() external onlyAdmin {
    console.log("debugBulkFundEntities: funding entities 1-200 with USDC and ETH");

    uint256 fundAmount = 100000000000000000000; // 100 units (100e18)

    for (uint256 entityNum = 1; entityNum <= 500; entityNum++) {
      bytes32 entity = bytes32(entityNum); // Entity ID is just the number padded

      // Fund with tokens 1 (USDC), 2 (ETH) only
      for (uint256 tokenId = 1; tokenId <= 2; tokenId++) {
        _reserves[entity][tokenId] += fundAmount;
        emit ReserveUpdated(entity, tokenId, _reserves[entity][tokenId]);
      }
    }

    console.log("debugBulkFundEntities: funding complete");
  }

  function processBatch(bytes32 entity, Batch calldata batch) public whenNotPaused nonReentrant returns (bool completeSuccess) {
    console.log("=== processBatch ENTRY ===");
    console.log("=== processBatch ENTRY ===");
    console.log("=== processBatch ENTRY ===");
    console.log("processBatch called with entity");
    console.logBytes32(entity);
    console.log("batch.reserveToReserve.length");
    console.logUint(batch.reserveToReserve.length);
    console.log("msg.sender:");
    console.logAddress(msg.sender);
    
    if (batch.reserveToReserve.length > 0) {
      console.log("First transfer details:");
      console.log("  to entity:");
      console.logBytes32(batch.reserveToReserve[0].receivingEntity);
      console.log("  tokenId:");
      console.logUint(batch.reserveToReserve[0].tokenId);
      console.log("  amount:");
      console.logUint(batch.reserveToReserve[0].amount);
      
      console.log("Sender current balance:");
      console.logUint(_reserves[entity][batch.reserveToReserve[0].tokenId]);
    }
    
    console.log("=== CALLING _processBatch ===");
    return _processBatch(entity, batch);
  }


  // ========== ACCOUNT PREFUNDING FUNCTION ==========
  // Allows an entity to fund an account's collateral from their reserves
  function prefundAccount(bytes32 counterpartyEntity, uint tokenId, uint amount) public whenNotPaused nonReentrant returns (bool) {
    bytes32 fundingEntity = bytes32(uint256(uint160(msg.sender)));
    require(fundingEntity != counterpartyEntity, "Cannot prefund account with self");
    require(amount > 0, "Amount zero");
    
    // Ensure entities are in canonical order (left < right)
    bytes32 leftEntity = fundingEntity < counterpartyEntity ? fundingEntity : counterpartyEntity;
    bytes32 rightEntity = fundingEntity < counterpartyEntity ? counterpartyEntity : fundingEntity;
    
    // Simple channel key: hash of left and right entities converted to bytes
    bytes memory ch_key = abi.encodePacked(keccak256(abi.encodePacked(leftEntity, rightEntity)));
    
    enforceDebts(fundingEntity, tokenId);

    // Check funding entity has sufficient reserves
    require(_reserves[fundingEntity][tokenId] >= amount, "Insufficient reserves for prefunding");
    
    // Move funds from reserves to account collateral
    _reserves[fundingEntity][tokenId] -= amount;
    emit ReserveUpdated(fundingEntity, tokenId, _reserves[fundingEntity][tokenId]);

    ChannelCollateral storage col = _collaterals[ch_key][tokenId];
    col.collateral += amount;
    
    // Emit SettlementProcessed event to notify both entities
    emit SettlementProcessed(
      leftEntity,
      rightEntity,
      tokenId,
      _reserves[leftEntity][tokenId],
      _reserves[rightEntity][tokenId],
      col.collateral,
      col.ondelta
    );
    
    console.log("Account prefunded:");
    console.logBytes32(fundingEntity);
    console.log("funded account with:");
    console.logBytes32(counterpartyEntity);
    console.log("amount:");
    console.logUint(amount);
    
    return true;
  }

  // ========== DIRECT R2R FUNCTION ==========
  // Simple reserve-to-reserve transfer (simpler than batch)
  function reserveToReserve(bytes32 fromEntity, bytes32 toEntity, uint tokenId, uint amount) public whenNotPaused nonReentrant returns (bool) {
    require(fromEntity != toEntity, "Cannot transfer to self");
    require(amount > 0, "Amount zero");
    enforceDebts(fromEntity, tokenId);
    require(_reserves[fromEntity][tokenId] >= amount, "Insufficient reserves");

    console.log("=== DIRECT R2R TRANSFER ===");
    console.logBytes32(fromEntity);
    console.log("to");
    console.logBytes32(toEntity);
    console.log("amount:");
    console.logUint(amount);

    // Simple transfer: subtract from sender, add to receiver
    _reserves[fromEntity][tokenId] -= amount;
    _reserves[toEntity][tokenId] += amount;

    // Emit events for j-watcher
    emit ReserveUpdated(fromEntity, tokenId, _reserves[fromEntity][tokenId]);
    emit ReserveUpdated(toEntity, tokenId, _reserves[toEntity][tokenId]);
    emit ReserveTransferred(fromEntity, toEntity, tokenId, amount);

    console.log("=== R2R TRANSFER COMPLETE ===");
    return true;
  }

  // ========== SETTLE FUNCTION (merged from cooperativeUpdate) ==========
  // Bilateral settlement with signature verification and nonce tracking
  // Can be called independently or as part of processBatch
  function settle(
    bytes32 leftEntity,
    bytes32 rightEntity,
    SettlementDiff[] memory diffs,
    uint[] memory forgiveDebtsInTokenIds,
    InsuranceRegistration[] memory insuranceRegs,
    bytes memory sig
  ) public whenNotPaused nonReentrant returns (bool) {
    require(leftEntity != rightEntity, "Cannot settle with self");
    require(leftEntity < rightEntity, "Entities must be in order (left < right)");

    // Simple channel key: hash of left and right entities converted to bytes
    bytes memory ch_key = abi.encodePacked(keccak256(abi.encodePacked(leftEntity, rightEntity)));

    // Determine caller and counterparty
    bytes32 caller = bytes32(uint256(uint160(msg.sender)));
    bool isInternalCall = msg.sender == address(this);

    // For internal calls (from processBatch), caller is passed in entityId
    // For external calls, verify caller is one of the entities
    if (!isInternalCall) {
      require(caller == leftEntity || caller == rightEntity, "Only involved entities can settle");
    }

    bytes32 counterparty = (caller == leftEntity) ? rightEntity : leftEntity;

    // Signature verification (skip for internal calls during development)
    if (!isInternalCall && sig.length > 0) {
      bytes memory encoded_msg = abi.encode(
        MessageType.CooperativeUpdate,
        ch_key,
        _channels[ch_key].cooperativeNonce,
        diffs,
        forgiveDebtsInTokenIds,
        insuranceRegs
      );

      bytes32 hash = ECDSA.toEthSignedMessageHash(keccak256(encoded_msg));

      address recoveredSigner = ECDSA.recover(hash, sig);
      address counterpartyAddress = address(uint160(uint256(counterparty)));
      require(recoveredSigner == counterpartyAddress, "Invalid counterparty signature");
    }

    // Update cooperative action scores
    entityScores[leftEntity].cooperativeActions++;
    entityScores[rightEntity].cooperativeActions++;
    
    for (uint j = 0; j < diffs.length; j++) {
      SettlementDiff memory diff = diffs[j];
      uint tokenId = diff.tokenId;
      
      // ✅ INVARIANT CHECK: Total value change must be zero
      // leftDiff + rightDiff + collateralDiff == 0
      require(diff.leftDiff + diff.rightDiff + diff.collateralDiff == 0, "Settlement must balance");
      
      // Update left entity reserves
      if (diff.leftDiff < 0) {
        require(_reserves[leftEntity][tokenId] >= uint(-diff.leftDiff), "Left entity insufficient reserves");
        _reserves[leftEntity][tokenId] -= uint(-diff.leftDiff);
      } else if (diff.leftDiff > 0) {
        _reserves[leftEntity][tokenId] += uint(diff.leftDiff);
      }
      
      // Update right entity reserves  
      if (diff.rightDiff < 0) {
        require(_reserves[rightEntity][tokenId] >= uint(-diff.rightDiff), "Right entity insufficient reserves");
        _reserves[rightEntity][tokenId] -= uint(-diff.rightDiff);
      } else if (diff.rightDiff > 0) {
        _reserves[rightEntity][tokenId] += uint(diff.rightDiff);
      }
      
      // Update collateral
      ChannelCollateral storage col = _collaterals[ch_key][tokenId];
      if (diff.collateralDiff < 0) {
        require(col.collateral >= uint(-diff.collateralDiff), "Insufficient collateral");
        col.collateral -= uint(-diff.collateralDiff);
      } else if (diff.collateralDiff > 0) {
        col.collateral += uint(diff.collateralDiff);
      }
      
      // Update ondelta
      col.ondelta += diff.ondeltaDiff;
    }

    // Forgive debts in specified tokens
    for (uint i = 0; i < forgiveDebtsInTokenIds.length; i++) {
      uint tokenId = forgiveDebtsInTokenIds[i];

      // Forgive left entity's debts to right entity
      uint256 leftDebtIndex = _debtIndex[leftEntity][tokenId];
      Debt[] storage leftDebts = _debts[leftEntity][tokenId];
      uint256 leftLength = leftDebts.length;
      for (uint256 j = leftDebtIndex; j < leftLength; j++) {
        if (leftDebts[j].creditor == rightEntity && leftDebts[j].amount > 0) {
          (uint256 forgivenAmount, bytes32 creditor) = _clearDebtAtIndex(leftEntity, tokenId, j, false);
          if (forgivenAmount > 0) {
            emit DebtForgiven(leftEntity, creditor, tokenId, forgivenAmount, j);
          }
        }
      }
      _syncDebtIndex(leftEntity, tokenId);

      // Forgive right entity's debts to left entity
      uint256 rightDebtIndex = _debtIndex[rightEntity][tokenId];
      Debt[] storage rightDebts = _debts[rightEntity][tokenId];
      uint256 rightLength = rightDebts.length;
      for (uint256 j = rightDebtIndex; j < rightLength; j++) {
        if (rightDebts[j].creditor == leftEntity && rightDebts[j].amount > 0) {
          (uint256 forgivenAmount, bytes32 creditor) = _clearDebtAtIndex(rightEntity, tokenId, j, false);
          if (forgivenAmount > 0) {
            emit DebtForgiven(rightEntity, creditor, tokenId, forgivenAmount, j);
          }
        }
      }
      _syncDebtIndex(rightEntity, tokenId);
    }

    // Process insurance registrations (mutual agreement via settle signature)
    for (uint i = 0; i < insuranceRegs.length; i++) {
      InsuranceRegistration memory reg = insuranceRegs[i];

      // Insurer must be one of the settling parties
      require(reg.insurer == leftEntity || reg.insurer == rightEntity, "Insurer must be settling party");
      // Insured must be one of the settling parties
      require(reg.insured == leftEntity || reg.insured == rightEntity, "Insured must be settling party");
      // Can't insure yourself
      require(reg.insurer != reg.insured, "Cannot self-insure");
      // Must have future expiry
      require(reg.expiresAt > block.timestamp, "Insurance already expired");
      // Must have limit
      require(reg.limit > 0, "Insurance limit must be positive");

      // Add to insured's FIFO queue
      insuranceLines[reg.insured].push(InsuranceLine({
        insurer: reg.insurer,
        tokenId: reg.tokenId,
        remaining: reg.limit,
        expiresAt: reg.expiresAt
      }));

      emit InsuranceRegistered(reg.insured, reg.insurer, reg.tokenId, reg.limit, reg.expiresAt);
    }

    // Emit ChannelSettled event with final values
    Settled[] memory settledEvents = new Settled[](diffs.length);
    for (uint i = 0; i < diffs.length; i++) {
      uint tokenId = diffs[i].tokenId;
      ChannelCollateral storage col = _collaterals[ch_key][tokenId];

      settledEvents[i] = Settled({
        left: leftEntity,
        right: rightEntity,
        tokenId: tokenId,
        leftReserve: _reserves[leftEntity][tokenId],
        rightReserve: _reserves[rightEntity][tokenId],
        collateral: col.collateral,
        ondelta: col.ondelta
      });
    }

    if (settledEvents.length > 0) {
      emit ChannelSettled(settledEvents);
    }

    // Increment nonce to invalidate old proofs
    _channels[ch_key].cooperativeNonce++;

    return true;
  }

  function _processBatch(bytes32 entityId, Batch memory batch) private returns (bool completeSuccess) {
    console.log("_processBatch starting for entity");
    console.logBytes32(entityId);
    uint startGas = gasleft();

    // the order is important: first go methods that increase entity's balance
    // then methods that deduct from it

    completeSuccess = true; 

    // Process reserveToReserve transfers (the core functionality we need)
    console.log("Processing reserveToReserve transfers count:");
    console.logUint(batch.reserveToReserve.length);
    for (uint i = 0; i < batch.reserveToReserve.length; i++) {
      console.log("Transfer index:");
      console.logUint(i);
      console.log("From entity:");
      console.logBytes32(entityId);
      console.log("To entity:");
      console.logBytes32(batch.reserveToReserve[i].receivingEntity);
      console.log("Token ID:");
      console.logUint(batch.reserveToReserve[i].tokenId);
      console.log("Amount:");
      console.logUint(batch.reserveToReserve[i].amount);
      reserveToReserve(entityId, batch.reserveToReserve[i]);
    }

    // NEW: Process settlements (bilateral settlements with signatures)
    console.log("Processing settlements count:");
    console.logUint(batch.settlements.length);
    for (uint i = 0; i < batch.settlements.length; i++) {
      Settlement memory settlement = batch.settlements[i];
      console.log("Settlement between:");
      console.logBytes32(settlement.leftEntity);
      console.log("and:");
      console.logBytes32(settlement.rightEntity);

      if (!settle(
        settlement.leftEntity,
        settlement.rightEntity,
        settlement.diffs,
        settlement.forgiveDebtsInTokenIds,
        settlement.insuranceRegs,
        settlement.sig
      )) {
        completeSuccess = false;
      }
    }

    if (batch.flashloans.length > 0) {
      revert("Depository: flashloans disabled");
    }

    for (uint i = 0; i < batch.cooperativeUpdate.length; i++) {
      if(!(cooperativeUpdate(entityId, batch.cooperativeUpdate[i]))){
        completeSuccess = false;
      }
    }
    for (uint i = 0; i < batch.cooperativeDisputeProof.length; i++) {
      if(!(cooperativeDisputeProof(batch.cooperativeDisputeProof[i]))){
        completeSuccess = false;
      }
    }

    //submitProof (Header / proofbody)

    for (uint i = 0; i < batch.initialDisputeProof.length; i++) {
      if(!(initialDisputeProof(batch.initialDisputeProof[i]))){
        completeSuccess = false;
      }
    }

    for (uint i = 0; i < batch.finalDisputeProof.length; i++) {
      if(!(finalDisputeProof(batch.finalDisputeProof[i]))){
        completeSuccess = false;
      }
    }

    for (uint i = 0; i < batch.reserveToCollateral.length; i++) {
      if(!(reserveToCollateral(entityId, batch.reserveToCollateral[i]))){
        completeSuccess = false;
      }
    }

    // increase gasused for hubs
    // this is hardest to fake metric of real usage
    if (batch.hub_id != 0 && entityId == _hubs[batch.hub_id].entityId){
      _hubs[batch.hub_id].gasused += startGas - gasleft();
    }

    // Update entity's gas usage score
    entityScores[entityId].totalGasUsed += uint64(startGas - gasleft());

    return completeSuccess;
    
  }

  
  enum MessageType {
    CooperativeUpdate,
    CooperativeDisputeProof,
    DisputeProof,
    FinalDisputeProof
  }

  struct TokenAmountPair {
    uint tokenId;
    uint amount;
  }

  struct AddrAmountPair {
    bytes32 entity;
    uint amount;
  }

  struct ReserveToCollateral {
    uint tokenId;
    bytes32 receivingEntity;
    // put in _channels with who (addr) and how much (amount)
    AddrAmountPair[] pairs;
  }

  struct Diff {
    uint tokenId;
    int peerReserveDiff;
    int collateralDiff;
    int ondeltaDiff;
  }

  // Simplified settlement diff structure
  struct SettlementDiff {
    uint tokenId;
    int leftDiff;        // Change for left entity
    int rightDiff;       // Change for right entity
    int collateralDiff;  // Change in collateral
    int ondeltaDiff;     // Change in ondelta
  }

  // Settlement batch between two entities
  struct Settlement {
    bytes32 leftEntity;
    bytes32 rightEntity;
    SettlementDiff[] diffs;
    uint[] forgiveDebtsInTokenIds;  // Token IDs where debts should be forgiven
    InsuranceRegistration[] insuranceRegs;  // Insurance lines to register
    bytes sig;                       // Signature from counterparty
  }
  //Enforces the invariant: Its main job is to run the check you described: require(leftReserveDiff + rightReserveDiff + collateralDiff == 0). This guarantees no value is created or lost, only moved.
  struct CooperativeUpdate {
    bytes32 counterentity;
    Diff[] diffs;
    uint[] forgiveDebtsInTokenIds;
    bytes sig; 
  }





  struct Allowence {
    uint deltaIndex;
    uint rightAllowence;
    uint leftAllowence;
  }
  struct SubcontractClause {
    address subcontractProviderAddress;
    bytes encodedBatch;
    Allowence[] allowences;
  }

  struct ProofBody{
    int[] offdeltas;
    uint[] tokenIds;
    SubcontractClause[] subcontracts;
  }

  struct CooperativeDisputeProof {
    bytes32 counterentity;
    ProofBody proofbody;
    bytes initialArguments;
    bytes finalArguments;
    bytes sig;
  }

  struct InitialDisputeProof {
    bytes32 counterentity;
    uint cooperativeNonce;
    uint disputeNonce;
    bytes32 proofbodyHash; 
    bytes sig;

    bytes initialArguments;
  }

  struct FinalDisputeProof {
    bytes32 counterentity;
    uint initialCooperativeNonce;
    uint initialDisputeNonce;
    uint disputeUntilBlock;
    bytes32 initialProofbodyHash;
    bytes initialArguments;
    bool startedByLeft;

    uint finalCooperativeNonce;
    uint finalDisputeNonce;
    ProofBody finalProofbody;
    bytes finalArguments;

    bytes sig;
  }

  struct Debt {
    uint amount;
    bytes32 creditor;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //                              INSURANCE
  // ═══════════════════════════════════════════════════════════════════════════

  struct InsuranceLine {
    bytes32 insurer;      // Entity providing coverage
    uint256 tokenId;      // Token covered
    uint256 remaining;    // Coverage left (decreases on claim)
    uint64 expiresAt;     // Block timestamp expiration
  }

  // insured entity => insurance lines (FIFO queue)
  mapping(bytes32 => InsuranceLine[]) public insuranceLines;

  event InsuranceRegistered(bytes32 indexed insured, bytes32 indexed insurer, uint256 indexed tokenId, uint256 limit, uint64 expiresAt);
  event InsuranceClaimed(bytes32 indexed insured, bytes32 indexed insurer, bytes32 indexed creditor, uint256 tokenId, uint256 amount);
  event InsuranceExpired(bytes32 indexed insured, bytes32 indexed insurer, uint256 indexed tokenId, uint256 index);

  // Registration struct for bilateral insurance agreement during settle()
  struct InsuranceRegistration {
    bytes32 insured;      // Entity being covered
    bytes32 insurer;      // Entity providing coverage (must be one of the settling parties)
    uint256 tokenId;      // Token covered
    uint256 limit;        // Max coverage amount
    uint64 expiresAt;     // Block timestamp expiration
  }

  struct DebtSnapshot {
    bytes32 creditor;
    uint256 amount;
    uint256 index;
  }

  function _addDebt(bytes32 debtor, uint256 tokenId, bytes32 creditor, uint256 amount) internal returns (uint256 index) {
    require(creditor != bytes32(0), "Depository: creditor required");
    require(amount > 0, "Depository: zero debt");
    _debts[debtor][tokenId].push(Debt({ amount: amount, creditor: creditor }));
    index = _debts[debtor][tokenId].length - 1;

    if (index == 0) {
      _debtIndex[debtor][tokenId] = 0;
    }

    _activeDebts[debtor]++;

    EntityScore storage score = entityScores[debtor];
    score.totalActiveDebts++;
    if (score.inDebtSince == 0) {
      score.inDebtSince = uint48(block.timestamp);
    }

    _increaseDebtStats(debtor, tokenId, amount);
    emit DebtCreated(debtor, creditor, tokenId, amount, index);
  }

  function _afterDebtCleared(bytes32 entity, bool isRepayment) internal {
    if (_activeDebts[entity] > 0) {
      unchecked {
        _activeDebts[entity]--;
      }
    }

    EntityScore storage score = entityScores[entity];
    if (score.totalActiveDebts > 0) {
      unchecked {
        score.totalActiveDebts--;
      }
      if (score.totalActiveDebts == 0) {
        score.inDebtSince = 0;
      }
    }

    if (isRepayment) {
      score.successfulRepayments++;
    }
  }

  function _increaseDebtStats(bytes32 entity, uint256 tokenId, uint256 amount) internal {
    if (amount == 0) {
      return;
    }
    TokenDebtStats storage stats = _tokenDebtStats[entity][tokenId];
    stats.outstandingAmount += amount;
    stats.lastUpdated = uint64(block.timestamp);
    if (stats.since == 0) {
      stats.since = uint64(block.timestamp);
    }
  }

  function _decreaseDebtStats(bytes32 entity, uint256 tokenId, uint256 amount) internal {
    if (amount == 0) {
      return;
    }
    TokenDebtStats storage stats = _tokenDebtStats[entity][tokenId];
    if (amount >= stats.outstandingAmount) {
      stats.outstandingAmount = 0;
      stats.since = 0;
    } else {
      stats.outstandingAmount -= amount;
    }
    stats.lastUpdated = uint64(block.timestamp);
  }

  function _clearDebtAtIndex(bytes32 entity, uint256 tokenId, uint256 index, bool isRepayment) internal returns (uint256 amountCleared, bytes32 creditor) {
    Debt storage debt = _debts[entity][tokenId][index];
    amountCleared = debt.amount;
    creditor = debt.creditor;

    if (amountCleared > 0) {
      _decreaseDebtStats(entity, tokenId, amountCleared);
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

  
  struct ChannelCollateral {
    // total amount of collateral locked in the channel for this token
    uint collateral;
    // when Left +=/-= .collateral, do the same operation to .ondelta
    int ondelta;   
  }

  struct ChannelInfo{
    // TODO: we could possibly store all channel state as a single hash
    // and provide it with every request as CALLDATA to save gas
    // but unilateral reserveToCollateral would become tricky

    // used for cooperativeUpdate and cooperative close, stored forever
    uint cooperativeNonce;

    // dispute state is stored after dispute is started
    bytes32 disputeHash;
  }
  

  function packTokenReference(uint8 tokenType, address contractAddress, uint96 externalTokenId) public pure returns (bytes32) {
    require(tokenType <= 255);

    // Pack the contractAddress into the most significant 160 bits
    bytes32 packed = bytes32(uint256(uint160(contractAddress)) << 96);

    // Pack the tokenId into the next 96 bits
    packed |= bytes32(uint256(externalTokenId) << 8);

    // Pack the tokenType into the least significant 8 bits
    packed |= bytes32(uint256(tokenType));

    return packed;
  }

  function unpackTokenReference(bytes32 packed) public pure returns (address contractAddress, uint96 externalTokenId, uint8 tokenType) {
    // Unpack the contractAddress from the most significant 160 bits
    contractAddress = address(uint160(uint256(packed) >> 96));

    // Unpack the externalTokenId from the next 96 bits
    externalTokenId = uint96((uint256(packed) >> 8) & 0xFFFFFFFFFFFFFFFFFFFFFF);

    // Unpack the tokenType from the least significant 8 bits
    tokenType = uint8(uint256(packed) & 0xFF);

    return (contractAddress, externalTokenId, tokenType);
  }





  function registerHub(uint hub_id, string memory new_uri) public returns (uint) {
    if (hub_id == 0) {
      _hubs.push(Hub({
        entityId: bytes32(uint256(uint160(msg.sender))),
        uri: new_uri,
        gasused: 0
      }));
      return _hubs.length - 1;
    } else {
      require(bytes32(uint256(uint160(msg.sender))) == _hubs[hub_id].entityId, "Sender is not hub owner");
      _hubs[hub_id].uri = new_uri;
      return hub_id;
    }
  }

  struct ExternalTokenToReserve{
    bytes32 entity; // The entity to credit. If bytes32(0), defaults to msg.sender
    bytes32 packedToken;
    uint internalTokenId;
    uint amount;
  }
  function externalTokenToReserve(ExternalTokenToReserve memory params) public nonReentrant {
    bytes32 targetEntity = params.entity == bytes32(0) ? bytes32(uint256(uint160(msg.sender))) : params.entity;
    require(params.amount > 0, "Amount zero");
    
    if (params.internalTokenId == 0) {
      // Check if token already exists using efficient lookup
      params.internalTokenId = tokenToId[params.packedToken];
      
      if (params.internalTokenId == 0) {
        // Create new token
        _tokens.push(params.packedToken);
        params.internalTokenId = _tokens.length - 1;
        tokenToId[params.packedToken] = params.internalTokenId;
        
        //console.log("Saved new token:", params.internalTokenId);
      }
    } else {
      params.packedToken = _tokens[params.internalTokenId];
      //require(_tokens[params.internalTokenId] == params.packedToken, "Token data mismatch");
    }


    (address contractAddress, uint96 tokenId, uint8 tokenType) = unpackTokenReference(params.packedToken);
    //console.log('unpackedToken ', contractAddress,tokenId,  tokenType);

    // todo: allow longer uint256 tokenId for ERC721 and ERC1155 
    // e.g. Rarible has format of 0xCreatorAddress..00000TokenId
    if (tokenType == TypeERC20) {
      require(IERC20(contractAddress).transferFrom(msg.sender, address(this), params.amount), "ERC20 transferFrom failed");
    } else if (tokenType == TypeERC721) {
      // 721 does not return bool on transfer
      IERC721(contractAddress).transferFrom(msg.sender, address(this), uint(tokenId));
      params.amount = 1; // For 721, amount is always 1
    } else if (tokenType == TypeERC1155) {
      IERC1155(contractAddress).safeTransferFrom(msg.sender, address(this), uint(tokenId), params.amount, "");
    }

    _reserves[targetEntity][params.internalTokenId] += params.amount;
    emit ReserveUpdated(targetEntity, params.internalTokenId, _reserves[targetEntity][params.internalTokenId]);
  }


  struct ReserveToExternalToken{
    bytes32 receivingEntity;
    uint tokenId;
    uint amount;
  }
  function reserveToExternalToken(bytes32 entity, ReserveToExternalToken memory params) internal {
    enforceDebts(entity, params.tokenId);

    (address contractAddress, uint96 tokenId, uint8 tokenType) = unpackTokenReference(_tokens[params.tokenId]);
    //console.log('unpackedToken ', contractAddress,tokenId,  tokenType);

    require(_reserves[entity][params.tokenId] >= params.amount, "Not enough reserve");

    _reserves[entity][params.tokenId] -= params.amount;
    emit ReserveUpdated(entity, params.tokenId, _reserves[entity][params.tokenId]);

    if (tokenType == TypeERC20) {
      require(IERC20(contractAddress).transfer(address(uint160(uint256(params.receivingEntity))), params.amount));
    } else if (tokenType == TypeERC721) {
      IERC721(contractAddress).transferFrom(address(this), address(uint160(uint256(params.receivingEntity))), uint(tokenId));
    } else if (tokenType == TypeERC1155) {
      IERC1155(contractAddress).safeTransferFrom(address(this), address(uint160(uint256(params.receivingEntity))), uint(tokenId), params.amount, "");
    }

  }
  struct ReserveToReserve{
    bytes32 receivingEntity;
    uint tokenId;
    uint amount;
  }
  function reserveToReserve(bytes32 entity, ReserveToReserve memory params) internal {
    console.log("=== reserveToReserve ENTRY ===");
    console.log("reserveToReserve: from entity");
    console.logBytes32(entity);
    console.log("reserveToReserve: to entity");
    console.logBytes32(params.receivingEntity);
    console.log("reserveToReserve: tokenId");
    console.logUint(params.tokenId);
    console.log("reserveToReserve: amount");
    console.logUint(params.amount);
    console.log("reserveToReserve: sender balance");
    console.logUint(_reserves[entity][params.tokenId]);

    enforceDebts(entity, params.tokenId);

    console.log("=== BALANCE CHECK ===");
    if (_reserves[entity][params.tokenId] >= params.amount) {
      console.log("SUCCESS: Balance check passed");
    } else {
      console.log("FAIL: Balance check failed - insufficient funds");
      console.log("Required:");
      console.logUint(params.amount);
      console.log("Available:");
      console.logUint(_reserves[entity][params.tokenId]);
    }

    require(_reserves[entity][params.tokenId] >= params.amount, "Insufficient balance for transfer");
    
    console.log("=== EXECUTING TRANSFER ===");
    _reserves[entity][params.tokenId] -= params.amount;
    _reserves[params.receivingEntity][params.tokenId] += params.amount;
    
    console.log("reserveToReserve: transfer complete");
    console.log("reserveToReserve: new sender balance");
    console.logUint(_reserves[entity][params.tokenId]);
    console.log("reserveToReserve: new recipient balance");
    console.logUint(_reserves[params.receivingEntity][params.tokenId]);
    
    emit ReserveUpdated(entity, params.tokenId, _reserves[entity][params.tokenId]);
    emit ReserveUpdated(params.receivingEntity, params.tokenId, _reserves[params.receivingEntity][params.tokenId]);
    emit ReserveTransferred(entity, params.receivingEntity, params.tokenId, params.amount);
    console.log("=== reserveToReserve COMPLETE ===");
  }

  /**
   * @notice Transfer control/dividend shares between entity reserves
   * @dev Wrapper around reserveToReserve with better semantics for control shares
   * @param to Recipient entity address
   * @param internalTokenId Internal token ID (use getControlShareTokenId helper)
   * @param amount Amount of shares to transfer
   */
  function transferControlShares(
    bytes32 entity,
    bytes32 to,
    uint256 internalTokenId,
    uint256 amount,
    string calldata /* purpose */
  ) internal {
    enforceDebts(entity, internalTokenId);

    require(_reserves[entity][internalTokenId] >= amount, "Insufficient control shares");
    require(to != bytes32(0), "Invalid recipient");
    require(to != entity, "Cannot transfer to self");

    _reserves[entity][internalTokenId] -= amount;
    _reserves[to][internalTokenId] += amount;

    // emit ControlSharesTransferred(entity, to, internalTokenId, amount, purpose); // DISABLED
    emit ReserveUpdated(entity, internalTokenId, _reserves[entity][internalTokenId]);
    emit ReserveUpdated(to, internalTokenId, _reserves[to][internalTokenId]);
  }

  /**
   * @notice Get internal token ID for EntityProvider control/dividend tokens
   * @param entityProvider EntityProvider contract address
   * @param externalTokenId External token ID (entity number for control, entity number | 0x8000... for dividend)
   * @return internalTokenId Internal token ID for use with reserves
   */
  function getControlShareTokenId(address entityProvider, uint256 externalTokenId) external view returns (uint256 internalTokenId) {
    bytes32 packedToken = packTokenReference(TypeERC1155, entityProvider, uint96(externalTokenId));
    return tokenToId[packedToken];
  }




  
  function getDebts(bytes32 entity, uint tokenId) public view returns (Debt[] memory allDebts, uint currentDebtIndex) {
    currentDebtIndex = _debtIndex[entity][tokenId];
    allDebts = _debts[entity][tokenId];
  }

  function listActiveDebts(
    bytes32 entity,
    uint256 tokenId,
    uint256 startIndex,
    uint256 limit
  ) external view returns (DebtSnapshot[] memory debts, uint256 nextIndex, bool hasMore) {
    require(limit > 0 && limit <= 256, "Depository: invalid limit");

    Debt[] storage queue = _debts[entity][tokenId];
    uint256 length = queue.length;
    uint256 cursor = startIndex;
    uint256 head = _debtIndex[entity][tokenId];
    if (cursor < head) {
      cursor = head;
    }

    if (cursor >= length) {
      return (new DebtSnapshot[](0), length, false);
    }

    DebtSnapshot[] memory buffer = new DebtSnapshot[](limit);
    uint256 count = 0;
    while (cursor < length && count < limit) {
      Debt storage debt = queue[cursor];
      if (debt.amount > 0) {
        buffer[count] = DebtSnapshot({
          creditor: debt.creditor,
          amount: debt.amount,
          index: cursor
        });
        count++;
      }
      cursor++;
    }

    debts = new DebtSnapshot[](count);
    for (uint256 i = 0; i < count; i++) {
      debts[i] = buffer[i];
    }

    nextIndex = cursor;
    hasMore = cursor < length;
  }

  function previewEnforceDebts(
    bytes32 entity,
    uint256 tokenId,
    uint256 additionalReserve,
    uint256 maxIterations
  )
    external
    view
    returns (
      uint256 totalClearedAmount,
      uint256 resultingReserve,
      uint256 nextDebtIndex,
      uint256 nextDebtAmount,
      bytes32 nextDebtCreditor
    )
  {
    Debt[] storage queue = _debts[entity][tokenId];
    uint256 length = queue.length;
    if (length == 0) {
      return (0, _reserves[entity][tokenId] + additionalReserve, 0, 0, bytes32(0));
    }

    uint256 cursor = _debtIndex[entity][tokenId];
    uint256 available = _reserves[entity][tokenId] + additionalReserve;
    uint256 iterations = 0;
    uint256 iterationCap = maxIterations == 0 ? type(uint256).max : maxIterations;

    while (cursor < length && available > 0 && iterations < iterationCap) {
      Debt storage debt = queue[cursor];
      uint256 amount = debt.amount;
      if (amount == 0) {
        cursor++;
        continue;
      }

      if (available >= amount) {
        available -= amount;
        totalClearedAmount += amount;
        cursor++;
      } else {
        uint256 paid = available;
        totalClearedAmount += paid;
        available = 0;
        nextDebtIndex = cursor;
        nextDebtAmount = amount - paid;
        nextDebtCreditor = debt.creditor;
        resultingReserve = available;
        return (totalClearedAmount, resultingReserve, nextDebtIndex, nextDebtAmount, nextDebtCreditor);
      }

      iterations++;
    }

    while (cursor < length && queue[cursor].amount == 0) {
      cursor++;
    }

    nextDebtIndex = cursor;
    resultingReserve = available;

    if (cursor < length) {
      nextDebtAmount = queue[cursor].amount;
      nextDebtCreditor = queue[cursor].creditor;
    } else {
      nextDebtAmount = 0;
      nextDebtCreditor = bytes32(0);
      nextDebtIndex = 0;
    }
  }

  function getEntityTokenDebtStats(bytes32 entity, uint256 tokenId) external view returns (TokenDebtStats memory) {
    return _tokenDebtStats[entity][tokenId];
  }


  /* triggered automatically before every reserveTo{Reserve/ChannelCollateral/PackedToken}
  /* can be called manually
  /* iterates over _debts starting from current _debtIndex, first-in-first-out 
  /* max _debts?
  /* Calling enforceDebts at the exit points is
  sound: it guarantees nobody can move funds while they owe. What you get is a single choke point that’s trivial to audit: “any reserve decrease first clears
  debts.”
  The elegance is that it does ONE thing perfectly: ensures reserves can't exit while debts exist. That's the minimum viable enforcement needed to make bilateral credit work.

  It transforms the complex social problem of "who gets paid first when there isn't enough?" into a deterministic mechanical process. FIFO is the only fair queue because chronological priority is the only objective ordering that can't be gamed ex-post.
  */

  //The FIFO queue is the ONLY safe approach. Any deviation creates attack vectors
/* enforceDebts(): The Immutable Law of Chronological Justice
 *
 * This function is 100% OPTIMAL - any deviation breaks fairness invariants.
 *
 * WHY FIFO IS THE ONLY SOLUTION:
 * In traditional finance, bankruptcy courts enforce "absolute priority rule" -
 * first creditor gets paid first. This prevents late-coming creditors from
 * jumping the queue through side deals, political influence, or sybil attacks.
 *
 * THE BEAUTY:
 * 1. SIMPLICITY: One queue, one order, no exceptions. O(n) complexity.
 * 2. UNGAMEABLE: Timestamp of debt creation is immutable history.
 * 3. DETERMINISTIC: No subjective judgments about "senior" vs "junior" debt.
 * 4. VACUUM CLEANER: Pays ALL available reserves to debt[0] until cleared.
 *
 * THE MECHANISM:
 * - Every reserve withdrawal must first satisfy debts in order
 * - Creates a "liquidity trap" - entity can receive but not send until debts clear
 * - Transforms social reputation ("this hub owes me") into mechanical enforcement
 *
 * WHY PARTIAL PAYMENTS ARE SAFE:
 * Entity cannot CHOOSE to pay partially - enforceDebts() is a vacuum that sucks
 * ALL available reserves into debt[0]. Partial payment only occurs when reserves
 * run out mid-debt. This enables:
 * 1. GAS EFFICIENCY: Large debts clear incrementally without hitting block gas limit
 * 2. CAPITAL EFFICIENCY: Don't need to accumulate full debt amount before repayment starts
 * 3. SAME FIFO SECURITY: Can't skip queue, can't game order, can't withdraw until debts clear
 *
 * Example: Entity owes Alice 1M, has 100k reserves, tries to withdraw 10k:
 *   1. enforceDebts() runs automatically
 *   2. Pays ALL 100k to Alice (debt reduced to 900k)
 *   3. Reserve = 0, withdrawal fails
 *   4. Entity receives another 50k → pays ALL 50k to Alice → still locked
 *   Repeat until Alice's debt = 0, THEN move to debt[1]
 *
 * WHY NOT NETTING/PRIORITIES/MANUAL ALLOCATION?
 * Any deviation from FIFO allows queue manipulation. Hub could create fake
 * senior debt to itself, or net out favorable cycles while starving others.
 *
 * The elegance: by doing exactly ONE thing perfectly (FIFO enforcement), it enables
 * an entire credit economy to exist trustlessly. The threat of entering this
 * "debt purgatory" keeps hubs honest without ever needing to trigger it.
 *
 * Like TCP sequence numbers or Bitcoin's UTXO model, the constraint IS the security.
 * Pure chronological ordering is the only objective truth the J-machine can enforce
 * without becoming a judge.
 */
  function enforceDebts(bytes32 entity, uint tokenId) public returns (uint256 totalDebts) {
    return _enforceDebts(entity, tokenId, type(uint256).max);
  }

  function enforceDebts(bytes32 entity, uint tokenId, uint256 maxIterations) public returns (uint256 totalDebts) {
    return _enforceDebts(entity, tokenId, maxIterations);
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
        _decreaseDebtStats(entity, tokenId, payableAmount);
        amount -= payableAmount;
      }

      // If reserves exhausted but debt remains, try insurance
      if (amount > 0 && available == 0) {
        uint256 insuranceRemaining = _claimFromInsurance(entity, creditor, tokenId, amount);
        uint256 insurancePaid = amount - insuranceRemaining;
        if (insurancePaid > 0) {
          _decreaseDebtStats(entity, tokenId, insurancePaid);
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



  function channelKey(bytes32 e1, bytes32 e2) public pure returns (bytes memory) {
    //determenistic channel key is 64 bytes: concatenated lowerKey + higherKey
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

      bytes memory ch_key = channelKey(receivingEntity, counterentity);

      logChannel(receivingEntity, counterentity);

      if (_reserves[entity][tokenId] >= amount) {
        ChannelCollateral storage col = _collaterals[ch_key][tokenId];

        _reserves[entity][tokenId] -= amount;
        col.collateral += amount;
        if (receivingEntity < counterentity) { // if receiver is left
          col.ondelta += int(amount);
        }

        emit TransferReserveToCollateral(receivingEntity, counterentity, col.collateral, col.ondelta, tokenId);

        log("Deposited to channel ", _collaterals[ch_key][tokenId].collateral);
      } else {
        log("Not enough funds", entity);
        return false;
      }
      logChannel(receivingEntity, counterentity);

    }


    return true;
  }

  // DEPRECATED: Use settle() instead - cooperativeUpdate kept for backwards compatibility
  // mutually agreed update of channel state in a single atomic operation
  function cooperativeUpdate(bytes32 entity, CooperativeUpdate memory params) internal returns (bool) {
    bytes memory ch_key = channelKey(entity, params.counterentity);
    bytes32 left;
    bytes32 right;

    if (entity < params.counterentity) {
        left = entity;
        right = params.counterentity;
    } else {
        left = params.counterentity;
        right = entity;
    }


    bytes memory encoded_msg = abi.encode(MessageType.CooperativeUpdate, 
    ch_key, 
    _channels[ch_key].cooperativeNonce, 
    params.diffs, 
    params.forgiveDebtsInTokenIds);

    bytes32 hash = ECDSA.toEthSignedMessageHash(keccak256(encoded_msg));

    log('Encoded msg', encoded_msg);
    
    address counterpartyAddress = address(uint160(uint256(params.counterentity)));
    if(counterpartyAddress != ECDSA.recover(hash, params.sig)) {
      log("Invalid signer ", ECDSA.recover(hash, params.sig));
      return false;
    }

    // Update cooperative action scores
    entityScores[entity].cooperativeActions++;
    entityScores[params.counterentity].cooperativeActions++;

    Settled[] memory settledEvents = new Settled[](params.diffs.length);

    for (uint i = 0; i < params.diffs.length; i++) {
      Diff memory diff = params.diffs[i];
      uint tokenId = diff.tokenId;

      // ✅ INVARIANT CHECK: Total value change within the channel for this token must be zero.
      // leftReserveChange + rightReserveChange + collateralChange == 0
      int myReserveDiff = -(diff.peerReserveDiff + diff.collateralDiff);
      require(_reserves[entity][tokenId] >= uint(-myReserveDiff), "Not enough sender reserve");


      if (diff.peerReserveDiff < 0) {
        enforceDebts(params.counterentity, tokenId);
        require(_reserves[params.counterentity][tokenId] >= uint(-diff.peerReserveDiff), "Not enough peer reserve");

        _reserves[params.counterentity][tokenId] -= uint(-diff.peerReserveDiff);
      } else {
        _reserves[params.counterentity][tokenId] += uint(diff.peerReserveDiff);
      }


      // ensure that the entity has enough funds to apply the diffs
      if (myReserveDiff < 0) {
        enforceDebts(entity, tokenId);
        // This check is already implicitly done by the invariant and the peer's reserve check,
        // but an explicit check is safer.
        require(_reserves[entity][tokenId] >= uint(-myReserveDiff), "Not enough sender reserve");
        _reserves[entity][tokenId] -= uint(-myReserveDiff);
      } else {
        _reserves[entity][tokenId] += uint(myReserveDiff);
      }


      ChannelCollateral storage col = _collaterals[ch_key][tokenId];

      if (diff.collateralDiff < 0) {
        require(col.collateral >= uint(-diff.collateralDiff), "Not enough collateral");
        col.collateral -= uint(-diff.collateralDiff);
      } else {
        col.collateral += uint(diff.collateralDiff);
      }

      // ondeltaDiff can be arbitrary
      col.ondelta += diff.ondeltaDiff;

      // Populate event with final absolute values for easy off-chain consumption
      settledEvents[i] = Settled({
          left: left,
          right: right,
          tokenId: tokenId,
          leftReserve: _reserves[left][tokenId],
          rightReserve: _reserves[right][tokenId],
          collateral: col.collateral,
          ondelta: col.ondelta
      });
    }

    if (settledEvents.length > 0) {
        emit ChannelSettled(settledEvents);
    }

    _channels[ch_key].cooperativeNonce++;

    logChannel(entity, params.counterentity);
    return true;
  }

  function finalizeChannel(
    bytes32 entity1,
    bytes32 entity2,
    ProofBody memory proofbody,
    bytes memory arguments1,
    bytes memory arguments2
  ) internal returns (bool) {
    bytes32 leftAddress;
    bytes32 rightAddress;
    bytes memory leftArguments;
    bytes memory rightArguments;

    if (entity1 < entity2) {
      leftAddress = entity1;
      rightAddress = entity2;
      leftArguments = arguments1;
      rightArguments = arguments2;
    } else {
      leftAddress = entity2;
      rightAddress = entity1;
      leftArguments = arguments2;
      rightArguments = arguments1;
    }

    bytes memory ch_key = channelKey(leftAddress, rightAddress);
    logChannel(leftAddress, rightAddress);

    uint256 tokenCount = proofbody.tokenIds.length;
    require(tokenCount == proofbody.offdeltas.length, "Depository: invalid proofbody");

    int[] memory deltas = new int[](tokenCount);
    for (uint256 i = 0; i < tokenCount; i++) {
      uint256 tokenId = proofbody.tokenIds[i];
      deltas[i] = _collaterals[ch_key][tokenId].ondelta + int(proofbody.offdeltas[i]);
    }

    bytes[] memory decodedLeft = leftArguments.length == 0 ? new bytes[](0) : abi.decode(leftArguments, (bytes[]));
    bytes[] memory decodedRight = rightArguments.length == 0 ? new bytes[](0) : abi.decode(rightArguments, (bytes[]));

    require(decodedLeft.length == proofbody.subcontracts.length, "Depository: invalid left args");
    require(decodedRight.length == proofbody.subcontracts.length, "Depository: invalid right args");

    for (uint256 i = 0; i < proofbody.subcontracts.length; i++) {
      SubcontractClause memory sc = proofbody.subcontracts[i];
      int[] memory newDeltas = SubcontractProvider(sc.subcontractProviderAddress).applyBatch(
        deltas,
        sc.encodedBatch,
        decodedLeft.length > i ? decodedLeft[i] : bytes(""),
        decodedRight.length > i ? decodedRight[i] : bytes("")
      );

      require(newDeltas.length == deltas.length, "Depository: invalid subcontract response");

      for (uint256 j = 0; j < sc.allowences.length; j++) {
        Allowence memory allowance = sc.allowences[j];
        require(allowance.deltaIndex < newDeltas.length, "Depository: invalid allowance index");
        int difference = newDeltas[allowance.deltaIndex] - deltas[allowance.deltaIndex];

        if (difference > 0) {
          require(uint256(difference) <= allowance.rightAllowence, "Depository: allowance exceeded (right)");
        } else if (difference < 0) {
          require(uint256(-difference) <= allowance.leftAllowence, "Depository: allowance exceeded (left)");
        }
      }

      for (uint256 j = 0; j < deltas.length; j++) {
        deltas[j] = newDeltas[j];
      }
    }

    for (uint256 i = 0; i < tokenCount; i++) {
      uint256 tokenId = proofbody.tokenIds[i];
      ChannelCollateral storage col = _collaterals[ch_key][tokenId];

      _applyChannelDelta(tokenId, col, leftAddress, rightAddress, deltas[i]);
      delete _collaterals[ch_key][tokenId];
    }

    delete _channels[ch_key].disputeHash;
    _channels[ch_key].cooperativeNonce++;
    logChannel(leftAddress, rightAddress);

    return true;
  }

  function _applyChannelDelta(
    uint256 tokenId,
    ChannelCollateral storage col,
    bytes32 leftEntity,
    bytes32 rightEntity,
    int delta
  ) internal {
    uint256 collateral = col.collateral;

    if (delta >= 0) {
      uint256 desired = uint256(delta);
      if (desired <= collateral) {
        if (desired > 0) {
          _increaseReserve(leftEntity, tokenId, desired);
        }
        uint256 remainder = collateral - desired;
        if (remainder > 0) {
          _increaseReserve(rightEntity, tokenId, remainder);
        }
      } else {
        if (collateral > 0) {
          _increaseReserve(leftEntity, tokenId, collateral);
        }
        uint256 shortfall = desired - collateral;
        _settleShortfall(rightEntity, leftEntity, tokenId, shortfall);
      }
    } else {
      uint256 desiredAbs = uint256(-delta);
      if (desiredAbs <= collateral) {
        if (desiredAbs > 0) {
          _increaseReserve(rightEntity, tokenId, desiredAbs);
        }
        uint256 remainder = collateral - desiredAbs;
        if (remainder > 0) {
          _increaseReserve(leftEntity, tokenId, remainder);
        }
      } else {
        if (collateral > 0) {
          _increaseReserve(rightEntity, tokenId, collateral);
        }
        uint256 shortfall = desiredAbs - collateral;
        _settleShortfall(leftEntity, rightEntity, tokenId, shortfall);
      }
    }

    col.collateral = 0;
    col.ondelta = 0;
  }

  function _increaseReserve(bytes32 entity, uint256 tokenId, uint256 amount) internal {
    if (amount == 0) {
      return;
    }
    _reserves[entity][tokenId] += amount;
    emit ReserveUpdated(entity, tokenId, _reserves[entity][tokenId]);
  }

  function _settleShortfall(bytes32 debtor, bytes32 creditor, uint256 tokenId, uint256 amount) internal {
    if (amount == 0) {
      return;
    }

    // 1. First, use debtor's reserves
    uint256 available = _reserves[debtor][tokenId];
    uint256 payAmount = available >= amount ? amount : available;

    if (payAmount > 0) {
      _reserves[debtor][tokenId] = available - payAmount;
      emit ReserveUpdated(debtor, tokenId, _reserves[debtor][tokenId]);
      _increaseReserve(creditor, tokenId, payAmount);
    }

    uint256 remaining = amount - payAmount;
    if (remaining == 0) {
      return;
    }

    // 2. Claim from insurance FIFO queue
    remaining = _claimFromInsurance(debtor, creditor, tokenId, remaining);

    // 3. Create debt for any remaining shortfall
    if (remaining > 0) {
      _addDebt(debtor, tokenId, creditor, remaining);
      _syncDebtIndex(debtor, tokenId);
    }
  }

  /**
   * @notice Claims from debtor's insurance lines (FIFO order with gas cap)
   * @dev Iterates from cursor position, skips expired/exhausted, stops if gas low
   * @param debtor Entity that owes (the insured party)
   * @param creditor Entity that is owed (receives insurance payout)
   * @param tokenId Token being claimed
   * @param shortfall Amount to cover
   * @return remaining Amount still uncovered after insurance claims
   */
  function _claimFromInsurance(
    bytes32 debtor,
    bytes32 creditor,
    uint256 tokenId,
    uint256 shortfall
  ) internal returns (uint256 remaining) {
    remaining = shortfall;
    InsuranceLine[] storage lines = insuranceLines[debtor];
    uint256 length = lines.length;
    if (length == 0) return remaining;

    uint256 cursor = insuranceCursor[debtor];
    if (cursor >= length) cursor = 0;

    uint256 startCursor = cursor;
    uint256 minGas = minGasForInsurance;

    // Iterate from cursor, wrap around once if needed
    for (uint256 checked = 0; checked < length && remaining > 0; checked++) {
      // Gas cap - stop if running low
      if (gasleft() < minGas) break;

      uint256 i = (startCursor + checked) % length;
      InsuranceLine storage line = lines[i];

      // Skip if wrong token
      if (line.tokenId != tokenId) continue;

      // Skip expired lines (lazy cleanup - just skip)
      if (block.timestamp > line.expiresAt) {
        emit InsuranceExpired(debtor, line.insurer, tokenId, i);
        continue;
      }

      // Skip exhausted lines
      if (line.remaining == 0) continue;

      // Check insurer has reserves to pay
      uint256 insurerReserves = _reserves[line.insurer][tokenId];
      uint256 canPay = line.remaining < insurerReserves ? line.remaining : insurerReserves;
      uint256 claimAmount = canPay < remaining ? canPay : remaining;

      if (claimAmount == 0) continue;

      // Transfer from insurer to creditor
      _reserves[line.insurer][tokenId] -= claimAmount;
      emit ReserveUpdated(line.insurer, tokenId, _reserves[line.insurer][tokenId]);
      _increaseReserve(creditor, tokenId, claimAmount);

      // Decrease remaining coverage
      line.remaining -= claimAmount;
      remaining -= claimAmount;

      // LOAN MODEL: debtor now owes insurer (insurer can recover later)
      _addDebt(debtor, tokenId, line.insurer, claimAmount);

      emit InsuranceClaimed(debtor, line.insurer, creditor, tokenId, claimAmount);

      // Advance cursor past this line for next call
      cursor = (i + 1) % length;
    }

    // Save cursor position
    insuranceCursor[debtor] = cursor;
  }

  // Cooperative dispute proof: both parties agree to close channel with signed proof
  function cooperativeDisputeProof (CooperativeDisputeProof memory params) public nonReentrant returns (bool) {
    bytes memory ch_key = channelKey(bytes32(uint256(uint160(msg.sender))), params.counterentity);

    console.log("Received proof");
    console.logBytes32(keccak256(abi.encode(params.proofbody)));
    console.logBytes32(keccak256(params.initialArguments));

    bytes memory encoded_msg = abi.encode(
      MessageType.CooperativeDisputeProof,
      ch_key,
      _channels[ch_key].cooperativeNonce,
      keccak256(abi.encode(params.proofbody)),
      keccak256(params.initialArguments)
    );

    bytes32 final_hash = ECDSA.toEthSignedMessageHash(keccak256(encoded_msg));

    // Fix type conversion: bytes32 → address
    address recoveredSigner = ECDSA.recover(final_hash, params.sig);
    address counterpartyAddress = address(uint160(uint256(params.counterentity)));
    require(recoveredSigner == counterpartyAddress, "Invalid counterparty signature");

    require(_channels[ch_key].disputeHash == bytes32(0), "Dispute already in progress");

    delete _channels[ch_key].disputeHash;

    require(
      finalizeChannel(
        bytes32(uint256(uint160(msg.sender))),
        params.counterentity,
        params.proofbody,
        params.finalArguments,
        params.initialArguments
      ),
      "Depository: finalize failed"
    );

    emit CooperativeClose(bytes32(uint256(uint160(msg.sender))), params.counterentity, _channels[ch_key].cooperativeNonce);

    return true;
  }


  // Initial dispute proof: one party posts signed proof to start dispute
  function initialDisputeProof(InitialDisputeProof memory params) public nonReentrant returns (bool) {
    bytes memory ch_key = channelKey(bytes32(uint256(uint160(msg.sender))), params.counterentity);

    // Update dispute scores for both parties
    entityScores[bytes32(uint256(uint160(msg.sender)))].totalDisputes++;
    entityScores[params.counterentity].totalDisputes++;

    // entities must always hold a dispute proof with cooperativeNonce equal or higher than the one in the contract
    require(_channels[ch_key].cooperativeNonce <= params.cooperativeNonce, "Proof nonce too old");

    bytes memory encoded_msg = abi.encode(MessageType.DisputeProof,
      ch_key,
      params.cooperativeNonce,
      params.disputeNonce,
      params.proofbodyHash);

    bytes32 final_hash = ECDSA.toEthSignedMessageHash(keccak256(encoded_msg));

    log('encoded_msg',encoded_msg);

    // Fix type conversion: bytes32 → address
    address recoveredSigner = ECDSA.recover(final_hash, params.sig);
    address counterpartyAddress = address(uint160(uint256(params.counterentity)));
    require(recoveredSigner == counterpartyAddress, "Invalid signer");

    require(_channels[ch_key].disputeHash == bytes32(0), "Dispute already in progress");

    bytes memory encodedDispute = abi.encodePacked(params.cooperativeNonce,
      params.disputeNonce,
      bytes32(uint256(uint160(msg.sender))) < params.counterentity, // is started by left
      block.number + 20,
      params.proofbodyHash,
      keccak256(abi.encodePacked(params.initialArguments)));

    _channels[ch_key].disputeHash = keccak256(encodedDispute);
    emit DisputeStarted(bytes32(uint256(uint160(msg.sender))), params.counterentity, params.disputeNonce, params.initialArguments);

    return true;
  }

  // Final dispute proof: counterparty responds with newer proof OR timeout expires
  function finalDisputeProof(FinalDisputeProof memory params) public nonReentrant returns (bool) {
    bytes memory ch_key = channelKey(bytes32(uint256(uint160(msg.sender))), params.counterentity);

    // Update dispute scores for both parties involved in the finalization
    entityScores[bytes32(uint256(uint160(msg.sender)))].totalDisputes++;
    entityScores[params.counterentity].totalDisputes++;

    // verify the dispute was started

    if (params.sig.length > 0) {
      // Validate signature if provided
      bytes memory encoded_msg = abi.encode(MessageType.FinalDisputeProof,
        ch_key,
        params.finalCooperativeNonce,
        params.initialDisputeNonce,
        params.finalDisputeNonce);

      bytes32 final_hash = ECDSA.toEthSignedMessageHash(keccak256(encoded_msg));
      log('encoded_msg',encoded_msg);

      // Fix type conversion: bytes32 → address
      address recoveredSigner = ECDSA.recover(final_hash, params.sig);
      address counterpartyAddress = address(uint160(uint256(params.counterentity)));
      require(recoveredSigner == counterpartyAddress, "Invalid signer");

      // TODO: if nonce is same, Left one's proof is considered valid

      require(params.initialDisputeNonce < params.finalDisputeNonce, "New nonce must be greater");
    } else {
      // counterparty agrees or does not respond
      bool senderIsCounterparty = params.startedByLeft != (bytes32(uint256(uint160(msg.sender))) < params.counterentity);
      require(senderIsCounterparty || (block.number >= params.disputeUntilBlock), "Dispute period ended");
      require(params.initialProofbodyHash == keccak256(abi.encode(params.finalProofbody)), "Invalid proofbody");
    }

    require(
      finalizeChannel(
        bytes32(uint256(uint160(msg.sender))),
        params.counterentity,
        params.finalProofbody,
        params.finalArguments,
        params.initialArguments
      ),
      "Depository: finalize failed"
    );

    return true;
  }





  struct TokenReserveDebts {
    uint reserve;
    uint debtIndex;
    Debt[] debts;
  }
  
  struct UserReturn {
    uint ETH_balance;
    TokenReserveDebts[] tokens;
  }

  struct ChannelReturn{
    ChannelInfo channel;
    ChannelCollateral[] collaterals;
  }
  
  
  function getUsers(bytes32[] memory entities, uint[] memory tokenIds) external view returns (UserReturn[] memory response) {
    response = new UserReturn[](entities.length);
    for (uint i = 0;i<entities.length;i++){
      bytes32 entity = entities[i];
      response[i] = UserReturn({
        ETH_balance: address(uint160(uint256(entity))).balance,
        tokens: new TokenReserveDebts[](tokenIds.length)
      });
    
      for (uint j = 0;j<tokenIds.length;j++){
        response[i].tokens[j]= TokenReserveDebts({
          reserve: _reserves[entity][tokenIds[j]],
          debtIndex: _debtIndex[entity][tokenIds[j]],
          debts: _debts[entity][tokenIds[j]]
        });
      }
    }
    
    return response;
  }

  function getChannels(bytes32 entity, bytes32[] memory counterentities, uint[] memory tokenIds) public view returns (ChannelReturn[] memory response) {
    bytes memory ch_key;

    // set length of the response array
    response = new ChannelReturn[](counterentities.length);

    for (uint i = 0;i<counterentities.length;i++){
      ch_key = channelKey(entity, counterentities[i]);

      response[i]=ChannelReturn({
        channel: _channels[ch_key],
        collaterals: new ChannelCollateral[](tokenIds.length)
      });

      for (uint j = 0;j<tokenIds.length;j++){
        response[i].collaterals[j]=_collaterals[ch_key][tokenIds[j]];
      }      
    }
    return response;    
  }

  /*

  function getAllHubs () public view returns (Hub[] memory) {
    return _hubs;
  }
  function getAllTokens () public view returns (bytes32[] memory) {
    return _tokens;
  }
  

  /* GPT5: You're right - this IS revolutionary. Lightning dies because you can't dynamically add inbound capacity. You solve it by allowing credit beyond
  collateral, then mechanically enforcing repayment via FIFO queue. That's genuinely novel. */
  function createDebt(bytes32 addr, bytes32 creditor, uint tokenId, uint amount) public onlyAdmin {
    _addDebt(addr, tokenId, creditor, amount);
  }


  function logChannel(bytes32 e1, bytes32 e2) public {
    /*
    bytes memory ch_key = channelKey(e1, e2);
    log(">>> Logging channel", ch_key);
    log("cooperativeNonce", _channels[ch_key].cooperativeNonce);
    log("disputeHash", _channels[ch_key].disputeHash);

    for (uint i = 0; i < _tokens.length; i++) {
      log("Token", _tokens[i]);
      log("Left:", _reserves[e1][i]);
      log("Right:", _reserves[e2][i]);
      log("collateral", _collaterals[ch_key][i].collateral);
      log("ondelta", _collaterals[ch_key][i].ondelta);
    }*/
  }       

  /* Events for control/dividend shares
  event ControlSharesReceived(
    address indexed entityProvider,
    bytes32 indexed fromEntity, 
    uint256 indexed tokenId,
    uint256 amount,
    bytes data
  );
  
  event ControlSharesTransferred(
    bytes32 indexed from,
    bytes32 indexed to,
    uint256 indexed internalTokenId,
    uint256 amount,
    string purpose
  );

  function onERC1155Received(
      address operator,
      address from,
      uint256 id,
      uint256 value,
      bytes calldata data
  )
      external
      returns(bytes4)
  {
    // If this is from an approved EntityProvider, automatically add to reserves
    if (approvedEntityProviders[msg.sender]) {
      // Create or find internal token ID for this EntityProvider token
      bytes32 packedToken = packTokenReference(TypeERC1155, msg.sender, uint96(id));
      
      // Use efficient lookup instead of O(n) iteration
      uint256 internalTokenId = tokenToId[packedToken];
      
      // Create new internal token ID if not found
      if (internalTokenId == 0) {
        _tokens.push(packedToken);
        internalTokenId = _tokens.length - 1;
        tokenToId[packedToken] = internalTokenId;
      }
      
      // Add to sender's reserves (the entity that sent the tokens)
      _reserves[bytes32(uint256(uint160(from)))][internalTokenId] += value;
      
      emit ControlSharesReceived(msg.sender, bytes32(uint256(uint160(from))), id, value, data);
    }
    
    return this.onERC1155Received.selector;
  }

  /* =================================================================================================
  /* === INSURANCE VIEW FUNCTIONS ====================================================================
  /* =================================================================================================*/

  /**
   * @notice Get all insurance lines for an insured entity
   * @param insured The entity that has insurance coverage
   * @return lines Array of insurance lines (FIFO order)
   */
  function getInsuranceLines(bytes32 insured) external view returns (InsuranceLine[] memory lines) {
    return insuranceLines[insured];
  }

  /**
   * @notice Get count of insurance lines for an entity
   * @param insured The entity to check
   * @return count Number of insurance lines
   */
  function getInsuranceLinesCount(bytes32 insured) external view returns (uint256 count) {
    return insuranceLines[insured].length;
  }

  /**
   * @notice Get available insurance coverage for a specific token
   * @param insured The insured entity
   * @param tokenId The token to check coverage for
   * @return totalAvailable Sum of remaining coverage for non-expired lines matching tokenId
   */
  function getAvailableInsurance(bytes32 insured, uint256 tokenId) external view returns (uint256 totalAvailable) {
    InsuranceLine[] storage lines = insuranceLines[insured];
    uint256 length = lines.length;

    for (uint256 i = 0; i < length; i++) {
      InsuranceLine storage line = lines[i];
      if (line.tokenId != tokenId) continue;
      if (block.timestamp > line.expiresAt) continue;
      if (line.remaining == 0) continue;

      // Cap by insurer's actual reserves
      uint256 insurerReserves = _reserves[line.insurer][tokenId];
      totalAvailable += line.remaining < insurerReserves ? line.remaining : insurerReserves;
    }
  }

}
