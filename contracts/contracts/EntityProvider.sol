// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "./Token.sol";
import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "./ECDSA.sol";

contract EntityProvider is ERC1155 { 
  struct Entity {
    bytes32 currentBoardHash;    // 0x0 = lazy entity (entityId == boardHash)
    bytes32 proposedBoardHash;   // Pending board transition
    uint256 activateAtBlock;     // When proposed board becomes active
    uint256 registrationBlock;   // When entity was registered (0 for lazy)
    ProposerType proposerType;   // Who proposed the current transition
    bytes32 articlesHash;        // Governance config hash
  }

  struct Board {
    uint16 votingThreshold;
    bytes32[] entityIds;        // Parallel arrays for efficiency
    uint16[] votingPowers;      // Must match entityIds length
    uint32 boardChangeDelay;    // Board → Board transitions (blocks)
    uint32 controlChangeDelay;  // Control → Board transitions (blocks)  
    uint32 dividendChangeDelay; // Dividend → Board transitions (blocks)
  }

  struct EntityArticles {
    uint32 controlDelay;      // Delay for control shareholders (X blocks)
    uint32 dividendDelay;     // Delay for dividend shareholders (X*3 blocks)  
    uint32 foundationDelay;   // Delay for foundation (X*10 blocks, 0=disabled)
    uint16 controlThreshold;  // % of control tokens needed for quorum replacement
  }

  enum ProposerType { BOARD, CONTROL, DIVIDEND }

  struct BoardProposal {
    bytes32 proposedBoardHash;
    ProposerType proposerType;
    uint256 proposeBlock;
    uint256 activateBlock;
    bool active;
  }

  // Core entity storage - single mapping for all entities
  mapping(bytes32 => Entity) public entities;
  
  // Sequential numbering for registered entities
  uint256 public nextNumber = 1;
  

  
  // Name system (decoupled from entity IDs)
  mapping(string => uint256) public nameToNumber;  // "coinbase" => 42
  mapping(uint256 => string) public numberToName;  // 42 => "coinbase"
  mapping(string => bool) public reservedNames;    // Admin-controlled names
  
  // Foundation controls (no centralized admin)
  mapping(address => uint8) public nameQuota;      // User name allowances
  
  // Governance system
  mapping(bytes32 => BoardProposal) public activeProposals;  // entityId => proposal
  mapping(bytes32 => uint256) public totalControlSupply;      // entityId => total control tokens
  mapping(bytes32 => uint256) public totalDividendSupply;     // entityId => total dividend tokens
  
  // Fixed token supplies for all entities (immutable and fair)
  uint256 public constant TOTAL_CONTROL_SUPPLY = 1e15;   // 1 quadrillion (max granularity)
  uint256 public constant TOTAL_DIVIDEND_SUPPLY = 1e15;  // 1 quadrillion (max granularity)

  // Foundation entity (always #1)
  uint256 public constant FOUNDATION_ENTITY = 1;

  // Events
  event EntityRegistered(bytes32 indexed entityId, uint256 indexed entityNumber, bytes32 boardHash);
  event NameAssigned(string indexed name, uint256 indexed entityNumber);
  event NameTransferred(string indexed name, uint256 indexed fromNumber, uint256 indexed toNumber);
  event BoardProposed(bytes32 indexed entityId, bytes32 proposedBoardHash);
  event BoardActivated(bytes32 indexed entityId, bytes32 newBoardHash);
  event GovernanceEnabled(bytes32 indexed entityId, uint256 controlTokenId, uint256 dividendTokenId);
  event ProposalCancelled(bytes32 indexed entityId, ProposerType cancelledBy);

  constructor() ERC1155("https://xln.com/entity/{id}.json") {
    // Reserve some premium names
    reservedNames["coinbase"] = true;
    reservedNames["ethereum"] = true;
    reservedNames["bitcoin"] = true;
    reservedNames["uniswap"] = true;
    
    // Create foundation entity #1 with governance
    bytes32 foundationQuorum = keccak256("FOUNDATION_INITIAL_QUORUM");
    bytes32 foundationId = bytes32(FOUNDATION_ENTITY);
    
    entities[foundationId] = Entity({
      currentBoardHash: foundationQuorum,
      proposedBoardHash: bytes32(0),
      activateAtBlock: 0,
      registrationBlock: block.number,
      proposerType: ProposerType.BOARD,
      articlesHash: keccak256(abi.encode(EntityArticles({
        controlDelay: 1000,
        dividendDelay: 3000,
        foundationDelay: 0, // Foundation can't replace itself
        controlThreshold: 51
      })))
    });
    
    // Setup governance for foundation entity
    (uint256 controlTokenId, uint256 dividendTokenId) = getTokenIds(FOUNDATION_ENTITY);
    address foundationAddress = address(uint160(uint256(foundationId)));
    
    _mint(foundationAddress, controlTokenId, TOTAL_CONTROL_SUPPLY, "");
    _mint(foundationAddress, dividendTokenId, TOTAL_DIVIDEND_SUPPLY, "");
    
    totalControlSupply[foundationId] = TOTAL_CONTROL_SUPPLY;
    totalDividendSupply[foundationId] = TOTAL_DIVIDEND_SUPPLY;
    
    emit GovernanceEnabled(foundationId, controlTokenId, dividendTokenId);
    
    nextNumber = 2; // Foundation takes #1, next entity will be #2
  }

  modifier onlyFoundation() {
    // Only foundation entity (via its governance tokens) can call admin functions
    bytes32 foundationId = bytes32(FOUNDATION_ENTITY);
    (uint256 controlTokenId,) = getTokenIds(FOUNDATION_ENTITY);
    require(balanceOf(msg.sender, controlTokenId) > 0, "Only foundation token holders");
    _;
  }

  /**
   * @notice Register a new numbered entity with automatic governance setup
   * @param boardHash Initial board/quorum hash
   * @return entityNumber The assigned entity number
   */
  function registerNumberedEntity(bytes32 boardHash) external returns (uint256 entityNumber) {
    entityNumber = nextNumber++;
    bytes32 entityId = bytes32(entityNumber);
    
    // Create entity with default governance articles
    EntityArticles memory defaultArticles = EntityArticles({
      controlDelay: 1000,     // Default 1000 blocks for control
      dividendDelay: 3000,    // Default 3000 blocks for dividend  
      foundationDelay: 10000, // Default 10000 blocks for foundation
      controlThreshold: 51    // Default 51% threshold
    });
    
    entities[entityId] = Entity({
      currentBoardHash: boardHash,
      proposedBoardHash: bytes32(0),
      activateAtBlock: 0,
      registrationBlock: block.number,
      proposerType: ProposerType.BOARD,
      articlesHash: keccak256(abi.encode(defaultArticles))
    });
    
    // Automatically setup governance with fixed supply
    (uint256 controlTokenId, uint256 dividendTokenId) = getTokenIds(entityNumber);
    address entityAddress = address(uint160(uint256(entityId)));
    
    _mint(entityAddress, controlTokenId, TOTAL_CONTROL_SUPPLY, "");
    _mint(entityAddress, dividendTokenId, TOTAL_DIVIDEND_SUPPLY, "");
    
    totalControlSupply[entityId] = TOTAL_CONTROL_SUPPLY;
    totalDividendSupply[entityId] = TOTAL_DIVIDEND_SUPPLY;
    
    emit EntityRegistered(entityId, entityNumber, boardHash);
    emit GovernanceEnabled(entityId, controlTokenId, dividendTokenId);
    
    return entityNumber;
  }

  /**
   * @notice Foundation assigns a name to an existing numbered entity
   * @param name The name to assign (e.g., "coinbase")
   * @param entityNumber The entity number to assign the name to
   */
  function assignName(string memory name, uint256 entityNumber) external onlyFoundation {
    require(bytes(name).length > 0 && bytes(name).length <= 32, "Invalid name length");
    require(entities[bytes32(entityNumber)].currentBoardHash != bytes32(0), "Entity doesn't exist");
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
   * @notice Transfer a name from one entity to another (foundation only)
   * @param name The name to transfer
   * @param newEntityNumber The target entity number
   */
  function transferName(string memory name, uint256 newEntityNumber) external onlyFoundation {
    require(nameToNumber[name] != 0, "Name not assigned");
    require(entities[bytes32(newEntityNumber)].currentBoardHash != bytes32(0), "Target entity doesn't exist");
    
    uint256 oldEntityNumber = nameToNumber[name];
    
    // Clear old mapping
    delete numberToName[oldEntityNumber];
    
    // Set new mapping
    nameToNumber[name] = newEntityNumber;
    numberToName[newEntityNumber] = name;
    
    emit NameTransferred(name, oldEntityNumber, newEntityNumber);
  }

  /**
   * @notice Propose a new board with proper BCD governance
   * @param entityId The entity ID  
   * @param newBoardHash The proposed new board hash
   * @param proposerType Who is proposing (BOARD, CONTROL, DIVIDEND)
   * @param articles Current governance articles (for verification)
   */
  function proposeBoard(
    bytes32 entityId, 
    bytes32 newBoardHash,
    ProposerType proposerType,
    EntityArticles memory articles
  ) external {
    require(entities[entityId].currentBoardHash != bytes32(0), "Entity doesn't exist");
    require(keccak256(abi.encode(articles)) == entities[entityId].articlesHash, "Invalid articles");
    
    // Check permissions and delays
    uint32 delay = _getDelayForProposer(articles, proposerType);
    require(delay > 0, "Proposer type disabled");
    
    // Verify proposer has the right to propose based on type
    if (proposerType == ProposerType.CONTROL) {
      // Control holders can override any proposal
      // TODO: Verify msg.sender has control tokens
    } else if (proposerType == ProposerType.BOARD) {
      // Current board can propose (shortest delay)
      // TODO: Verify msg.sender is current board member
    } else if (proposerType == ProposerType.DIVIDEND) {
      // Dividend holders can propose (longest delay)
      // TODO: Verify msg.sender has dividend tokens
    }
    
    // Cancel any existing proposal that can be overridden
    if (entities[entityId].proposedBoardHash != bytes32(0)) {
      require(_canCancelProposal(proposerType, entities[entityId].proposerType), 
              "Cannot override existing proposal");
    }
    
    uint256 activateAtBlock = block.number + delay;
    
    entities[entityId].proposedBoardHash = newBoardHash;
    entities[entityId].activateAtBlock = activateAtBlock;
    entities[entityId].proposerType = proposerType;
    
    emit BoardProposed(entityId, newBoardHash);
  }

  /**
   * @notice Activate a previously proposed board (with delay enforcement)
   * @param entityId The entity ID
   */
  function activateBoard(bytes32 entityId) external {
    require(entities[entityId].currentBoardHash != bytes32(0), "Entity doesn't exist");
    require(entities[entityId].proposedBoardHash != bytes32(0), "No proposed board");
    require(block.number >= entities[entityId].activateAtBlock, "Delay period not met");
    
    entities[entityId].currentBoardHash = entities[entityId].proposedBoardHash;
    entities[entityId].proposedBoardHash = bytes32(0);
    entities[entityId].activateAtBlock = 0;
    
    emit BoardActivated(entityId, entities[entityId].currentBoardHash);
  }

  /**
   * @notice Cancel a pending board proposal
   * @param entityId The entity ID
   * @param proposerType Who is cancelling (BOARD, CONTROL, DIVIDEND)
   * @param articles Current governance articles (for verification)
   */
  function cancelBoardProposal(
    bytes32 entityId,
    ProposerType proposerType,
    EntityArticles memory articles
  ) external {
    require(entities[entityId].currentBoardHash != bytes32(0), "Entity doesn't exist");
    require(entities[entityId].proposedBoardHash != bytes32(0), "No proposed board");
    require(keccak256(abi.encode(articles)) == entities[entityId].articlesHash, "Invalid articles");
    
    // Check if this proposer type can cancel the existing proposal
    require(_canCancelProposal(proposerType, entities[entityId].proposerType), 
            "Cannot cancel this proposal");
    
    entities[entityId].proposedBoardHash = bytes32(0);
    entities[entityId].activateAtBlock = 0;
    
    emit ProposalCancelled(entityId, proposerType);
  }



  /**
   * @notice Recover entity ID from hanko signature (improved version of isValidSignature)
   * @param encodedBoard The entity's board data
   * @param encodedSignature The entity's signatures  
   * @param hash The hash that was signed
   * @return entityId The entity ID that signed this hash (0 if invalid)
   */
  function recoverEntity(
    bytes calldata encodedBoard, 
    bytes calldata encodedSignature, 
    bytes32 hash
  ) public view returns (uint256 entityId) {
    bytes32 boardHash = keccak256(encodedBoard);
    
    // First try to find registered entity with this board hash
    for (uint256 i = 1; i < nextNumber; i++) {
      bytes32 candidateEntityId = bytes32(i);
      if (entities[candidateEntityId].currentBoardHash != bytes32(0) && entities[candidateEntityId].currentBoardHash == boardHash) {
        // Verify signature for this registered entity
        uint16 boardResult = _verifyBoard(hash, encodedBoard, encodedSignature);
        if (boardResult > 0) {
          return i; // Return entity number
        }
      }
    }
    
    // If no registered entity found, try as lazy entity
    uint16 lazyResult = _verifyBoard(hash, encodedBoard, encodedSignature);
    if (lazyResult > 0) {
      return uint256(boardHash); // Return board hash as entity ID for lazy entities
    }
    
    return 0; // Invalid signature
  }

  /**
   * @notice Simplified board verification (calldata version)
   */
  function _verifyBoard(
    bytes32 _hash,
    bytes calldata encodedBoard,
    bytes calldata encodedSignature
  ) internal pure returns (uint16) {
    Board memory board = abi.decode(encodedBoard, (Board));
    bytes[] memory signatures = abi.decode(encodedSignature, (bytes[]));
    
    require(board.entityIds.length == board.votingPowers.length, "Board arrays length mismatch");
    
    uint16 voteYes = 0;
    uint16 totalVotes = 0;
    
    for (uint i = 0; i < board.entityIds.length && i < signatures.length; i++) {
      bytes32 entityId = board.entityIds[i];
      uint16 votingPower = board.votingPowers[i];
      
      // Check if this is an EOA (20 bytes when cast to address)
      if (uint256(entityId) <= type(uint160).max) {
        // Simple EOA verification
        address signer = address(uint160(uint256(entityId)));
        if (signer == _recoverSigner(_hash, signatures[i])) {
          voteYes += votingPower;
        }
        totalVotes += votingPower;
      }
      // Note: Nested entity verification handled by Hanko system
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

  /**
   * @notice Validate entity exists (registered or lazy)
   * @param entityId The entity ID to validate
   * @param boardHash The board hash for validation
   * @return isLazy Whether this is a lazy entity
   */
  function _validateEntity(bytes32 entityId, bytes32 boardHash) internal view returns (bool isLazy) {
    if (entities[entityId].currentBoardHash == bytes32(0)) {
      // Lazy entity: entityId must equal boardHash
      require(entityId == boardHash, "Lazy entity: ID must equal board hash");
      return true;
    } else {
      // Registered entity: use stored boardHash
      require(boardHash == entities[entityId].currentBoardHash, "Board hash mismatch");
      return false;
    }
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
    exists = entity.currentBoardHash != bytes32(0);
    currentBoardHash = entity.currentBoardHash;
    proposedBoardHash = entity.proposedBoardHash;
    registrationBlock = entity.registrationBlock;
    
    // Get name if it's a numbered entity
    if (uint256(entityId) > 0 && uint256(entityId) < nextNumber) {
      name = numberToName[uint256(entityId)];
    }
  }

  // Admin functions
  function setReservedName(string memory name, bool reserved) external onlyFoundation {
    reservedNames[name] = reserved;
  }

  // === HANKO SIGNATURE VERIFICATION ===
  //
  // 🚨 CRITICAL DESIGN PHILOSOPHY: "ASSUME YES" FLASHLOAN GOVERNANCE 🚨
  //
  // This system INTENTIONALLY allows entities to mutually validate without EOA signatures.
  // This is NOT a bug - it's a feature that enables flexible governance structures.
  //
  // EXAMPLE OF INTENTIONAL "LOOPHOLE":
  // EntityA (threshold: 1) references EntityB at weight 100
  // EntityB (threshold: 1) references EntityA at weight 100
  // → Both pass validation with ZERO EOA signatures!
  //
  // WHY THIS IS INTENDED:
  // 1. UI/Application layer enforces policies (e.g., "require at least 1 EOA")
  // 2. Protocol stays flexible for exotic governance structures
  // 3. Real entities will naturally include EOAs for practical control
  // 4. Alternative would require complex graph analysis → expensive + still gameable
  //
  // POLICY ENFORCEMENT BELONGS IN UI, NOT PROTOCOL!

  struct HankoBytes {
    bytes32[] placeholders;    // Entity IDs that failed to sign (index 0..N-1)  
    bytes packedSignatures;    // EOA signatures → yesEntities (index N..M-1)
    HankoClaim[] claims;       // Entity claims to verify (index M..∞)
  }

  struct HankoClaim {
    bytes32 entityId;          // Entity being verified
    uint256[] entityIndexes;   // Indexes into placeholders + yesEntities + claims arrays
    uint256[] weights;         // Voting weights for each entity  
    uint256 threshold;         // Required voting power
  }
  
  // Events
  event HankoVerified(bytes32 indexed entityId, bytes32 indexed hash);
  event HankoClaimProcessed(bytes32 indexed entityId, bool success, uint256 votingPower);

  /**
   * @notice Detect signature count from packed signatures length
   * @dev DESIGN CHOICE: Signature count embedded in byte length, not explicit field
   *      This eliminates potential attack vectors where count != actual signatures
   * 
   * @param packedSignatures Packed rsrsrs...vvv format
   * @return signatureCount Number of signatures in the packed data
   * 
   * EXAMPLES:
   * - 1 sig: 64 bytes (RS) + 1 byte (V) = 65 bytes total
   * - 2 sigs: 128 bytes (RS) + 1 byte (VV in bits) = 129 bytes total  
   * - 8 sigs: 512 bytes (RS) + 1 byte (8 V bits) = 513 bytes total
   * - 9 sigs: 576 bytes (RS) + 2 bytes (9 V bits) = 578 bytes total
   */
  function _detectSignatureCount(bytes memory packedSignatures) internal pure returns (uint256 signatureCount) {
    if (packedSignatures.length == 0) return 0;
    
    // Try different signature counts until we find the right one
    // Formula: length = count * 64 + ceil(count / 8)
    for (uint256 count = 1; count <= 16000; count++) {
      uint256 expectedRSBytes = count * 64;
      uint256 expectedVBytes = (count + 7) / 8; // Ceiling division
      uint256 expectedTotal = expectedRSBytes + expectedVBytes;
      
      if (packedSignatures.length == expectedTotal) {
        return count;
      }
      
      // Early exit if we've exceeded possible length
      if (expectedTotal > packedSignatures.length) {
        break;
      }
    }
    
    revert("Invalid packed signature length - cannot detect count");
  }

  /**
   * @notice Unpack signatures from packed format
   * @param packedSignatures Packed rsrsrs...vvv format
   * @return signatures Array of 65-byte signatures
   */
  function _unpackSignatures(
    bytes memory packedSignatures
  ) internal pure returns (bytes[] memory signatures) {
    uint256 signatureCount = _detectSignatureCount(packedSignatures);
    
    if (signatureCount == 0) {
      return new bytes[](0);
    }
    
    uint256 expectedRSBytes = signatureCount * 64;
    uint256 expectedVBytes = (signatureCount + 7) / 8; // Ceiling division
    
    signatures = new bytes[](signatureCount);
    
    for (uint256 i = 0; i < signatureCount; i++) {
      // Extract R and S (64 bytes)
      bytes memory rs = new bytes(64);
      for (uint256 j = 0; j < 64; j++) {
        rs[j] = packedSignatures[i * 64 + j];
      }
      
      // Extract V bit
      uint256 vByteIndex = expectedRSBytes + i / 8;
      uint256 vBitIndex = i % 8;
      uint8 vByte = uint8(packedSignatures[vByteIndex]);
      uint8 v = ((vByte >> vBitIndex) & 1) == 0 ? 27 : 28;
      
      // Combine into 65-byte signature
      signatures[i] = new bytes(65);
      for (uint256 j = 0; j < 64; j++) {
        signatures[i][j] = rs[j];
      }
      signatures[i][64] = bytes1(v);
    }
  }

  /**
   * @notice Build and hash a board from actual signers and claim data
   * @param actualSigners Array of recovered signer addresses
   * @param claim The hanko claim with weights and threshold
   * @return boardHash The keccak256 hash of the reconstructed board
   */
  function _buildBoardHash(
    address[] memory actualSigners,
    HankoClaim memory claim
  ) internal pure returns (bytes32 boardHash) {
    require(actualSigners.length == claim.weights.length, "Signers/weights length mismatch");
    
    // Build parallel arrays for Board struct
    bytes32[] memory entityIds = new bytes32[](actualSigners.length);
    uint16[] memory votingPowers = new uint16[](actualSigners.length);
    
    // Populate arrays with actual signers and their weights
    for (uint256 i = 0; i < actualSigners.length; i++) {
      entityIds[i] = bytes32(uint256(uint160(actualSigners[i]))); // Convert address to bytes32
      votingPowers[i] = uint16(claim.weights[i]);
    }
    
    // Build Board struct with parallel arrays (transition delays set to 0 for compatibility)
    Board memory reconstructedBoard = Board({
      votingThreshold: uint16(claim.threshold),
      entityIds: entityIds,
      votingPowers: votingPowers,
      boardChangeDelay: 0,      // Default delays for hanko verification
      controlChangeDelay: 0,
      dividendChangeDelay: 0
    });
    
    // Hash the reconstructed board (same as entity registration)
    boardHash = keccak256(abi.encode(reconstructedBoard));
  }

  /**
   * @notice Verify hanko signature with flashloan governance (optimistic verification)
   * @param hankoData ABI-encoded hanko bytes  
   * @param hash The hash that was signed
   * @return entityId The verified entity (0 if invalid)
   * @return success Whether verification succeeded
   */
  function verifyHankoSignature(
    bytes calldata hankoData,
    bytes32 hash
  ) external view returns (bytes32 entityId, bool success) {
    HankoBytes memory hanko = abi.decode(hankoData, (HankoBytes));
    
    // Unpack signatures (with automatic count detection)
    bytes[] memory signatures = _unpackSignatures(hanko.packedSignatures);
    uint256 signatureCount = signatures.length;
    
    // Calculate total entities for bounds checking
    uint256 totalEntities = hanko.placeholders.length + signatureCount + hanko.claims.length;
    
    // Recover EOA signers for quorum hash building
    address[] memory actualSigners = new address[](signatureCount);
    uint256 validSignerCount = 0;
    
    for (uint256 i = 0; i < signatures.length; i++) {
      if (signatures[i].length == 65) {
        address signer = _recoverSigner(hash, signatures[i]);
        if (signer != address(0)) {
          actualSigners[validSignerCount] = signer;
          validSignerCount++;
        }
      }
    }
    
    // Resize to valid signers only
    address[] memory validSigners = new address[](validSignerCount);
    for (uint256 i = 0; i < validSignerCount; i++) {
      validSigners[i] = actualSigners[i];
    }
    
    // 🔥 FLASHLOAN GOVERNANCE: The Heart of "Assume YES" Philosophy 🔥
    //
    // KEY INSIGHT: When processing claim X that references claim Y:
    // - We DON'T wait for Y to be verified first
    // - We OPTIMISTICALLY assume Y will say "YES" 
    // - If ANY claim fails its threshold → entire Hanko fails IMMEDIATELY
    //
    // CONCRETE EXAMPLE - Circular Reference:
    // Claim 0: EntityA needs EntityB (index 3) at weight 100, threshold 100
    // Claim 1: EntityB needs EntityA (index 2) at weight 100, threshold 100
    // 
    // Processing:
    // 1. Claim 0 processing: Assume EntityB=YES → 100 power ≥ 100 → CONTINUE
    // 2. Claim 1 processing: Assume EntityA=YES → 100 power ≥ 100 → CONTINUE
    // 3. All claims passed → Hanko succeeds!
    //
    // ⚡ OPTIMIZATION: Fail immediately on threshold failure - no need to store results!
    //
    // This is INTENDED BEHAVIOR enabling flexible governance!
    
    for (uint256 claimIndex = 0; claimIndex < hanko.claims.length; claimIndex++) {
      HankoClaim memory claim = hanko.claims[claimIndex];
      
      // Build board hash from actual signers
      bytes32 reconstructedBoardHash = _buildBoardHash(validSigners, claim);
      
      // Validate entity exists (registered or lazy) and verify board hash
      _validateEntity(claim.entityId, reconstructedBoardHash);
      
      // Validate structure
      require(
        claim.entityIndexes.length == claim.weights.length,
        "Claim indexes/weights length mismatch"
      );
      
      uint256 totalVotingPower = 0;
      
      // Calculate voting power with flashloan assumptions
      for (uint256 i = 0; i < claim.entityIndexes.length; i++) {
        uint256 entityIndex = claim.entityIndexes[i];
        
        // Bounds check
        require(entityIndex < totalEntities, "Entity index out of bounds");
        
        if (entityIndex < hanko.placeholders.length) {
          // Index 0..N-1: Placeholder (failed entity) - contributes 0 voting power
          continue;
        } else if (entityIndex < hanko.placeholders.length + signatureCount) {
          // Index N..M-1: EOA signature - verified, contributes full weight
          totalVotingPower += claim.weights[i];
        } else {
          // Index M..∞: Entity claim - ASSUME YES! (flashloan governance)
          uint256 referencedClaimIndex = entityIndex - hanko.placeholders.length - signatureCount;
          require(referencedClaimIndex < hanko.claims.length, "Referenced claim index out of bounds");
          
          // 🚨 CRITICAL: We ASSUME the referenced claim will pass (flashloan assumption)
          // This enables circular references to mutually validate.
          // If our assumption is wrong, THIS claim will fail its threshold check below.
          totalVotingPower += claim.weights[i];
        }
      }
      
      // 💥 IMMEDIATE FAILURE: Check threshold and fail right away if not met
      if (totalVotingPower < claim.threshold) {
        return (bytes32(0), false); // Immediate failure - no need to check other claims
      }
    }
    
    // All claims passed - return final entity
    if (hanko.claims.length > 0) {
      bytes32 targetEntity = hanko.claims[hanko.claims.length - 1].entityId;
      return (targetEntity, true);
    }
    
    return (bytes32(0), false);
  }

  /**
   * @notice Batch verify multiple hanko signatures
   * @param hankoDataArray Array of ABI-encoded hanko bytes
   * @param hashes Array of hashes that were signed
   * @return entityIds Array of verified entity IDs
   * @return results Array of success flags
   */
  function batchVerifyHankoSignatures(
    bytes[] calldata hankoDataArray,
    bytes32[] calldata hashes
  ) external view returns (bytes32[] memory entityIds, bool[] memory results) {
    require(hankoDataArray.length == hashes.length, "Array length mismatch");
    
    entityIds = new bytes32[](hankoDataArray.length);
    results = new bool[](hankoDataArray.length);
    
    for (uint256 i = 0; i < hankoDataArray.length; i++) {
      (entityIds[i], results[i]) = this.verifyHankoSignature(hankoDataArray[i], hashes[i]);
    }
  }



  function setNameQuota(address user, uint8 quota) external onlyFoundation {
    nameQuota[user] = quota;
  }

  // === GOVERNANCE FUNCTIONS ===

  /**
   * @notice Get token IDs for an entity (first bit determines control vs dividend)
   * @param entityNumber The entity number
   * @return controlTokenId Token ID for control tokens (original ID)
   * @return dividendTokenId Token ID for dividend tokens (first bit set)
   */
  function getTokenIds(uint256 entityNumber) public pure returns (uint256 controlTokenId, uint256 dividendTokenId) {
    controlTokenId = entityNumber;
    dividendTokenId = entityNumber | 0x8000000000000000000000000000000000000000000000000000000000000000;
  }

  /**
   * @notice Extract entity number from token ID
   * @param tokenId The token ID (control or dividend)
   * @return entityNumber The entity number
   */
  function getEntityFromToken(uint256 tokenId) public pure returns (uint256 entityNumber) {
    return tokenId & 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF;
  }







  // === INTERNAL HELPER FUNCTIONS ===

  function _getDelayForProposer(EntityArticles memory articles, ProposerType proposerType) internal pure returns (uint32) {
    if (proposerType == ProposerType.CONTROL) return articles.controlDelay;
    if (proposerType == ProposerType.DIVIDEND) return articles.dividendDelay;
    return 0; // BOARD has no delay
  }

  function _canCancelProposal(ProposerType canceller, ProposerType existing) internal pure returns (bool) {
    // Priority: CONTROL > BOARD > DIVIDEND (BCD model)
    if (canceller == ProposerType.CONTROL) return existing != ProposerType.CONTROL;
    if (canceller == ProposerType.BOARD) return existing == ProposerType.DIVIDEND;
    return false; // DIVIDEND cannot cancel anyone
  }

  function _validateControlProposer(bytes32 entityId, address proposer, EntityArticles memory articles) internal view {
    (uint256 controlTokenId,) = getTokenIds(uint256(entityId));
    uint256 proposerBalance = balanceOf(proposer, controlTokenId);
    require(proposerBalance > 0, "No control tokens");
    
    // Optional: require minimum percentage
    // uint256 required = (totalControlSupply[entityId] * articles.controlThreshold) / 10000;
    // require(proposerBalance >= required, "Insufficient control tokens");
  }

  function _validateDividendProposer(bytes32 entityId, address proposer) internal view {
    (, uint256 dividendTokenId) = getTokenIds(uint256(entityId));
    uint256 proposerBalance = balanceOf(proposer, dividendTokenId);
    require(proposerBalance > 0, "No dividend tokens");
  }

  function _validateControlSupport(bytes32 entityId, address[] memory supporters, EntityArticles memory articles) internal view {
    (uint256 controlTokenId,) = getTokenIds(uint256(entityId));
    
    uint256 totalSupport = 0;
    for (uint i = 0; i < supporters.length; i++) {
      totalSupport += balanceOf(supporters[i], controlTokenId);
    }
    
    uint256 required = (totalControlSupply[entityId] * articles.controlThreshold) / 100;
    require(totalSupport >= required, "Insufficient control support");
  }

  function _validateDividendSupport(bytes32 entityId, address[] memory supporters) internal view {
    (, uint256 dividendTokenId) = getTokenIds(uint256(entityId));
    
    uint256 totalSupport = 0;
    for (uint i = 0; i < supporters.length; i++) {
      totalSupport += balanceOf(supporters[i], dividendTokenId);
    }
    
    // Require majority of dividend tokens
    uint256 required = (totalDividendSupply[entityId] * 51) / 100;
    require(totalSupport >= required, "Insufficient dividend support");
  }

  // === VIEW FUNCTIONS ===

  /**
   * @notice Get governance info for an entity
   */
  function getGovernanceInfo(uint256 entityNumber) external view returns (
    uint256 controlTokenId,
    uint256 dividendTokenId,
    uint256 controlSupply,
    uint256 dividendSupply,
    bool hasActiveProposal,
    bytes32 articlesHash
  ) {
    bytes32 entityId = bytes32(entityNumber);
    (controlTokenId, dividendTokenId) = getTokenIds(entityNumber);
    controlSupply = totalControlSupply[entityId];
    dividendSupply = totalDividendSupply[entityId];
    hasActiveProposal = activeProposals[entityId].active;
    articlesHash = entities[entityId].articlesHash;
  }

  /**
   * @notice Override to track token supply changes
   */
  function _afterTokenTransfer(
    address operator,
    address from,
    address to,
    uint256[] memory ids,
    uint256[] memory amounts,
    bytes memory data
  ) internal {
    for (uint i = 0; i < ids.length; i++) {
      uint256 entityNumber = getEntityFromToken(ids[i]);
      bytes32 entityId = bytes32(entityNumber);
      
      if (entities[entityId].currentBoardHash != bytes32(0)) {
        (uint256 controlTokenId,) = getTokenIds(entityNumber);
        
        // Update total supply for control tokens
        if (ids[i] == controlTokenId) {
          if (from == address(0)) {
            // Mint
            totalControlSupply[entityId] += amounts[i];
          } else if (to == address(0)) {
            // Burn
            totalControlSupply[entityId] -= amounts[i];
          }
        } else {
          // Dividend token
          if (from == address(0)) {
            // Mint
            totalDividendSupply[entityId] += amounts[i];
          } else if (to == address(0)) {
            // Burn
            totalDividendSupply[entityId] -= amounts[i];
          }
        }
      }
    }
  }

  /**
   * @notice Foundation can create entity with custom governance articles
   * @param boardHash Initial board/quorum hash
   * @param articles Custom governance configuration
   * @return entityNumber The assigned entity number
   */
  function foundationRegisterEntity(
    bytes32 boardHash,
    EntityArticles memory articles
  ) external onlyFoundation returns (uint256 entityNumber) {
    entityNumber = nextNumber++;
    bytes32 entityId = bytes32(entityNumber);
    
    entities[entityId] = Entity({
      currentBoardHash: boardHash,
      proposedBoardHash: bytes32(0),
      activateAtBlock: 0,
      registrationBlock: block.number,
      proposerType: ProposerType.BOARD,
      articlesHash: keccak256(abi.encode(articles))
    });
    
    // Automatically setup governance with fixed supply
    (uint256 controlTokenId, uint256 dividendTokenId) = getTokenIds(entityNumber);
    address entityAddress = address(uint160(uint256(entityId)));
    
    _mint(entityAddress, controlTokenId, TOTAL_CONTROL_SUPPLY, "");
    _mint(entityAddress, dividendTokenId, TOTAL_DIVIDEND_SUPPLY, "");
    
    totalControlSupply[entityId] = TOTAL_CONTROL_SUPPLY;
    totalDividendSupply[entityId] = TOTAL_DIVIDEND_SUPPLY;
    
    emit EntityRegistered(entityId, entityNumber, boardHash);
    emit GovernanceEnabled(entityId, controlTokenId, dividendTokenId);
    
    return entityNumber;
  }

  // === ENTITY SIGNATURE RECOVERY ===

  /**
   * @notice Transfer tokens from entity using hanko signature authorization
   * @param entityNumber The entity number
   * @param to Recipient address  
   * @param tokenId Token ID (control or dividend)
   * @param amount Amount to transfer
   * @param encodedBoard Entity's board data
   * @param encodedSignature Entity's signatures authorizing this transfer
   */
  function entityTransferTokens(
    uint256 entityNumber,
    address to,
    uint256 tokenId,
    uint256 amount,
    bytes calldata encodedBoard,
    bytes calldata encodedSignature
  ) external {
    // Create transfer hash
    bytes32 transferHash = keccak256(abi.encodePacked(
      "ENTITY_TRANSFER",
      entityNumber,
      to,
      tokenId,
      amount,
      block.timestamp
    ));
    
    // Verify entity signature
    uint256 recoveredEntityId = recoverEntity(encodedBoard, encodedSignature, transferHash);
    require(recoveredEntityId == entityNumber, "Invalid entity signature");
    
    // Execute transfer
    address entityAddress = address(uint160(uint256(bytes32(entityNumber))));
    _safeTransferFrom(entityAddress, to, tokenId, amount, "");
  }

  // === CONTROL SHARES RELEASE TO DEPOSITORY ===

  event ControlSharesReleased(
    bytes32 indexed entityId, 
    address indexed depository, 
    uint256 controlAmount, 
    uint256 dividendAmount,
    string purpose
  );

  /**
   * @notice Release entity's control and/or dividend shares to depository for trading
   * @dev This mirrors real corporate stock issuance - entity manages its own share releases
   * @param entityNumber The entity number
   * @param depository Depository contract address to receive the shares
   * @param controlAmount Amount of control tokens to release (0 to skip)
   * @param dividendAmount Amount of dividend tokens to release (0 to skip) 
   * @param purpose Human-readable purpose (e.g., "Series A", "Employee Pool", "Public Sale")
   * @param encodedBoard Entity's board data
   * @param encodedSignature Entity's Hanko signatures authorizing this release
   */
  function releaseControlShares(
    uint256 entityNumber,
    address depository,
    uint256 controlAmount,
    uint256 dividendAmount,
    string calldata purpose,
    bytes calldata encodedBoard,
    bytes calldata encodedSignature
  ) external {
    require(depository != address(0), "Invalid depository address");
    require(controlAmount > 0 || dividendAmount > 0, "Must release some tokens");
    
    bytes32 entityId = bytes32(entityNumber);
    require(entities[entityId].currentBoardHash != bytes32(0), "Entity doesn't exist");
    
    // Create release authorization hash
    bytes32 releaseHash = keccak256(abi.encodePacked(
      "RELEASE_CONTROL_SHARES",
      entityNumber,
      depository,
      controlAmount,
      dividendAmount,
      keccak256(bytes(purpose)),
      block.timestamp
    ));
    
    // Verify entity signature authorization
    uint256 recoveredEntityId = recoverEntity(encodedBoard, encodedSignature, releaseHash);
    require(recoveredEntityId == entityNumber, "Invalid entity signature");
    
    address entityAddress = address(uint160(uint256(entityId)));
    (uint256 controlTokenId, uint256 dividendTokenId) = getTokenIds(entityNumber);
    
    // Transfer control tokens if requested
    if (controlAmount > 0) {
      require(balanceOf(entityAddress, controlTokenId) >= controlAmount, "Insufficient control tokens");
      _safeTransferFrom(entityAddress, depository, controlTokenId, controlAmount, 
        abi.encode("CONTROL_SHARE_RELEASE", purpose));
    }
    
    // Transfer dividend tokens if requested  
    if (dividendAmount > 0) {
      require(balanceOf(entityAddress, dividendTokenId) >= dividendAmount, "Insufficient dividend tokens");
      _safeTransferFrom(entityAddress, depository, dividendTokenId, dividendAmount,
        abi.encode("DIVIDEND_SHARE_RELEASE", purpose));
    }
    
    emit ControlSharesReleased(entityId, depository, controlAmount, dividendAmount, purpose);
  }

}