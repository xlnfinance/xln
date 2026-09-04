// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "./EntityProvider.sol";
import "./DeltaTransformer.sol";
import "./Types.sol";
import "./Account.sol";
import "./HankoEncoding.sol";
import "./HashLadderRegistry.sol";
import "./DepositoryBounds.sol";
import "./custody/NftCustody.sol";

abstract contract ReentrancyGuardLite {
  error E0();
  uint256 internal constant _NOT_ENTERED = 1;
  uint256 internal constant _ENTERED = 2;
  uint256 public _status = _NOT_ENTERED;

  modifier nonReentrant() {
    if (_status == _ENTERED) revert E0();
    _status = _ENTERED;
    _;
    _status = _NOT_ENTERED;
  }
}

interface IERC20 {
  function transfer(address to, uint256 value) external returns (bool);
  function transferFrom(address from, address to, uint256 value) external returns (bool);
  function balanceOf(address account) external view returns (uint256);
}
// IERC1155 already defined in @openzeppelin/contracts (imported via EntityProvider.sol)

contract Depository is ReentrancyGuardLite, IDepositoryDelegateErrorAbi {
  struct ReserveMint {
    bytes32 entity;
    uint tokenId;
    uint amount;
  }


  // Shared E2..E10 / transformer errors: Types.sol.
  // Depository-only codes stay here — not used by the Account library.
  error E1(); // ZeroAmount
  error E11(); // UnsupportedToken
  // Registry conflict: a Source retry changed ratio, a Target retry lowered
  // ratio, the signed role mismatched, or a first Source write missed its
  // beneficiary window. Exact retries remain idempotent.
  error E12();

  // Immutable EntityProvider (set in constructor, gas-efficient static calls)
  address public immutable entityProvider;
  // Only this deployment's canonical DeltaTransformer may define Pull ABI and
  // authorize hash-ladder registrations from signed ProofBodies.
  // Public getter is a deployment trust boundary, not UI convenience:
  // Runtime readiness must prove that the Depository authorizes the same
  // transformer whose ABI it uses to sign Pull clauses. Code-shape matching
  // alone cannot distinguish two canonical deployments at different addresses.
  address public immutable deltaTransformer;

  mapping (bytes32 => mapping (uint => uint)) public _reserves;

  mapping (bytes => AccountInfo) public _accounts;
  mapping (bytes => mapping(uint => AccountCollateral)) public _collaterals;

  // Independent reveal records. Key = (revealer Entity, ladder, role namespace).
  // Value packs (revealedAt << 16) | fillRatio. Account/dispute semantics are
  // intentionally absent: the signed DeltaTransformer.Pull owns them.
  // Sprites-like evidence scoped by authenticated writer, Account peer,
  // ladder and signed role. No hashed duplicate of this pair is stored.
  mapping (bytes32 => mapping (bytes32 => mapping (bytes32 => mapping (bool => uint256)))) private hashLadderReveals;

  mapping (bytes32 => mapping (uint => Debt[])) public _debts;
  // the current debt index to pay
  mapping (bytes32 => mapping (uint => uint)) public _debtIndex;
  // total reserve locked by unpaid debt, scoped by debtor and token
  mapping (bytes32 => mapping (uint => uint)) public debtOutstanding;
  // Number of live (unpaid) debt entries per entity across all tokens. One
  // observability counter, not per token: watchers only need "has debts".
  mapping (bytes32 => uint256) public activeDebts;


  address private immutable admin;
  uint256 private constant LOCAL_DEV_CHAIN_ID = 31337;
  uint256 private constant SECONDARY_LOCAL_DEV_CHAIN_ID = 31338;
  uint256 private constant DEBT_ENFORCEMENT_CHUNK = 32;
  // EIP-7623 charges a 40-gas floor per non-zero calldata byte. A 256 KiB
  // batch therefore leaves ~4.5M execution gas inside the protocol's 15M-gas
  // liveness envelope; transformer calls dynamically yield to that reserve.
  uint256 private constant MAX_ENCODED_BATCH_BYTES = 256 * 1024;
  // One top-level R2C item can fan out to many bilateral accounts. Bounding
  // only the outer and inner arrays independently admitted 50 * 64 cold
  // collateral writes (~200M gas), so an otherwise valid signed batch could
  // never be mined. 256 distinct pairs stays inside the 15M liveness envelope;
  // larger transfers remain losslessly expressible across sequential nonces.
  // Runtime permits up to 1,000 open swaps in one account proof. The canonical
  // DeltaTransformer path is regression-tested below this cap.
  event DebtCreated(bytes32 indexed debtor, bytes32 indexed creditor, uint256 indexed tokenId, uint256 amount, uint256 debtIndex);
  event DebtEnforced(bytes32 indexed debtor, bytes32 indexed creditor, uint256 indexed tokenId, uint256 amountPaid, uint256 remainingAmount, uint256 newDebtIndex);
  event DebtForgiven(bytes32 indexed debtor, bytes32 indexed creditor, uint256 indexed tokenId, uint256 amountForgiven, uint256 debtIndex);
  event TransformerDeltaClamped(
    bytes32 indexed accountKeyHash,
    uint256 indexed clauseIndex,
    address indexed transformer,
    uint256 tokenId,
    int256 requestedValue,
    int256 appliedValue
  );

  modifier onlyLocalDevAdmin() {
    _requireAdmin();
    if (block.chainid != LOCAL_DEV_CHAIN_ID && block.chainid != SECONDARY_LOCAL_DEV_CHAIN_ID) revert E2();
    _;
  }

  function _requireAdmin() private view {
    if (msg.sender != admin) revert E2();
  }

  // EntityScore tracking removed for size reduction
  // Hub tracking removed for size reduction

  // Events related to disputes and cooperative closures
  event DisputeStarted(
    bytes32 indexed sender,
    bytes32 indexed counterentity,
    uint indexed nonce,
    bool proposerIsLeft,
    bytes32 proofbodyHash,
    bytes32 watchSeed,
    bytes starterInitialArguments,
    bytes starterCounterArguments,
    bytes32 starterCounterProofCommitment,
    uint256 disputeTimeout,
    uint256 disputeStartTimestamp,
    uint32 leftResponseSeconds,
    uint32 rightResponseSeconds
  );
  event DisputeFinalized(
    bytes32 indexed sender,
    bytes32 indexed counterentity,
    uint indexed nonce,
    bytes32 finalProofbodyHash,
    bytes32 finalizationEvidenceHash
  );
  event CounterDisputeRegistered(bytes32 indexed sender, bytes32 indexed counterentity, uint256 indexed nonce, bool proposerIsLeft, bytes32 proofbodyHash);
  event CooperativeClose(bytes32 indexed sender, bytes32 indexed counterentity, uint indexed nonce);

  // ═══════════════════════════════════════════════════════════════════════════
  // CANONICAL J-EVENTS (Single Source of Truth - must match j-event-watcher.ts)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // These events are the ONLY events that j-watcher processes for entity state.
  // Each event type has exactly ONE purpose:
  //
  // ReserveUpdated  - Entity reserve balance changed (mint, R2R, settlement)
  // AccountSettled  - Bilateral account state changed (in Account.sol)
  //
  // REMOVED (redundant):
  // - ReserveMinted: redundant with ReserveUpdated (newBalance is sufficient)
  // - ReserveTransferred: redundant with 2x ReserveUpdated (one per entity)
  // - SettlementProcessed: duplicate of AccountSettled
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * @notice Emitted whenever an entity's reserve balance changes.
   * @dev This is THE canonical event for reserve state. Covers: mint, R2R, settlement.
   *      j-watcher uses this to set entity.reserves[tokenId] = newBalance
   * @param entity The entity whose reserve was updated.
   * @param tokenId The internal ID of the token.
   * @param newBalance The absolute new balance of the token for the entity.
   */
  event ReserveUpdated(bytes32 indexed entity, uint indexed tokenId, uint newBalance);
  event SecretRevealed(bytes32 indexed hashlock, bytes32 indexed revealer, bytes32 secret);
  // The full reveal material rides the event so a sibling-chain watcher can
  // port the registration without tracing the registration tx calldata.
  event HashLadderRevealRegistered(
    bytes32 indexed entity,
    bytes32 indexed counterpartyEntity,
    bytes32 ladderHash,
    uint16 fillRatio,
    bytes32 fullSecret,
    bytes32[4] reveals,
    bool targetRole,
    uint256 revealedAt
  );
  event TokenRegistered(uint256 indexed tokenId, uint8 tokenType, address indexed contractAddress, uint256 externalTokenId);

  //event ChannelUpdated(address indexed receiver, address indexed addr, uint tokenId);


  uint8 constant TypeERC20 = 0;
  uint8 constant TypeERC721 = 1;
  uint8 constant TypeERC1155 = 2;

  struct TokenMetadata {
    address contractAddress;
    uint256 externalTokenId;
    uint8 tokenType;
  }

  TokenMetadata[] public _tokens;
  
  // Efficient token lookup: packedToken -> internalTokenId
  mapping(bytes32 => uint256) private tokenToId;

  constructor(address _entityProvider, address _deltaTransformer) {
    if (_entityProvider == address(0) || _deltaTransformer == address(0)) revert E7();
    entityProvider = _entityProvider;
    deltaTransformer = _deltaTransformer;
    admin = msg.sender;
    _tokens.push(TokenMetadata({ contractAddress: address(0), externalTokenId: 0, tokenType: TypeERC20 }));
  }

  /// @notice Read a registered hash-ladder reveal. Returns (0, 0) when absent.
  /// @dev Called by DeltaTransformer.applyPull with the pull beneficiary as
  /// `entity`; the transformer trusts only this registry, never calldata.
  /// `revealedAt` is unix seconds (block.timestamp at registration).
  function getHashLadderReveal(
    bytes32 ownerEntity,
    bytes32 counterpartyEntity,
    bytes32 ladderHash,
    bool targetRole
  )
    external
    view
    returns (uint16 fillRatio, uint256 revealedAt)
  {
    return HashLadderRegistry.getReveal(
      hashLadderReveals,
      ownerEntity,
      counterpartyEntity,
      ladderHash,
      targetRole
    );
  }

  function getTokensLength() external view returns (uint) {
    return _tokens.length;
  }

  /// @notice Listing entrypoint. Only the immutable EntityProvider may call it:
  ///         EP share releases auto-register, and every external token is
  ///         listed through EntityProvider.foundationRegisterExternalToken under
  ///         a Foundation Hanko. No deployer key holds listing power on any chain.
  function registerExternalToken(uint8 tokenType, address contractAddress, uint256 externalTokenId)
    external
    returns (uint256 tokenId)
  {
    if (msg.sender != entityProvider) revert E2();
    tokenId = _registerExternalToken(tokenType, contractAddress, externalTokenId);
  }

  function _registerExternalToken(uint8 tokenType, address contractAddress, uint256 externalTokenId)
    private
    returns (uint256 tokenId)
  {
    if (contractAddress.code.length == 0) revert E11();
    bytes32 packedToken = _packTokenReference(tokenType, contractAddress, externalTokenId);
    tokenId = tokenToId[packedToken];
    if (tokenId != 0) return tokenId;
    (, bool validSupply) = Account.readFixedTokenSupply(
      tokenType,
      contractAddress,
      externalTokenId,
      entityProvider
    );
    if (!validSupply) revert E11();

    _tokens.push(TokenMetadata({
      contractAddress: contractAddress,
      externalTokenId: externalTokenId,
      tokenType: tokenType
    }));
    tokenId = _tokens.length - 1;
    tokenToId[packedToken] = tokenId;
    emit TokenRegistered(tokenId, tokenType, contractAddress, externalTokenId);
  }

  function _safeERC20Call(address token, bytes memory data) private {
    (bool success, bytes memory returndata) = token.call(data);
    if (!success) revert E3();
    // Old Tether deployments, including Nile USDT, may execute the transfer
    // and still return ABI `false`. The boolean therefore cannot be the
    // financial authority. Both callers verify exact token balance deltas
    // immediately after this call; that rejects no-op, short and fee-taking
    // transfers while supporting no-return and false-return ERC20s.
    if (returndata.length != 0 && returndata.length != 32) revert E3();
  }

  function _safeERC20TransferFrom(address token, address from, address to, uint256 amount) private {
    _safeERC20Call(token, abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount));
  }

  function _safeERC20Transfer(address token, address to, uint256 amount) private {
    _safeERC20Call(token, abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
  }


  // Batch struct is in Types.sol
  // === HANKO INTEGRATION ===

  /// @notice Sequential nonce for each entity authorising batches via Hanko.
  mapping(bytes32 => uint256) public entityNonces;

  /// @notice Domain separator used when hashing Hanko payloads for verification.
  bytes32 public constant DOMAIN_SEPARATOR = keccak256("XLN_DEPOSITORY_HANKO_V1");
  bytes32 public constant WATCHTOWER_COUNTER_DISPUTE_DOMAIN_SEPARATOR =
    keccak256("XLN_WATCHTOWER_COUNTER_DISPUTE_V1");

  event HankoBatchProcessed(bytes32 indexed entityId, bytes32 indexed batchHash, uint256 nonce);
  event WatchtowerCounterDisputeExecuted(
    address indexed tower,
    bytes32 indexed entityId,
    bytes32 indexed counterentity,
    uint256 finalNonce,
    uint256 appointmentSequence
  );

  /// @notice Process a batch authorized by entity Hanko.
  /// @dev This is the canonical production write path.
  ///      Depository is bound to a single immutable EntityProvider at deploy time.
  function processBatch(
    bytes calldata encodedBatch,
    bytes calldata hankoData,
    uint256 nonce
  ) external nonReentrant {
    if (nonce > JS_SAFE_NONCE_MAX) revert E10();
    if (encodedBatch.length > MAX_ENCODED_BATCH_BYTES) revert E10();
    Batch memory batch = abi.decode(encodedBatch, (Batch));
    DepositoryBounds.assertBatch(batch);
    Account.validateDisputeProofs(
      batch.disputeStarts,
      batch.counterDisputes,
      batch.disputeFinalizations
    );
    bytes32 batchHash = Account.computeBatchHankoHash(DOMAIN_SEPARATOR, encodedBatch, nonce);
    (bytes32 entityId, bool hankoValid) =
      EntityProvider(entityProvider).verifyCurrentHankoSignature(
        hankoData,
        batchHash
      );
    if (!hankoValid || entityId == bytes32(0)) revert E4();
    if (nonce != entityNonces[entityId] + 1) revert E2();
    entityNonces[entityId] = nonce;
    _processBatch(entityId, batch);
    emit HankoBatchProcessed(entityId, batchHash, nonce);
  }

  /// @notice Hash that an entity authorizes for a tower-only delayed counter-dispute.
  /// @dev The authorization binds the tower, account, final signed state, window,
  ///      and appointment sequence. The watchtower is a trusted delegated agent:
  ///      dynamic `otherArguments` are intentionally not owner-Hanko-bound because
  ///      secrets, fills, and pull evidence can change until execution. Financial
  ///      authority remains capped by the signed ProofBody and its allowances.
  function computeWatchtowerCounterDisputeHash(
    address tower,
    bytes32 entityId,
    bytes32 counterentity,
    uint256 finalNonce,
    bytes32 finalProofbodyHash,
    uint256 lastResortWindowSeconds,
    uint256 appointmentSequence
  ) external view returns (bytes32) {
    // Keep the public helper and Account.registerWatchtowerCounterDispute on
    // the same canonical ABI encoding. A hand-written packed address layout is
    // a different signature domain even when every visible value is equal.
    return keccak256(HankoEncoding.encodeWatchtowerCounterDispute(
      WATCHTOWER_COUNTER_DISPUTE_DOMAIN_SEPARATOR,
      block.chainid,
      address(this),
      tower,
      entityId,
      counterentity,
      finalNonce,
      finalProofbodyHash,
      lastResortWindowSeconds,
      appointmentSequence
    ));
  }

  /// @notice Delegated last-resort counter-dispute for a designated watchtower.
  /// @dev This path is intentionally narrower than processBatch():
  ///      - tower may only submit newer signed counter-disputes
  ///      - tower may never start disputes
  ///      - tower may never use unilateral timeout finalize
  ///      - tower may never act before the final last-resort window
  ///      - dynamic otherArguments are trusted execution evidence, while the
  ///        signed ProofBody remains the immutable financial authorization
  function watchtowerCounterDispute(
    bytes32 entityId,
    FinalDisputeProof calldata params,
    uint256 lastResortWindowSeconds,
    uint256 appointmentSequence,
    bytes calldata ownerAuthorizationHanko
  ) external nonReentrant returns (bool) {
    if (msg.data.length > MAX_ENCODED_BATCH_BYTES) revert E10();
    // Full delegated authorization and pre-T locking live in Account so this
    // settlement entrypoint remains deployable under EIP-170.
    if (Account.registerWatchtowerCounterDispute(
      _accounts,
      WATCHTOWER_COUNTER_DISPUTE_DOMAIN_SEPARATOR,
      msg.sender,
      entityId,
      params,
      lastResortWindowSeconds,
      appointmentSequence,
      ownerAuthorizationHanko,
      entityProvider
    )) {
      return true;
    }

    // At/after T the exact selected identity is already authenticated by its
    // pre-T counter registration. Account intentionally requires an empty
    // repeated inner signature so either current-board outer caller can
    // execute without impersonating the original counter-proof signer.
    FinalDisputeProof memory executable = params;
    executable.sig = "";
    _disputeFinalizeInternal(entityId, executable);
    emit WatchtowerCounterDisputeExecuted(
      msg.sender,
      entityId,
      params.counterentity,
      params.finalNonce,
      appointmentSequence
    );
    return true;
  }

  /**
   * @notice Mint new reserves to an entity (local dev admin only).
   * @dev Local Anvil bootstrap helper. Mainnet/testnet deployments must fund reserves
   *      through processBatch() deposits or a governance-controlled production path.
   * @param entity The entity receiving the minted reserves.
   * @param tokenId The internal token ID.
   * @param amount The amount to mint.
   */
  function mintToReserve(bytes32 entity, uint tokenId, uint amount) external onlyLocalDevAdmin {
    if (amount == 0) revert E1();
    _increaseReserve(entity, tokenId, amount);
  }

  function _processBatch(bytes32 entityId, Batch memory batch) private {
    // Implicit flash credit for the initiator (see Types.BatchScratch). No
    // reserve is ever inflated; a debt-free initiator may spend ahead of
    // holding and must be whole again before this function returns.
    BatchScratch storage scratch = BatchScratchLib.get();
    scratch.initiator = entityId;

    // the order is important: first go methods that increase entity's balance
    // then methods that deduct from it

    // Process external token deposits (increases reserves).
    // params.entity == 0 means "credit batch initiator"; otherwise the
    // signer explicitly authorises depositing into another entity reserve.
    for (uint i = 0; i < batch.externalTokenToReserve.length; i++) {
      ExternalTokenToReserve memory params = batch.externalTokenToReserve[i];
      if (params.entity == bytes32(0)) {
        params.entity = entityId;
      }
      _externalTokenToReserve(params);
    }

    // Process reserveToReserve transfers (the core functionality we need)
    for (uint i = 0; i < batch.reserveToReserve.length; i++) {
      if (!_reserveToReserve(entityId, batch.reserveToReserve[i])) revert E3();
    }

    // C2R shortcut: direct processing (no Settlement[] allocation)
    // Pure C2R = withdraw `amount` from my share of collateral to my reserve
    // Account reverts E4/E3 itself; every rejected item aborts the batch.
    for (uint i = 0; i < batch.collateralToReserve.length; i++) {
      Account.processC2R(_reserves, _accounts, _collaterals, entityId, batch.collateralToReserve[i], entityProvider);
    }

    // Delegate settlement diffs to Account library, handle debt forgiveness in Depository
    if (batch.settlements.length > 0) {
      _enforceSettlementOutflowDebts(batch.settlements);
      Account.processSettlements(
        _reserves,
        debtOutstanding,
        _accounts,
        _collaterals,
        entityId,
        batch.settlements,
        entityProvider
      );
      // Handle debt forgiveness (not in Account due to stack limits)
      for (uint i = 0; i < batch.settlements.length; i++) {
        Settlement memory s = batch.settlements[i];
        for (uint j = 0; j < s.forgiveDebtsInTokenIds.length; j++) {
          uint tokenId = s.forgiveDebtsInTokenIds[j];
          (bool leftHasDebt, bool leftForgiven) =
            _forgiveDebtsBetweenEntities(s.leftEntity, s.rightEntity, tokenId);
          (bool rightHasDebt, bool rightForgiven) =
            _forgiveDebtsBetweenEntities(s.rightEntity, s.leftEntity, tokenId);
          // A token-only settlement authorizes the current bilateral debt. A
          // third-party FIFO head must fail the whole signed settlement rather
          // than silently consuming its nonce and unrelated diffs as "success".
          if (!leftForgiven && !rightForgiven && (leftHasDebt || rightHasDebt)) revert E2();
        }
      }
    }

    if (batch.disputeStarts.length > 0) {
      Account.processDisputeStarts(_accounts, entityId, batch.disputeStarts, entityProvider);
    }

    // Counter-proofs are state-selection responses, not early settlement.
    // Lock them before reveal/finalization processing so an obsolete initial
    // proof can never win a same-batch race once a newer state is selected.
    if (batch.counterDisputes.length > 0) {
      Account.processCounterDisputes(_accounts, entityId, batch.counterDisputes, entityProvider);
    }

    // HTLC secret reveals (must run before dispute finalizations).
    // Only the immutable canonical transformer may be called here. This is the
    // sole CALL inside processBatch whose target came from the batch itself;
    // it executes while _status == 2 and implicit-flash deficits are open, so an
    // arbitrary target would be untrusted code running in the settlement window.
    for (uint i = 0; i < batch.revealSecrets.length; i++) {
      SecretReveal memory reveal = batch.revealSecrets[i];
      if (reveal.transformer != deltaTransformer) revert E2();
      DeltaTransformer(deltaTransformer).revealSecret(reveal.secret);
      emit SecretRevealed(keccak256(abi.encode(reveal.secret)), entityId, reveal.secret);
    }

    // Reveals are Sprites-like public evidence authenticated by this batch's
    // outer Entity Hanko. The witness itself is proof-independent, but a first
    // Source write is useful only for the currently active bilateral dispute.
    // Enforcing its signed owner window here prevents an early write from
    // consuming the immutable Source slot before S. Target stays refreshable:
    // an early/late port is harmless and can be republished for a later clock.
    for (uint i = 0; i < batch.hashLadderRegistrations.length; i++) {
      HashLadderRegistration memory registration = batch.hashLadderRegistrations[i];
      HashLadderRegistry.registerReveal(
        hashLadderReveals,
        _accounts,
        entityId,
        registration
      );
    }

    // Dispute finalizations stay in Depository (too many storage refs for Account)
    for (uint i = 0; i < batch.disputeFinalizations.length; i++) {
      _disputeFinalizeInternal(entityId, batch.disputeFinalizations[i]);
    }

    for (uint i = 0; i < batch.reserveToCollateral.length; i++) {
      if (!_reserveToCollateral(entityId, batch.reserveToCollateral[i])) revert E3();
    }

    // Process external token withdrawals (decreases reserves)
    // Security: batch initiator can only withdraw from their own reserves
    for (uint i = 0; i < batch.reserveToExternalToken.length; i++) {
      if (!_reserveToExternalToken(entityId, batch.reserveToExternalToken[i])) revert E3();
    }

    // Every deficit the initiator opened must be repaid inside this batch.
    uint256 touched = scratch.tokens.length;
    for (uint256 i = 0; i < touched; i++) {
      uint256 tokenId = scratch.tokens[i];
      if (scratch.deficit[tokenId] != 0) revert E3();
    }
    delete scratch.tokens;
    scratch.initiator = bytes32(0);
  }

  // MessageType enum is in Types.sol

  // ReserveToCollateral and EntityAmount (was AddrAmountPair) are in Types.sol


  // Allowance, TransformerClause, ProofBody, InitialDisputeProof, FinalDisputeProof, Debt are in Types.sol

  // DebtSnapshot moved to DepositoryView.sol

  function _addDebt(bytes32 debtor, uint256 tokenId, bytes32 creditor, uint256 amount) internal {
    if (creditor == bytes32(0) || debtor == creditor) revert E2();
    Account.addDebt(
      _debts,
      _debtIndex,
      debtOutstanding,
      debtor,
      tokenId,
      creditor,
      amount
    );
    activeDebts[debtor]++;
  }

  function _afterDebtCleared(bytes32 entity) internal {
    if (activeDebts[entity] > 0) {
      unchecked {
        activeDebts[entity]--;
      }
    }
  }

  function _reduceDebtOutstanding(bytes32 entity, uint256 tokenId, uint256 amount) internal {
    if (amount == 0) return;
    uint256 outstanding = debtOutstanding[entity][tokenId];
    if (outstanding < amount) revert E3();
    unchecked {
      debtOutstanding[entity][tokenId] = outstanding - amount;
    }
  }

  function _spendableReserve(bytes32 entity, uint256 tokenId) internal view returns (uint256) {
    uint256 reserve = _reserves[entity][tokenId];
    uint256 outstanding = debtOutstanding[entity][tokenId];
    return reserve > outstanding ? reserve - outstanding : 0;
  }

  /// @dev Outflow gate incl. the initiator's implicit flash allowance.
  function _canSpend(bytes32 entity, uint256 tokenId, uint256 amount) internal view returns (bool) {
    return Account.canSpend(_reserves, debtOutstanding, entity, tokenId, amount);
  }

  function _packTokenReference(uint8 tokenType, address contractAddress, uint256 externalTokenId) private pure returns (bytes32) {
    return keccak256(abi.encode(tokenType, contractAddress, externalTokenId));
  }

  function _enforceSettlementOutflowDebts(Settlement[] memory settlements) private {
    for (uint256 i = 0; i < settlements.length; i++) {
      Settlement memory settlement = settlements[i];
      for (uint256 j = 0; j < settlement.diffs.length; j++) {
        SettlementDiff memory diff = settlement.diffs[j];
        if (diff.leftDiff < 0) _enforceDebts(settlement.leftEntity, diff.tokenId, DEBT_ENFORCEMENT_CHUNK);
        if (diff.rightDiff < 0) _enforceDebts(settlement.rightEntity, diff.tokenId, DEBT_ENFORCEMENT_CHUNK);
      }
    }
  }

  // registerHub removed for size reduction

  // ExternalTokenToReserve struct is in Types.sol
  // Local Anvil bootstrap helper. User deposits must go through processBatch().
  function adminRegisterExternalToken(ExternalTokenToReserve memory params) external onlyLocalDevAdmin nonReentrant {
    params.internalTokenId = _registerExternalToken(
      params.tokenType,
      params.contractAddress,
      params.externalTokenId
    );
    _externalTokenToReserve(params);
  }

  // Internal version for batch processing (already inside nonReentrant context)
  function _externalTokenToReserve(ExternalTokenToReserve memory params) internal {
    bytes32 targetEntity = params.entity == bytes32(0) ? bytes32(uint256(uint160(msg.sender))) : params.entity;
    if (params.amount == 0) revert E1();

    bytes32 packedToken = _packTokenReference(params.tokenType, params.contractAddress, params.externalTokenId);

    if (params.internalTokenId == 0) {
      params.internalTokenId = tokenToId[packedToken];
      if (params.internalTokenId == 0) revert E11();
    } else {
      TokenMetadata memory meta = _tokens[params.internalTokenId];
      params.contractAddress = meta.contractAddress;
      params.externalTokenId = meta.externalTokenId;
      params.tokenType = meta.tokenType;
    }

    if (params.tokenType == TypeERC20) {
      uint256 balanceBefore = IERC20(params.contractAddress).balanceOf(address(this));
      _safeERC20TransferFrom(params.contractAddress, msg.sender, address(this), params.amount);
      uint256 balanceAfter = IERC20(params.contractAddress).balanceOf(address(this));
      params.amount = balanceAfter - balanceBefore;
      if (params.amount == 0) revert E3();
    } else if (params.tokenType == TypeERC721) {
      NftCustody.depositERC721(params.contractAddress, params.externalTokenId);
      params.amount = 1;
    } else if (params.tokenType == TypeERC1155) {
      NftCustody.depositERC1155(params.contractAddress, params.externalTokenId, params.amount);
    }

    _increaseReserve(targetEntity, params.internalTokenId, params.amount);
  }


  // ReserveToExternalToken struct is in Types.sol
  function _reserveToExternalToken(bytes32 entity, ReserveToExternalToken memory params) internal returns (bool) {
    if (params.amount == 0) revert E1();
    _enforceDebts(entity, params.tokenId, DEBT_ENFORCEMENT_CHUNK);

    TokenMetadata memory meta = _tokens[params.tokenId];
    if (!_canSpend(entity, params.tokenId, params.amount)) return false;
    if (uint256(params.receivingEntity) > type(uint160).max) revert E2();
    address recipient = address(uint160(uint256(params.receivingEntity)));
    if (meta.tokenType == TypeERC721 && params.amount != 1) revert E1();
    _decreaseReserve(entity, params.tokenId, params.amount);

    if (meta.tokenType == TypeERC20) {
      uint256 senderBalanceBefore = IERC20(meta.contractAddress).balanceOf(address(this));
      uint256 recipientBalanceBefore = IERC20(meta.contractAddress).balanceOf(recipient);
      _safeERC20Transfer(meta.contractAddress, recipient, params.amount);
      uint256 senderBalanceAfter = IERC20(meta.contractAddress).balanceOf(address(this));
      uint256 recipientBalanceAfter = IERC20(meta.contractAddress).balanceOf(recipient);
      if (
        senderBalanceBefore < params.amount ||
        senderBalanceAfter != senderBalanceBefore - params.amount ||
        recipientBalanceAfter < recipientBalanceBefore ||
        recipientBalanceAfter - recipientBalanceBefore != params.amount
      ) revert E11();
    } else if (meta.tokenType == TypeERC721) {
      NftCustody.withdrawERC721(meta.contractAddress, meta.externalTokenId, recipient);
    } else if (meta.tokenType == TypeERC1155) {
      NftCustody.withdrawERC1155(meta.contractAddress, meta.externalTokenId, params.amount, recipient);
    }
    return true;
  }
  // ReserveToReserve struct is in Types.sol
  function _reserveToReserve(bytes32 entity, ReserveToReserve memory params) internal returns (bool) {
    // Entity 0 can never sign; a transfer there burns reserves silently.
    if (params.receivingEntity == bytes32(0)) revert E7();
    _enforceDebts(entity, params.tokenId, DEBT_ENFORCEMENT_CHUNK);
    if (!_canSpend(entity, params.tokenId, params.amount)) return false;
    _decreaseReserve(entity, params.tokenId, params.amount);
    _increaseReserve(params.receivingEntity, params.tokenId, params.amount);
    return true;
  }

  // FIFO debt enforcement. `maxIterations == 0` drains without a slot cap.
  // The public wrapper is reentrancy-guarded: a listed token's transfer hook
  // must not interleave debt movements with a live batch. Internal callers use
  // _enforceDebts, which runs inside the already-guarded batch.
  function enforceDebts(bytes32 entity, uint256 tokenId, uint256 maxIterations) external nonReentrant {
    _enforceDebts(entity, tokenId, maxIterations);
  }

  function _enforceDebts(bytes32 entity, uint256 tokenId, uint256 maxIterations) internal {
    Account.enforceDebts(
      _reserves,
      _debts,
      _debtIndex,
      debtOutstanding,
      activeDebts,
      entity,
      tokenId,
      maxIterations
    );
  }



  function _accountKey(bytes32 e1, bytes32 e2) private pure returns (bytes memory) {
    return e1 < e2 ? abi.encodePacked(e1, e2) : abi.encodePacked(e2, e1);
  }

  function _reserveToCollateral(bytes32 entity, ReserveToCollateral memory params) internal returns (bool completeSuccess) {
    uint tokenId = params.tokenId;
    bytes32 receivingEntity = params.receivingEntity;
    if (receivingEntity == bytes32(0) || params.pairs.length == 0) revert E7();
   
    // debts must be paid before any transfers from reserve 
    _enforceDebts(entity, tokenId, DEBT_ENFORCEMENT_CHUNK);

    uint256 totalAmount = 0;
    for (uint i = 0; i < params.pairs.length; i++) {
      uint256 amount = params.pairs[i].amount;
      if (amount == 0) revert E1();
      if (params.pairs[i].entity == bytes32(0) || params.pairs[i].entity == receivingEntity) revert E7();
      if (amount > MAX_MONEY) revert E8();
      totalAmount += amount;
    }
    if (!_canSpend(entity, tokenId, totalAmount)) return false;

    for (uint i = 0; i < params.pairs.length; i++) {
      bytes32 counterentity = params.pairs[i].entity;
      uint amount = params.pairs[i].amount;

      bytes memory acct_key = _accountKey(receivingEntity, counterentity);

      
        AccountCollateral storage col = _collaterals[acct_key][tokenId];
        int256 signedAmount = int256(amount);

        _decreaseReserve(entity, tokenId, amount);
        // Per-call amount is already ≤ int256.max above, but collateral
        // accumulates across pairs and senders and shares Account's ceiling.
        Account.increaseCollateral(col, amount);
        if (receivingEntity < counterentity) { // if receiver is left
          col.ondelta += signedAmount;
          if (col.ondelta > MAX_MONEY_INT) revert E8();
        }

        // Emit unionified AccountSettled event (canonical ordering: left < right)
        bytes32 leftEntity = receivingEntity < counterentity ? receivingEntity : counterentity;
        bytes32 rightEntity = receivingEntity < counterentity ? counterentity : receivingEntity;

        // R2C doesn't increment nonce (no bilateral signature required)
        TokenSettlement[] memory tokens = new TokenSettlement[](1);
        tokens[0] = TokenSettlement({
          tokenId: tokenId,
          leftReserve: _reserves[leftEntity][tokenId],
          rightReserve: _reserves[rightEntity][tokenId],
          collateral: col.collateral,
          ondelta: col.ondelta
        });
        AccountSettlement[] memory settled = new AccountSettlement[](1);
        if (_accounts[_accountKey(leftEntity, rightEntity)].nonce > JS_SAFE_NONCE_MAX) revert E10();
        settled[0] = AccountSettlement({
          left: leftEntity,
          right: rightEntity,
          tokens: tokens,
          nonce: _accounts[_accountKey(leftEntity, rightEntity)].nonce
        });
        emit Account.AccountSettled(settled);
    }


    return true;
  }



  function _forgiveDebtsBetweenEntities(bytes32 debtor, bytes32 creditor, uint tokenId)
    internal returns (bool hasCurrentDebt, bool forgiven)
  {
    uint256 idx = _debtIndex[debtor][tokenId];
    Debt[] storage queue = _debts[debtor][tokenId];
    uint256 len = queue.length;
    if (idx >= len) return (false, false);
    Debt storage current = queue[idx];
    uint256 amount = current.amount;
    // Forgiveness is deliberately FIFO and O(1): a bilateral settlement may
    // forgive only the debtor's current debt when that debt belongs to the
    // counterparty. It must never scan or partially process an unbounded tail.
    if (amount == 0) return (false, false);
    if (current.creditor != creditor) return (true, false);
    current.amount = 0;
    _reduceDebtOutstanding(debtor, tokenId, amount);
    _afterDebtCleared(debtor);
    emit DebtForgiven(debtor, creditor, tokenId, amount, idx);
    if (idx + 1 == len) {
      _debtIndex[debtor][tokenId] = 0;
      delete _debts[debtor][tokenId];
    } else {
      _debtIndex[debtor][tokenId] = idx + 1;
    }
    return (true, true);
  }

  function _increaseReserve(bytes32 entity, uint256 tokenId, uint256 amount) internal {
    Account.increaseReserve(_reserves, entity, tokenId, amount);
  }

  function _decreaseReserve(bytes32 entity, uint256 tokenId, uint256 amount) internal {
    Account.decreaseReserve(_reserves, entity, tokenId, amount);
  }

  /// @notice Internal dispute finalize with full storage access
  function _disputeFinalizeInternal(bytes32 entityId, FinalDisputeProof memory params) private {
    bytes memory acct_key = _accountKey(entityId, params.counterentity);
    AccountInfo storage account = _accounts[acct_key];
    bool initialProposerIsLeft = account.disputeInitialProposerIsLeft;
    (
      bytes memory leftArguments,
      bytes memory rightArguments,
      uint256 leftArgumentsTimestamp,
      uint256 rightArgumentsTimestamp,
      uint256 eventInitialNonce,
      bytes32 finalProofbodyHash,
      uint256 disputeStartTimestamp,
      uint256 disputeTimeout,
      uint32 leftResponseSeconds,
      uint32 rightResponseSeconds
    ) = Account.prepareDisputeFinalization(
      _accounts,
      entityId,
      params,
      entityProvider,
      deltaTransformer
    );

    _finalizeAccount(
      entityId,
      params.counterentity,
      params.finalProofbody,
      leftArguments,
      rightArguments,
      leftArgumentsTimestamp,
      rightArgumentsTimestamp,
      disputeStartTimestamp,
      disputeTimeout,
      leftResponseSeconds,
      rightResponseSeconds
    );
    // Cooperative/counter-dispute adopts its signed nonce. A unilateral
    // timeout has no newer signature, so it consumes exactly one nonce.
    bool adoptsSignedBranch =
      params.sig.length > 0 ||
      params.finalNonce != eventInitialNonce ||
      finalProofbodyHash != params.initialProofbodyHash ||
      params.proposerIsLeft != initialProposerIsLeft;
    if (adoptsSignedBranch) {
      if (params.finalNonce >= JS_SAFE_NONCE_MAX) revert E10();
      account.nonce = params.finalNonce;
    } else {
      if (account.nonce >= JS_SAFE_NONCE_MAX) revert E10();
      account.nonce += 1;
    }

    bytes32 initialProofbodyHash = params.initialProofbodyHash;
    uint256 finalNonce = params.finalNonce;
    bool proposerIsLeft = params.proposerIsLeft;
    bool startedByLeft = params.startedByLeft;
    bytes32 starterArgumentsHash = keccak256(params.starterArguments);
    bytes32 otherArgumentsHash = keccak256(params.otherArguments);
    bytes32 sigHash = keccak256(params.sig);
    bytes32 finalizationEvidenceHash;
    // Exactly abi.encode of seven static words, written directly so finality
    // authentication does not add a second generic encoder to runtime bytecode.
    assembly ("memory-safe") {
      let ptr := mload(0x40)
      mstore(ptr, initialProofbodyHash)
      mstore(add(ptr, 0x20), finalNonce)
      mstore(add(ptr, 0x40), proposerIsLeft)
      mstore(add(ptr, 0x60), startedByLeft)
      mstore(add(ptr, 0x80), starterArgumentsHash)
      mstore(add(ptr, 0xa0), otherArgumentsHash)
      mstore(add(ptr, 0xc0), sigHash)
      finalizationEvidenceHash := keccak256(ptr, 0xe0)
    }

    emit DisputeFinalized(
      entityId,
      params.counterentity,
      eventInitialNonce,
      finalProofbodyHash,
      // Receipt MPT authenticates this commitment to the non-emitted sidecar.
      finalizationEvidenceHash
    );
  }

  /// @notice Finalize account - applies deltas and clears collateral
  function _finalizeAccount(
    bytes32 entity1,
    bytes32 entity2,
    ProofBody memory proofbody,
    bytes memory leftArguments,
    bytes memory rightArguments,
    uint256 leftArgumentsTimestamp,
    uint256 rightArgumentsTimestamp,
    uint256 disputeStartTimestamp,
    uint256 disputeTimeout,
    uint32 leftResponseSeconds,
    uint32 rightResponseSeconds
  ) private {
    if (proofbody.tokenIds.length != proofbody.offdeltas.length) revert E8();

    bytes32 leftAddr = entity1 < entity2 ? entity1 : entity2;
    bytes32 rightAddr = entity1 < entity2 ? entity2 : entity1;
    bytes memory acct_key = _accountKey(leftAddr, rightAddr);

    // Account owns bilateral delta arithmetic and signed transformer execution;
    // Depository owns only the resulting custody, reserve, and debt effects.
    int[] memory transformerDeltas = Account.prepareSettlementDeltas(
      _collaterals,
      acct_key,
      proofbody,
      leftArguments,
      rightArguments,
      leftArgumentsTimestamp,
      rightArgumentsTimestamp,
      leftAddr,
      rightAddr,
      deltaTransformer,
      disputeStartTimestamp,
      disputeTimeout,
      leftResponseSeconds,
      rightResponseSeconds
    );

    // Every term is MAX_MONEY-bounded (see Types.sol), so the delta is a plain
    // int256 and its magnitude is exact.
    for (uint256 i = 0; i < proofbody.tokenIds.length; i++) {
      int256 delta = transformerDeltas[i];
      bool negativeDelta = delta < 0;
      uint256 deltaMagnitude = negativeDelta ? uint256(-delta) : uint256(delta);
      _applyAccountDelta(
        acct_key,
        proofbody.tokenIds[i],
        leftAddr,
        rightAddr,
        negativeDelta,
        deltaMagnitude
      );
    }

    // Nonce update is handled by _disputeFinalizeInternal (caller).
  }

  /// @notice Apply delta to account collateral and reserves
  function _applyAccountDelta(
    bytes memory acct_key,
    uint256 tokenId,
    bytes32 leftEntity,
    bytes32 rightEntity,
    bool negativeDelta,
    uint256 deltaMagnitude
  ) private {
    AccountCollateral storage col = _collaterals[acct_key][tokenId];
    uint256 collateral = col.collateral;

    // Δ is LEFT's allocation (ondelta + offdelta), bounded by RCPAN:
    //   −leftCreditLimit ≤ Δ ≤ collateral + rightCreditLimit
    //
    // Credit limits are deliberately NOT known to the jurisdiction. Both parties
    // sign offdelta; Δ = stored ondelta + that signed offdelta settles as-is,
    // however large the implied debt. Signing the offdelta IS the consent to it;
    // the runtime enforces RCPAN before it signs. An on-chain limit would be a
    // second source of truth that can only disagree with the signature.
    //
    // Collateral only exists on the right side of 0. Therefore:
    // - If Δ ≤ 0: LEFT gets 0, RIGHT gets all collateral, and LEFT owes −Δ (credit/debt).
    // - If 0 < Δ < collateral: split collateral (LEFT = Δ, RIGHT = collateral − Δ).
    // - If Δ ≥ collateral: LEFT gets all collateral and RIGHT owes Δ − collateral (credit/debt).
    if (negativeDelta || deltaMagnitude == 0) {
      if (collateral > 0) _increaseReserve(rightEntity, tokenId, collateral);
      if (deltaMagnitude > 0) {
        _settleShortfall(leftEntity, rightEntity, tokenId, deltaMagnitude);
      }
    } else {
      uint256 desired = deltaMagnitude;
      if (desired >= collateral) {
        if (collateral > 0) _increaseReserve(leftEntity, tokenId, collateral);
        uint256 shortfall = desired - collateral;
        if (shortfall > 0) _settleShortfall(rightEntity, leftEntity, tokenId, shortfall);
      } else {
        _increaseReserve(leftEntity, tokenId, desired);
        _increaseReserve(rightEntity, tokenId, collateral - desired);
      }
    }
    col.collateral = 0;
    col.ondelta = 0;
  }

  /// @notice Settle shortfall via reserves, then debt
  /// @dev The debt booked here is unsecured by construction. It carries no
  ///      interest, no external claim and no seizure right: the jurisdiction can
  ///      only intercept this debtor's FUTURE reserve inflows of the same token
  ///      at this Depository (enforceDebts runs before every outflow and
  ///      _spendableReserve nets outstanding debt). Nothing else is possible
  ///      without an off-chain legal wrapper. The economic meaning of a credit
  ///      line is therefore exactly: "I trust this counterparty's future J-reserve
  ///      inflows and reputation up to this amount." Hubs must size credit by
  ///      that, not by any assumption of on-chain recourse.
  function _settleShortfall(bytes32 debtor, bytes32 creditor, uint256 tokenId, uint256 amount) private {
    if (amount == 0) return;

    _enforceDebts(debtor, tokenId, DEBT_ENFORCEMENT_CHUNK);
    uint256 available = _spendableReserve(debtor, tokenId);
    uint256 payAmount = available >= amount ? amount : available;
    if (payAmount > 0) {
      _decreaseReserve(debtor, tokenId, payAmount);
      _increaseReserve(creditor, tokenId, payAmount);
    }

    uint256 remaining = amount - payAmount;
    if (remaining > 0) {
      _addDebt(debtor, tokenId, creditor, remaining);
    }
  }

  /// @dev Single ERC1155 custody is required for registered external assets.
  /// Batch receipt stays unsupported so one callback can never imply that an
  /// arbitrary token set was registered or credited.
  function onERC1155Received(address, address from, uint256 id, uint256 amount, bytes calldata data)
    external returns (bytes4)
  {
    if (data.length != 0) {
      // Entity number rides in the low 160 bits of both share ids; the sender
      // must be that entity's namespaced treasury and the credit goes to its id.
      uint256 entityNumber = uint256(uint160(id));
      if (msg.sender != entityProvider || from != entityTreasury(entityNumber)) revert E11();
      uint256 tokenId = tokenToId[_packTokenReference(TypeERC1155, entityProvider, id)];
      if (tokenId == 0) revert E11();
      _increaseReserve(bytes32(entityNumber), tokenId, amount);
    }
    return 0xf23a6e61;
  }
}
