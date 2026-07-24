// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "./HankoEncoding.sol";
import "./EntityTypes.sol";
import "./HankoVerifier.sol";

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
  error HankoProofTooLarge();
  error MissingShareSupport();
  error TooManyShareSupporters();
  error InsufficientShareSupport();
  error InvalidFoundationAuthorization();
  error InvalidFoundationActionNonce();

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
  bytes32 public constant FOUNDATION_ACTION_DOMAIN = keccak256("XLN_ENTITY_PROVIDER_FOUNDATION_ACTION_V1");
  bytes32 public constant FOUNDATION_ASSIGN_NAME = keccak256("ASSIGN_NAME");
  bytes32 public constant FOUNDATION_TRANSFER_NAME = keccak256("TRANSFER_NAME");
  bytes32 public constant FOUNDATION_SET_RESERVED_NAME = keccak256("SET_RESERVED_NAME");
  bytes32 public constant FOUNDATION_SET_NAME_QUOTA = keccak256("SET_NAME_QUOTA");
  bytes32 public constant FOUNDATION_REGISTER_ENTITY = keccak256("REGISTER_ENTITY");

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
  event FoundationActionExecuted(
    bytes32 indexed actionType,
    uint256 indexed actionNonce,
    bytes32 indexed argumentsHash
  );

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

  function computeFoundationActionHash(
    bytes32 actionType,
    bytes32 argumentsHash,
    uint256 actionNonce
  ) public view returns (bytes32) {
    return keccak256(abi.encodePacked(
      FOUNDATION_ACTION_DOMAIN,
      block.chainid,
      address(this),
      actionType,
      argumentsHash,
      actionNonce
    ));
  }

  function _authorizeFoundation(
    bytes32 actionType,
    bytes32 argumentsHash,
    bytes calldata hankoData,
    uint256 actionNonce
  ) internal {
    bytes32 foundationId = bytes32(FOUNDATION_ENTITY);
    if (actionNonce != entityActionNonces[foundationId] + 1) revert InvalidFoundationActionNonce();
    bytes32 actionHash = computeFoundationActionHash(actionType, argumentsHash, actionNonce);
    (bytes32 recoveredEntityId, bool valid) = _verifyCurrentHankoSignature(hankoData, actionHash);
    if (!valid || recoveredEntityId != foundationId) revert InvalidFoundationAuthorization();
    entityActionNonces[foundationId] = actionNonce;
    emit FoundationActionExecuted(actionType, actionNonce, argumentsHash);
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
  function assignName(
    string calldata name,
    uint256 entityNumber,
    bytes calldata hankoData,
    uint256 actionNonce
  ) external {
    require(bytes(name).length > 0 && bytes(name).length <= 32, "Invalid name length");
    require(entities[bytes32(entityNumber)].currentBoardHash != bytes32(0), "Entity doesn't exist");
    require(nameToNumber[name] == 0, "Name already assigned");
    _authorizeFoundation(
      FOUNDATION_ASSIGN_NAME,
      keccak256(abi.encode(name, entityNumber)),
      hankoData,
      actionNonce
    );
    
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
  function transferName(
    string calldata name,
    uint256 newEntityNumber,
    bytes calldata hankoData,
    uint256 actionNonce
  ) external {
    require(nameToNumber[name] != 0, "Name not assigned");
    require(entities[bytes32(newEntityNumber)].currentBoardHash != bytes32(0), "Target entity doesn't exist");
    
    uint256 oldEntityNumber = nameToNumber[name];
    if (oldEntityNumber == newEntityNumber) return;
    _authorizeFoundation(
      FOUNDATION_TRANSFER_NAME,
      keccak256(abi.encode(name, newEntityNumber)),
      hankoData,
      actionNonce
    );

    string memory replacedName = numberToName[newEntityNumber];
    if (bytes(replacedName).length > 0) {
      delete nameToNumber[replacedName];
    }
    
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
  function setReservedName(
    string calldata name,
    bool reserved,
    bytes calldata hankoData,
    uint256 actionNonce
  ) external {
    _authorizeFoundation(
      FOUNDATION_SET_RESERVED_NAME,
      keccak256(abi.encode(name, reserved)),
      hankoData,
      actionNonce
    );
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
    return HankoVerifier.verify(entities, hankoData, hash, false);
  }

  function verifyCurrentHankoSignature(
    bytes calldata hankoData,
    bytes32 hash
  ) external view returns (bytes32 entityId, bool success) {
    return HankoVerifier.verify(entities, hankoData, hash, true);
  }

  function _verifyCurrentHankoSignature(
    bytes calldata hankoData,
    bytes32 hash
  ) internal view returns (bytes32 entityId, bool success) {
    return HankoVerifier.verify(entities, hankoData, hash, true);
  }

  function setNameQuota(
    address user,
    uint8 quota,
    bytes calldata hankoData,
    uint256 actionNonce
  ) external {
    _authorizeFoundation(
      FOUNDATION_SET_NAME_QUOTA,
      keccak256(abi.encode(user, quota)),
      hankoData,
      actionNonce
    );
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
    EntityArticles calldata articles,
    bytes calldata hankoData,
    uint256 actionNonce
  ) external returns (uint256 entityNumber) {
    require(boardHash != bytes32(0), "Invalid board hash");
    _authorizeFoundation(
      FOUNDATION_REGISTER_ENTITY,
      keccak256(abi.encode(boardHash, articles)),
      hankoData,
      actionNonce
    );

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
