pragma solidity ^0.8.24;

import "./Token.sol";

contract EntityProvider { 
  struct Entity {
    bytes32 currentBoardHash;
    bytes32 proposedAuthenticatorHash;
    uint256 registrationBlock;
    bool exists;
  }

  struct Delegate {
    bytes entityId;
    uint16 votingPower;
  }

  struct Board {
    uint16 votingThreshold;
    Delegate[] delegates;
  }

  // Core entity storage - single mapping for all entities
  mapping(bytes32 => Entity) public entities;
  
  // Sequential numbering for registered entities
  uint256 public nextNumber = 1;
  
  // Name system (decoupled from entity IDs)
  mapping(string => uint256) public nameToNumber;  // "coinbase" => 42
  mapping(uint256 => string) public numberToName;  // 42 => "coinbase"
  mapping(string => bool) public reservedNames;    // Admin-controlled names
  
  // Admin controls
  address public admin;
  mapping(address => uint8) public nameQuota;      // User name allowances
  
  // Legacy support
  mapping (uint => uint) public activateAtBlock;

  // Events
  event EntityRegistered(bytes32 indexed entityId, uint256 indexed entityNumber, bytes32 boardHash);
  event NameAssigned(string indexed name, uint256 indexed entityNumber);
  event NameTransferred(string indexed name, uint256 indexed fromNumber, uint256 indexed toNumber);
  event BoardProposed(bytes32 indexed entityId, bytes32 proposedBoardHash);
  event BoardActivated(bytes32 indexed entityId, bytes32 newBoardHash);

  constructor() {
    admin = msg.sender;
    // Reserve some premium names
    reservedNames["coinbase"] = true;
    reservedNames["ethereum"] = true;
    reservedNames["bitcoin"] = true;
    reservedNames["uniswap"] = true;
  }

  modifier onlyAdmin() {
    require(msg.sender == admin, "Only admin");
    _;
  }

  /**
   * @notice Register a new numbered entity (anyone can call)
   * @param boardHash Initial board/quorum hash
   * @return entityNumber The assigned entity number
   */
  function registerNumberedEntity(bytes32 boardHash) external returns (uint256 entityNumber) {
    entityNumber = nextNumber++;
    bytes32 entityId = bytes32(entityNumber);
    
    entities[entityId] = Entity({
      currentBoardHash: boardHash,
      proposedAuthenticatorHash: bytes32(0),
      registrationBlock: block.number,
      exists: true
    });
    
    emit EntityRegistered(entityId, entityNumber, boardHash);
    return entityNumber;
  }

  /**
   * @notice Admin assigns a name to an existing numbered entity
   * @param name The name to assign (e.g., "coinbase")
   * @param entityNumber The entity number to assign the name to
   */
  function assignName(string memory name, uint256 entityNumber) external onlyAdmin {
    require(bytes(name).length > 0 && bytes(name).length <= 32, "Invalid name length");
    require(entities[bytes32(entityNumber)].exists, "Entity doesn't exist");
    require(nameToNumber[name] == 0, "Name already assigned");
    
    // If entity already has a name, clear it
    string memory oldName = numberToName[entityNumber];
    if (bytes(oldName).length > 0) {
      delete nameToNumber[oldName];
    }
    
    nameToNumber[name] = entityNumber;
    numberToName[entityNumber] = name;
    
    emit NameAssigned(name, entityNumber);
  }

  /**
   * @notice Transfer a name from one entity to another (admin only for now)
   * @param name The name to transfer
   * @param newEntityNumber The target entity number
   */
  function transferName(string memory name, uint256 newEntityNumber) external onlyAdmin {
    require(nameToNumber[name] != 0, "Name not assigned");
    require(entities[bytes32(newEntityNumber)].exists, "Target entity doesn't exist");
    
    uint256 oldEntityNumber = nameToNumber[name];
    
    // Clear old mapping
    delete numberToName[oldEntityNumber];
    
    // Set new mapping
    nameToNumber[name] = newEntityNumber;
    numberToName[newEntityNumber] = name;
    
    emit NameTransferred(name, oldEntityNumber, newEntityNumber);
  }

  /**
   * @notice Propose a new board for an entity
   * @param entityId The entity ID (bytes32 format)
   * @param newBoardHash Hash of the new proposed board
   */
  function proposeBoard(bytes32 entityId, bytes32 newBoardHash) external {
    require(entities[entityId].exists, "Entity doesn't exist");
    
    entities[entityId].proposedAuthenticatorHash = newBoardHash;
    emit BoardProposed(entityId, newBoardHash);
  }

  /**
   * @notice Activate a previously proposed board
   * @param entityId The entity ID
   */
  function activateBoard(bytes32 entityId) external {
    require(entities[entityId].exists, "Entity doesn't exist");
    require(entities[entityId].proposedAuthenticatorHash != bytes32(0), "No proposed board");
    
    entities[entityId].currentBoardHash = entities[entityId].proposedAuthenticatorHash;
    entities[entityId].proposedAuthenticatorHash = bytes32(0);
    
    // Legacy support
    if (uint256(entityId) < 1000000) {
      activateAtBlock[uint256(entityId)] = block.number;
    }
    
    emit BoardActivated(entityId, entities[entityId].currentBoardHash);
  }

  /**
   * @notice Verify entity signature (simplified version)
   * @param _hash The hash that was signed
   * @param entityId The entity ID (lazy hash, numbered, or resolved from name)
   * @param encodedBoard The board data
   * @param encodedSignature The signatures
   * @return votingResult Success ratio (0 = invalid)
   */
  function isValidSignature(
    bytes32 _hash,
    bytes32 entityId,
    bytes calldata encodedBoard,
    bytes calldata encodedSignature
  ) external view returns (uint16) {
    bytes32 boardHash = keccak256(encodedBoard);
    
    if (entities[entityId].exists) {
      // REGISTERED ENTITY: use on-chain board
      require(boardHash == entities[entityId].currentBoardHash, "Board hash mismatch");
    } else {
      // LAZY ENTITY: entityId must equal boardHash
      require(entityId == boardHash, "Lazy entity: ID must equal board hash");
    }
    
    return _verifyBoard(_hash, encodedBoard, encodedSignature);
  }

  /**
   * @notice Simplified board verification
   */
  function _verifyBoard(
    bytes32 _hash,
    bytes calldata encodedBoard,
    bytes calldata encodedSignature
  ) internal pure returns (uint16) {
    Board memory board = abi.decode(encodedBoard, (Board));
    bytes[] memory signatures = abi.decode(encodedSignature, (bytes[]));
    
    uint16 voteYes = 0;
    uint16 totalVotes = 0;
    
    for (uint i = 0; i < board.delegates.length && i < signatures.length; i++) {
      Delegate memory delegate = board.delegates[i];
      
      if (delegate.entityId.length == 20) {
        // Simple EOA verification
        address signer = address(uint160(uint256(bytes32(delegate.entityId))));
        if (signer == _recoverSigner(_hash, signatures[i])) {
          voteYes += delegate.votingPower;
        }
        totalVotes += delegate.votingPower;
      }
      // Note: Nested entity verification removed for simplicity
    }
    
    if (totalVotes == 0) return 0;
    if (voteYes < board.votingThreshold) return 0;
    
    return (voteYes * 100) / totalVotes;
  }

  /**
   * @notice Recover signer from signature
   */
  function _recoverSigner(bytes32 _hash, bytes memory _signature) internal pure returns (address) {
    if (_signature.length != 65) return address(0);
    
    bytes32 r;
    bytes32 s;
    uint8 v;
    
    assembly {
      r := mload(add(_signature, 32))
      s := mload(add(_signature, 64))
      v := byte(0, mload(add(_signature, 96)))
    }
    
    if (v < 27) v += 27;
    if (v != 27 && v != 28) return address(0);
    
    return ecrecover(_hash, v, r, s);
  }

  // Utility functions
  function resolveEntityId(string memory identifier) external view returns (bytes32) {
    // Try to resolve as name first
    uint256 number = nameToNumber[identifier];
    if (number > 0) {
      return bytes32(number);
    }
    
    // Try to parse as number
    // Note: This would need a string-to-uint parser in practice
    return bytes32(0);
  }

  function getEntityInfo(bytes32 entityId) external view returns (
    bool exists,
    bytes32 currentBoardHash,
    bytes32 proposedBoardHash,
    uint256 registrationBlock,
    string memory name
  ) {
    Entity memory entity = entities[entityId];
    exists = entity.exists;
    currentBoardHash = entity.currentBoardHash;
    proposedBoardHash = entity.proposedAuthenticatorHash;
    registrationBlock = entity.registrationBlock;
    
    // Get name if it's a numbered entity
    if (uint256(entityId) > 0 && uint256(entityId) < nextNumber) {
      name = numberToName[uint256(entityId)];
    }
  }

  // Admin functions
  function setReservedName(string memory name, bool reserved) external onlyAdmin {
    reservedNames[name] = reserved;
  }

  function setNameQuota(address user, uint8 quota) external onlyAdmin {
    nameQuota[user] = quota;
  }

  function changeAdmin(address newAdmin) external onlyAdmin {
    admin = newAdmin;
  }
}