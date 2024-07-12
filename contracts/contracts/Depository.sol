// SPDX-License-Identifier: unknown
pragma solidity ^0.8.24;

// Add necessary interfaces
interface IERC20 {
  function transfer(address to, uint256 value) external returns (bool);
  function transferFrom(address from, address to, uint256 value) external returns (bool);
}
interface IERC721 {
  function transferFrom(address from, address to, uint256 tokenId) external;
}
interface IERC1155 {
  function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata data) external;
}
/*import "../openzeppelin-contracts/contracts/token/TypeERC20/IERC20.sol";
import "../openzeppelin-contracts/contracts/token/TypeERC721/IERC721.sol";
import "../openzeppelin-contracts/contracts/token/TypeERC1155/IERC1155.sol";*/

import "./ECDSA.sol";
import "./console.sol";

import "./EntityProvider.sol";

import "./SubcontractProvider.sol";


contract Depository is Console {

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
  Hub[] public hubs;
  
  event TransferReserveToCollateral(address indexed receiver, address indexed addr, uint collateral, int ondelta, uint tokenId);
  //event ChannelUpdated(address indexed receiver, address indexed addr, uint tokenId);


  // Token type identifiers
  uint8 constant TypeERC20 = 0;
  uint8 constant TypeERC721 = 1;
  uint8 constant TypeERC1155 = 2;
  
  enum TokenType {ERC20, ERC721, ERC1155}


  bytes32[] public _tokens;

  constructor() {
    
    // empty record, hub_id==0 means not a hub
    hubs.push(Hub({
      addr: address(0),
      uri: '',
      gasused: 0
    }));
    
    registerHub(0, "ws://127.0.0.1:8400");

    _reserves[msg.sender][0] = 100000000;
    _reserves[msg.sender][1] = 100000000;
    
  }





  struct Batch {
    // tokens move Token <=> Reserve <=> Collateral
    // but never Token <=> Collateral. 'reserve' acts as an intermediary balance
    ReserveToExternalToken[] reserveToExternalToken;
    ExternalTokenToReserve[] externalTokenToReserve;

    // don't require a signature, as they are strictly increasing peer's balance
    ReserveToReserve[] reserveToReserve;
    ReserveToCollateral[] reserveToCollateral;

    // cooperativeUpdate and cooperativeProof are always signed by the peer
    CooperativeUpdate[] cooperativeUpdate;

    // disputeProof is signed by the peer, but could be outdated
    // another peer has time to respond with a newer proof
    DisputeProof[] disputeProof;

    RevealEntries[] revealEntries;

    TokenAmountPair[] flashloans;

    //bytes32[] revealSecret;
    //bytes32[] cleanSecret;
    uint hub_id;
  }


  /*
  function processBatch(bytes calldata encodedBatch, bytes calldata encodedEntity) public returns (bool completeSuccess) {
    address entityAddress = msg.sender;
    if (encodedEntity.length > 0) {
      (address entityProviderAddress, 
      uint entityId, 
      bytes memory entitySignature) = abi.decode(encodedEntity, (address, uint, bytes));

      log("Entity", entityProviderAddress);
      require(EntityProvider(entityProviderAddress).isValidSignature(
        keccak256(encodedBatch),
        entityId,
        entitySignature,
        bytes[]) > 0);

      bytes memory fullEntity = abi.encode(entityProviderAddress, entityId);

      entityAddress = address(keccak256(bytes32(fullEntity)));


    } else {
      log("No entity, fallback to msg.sender");
      
    }

    return _processBatch(entityAddress, abi.decode(encodedBatch, (Batch)));
  }
  */

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

    //submitProof (Header / proofbody)

    for (uint i = 0; i < batch.disputeProof.length; i++) {
      if(!(disputeProof(batch.disputeProof[i]))){
        completeSuccess = false;
      }
    }

    for (uint i = 0; i < batch.revealEntries.length; i++) {
      if(!(revealEntries(batch.revealEntries[i]))){
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
    if (batch.hub_id != 0 && msg.sender == hubs[batch.hub_id].addr){
      hubs[batch.hub_id].gasused += startGas - gasleft();
    }

    return completeSuccess;
    
  }

  
  enum MessageType {
    JSON, // for offchain messages
    CooperativeUpdate,
    CooperativeProof,
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
    uint incrementDeltaAllowence;
    uint decrementDeltaAllowence;
  }
  struct SubcontractClause {
    address subcontractProviderAddress;
    bytes data;
    Allowence[] allowences;
  }

  struct ProofBody{
    int[] offdeltas;
    uint[] tokenIds;
    SubcontractClause[] subcontracts;
  }

  struct DisputeProof {
    address peer;
    uint cooperative_nonce;
    uint dispute_nonce;



    ProofBody proofbody;
    bytes32 proofbody_hash; 

    bytes sig;
  }

  struct RevealEntries {
    address peer;
    ProofBody proofbody;
  }

  // Internal structs
  struct Debt {
    uint amount;
    address pay_to;
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
    uint cooperative_nonce;

    // used for dispute (non-cooperative) close 
    uint dispute_nonce;

    bool dispute_started_by_left;
    uint dispute_until_block;

    // hash of dispute state is stored after dispute is started
    bytes32 proofbody_hash; 

    bytes32 arguments_hash; 
  }




    // Packing Function
    function packTokenReference(uint8 tokenType, address contractAddress, uint96 tokenId) public pure returns (bytes32) {
        require(tokenType <= 2, "Invalid token type");

        bytes32 packed;
        packed |= bytes32(uint256(tokenType)) << 254; // 2 bits for token type
        packed |= bytes32(uint256(uint160(contractAddress))) << 96; // 160 bits for address
        packed |= bytes32(uint256(tokenId)); // 96 bits for token ID

        return packed;
    }

    // Unpacking Function
    function unpackTokenReference(bytes32 packed) public pure returns (uint8 tokenType, address contractAddress, uint96 tokenId) {
        tokenType = uint8(uint256(packed >> 254));
        contractAddress = address(uint160(uint256(packed >> 96)));
        tokenId = uint96(uint256(packed));
    }



  function registerHub(uint hub_id, string memory new_uri) public returns (uint) {
    if (hub_id == 0) {
      hubs.push(Hub({
        addr: msg.sender,
        uri: new_uri,
        gasused: 0
      }));
      return hubs.length - 1;
    } else {
      require(msg.sender == hubs[hub_id].addr, "Not your hub address");
      hubs[hub_id].uri = new_uri;
      return hub_id;
    }
  }

  struct ExternalTokenToReserve{
    address receiver;
    bytes32 packedToken;
    uint internalTokenId;
    uint amount;
  }
  function externalTokenToReserve(ExternalTokenToReserve memory params) public {
    if (params.internalTokenId == 0) {
      // create new token
      _tokens.push(params.packedToken);
      params.internalTokenId = _tokens.length - 1;
    } else {
      params.packedToken = _tokens[params.internalTokenId];
      require(_tokens[params.internalTokenId] == params.packedToken, "Token data mismatch");
    }


    (uint8 tokenType, address contractAddress, uint96 tokenId) = unpackTokenReference(params.packedToken);
    
    if (tokenType == TypeERC20) {
        IERC20(contractAddress).transferFrom(msg.sender, address(this), params.amount);
    } else if (tokenType == TypeERC721) {
        IERC721(contractAddress).transferFrom(msg.sender, address(this), tokenId);
    } else if (tokenType == TypeERC1155) {
        IERC1155(contractAddress).safeTransferFrom(msg.sender, address(this), tokenId, params.amount, "");
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

    (uint8 tokenType, address contractAddress, uint96 tokenId) = unpackTokenReference(_tokens[params.tokenId]);
    require(_reserves[msg.sender][params.tokenId] >= params.amount, "Not enough reserve");

    _reserves[msg.sender][params.tokenId] -= params.amount;

    if (tokenType == TypeERC20) {
      require(IERC20(contractAddress).transfer(params.receiver, params.amount));
    } else if (tokenType == TypeERC721) {
      IERC721(contractAddress).transferFrom(address(this), params.receiver, tokenId);
    } else if (tokenType == TypeERC1155) {
      IERC1155(contractAddress).safeTransferFrom(address(this), params.receiver, tokenId, params.amount, "");
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
      // the user has nothing, try again later
      return debtsLength - memoryDebtIndex;
    }
    // allow partial enforcing in case there are too many _debts to pay off at once (over block gas limit)
    while (true) {
      Debt storage debt = _debts[addr][tokenId][memoryDebtIndex];
      
      if (memoryReserve >= debt.amount) {
        // can pay this debt off in full
        memoryReserve -= debt.amount;
        _reserves[debt.pay_to][tokenId] += debt.amount;

        delete _debts[addr][tokenId][memoryDebtIndex];

        // last debt was paid off, the user is debt free now
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
        _reserves[debt.pay_to][tokenId] += memoryReserve;
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
  
  struct TokenReserveDebts {
    uint reserve;
    uint _debtIndex;
    Debt[] _debts;
  }
  
  struct UserReturn {
    uint ETH_balance;
    TokenReserveDebts[] _tokens;
  }


  

  function reserveToCollateral(ReserveToCollateral memory params) public returns (bool completeSuccess) {
    //require(_channels[ch_key].dispute_until_block == 0);
    uint tokenId = params.tokenId;
    address receiver = params.receiver;
   
    // _debts must be paid before any transfers from reserve 
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

  function cooperativeUpdate(CooperativeUpdate memory params) public returns (bool) {
    bytes memory ch_key = channelKey(msg.sender, params.peer);

    bytes memory encoded_msg = abi.encode(MessageType.CooperativeUpdate, 
    ch_key, 
    _channels[ch_key].cooperative_nonce, 
    params.diffs, 
    params.forgiveDebtsInTokenIds);

    bytes32 hash = ECDSA.toEthSignedMessageHash(keccak256(encoded_msg));

    log('Encoded msg', encoded_msg);
    
    if(params.peer != ECDSA.recover(hash, params.sig)) {
      log("Invalid signer ", ECDSA.recover(hash, params.sig));
      return false;
    }

    _channels[ch_key].cooperative_nonce++;

    for (uint i = 0; i < params.diffs.length; i++) {
      Diff memory diff = params.diffs[i];
      // ensure that the user has enough funds to apply the diffs



      
      if (diff.peerReserveDiff > 0) {
        _reserves[msg.sender][diff.tokenId] -= uint(diff.peerReserveDiff);
        _reserves[params.peer][diff.tokenId] += uint(diff.peerReserveDiff);
      } else {
        _reserves[params.peer][diff.tokenId] -= uint(-diff.peerReserveDiff);
        _reserves[msg.sender][diff.tokenId] += uint(-diff.peerReserveDiff);
      }

    }

    logChannel(msg.sender, params.peer);
    return true;
  }

  /*
  function cooperativeProof(CooperativeProof memory params) public returns (bool) {
    bytes memory ch_key = channelKey(msg.sender, params.peer);

    bytes memory encoded_msg = abi.encode(MessageType.CooperativeProof, ch_key, _channels[ch_key].cooperative_nonce, _channels[ch_key].cooperative_nonce, params.entries);

    bytes32 hash = ECDSA.toEthSignedMessageHash(keccak256(encoded_msg));
    log('Encoded hash', hash);
    log('Encoded msg', encoded_msg);

    if(params.peer != ECDSA.recover(hash, params.sig)) {
      log("Invalid signer ", ECDSA.recover(hash, params.sig));
      return false;
    }

    finalizeChannel(msg.sender, params.peer, params.entries);
    return true;
  }*/


 



  // returns tokens to _reserves based on final deltas and _collaterals
  // then increases cooperative_nonce to invalidate all previous dispute proofs
  function finalizeChannel(address user1, address user2, ProofBody memory proofbody, bytes[] memory leftArguments, bytes[] memory rightArguments) internal returns (bool) {
    address l_user;
    address r_user;
    if (user1 < user2) {
      l_user = user1;
      r_user = user2;
    } else {
      l_user = user2;
      r_user = user1;    
    }

    bytes memory ch_key = abi.encodePacked(l_user, r_user);

    logChannel(l_user, r_user);

    // 1. create deltas (ondelta+offdelta) from proofbody
    int[] memory deltas = new int[](proofbody.offdeltas.length);
    for (uint i = 0;i<deltas.length;i++){
      deltas[i] = _collaterals[ch_key][proofbody.tokenIds[i]].ondelta + int(proofbody.offdeltas[i]);
    }
    
    // 2. process subcontracts and apply to deltas
    for (uint i = 0; i < proofbody.subcontracts.length; i++){

      SubcontractClause memory sub = proofbody.subcontracts[i];
      int[] memory newDeltas = SubcontractProvider(sub.subcontractProviderAddress).process(
        SubcontractProvider.SubcontractParams(
        deltas, 
        proofbody.tokenIds, 
        l_user, 
        r_user, 
        sub.data, 
        leftArguments[i],
        rightArguments[i]
      ));



      // iterate over allowences and apply to new deltas to deltas if they are respected
      for (uint j = 0; j < sub.allowences.length; j++){
        Allowence memory allowence = sub.allowences[j];
        int maxDelta = deltas[allowence.deltaIndex] + int(allowence.incrementDeltaAllowence);
        int minDelta = deltas[allowence.deltaIndex] - int(allowence.decrementDeltaAllowence);
        if (minDelta <= newDeltas[allowence.deltaIndex] && newDeltas[allowence.deltaIndex] <= maxDelta){
          deltas[allowence.deltaIndex] = newDeltas[allowence.deltaIndex];
        }
      }
    }
    
    // 3. split _collaterals
    for (uint i = 0;i<deltas.length;i++){
      uint tokenId = proofbody.tokenIds[i];
      int delta = deltas[i];
      ChannelCollateral storage col = _collaterals[ch_key][tokenId];

      if (delta >= 0 && uint(delta) <= col.collateral) {
        // ChannelCollateral is split (standard no-credit LN resolution)
        uint left_gets = uint(delta);
        _reserves[l_user][tokenId] += left_gets;
        _reserves[r_user][tokenId] += col.collateral - left_gets;
      } else {
        // one user gets entire collateral, another pays uncovered credit from reserve or gets debt (resolution enabled by XLN)
        address getsCollateral = delta < 0 ? r_user : l_user;
        address getsDebt = delta < 0 ? l_user : r_user;
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
            pay_to: getsCollateral,
            amount: debtAmount
          }));
          _activeDebts[getsDebt]++;
        }
      }

      delete _collaterals[ch_key][tokenId];
    }


    delete _channels[ch_key].proofbody_hash;
    delete _channels[ch_key].dispute_nonce;

    delete _channels[ch_key].dispute_until_block;
    delete _channels[ch_key].dispute_started_by_left;

    _channels[ch_key].cooperative_nonce++;
   
    logChannel(l_user, r_user);

    return true;

  }


  function disputeProof(DisputeProof memory params) public returns (bool) {
    bytes memory ch_key = channelKey(msg.sender, params.peer);

    // users must always hold a dispute proof with cooperative_nonce equal or higher than the one in the contract
    require(_channels[ch_key].cooperative_nonce <= params.cooperative_nonce, "Outdated cooperative_nonce");

    bytes memory encoded_msg = abi.encode(MessageType.DisputeProof, ch_key, params.cooperative_nonce, params.dispute_nonce, params.proofbody_hash);

    bytes32 final_hash = ECDSA.toEthSignedMessageHash(keccak256(encoded_msg));

    log('encoded_msg',encoded_msg);

    require(ECDSA.recover(final_hash, params.sig) == params.peer, "Invalid signer");

    if (_channels[ch_key].dispute_until_block == 0) {
      // starting a dispute
      _channels[ch_key].dispute_started_by_left = msg.sender < params.peer;
      _channels[ch_key].dispute_nonce = params.dispute_nonce;
      _channels[ch_key].proofbody_hash = params.proofbody_hash;

      // todo: hubs get shorter delay
      _channels[ch_key].dispute_until_block = block.number + 20;

      log("set until", _channels[ch_key].dispute_until_block);
    } else {
      // providing another dispute proof with higher nonce
      // TODO: if nonce is same, Left one's proof is considered valid
      require(!_channels[ch_key].dispute_started_by_left == msg.sender < params.peer, "Only your peer can respond to dispute");

      require(_channels[ch_key].dispute_nonce < params.dispute_nonce, "New nonce must be greater");

      require(params.proofbody_hash == keccak256(abi.encode(params.proofbody)), "Invalid proofbody_hash");
      
      bytes[] memory leftArguments;
      bytes[] memory rightArguments;

      finalizeChannel(msg.sender, params.peer, params.proofbody, leftArguments, rightArguments);
      return true;
    }

    return true;
  }


  function revealEntries(RevealEntries memory params) public returns (bool success) {
    bytes memory ch_key = channelKey(msg.sender, params.peer);

    bool sender_is_left = msg.sender < params.peer;
 
    if ((_channels[ch_key].dispute_started_by_left == sender_is_left) && block.number < _channels[ch_key].dispute_until_block) {
      return false;
    } else if (_channels[ch_key].proofbody_hash != keccak256(abi.encode(params.proofbody))) {
      return false;
    } 

    finalizeChannel(msg.sender, params.peer, params.proofbody, new bytes[](0), new bytes[](0));
    return true;
  }






  function getUser(address addr) external view returns (UserReturn memory) {
    UserReturn memory response = UserReturn({
      ETH_balance: addr.balance,
      _tokens: new TokenReserveDebts[](_tokens.length)
    });
    
    for (uint i = 0;i<_tokens.length;i++){
      response._tokens[i]=(TokenReserveDebts({
        reserve: _reserves[addr][i],
        _debtIndex: _debtIndex[addr][i],
        _debts: _debts[addr][i]
      }));
    }
    
    return response;
  }
  
  struct ChannelReturn{
    address peer;
    ChannelInfo channel;
    ChannelCollateral[] _collaterals;
  }
  
  // get many _channels around one address
  function getChannels(address  addr, address[] memory peers) public view returns ( ChannelReturn[] memory response) {
    bytes memory ch_key;

    // set length of the response array
    response = new ChannelReturn[](peers.length);

    for (uint i = 0;i<peers.length;i++){
      ch_key = channelKey(addr, peers[i]);

      response[i]=ChannelReturn({
        peer: peers[i],
        channel: _channels[ch_key],
        _collaterals: new ChannelCollateral[](_tokens.length)
      });

      for (uint tokenId = 0;tokenId<_tokens.length;tokenId++){
        response[i]._collaterals[tokenId]=_collaterals[ch_key][tokenId];
      }
      
    }

    return response;

    
  }

  function getAllHubs () public view returns (Hub[] memory) {
    return hubs;
  }
  function getAllTokens () public view returns (bytes32[] memory) {
    return _tokens;
  }
  



  function createDebt(address addr, address pay_to, uint tokenId, uint amount) public {
    _debts[addr][tokenId].push(Debt({
      pay_to: pay_to,
      amount: amount
    }));
  }


  function logChannel(address a1, address a2) public {
    bytes memory ch_key = channelKey(a1, a2);
    log(">>> Logging channel", ch_key);
    log("cooperative_nonce", _channels[ch_key].cooperative_nonce);
    log("dispute_nonce", _channels[ch_key].dispute_nonce);
    log("dispute_until_block", _channels[ch_key].dispute_until_block);
    for (uint i = 0; i < _tokens.length; i++) {
      log("PackedToken", _tokens[i]);
      log("Left:", _reserves[a1][i]);
      log("Right:", _reserves[a2][i]);
      log("collateral", _collaterals[ch_key][i].collateral);
      log("ondelta", _collaterals[ch_key][i].ondelta);
    }
  }       
}
