// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import "../../../contracts/Depository.sol";
import "../../../contracts/EntityProvider.sol";
import {ERC20Mock} from "../../../contracts/ERC20Mock.sol";
import "../../../contracts/Types.sol";
import {XlnHanko} from "../helpers/XlnHanko.sol";

/// @notice Stateful handler driving Depository.processBatch through the real
///         Hanko authorization path.
///
/// Every action is written so that a *legal* sequence succeeds and an illegal
/// one reverts inside the Depository — the handler never pre-filters away a
/// state transition the contract would have accepted. Handler-side oracles
/// (`*Violations` counters) record facts the post-state alone cannot show,
/// e.g. "this flashloan batch ended with more reserve than it started with".
contract DepositoryHandler is CommonBase, StdCheats, StdUtils {
  uint256 public constant ACTORS = 4;
  uint256 public constant PAIRS = 6; // C(4,2)
  uint256 public constant DISPUTE_DELAY = 100;

  Depository public immutable dep;
  ERC20Mock public immutable tokenA; // internal id 1
  ERC20Mock public immutable tokenB; // internal id 2

  uint256[3] public TOKENS = [uint256(1), uint256(2), uint256(3)];

  uint256[ACTORS] internal pk;
  bytes32[ACTORS] public entityOf;

  // ── ghost accounting ──
  mapping(uint256 => uint256) public ghostMinted; // tokenId => admin-minted total

  // handler-side oracles
  uint256 public flashloanViolations;
  uint256 public disputeEarlyFinalizeViolations;
  uint256 public disputeDoubleFinalizeViolations;
  uint256 public disputeOverwriteViolations;

  /// @dev Coverage probe: counts states in which at least one entity carries
  /// outstanding debt, so a green debt invariant cannot be vacuously green.
  uint256 public debtObservations;

  /// @dev Splits finalizations by who submitted them. invariant 4a only means
  /// something if `starterTimeoutFinalizes` is non-zero: the counterparty is
  /// allowed to finalize immediately, so those calls test nothing about delay.
  uint256 public starterTimeoutFinalizes;
  uint256 public counterpartyTimeoutFinalizes;
  /// @dev Starter finalizations attempted before the delay elapsed. These MUST
  /// all be rejected; the count proves the early path was actually exercised.
  uint256 public starterEarlyFinalizeAttempts;

  // action counters (coverage proof — a fuzz run where these stay 0 is worthless)
  mapping(bytes32 => uint256) public calls;

  // ── dispute ghost state, keyed by pair index ──
  struct DisputeGhost {
    bool active;
    uint256 starter; // actor index
    uint256 counter; // actor index
    bool startedByLeft;
    uint256 startBlock;
    uint256 startTimestamp;
    uint256 nonce;
    bytes32 proofbodyHash;
    bytes32 watchSeed;
    uint256 tokenId;
    int256 offdelta;
  }
  mapping(uint256 => DisputeGhost) public disputes;

  constructor(Depository _dep, ERC20Mock _a, ERC20Mock _b, uint256[ACTORS] memory _pk) {
    dep = _dep;
    tokenA = _a;
    tokenB = _b;
    for (uint256 i = 0; i < ACTORS; i++) {
      pk[i] = _pk[i];
      entityOf[i] = XlnHanko.lazyEntityId(vm.addr(_pk[i]));
    }
  }

  // ═══════════════════════════ helpers ═══════════════════════════

  function _actor(uint256 seed) internal pure returns (uint256) {
    return seed % ACTORS;
  }

  function _token(uint256 seed) internal view returns (uint256) {
    return TOKENS[seed % 3];
  }

  function _observeDebt() internal {
    for (uint256 i = 0; i < ACTORS; i++) {
      for (uint256 k = 0; k < 3; k++) {
        if (dep.debtOutstanding(entityOf[i], TOKENS[k]) > 0) {
          debtObservations++;
          return;
        }
      }
    }
  }

  function _bump(string memory name) internal {
    calls[keccak256(bytes(name))]++;
  }

  function callCount(string memory name) external view returns (uint256) {
    return calls[keccak256(bytes(name))];
  }

  function _hanko(uint256 actor, bytes32 hash) internal view returns (bytes memory) {
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk[actor], hash);
    return XlnHanko.encodeSingleSignerHanko(entityOf[actor], v, r, s);
  }

  /// @dev Submits with the correct next nonce. Returns false when the
  ///      Depository rejected the whole batch.
  function _submit(uint256 actor, Batch memory batch) internal returns (bool ok) {
    bytes memory encoded = abi.encode(batch);
    uint256 nonce = dep.entityNonces(entityOf[actor]) + 1;
    bytes32 h = XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), encoded, nonce);
    try dep.processBatch(encoded, _hanko(actor, h), nonce) returns (bool complete) {
      return complete;
    } catch {
      return false;
    }
  }

  function pairIndex(uint256 a, uint256 b) public pure returns (uint256) {
    (uint256 lo, uint256 hi) = a < b ? (a, b) : (b, a);
    // 4 actors -> 6 pairs, stable dense index
    if (lo == 0) return hi - 1;        // 0-1=0, 0-2=1, 0-3=2
    if (lo == 1) return 2 + hi - 1;    // 1-2=3, 1-3=4
    return 5;                          // 2-3
  }

  function _distinct(uint256 seedA, uint256 seedB) internal pure returns (uint256 a, uint256 b) {
    a = _actor(seedA);
    b = _actor(seedB);
    if (a == b) b = (b + 1) % ACTORS;
  }

  function _reserve(uint256 actor, uint256 tokenId) internal view returns (uint256) {
    return dep._reserves(entityOf[actor], tokenId);
  }

  function _accountNonce(bytes32 e1, bytes32 e2) internal view returns (uint256 n) {
    (n,,,,,,,) = dep._accounts(XlnHanko.accountKey(e1, e2));
  }

  function _disputeHash(bytes32 e1, bytes32 e2) internal view returns (bytes32 h) {
    (, h,,,,,,) = dep._accounts(XlnHanko.accountKey(e1, e2));
  }

  function _collateral(bytes32 e1, bytes32 e2, uint256 tokenId) internal view returns (uint256 c) {
    (c,) = dep._collaterals(XlnHanko.accountKey(e1, e2), tokenId);
  }

  // ═══════════════════════════ actions ═══════════════════════════

  /// @notice Admin flash-funding. The only source of new internal value besides
  ///         external deposits, so it is fully ghost-tracked.
  function mint(uint256 actorSeed, uint256 tokenSeed, uint256 amount) external {
    uint256 a = _actor(actorSeed);
    uint256 t = _token(tokenSeed);
    amount = bound(amount, 1, 1e24);
    vm.prank(dep.admin());
    try dep.mintToReserve(entityOf[a], t, amount) {
      ghostMinted[t] += amount;
      _bump("mint");
    } catch {}
  }

  function reserveToReserve(uint256 fromSeed, uint256 toSeed, uint256 tokenSeed, uint256 amount) external {
    (uint256 from, uint256 to) = _distinct(fromSeed, toSeed);
    uint256 t = _token(tokenSeed);
    amount = bound(amount, 0, _reserve(from, t) + 1); // +1 so the over-spend path is reachable

    Batch memory b = XlnHanko.emptyBatch();
    b.reserveToReserve = new ReserveToReserve[](1);
    b.reserveToReserve[0] = ReserveToReserve({ receivingEntity: entityOf[to], tokenId: t, amount: amount });
    if (_submit(from, b)) _bump("reserveToReserve");
  }

  function reserveToCollateral(uint256 fromSeed, uint256 cpSeed, uint256 tokenSeed, uint256 amount) external {
    (uint256 from, uint256 cp) = _distinct(fromSeed, cpSeed);
    uint256 t = _token(tokenSeed);
    amount = bound(amount, 0, _reserve(from, t) + 1);

    Batch memory b = XlnHanko.emptyBatch();
    b.reserveToCollateral = new ReserveToCollateral[](1);
    EntityAmount[] memory pairs = new EntityAmount[](1);
    pairs[0] = EntityAmount({ entity: entityOf[cp], amount: amount });
    b.reserveToCollateral[0] = ReserveToCollateral({
      tokenId: t,
      receivingEntity: entityOf[from],
      pairs: pairs
    });
    if (_submit(from, b)) _bump("reserveToCollateral");
  }

  /// @notice Bilateral collateral withdrawal, signed by the counterparty.
  function collateralToReserve(uint256 fromSeed, uint256 cpSeed, uint256 tokenSeed, uint256 amount) external {
    (uint256 from, uint256 cp) = _distinct(fromSeed, cpSeed);
    uint256 t = _token(tokenSeed);
    bytes32 me = entityOf[from];
    bytes32 other = entityOf[cp];
    uint256 col = _collateral(me, other, t);
    amount = bound(amount, 0, col + 1);

    bool isLeft = me < other;
    int256 signedAmount = int256(amount);
    SettlementDiff[] memory diffs = new SettlementDiff[](1);
    diffs[0] = SettlementDiff({
      tokenId: t,
      leftDiff: isLeft ? signedAmount : int256(0),
      rightDiff: isLeft ? int256(0) : signedAmount,
      collateralDiff: -signedAmount,
      ondeltaDiff: isLeft ? -signedAmount : int256(0)
    });

    bytes memory key = XlnHanko.accountKey(me, other);
    uint256 nonce = _accountNonce(me, other) + 1;
    bytes32 h = XlnHanko.cooperativeUpdateHash(address(dep), key, nonce, diffs, new uint256[](0));

    Batch memory b = XlnHanko.emptyBatch();
    b.collateralToReserve = new CollateralToReserve[](1);
    b.collateralToReserve[0] = CollateralToReserve({
      counterparty: other,
      tokenId: t,
      amount: amount,
      nonce: nonce,
      sig: _hanko(cp, h)
    });
    if (_submit(from, b)) _bump("collateralToReserve");
  }

  /// @notice Signed bilateral settlement. `leftDiff + rightDiff + collateralDiff == 0`
  ///         is a contract-side requirement, so the handler emits balanced diffs
  ///         and lets the Depository police the balances.
  function settle(
    uint256 fromSeed,
    uint256 cpSeed,
    uint256 tokenSeed,
    int256 leftDiff,
    int256 collateralDiff,
    bool forgive
  ) external {
    (uint256 from, uint256 cp) = _distinct(fromSeed, cpSeed);
    uint256 t = _token(tokenSeed);
    bytes32 me = entityOf[from];
    bytes32 other = entityOf[cp];
    (bytes32 left, bytes32 right) = me < other ? (me, other) : (other, me);

    leftDiff = bound(leftDiff, -1e21, 1e21);
    collateralDiff = bound(collateralDiff, -1e21, 1e21);

    SettlementDiff[] memory diffs = new SettlementDiff[](1);
    diffs[0] = SettlementDiff({
      tokenId: t,
      leftDiff: leftDiff,
      rightDiff: -leftDiff - collateralDiff,
      collateralDiff: collateralDiff,
      ondeltaDiff: collateralDiff
    });

    uint256[] memory forgiveIds = new uint256[](forgive ? 1 : 0);
    if (forgive) forgiveIds[0] = t;

    bytes memory key = XlnHanko.accountKey(me, other);
    uint256 nonce = _accountNonce(me, other) + 1;
    bytes32 h = XlnHanko.cooperativeUpdateHash(address(dep), key, nonce, diffs, forgiveIds);

    Batch memory b = XlnHanko.emptyBatch();
    b.settlements = new Settlement[](1);
    b.settlements[0] = Settlement({
      leftEntity: left,
      rightEntity: right,
      diffs: diffs,
      forgiveDebtsInTokenIds: forgiveIds,
      sig: _hanko(cp, h),
      nonce: nonce
    });
    if (_submit(from, b)) _bump("settle");
  }

  // ── flashloans ──

  /// @dev Builds a counterparty-signed C2R leg pulling `amount` out of collateral.
  function _c2rLeg(uint256 from, uint256 cp, uint256 t, uint256 amount)
    internal view returns (CollateralToReserve memory leg)
  {
    bytes32 me = entityOf[from];
    bytes32 other = entityOf[cp];
    bool isLeft = me < other;
    int256 signedAmount = int256(amount);
    SettlementDiff[] memory diffs = new SettlementDiff[](1);
    diffs[0] = SettlementDiff({
      tokenId: t,
      leftDiff: isLeft ? signedAmount : int256(0),
      rightDiff: isLeft ? int256(0) : signedAmount,
      collateralDiff: -signedAmount,
      ondeltaDiff: isLeft ? -signedAmount : int256(0)
    });
    uint256 nonce = _accountNonce(me, other) + 1;
    bytes32 h = XlnHanko.cooperativeUpdateHash(
      address(dep), XlnHanko.accountKey(me, other), nonce, diffs, new uint256[](0)
    );
    leg = CollateralToReserve({
      counterparty: other, tokenId: t, amount: amount, nonce: nonce, sig: _hanko(cp, h)
    });
  }

  /// @notice A flashloan can only clear if the same batch brings real value in.
  ///         Repayment source here is a collateral withdrawal, and the loan is
  ///         split across several entries on the SAME tokenId so the aggregation
  ///         at Depository.sol:485-504 is under test on every call.
  ///
  ///         Oracle: the borrower's reserve may grow by at most the amount
  ///         actually pulled out of collateral. Any excess is flash-minted value
  ///         that survived the burn.
  function flashloanRepaidByCollateral(
    uint256 fromSeed,
    uint256 cpSeed,
    uint256 tokenSeed,
    uint256 loan,
    uint256 pull,
    uint256 parts
  ) external {
    (uint256 from, uint256 cp) = _distinct(fromSeed, cpSeed);
    uint256 t = _token(tokenSeed);
    uint256 col = _collateral(entityOf[from], entityOf[cp], t);
    if (col == 0) return;

    pull = bound(pull, 1, col);
    loan = bound(loan, 1, 1e24);
    uint256 n = bound(parts, 1, 4);

    Batch memory b = XlnHanko.emptyBatch();
    b.flashloans = new Flashloan[](n);
    uint256 assigned;
    for (uint256 i = 0; i < n; i++) {
      uint256 slice = i == n - 1 ? loan - assigned : loan / n;
      assigned += slice;
      b.flashloans[i] = Flashloan({ tokenId: t, amount: slice });
    }
    b.collateralToReserve = new CollateralToReserve[](1);
    b.collateralToReserve[0] = _c2rLeg(from, cp, t, pull);

    uint256 pre = _reserve(from, t);
    if (_submit(from, b)) {
      _bump("flashloanRepaidByCollateral");
      if (_reserve(from, t) > pre + pull) flashloanViolations++;
    }
  }

  /// @notice Same idea, repaid by a real external deposit, and with the borrowed
  ///         token simultaneously routed into collateral in the same batch
  ///         (task item 2: flashloan ∩ reserve-to-collateral).
  function flashloanIntoCollateral(
    uint256 actorSeed,
    uint256 cpSeed,
    bool useA,
    uint256 loanAmount,
    uint256 collateralAmount,
    uint256 depositAmount
  ) external {
    (uint256 a, uint256 cp) = _distinct(actorSeed, cpSeed);
    ERC20Mock tok = useA ? tokenA : tokenB;
    uint256 t = useA ? 1 : 2;
    loanAmount = bound(loanAmount, 1, 1e24);
    collateralAmount = bound(collateralAmount, 0, loanAmount);
    depositAmount = bound(depositAmount, 0, 1e24);

    address caller = vm.addr(pk[a]);
    tok.mint(caller, depositAmount);
    vm.prank(caller);
    tok.approve(address(dep), depositAmount);

    Batch memory b = XlnHanko.emptyBatch();
    b.flashloans = new Flashloan[](2);
    b.flashloans[0] = Flashloan({ tokenId: t, amount: loanAmount });
    b.flashloans[1] = Flashloan({ tokenId: t, amount: 0 }); // duplicate id, zero slice
    b.externalTokenToReserve = new ExternalTokenToReserve[](1);
    b.externalTokenToReserve[0] = ExternalTokenToReserve({
      entity: entityOf[a],
      contractAddress: address(tok),
      externalTokenId: 0,
      tokenType: 0,
      internalTokenId: t,
      amount: depositAmount
    });
    b.reserveToCollateral = new ReserveToCollateral[](1);
    EntityAmount[] memory pairs = new EntityAmount[](1);
    pairs[0] = EntityAmount({ entity: entityOf[cp], amount: collateralAmount });
    b.reserveToCollateral[0] = ReserveToCollateral({
      tokenId: t, receivingEntity: entityOf[a], pairs: pairs
    });

    uint256 pre = _reserve(a, t);

    bytes memory encoded = abi.encode(b);
    uint256 nonce = dep.entityNonces(entityOf[a]) + 1;
    bytes32 h = XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), encoded, nonce);
    vm.prank(caller);
    try dep.processBatch(encoded, _hanko(a, h), nonce) {
      _bump("flashloanIntoCollateral");
      // Reserve may grow by the deposit only; the loan must be fully burned.
      if (_reserve(a, t) > pre + depositAmount) flashloanViolations++;
    } catch {}
  }

  // ── external token flows ──

  function depositExternal(uint256 actorSeed, bool useA, uint256 amount) external {
    uint256 a = _actor(actorSeed);
    ERC20Mock tok = useA ? tokenA : tokenB;
    uint256 t = useA ? 1 : 2;
    amount = bound(amount, 1, 1e24);

    address caller = vm.addr(pk[a]);
    tok.mint(caller, amount);
    vm.prank(caller);
    tok.approve(address(dep), amount);

    Batch memory b = XlnHanko.emptyBatch();
    b.externalTokenToReserve = new ExternalTokenToReserve[](1);
    b.externalTokenToReserve[0] = ExternalTokenToReserve({
      entity: entityOf[a],
      contractAddress: address(tok),
      externalTokenId: 0,
      tokenType: 0,
      internalTokenId: t,
      amount: amount
    });

    bytes memory encoded = abi.encode(b);
    uint256 nonce = dep.entityNonces(entityOf[a]) + 1;
    bytes32 h = XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), encoded, nonce);
    vm.prank(caller); // transferFrom pulls from msg.sender
    try dep.processBatch(encoded, _hanko(a, h), nonce) { _bump("depositExternal"); } catch {}
  }

  function withdrawExternal(uint256 actorSeed, bool useA, uint256 amount) external {
    uint256 a = _actor(actorSeed);
    uint256 t = useA ? 1 : 2;
    amount = bound(amount, 1, _reserve(a, t) + 1);

    Batch memory b = XlnHanko.emptyBatch();
    b.reserveToExternalToken = new ReserveToExternalToken[](1);
    b.reserveToExternalToken[0] = ReserveToExternalToken({
      receivingEntity: bytes32(uint256(uint160(vm.addr(pk[a])))),
      tokenId: t,
      amount: amount
    });
    if (_submit(a, b)) _bump("withdrawExternal");
  }

  // ── debt ──

  function pokeEnforceDebts(uint256 actorSeed, uint256 tokenSeed, uint256 maxIterations) external {
    uint256 a = _actor(actorSeed);
    uint256 t = _token(tokenSeed);
    maxIterations = bound(maxIterations, 0, 64);
    try dep.enforceDebts(entityOf[a], t, maxIterations) { _bump("pokeEnforceDebts"); _observeDebt(); } catch {}
  }

  // ── disputes ──

  function _proofBody(bytes32 watchSeed, uint256 tokenId, int256 offdelta)
    internal pure returns (ProofBody memory pb)
  {
    pb.watchSeed = watchSeed;
    pb.offdeltas = new int256[](1);
    pb.offdeltas[0] = offdelta;
    pb.tokenIds = new uint256[](1);
    pb.tokenIds[0] = tokenId;
    pb.transformers = new TransformerClause[](0);
  }

  function disputeStart(
    uint256 fromSeed,
    uint256 cpSeed,
    uint256 tokenSeed,
    int256 offdelta,
    uint256 seedNoise
  ) external {
    (uint256 from, uint256 cp) = _distinct(fromSeed, cpSeed);
    uint256 t = _token(tokenSeed);
    bytes32 me = entityOf[from];
    bytes32 other = entityOf[cp];
    offdelta = bound(offdelta, -1e21, 1e21);

    bytes32 watchSeed = keccak256(abi.encodePacked("watch", seedNoise));
    ProofBody memory pb = _proofBody(watchSeed, t, offdelta);
    bytes32 pbHash = keccak256(abi.encode(pb));

    bytes memory key = XlnHanko.accountKey(me, other);
    uint256 nonce = _accountNonce(me, other) + 1;
    bytes32 h = XlnHanko.disputeProofHash(address(dep), key, nonce, pbHash, watchSeed);

    Batch memory b = XlnHanko.emptyBatch();
    b.disputeStarts = new InitialDisputeProof[](1);
    b.disputeStarts[0] = InitialDisputeProof({
      counterentity: other,
      nonce: nonce,
      proofbodyHash: pbHash,
      initialProofbody: pb,
      watchSeed: watchSeed,
      sig: _hanko(cp, h),
      starterInitialArguments: "",
      starterIncrementedArguments: ""
    });

    uint256 pi = pairIndex(from, cp);
    bool wasActive = disputes[pi].active && _disputeHash(me, other) != bytes32(0);

    if (_submit(from, b)) {
      _bump("disputeStart");
      // Oracle: a dispute must never be startable on top of a live one.
      if (wasActive) disputeOverwriteViolations++;
      disputes[pi] = DisputeGhost({
        active: true,
        starter: from,
        counter: cp,
        startedByLeft: me < other,
        startBlock: vm.getBlockNumber(),
        startTimestamp: vm.getBlockTimestamp(),
        nonce: nonce,
        proofbodyHash: pbHash,
        watchSeed: watchSeed,
        tokenId: t,
        offdelta: offdelta
      });
    }
  }

  /// @notice Unilateral timeout finalization on the initial proof body.
  /// @param bySeed 0 => starter finalizes (must wait out defaultDisputeDelay),
  ///               1 => counterparty finalizes (allowed immediately by design).
  function disputeFinalizeTimeout(uint256 pairSeed, uint256 bySeed) external {
    uint256 pi = pairSeed % PAIRS;
    // Bias towards a live dispute: an unbiased pick almost always lands on a
    // pair that never disputed, which would make this action dead weight.
    if (!disputes[pi].active) {
      for (uint256 k = 0; k < PAIRS; k++) {
        uint256 cand = (pi + k) % PAIRS;
        if (disputes[cand].active) { pi = cand; break; }
      }
    }
    DisputeGhost memory g = disputes[pi];
    if (g.startBlock == 0) return; // never started

    bool byStarter = bySeed % 2 == 0;
    uint256 caller = byStarter ? g.starter : g.counter;
    bytes32 me = entityOf[caller];
    bytes32 other = entityOf[byStarter ? g.counter : g.starter];

    ProofBody memory pb = _proofBody(g.watchSeed, g.tokenId, g.offdelta);

    Batch memory b = XlnHanko.emptyBatch();
    b.disputeFinalizations = new FinalDisputeProof[](1);
    b.disputeFinalizations[0] = FinalDisputeProof({
      counterentity: other,
      initialNonce: g.nonce,
      finalNonce: g.nonce,
      initialProofbodyHash: g.proofbodyHash,
      finalProofbody: pb,
      starterArguments: "",
      otherArguments: "",
      sig: "",
      startedByLeft: g.startedByLeft,
      cooperative: false
    });

    bool wasActive = g.active && _disputeHash(me, other) != bytes32(0);
    bool wasEarly = vm.getBlockNumber() < g.startBlock + DISPUTE_DELAY;
    if (byStarter && wasEarly && wasActive) starterEarlyFinalizeAttempts++;

    if (_submit(caller, b)) {
      _bump("disputeFinalizeTimeout");
      // Oracle 1: the starter may not finalize before the delay elapsed.
      if (byStarter) {
        if (wasEarly) disputeEarlyFinalizeViolations++;
        else starterTimeoutFinalizes++;
      } else {
        counterpartyTimeoutFinalizes++;
      }
      // Oracle 2: the same dispute may not be finalized twice.
      if (!wasActive) disputeDoubleFinalizeViolations++;
      disputes[pi].active = false;
      _observeDebt();
    }
  }

  /// @notice Cooperative close signed by the counterparty at a strictly newer nonce.
  function disputeFinalizeCooperative(
    uint256 fromSeed,
    uint256 cpSeed,
    uint256 tokenSeed,
    int256 offdelta,
    uint256 seedNoise
  ) external {
    (uint256 from, uint256 cp) = _distinct(fromSeed, cpSeed);
    uint256 t = _token(tokenSeed);
    bytes32 me = entityOf[from];
    bytes32 other = entityOf[cp];
    offdelta = bound(offdelta, -1e21, 1e21);

    uint256 storedNonce = _accountNonce(me, other);
    if (storedNonce == 0) return; // cooperative path requires a live account

    ProofBody memory pb = _proofBody(keccak256(abi.encodePacked("coop", seedNoise)), t, offdelta);
    bytes32 pbHash = keccak256(abi.encode(pb));

    bytes memory key = XlnHanko.accountKey(me, other);
    uint256 finalNonce = storedNonce + 1;
    bytes32 h = XlnHanko.cooperativeDisputeProofHash(
      address(dep), key, finalNonce, pbHash, keccak256("")
    );

    Batch memory b = XlnHanko.emptyBatch();
    b.disputeFinalizations = new FinalDisputeProof[](1);
    b.disputeFinalizations[0] = FinalDisputeProof({
      counterentity: other,
      initialNonce: storedNonce,
      finalNonce: finalNonce,
      initialProofbodyHash: bytes32(0),
      finalProofbody: pb,
      starterArguments: "",
      otherArguments: "",
      sig: _hanko(cp, h),
      startedByLeft: other < me,
      cooperative: true
    });

    uint256 pi = pairIndex(from, cp);
    if (_submit(from, b)) {
      _bump("disputeFinalizeCooperative");
      disputes[pi].active = false;
    }
  }

  /// @notice One scripted dispute lifecycle: start, attempt an early starter
  ///          finalization (must be rejected), advance past the delay, then
  ///          finalize legally. Without this the starter branch of invariant 4a
  ///          is reachable only by a rare selector ordering, and a green result
  ///          would mean nothing.
  function disputeFullCycle(
    uint256 fromSeed,
    uint256 cpSeed,
    uint256 tokenSeed,
    int256 offdelta,
    uint256 seedNoise
  ) external {
    (uint256 from, uint256 cp) = _distinct(fromSeed, cpSeed);
    uint256 t = _token(tokenSeed);
    bytes32 me = entityOf[from];
    bytes32 other = entityOf[cp];
    if (_disputeHash(me, other) != bytes32(0)) return; // already disputing
    offdelta = bound(offdelta, -1e21, 1e21);

    bytes32 watchSeed = keccak256(abi.encodePacked("cycle", seedNoise));
    ProofBody memory pb = _proofBody(watchSeed, t, offdelta);
    bytes32 pbHash = keccak256(abi.encode(pb));
    bytes memory key = XlnHanko.accountKey(me, other);
    uint256 nonce = _accountNonce(me, other) + 1;
    bool startedByLeft = me < other;

    Batch memory start = XlnHanko.emptyBatch();
    start.disputeStarts = new InitialDisputeProof[](1);
    start.disputeStarts[0] = InitialDisputeProof({
      counterentity: other,
      nonce: nonce,
      proofbodyHash: pbHash,
      initialProofbody: pb,
      watchSeed: watchSeed,
      sig: _hanko(cp, XlnHanko.disputeProofHash(address(dep), key, nonce, pbHash, watchSeed)),
      starterInitialArguments: "",
      starterIncrementedArguments: ""
    });
    if (!_submit(from, start)) return;
    _bump("disputeStart");
    uint256 startBlock = vm.getBlockNumber();

    Batch memory fin = XlnHanko.emptyBatch();
    fin.disputeFinalizations = new FinalDisputeProof[](1);
    fin.disputeFinalizations[0] = FinalDisputeProof({
      counterentity: other,
      initialNonce: nonce,
      finalNonce: nonce,
      initialProofbodyHash: pbHash,
      finalProofbody: pb,
      starterArguments: "",
      otherArguments: "",
      sig: "",
      startedByLeft: startedByLeft,
      cooperative: false
    });

    // Step 1: the starter tries to finalize immediately. This must fail.
    starterEarlyFinalizeAttempts++;
    if (_submit(from, fin)) {
      disputeEarlyFinalizeViolations++;
      _observeDebt();
      return;
    }

    // Step 2: wait out the delay, then finalize legally.
    vm.roll(startBlock + DISPUTE_DELAY);
    vm.warp(vm.getBlockTimestamp() + DISPUTE_DELAY * 12);
    if (_submit(from, fin)) {
      _bump("disputeFullCycle");
      starterTimeoutFinalizes++;
      _observeDebt();
      // Step 3: the same dispute must not finalize a second time.
      if (_submit(from, fin)) disputeDoubleFinalizeViolations++;
    }
  }

  // ── time ──

  /// @notice Rolls exactly to a live dispute's timeout. Without this the
  ///         *legal* starter finalization is statistically unreachable, and
  ///         invariant_disputeNotFinalizableEarly would be vacuously green.
  function advancePastDisputeDelay(uint256 pairSeed) external {
    uint256 startAt = pairSeed % PAIRS;
    for (uint256 k = 0; k < PAIRS; k++) {
      uint256 pi = (startAt + k) % PAIRS;
      DisputeGhost memory g = disputes[pi];
      if (!g.active) continue;
      uint256 target = g.startBlock + DISPUTE_DELAY;
      if (vm.getBlockNumber() >= target) return;
      vm.roll(target);
      vm.warp(vm.getBlockTimestamp() + DISPUTE_DELAY * 12);
      _bump("advancePastDisputeDelay");
      return;
    }
  }

  function advance(uint256 blocks_, uint256 secs) external {
    blocks_ = bound(blocks_, 1, 200);
    secs = bound(secs, 1, 2000);
    // vm.getBlockNumber/Timestamp rather than block.number/timestamp: under
    // via_ir the opcodes get hoisted and the cheatcode write is lost.
    vm.roll(vm.getBlockNumber() + blocks_);
    vm.warp(vm.getBlockTimestamp() + secs);
    _bump("advance");
  }
}
