// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "./HankoEncoding.sol";

contract EntityProvider is ERC1155 { 
  error InvalidHankoWeight();
  error InvalidHankoThreshold();
  error DuplicateHankoSigner();
  error DuplicateHankoEntityIndex();
  error DuplicateHankoBoardMember();
  error DuplicateHankoClaimEntity();
  error DuplicateHankoPlaceholder();
  error InvalidHankoClaimOrder();
  error InvalidHankoClaimShape();
  error InvalidHankoFirstMember();
  error InvalidHankoPackedSignatureLength();
  error InvalidHankoPackedSignaturePadding();
  error NonCanonicalHankoPlaceholder();
  error UnusedHankoPlaceholder();
  error UnusedHankoSignature();
  error UnusedHankoClaim();
  error DuplicateShareSupporter();
  error ShareSupportersNotSorted();
  error InvalidShareSupportSignature();
  error ShareSupporterHasNoShares();
  error InvalidAuthorityAuthorization();
  error BoardProposalPriority();
  error CancellationPriority();
  error DividendAuthorityDisabled();
  error FoundationAuthorityDisabled();
  error InvalidHankoAuthorizationCount();
  error MissingShareSupport();
  error TooManyShareSupporters();
  error InsufficientShareSupport();

  struct EntityArticles {
    uint32 controlDelay;
    uint32 dividendDelay;
    uint32 foundationDelay;
  }

  struct Entity {
    bytes32 currentBoardHash;    // 0x0 = lazy entity (entityId == boardHash)
    bytes32 previousBoardHash;   // Immediate predecessor only
    uint256 previousBoardValidUntil; // Exclusive Unix-second Hanko deadline
    bytes32 proposedBoardHash;   // Pending board transition
    uint256 activateAtBlock;     // When proposed board becomes active
    uint256 registrationBlock;   // When entity was registered (0 for lazy)
    ProposerType proposerType;   // Who proposed the current transition
    EntityArticles articles;     // Immutable, packed into one storage slot
  }

  struct Board {
    uint16 votingThreshold;
    bytes32[] entityIds;        // Parallel arrays for efficiency
    uint16[] votingPowers;      // Must match entityIds length
    uint32 boardChangeDelay;    // Board → Board transitions (blocks)
    uint32 controlChangeDelay;  // Control → Board transitions (blocks)  
    uint32 dividendChangeDelay; // Dividend → Board transitions (blocks)
  }

  enum ProposerType { BOARD, CONTROL, DIVIDEND, FOUNDATION }
  enum EntityProviderActionKind { ENTITY_TRANSFER, RELEASE_CONTROL_SHARES }

  // Core entity storage - single mapping for all entities
  mapping(bytes32 => Entity) public entities;
  
  // Sequential numbering for registered entities
  uint256 public nextNumber = 1;
  mapping(bytes32 => uint256) public entityIdToNumber;
  

  
  // Name system (decoupled from entity IDs)
  mapping(string => uint256) public nameToNumber;  // "coinbase" => 42
  mapping(uint256 => string) public numberToName;  // 42 => "coinbase"
  mapping(string => bool) public reservedNames;    // Admin-controlled names
  
  // Foundation controls (no centralized admin)
  mapping(address => uint8) public nameQuota;      // User name allowances
  
  // Governance system
  mapping(bytes32 => uint256) public entityActionNonces;       // entity-authorized ERC1155 actions
  mapping(bytes32 => uint256) public boardActionNonces;        // board proposal/cancel replay fence
  mapping(bytes32 => uint256) public boardEpochs;              // increments only on BoardActivated
  
  // Fixed token supplies for all entities (immutable and fair)
  uint256 public constant TOTAL_CONTROL_SUPPLY = 100_000_000_000;
  uint256 public constant TOTAL_DIVIDEND_SUPPLY = 100_000_000_000;
  uint256 public constant BOARD_GRACE_PERIOD = 7 days;
  uint256 public constant MAX_SHARE_SUPPORTERS = 256;
  bytes32 public constant BOARD_PROPOSAL_DOMAIN = keccak256("XLN_ENTITY_PROVIDER_BOARD_PROPOSAL_V3");
  bytes32 public constant BOARD_PROPOSAL_CANCEL_DOMAIN = keccak256("XLN_ENTITY_PROVIDER_BOARD_PROPOSAL_CANCEL_V3");

  // Foundation entity (always #1)
  uint256 public constant FOUNDATION_ENTITY = 1;

  // Events
  event EntityRegistered(bytes32 indexed entityId, uint256 indexed entityNumber, bytes32 boardHash);
  event NameAssigned(string indexed name, uint256 indexed entityNumber);
  event NameTransferred(string indexed name, uint256 indexed fromNumber, uint256 indexed toNumber);
  event BoardProposed(
    bytes32 indexed entityId,
    bytes32 indexed proposedBoardHash,
    ProposerType authority,
    uint256 proposalNonce,
    uint256 activateAtBlock
  );
  event BoardActivated(
    bytes32 indexed entityId,
    bytes32 previousBoardHash,
    bytes32 newBoardHash,
    uint256 previousBoardValidUntil
  );
  event GovernanceEnabled(bytes32 indexed entityId, uint256 controlTokenId, uint256 dividendTokenId);
  event FoundationBootstrapped(
    address indexed recipient,
    bytes32 indexed boardHash,
    uint256 controlTokenId,
    uint256 dividendTokenId
  );
  event EntityProviderActionExecuted(
    bytes32 indexed entityId,
    uint256 indexed actionNonce,
    bytes32 indexed actionHash,
    EntityProviderActionKind actionKind
  );

  event EntityProviderActionCancelled(
    bytes32 indexed entityId,
    uint256 indexed actionNonce,
    bytes32 indexed cancelledActionHash,
    EntityProviderActionKind cancelledActionKind,
    bytes32 cancelHash
  );

  event ProposalCancelled(
    bytes32 indexed entityId,
    bytes32 indexed proposedBoardHash,
    ProposerType proposedBy,
    ProposerType cancelledBy,
    uint256 proposalNonce
  );

  function _asUint16Weight(uint256 value) internal pure returns (uint16) {
    if (value == 0 || value > type(uint16).max) revert InvalidHankoWeight();
    return uint16(value);
  }

  function _asUint16Threshold(uint256 value) internal pure returns (uint16) {
    if (value == 0 || value > type(uint16).max) revert InvalidHankoThreshold();
    return uint16(value);
  }

  function _singleSignerBoardHash(address signer) internal pure returns (bytes32) {
    bytes32[] memory entityIds = new bytes32[](1);
    entityIds[0] = bytes32(uint256(uint160(signer)));
    uint16[] memory votingPowers = new uint16[](1);
    votingPowers[0] = 1;
    return keccak256(abi.encode(Board({
      votingThreshold: 1,
      entityIds: entityIds,
      votingPowers: votingPowers,
      boardChangeDelay: 0,
      controlChangeDelay: 0,
      dividendChangeDelay: 0
    })));
  }

  constructor(address foundationRecipient) ERC1155("https://xln.com/entity/{id}.json") {
    require(foundationRecipient != address(0), "Invalid foundation recipient");

    // Reserve some premium names
    reservedNames["coinbase"] = true;
    reservedNames["ethereum"] = true;
    reservedNames["bitcoin"] = true;
    reservedNames["uniswap"] = true;

    // Create foundation entity #1 with governance
    bytes32 foundationQuorum = _singleSignerBoardHash(foundationRecipient);
    bytes32 foundationId = bytes32(FOUNDATION_ENTITY);

    entities[foundationId] = Entity({
      currentBoardHash: foundationQuorum,
      previousBoardHash: bytes32(0),
      previousBoardValidUntil: 0,
      proposedBoardHash: bytes32(0),
      activateAtBlock: 0,
      registrationBlock: block.number,
      proposerType: ProposerType.BOARD,
      articles: EntityArticles({
        controlDelay: 1000,
        dividendDelay: 3000,
        foundationDelay: 0 // Foundation can't replace itself
      })
    });
    entityIdToNumber[foundationId] = FOUNDATION_ENTITY;
    
    // Setup governance for foundation entity
    (uint256 controlTokenId, uint256 dividendTokenId) = getTokenIds(FOUNDATION_ENTITY);
    
    _mint(foundationRecipient, controlTokenId, TOTAL_CONTROL_SUPPLY, "");
    _mint(foundationRecipient, dividendTokenId, TOTAL_DIVIDEND_SUPPLY, "");

    emit GovernanceEnabled(foundationId, controlTokenId, dividendTokenId);
    emit FoundationBootstrapped(foundationRecipient, foundationQuorum, controlTokenId, dividendTokenId);
    
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
    require(boardHash != bytes32(0), "Invalid board hash");

    entityNumber = nextNumber++;
    bytes32 entityId = bytes32(entityNumber);

    // Create entity with default governance articles
    EntityArticles memory defaultArticles = EntityArticles({
      controlDelay: 1000,     // Default 1000 blocks for control
      dividendDelay: 3000,    // Default 3000 blocks for dividend
      foundationDelay: 10000  // Default 10000 blocks for foundation
    });

    entities[entityId] = Entity({
      currentBoardHash: boardHash,
      previousBoardHash: bytes32(0),
      previousBoardValidUntil: 0,
      proposedBoardHash: bytes32(0),
      activateAtBlock: 0,
      registrationBlock: block.number,
      proposerType: ProposerType.BOARD,
      articles: defaultArticles
    });

    // Automatically setup governance with fixed supply
    (uint256 controlTokenId, uint256 dividendTokenId) = getTokenIds(entityNumber);
    address entityAddress = address(uint160(uint256(entityId)));

    _mint(entityAddress, controlTokenId, TOTAL_CONTROL_SUPPLY, "");
    _mint(entityAddress, dividendTokenId, TOTAL_DIVIDEND_SUPPLY, "");

    entityIdToNumber[entityId] = entityNumber;

    emit EntityRegistered(entityId, entityNumber, boardHash);
    emit GovernanceEnabled(entityId, controlTokenId, dividendTokenId);

    return entityNumber;
  }

  /**
   * @notice Batch register multiple numbered entities in one transaction
   * @param boardHashes Array of board hashes for entities
   * @return entityNumbers Array of assigned entity numbers
   */
  function registerNumberedEntitiesBatch(bytes32[] calldata boardHashes) external returns (uint256[] memory entityNumbers) {
    entityNumbers = new uint256[](boardHashes.length);

    // Default governance articles (reused for all)
    EntityArticles memory defaultArticles = EntityArticles({
      controlDelay: 1000,
      dividendDelay: 3000,
      foundationDelay: 10000
    });
    for (uint256 i = 0; i < boardHashes.length; i++) {
      require(boardHashes[i] != bytes32(0), "Invalid board hash");

      uint256 entityNumber = nextNumber++;
      bytes32 entityId = bytes32(entityNumber);

      entities[entityId] = Entity({
        currentBoardHash: boardHashes[i],
        previousBoardHash: bytes32(0),
        previousBoardValidUntil: 0,
        proposedBoardHash: bytes32(0),
        activateAtBlock: 0,
        registrationBlock: block.number,
        proposerType: ProposerType.BOARD,
        articles: defaultArticles
      });

      // Setup governance
      (uint256 controlTokenId, uint256 dividendTokenId) = getTokenIds(entityNumber);
      address entityAddress = address(uint160(uint256(entityId)));

      _mint(entityAddress, controlTokenId, TOTAL_CONTROL_SUPPLY, "");
      _mint(entityAddress, dividendTokenId, TOTAL_DIVIDEND_SUPPLY, "");

      entityIdToNumber[entityId] = entityNumber;

      emit EntityRegistered(entityId, entityNumber, boardHashes[i]);
      emit GovernanceEnabled(entityId, controlTokenId, dividendTokenId);

      entityNumbers[i] = entityNumber;
    }

    return entityNumbers;
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

  function computeBoardProposalHash(
    bytes32 entityId,
    bytes32 newBoardHash,
    ProposerType authority,
    uint256 actionNonce
  ) public view returns (bytes32) {
    return keccak256(encodeBoardProposalHankoPayload(entityId, newBoardHash, authority, actionNonce));
  }

  function encodeBoardProposalHankoPayload(
    bytes32 entityId,
    bytes32 newBoardHash,
    ProposerType authority,
    uint256 actionNonce
  ) public view returns (bytes memory) {
    return HankoEncoding.encodeBoardProposal(
      BOARD_PROPOSAL_DOMAIN,
      block.chainid,
      address(this),
      entityId,
      boardEpochs[entityId],
      newBoardHash,
      uint8(authority),
      actionNonce
    );
  }

  function computeBoardProposalCancelHash(
    bytes32 entityId,
    bytes32 proposedBoardHash,
    ProposerType proposedBy,
    ProposerType cancelledBy,
    uint256 actionNonce
  ) public view returns (bytes32) {
    return keccak256(encodeBoardProposalCancelHankoPayload(
      entityId, proposedBoardHash, proposedBy, cancelledBy, actionNonce
    ));
  }

  function encodeBoardProposalCancelHankoPayload(
    bytes32 entityId,
    bytes32 proposedBoardHash,
    ProposerType proposedBy,
    ProposerType cancelledBy,
    uint256 actionNonce
  ) public view returns (bytes memory) {
    return HankoEncoding.encodeBoardProposalCancel(
      BOARD_PROPOSAL_CANCEL_DOMAIN,
      block.chainid,
      address(this),
      entityId,
      boardEpochs[entityId],
      proposedBoardHash,
      uint8(proposedBy),
      uint8(cancelledBy),
      actionNonce
    );
  }

  /**
   * @notice Propose a board replacement through one of the configured authority lanes.
   * @dev A pending proposal can only be replaced by a strictly higher authority:
   *      CONTROL > BOARD > DIVIDEND > FOUNDATION. Board Hankos are deliberately
   *      current-only; the seven-day previous-board grace applies to account
   *      finalization, never to creation of a new governance epoch.
   */
  function proposeBoard(
    bytes32 entityId, 
    bytes32 newBoardHash,
    ProposerType proposerType,
    bytes[] calldata authorizations
  ) external {
    require(entities[entityId].currentBoardHash != bytes32(0), "Entity doesn't exist");
    require(newBoardHash != bytes32(0), "Invalid board hash");
    require(newBoardHash != entities[entityId].currentBoardHash, "Board already active");
    Entity storage entity = entities[entityId];
    EntityArticles memory articles = entity.articles;
    _requireAuthorityEnabled(articles, proposerType);
    if (entity.proposedBoardHash != bytes32(0)) {
      if (!_hasHigherPriority(proposerType, entity.proposerType)) revert BoardProposalPriority();
    }

    uint256 actionNonce = boardActionNonces[entityId] + 1;
    bytes32 proposalHash = computeBoardProposalHash(entityId, newBoardHash, proposerType, actionNonce);
    _requireBoardAuthority(entityId, proposerType, proposalHash, authorizations);

    uint256 activateAtBlock = block.number + _authorityDelay(articles, proposerType);

    boardActionNonces[entityId] = actionNonce;
    entity.proposedBoardHash = newBoardHash;
    entity.activateAtBlock = activateAtBlock;
    entity.proposerType = proposerType;
    
    emit BoardProposed(entityId, newBoardHash, proposerType, actionNonce, activateAtBlock);
  }

  /**
   * @notice Activate a previously proposed board (with delay enforcement)
   * @param entityId The entity ID
   */
  function activateBoard(bytes32 entityId) external {
    require(entities[entityId].currentBoardHash != bytes32(0), "Entity doesn't exist");
    require(entities[entityId].proposedBoardHash != bytes32(0), "No proposed board");
    require(block.number >= entities[entityId].activateAtBlock, "Delay period not met");
    bytes32 proposedBoardHash = entities[entityId].proposedBoardHash;
    
    Entity storage entity = entities[entityId];
    bytes32 previousBoardHash = entity.currentBoardHash;
    uint256 previousBoardValidUntil = block.timestamp + BOARD_GRACE_PERIOD;
    entity.previousBoardHash = previousBoardHash;
    entity.previousBoardValidUntil = previousBoardValidUntil;
    entity.currentBoardHash = proposedBoardHash;
    boardEpochs[entityId] += 1;
    entity.proposedBoardHash = bytes32(0);
    entity.activateAtBlock = 0;

    emit BoardActivated(entityId, previousBoardHash, proposedBoardHash, previousBoardValidUntil);
  }

  /**
   * @notice Cancel a pending board proposal
   * @param entityId The entity ID
   * @param proposerType Who is cancelling (BOARD, CONTROL, DIVIDEND)
   * @param authorizations Authority-specific signatures or one Hanko
   */
  function cancelBoardProposal(
    bytes32 entityId,
    ProposerType proposerType,
    bytes[] calldata authorizations
  ) external {
    require(entities[entityId].currentBoardHash != bytes32(0), "Entity doesn't exist");
    require(entities[entityId].proposedBoardHash != bytes32(0), "No proposed board");
    Entity storage entity = entities[entityId];
    EntityArticles memory articles = entity.articles;
    ProposerType proposedBy = entity.proposerType;
    if (!_hasHigherPriority(proposerType, proposedBy)) revert CancellationPriority();
    _requireAuthorityEnabled(articles, proposerType);
    uint256 actionNonce = boardActionNonces[entityId];
    bytes32 cancelHash = computeBoardProposalCancelHash(
      entityId,
      entity.proposedBoardHash,
      proposedBy,
      proposerType,
      actionNonce
    );
    _requireBoardAuthority(entityId, proposerType, cancelHash, authorizations);

    bytes32 proposedBoardHash = entity.proposedBoardHash;
    entity.proposedBoardHash = bytes32(0);
    entity.activateAtBlock = 0;
    
    emit ProposalCancelled(entityId, proposedBoardHash, proposedBy, proposerType, actionNonce);
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
    if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
      return address(0);
    }
    
    return ecrecover(_hash, v, r, s);
  }

  /**
   * @notice Validate entity exists (registered or lazy)
   * @param entityId The entity ID to validate
   * @param boardHash The board hash for validation
   * @return isLazy Whether this is a lazy entity
   */
  function _validateEntity(bytes32 entityId, bytes32 boardHash) internal view returns (bool isLazy) {
    return _validateEntityBoard(entityId, boardHash, false);
  }

  function _validateEntityBoard(
    bytes32 entityId,
    bytes32 boardHash,
    bool currentOnly
  ) internal view returns (bool isLazy) {
    Entity storage entity = entities[entityId];
    bool isLazyEntity = entity.currentBoardHash == bytes32(0);

    if (isLazyEntity) {
      return entityId == boardHash;
    }
    if (boardHash == entity.currentBoardHash) return true;
    if (currentOnly) return false;
    return
      boardHash == entity.previousBoardHash &&
      boardHash != bytes32(0) &&
      block.timestamp < entity.previousBoardValidUntil;
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
  // Claims form one bottom-up authorization proof. EOA signatures are leaves;
  // each later claim may count only an earlier claim that already passed its
  // exact lazy/registered board binding and threshold. This permits recursive
  // Entity membership without allowing self/future references to bootstrap a
  // quorum. A configured board back-edge may still appear as a zero-power
  // placeholder when the remaining board members independently reach quorum.

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
    uint32 boardChangeDelay;   // Exact Board hash field
    uint32 controlChangeDelay; // Exact Board hash field
    uint32 dividendChangeDelay;// Exact Board hash field
  }
  
  // Events
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
    
    uint256 candidate = packedSignatures.length * 8 / 513;
    uint256 expectedLength = candidate * 64 + (candidate + 7) / 8;
    if (candidate == 0 || expectedLength != packedSignatures.length) {
      revert InvalidHankoPackedSignatureLength();
    }
    return candidate;
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
    uint256 usedBits = signatureCount % 8;
    if (usedBits != 0 && uint8(packedSignatures[packedSignatures.length - 1]) >> usedBits != 0) {
      revert InvalidHankoPackedSignaturePadding();
    }
    
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
   * @notice Build and hash a board from placeholders + signers using claim indexes
   * @dev Supports M-of-N: reconstructs full board from placeholders (non-signers) + signers
   * @param hanko The full hanko bytes (for placeholders access)
   * @param actualSigners Array of recovered signer addresses
   * @param claim The hanko claim with entityIndexes, weights and threshold
   * @return boardHash The keccak256 hash of the reconstructed board
   */
  function _buildBoardHash(
    HankoBytes memory hanko,
    address[] memory actualSigners,
    HankoClaim memory claim
  ) internal pure returns (bytes32 boardHash) {
    if (claim.entityIndexes.length == 0 || claim.entityIndexes.length != claim.weights.length) {
      revert InvalidHankoClaimShape();
    }

    uint256 boardSize = claim.entityIndexes.length;
    uint256 placeholderCount = hanko.placeholders.length;
    uint256 signerCount = actualSigners.length;

    // Build parallel arrays for Board struct
    bytes32[] memory entityIds = new bytes32[](boardSize);
    uint16[] memory votingPowers = new uint16[](boardSize);

    // HIERARCHICAL BOARD RECONSTRUCTION using entityIndexes mapping:
    // Index zones:
    //   0..placeholderCount-1 → placeholder (board member who didn't authorize)
    //   placeholderCount..placeholderCount+signerCount-1 → EOA signer (authorized)
    //   >= placeholderCount+signerCount → entity claim (authorized via nested hanko)
    for (uint256 i = 0; i < boardSize; i++) {
      uint256 idx = claim.entityIndexes[i];
      for (uint256 j = 0; j < i; j++) {
        if (claim.entityIndexes[j] == idx) revert DuplicateHankoEntityIndex();
      }

      if (idx < placeholderCount) {
        // Zone 1: Placeholder - board member who didn't authorize (EOA or entity)
        // Stored directly as bytes32 (address left-padded or entityId)
        entityIds[i] = hanko.placeholders[idx];
      } else if (idx < placeholderCount + signerCount) {
        // Zone 2: EOA signer - board member who signed with their private key
        // Convert recovered address to bytes32 (left-pad with zeros)
        uint256 signerIdx = idx - placeholderCount;
        entityIds[i] = bytes32(uint256(uint160(actualSigners[signerIdx])));
      } else {
        // Zone 3: Entity claim - board member who authorized via their own quorum
        // Use the entity's ID from their claim (nested hierarchical authorization)
        uint256 claimIdx = idx - placeholderCount - signerCount;
        require(claimIdx < hanko.claims.length, "Claim index out of bounds");
        entityIds[i] = hanko.claims[claimIdx].entityId;
      }

      // Index zero is the default proposer anchor. It must be a direct EOA
      // identity (signed or placeholder), never an Entity claim. A placeholder
      // may be unsigned when another branch independently reaches threshold.
      if (
        i == 0 &&
        (
          idx >= placeholderCount + signerCount ||
          entityIds[i] == bytes32(0) ||
          uint256(entityIds[i]) > type(uint160).max
        )
      ) revert InvalidHankoFirstMember();

      // A board member is one authority, regardless of whether the same ID was
      // supplied through two placeholders, two nested claims, or mixed zones.
      // Counting repeated member slots would let one authority multiply power.
      for (uint256 j = 0; j < i; j++) {
        if (entityIds[j] == entityIds[i]) revert DuplicateHankoBoardMember();
      }

      votingPowers[i] = _asUint16Weight(claim.weights[i]);
    }

    // Build Board struct with parallel arrays (transition delays set to 0 for compatibility)
    Board memory reconstructedBoard = Board({
      votingThreshold: _asUint16Threshold(claim.threshold),
      entityIds: entityIds,
      votingPowers: votingPowers,
      boardChangeDelay: claim.boardChangeDelay,
      controlChangeDelay: claim.controlChangeDelay,
      dividendChangeDelay: claim.dividendChangeDelay
    });

    // Hash the reconstructed board (same as entity registration)
    boardHash = keccak256(abi.encode(reconstructedBoard));

  }

  /* Hanko Signatures - Ephemeral Entity Registration
  From EntityProvider.sol this is actually revolutionary:
  struct HankoBytes {
    bytes32[] placeholders;    // Entities that didn't sign
    bytes packedSignatures;    // EOA sigs compressed (rsrsrs...vvv)
    HankoClaim[] claims;       // Nested entity proofs
  }

  What this enables:
  - Entities can be verified without pre-registration
  - Nested hierarchies (Corp A owns Corp B owns wallet C) - zero contract deployment
  - Recursive verification via claims
  - Packed signatures: N×64 bytes + ceil(N/8) bytes for V bits

  Why "first in history":
  - Multisigs require deployed contracts (Gnosis Safe, etc.)
  - Account abstraction requires pre-registration
  - Hanko: Pure cryptographic verification, ephemeral entities, hierarchical M-of-N

  Registered entities bind claims to their current board hash. Unregistered
  entities can still sign when their entity ID is the reconstructed board hash.
   */

  /**
   * @notice Verify an ordered recursive Hanko proof
   * @param hankoData ABI-encoded hanko bytes
   * @param hash The hash that was signed
   * @return entityId The verified entity (0 if invalid)
   * @return success Whether verification succeeded
   */
  function verifyHankoSignature(
    bytes calldata hankoData,
    bytes32 hash
  ) external view returns (bytes32 entityId, bool success) {
    return _verifyHankoSignature(hankoData, hash);
  }

  function _verifyHankoSignature(
    bytes calldata hankoData,
    bytes32 hash
  ) internal view returns (bytes32 entityId, bool success) {
    return _verifyHankoSignatureMode(hankoData, hash, false);
  }

  function _verifyCurrentHankoSignature(
    bytes calldata hankoData,
    bytes32 hash
  ) internal view returns (bytes32 entityId, bool success) {
    return _verifyHankoSignatureMode(hankoData, hash, true);
  }

  function _verifyHankoSignatureMode(
    bytes calldata hankoData,
    bytes32 hash,
    bool currentOnly
  ) internal view returns (bytes32 entityId, bool success) {
    HankoBytes memory hanko = abi.decode(hankoData, (HankoBytes));

    for (uint256 i = 0; i < hanko.placeholders.length; i++) {
      for (uint256 j = 0; j < i; j++) {
        if (hanko.placeholders[i] == hanko.placeholders[j]) revert DuplicateHankoPlaceholder();
      }
    }

    // Unpack signatures (with automatic count detection)
    bytes[] memory signatures = _unpackSignatures(hanko.packedSignatures);
    uint256 signatureCount = signatures.length;

    // Every valid proof bottoms out in an EOA signature. Nested Entity claims
    // can then build upward, but may reference only claims already verified.
    if (signatureCount == 0) {
      return (bytes32(0), false); // Reject hanko with no EOA signatures
    }
    
    // Calculate total entities for bounds checking
    uint256 totalEntities = hanko.placeholders.length + signatureCount + hanko.claims.length;
    
    // Recover EOA signers by original signature slot. Invalid signatures stay
    // as address(0), so a bad signature cannot shift later signers or earn votes.
    address[] memory actualSigners = new address[](signatureCount);
    for (uint256 i = 0; i < signatures.length; i++) {
      address signer = _recoverSigner(hash, signatures[i]);
      if (signer == address(0)) return (bytes32(0), false);
      for (uint256 j = 0; j < i; j++) {
        if (signer == actualSigners[j]) revert DuplicateHankoSigner();
      }
      actualSigners[i] = signer;
      bytes32 signerId = bytes32(uint256(uint160(signer)));
      for (uint256 j = 0; j < hanko.placeholders.length; j++) {
        if (hanko.placeholders[j] == signerId) revert NonCanonicalHankoPlaceholder();
      }
    }

    bool[] memory usedPlaceholders = new bool[](hanko.placeholders.length);
    bool[] memory usedSignatures = new bool[](signatureCount);
    
    for (uint256 claimIndex = 0; claimIndex < hanko.claims.length; claimIndex++) {
      HankoClaim memory claim = hanko.claims[claimIndex];
      uint256 placeholderCount = hanko.placeholders.length;

      for (uint256 priorClaimIndex = 0; priorClaimIndex < claimIndex; priorClaimIndex++) {
        if (hanko.claims[priorClaimIndex].entityId == claim.entityId) {
          revert DuplicateHankoClaimEntity();
        }
      }

      for (uint256 i = 0; i < claim.entityIndexes.length; i++) {
        uint256 entityIndex = claim.entityIndexes[i];
        require(entityIndex < totalEntities, "Entity index out of bounds");
        if (entityIndex < placeholderCount) {
          usedPlaceholders[entityIndex] = true;
          for (uint256 priorClaimIndex = 0; priorClaimIndex < claimIndex; priorClaimIndex++) {
            if (hanko.claims[priorClaimIndex].entityId == hanko.placeholders[entityIndex]) {
              revert NonCanonicalHankoPlaceholder();
            }
          }
        } else if (entityIndex < placeholderCount + signatureCount) {
          usedSignatures[entityIndex - placeholderCount] = true;
        } else if (entityIndex >= placeholderCount + signatureCount) {
          uint256 referencedClaimIndex = entityIndex - placeholderCount - signatureCount;
          if (referencedClaimIndex >= claimIndex) revert InvalidHankoClaimOrder();
        }
      }

      // Build board hash from placeholders + signers using entityIndexes mapping
      // Supports M-of-N: reconstructs full board even when not all members sign
      bytes32 reconstructedBoardHash = _buildBoardHash(hanko, actualSigners, claim);

      // Validate entity exists (registered or lazy) and verify board hash
      if (!_validateEntityBoard(claim.entityId, reconstructedBoardHash, currentOnly)) {
        return (bytes32(0), false);
      }

      uint256 totalVotingPower = 0;

      for (uint256 i = 0; i < claim.entityIndexes.length; i++) {
        uint256 entityIndex = claim.entityIndexes[i];

        // Bounds check
        require(entityIndex < totalEntities, "Entity index out of bounds");

        if (entityIndex < placeholderCount) {
          // Index 0..N-1: Placeholder (failed entity) - contributes 0 voting power
          continue;
        } else if (entityIndex < placeholderCount + signatureCount) {
          // Index N..M-1: EOA signature - verified, contributes full weight
          totalVotingPower += claim.weights[i];
        } else {
          // Index M..∞: an earlier claim which already passed board + quorum.
          uint256 referencedClaimIndex = entityIndex - placeholderCount - signatureCount;
          if (referencedClaimIndex >= claimIndex) revert InvalidHankoClaimOrder();
          totalVotingPower += claim.weights[i];
        }
      }

      if (totalVotingPower < claim.threshold) {
        return (bytes32(0), false);
      }
    }

    bool[] memory reachableClaims = new bool[](hanko.claims.length);
    if (hanko.claims.length > 0) reachableClaims[hanko.claims.length - 1] = true;
    for (uint256 cursor = hanko.claims.length; cursor > 0; cursor--) {
      uint256 claimIndex = cursor - 1;
      if (!reachableClaims[claimIndex]) continue;
      HankoClaim memory claim = hanko.claims[claimIndex];
      for (uint256 i = 0; i < claim.entityIndexes.length; i++) {
        uint256 entityIndex = claim.entityIndexes[i];
        if (entityIndex >= hanko.placeholders.length + signatureCount) {
          reachableClaims[entityIndex - hanko.placeholders.length - signatureCount] = true;
        }
      }
    }
    for (uint256 i = 0; i < reachableClaims.length; i++) {
      if (!reachableClaims[i]) revert UnusedHankoClaim();
    }
    for (uint256 i = 0; i < usedPlaceholders.length; i++) {
      if (!usedPlaceholders[i]) revert UnusedHankoPlaceholder();
    }
    for (uint256 i = 0; i < usedSignatures.length; i++) {
      if (!usedSignatures[i]) revert UnusedHankoSignature();
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
      (entityIds[i], results[i]) = _verifyHankoSignature(hankoDataArray[i], hashes[i]);
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

  function _requireStrictShareMajority(
    bytes32 entityId,
    bytes32 digest,
    bool control,
    bytes[] calldata signatures
  ) internal view {
    if (signatures.length == 0) revert MissingShareSupport();
    if (signatures.length > MAX_SHARE_SUPPORTERS) revert TooManyShareSupporters();
    (uint256 controlTokenId, uint256 dividendTokenId) = getTokenIds(uint256(entityId));
    uint256 tokenId = control ? controlTokenId : dividendTokenId;
    uint256 totalSupport = 0;
    address previousSigner = address(0);
    for (uint256 i = 0; i < signatures.length; i++) {
      address signer = _recoverSigner(digest, signatures[i]);
      if (signer == address(0)) revert InvalidShareSupportSignature();
      if (i > 0) {
        if (signer == previousSigner) revert DuplicateShareSupporter();
        if (signer < previousSigner) revert ShareSupportersNotSorted();
      }
      uint256 balance = balanceOf(signer, tokenId);
      if (balance == 0) revert ShareSupporterHasNoShares();
      totalSupport += balance;
      previousSigner = signer;
    }

    uint256 fixedSupply = control ? TOTAL_CONTROL_SUPPLY : TOTAL_DIVIDEND_SUPPLY;
    if (totalSupport <= fixedSupply / 2) revert InsufficientShareSupport();
  }

  function _requireBoardAuthority(
    bytes32 entityId,
    ProposerType authority,
    bytes32 digest,
    bytes[] calldata authorizations
  ) internal view {
    if (authority == ProposerType.CONTROL || authority == ProposerType.DIVIDEND) {
      _requireStrictShareMajority(entityId, digest, authority == ProposerType.CONTROL, authorizations);
      return;
    }

    if (authorizations.length != 1) revert InvalidHankoAuthorizationCount();
    bytes32 expectedEntityId = authority == ProposerType.BOARD
      ? entityId
      : bytes32(FOUNDATION_ENTITY);
    (bytes32 recoveredEntityId, bool valid) = _verifyCurrentHankoSignature(authorizations[0], digest);
    if (!valid || recoveredEntityId != expectedEntityId) revert InvalidAuthorityAuthorization();
  }

  function _requireAuthorityEnabled(
    EntityArticles memory articles,
    ProposerType authority
  ) internal pure {
    if (authority == ProposerType.DIVIDEND) {
      if (articles.dividendDelay == 0) revert DividendAuthorityDisabled();
    } else if (authority == ProposerType.FOUNDATION) {
      if (articles.foundationDelay == 0) revert FoundationAuthorityDisabled();
    }
  }

  function _authorityDelay(
    EntityArticles memory articles,
    ProposerType authority
  ) internal pure returns (uint32) {
    if (authority == ProposerType.DIVIDEND) return articles.dividendDelay;
    if (authority == ProposerType.FOUNDATION) return articles.foundationDelay;
    return articles.controlDelay;
  }

  function _hasHigherPriority(
    ProposerType challenger,
    ProposerType incumbent
  ) internal pure returns (bool) {
    return _authorityPriority(challenger) > _authorityPriority(incumbent);
  }

  function _authorityPriority(ProposerType authority) internal pure returns (uint8) {
    if (authority == ProposerType.CONTROL) return 4;
    if (authority == ProposerType.BOARD) return 3;
    if (authority == ProposerType.DIVIDEND) return 2;
    return 1;
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
    bool exists = entities[entityId].currentBoardHash != bytes32(0);
    controlSupply = exists ? TOTAL_CONTROL_SUPPLY : 0;
    dividendSupply = exists ? TOTAL_DIVIDEND_SUPPLY : 0;
    hasActiveProposal = entities[entityId].proposedBoardHash != bytes32(0);
    articlesHash = keccak256(abi.encode(entities[entityId].articles));
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
    require(boardHash != bytes32(0), "Invalid board hash");

    entityNumber = nextNumber++;
    bytes32 entityId = bytes32(entityNumber);
    
    entities[entityId] = Entity({
      currentBoardHash: boardHash,
      previousBoardHash: bytes32(0),
      previousBoardValidUntil: 0,
      proposedBoardHash: bytes32(0),
      activateAtBlock: 0,
      registrationBlock: block.number,
      proposerType: ProposerType.BOARD,
      articles: articles
    });
    
    // Automatically setup governance with fixed supply
    (uint256 controlTokenId, uint256 dividendTokenId) = getTokenIds(entityNumber);
    address entityAddress = address(uint160(uint256(entityId)));
    
    _mint(entityAddress, controlTokenId, TOTAL_CONTROL_SUPPLY, "");
    _mint(entityAddress, dividendTokenId, TOTAL_DIVIDEND_SUPPLY, "");

    entityIdToNumber[entityId] = entityNumber;
    
    emit EntityRegistered(entityId, entityNumber, boardHash);
    emit GovernanceEnabled(entityId, controlTokenId, dividendTokenId);
    
    return entityNumber;
  }

  // === ENTITY HANKO ACTIONS ===

  // The contract domain is always derived locally. Never accept chainId or the
  // EntityProvider address as calldata: deterministic deployments may reuse an
  // address on another chain, and signatures must not cross either boundary.
  function encodeEntityTransferHankoPayload(
    uint256 entityNumber,
    address to,
    uint256 tokenId,
    uint256 amount,
    uint256 actionNonce
  ) public view returns (bytes memory) {
    return HankoEncoding.encodeEntityTransfer(
      block.chainid,
      address(this),
      entityNumber,
      boardEpochs[bytes32(entityNumber)],
      to,
      tokenId,
      amount,
      actionNonce
    );
  }

  function computeEntityTransferHankoHash(
    uint256 entityNumber,
    address to,
    uint256 tokenId,
    uint256 amount,
    uint256 actionNonce
  ) public view returns (bytes32) {
    return keccak256(encodeEntityTransferHankoPayload(
      entityNumber,
      to,
      tokenId,
      amount,
      actionNonce
    ));
  }

  /**
   * @notice Transfer tokens from entity using hanko signature authorization
   * @param entityNumber The entity number
   * @param to Recipient address  
   * @param tokenId Token ID (control or dividend)
   * @param amount Amount to transfer
   * @param hankoData Canonical entity quorum Hanko authorizing this transfer
   */
  function entityTransferTokens(
    uint256 entityNumber,
    address to,
    uint256 tokenId,
    uint256 amount,
    bytes calldata hankoData
  ) external {
    bytes32 entityId = bytes32(entityNumber);
    uint256 actionNonce = entityActionNonces[entityId] + 1;

    bytes32 transferHash = computeEntityTransferHankoHash(
      entityNumber,
      to,
      tokenId,
      amount,
      actionNonce
    );
    
    (bytes32 recoveredEntityId, bool valid) = _verifyCurrentHankoSignature(hankoData, transferHash);
    require(valid && recoveredEntityId == entityId, "Invalid entity signature");
    entityActionNonces[entityId] = actionNonce;
    
    // Execute transfer
    address entityAddress = address(uint160(uint256(entityId)));
    _safeTransferFrom(entityAddress, to, tokenId, amount, "");
    emit EntityProviderActionExecuted(
      entityId,
      actionNonce,
      transferHash,
      EntityProviderActionKind.ENTITY_TRANSFER
    );
  }

  // === CONTROL SHARES RELEASE TO DEPOSITORY ===

  event ControlSharesReleased(
    bytes32 indexed entityId, 
    address indexed depository, 
    uint256 controlAmount, 
    uint256 dividendAmount,
    string purpose
  );

  function encodeReleaseControlSharesHankoPayload(
    uint256 entityNumber,
    address depository,
    uint256 controlAmount,
    uint256 dividendAmount,
    string memory purpose,
    uint256 actionNonce
  ) public view returns (bytes memory) {
    return HankoEncoding.encodeReleaseControlShares(
      block.chainid,
      address(this),
      entityNumber,
      boardEpochs[bytes32(entityNumber)],
      depository,
      controlAmount,
      dividendAmount,
      purpose,
      actionNonce
    );
  }

  function computeReleaseControlSharesHankoHash(
    uint256 entityNumber,
    address depository,
    uint256 controlAmount,
    uint256 dividendAmount,
    string memory purpose,
    uint256 actionNonce
  ) public view returns (bytes32) {
    return keccak256(encodeReleaseControlSharesHankoPayload(
      entityNumber,
      depository,
      controlAmount,
      dividendAmount,
      purpose,
      actionNonce
    ));
  }

  function encodeCancelEntityProviderActionHankoPayload(
    uint256 entityNumber,
    uint256 actionNonce,
    bytes32 cancelledActionHash,
    EntityProviderActionKind cancelledActionKind
  ) public view returns (bytes memory) {
    return HankoEncoding.encodeCancelEntityProviderAction(
      block.chainid,
      address(this),
      entityNumber,
      boardEpochs[bytes32(entityNumber)],
      actionNonce,
      cancelledActionHash,
      uint8(cancelledActionKind)
    );
  }

  function computeCancelEntityProviderActionHankoHash(
    uint256 entityNumber,
    uint256 actionNonce,
    bytes32 cancelledActionHash,
    EntityProviderActionKind cancelledActionKind
  ) public view returns (bytes32) {
    return keccak256(encodeCancelEntityProviderActionHankoPayload(
      entityNumber,
      actionNonce,
      cancelledActionHash,
      cancelledActionKind
    ));
  }

  /**
   * @notice Consume the next EntityProvider action nonce without executing its action.
   * @dev Execute and cancel share one nonce lane. The first mined transaction wins;
   *      the other Hanko becomes invalid because its payload commits the old nonce.
   */
  function cancelEntityProviderAction(
    uint256 entityNumber,
    bytes32 cancelledActionHash,
    EntityProviderActionKind cancelledActionKind,
    bytes calldata hankoData
  ) external {
    require(cancelledActionHash != bytes32(0), "Invalid action hash");
    bytes32 entityId = bytes32(entityNumber);
    uint256 actionNonce = entityActionNonces[entityId] + 1;
    bytes32 cancelHash = computeCancelEntityProviderActionHankoHash(
      entityNumber,
      actionNonce,
      cancelledActionHash,
      cancelledActionKind
    );
    (bytes32 recoveredEntityId, bool valid) = _verifyCurrentHankoSignature(hankoData, cancelHash);
    require(valid && recoveredEntityId == entityId, "Invalid entity signature");
    entityActionNonces[entityId] = actionNonce;
    emit EntityProviderActionCancelled(
      entityId,
      actionNonce,
      cancelledActionHash,
      cancelledActionKind,
      cancelHash
    );
  }

  /**
   * @notice Release entity's control and/or dividend shares to depository for trading
   * @dev This mirrors real corporate stock issuance - entity manages its own share releases
   * @param entityNumber The entity number
   * @param depository Depository contract address to receive the shares
   * @param controlAmount Amount of control tokens to release (0 to skip)
   * @param dividendAmount Amount of dividend tokens to release (0 to skip) 
   * @param purpose Human-readable purpose (e.g., "Series A", "Employee Pool", "Public Sale")
   * @param hankoData Canonical entity quorum Hanko authorizing this release
   */
  function releaseControlShares(
    uint256 entityNumber,
    address depository,
    uint256 controlAmount,
    uint256 dividendAmount,
    string calldata purpose,
    bytes calldata hankoData
  ) external {
    require(depository != address(0), "Invalid depository address");
    require(controlAmount > 0 || dividendAmount > 0, "Must release some tokens");
    
    bytes32 entityId = bytes32(entityNumber);
    require(entities[entityId].currentBoardHash != bytes32(0), "Entity doesn't exist");
    uint256 actionNonce = entityActionNonces[entityId] + 1;
    
    bytes32 releaseHash = computeReleaseControlSharesHankoHash(
      entityNumber,
      depository,
      controlAmount,
      dividendAmount,
      purpose,
      actionNonce
    );
    
    (bytes32 recoveredEntityId, bool valid) = _verifyCurrentHankoSignature(hankoData, releaseHash);
    require(valid && recoveredEntityId == entityId, "Invalid entity signature");
    entityActionNonces[entityId] = actionNonce;
    
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
    emit EntityProviderActionExecuted(
      entityId,
      actionNonce,
      releaseHash,
      EntityProviderActionKind.RELEASE_CONTROL_SHARES
    );
  }

}
