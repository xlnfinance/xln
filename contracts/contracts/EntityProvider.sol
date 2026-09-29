// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "./HankoEncoding.sol";
import "./EntityTypes.sol";
import "./HankoVerifier.sol";
import "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import "./interfaces/IEntityShareDepository.sol";

contract EntityProvider is ERC1155 {
  using Checkpoints for Checkpoints.Trace208;

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
  error InvalidHankoMemberSignatures();
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
  error BoardGracePeriodActive();
  error ShareDepositoryAlreadyBound();
  error ShareDepositoryBindingInvalid();
  error ShareDepositoryRequired();
  error ShareDepositoryLimit();
  error InvalidBoard();
  error BoardNotCommitted();

  enum EntityProviderActionKind { ENTITY_TRANSFER, RELEASE_CONTROL_SHARES, WATCHTOWER_MIN_SEQUENCE }

  // Core entity storage - single mapping for all entities
  mapping(bytes32 => Entity) public entities;
  
  // Sequential numbering for registered entities
  uint256 public nextNumber = 1;
  // A numbered entity's id is bytes32(entityNumber); no reverse map is stored.

  // No name registry on chain: human names are a relay/UI concern (ENS-style
  // integrations can bind to entity numbers later without touching the root).

  // Governance system
  mapping(bytes32 => uint256) public entityActionNonces;       // entity-authorized ERC1155 actions
  mapping(bytes32 => uint256) public boardActionNonces;        // board proposal/cancel replay fence
  mapping(bytes32 => uint256) public boardEpochs;              // increments only on BoardActivated
  address public immutable foundationDeployer;
  // Append-only list of Depositories whose reserves carry CONTROL weight and
  // may receive released shares. The first entry is bound at deployment; later
  // entries are added by Foundation Hanko. Append-only cannot rug v1 weight,
  // and a listed Depository can never report more weight than the shares it
  // actually holds (see _requireReserveControlMajority).
  address[] private _shareDepositories;
  mapping(bytes32 => mapping(address => uint256)) private controlReserveTokenIds;
  // Watchtower appointment fence. Depository.watchtowerCounterDispute accepts
  // an owner appointment only if its appointmentSequence >= this minimum, so
  // an entity revokes every older tower appointment with one current-board
  // action instead of having to out-race a fired tower until T.
  mapping(bytes32 => uint256) public watchtowerMinSequence;
  // Board preimages that were validated on chain. proposeBoard accepts only
  // committed hashes so an unreachable threshold can never brick an entity.
  mapping(bytes32 => bool) public committedBoards;
  // DIVIDEND votes are read at (block.timestamp - 1): every transaction in a
  // block shares the timestamp, so a same-transaction flash borrow carries no
  // weight. Keyed by seconds like everything else in this system.
  mapping(uint256 => mapping(address => Checkpoints.Trace208)) private _dividendCheckpoints;
  
  // Fixed token supplies for all entities (immutable and fair)
  uint256 public constant TOTAL_CONTROL_SUPPLY = 100_000_000_000;
  uint256 public constant TOTAL_DIVIDEND_SUPPLY = 100_000_000_000;
  uint256 public constant BOARD_GRACE_PERIOD = 7 days;
  uint256 public constant MAX_SHARE_SUPPORTERS = 256;
  uint256 public constant MAX_SHARE_DEPOSITORIES = 8;
  uint256 public constant MAX_BOARD_MEMBERS = 256;
  bytes32 public constant BOARD_PROPOSAL_DOMAIN = keccak256("XLN_ENTITY_PROVIDER_BOARD_PROPOSAL_V1");
  bytes32 public constant BOARD_PROPOSAL_CANCEL_DOMAIN = keccak256("XLN_ENTITY_PROVIDER_BOARD_PROPOSAL_CANCEL_V1");
  bytes32 public constant FOUNDATION_ACTION_DOMAIN = keccak256("XLN_ENTITY_PROVIDER_FOUNDATION_ACTION_V1");
  bytes32 public constant FOUNDATION_REGISTER_ENTITY = keccak256("REGISTER_ENTITY");
  bytes32 public constant FOUNDATION_REGISTER_TOKEN = keccak256("REGISTER_EXTERNAL_TOKEN");
  bytes32 public constant FOUNDATION_ADD_SHARE_DEPOSITORY = keccak256("ADD_SHARE_DEPOSITORY");

  // Foundation entity (always #1)
  uint256 public constant FOUNDATION_ENTITY = 1;

  // Events
  event EntityRegistered(bytes32 indexed entityId, uint256 indexed entityNumber, bytes32 boardHash);
  event BoardProposed(
    bytes32 indexed entityId,
    bytes32 indexed proposedBoardHash,
    ProposerType authority,
    uint256 proposalNonce,
    uint256 activateAt
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
  event ShareDepositoryBound(address indexed depository);
  event BoardCommitted(bytes32 indexed boardHash);
  event ExternalTokenListed(
    address indexed depository,
    uint8 tokenType,
    address indexed contractAddress,
    uint256 externalTokenId,
    uint256 tokenId
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
    foundationDeployer = foundationRecipient;

    // Create foundation entity #1 with governance
    bytes32 foundationQuorum = _singleSignerBoardHash(foundationRecipient);
    bytes32 foundationId = bytes32(FOUNDATION_ENTITY);

    entities[foundationId] = Entity({
      currentBoardHash: foundationQuorum,
      previousBoardHash: bytes32(0),
      previousBoardValidUntil: 0,
      proposedBoardHash: bytes32(0),
      activateAt: 0,
      registrationBlock: block.number,
      proposerType: ProposerType.BOARD,
      previousBoardHash2: bytes32(0),
      previousBoardValidUntil2: 0,
      articles: EntityArticles({
        controlDelay: 1 days,
        dividendDelay: 3 days,
        foundationDelay: 0 // Foundation can't replace itself
      })
    });
    committedBoards[foundationQuorum] = true;
    // Foundation shares live in the Foundation treasury like every other
    // entity's, so releaseControlShares/entityTransferTokens work for #1 too.
    (uint256 controlTokenId, uint256 dividendTokenId) = getTokenIds(FOUNDATION_ENTITY);
    address foundationTreasury = entityTreasury(FOUNDATION_ENTITY);
    _mint(foundationTreasury, controlTokenId, TOTAL_CONTROL_SUPPLY, "");
    _mint(foundationTreasury, dividendTokenId, TOTAL_DIVIDEND_SUPPLY, "");

    emit GovernanceEnabled(foundationId, controlTokenId, dividendTokenId);
    emit FoundationBootstrapped(foundationRecipient, foundationQuorum, controlTokenId, dividendTokenId);
    
    nextNumber = 2; // Foundation takes #1, next entity will be #2
  }

  /** One-time stack binding; the Foundation deployment signer has no authority after it succeeds. */
  function bindShareDepository(address depository) external {
    if (msg.sender != foundationDeployer) revert ShareDepositoryBindingInvalid();
    if (_shareDepositories.length != 0) revert ShareDepositoryAlreadyBound();
    _addShareDepository(depository);
  }

  /// @notice Append a further Depository (e.g. a v2 court) to the CONTROL set.
  /// @dev Foundation Hanko, append-only, capped. Weight is bounded by shares the
  ///      Depository really holds, so listing a contract that holds nothing adds
  ///      no power; shareholders decide by depositing there.
  function foundationAddShareDepository(
    address depository,
    bytes calldata hankoData,
    uint256 actionNonce
  ) external {
    _authorizeFoundation(
      FOUNDATION_ADD_SHARE_DEPOSITORY,
      keccak256(abi.encode(depository)),
      hankoData,
      actionNonce
    );
    _addShareDepository(depository);
  }

  function _addShareDepository(address depository) private {
    if (depository.code.length == 0) revert ShareDepositoryBindingInvalid();
    if (IEntityShareDepository(depository).entityProvider() != address(this)) {
      revert ShareDepositoryBindingInvalid();
    }
    if (_shareDepositories.length >= MAX_SHARE_DEPOSITORIES) revert ShareDepositoryLimit();
    if (_isShareDepository(depository)) revert ShareDepositoryAlreadyBound();
    _shareDepositories.push(depository);
    emit ShareDepositoryBound(depository);
  }

  function _isShareDepository(address depository) private view returns (bool) {
    for (uint256 i = 0; i < _shareDepositories.length; i++) {
      if (_shareDepositories[i] == depository) return true;
    }
    return false;
  }

  /// @notice Primary (first-bound) share Depository; zero before binding.
  function shareDepository() external view returns (address) {
    return _shareDepositories.length == 0 ? address(0) : _shareDepositories[0];
  }

  function shareDepositories() external view returns (address[] memory) {
    return _shareDepositories;
  }

  /// @notice List an external token on a Depository of this stack.
  /// @dev Replaces the immutable deployer EOA as listing authority: a lost key
  ///      must not freeze listing forever, and a compromised one must not list a
  ///      trap token without the Foundation board. Any Depository built on this
  ///      EntityProvider may be targeted; the Depository itself only admits
  ///      calls from this contract.
  function foundationRegisterExternalToken(
    address depository,
    uint8 tokenType,
    address contractAddress,
    uint256 externalTokenId,
    bytes calldata hankoData,
    uint256 actionNonce
  ) external returns (uint256 tokenId) {
    _authorizeFoundation(
      FOUNDATION_REGISTER_TOKEN,
      keccak256(abi.encode(depository, tokenType, contractAddress, externalTokenId)),
      hankoData,
      actionNonce
    );
    if (depository.code.length == 0 || IEntityShareDepository(depository).entityProvider() != address(this)) {
      revert ShareDepositoryBindingInvalid();
    }
    tokenId = IEntityShareDepository(depository).registerExternalToken(tokenType, contractAddress, externalTokenId);
    emit ExternalTokenListed(depository, tokenType, contractAddress, externalTokenId, tokenId);
  }

  // ========== BOARD PREIMAGES ==========

  /// @notice Validate a board and record its hash as installable.
  /// @dev Permissionless. HankoVerifier checks member/weight/threshold ranges
  ///      at proof time but not reachability; a blind hash whose threshold
  ///      exceeds the weight sum would brick the entity at birth. Every ingress
  ///      (registration, proposal) goes through this predicate.
  function commitBoard(bytes calldata encodedBoard) external returns (bytes32 boardHash) {
    boardHash = _validatedBoardHash(encodedBoard);
  }

  function _validatedBoardHash(bytes calldata encodedBoard) private returns (bytes32 boardHash) {
    Board memory board = abi.decode(encodedBoard, (Board));
    _validateBoard(board);
    boardHash = keccak256(abi.encode(board));
    if (!committedBoards[boardHash]) {
      committedBoards[boardHash] = true;
      emit BoardCommitted(boardHash);
    }
  }

  /// @dev Mirrors HankoVerifier's per-claim rules plus reachability:
  ///      1..256 members, equal array lengths, nonzero unique ids, weights in
  ///      1..65535, threshold in 1..65535, first member address-shaped.
  ///      HankoVerifier lets member 0 vote only as a direct key (EOA signature
  ///      or ERC-1271 contract), never through a nested entity claim. A numbered
  ///      entity id is address-shaped but nobody holds its key, so if member 0
  ///      is an already-registered numbered entity its weight can never count;
  ///      reachability must then hold without it. A real key is a ~160-bit
  ///      random value and never falls below nextNumber.
  function _validateBoard(Board memory board) private view {
    uint256 members = board.entityIds.length;
    if (members == 0 || members > MAX_BOARD_MEMBERS || members != board.votingPowers.length) revert InvalidBoard();
    if (board.votingThreshold == 0) revert InvalidBoard();
    uint256 first = uint256(board.entityIds[0]);
    if (first == 0 || first > type(uint160).max) revert InvalidBoard();
    uint256 total;
    for (uint256 i = 0; i < members; i++) {
      bytes32 id = board.entityIds[i];
      if (id == bytes32(0) || board.votingPowers[i] == 0) revert InvalidBoard();
      for (uint256 j = 0; j < i; j++) {
        if (board.entityIds[j] == id) revert InvalidBoard();
      }
      if (i == 0 && first < nextNumber) continue; // numbered entity at slot 0 cannot sign
      total += board.votingPowers[i];
    }
    if (total < board.votingThreshold) revert InvalidBoard();
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

  function _defaultArticles() private pure returns (EntityArticles memory) {
    return EntityArticles({
      controlDelay: 1 days,
      dividendDelay: 3 days,
      foundationDelay: 10 days
    });
  }

  /**
   * @notice Register a new numbered entity with automatic governance setup
   * @param encodedBoard abi.encode(Board) of the initial board; validated on chain
   * @return entityNumber The assigned entity number
   */
  function registerNumberedEntity(bytes calldata encodedBoard) external returns (uint256 entityNumber) {
    return _registerEntity(_validatedBoardHash(encodedBoard), _defaultArticles());
  }

  /**
   * @notice Batch register multiple numbered entities in one transaction
   * @param encodedBoards abi.encode(Board) per entity; each validated on chain
   * @return entityNumbers Array of assigned entity numbers
   */
  function registerNumberedEntitiesBatch(bytes[] calldata encodedBoards) external returns (uint256[] memory entityNumbers) {
    entityNumbers = new uint256[](encodedBoards.length);
    EntityArticles memory defaultArticles = _defaultArticles();
    for (uint256 i = 0; i < encodedBoards.length; i++) {
      entityNumbers[i] = _registerEntity(_validatedBoardHash(encodedBoards[i]), defaultArticles);
    }
    return entityNumbers;
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
   *      CONTROL > BOARD > DIVIDEND > FOUNDATION. Equal-lane replacement was
   *      considered and rejected: a compromised board and its legitimate
   *      members hold the same keys and the same lane, so mutual replacement
   *      is an unbounded livelock. Strict priority terminates: the first
   *      proposal activates after its delay unless a higher lane cancels it.
   *      The new board hash must have been committed (validated preimage) or be
   *      one of this entity's retired boards. Board Hankos are deliberately
   *      current-only; the seven-day previous-board grace applies only to
   *      historical bilateral dispute proofs, including start/finalization,
   *      never to creation of a new governance epoch.
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
    if (
      !committedBoards[newBoardHash] &&
      newBoardHash != entity.previousBoardHash &&
      newBoardHash != entity.previousBoardHash2
    ) revert BoardNotCommitted();
    EntityArticles memory articles = entity.articles;
    _requireAuthorityEnabled(articles, proposerType);
    if (entity.proposedBoardHash != bytes32(0)) {
      if (!_hasHigherPriority(proposerType, entity.proposerType)) revert BoardProposalPriority();
    }

    uint256 actionNonce = boardActionNonces[entityId] + 1;
    bytes32 proposalHash = computeBoardProposalHash(entityId, newBoardHash, proposerType, actionNonce);
    _requireBoardAuthority(entityId, proposerType, proposalHash, authorizations);

    uint256 activateAt = block.timestamp + _authorityDelay(articles, proposerType);

    boardActionNonces[entityId] = actionNonce;
    entity.proposedBoardHash = newBoardHash;
    entity.activateAt = activateAt;
    entity.proposerType = proposerType;

    emit BoardProposed(entityId, newBoardHash, proposerType, actionNonce, activateAt);
  }

  /**
   * @notice Activate a previously proposed board (with delay enforcement)
   * @param entityId The entity ID
   */
  function activateBoard(bytes32 entityId) external {
    Entity storage entity = entities[entityId];
    require(entity.currentBoardHash != bytes32(0), "Entity doesn't exist");
    require(entity.proposedBoardHash != bytes32(0), "No proposed board");
    require(block.timestamp >= entity.activateAt, "Delay period not met");
    // Two historical boards can verify dispute evidence. Activation only waits
    // while BOTH retired slots are still inside their seven-day windows, so a
    // compromised current board can be replaced at once without revoking the
    // proof window promised to the board it displaced.
    if (block.timestamp < entity.previousBoardValidUntil2) revert BoardGracePeriodActive();
    bytes32 proposedBoardHash = entity.proposedBoardHash;
    bytes32 previousBoardHash = entity.currentBoardHash;
    uint256 previousBoardValidUntil = block.timestamp + BOARD_GRACE_PERIOD;
    entity.previousBoardHash2 = entity.previousBoardHash;
    entity.previousBoardValidUntil2 = entity.previousBoardValidUntil;
    entity.previousBoardHash = previousBoardHash;
    entity.previousBoardValidUntil = previousBoardValidUntil;
    entity.currentBoardHash = proposedBoardHash;
    boardEpochs[entityId] += 1;
    entity.proposedBoardHash = bytes32(0);
    entity.activateAt = 0;

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
    entity.activateAt = 0;

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
  function getEntityInfo(bytes32 entityId) external view returns (
    bool exists,
    bytes32 currentBoardHash,
    bytes32 proposedBoardHash,
    uint256 registrationBlock
  ) {
    Entity storage entity = entities[entityId];
    exists = entity.currentBoardHash != bytes32(0);
    currentBoardHash = entity.currentBoardHash;
    proposedBoardHash = entity.proposedBoardHash;
    registrationBlock = entity.registrationBlock;
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

  // === INTERNAL HELPER FUNCTIONS ===

  function _registerEntity(
    bytes32 boardHash,
    EntityArticles memory articles
  ) internal returns (uint256 entityNumber) {
    require(boardHash != bytes32(0), "Invalid board hash");
    entityNumber = nextNumber++;
    bytes32 entityId = bytes32(entityNumber);

    entities[entityId] = Entity({
      currentBoardHash: boardHash,
      previousBoardHash: bytes32(0),
      previousBoardValidUntil: 0,
      proposedBoardHash: bytes32(0),
      activateAt: 0,
      registrationBlock: block.number,
      proposerType: ProposerType.BOARD,
      articles: articles,
      previousBoardHash2: bytes32(0),
      previousBoardValidUntil2: 0
    });

    (uint256 controlTokenId, uint256 dividendTokenId) = getTokenIds(entityNumber);
    address treasury = entityTreasury(entityNumber);
    _mint(treasury, controlTokenId, TOTAL_CONTROL_SUPPLY, "");
    _mint(treasury, dividendTokenId, TOTAL_DIVIDEND_SUPPLY, "");

    emit EntityRegistered(entityId, entityNumber, boardHash);
    emit GovernanceEnabled(entityId, controlTokenId, dividendTokenId);
  }

  /// @dev DIVIDEND lane. Each authorization is either a 65-byte EOA signature
  ///      over `digest` or a current-board Hanko of a NUMBERED entity (companies
  ///      hold dividend shares in their treasuries). The voter address is the
  ///      EOA or the entity treasury; weight is its checkpointed dividend
  ///      balance one second before this block, so a same-transaction flash
  ///      borrow carries nothing. CONTROL is decided separately by
  ///      _requireReserveControlMajority over Depository reserves.
  function _requireDividendShareMajority(
    bytes32 entityId,
    bytes32 digest,
    bytes[] calldata authorizations
  ) internal view {
    if (authorizations.length == 0) revert MissingShareSupport();
    if (authorizations.length > MAX_SHARE_SUPPORTERS) revert TooManyShareSupporters();
    (, uint256 tokenId) = getTokenIds(uint256(entityId));
    uint256 totalSupport = 0;
    address previousVoter = address(0);
    for (uint256 i = 0; i < authorizations.length; i++) {
      address voter;
      if (authorizations[i].length == 65) {
        voter = _recoverSigner(digest, authorizations[i]);
      } else {
        (bytes32 voterEntityId, bool valid) = _verifyCurrentHankoSignature(authorizations[i], digest);
        uint256 voterNumber = uint256(voterEntityId);
        if (!valid || voterNumber == 0 || voterNumber >= nextNumber) revert InvalidShareSupportSignature();
        voter = entityTreasury(voterNumber);
      }
      if (voter == address(0)) revert InvalidShareSupportSignature();
      if (i > 0) {
        if (voter == previousVoter) revert DuplicateShareSupporter();
        if (voter < previousVoter) revert ShareSupportersNotSorted();
      }
      uint256 balance = _dividendCheckpoints[tokenId][voter].upperLookupRecent(uint48(block.timestamp - 1));
      if (balance == 0) revert ShareSupporterHasNoShares();
      totalSupport += balance;
      previousVoter = voter;
    }

    if (totalSupport <= TOTAL_DIVIDEND_SUPPLY / 2) revert InsufficientShareSupport();
  }

  function _requireReserveControlMajority(
    bytes32 targetEntityId,
    bytes32 digest,
    bytes[] calldata hankos
  ) internal view {
    uint256 depositoryCount = _shareDepositories.length;
    if (depositoryCount == 0) revert ShareDepositoryRequired();
    if (hankos.length == 0) revert MissingShareSupport();
    if (hankos.length > MAX_SHARE_SUPPORTERS) revert TooManyShareSupporters();
    (uint256 controlTokenId, ) = getTokenIds(uint256(targetEntityId));
    bytes32[] memory shareholders = new bytes32[](hankos.length);
    bytes32 previousShareholder = bytes32(0);
    for (uint256 i = 0; i < hankos.length; i++) {
      (bytes32 shareholderEntityId, bool valid) = _verifyCurrentHankoSignature(hankos[i], digest);
      if (!valid || shareholderEntityId == bytes32(0)) revert InvalidShareSupportSignature();
      if (i > 0) {
        if (shareholderEntityId == previousShareholder) revert DuplicateShareSupporter();
        if (shareholderEntityId < previousShareholder) revert ShareSupportersNotSorted();
      }
      shareholders[i] = shareholderEntityId;
      previousShareholder = shareholderEntityId;
    }
    uint256 totalSupport = 0;
    bool anyRegistered = false;
    for (uint256 d = 0; d < depositoryCount; d++) {
      address depository = _shareDepositories[d];
      uint256 internalTokenId = controlReserveTokenIds[targetEntityId][depository];
      if (internalTokenId == 0) continue;
      anyRegistered = true;
      // Fault isolation: one broken or malicious Depository must never brick
      // the CONTROL lane for every entity forever (the list is append-only).
      // A Depository that reverts, is mid-batch (_status == 2, reserves may be
      // flash-inflated) or returns malformed data simply contributes zero.
      (bool statusOk, bytes memory statusData) =
        depository.staticcall(abi.encodeWithSelector(IEntityShareDepository._status.selector));
      if (!statusOk || statusData.length != 32 || abi.decode(statusData, (uint256)) == 2) continue;
      uint256 depositorySupport = 0;
      bool readOk = true;
      for (uint256 i = 0; i < shareholders.length; i++) {
        (bool ok, bytes memory data) = depository.staticcall(
          abi.encodeWithSelector(IEntityShareDepository._reserves.selector, shareholders[i], internalTokenId)
        );
        if (!ok || data.length != 32) { readOk = false; break; }
        depositorySupport += abi.decode(data, (uint256));
      }
      if (!readOk) continue;
      // A Depository can never report more weight than the shares it holds.
      uint256 held = balanceOf(depository, controlTokenId);
      totalSupport += depositorySupport < held ? depositorySupport : held;
    }
    if (!anyRegistered) revert ShareDepositoryRequired();
    if (totalSupport == 0) revert ShareSupporterHasNoShares();
    if (totalSupport <= TOTAL_CONTROL_SUPPLY / 2) revert InsufficientShareSupport();
  }

  function _requireBoardAuthority(
    bytes32 entityId,
    ProposerType authority,
    bytes32 digest,
    bytes[] calldata authorizations
  ) internal view {
    if (authority == ProposerType.CONTROL) {
      _requireReserveControlMajority(entityId, digest, authorizations);
      return;
    }
    if (authority == ProposerType.DIVIDEND) {
      _requireDividendShareMajority(entityId, digest, authorizations);
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

  /**
   * @notice Foundation can create entity with custom governance articles
   * @param encodedBoard abi.encode(Board) of the initial board; validated on chain
   * @param articles Custom governance configuration (delays in seconds)
   * @return entityNumber The assigned entity number
   */
  function foundationRegisterEntity(
    bytes calldata encodedBoard,
    EntityArticles calldata articles,
    bytes calldata hankoData,
    uint256 actionNonce
  ) external returns (uint256 entityNumber) {
    bytes32 boardHash = _validatedBoardHash(encodedBoard);
    _authorizeFoundation(
      FOUNDATION_REGISTER_ENTITY,
      keccak256(abi.encode(boardHash, articles)),
      hankoData,
      actionNonce
    );
    return _registerEntity(boardHash, articles);
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
    _safeTransferFrom(entityTreasury(entityNumber), to, tokenId, amount, "");
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
   * @notice Release entity control and/or dividend shares to an explicit custodian.
   * @dev This operation targets an IEntityShareDepository. Each released class
   *      is registered while its Entity treasury balance still proves a fixed
   *      supply, then the ERC1155 callback credits that Entity's reserve. Direct
   *      wallet transfers use entityTransferTokens instead.
   * @param entityNumber The entity number
   * @param recipient Explicit custody address receiving the shares
   * @param controlAmount Amount of control tokens to release (0 to skip)
   * @param dividendAmount Amount of dividend tokens to release (0 to skip) 
   * @param purpose Human-readable purpose (e.g., "Series A", "Employee Pool", "Public Sale")
   * @param hankoData Canonical entity quorum Hanko authorizing this release
   */
  function releaseControlShares(
    uint256 entityNumber,
    address recipient,
    uint256 controlAmount,
    uint256 dividendAmount,
    string calldata purpose,
    bytes calldata hankoData
  ) external {
    if (recipient == address(0) || !_isShareDepository(recipient)) revert ShareDepositoryRequired();
    require(controlAmount > 0 || dividendAmount > 0, "Must release some tokens");
    
    bytes32 entityId = bytes32(entityNumber);
    require(entities[entityId].currentBoardHash != bytes32(0), "Entity doesn't exist");
    uint256 actionNonce = entityActionNonces[entityId] + 1;
    
    bytes32 releaseHash = computeReleaseControlSharesHankoHash(
      entityNumber,
      recipient,
      controlAmount,
      dividendAmount,
      purpose,
      actionNonce
    );
    
    (bytes32 recoveredEntityId, bool valid) = _verifyCurrentHankoSignature(hankoData, releaseHash);
    require(valid && recoveredEntityId == entityId, "Invalid entity signature");
    entityActionNonces[entityId] = actionNonce;
    
    address entityAddress = entityTreasury(entityNumber);
    (uint256 controlTokenId, uint256 dividendTokenId) = getTokenIds(entityNumber);
    
    // Transfer control tokens if requested
    if (controlAmount > 0) {
      require(balanceOf(entityAddress, controlTokenId) >= controlAmount, "Insufficient control tokens");
      controlReserveTokenIds[entityId][recipient] = IEntityShareDepository(recipient)
        .registerExternalToken(2, address(this), controlTokenId);
      _safeTransferFrom(entityAddress, recipient, controlTokenId, controlAmount,
        abi.encode("CONTROL_SHARE_RELEASE", purpose));
    }
    
    // Transfer dividend tokens if requested  
    if (dividendAmount > 0) {
      require(balanceOf(entityAddress, dividendTokenId) >= dividendAmount, "Insufficient dividend tokens");
      IEntityShareDepository(recipient).registerExternalToken(2, address(this), dividendTokenId);
      _safeTransferFrom(entityAddress, recipient, dividendTokenId, dividendAmount,
        abi.encode("DIVIDEND_SHARE_RELEASE", purpose));
    }
    
    emit ControlSharesReleased(entityId, recipient, controlAmount, dividendAmount, purpose);
    emit EntityProviderActionExecuted(
      entityId,
      actionNonce,
      releaseHash,
      EntityProviderActionKind.RELEASE_CONTROL_SHARES
    );
  }

  // ========== WATCHTOWER APPOINTMENT FENCE ==========

  function computeWatchtowerMinSequenceHankoHash(
    uint256 entityNumber,
    uint256 newMinimum,
    uint256 actionNonce
  ) public view returns (bytes32) {
    return keccak256(HankoEncoding.encodeWatchtowerMinSequence(
      block.chainid,
      address(this),
      entityNumber,
      boardEpochs[bytes32(entityNumber)],
      newMinimum,
      actionNonce
    ));
  }

  /// @notice Raise the minimum accepted watchtower appointment sequence.
  /// @dev Monotonic. Uses the entity action nonce lane like every other
  ///      current-board entity action.
  function setWatchtowerMinSequence(
    uint256 entityNumber,
    uint256 newMinimum,
    bytes calldata hankoData
  ) external {
    bytes32 entityId = bytes32(entityNumber);
    if (newMinimum <= watchtowerMinSequence[entityId]) revert InvalidAuthorityAuthorization();
    uint256 actionNonce = entityActionNonces[entityId] + 1;
    bytes32 actionHash = computeWatchtowerMinSequenceHankoHash(entityNumber, newMinimum, actionNonce);
    (bytes32 recoveredEntityId, bool valid) = _verifyCurrentHankoSignature(hankoData, actionHash);
    require(valid && recoveredEntityId == entityId, "Invalid entity signature");
    entityActionNonces[entityId] = actionNonce;
    watchtowerMinSequence[entityId] = newMinimum;
    emit EntityProviderActionExecuted(
      entityId,
      actionNonce,
      actionHash,
      EntityProviderActionKind.WATCHTOWER_MIN_SEQUENCE
    );
  }

  /// @dev Checkpoint dividend balances (high-bit token ids) on every transfer so
  ///      the DIVIDEND lane can read the previous block. Control ids are not
  ///      checkpointed: CONTROL is decided by Depository reserves.
  function _update(
    address from,
    address to,
    uint256[] memory ids,
    uint256[] memory values
  ) internal virtual override {
    super._update(from, to, ids, values);
    uint48 key = uint48(block.timestamp);
    for (uint256 i = 0; i < ids.length; i++) {
      uint256 id = ids[i];
      if (id >> 255 == 0) continue;
      if (from != address(0)) _dividendCheckpoints[id][from].push(key, uint208(balanceOf(from, id)));
      if (to != address(0)) _dividendCheckpoints[id][to].push(key, uint208(balanceOf(to, id)));
    }
  }

  /// @notice Dividend balance of `account` as of unix second `timestamp` (checkpointed).
  function dividendBalanceAt(address account, uint256 tokenId, uint48 timestamp) external view returns (uint256) {
    return _dividendCheckpoints[tokenId][account].upperLookupRecent(timestamp);
  }

}
