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
  
  mapping (address entity => mapping (uint tokenId => uint)) public _reserves;

  mapping (bytes channelKey => ChannelInfo) public _channels;
  mapping (bytes channelKey => mapping(uint tokenId => ChannelCollateral)) public _collaterals; 
  

  mapping (address entity => mapping (uint tokenId => Debt[])) public _debts;
  // the current debt index to pay
  mapping (address entity => mapping (uint tokenId => uint)) public _debtIndex;
  // total number of debts of an entity
  mapping (address entity => uint) public _activeDebts;


  struct Hub {
    address addr;
    uint gasused;
    string uri;
  }
  Hub[] public _hubs;
  
  event TransferReserveToCollateral(address indexed receiver, address indexed addr, uint collateral, int ondelta, uint tokenId);
  event DisputeStarted(address indexed sender, address indexed peer, uint indexed disputeNonce, bytes initialArguments);
  event CooperativeClose(address indexed sender, address indexed peer, uint indexed cooperativeNonce);
  
  //event ChannelUpdated(address indexed receiver, address indexed addr, uint tokenId);


  // Token type identifiers
  uint8 constant TypeERC20 = 0;
  uint8 constant TypeERC721 = 1;
  uint8 constant TypeERC1155 = 2;   




  bytes32[] public _tokens;

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
      addr: address(0),
      uri: '',
      gasused: 0
    }));
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

    // cooperativeUpdate and cooperativeProof are always signed by the peer
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


  /**
   * @notice Process batch with entity signature authorization
   * @param encodedBatch The batch data
   * @param entityProvider EntityProvider contract address
   * @param entityNumber Entity number  
   * @param encodedBoard Entity board data
   * @param encodedSignature Entity signatures
   */
  function processBatchAsEntity(
    bytes calldata encodedBatch,
    address entityProvider,
    uint256 entityNumber,
    bytes calldata encodedBoard,
    bytes calldata encodedSignature
  ) external onlyApprovedProvider(entityProvider) returns (bool completeSuccess) {
    
    // Verify entity signature
    uint256 recoveredEntity = EntityProvider(entityProvider).recoverEntity(
      encodedBoard,
      encodedSignature,
      keccak256(encodedBatch)
    );
    
    require(recoveredEntity == entityNumber, "Invalid entity signature");
    
    // Calculate entity address
    bytes32 entityId = bytes32(entityNumber);
    address entityAddress = address(uint160(uint256(entityId)));
    
    return _processBatch(entityAddress, abi.decode(encodedBatch, (Batch)));
  }

  function processBatch(Batch calldata batch) public returns (bool completeSuccess) {
    return _processBatch(msg.sender, batch);
  }

  function _processBatch(address entityAddress, Batch memory batch) private returns (bool completeSuccess) {
    uint startGas = gasleft();

    // the order is important: first go methods that increase entity's balance
    // then methods that deduct from it

    completeSuccess = true; 


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
    
    for (uint i = 0; i < batch.cooperativeUpdate.length; i++) {
      if(!(cooperativeUpdate(batch.cooperativeUpdate[i]))){
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
      if(!(reserveToCollateral(batch.reserveToCollateral[i]))){
        completeSuccess = false;
      }
    }
    
    /*
    for (uint i = 0; i < batch.revealSecret.length; i++) {
      revealSecret(batch.revealSecret[i]);
    }

    for (uint i = 0; i < batch.cleanSecret.length; i++) {
      cleanSecret(batch.cleanSecret[i]);
    }*/

    // increase gasused for hubs
    // this is hardest to fake metric of real usage
    if (batch.hub_id != 0 && msg.sender == _hubs[batch.hub_id].addr){
      _hubs[batch.hub_id].gasused += startGas - gasleft();
    }

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
    address addr;
    uint amount;
  }

  struct ReserveToCollateral {
    uint tokenId;
    address receiver;
    // put in _channels with who (addr) and how much (amount)
    AddrAmountPair[] pairs;
  }

  struct Diff {
    uint tokenId;
    int peerReserveDiff;
    int collateralDiff;
    int ondeltaDiff;
  }

  struct CooperativeUpdate {
    address peer;
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
    address peer;
    ProofBody proofbody;
    bytes initialArguments;
    bytes finalArguments;
    bytes sig;
  }

  struct InitialDisputeProof {
    address peer;
    uint cooperativeNonce;
    uint disputeNonce;
    bytes32 proofbodyHash; 
    bytes sig;

    bytes initialArguments;
  }

  struct FinalDisputeProof {
    address peer;
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
    address creditor;
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
        addr: msg.sender,
        uri: new_uri,
        gasused: 0
      }));
      return _hubs.length - 1;
    } else {
      require(msg.sender == _hubs[hub_id].addr);
      _hubs[hub_id].uri = new_uri;
      return hub_id;
    }
  }

  struct ExternalTokenToReserve{
    bytes32 packedToken;
    uint internalTokenId;
    uint amount;
  }
  function externalTokenToReserve(ExternalTokenToReserve memory params) public {
    if (params.internalTokenId == 0) {
      // create new token
      _tokens.push(params.packedToken);
      params.internalTokenId = _tokens.length - 1;

      //console.log("Saved new token:", params.internalTokenId);
    } else {
      params.packedToken = _tokens[params.internalTokenId];
      //require(_tokens[params.internalTokenId] == params.packedToken, "Token data mismatch");
    }


    (address contractAddress, uint96 tokenId, uint8 tokenType) = unpackTokenReference(params.packedToken);
    //console.log('unpackedToken ', contractAddress,tokenId,  tokenType);

    // todo: allow longer uint256 tokenId for ERC721 and ERC1155 
    // e.g. Rarible has format of 0xCreatorAddress..00000TokenId
    if (tokenType == TypeERC20) {
      //console.log("20", contractAddress, msg.sender, address(this));

      require(IERC20(contractAddress).transferFrom(msg.sender, address(this), params.amount), "Fail");
    } else if (tokenType == TypeERC721) {
      // 721 does not return bool on transfer
      IERC721(contractAddress).transferFrom(msg.sender, address(this), uint(tokenId));
    } else if (tokenType == TypeERC1155) {
      IERC1155(contractAddress).safeTransferFrom(msg.sender, address(this), uint(tokenId), params.amount, "");
    }

    _reserves[msg.sender][params.internalTokenId] += params.amount;
  }


  struct ReserveToExternalToken{
    address receiver;
    uint tokenId;
    uint amount;
  }
  function reserveToExternalToken(ReserveToExternalToken memory params) public {
    enforceDebts(msg.sender, params.tokenId);

    (address contractAddress, uint96 tokenId, uint8 tokenType) = unpackTokenReference(_tokens[params.tokenId]);
    //console.log('unpackedToken ', contractAddress,tokenId,  tokenType);

    require(_reserves[msg.sender][params.tokenId] >= params.amount, "Not enough reserve");

    _reserves[msg.sender][params.tokenId] -= params.amount;

    if (tokenType == TypeERC20) {
      require(IERC20(contractAddress).transfer(params.receiver, params.amount));
    } else if (tokenType == TypeERC721) {
      IERC721(contractAddress).transferFrom(address(this), params.receiver, uint(tokenId));
    } else if (tokenType == TypeERC1155) {
      IERC1155(contractAddress).safeTransferFrom(address(this), params.receiver, uint(tokenId), params.amount, "");
    }

  }
  struct ReserveToReserve{
    address receiver;
    uint tokenId;
    uint amount;
  }
  function reserveToReserve(ReserveToReserve memory params) public {
    enforceDebts(msg.sender, params.tokenId);

    require(_reserves[msg.sender][params.tokenId] >= params.amount);
    _reserves[msg.sender][params.tokenId] -= params.amount;
    _reserves[params.receiver][params.tokenId] += params.amount;
  }




  
  function getDebts(address addr, uint tokenId) public view returns (Debt[] memory allDebts, uint currentDebtIndex) {
    currentDebtIndex = _debtIndex[addr][tokenId];
    allDebts = _debts[addr][tokenId];
  }


  // triggered automatically before every reserveTo{Reserve/ChannelCollateral/PackedToken}
  // can be called manually
  // iterates over _debts starting from current _debtIndex, first-in-first-out 
  // max _debts?
  function enforceDebts(address addr, uint tokenId) public returns (uint totalDebts) {
    uint debtsLength = _debts[addr][tokenId].length;
    if (debtsLength == 0) {
      return 0;
    }
   
    uint memoryReserve = _reserves[addr][tokenId]; 
    uint memoryDebtIndex = _debtIndex[addr][tokenId];
    
    if (memoryReserve == 0){
      return debtsLength - memoryDebtIndex;
    }
    // allow partial enforcing in case there are too many _debts to pay off at once (over block gas limit)
    while (true) {
      Debt storage debt = _debts[addr][tokenId][memoryDebtIndex];
      
      if (memoryReserve >= debt.amount) {
        // can pay this debt off in full
        memoryReserve -= debt.amount;
        _reserves[debt.creditor][tokenId] += debt.amount;

        delete _debts[addr][tokenId][memoryDebtIndex];

        // last debt was paid off, the entity is debt free now
        if (memoryDebtIndex+1 == debtsLength) {
          memoryDebtIndex = 0;
          // resets .length to 0
          delete _debts[addr][tokenId]; 
          debtsLength = 0;
          break;
        }
        memoryDebtIndex++;
        _activeDebts[addr]--;
        
      } else {
        // pay off the debt partially and break the loop
        _reserves[debt.creditor][tokenId] += memoryReserve;
        debt.amount -= memoryReserve;
        memoryReserve = 0;
        break;
      }
    }

    // put memory variables back to storage
    _reserves[addr][tokenId] = memoryReserve;
    _debtIndex[addr][tokenId] = memoryDebtIndex;
    
    return debtsLength - memoryDebtIndex;
  }



  function channelKey(address a1, address a2) public pure returns (bytes memory) {
    //determenistic channel key is 40 bytes: concatenated lowerKey + higherKey
    return a1 < a2 ? abi.encodePacked(a1, a2) : abi.encodePacked(a2, a1);
  }
  

  

  function reserveToCollateral(ReserveToCollateral memory params) public returns (bool completeSuccess) {
    uint tokenId = params.tokenId;
    address receiver = params.receiver;
   
    // debts must be paid before any transfers from reserve 
    enforceDebts(msg.sender, tokenId);

    for (uint i = 0; i < params.pairs.length; i++) {
      address addr = params.pairs[i].addr;
      uint amount = params.pairs[i].amount;

      bytes memory ch_key = channelKey(params.receiver, addr);

      logChannel(params.receiver, addr);

      if (_reserves[msg.sender][tokenId] >= amount) {
        ChannelCollateral storage col = _collaterals[ch_key][tokenId];

        _reserves[msg.sender][tokenId] -= amount;
        col.collateral += amount;
        if (params.receiver < addr) { // if receiver is left
          col.ondelta += int(amount);
        }

        emit TransferReserveToCollateral(receiver, addr, col.collateral, col.ondelta, tokenId);

        log("Deposited to channel ", _collaterals[ch_key][tokenId].collateral);
      } else {
        log("Not enough funds", msg.sender);
        return false;
      }
      logChannel(params.receiver, addr);

    }


    return true;
  }




  // mutually agreed update of channel state in a single atomic operation
  function cooperativeUpdate(CooperativeUpdate memory params) public returns (bool) {
    bytes memory ch_key = channelKey(msg.sender, params.peer);

    bytes memory encoded_msg = abi.encode(MessageType.CooperativeUpdate, 
    ch_key, 
    _channels[ch_key].cooperativeNonce, 
    params.diffs, 
    params.forgiveDebtsInTokenIds);

    bytes32 hash = ECDSA.toEthSignedMessageHash(keccak256(encoded_msg));

    log('Encoded msg', encoded_msg);
    
    if(params.peer != ECDSA.recover(hash, params.sig)) {
      log("Invalid signer ", ECDSA.recover(hash, params.sig));
      return false;
    }


    for (uint i = 0; i < params.diffs.length; i++) {
      Diff memory diff = params.diffs[i];

      if (diff.peerReserveDiff < 0) {
        enforceDebts(params.peer, diff.tokenId);
        require(_reserves[params.peer][diff.tokenId] >= uint(-diff.peerReserveDiff), "Not enough peer reserve");

        _reserves[params.peer][diff.tokenId] -= uint(-diff.peerReserveDiff);
      } else {
        _reserves[params.peer][diff.tokenId] += uint(diff.peerReserveDiff);
      }


      // ensure that the entity has enough funds to apply the diffs
      int totalDiff = diff.peerReserveDiff + diff.collateralDiff;
      if (totalDiff > 0) {
        enforceDebts(msg.sender, diff.tokenId);
        // if the sender is sending funds, they must have them
        require(_reserves[msg.sender][diff.tokenId] >= uint(totalDiff), "Not enough sender reserve");

        _reserves[msg.sender][diff.tokenId] -= uint(totalDiff);
      } else {
        // sender is receiving
        _reserves[msg.sender][diff.tokenId] += uint(-totalDiff);
      }


      if (diff.collateralDiff < 0) {
        require(_collaterals[ch_key][diff.tokenId].collateral >= uint(-diff.collateralDiff), "Not enough collateral");
        _collaterals[ch_key][diff.tokenId].collateral -= uint(diff.collateralDiff);
      } else {
        _collaterals[ch_key][diff.tokenId].collateral += uint(diff.collateralDiff);
      }

      // ondeltaDiff can be arbitrary
      _collaterals[ch_key][diff.tokenId].ondelta += diff.ondeltaDiff;
    }
    _channels[ch_key].cooperativeNonce++;

    logChannel(msg.sender, params.peer);
    return true;
  }


 



  // returns tokens to _reserves based on final deltas and _collaterals
  // then increases cooperativeNonce to invalidate all previous dispute proofs

  // todo: private visability
  function finalizeChannel(address entity1, 
      address entity2, 
      ProofBody memory proofbody, 
      bytes memory arguments1, 
      bytes memory arguments2) public returns (bool) 
  {
    address leftAddress;
    address rightAddress;
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

    bytes memory ch_key = abi.encodePacked(leftAddress, rightAddress);

    logChannel(leftAddress, rightAddress);

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
        }
      }

      delete _collaterals[ch_key][tokenId];
    }


    delete _channels[ch_key].disputeHash;

    _channels[ch_key].cooperativeNonce++;
   
    logChannel(leftAddress, rightAddress);

    return true;

  }

  function cooperativeDisputeProof (CooperativeDisputeProof memory params) public returns (bool) {
    bytes memory ch_key = channelKey(msg.sender, params.peer);


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

    require(ECDSA.recover(final_hash, params.sig) == params.peer);

    require(_channels[ch_key].disputeHash == bytes32(0));

    delete _channels[ch_key].disputeHash;

    finalizeChannel(msg.sender, params.peer, params.proofbody, params.finalArguments, params.initialArguments);
    
    emit CooperativeClose(msg.sender, params.peer, _channels[ch_key].cooperativeNonce);
  }


  function initialDisputeProof(InitialDisputeProof memory params) public returns (bool) {
    bytes memory ch_key = channelKey(msg.sender, params.peer);

    // entities must always hold a dispute proof with cooperativeNonce equal or higher than the one in the contract
    require(_channels[ch_key].cooperativeNonce <= params.cooperativeNonce);

    bytes memory encoded_msg = abi.encode(MessageType.DisputeProof, 
      ch_key, 
      params.cooperativeNonce, 
      params.disputeNonce, 
      params.proofbodyHash);

    bytes32 final_hash = ECDSA.toEthSignedMessageHash(keccak256(encoded_msg));

    log('encoded_msg',encoded_msg);

    require(ECDSA.recover(final_hash, params.sig) == params.peer, "Invalid signer");

    require(_channels[ch_key].disputeHash == bytes32(0));

    bytes memory encodedDispute = abi.encodePacked(params.cooperativeNonce,
      params.disputeNonce, 
      msg.sender < params.peer, // is started by left
      block.number + 20,
      params.proofbodyHash, 
      keccak256(abi.encodePacked(params.initialArguments)));

    _channels[ch_key].disputeHash = keccak256(encodedDispute);
    emit DisputeStarted(msg.sender, params.peer, params.disputeNonce, params.initialArguments);
  }

  function finalDisputeProof(FinalDisputeProof memory params) public returns (bool) {
    bytes memory ch_key = channelKey(msg.sender, params.peer);
    // verify the dispute was started

    bytes memory encodedDispute = abi.encodePacked(params.initialCooperativeNonce,
      params.initialDisputeNonce, 
      params.startedByLeft, 
      params.disputeUntilBlock,
      params.initialProofbodyHash, 
      keccak256(params.initialArguments));
    
    require(_channels[ch_key].disputeHash == keccak256(encodedDispute), "Dispute not found");

    if (params.sig.length != 0) {
      // counter proof was provided
      bytes32 finalProofbodyHash = keccak256(abi.encode(params.finalProofbody));
      bytes memory encoded_msg = abi.encode(MessageType.DisputeProof, 
        ch_key, 
        params.finalCooperativeNonce, 
        params.finalDisputeNonce, 
        finalProofbodyHash);

      bytes32 final_hash = ECDSA.toEthSignedMessageHash(keccak256(encoded_msg));
      log('encoded_msg',encoded_msg);
      require(ECDSA.recover(final_hash, params.sig) == params.peer, "Invalid signer");

      // TODO: if nonce is same, Left one's proof is considered valid

      require(params.initialDisputeNonce < params.finalDisputeNonce, "New nonce must be greater");

      
    } else {
      // counterparty agrees or does not respond 
      bool senderIsCounterparty = params.startedByLeft != msg.sender < params.peer;
      require(senderIsCounterparty || (block.number >= params.disputeUntilBlock), "Dispute period ended");
      require(params.initialProofbodyHash == keccak256(abi.encode(params.finalProofbody)), "Invalid proofbody");
    }
    

    finalizeChannel(msg.sender, params.peer, params.finalProofbody, params.finalArguments, params.initialArguments);
  

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
  
  
  // return users with reserves in provided tokens
  function getUsers(address[] memory addrs, uint[] memory tokenIds) external view returns (UserReturn[] memory response) {
    response = new UserReturn[](addrs.length);
    for (uint i = 0;i<addrs.length;i++){
      address addr = addrs[i];
      response[i] = UserReturn({
        ETH_balance: addr.balance,
        tokens: new TokenReserveDebts[](tokenIds.length)
      });
    
      for (uint j = 0;j<tokenIds.length;j++){
        response[i].tokens[j]= TokenReserveDebts({
          reserve: _reserves[addr][tokenIds[j]],
          debtIndex: _debtIndex[addr][tokenIds[j]],
          debts: _debts[addr][tokenIds[j]]
        });
      }
    }
    
    return response;
  }
  
  // get many _channels around one address, with collaterals in provided tokens
  function getChannels(address  addr, address[] memory peers, uint[] memory tokenIds) public view returns (ChannelReturn[] memory response) {
    bytes memory ch_key;

    // set length of the response array
    response = new ChannelReturn[](peers.length);

    for (uint i = 0;i<peers.length;i++){
      ch_key = channelKey(addr, peers[i]);

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


  function logChannel(address a1, address a2) public {
    /*
    bytes memory ch_key = channelKey(a1, a2);
    log(">>> Logging channel", ch_key);
    log("cooperativeNonce", _channels[ch_key].cooperativeNonce);
    log("disputeHash", _channels[ch_key].disputeHash);

    for (uint i = 0; i < _tokens.length; i++) {
      log("Token", _tokens[i]);
      log("Left:", _reserves[a1][i]);
      log("Right:", _reserves[a2][i]);
      log("collateral", _collaterals[ch_key][i].collateral);
      log("ondelta", _collaterals[ch_key][i].ondelta);
    }*/
  }       

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
    return this.onERC1155Received.selector;
  }


}
