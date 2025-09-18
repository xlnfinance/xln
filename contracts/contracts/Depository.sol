// SPDX-License-Identifier: unknown
pragma solidity ^0.8.24;


import "./ECDSA.sol";
import "./console.sol";
import "hardhat/console.sol";

import "./EntityProvider.sol";

import "./SubcontractProvider.sol";

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
contract Depository is Console {

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
  function addEntityProvider(address provider) external {
    require(!approvedEntityProviders[provider], "Already approved");
    approvedEntityProviders[provider] = true;
    entityProvidersList.push(provider);
    emit EntityProviderAdded(provider);
  }
  
  /**
   * @notice Remove an EntityProvider from approved list  
   * @param provider EntityProvider contract address
   */
  function removeEntityProvider(address provider) external {
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
    _tokens.push(bytes32(0));
    
    // empty record, hub_id==0 means not a hub
    _hubs.push(Hub({
      entityId: bytes32(0),
      uri: '',
      gasused: 0
    }));
    
    // DEBUG: Prefund top 20 entities for testing
    debugBulkFundEntities();
  }
  
  function getTokensLength() public view returns (uint) {
    return _tokens.length;
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


  /* === HANKO INTEGRATION ===
  
  /* Nonce tracking for replay protection (since Hanko signatures are stateless)
  /* EVM-style sequential nonces: each entity must use nonce = lastNonce + 1
  mapping(address => uint256) public entityNonces;
  
  /* Domain separation for EIP-712 compatibility
  bytes32 public constant DOMAIN_SEPARATOR = keccak256("XLN_DEPOSITORY_HANKO_V1");
  
  event HankoBatchProcessed(bytes32 indexed entityId, bytes32 indexed hankoHash, uint256 nonce, bool success);
  
  /**
   * @notice Process batch with Hanko signature authorization using on-chain cryptographic verification
   * @dev SECURITY: All signatures are verified on-chain using ecrecover - no off-chain trust
   * @param encodedBatch The batch data
   * @param entityProvider EntityProvider contract address  
   * @param hankoData ABI-encoded Hanko bytes (placeholders, packedSignatures, claims)
   * @param nonce EVM-style sequential nonce for replay protection
   */
  /* DISABLED: Hanko processing
  function processBatchWithHanko(
    bytes calldata encodedBatch,
    address entityProvider,
    bytes calldata hankoData,
    uint256 nonce
  ) external onlyApprovedProvider(entityProvider) returns (bool completeSuccess) {
    
    // 🛡️ Domain separation: Hash batch with contract-specific context
    bytes32 domainSeparatedHash = keccak256(abi.encodePacked(
      DOMAIN_SEPARATOR,
      block.chainid,
      address(this),
      encodedBatch,
      nonce
    ));
    
    // 🔥 Verify Hanko with flashloan governance
    (bytes32 entityId, bool hankoValid) = EntityProvider(entityProvider).verifyHankoSignature(
      hankoData,
      domainSeparatedHash
    );
    
    require(hankoValid, "Invalid Hanko signature");
    require(entityId != bytes32(0), "No entity recovered from Hanko");
    
    // 🚀 Nonce management: Prevent replay attacks
    bytes32 entityIdBytes32 = entityId; // Already bytes32
    bytes32 hankoHash = keccak256(hankoData);
    
    require(nonce == entityNonces[address(uint160(uint256(entityIdBytes32)))] + 1, "Invalid nonce (must be sequential)");
    entityNonces[address(uint160(uint256(entityIdBytes32)))] = nonce;
    
    // ⚡ Process the actual batch
    completeSuccess = _processBatch(entityIdBytes32, abi.decode(encodedBatch, (Batch)));
    
    emit HankoBatchProcessed(entityId, hankoHash, nonce, completeSuccess);
    
    return completeSuccess;
  }
  */
  




  // DEBUG: Simple function to fund entity reserves for testing
  function debugFundReserves(bytes32 entity, uint tokenId, uint amount) public {
    console.log("debugFundReserves: funding entity");
    console.logBytes32(entity);
    console.log("debugFundReserves: tokenId");
    console.logUint(tokenId);
    console.log("debugFundReserves: amount");
    console.logUint(amount);
    
    _reserves[entity][tokenId] += amount;
    emit ReserveUpdated(entity, tokenId, _reserves[entity][tokenId]);
    
    console.log("debugFundReserves: new balance");
    console.logUint(_reserves[entity][tokenId]);
  }

  // DEBUG: Bulk fund top 20 entities with test reserves
  function debugBulkFundEntities() public {
    console.log("debugBulkFundEntities: funding entities 1-20 with 1M tokens");
    
    uint256 fundAmount = 1000000000000000000; // 1M tokens (1e18)
    
    for (uint256 entityNum = 1; entityNum <= 20; entityNum++) {
      bytes32 entity = bytes32(entityNum); // Entity ID is just the number padded
      
      // Fund with tokens 1, 2, 3
      for (uint256 tokenId = 1; tokenId <= 3; tokenId++) {
        _reserves[entity][tokenId] += fundAmount;
        emit ReserveUpdated(entity, tokenId, _reserves[entity][tokenId]);
      }
    }
    
    console.log("debugBulkFundEntities: funding complete");
  }

  function processBatch(bytes32 entity, Batch calldata batch) public returns (bool completeSuccess) {
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
  function prefundAccount(bytes32 counterpartyEntity, uint tokenId, uint amount) public returns (bool) {
    bytes32 fundingEntity = bytes32(uint256(uint160(msg.sender)));
    require(fundingEntity != counterpartyEntity, "Cannot prefund account with self");
    
    // Ensure entities are in canonical order (left < right)
    bytes32 leftEntity = fundingEntity < counterpartyEntity ? fundingEntity : counterpartyEntity;
    bytes32 rightEntity = fundingEntity < counterpartyEntity ? counterpartyEntity : fundingEntity;
    
    // Simple channel key: hash of left and right entities converted to bytes
    bytes memory ch_key = abi.encodePacked(keccak256(abi.encodePacked(leftEntity, rightEntity)));
    
    // Check funding entity has sufficient reserves
    require(_reserves[fundingEntity][tokenId] >= amount, "Insufficient reserves for prefunding");
    
    // Move funds from reserves to account collateral
    _reserves[fundingEntity][tokenId] -= amount;
    
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

  // ========== NEW SIMPLIFIED SETTLE FUNCTION ==========
  // Simple settlement between two entities without signature verification
  // Can be called independently or as part of processBatch
  function settle(bytes32 leftEntity, bytes32 rightEntity, SettlementDiff[] memory diffs) public returns (bool) {
    require(leftEntity != rightEntity, "Cannot settle with self");
    require(leftEntity < rightEntity, "Entities must be in order (left < right)");
    
    // Simple channel key: hash of left and right entities converted to bytes
    bytes memory ch_key = abi.encodePacked(keccak256(abi.encodePacked(leftEntity, rightEntity)));
    
    // Comment out signature verification for development
    // TODO: Re-enable signature verification in production
    
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
      
      // Emit SettlementProcessed event with final values for j-watcher consumption
      emit SettlementProcessed(
        leftEntity,
        rightEntity,
        tokenId,
        _reserves[leftEntity][tokenId],
        _reserves[rightEntity][tokenId],
        col.collateral,
        col.ondelta
      );
    }
    
    // TODO: Add cooperative nonce tracking if needed for settlement ordering
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

    // NEW: Process settlements (simplified account settlements between entities)
    console.log("Processing settlements count:");
    console.logUint(batch.settlements.length);
    for (uint i = 0; i < batch.settlements.length; i++) {
      Settlement memory settlement = batch.settlements[i];
      console.log("Settlement between:");
      console.logBytes32(settlement.leftEntity);
      console.log("and:");
      console.logBytes32(settlement.rightEntity);
      
      if (!settle(settlement.leftEntity, settlement.rightEntity, settlement.diffs)) {
        completeSuccess = false;
      }
    }

    /*
    // flashloans allow to settle batch of cooperativeUpdate
    for (uint i = 0; i < batch.flashloans.length; i++) {
      _reserves[msg.sender][batch.flashloans[i].tokenId] += batch.flashloans[i].amount;
    }

    for (uint i = 0; i < batch.flashloans.length; i++) {
      // fails if not enough _reserves 
      _reserves[entityAddress][batch.flashloans[i].tokenId] -= batch.flashloans[i].amount;
    }
    */
    
    /* DISABLED: dispute functions
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
    */

    
    /* DISABLED: collateral functions
    for (uint i = 0; i < batch.reserveToCollateral.length; i++) {
      if(!(reserveToCollateral(entityId, batch.reserveToCollateral[i]))){
        completeSuccess = false;
      }
    }
    */
    
    /*
    for (uint i = 0; i < batch.revealSecret.length; i++) {
      revealSecret(batch.revealSecret[i]);
    }

    for (uint i = 0; i < batch.cleanSecret.length; i++) {
      cleanSecret(batch.cleanSecret[i]);
    }*/

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
    DisputeProof
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
    // No signature field - signatures commented out for development
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
  function externalTokenToReserve(ExternalTokenToReserve memory params) public {
    bytes32 targetEntity = params.entity == bytes32(0) ? bytes32(uint256(uint160(msg.sender))) : params.entity;
    
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
    // enforceDebts(entity, params.tokenId); // DISABLED

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
    
    // enforceDebts(entity, params.tokenId); // DISABLED

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
   * @param purpose Human-readable purpose (e.g., "Sale", "Investment", "Dividend Distribution")
   */
  function transferControlShares(
    bytes32 entity,
    bytes32 to,
    uint256 internalTokenId,
    uint256 amount,
    string calldata purpose
  ) internal {
    // enforceDebts(entity, internalTokenId); // DISABLED

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


  /* triggered automatically before every reserveTo{Reserve/ChannelCollateral/PackedToken}
  /* can be called manually
  /* iterates over _debts starting from current _debtIndex, first-in-first-out 
  /* max _debts?
  function enforceDebts(bytes32 entity, uint tokenId) public returns (uint totalDebts) {
    uint debtsLength = _debts[entity][tokenId].length;
    if (debtsLength == 0) {
      return 0;
    }
   
    uint memoryReserve = _reserves[entity][tokenId]; 
    uint memoryDebtIndex = _debtIndex[entity][tokenId];
    
    if (memoryReserve == 0){
      return debtsLength - memoryDebtIndex;
    }
    // allow partial enforcing in case there are too many _debts to pay off at once (over block gas limit)
    while (true) {
      Debt storage debt = _debts[entity][tokenId][memoryDebtIndex];
      
      if (memoryReserve >= debt.amount) {
        // can pay this debt off in full
        memoryReserve -= debt.amount;
        _reserves[debt.creditor][tokenId] += debt.amount;

        delete _debts[entity][tokenId][memoryDebtIndex];

        // Update reputation score for repayment
        EntityScore storage score = entityScores[entity];
        score.totalActiveDebts--;
        score.successfulRepayments++;
        if (score.totalActiveDebts == 0) {
          score.inDebtSince = 0; // Reset timestamp when all debts are clear
        }

        // last debt was paid off, the entity is debt free now
        if (memoryDebtIndex+1 == debtsLength) {
          memoryDebtIndex = 0;
          // resets .length to 0
          delete _debts[entity][tokenId]; 
          debtsLength = 0;
          break;
        }
        memoryDebtIndex++;
        _activeDebts[entity]--;
        
      } else {
        // pay off the debt partially and break the loop
        _reserves[debt.creditor][tokenId] += memoryReserve;
        debt.amount -= memoryReserve;
        memoryReserve = 0;
        break;
      }
    }

    // put memory variables back to storage
    _reserves[entity][tokenId] = memoryReserve;
    _debtIndex[entity][tokenId] = memoryDebtIndex;
    
    return debtsLength - memoryDebtIndex;
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




  /* mutually agreed update of channel state in a single atomic operation
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
    
    if(params.counterentity != ECDSA.recover(hash, params.sig)) {
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

  /* COMMENTED OUT: Channel finalization disabled for development focus
  /* returns tokens to _reserves based on final deltas and _collaterals
  /* then increases cooperativeNonce to invalidate all previous dispute proofs

  /* todo: private visability
  /* function finalizeChannel(bytes32 entity1, 
  /*     bytes32 entity2, 
  /*     ProofBody memory proofbody, 
  /*     bytes memory arguments1, 
  /*     bytes memory arguments2) public returns (bool) 
  /* {
  /*   bytes32 leftAddress;
  /*   bytes32 rightAddress;
  /*   bytes memory leftArguments;
  /*   bytes memory rightArguments;
  /*   if (entity1 < entity2) {
  /*       leftAddress = entity1;
  /*       rightAddress = entity2;
  /*       leftArguments = arguments1;
  /*       rightArguments = arguments2;
  /*   } else {
  /*       leftAddress = entity2;
  /*       rightAddress = entity1;    
  /*       leftArguments = arguments2;
  /*       rightArguments = arguments1;
  /*   }

  /*   bytes memory ch_key = abi.encodePacked(leftAddress, rightAddress);

  /*   logChannel(leftAddress, rightAddress);

    // 1. create deltas (ondelta+offdelta) from proofbody
    int[] memory deltas = new int[](proofbody.offdeltas.length);
    for (uint i = 0;i<deltas.length;i++){
      deltas[i] = _collaterals[ch_key][proofbody.tokenIds[i]].ondelta + int(proofbody.offdeltas[i]);
    }
    
    // 2. process subcontracts and apply to deltas
    bytes[] memory decodedLeftArguments = abi.decode(leftArguments, (bytes[]));
    bytes[] memory decodedRightArguments = abi.decode(rightArguments, (bytes[]));

    for (uint i = 0; i < proofbody.subcontracts.length; i++){
      SubcontractClause memory sc = proofbody.subcontracts[i];
      
      // todo: check gas usage
      int[] memory newDeltas = SubcontractProvider(sc.subcontractProviderAddress).applyBatch(
        deltas, 
        sc.encodedBatch, 
        decodedLeftArguments[i],
        decodedRightArguments[i]
      );

      // sanity check 
      if (newDeltas.length != deltas.length) continue;

      // iterate over allowences and apply to new deltas if they are respected
      for (uint j = 0; j < sc.allowences.length; j++){
        Allowence memory allowence = sc.allowences[j];
        int difference = newDeltas[allowence.deltaIndex] - deltas[allowence.deltaIndex];
        if ((difference > 0 && uint(difference) > allowence.rightAllowence) || 
          (difference < 0 && uint(-difference) > allowence.leftAllowence) || 
          difference == 0){
          continue;
        }
        console.log("Update delta");
        console.logInt(deltas[allowence.deltaIndex]);
        console.logInt(newDeltas[allowence.deltaIndex]);
        deltas[allowence.deltaIndex] = newDeltas[allowence.deltaIndex];
      
      }
    }    

    // 3. split _collaterals
    for (uint i = 0;i<deltas.length;i++){
      uint tokenId = proofbody.tokenIds[i];
      int delta = deltas[i];
      ChannelCollateral storage col = _collaterals[ch_key][tokenId];

      if (delta >= 0 && uint(delta) <= col.collateral) {
        // collateral is split between entities
        _reserves[leftAddress][tokenId] += uint(delta);
        _reserves[rightAddress][tokenId] += col.collateral - uint(delta);
      } else {
        // one entity gets entire collateral, another pays credit from reserve or gets debt
        address getsCollateral = delta < 0 ? rightAddress : leftAddress;
        address getsDebt = delta < 0 ? leftAddress : rightAddress;
        uint debtAmount = delta < 0 ? uint(-delta) : uint(delta) - col.collateral;
        _reserves[getsCollateral][tokenId] += col.collateral;
        
        log('gets debt', getsDebt);
        log('debt', debtAmount);

        if (_reserves[getsDebt][tokenId] >= debtAmount) {
          // will pay right away without creating Debt
          _reserves[getsCollateral][tokenId] += debtAmount;
          _reserves[getsDebt][tokenId] -= debtAmount;
        } else {
          // pay what they can, and create Debt
          if (_reserves[getsDebt][tokenId] > 0) {
            _reserves[getsCollateral][tokenId] += _reserves[getsDebt][tokenId];
            debtAmount -= _reserves[getsDebt][tokenId];
            _reserves[getsDebt][tokenId] = 0;
          }
          _debts[getsDebt][tokenId].push(Debt({
            creditor: getsCollateral,
            amount: debtAmount
          }));
          _activeDebts[getsDebt]++;

          // Update reputation score for new debt
          EntityScore storage score = entityScores[getsDebt];
          score.totalActiveDebts++;
          if (score.inDebtSince == 0) {
            score.inDebtSince = uint48(block.timestamp);
          }
        }
      }

      delete _collaterals[ch_key][tokenId];
    }


    delete _channels[ch_key].disputeHash;

    _channels[ch_key].cooperativeNonce++;
   
    logChannel(leftAddress, rightAddress);

    return true;

  }

  /* DISABLED: disputes
  function cooperativeDisputeProof (CooperativeDisputeProof memory params) public returns (bool) {
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

    bytes32 hash = keccak256(encoded_msg);


    bytes32 final_hash = ECDSA.toEthSignedMessageHash(keccak256(encoded_msg));

    require(ECDSA.recover(final_hash, params.sig) == params.counterentity);

    require(_channels[ch_key].disputeHash == bytes32(0));

    delete _channels[ch_key].disputeHash;

    finalizeChannel(bytes32(uint256(uint160(msg.sender))), params.counterentity, params.proofbody, params.finalArguments, params.initialArguments);
    
    emit CooperativeClose(bytes32(uint256(uint160(msg.sender))), params.counterentity, _channels[ch_key].cooperativeNonce);
  }
  */


  /* DISABLED: dispute functions
  function initialDisputeProof(InitialDisputeProof memory params) public returns (bool) {
  /*   bytes memory ch_key = channelKey(bytes32(uint256(uint160(msg.sender))), params.counterentity);

  /*   // Update dispute scores for both parties
  /*   entityScores[bytes32(uint256(uint160(msg.sender)))].totalDisputes++;
  /*   entityScores[params.counterentity].totalDisputes++;

  /*   // entities must always hold a dispute proof with cooperativeNonce equal or higher than the one in the contract
  /*   require(_channels[ch_key].cooperativeNonce <= params.cooperativeNonce);

  /*   bytes memory encoded_msg = abi.encode(MessageType.DisputeProof, 
  /*     ch_key, 
  /*     params.cooperativeNonce, 
  /*     params.disputeNonce, 
  /*     params.proofbodyHash);

  /*   bytes32 final_hash = ECDSA.toEthSignedMessageHash(keccak256(encoded_msg));

  /*   log('encoded_msg',encoded_msg);

  /*   require(ECDSA.recover(final_hash, params.sig) == params.counterentity, "Invalid signer");

  /*   require(_channels[ch_key].disputeHash == bytes32(0));

  /*   bytes memory encodedDispute = abi.encodePacked(params.cooperativeNonce,
  /*     params.disputeNonce, 
  /*     bytes32(uint256(uint160(msg.sender))) < params.counterentity, // is started by left
  /*     block.number + 20,
  /*     params.proofbodyHash, 
  /*     keccak256(abi.encodePacked(params.initialArguments)));

  /*   _channels[ch_key].disputeHash = keccak256(encodedDispute);
  /*   emit DisputeStarted(bytes32(uint256(uint160(msg.sender))), params.counterentity, params.disputeNonce, params.initialArguments);
  /* }

  /* COMMENTED OUT: Dispute functionality disabled for development focus
  /* function finalDisputeProof(FinalDisputeProof memory params) public returns (bool) {
  /*   bytes memory ch_key = channelKey(bytes32(uint256(uint160(msg.sender))), params.counterentity);

  /*   // Update dispute scores for both parties involved in the finalization
  /*   entityScores[bytes32(uint256(uint160(msg.sender)))].totalDisputes++;
  /*   entityScores[params.counterentity].totalDisputes++;

  /*   // verify the dispute was started

  /*   if (params.sig.length > 0) {
  /*     // Validate signature if provided
  /*     bytes memory encoded_msg = abi.encode(MessageType.FinalDisputeProof, 
  /*       ch_key, 
  /*       params.cooperativeNonce, 
  /*       params.initialDisputeNonce, 
  /*       params.finalDisputeNonce);
        
  /*     bytes32 final_hash = ECDSA.toEthSignedMessageHash(keccak256(encoded_msg));
  /*     log('encoded_msg',encoded_msg);
  /*     require(ECDSA.recover(final_hash, params.sig) == params.counterentity, "Invalid signer");

  /*     // TODO: if nonce is same, Left one's proof is considered valid

  /*     require(params.initialDisputeNonce < params.finalDisputeNonce, "New nonce must be greater");
  /*   } else {
  /*     // counterparty agrees or does not respond 
  /*     bool senderIsCounterparty = params.startedByLeft != (bytes32(uint256(uint160(msg.sender))) < params.counterentity);
  /*     require(senderIsCounterparty || (block.number >= params.disputeUntilBlock), "Dispute period ended");
  /*     require(params.initialProofbodyHash == keccak256(abi.encode(params.finalProofbody)), "Invalid proofbody");
  /*   }
    

  /*   finalizeChannel(bytes32(uint256(uint160(msg.sender))), params.counterentity, params.finalProofbody, params.finalArguments, params.initialArguments);
  

  /*   return true;
  /* }





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
  
  
  /* return users with reserves in provided tokens
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
  
  /* get many _channels around one address, with collaterals in provided tokens
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
  


  function createDebt(address addr, address creditor, uint tokenId, uint amount) public {
    _debts[addr][tokenId].push(Debt({
      creditor: creditor,
      amount: amount
    }));
  }
  */


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
  /* === SHORTCUT FUNCTIONS ==========================================================================
  /* =================================================================================================

  /**
   * @notice Unilateral action to move funds from reserve to a channel's collateral.
   * @dev This does not require a counterparty signature as it only adds funds to the channel.
   * @param peer The counterparty in the channel.
   * @param tokenId The internal ID of the token being moved.
   * @param amount The amount to move.
   */

}
