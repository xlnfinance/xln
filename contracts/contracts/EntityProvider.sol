pragma solidity ^0.8.24;

import "./Token.sol";
import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";

contract EntityProvider is ERC1155 { 
  struct Entity {
    bytes32 currentBoardHash;
    bytes32 proposedAuthenticatorHash;
    uint256 registrationBlock;
    bool exists;
    bytes32 articlesHash;  // Governance config hash
  }

  struct Delegate {
    bytes entityId;
    uint16 votingPower;
  }

  struct Board {
    uint16 votingThreshold;
    Delegate[] delegates;
  }

  struct EntityArticles {
    uint32 controlDelay;      // Delay for control shareholders (X blocks)
    uint32 dividendDelay;     // Delay for dividend shareholders (X*3 blocks)  
    uint32 foundationDelay;   // Delay for foundation (X*10 blocks, 0=disabled)
    uint16 controlThreshold;  // % of control tokens needed for quorum replacement
  }

  enum ProposerType { QUORUM, CONTROL, DIVIDEND, FOUNDATION }

  struct QuorumProposal {
    bytes32 proposedQuorum;
    ProposerType proposerType;
    uint256 proposeBlock;
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
  
  // Admin controls
  address public admin;
  mapping(address => uint8) public nameQuota;      // User name allowances
  
  // Legacy support
  mapping (uint => uint) public activateAtBlock;
  
  // Governance system
  mapping(bytes32 => QuorumProposal) public activeProposals;  // entityId => proposal
  mapping(bytes32 => uint256) public totalControlSupply;      // entityId => total control tokens
  mapping(bytes32 => uint256) public totalDividendSupply;     // entityId => total dividend tokens
  
  // Foundation entity (always #1)
  uint256 public constant FOUNDATION_ENTITY = 1;

  // Events
  event EntityRegistered(bytes32 indexed entityId, uint256 indexed entityNumber, bytes32 boardHash);
  event NameAssigned(string indexed name, uint256 indexed entityNumber);
  event NameTransferred(string indexed name, uint256 indexed fromNumber, uint256 indexed toNumber);
  event BoardProposed(bytes32 indexed entityId, bytes32 proposedBoardHash);
  event BoardActivated(bytes32 indexed entityId, bytes32 newBoardHash);
  event GovernanceEnabled(bytes32 indexed entityId, uint256 controlTokenId, uint256 dividendTokenId);
  event QuorumReplacementProposed(bytes32 indexed entityId, bytes32 newQuorum, ProposerType proposerType, uint256 executeBlock);
  event QuorumReplaced(bytes32 indexed entityId, bytes32 oldQuorum, bytes32 newQuorum);
  event ProposalCancelled(bytes32 indexed entityId, ProposerType cancelledBy);

  constructor() ERC1155("https://xln.com/entity/{id}.json") {
    admin = msg.sender;
    // Reserve some premium names
    reservedNames["coinbase"] = true;
    reservedNames["ethereum"] = true;
    reservedNames["bitcoin"] = true;
    reservedNames["uniswap"] = true;
    
    // Create foundation entity #1
    bytes32 foundationQuorum = keccak256("FOUNDATION_INITIAL_QUORUM");
    bytes32 foundationId = bytes32(FOUNDATION_ENTITY);
    
    entities[foundationId] = Entity({
      currentBoardHash: foundationQuorum,
      proposedAuthenticatorHash: bytes32(0),
      registrationBlock: block.number,
      exists: true,
      articlesHash: bytes32(0)
    });
    
    nextNumber = 2; // Foundation takes #1, next entity will be #2
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
      exists: true,
      articlesHash: bytes32(0)  // Default no governance config
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

  /**
   * @notice Setup governance for an entity (auto-called on registration)
   * @param entityNumber The entity number
   * @param initialHolders Array of initial token holders
   * @param controlAmounts Array of control token amounts
   * @param dividendAmounts Array of dividend token amounts  
   * @param articles Governance configuration
   */
  function setupGovernance(
    uint256 entityNumber,
    address[] memory initialHolders,
    uint256[] memory controlAmounts,
    uint256[] memory dividendAmounts,
    EntityArticles memory articles
  ) external {
    bytes32 entityId = bytes32(entityNumber);
    require(entities[entityId].exists, "Entity doesn't exist");
    require(entities[entityId].articlesHash == bytes32(0), "Governance already setup");
    
    // Validate arrays
    require(initialHolders.length == controlAmounts.length, "Mismatched control arrays");
    require(initialHolders.length == dividendAmounts.length, "Mismatched dividend arrays");
    
    (uint256 controlTokenId, uint256 dividendTokenId) = getTokenIds(entityNumber);
    
    uint256 totalControl = 0;
    uint256 totalDividend = 0;
    
    // Mint tokens to initial holders
    for (uint i = 0; i < initialHolders.length; i++) {
      if (controlAmounts[i] > 0) {
        _mint(initialHolders[i], controlTokenId, controlAmounts[i], "");
        totalControl += controlAmounts[i];
      }
      if (dividendAmounts[i] > 0) {
        _mint(initialHolders[i], dividendTokenId, dividendAmounts[i], "");
        totalDividend += dividendAmounts[i];
      }
    }
    
    // Store governance config
    entities[entityId].articlesHash = keccak256(abi.encode(articles));
    totalControlSupply[entityId] = totalControl;
    totalDividendSupply[entityId] = totalDividend;
    
    emit GovernanceEnabled(entityId, controlTokenId, dividendTokenId);
  }

  /**
   * @notice Propose quorum replacement
   * @param entityNumber The entity number
   * @param newQuorum The proposed new quorum hash
   * @param proposerType Who is proposing (CONTROL, DIVIDEND, FOUNDATION)
   * @param articles Current governance articles (for verification)
   */
  function proposeQuorumReplacement(
    uint256 entityNumber,
    bytes32 newQuorum,
    ProposerType proposerType,
    EntityArticles memory articles
  ) external {
    bytes32 entityId = bytes32(entityNumber);
    require(entities[entityId].exists, "Entity doesn't exist");
    require(keccak256(abi.encode(articles)) == entities[entityId].articlesHash, "Invalid articles");
    
    // Check permissions and delays
    uint32 delay = _getDelayForProposer(articles, proposerType);
    require(delay > 0, "Proposer type disabled");
    
    if (proposerType == ProposerType.CONTROL) {
      _validateControlProposer(entityId, msg.sender, articles);
    } else if (proposerType == ProposerType.DIVIDEND) {
      _validateDividendProposer(entityId, msg.sender);
    } else if (proposerType == ProposerType.FOUNDATION) {
      require(msg.sender == address(bytes20(bytes32(FOUNDATION_ENTITY))), "Not foundation");
    }
    
    // Handle proposal priorities and cancellation
    QuorumProposal storage existing = activeProposals[entityId];
    if (existing.active) {
      // Higher priority can cancel lower priority
      require(_canCancelProposal(proposerType, existing.proposerType), "Cannot cancel existing proposal");
      emit ProposalCancelled(entityId, proposerType);
    }
    
    // Create new proposal
    activeProposals[entityId] = QuorumProposal({
      proposedQuorum: newQuorum,
      proposerType: proposerType,
      proposeBlock: block.number,
      active: true
    });
    
    emit QuorumReplacementProposed(entityId, newQuorum, proposerType, block.number + delay);
  }

  /**
   * @notice Execute quorum replacement after delay
   * @param entityNumber The entity number
   * @param supporters Array of supporter addresses (for validation)
   * @param articles Current governance articles
   */
  function executeQuorumReplacement(
    uint256 entityNumber,
    address[] memory supporters,
    EntityArticles memory articles
  ) external {
    bytes32 entityId = bytes32(entityNumber);
    QuorumProposal storage proposal = activeProposals[entityId];
    
    require(proposal.active, "No active proposal");
    require(keccak256(abi.encode(articles)) == entities[entityId].articlesHash, "Invalid articles");
    
    // Check delay has passed
    uint32 delay = _getDelayForProposer(articles, proposal.proposerType);
    require(block.number >= proposal.proposeBlock + delay, "Delay not passed");
    
    // Validate support threshold for control/dividend proposals
    if (proposal.proposerType == ProposerType.CONTROL) {
      _validateControlSupport(entityId, supporters, articles);
    } else if (proposal.proposerType == ProposerType.DIVIDEND) {
      _validateDividendSupport(entityId, supporters);
    }
    
    // Execute replacement
    bytes32 oldQuorum = entities[entityId].currentBoardHash;
    entities[entityId].currentBoardHash = proposal.proposedQuorum;
    entities[entityId].proposedAuthenticatorHash = bytes32(0);
    
    // Clear proposal
    delete activeProposals[entityId];
    
    emit QuorumReplaced(entityId, oldQuorum, proposal.proposedQuorum);
  }

  // === INTERNAL HELPER FUNCTIONS ===

  function _getDelayForProposer(EntityArticles memory articles, ProposerType proposerType) internal pure returns (uint32) {
    if (proposerType == ProposerType.CONTROL) return articles.controlDelay;
    if (proposerType == ProposerType.DIVIDEND) return articles.dividendDelay;
    if (proposerType == ProposerType.FOUNDATION) return articles.foundationDelay;
    return 0; // QUORUM has no delay
  }

  function _canCancelProposal(ProposerType canceller, ProposerType existing) internal pure returns (bool) {
    // Priority: CONTROL > QUORUM > DIVIDEND > FOUNDATION
    if (canceller == ProposerType.CONTROL) return existing != ProposerType.CONTROL;
    if (canceller == ProposerType.QUORUM) return existing == ProposerType.DIVIDEND || existing == ProposerType.FOUNDATION;
    if (canceller == ProposerType.DIVIDEND) return existing == ProposerType.FOUNDATION;
    return false; // FOUNDATION cannot cancel anyone
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
      
      if (entities[entityId].exists) {
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
}