// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import "../../../contracts/Depository.sol";
import "../../../contracts/EntityProvider.sol";
import "../../../contracts/Types.sol";
import {XlnHanko} from "../helpers/XlnHanko.sol";

/// @notice Stateful handler for DebtLifecycle.invariants.t.sol (C4 hardening
///         wave 2, audit gaps A1-A3): the debt lifecycle is GENERATED, not
///         avoided.
///
/// The wave-1 conservation model could never move debt because no handler
/// ever finalized a dispute or signed a forgiveness (c4-adversary A1/A3).
/// This handler drives exactly those paths against the real bytecode:
///
/// - `openDebtDispute` + `finalizeDebtDispute`: a signed ProofBody whose
///   delta sits beyond collateral+spendable, so Depository._settleShortfall
///   (Depository.sol:1055-1070) books the uncovered remainder as a new Debt
///   via _addDebt (:608) — debts now EXIST in the model.
/// - `enforceDebt`: the public `enforceDebts` entry (Depository.sol:748)
///   against a non-empty queue, including partial enforcement through a
///   small maxIterations cap (Account.sol:160-229).
/// - `forgiveDebt`: a cooperative settlement carrying a non-empty
///   `forgiveDebtsInTokenIds`, exercising the O(1) single-cursor-head
///   forgiveness admission (Depository.sol:514-529 → :833-858) including the
///   third-party-FIFO-head E2 guard at :527.
/// - `mint`, `seedCollateral`, `spend`: reserve/collateral shaping so both
///   shortfall branches (Δ<0 on LEFT, Δ>collateral on RIGHT) and the implicit
///   `enforceDebts` inside every spendable-gated leg are reached.
///
/// Ghost model (mirrors real accounting, verified against the contracts):
/// - Per (debtor, token) the handler keeps an independent FIFO ghost queue
///   {creditor, amount}[] + cursor, updated by an exact simulation of
///   Account.enforceDebts and of the O(1) forgiveness semantics. The suite
///   asserts ghost == real chain queue element-wise (bidirectional oracle).
/// - `spendable` is invariant under enforcement (reserve and outstanding
///   decrease by the same paid amount; when outstanding > reserve the drain
///   stops at zero reserve), so shortfall predictions read pre-call state.
/// - The finalize prediction is recomputed at finalize time from the CURRENT
///   ondelta/collateral (prepareSettlementDeltas reads live storage, and R2C
///   may legitimately grow collateral while the dispute is live), from the
///   offdelta fixed at dispute start.
/// - Lifecycle flow conservation: ghostDebtCreated == ghostLive + ghostRepaid
///   + ghostForgiven (every booked debt is outstanding, repaid, or forgiven).
contract DebtLifecycleHandler is CommonBase, StdCheats, StdUtils {
  uint256 public constant ACTORS = 4;
  uint256 public constant PAIRS = 6; // C(4,2)
  uint32 public constant LEFT_RESPONSE_SECONDS = 50;
  uint32 public constant RIGHT_RESPONSE_SECONDS = 50;
  uint256 public constant DISPUTE_WINDOW_SECONDS =
    uint256(LEFT_RESPONSE_SECONDS) + uint256(RIGHT_RESPONSE_SECONDS);
  /// @dev Depository.DEBT_ENFORCEMENT_CHUNK (private constant, mirrored).
  uint256 private constant DEBT_ENFORCEMENT_CHUNK = 32;

  Depository public immutable dep;
  address public immutable admin;

  uint256[2] public TOKENS = [uint256(1), uint256(3)];

  uint256[ACTORS] internal pk;
  bytes32[ACTORS] public entityOf;

  // ── ghost accounting ──
  mapping(uint256 => uint256) public ghostMinted; // tokenId => admin-minted total
  mapping(uint256 => uint256) public ghostLiveDebt; // tokenId => Σ live debt amount
  uint256 public ghostDebtCreated; // Σ booked debt amount
  uint256 public ghostDebtRepaid; // Σ enforced/paid debt amount
  uint256 public ghostDebtForgiven; // Σ forgiven debt amount

  /// @dev Independent FIFO mirror of Depository._debts/_debtIndex per
  ///      (actor, token). Simulated without reading the chain queue.
  struct GhostDebt {
    bytes32 creditor;
    uint256 amount;
  }
  struct DebtQueue {
    GhostDebt[] queue;
    uint256 cursor;
  }
  mapping(uint256 => mapping(uint256 => DebtQueue)) internal debtGhosts;

  // ── handler-side oracles ──
  /// @dev A debt-lifecycle action (finalize/enforce/forgive/spend/seed)
  ///      moved Σreserves+Σcollateral for any token, or failed to consume
  ///      the account collateral it must consume.
  uint256 public debtPoolViolations;
  /// @dev Post-action real-vs-ghost debt book mismatch (outstanding, active
  ///      count, queue contents, cursor).
  uint256 public bookDesyncs;
  /// @dev Accepted forgiveness did not forgive exactly the predicted heads.
  uint256 public forgivenessDesyncs;
  /// @dev A finalize created debt != predicted uncovered shortfall remainder.
  uint256 public shortfallDesyncs;
  /// @dev debtOutstanding rose outside a finalize action.
  uint256 public foreignDebtCreation;

  // coverage counters
  uint256 public disputesStarted;
  uint256 public disputesFinalized;
  uint256 public debtsCreated; // count of _addDebt bookings
  uint256 public debtsPaidOff; // finalize-time coverage of existing debt
  uint256 public forgivenessSettlements; // accepted
  uint256 public e2GuardedForgivenessRejections;
  uint256 public enforcementCalls;
  uint256 public partialEnforcements; // enforcement that stopped early
  mapping(bytes32 => uint256) public calls;

  struct DisputeGhost {
    bool active;
    uint256 starter; // actor index (submitted the start batch)
    uint256 counter; // actor index (signed the initial proof)
    bool startedByLeft; // starter is the left entity
    bool proposerIsLeft; // initial proof author is the left entity
    uint256 startTimestamp;
    uint256 nonce;
    bytes32 proofbodyHash;
    bytes32 watchSeed;
    uint256 tokenId;
    int256 offdelta; // signed at start; ondelta is read live at finalize
  }
  mapping(uint256 => DisputeGhost) public disputes;

  constructor(Depository _dep, uint256[ACTORS] memory _pk, address _admin) {
    dep = _dep;
    admin = _admin;
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
    return TOKENS[seed % 2];
  }

  function _distinct(uint256 seedA, uint256 seedB) internal pure returns (uint256 a, uint256 b) {
    a = _actor(seedA);
    b = _actor(seedB);
    if (a == b) b = (b + 1) % ACTORS;
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

  function _submit(uint256 actor, Batch memory batch) internal returns (bool ok) {
    bytes memory encoded = abi.encode(batch);
    uint256 nonce = dep.entityNonces(entityOf[actor]) + 1;
    bytes32 h = XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), encoded, nonce);
    try dep.processBatch(encoded, _hanko(actor, h), nonce) {
      return true;
    } catch {
      return false;
    }
  }

  function pairIndex(uint256 a, uint256 b) public pure returns (uint256) {
    (uint256 lo, uint256 hi) = a < b ? (a, b) : (b, a);
    if (lo == 0) return hi - 1;
    if (lo == 1) return 2 + hi - 1;
    return 5;
  }

  function _reserve(uint256 actor, uint256 tokenId) internal view returns (uint256) {
    return dep._reserves(entityOf[actor], tokenId);
  }

  function _collateral(bytes32 e1, bytes32 e2, uint256 tokenId) internal view returns (uint256 c) {
    (c,) = dep._collaterals(XlnHanko.accountKey(e1, e2), tokenId);
  }

  function _ondelta(bytes32 e1, bytes32 e2, uint256 tokenId) internal view returns (int256 d) {
    (, d) = dep._collaterals(XlnHanko.accountKey(e1, e2), tokenId);
  }

  function _accountNonce(bytes32 e1, bytes32 e2) internal view returns (uint256 n) {
    (n, , , , , , , , , , , , , , ) = dep._accounts(XlnHanko.accountKey(e1, e2));
  }

  function _disputeHash(bytes32 e1, bytes32 e2) internal view returns (bytes32 h) {
    (, h, , , , , , , , , , , , , ) = dep._accounts(XlnHanko.accountKey(e1, e2));
  }

  function _totalInternal(uint256 tokenId) internal view returns (uint256 total) {
    for (uint256 i = 0; i < ACTORS; i++) {
      total += dep._reserves(entityOf[i], tokenId);
    }
    for (uint256 i = 0; i < ACTORS; i++) {
      for (uint256 j = i + 1; j < ACTORS; j++) {
        (uint256 c,) = dep._collaterals(XlnHanko.accountKey(entityOf[i], entityOf[j]), tokenId);
        total += c;
      }
    }
  }

  // ── ghost queue simulation ──

  function _ghostOutstanding(uint256 a, uint256 t) internal view returns (uint256 sum) {
    GhostDebt[] memory q = debtGhosts[a][t].queue;
    for (uint256 i = 0; i < q.length; i++) {
      if (q[i].amount != 0) sum += q[i].amount;
    }
  }

  function _ghostActiveCount(uint256 a, uint256 t) internal view returns (uint256 count) {
    GhostDebt[] memory q = debtGhosts[a][t].queue;
    for (uint256 i = 0; i < q.length; i++) {
      if (q[i].amount != 0) count++;
    }
  }

  /// @dev Depository.activeDebts is one per-entity counter across ALL tokens.
  function _ghostActiveCountAll(uint256 a) internal view returns (uint256 count) {
    for (uint256 ti = 0; ti < 2; ti++) count += _ghostActiveCount(a, TOKENS[ti]);
  }

  /// @dev Exact simulation of Account.enforceDebts (Account.sol:160-229) on
  ///      the ghost queue, given the debtor's real reserve at call time.
  ///      Returns the total paid. Mirrors: zero-amount skip, full-reserve
  ///      availability, partial entry, chunk cap, cursor reset + queue
  ///      deletion once the cursor passes the end.
  function _ghostEnforce(uint256 a, uint256 t, uint256 maxIterations, uint256 available)
    internal
    returns (uint256 paidTotal)
  {
    DebtQueue storage g = debtGhosts[a][t];
    uint256 len = g.queue.length;
    if (len == 0) {
      g.cursor = 0;
      return 0;
    }
    uint256 cursor = g.cursor;
    if (cursor >= len) cursor = 0;
    uint256 iterationCap = maxIterations == 0 ? type(uint256).max : maxIterations;
    uint256 steps;
    while (cursor < len && steps < iterationCap) {
      steps++;
      uint256 amount = g.queue[cursor].amount;
      if (amount == 0) {
        cursor++;
        continue;
      }
      if (available == 0) break;
      uint256 pay = available < amount ? available : amount;
      available -= pay;
      amount -= pay;
      paidTotal += pay;
      if (amount == 0) {
        // Account.enforceDebts does `delete queue[cursor]`: BOTH the amount
        // and the creditor are zeroed, unlike forgiveness which keeps the
        // creditor on a forgiven head.
        delete g.queue[cursor];
        cursor++;
      } else {
        g.queue[cursor].amount = amount;
      }
    }
    if (cursor >= len) {
      g.cursor = 0;
      delete g.queue;
    } else {
      g.cursor = cursor;
    }
  }

  /// @dev Exact simulation of Depository._forgiveDebtsBetweenEntities
  ///      (:833-858): O(1), cursor-head only, only when the live head belongs
  ///      to `creditor`; the queue is deleted when the head was the last entry.
  function _ghostForgive(uint256 a, uint256 t, bytes32 creditor) internal returns (bool forgiven) {
    DebtQueue storage g = debtGhosts[a][t];
    uint256 len = g.queue.length;
    if (g.cursor >= len) return false;
    uint256 amount = g.queue[g.cursor].amount;
    if (amount == 0) return false;
    if (g.queue[g.cursor].creditor != creditor) return false;
    g.queue[g.cursor].amount = 0;
    if (g.cursor + 1 == len) {
      g.cursor = 0;
      delete g.queue;
    } else {
      g.cursor = g.cursor + 1;
    }
    return true;
  }

  // ── per-action real-vs-ghost book check ──

  function _checkBooks(uint256 a, uint256 t) internal {
    DebtQueue storage g = debtGhosts[a][t];
    uint256 len = g.queue.length;
    if (dep.debtOutstanding(entityOf[a], t) != _ghostOutstanding(a, t)) bookDesyncs++;
    if (dep.activeDebts(entityOf[a]) != _ghostActiveCountAll(a)) bookDesyncs++;
    if (len == 0) {
      if (dep._debtIndex(entityOf[a], t) != 0) bookDesyncs++;
      return;
    }
    if (dep._debtIndex(entityOf[a], t) != g.cursor) bookDesyncs++;
    for (uint256 i = 0; i < len; i++) {
      try dep._debts(entityOf[a], t, i) returns (bytes32 creditor, uint256 amount) {
        if (creditor != g.queue[i].creditor || amount != g.queue[i].amount) bookDesyncs++;
      } catch {
        bookDesyncs++; // real queue shorter than the ghost
      }
    }
  }

  /// @dev Snapshot + compare the per-token value pool around a debt action.
  struct PoolSnapshot {
    uint256 t1;
    uint256 t3;
  }

  function _poolNow() internal view returns (PoolSnapshot memory p) {
    p.t1 = _totalInternal(1);
    p.t3 = _totalInternal(3);
  }

  function _poolUnchanged(PoolSnapshot memory before_) internal {
    PoolSnapshot memory after_ = _poolNow();
    if (after_.t1 != before_.t1 || after_.t3 != before_.t3) debtPoolViolations++;
  }

  /// @dev debtOutstanding may rise only inside finalize (shortfall booking);
  ///      `baseline` is the post-implicit-enforcement expectation.
  function _bookForeignIncreases(uint256 a, uint256 t, uint256 baseline) internal {
    if (dep.debtOutstanding(entityOf[a], t) > baseline) foreignDebtCreation++;
  }

  /// @dev A wrapping batch reverted: processBatch is atomic, so real state is
  ///      unchanged and the ghost must be rebuilt from the real queue.
  function _resyncGhostFromChain(uint256 a, uint256 t) internal {
    DebtQueue storage g = debtGhosts[a][t];
    delete g.queue;
    for (uint256 i = 0; i < 256; i++) {
      try dep._debts(entityOf[a], t, i) returns (bytes32 creditor, uint256 amount) {
        g.queue.push(GhostDebt({ creditor: creditor, amount: amount }));
      } catch {
        break;
      }
    }
    g.cursor = dep._debtIndex(entityOf[a], t);
  }

  /// @dev Live head exists at the real cursor for (entity, token).
  function _headAlive(bytes32 e, uint256 t) internal view returns (bool alive) {
    uint256 cursor = dep._debtIndex(e, t);
    try dep._debts(e, t, cursor) returns (bytes32, uint256 amt) {
      if (amt > 0) alive = true;
    } catch {}
  }

  /// @dev Depository._forgiveDebtsBetweenEntities admission: the live cursor
  ///      head belongs exactly to `creditor`.
  function _headForgivable(bytes32 debtor, bytes32 creditor, uint256 t)
    internal view
    returns (bool forgivable, uint256 amount)
  {
    uint256 cursor = dep._debtIndex(debtor, t);
    try dep._debts(debtor, t, cursor) returns (bytes32 headCreditor, uint256 amt) {
      if (amt > 0 && headCreditor == creditor) {
        forgivable = true;
        amount = amt;
      }
    } catch {}
  }

  // ═══════════════════════════ actions ═══════════════════════════

  /// @notice Admin flash-funding of reserves (ghost-tracked; the only source
  ///         of new internal value in this model).
  function mint(uint256 actorSeed, uint256 tokenSeed, uint256 amount) external {
    uint256 a = _actor(actorSeed);
    uint256 t = _token(tokenSeed);
    amount = bound(amount, 1, 1e24);
    vm.prank(admin);
    try dep.mintToReserve(entityOf[a], t, amount) {
      ghostMinted[t] += amount;
      _bump("mint");
    } catch {}
  }

  /// @notice R2C so finalizes exercise both the split and the shortfall
  ///         branch. Implicit enforceDebts runs before the spendable check
  ///         (Depository.sol:773) — the ghost simulates it exactly.
  function seedCollateral(uint256 fromSeed, uint256 cpSeed, uint256 tokenSeed, uint256 amount)
    external
  {
    (uint256 from, uint256 cp) = _distinct(fromSeed, cpSeed);
    uint256 t = _token(tokenSeed);

    uint256 outstandingBefore = dep.debtOutstanding(entityOf[from], t);
    uint256 paid = _ghostEnforce(from, t, DEBT_ENFORCEMENT_CHUNK, _reserve(from, t));
    uint256 outstanding = _ghostOutstanding(from, t);
    uint256 reserve = _reserve(from, t) - paid;
    uint256 spendable = reserve > outstanding ? reserve - outstanding : 0;

    PoolSnapshot memory pool = _poolNow();
    Batch memory b = XlnHanko.emptyBatch();
    b.reserveToCollateral = new ReserveToCollateral[](1);
    EntityAmount[] memory pairs = new EntityAmount[](1);
    pairs[0] = EntityAmount({ entity: entityOf[cp], amount: bound(amount, 1, spendable + 1) });
    b.reserveToCollateral[0] =
      ReserveToCollateral({ tokenId: t, receivingEntity: entityOf[from], pairs: pairs });

    if (_submit(from, b)) {
      if (paid > 0) {
        ghostDebtRepaid += paid;
        ghostLiveDebt[t] -= paid;
      }
      _bump("seedCollateral");
      _poolUnchanged(pool);
      _bookForeignIncreases(from, t, outstandingBefore - paid);
      _checkBooks(from, t);
    } else {
      _resyncGhostFromChain(from, t);
    }
  }

  /// @notice Single-leg R2R: exercises the implicit enforceDebts + spendable
  ///         path (Depository.sol:739-745) with existing debt outstanding.
  function spend(uint256 fromSeed, uint256 toSeed, uint256 tokenSeed, uint256 amount) external {
    (uint256 from, uint256 to) = _distinct(fromSeed, toSeed);
    uint256 t = _token(tokenSeed);

    uint256 outstandingBefore = dep.debtOutstanding(entityOf[from], t);
    uint256 paid = _ghostEnforce(from, t, DEBT_ENFORCEMENT_CHUNK, _reserve(from, t));
    uint256 outstanding = _ghostOutstanding(from, t);
    uint256 reserve = _reserve(from, t) - paid;
    uint256 spendable = reserve > outstanding ? reserve - outstanding : 0;

    PoolSnapshot memory pool = _poolNow();
    Batch memory b = XlnHanko.emptyBatch();
    b.reserveToReserve = new ReserveToReserve[](1);
    b.reserveToReserve[0] = ReserveToReserve({
      receivingEntity: entityOf[to],
      tokenId: t,
      amount: bound(amount, 1, spendable + 1)
    });

    if (_submit(from, b)) {
      if (paid > 0) {
        ghostDebtRepaid += paid;
        ghostLiveDebt[t] -= paid;
      }
      _bump("spend");
      _poolUnchanged(pool);
      _bookForeignIncreases(from, t, outstandingBefore - paid);
      _checkBooks(from, t);
    } else {
      _resyncGhostFromChain(from, t);
    }
  }

  /// @notice Opens a dispute whose signed delta can land beyond the debtor's
  ///         collateral+spendable, so finalization books a shortfall debt
  ///         (or pays it down from reserve when the fuzzer keeps it small).
  function openDebtDispute(
    uint256 fromSeed,
    uint256 cpSeed,
    uint256 tokenSeed,
    uint256 magnitude,
    uint256 sideSeed,
    uint256 seedNoise
  ) external {
    (uint256 from, uint256 cp) = _distinct(fromSeed, cpSeed);
    if (_disputeHash(entityOf[from], entityOf[cp]) != bytes32(0)) return; // already live
    uint256 t = _token(tokenSeed);

    bytes32 me = entityOf[from];
    bytes32 other = entityOf[cp];
    bool iAmLeft = me < other;
    // Debtor side selection: LEFT debtor needs Δ < 0; RIGHT debtor needs
    // Δ > collateral. 2 of 3 picks force a magnitude beyond spendable so the
    // debt-creation path dominates; the third leaves small/no shortfall.
    bool debtorIsLeft = sideSeed % 2 == 0;
    bool forceShortfall = seedNoise % 3 != 0;

    int256 ondelta = _ondelta(me, other, t);
    uint256 collateral = _collateral(me, other, t);
    uint256 debtorActor = debtorIsLeft ? (iAmLeft ? from : cp) : (iAmLeft ? cp : from);
    uint256 spendable;
    {
      uint256 r = _reserve(debtorActor, t);
      uint256 o = dep.debtOutstanding(entityOf[debtorActor], t);
      spendable = r > o ? r - o : 0;
    }
    uint256 base =
      forceShortfall ? bound(magnitude, spendable + 1, spendable + 1e18) : bound(magnitude, 1, 1e21);

    int256 offdelta;
    if (debtorIsLeft) {
      // Δ = ondelta + offdelta = −base → LEFT owes `base`.
      offdelta = -int256(base) - ondelta;
    } else {
      // Δ = collateral + base → RIGHT owes `base` beyond the collateral.
      offdelta = int256(collateral) + int256(base) - ondelta;
    }

    bytes32 watchSeed = keccak256(abi.encodePacked("dl", seedNoise));
    ProofBody memory pb;
    pb.watchSeed = watchSeed;
    pb.leftResponseSeconds = LEFT_RESPONSE_SECONDS;
    pb.rightResponseSeconds = RIGHT_RESPONSE_SECONDS;
    pb.offdeltas = new int256[](1);
    pb.offdeltas[0] = offdelta;
    pb.tokenIds = new uint256[](1);
    pb.tokenIds[0] = t;
    pb.transformers = new TransformerClause[](0);
    bytes32 pbHash = keccak256(abi.encode(pb));

    uint256 nonce = _accountNonce(me, other) + 1;
    bool proposerIsLeft = other < me; // cp authored/signed the initial proof
    bytes32 h =
      XlnHanko.disputeProofHash(address(dep), XlnHanko.accountKey(me, other), nonce, proposerIsLeft, pbHash, watchSeed);

    Batch memory b = XlnHanko.emptyBatch();
    b.disputeStarts = new InitialDisputeProof[](1);
    b.disputeStarts[0] = InitialDisputeProof({
      counterentity: other,
      nonce: nonce,
      proposerIsLeft: proposerIsLeft,
      proofbodyHash: pbHash,
      initialProofbody: pb,
      watchSeed: watchSeed,
      sig: _hanko(cp, h),
      starterInitialArguments: "",
      starterCounterArguments: "",
      starterCounterProofCommitment: bytes32(0)
    });

    if (_submit(from, b)) {
      disputes[pairIndex(from, cp)] = DisputeGhost({
        active: true,
        starter: from,
        counter: cp,
        startedByLeft: iAmLeft,
        proposerIsLeft: proposerIsLeft,
        startTimestamp: vm.getBlockTimestamp(),
        nonce: nonce,
        proofbodyHash: pbHash,
        watchSeed: watchSeed,
        tokenId: t,
        offdelta: offdelta
      });
      disputesStarted++;
      _bump("openDebtDispute");
    }
  }

  /// @dev Rebuilds the exact committed initial ProofBody from the ghost.
  function _ghostProofBody(DisputeGhost memory g) internal view returns (ProofBody memory pb) {
    pb.watchSeed = g.watchSeed;
    pb.leftResponseSeconds = LEFT_RESPONSE_SECONDS;
    pb.rightResponseSeconds = RIGHT_RESPONSE_SECONDS;
    pb.offdeltas = new int256[](1);
    pb.offdeltas[0] = g.offdelta;
    pb.tokenIds = new uint256[](1);
    pb.tokenIds[0] = g.tokenId;
    pb.transformers = new TransformerClause[](0);
  }

  /// @notice Finalizes a live dispute: books the shortfall debt predicted by
  ///         the ghost (implicit chunked enforcement of existing debts first,
  ///         then pay-from-spendable, then _addDebt for the remainder). The
  ///         debtor side and magnitude are recomputed from CURRENT custody
  ///         because R2C may grow collateral while the dispute is live.
  function finalizeDebtDispute(uint256 pairSeed, uint256 bySeed) external {
    uint256 pi = pairSeed % PAIRS;
    if (!disputes[pi].active) {
      for (uint256 k = 0; k < PAIRS; k++) {
        uint256 cand = (pi + k) % PAIRS;
        if (disputes[cand].active) {
          pi = cand;
          break;
        }
      }
    }
    DisputeGhost memory g = disputes[pi];
    if (!g.active || g.startTimestamp == 0) return;
    bytes32 starterE = entityOf[g.starter];
    bytes32 counterE = entityOf[g.counter];
    if (_disputeHash(starterE, counterE) == bytes32(0)) return;

    bool byStarter = bySeed % 2 == 0;
    uint256 caller = byStarter ? g.starter : g.counter;
    // counterentity is the OTHER side of the finalizer, not a fixed dispute role.
    bytes32 otherE = caller == g.starter ? counterE : starterE;
    if (byStarter && vm.getBlockTimestamp() < g.startTimestamp + DISPUTE_WINDOW_SECONDS) {
      vm.warp(g.startTimestamp + DISPUTE_WINDOW_SECONDS);
    }

    // ── ghost prediction from observable pre-state ──
    uint256 t = g.tokenId;
    uint256 leftActor = g.startedByLeft ? g.starter : g.counter;
    uint256 rightActor = g.startedByLeft ? g.counter : g.starter;
    bytes32 leftE = entityOf[leftActor];
    bytes32 rightE = entityOf[rightActor];

    int256 delta = _ondelta(leftE, rightE, t) + g.offdelta; // LEFT's allocation
    uint256 collateralNow = _collateral(leftE, rightE, t);

    // Mirror Depository._applyAccountDelta branch selection (:1034-1049).
    uint256 debtorActor;
    uint256 creditorActor;
    uint256 magnitude; // uncovered shortfall after collateral
    if (delta < 0) {
      debtorActor = leftActor;
      creditorActor = rightActor;
      magnitude = uint256(-delta);
    } else if (uint256(delta) > collateralNow) {
      debtorActor = rightActor;
      creditorActor = leftActor;
      magnitude = uint256(delta) - collateralNow;
    } else {
      debtorActor = type(uint256).max; // split branch: no debt possible
      magnitude = 0;
    }

    uint256 paid;
    uint256 outstandingBefore;
    if (debtorActor != type(uint256).max) {
      outstandingBefore = dep.debtOutstanding(entityOf[debtorActor], t);
      paid = _ghostEnforce(debtorActor, t, DEBT_ENFORCEMENT_CHUNK, _reserve(debtorActor, t));
      uint256 outstanding = _ghostOutstanding(debtorActor, t);
      uint256 reserve = _reserve(debtorActor, t) - paid;
      uint256 spendable = reserve > outstanding ? reserve - outstanding : 0;
      uint256 payAmount = spendable > magnitude ? magnitude : spendable;
      magnitude = magnitude - payAmount; // remaining → _addDebt
    }

    ProofBody memory pb = _ghostProofBody(g);
    Batch memory b = XlnHanko.emptyBatch();
    b.disputeFinalizations = new FinalDisputeProof[](1);
    b.disputeFinalizations[0] = FinalDisputeProof({
      counterentity: otherE,
      initialNonce: g.nonce,
      finalNonce: g.nonce,
      proposerIsLeft: g.proposerIsLeft,
      initialProofbodyHash: g.proofbodyHash,
      finalProofbody: pb,
      starterArguments: "",
      otherArguments: "",
      sig: "",
      startedByLeft: g.startedByLeft,
      cooperative: false
    });

    PoolSnapshot memory pool = _poolNow();
    if (_submit(caller, b)) {
      disputes[pi].active = false;
      disputesFinalized++;
      _bump("finalizeDebtDispute");
      _poolUnchanged(pool);
      // Finalize consumes the account collateral exactly (ondelta reset).
      if (_collateral(leftE, rightE, t) != 0 || _ondelta(leftE, rightE, t) != 0) debtPoolViolations++;

      if (debtorActor != type(uint256).max) {
        if (paid > 0) {
          ghostDebtRepaid += paid;
          ghostLiveDebt[t] -= paid;
          debtsPaidOff++;
        }
        if (magnitude > 0) {
          debtGhosts[debtorActor][t].queue.push(
            GhostDebt({ creditor: entityOf[creditorActor], amount: magnitude })
          );
          ghostDebtCreated += magnitude;
          ghostLiveDebt[t] += magnitude;
          debtsCreated++;
        }
        if (dep.debtOutstanding(entityOf[debtorActor], t) != _ghostOutstanding(debtorActor, t)) {
          shortfallDesyncs++;
        }
        _bookForeignIncreases(debtorActor, t, outstandingBefore - paid + magnitude);
        _checkBooks(debtorActor, t);
        _checkBooks(creditorActor, t);
      }
    } else {
      if (debtorActor != type(uint256).max) _resyncGhostFromChain(debtorActor, t);
    }
  }

  /// @notice Direct public enforcement (Depository.enforceDebts is an
  ///         unauthenticated action, audit A12) against the existing queue,
  ///         including partial enforcement via small maxIterations caps.
  function enforceDebt(uint256 actorSeed, uint256 tokenSeed, uint256 capSeed) external {
    uint256 a = _actor(actorSeed);
    uint256 t = _token(tokenSeed);
    uint256 cap;
    uint256 pick = capSeed % 5;
    if (pick == 0) cap = 0; // uncapped drain
    else if (pick == 1) cap = 1; // partial: single entry per call
    else if (pick == 2) cap = 2;
    else cap = DEBT_ENFORCEMENT_CHUNK;

    uint256 paid = _ghostEnforce(a, t, cap, _reserve(a, t));

    PoolSnapshot memory pool = _poolNow();
    dep.enforceDebts(entityOf[a], t, cap);
    enforcementCalls++;
    _bump("enforceDebt");
    if (cap != 0 && cap < DEBT_ENFORCEMENT_CHUNK && _ghostCursorMidQueue(a, t)) partialEnforcements++;
    _poolUnchanged(pool);
    if (paid > 0) {
      ghostDebtRepaid += paid;
      ghostLiveDebt[t] -= paid;
    }
    _checkBooks(a, t);
  }

  /// @dev True when the ghost cursor still points inside a live queue.
  function _ghostCursorMidQueue(uint256 a, uint256 t) internal view returns (bool) {
    DebtQueue storage g = debtGhosts[a][t];
    return g.queue.length != 0 && g.cursor < g.queue.length;
  }

  /// @notice Cooperative settlement with a NON-EMPTY forgiveDebtsInTokenIds:
  ///         exercises the O(1) cursor-head forgiveness and the third-party
  ///         FIFO-head E2 admission guard (Depository.sol:514-529, :833-858).
  function forgiveDebt(uint256 fromSeed, uint256 cpSeed, uint256 tokenSeed, uint256 attemptSeed)
    external
  {
    (uint256 from, uint256 cp) = _distinct(fromSeed, cpSeed);
    bytes32 me = entityOf[from];
    bytes32 other = entityOf[cp];
    if (_disputeHash(me, other) != bytes32(0)) return; // settlement is E6 while live
    uint256 t = _token(tokenSeed);

    // Actor indexes do NOT order entities: canonical left/right is by entity id.
    uint256 leftActor = entityOf[from] < entityOf[cp] ? from : cp;
    uint256 rightActor = entityOf[from] < entityOf[cp] ? cp : from;
    bytes32 leftE = entityOf[leftActor];
    bytes32 rightE = entityOf[rightActor];

    // Predict admission from the real queue heads (what the parties read
    // off-chain): forgivable head on either side, or both queues headless.
    (bool leftForgivable, uint256 leftAmount) = _headForgivable(leftE, rightE, t);
    (bool rightForgivable, uint256 rightAmount) = _headForgivable(rightE, leftE, t);
    bool accepted = leftForgivable || rightForgivable || (!(_headAlive(leftE, t)) && !(_headAlive(rightE, t)));
    if (!accepted && attemptSeed % 2 == 1) {
      // Still exercise the E2 rejection path sometimes.
      e2GuardedForgivenessRejections++;
    }

    uint256 nonce = _accountNonce(me, other) + 1;
    uint256[] memory forgiveIds = new uint256[](1);
    forgiveIds[0] = t;
    SettlementDiff[] memory diffs = new SettlementDiff[](0);
    bytes32 h = XlnHanko.cooperativeUpdateHash(address(dep), XlnHanko.accountKey(me, other), nonce, diffs, forgiveIds);

    Batch memory b = XlnHanko.emptyBatch();
    b.settlements = new Settlement[](1);
    b.settlements[0] = Settlement({
      leftEntity: leftE,
      rightEntity: rightE,
      diffs: diffs,
      forgiveDebtsInTokenIds: forgiveIds,
      sig: _hanko(cp, h),
      nonce: nonce
    });

    PoolSnapshot memory pool = _poolNow();
    uint256 outstandingBefore = dep.debtOutstanding(leftE, t) + dep.debtOutstanding(rightE, t);
    if (_submit(from, b)) {
      forgivenessSettlements++;
      _bump("forgiveDebt");
      _poolUnchanged(pool);

      // Mirror the exact O(1) semantics on the ghost: left head first, then
      // right head, cursor-only, at most one entry per side per settlement.
      if (leftForgivable && !_ghostForgive(leftActor, t, rightE)) forgivenessDesyncs++;
      if (rightForgivable && !_ghostForgive(rightActor, t, leftE)) forgivenessDesyncs++;
      uint256 expectedForgiven = (leftForgivable ? leftAmount : 0) + (rightForgivable ? rightAmount : 0);
      uint256 outstandingAfter = dep.debtOutstanding(leftE, t) + dep.debtOutstanding(rightE, t);
      if (outstandingBefore - outstandingAfter != expectedForgiven) forgivenessDesyncs++;
      if (expectedForgiven > 0) {
        ghostDebtForgiven += expectedForgiven;
        ghostLiveDebt[t] -= expectedForgiven;
      }
      _checkBooks(leftActor, t);
      _checkBooks(rightActor, t);
    }
  }

  /// @notice Warps past a live dispute timeout so starter finalization works.
  function advancePastDisputeDelay(uint256 pairSeed) external {
    uint256 startAt = pairSeed % PAIRS;
    for (uint256 k = 0; k < PAIRS; k++) {
      uint256 pi = (startAt + k) % PAIRS;
      if (!disputes[pi].active) continue;
      uint256 target = disputes[pi].startTimestamp + DISPUTE_WINDOW_SECONDS;
      if (vm.getBlockTimestamp() >= target) return;
      vm.warp(target);
      return;
    }
  }

  function advance(uint256 blocks_, uint256 secs) external {
    blocks_ = bound(blocks_, 1, 200);
    secs = bound(secs, 1, 2000);
    vm.roll(vm.getBlockNumber() + blocks_);
    vm.warp(vm.getBlockTimestamp() + secs);
  }

  // ═══════════════════════════ verification ═══════════════════════════

  /// @dev Full ghost-vs-real comparison across every actor × token.
  function checkDebtBooks() external view returns (uint256 violations) {
    for (uint256 a = 0; a < ACTORS; a++) {
      for (uint256 ti = 0; ti < 2; ti++) {
        uint256 t = TOKENS[ti];
        DebtQueue storage g = debtGhosts[a][t];
        uint256 len = g.queue.length;
        if (dep.debtOutstanding(entityOf[a], t) != _ghostOutstanding(a, t)) violations++;
        if (dep.activeDebts(entityOf[a]) != _ghostActiveCountAll(a)) violations++;
        if (len == 0) {
          if (dep._debtIndex(entityOf[a], t) != 0) violations++;
          continue;
        }
        if (dep._debtIndex(entityOf[a], t) != g.cursor) violations++;
        for (uint256 i = 0; i < len; i++) {
          try dep._debts(entityOf[a], t, i) returns (bytes32 creditor, uint256 amount) {
            if (creditor != g.queue[i].creditor || amount != g.queue[i].amount) violations++;
          } catch {
            violations++;
          }
        }
      }
    }
  }

  /// @dev Σ real debtOutstanding per token, for the aggregate debt oracle.
  function realOutstandingTotal(uint256 t) external view returns (uint256 total) {
    for (uint256 a = 0; a < ACTORS; a++) {
      total += dep.debtOutstanding(entityOf[a], t);
    }
  }

  /// @dev Role-side assertion: every live dispute stored the signed response
  ///      windows on the correct left/right AccountInfo fields.
  function checkWindowSides() external view returns (uint256 violations) {
    for (uint256 pi = 0; pi < PAIRS; pi++) {
      DisputeGhost memory g = disputes[pi];
      if (!g.active) continue;
      (, , , , uint32 lrs, uint32 rrs, , , , , , , , , ) =
        dep._accounts(XlnHanko.accountKey(entityOf[g.starter], entityOf[g.counter]));
      if (lrs != LEFT_RESPONSE_SECONDS || rrs != RIGHT_RESPONSE_SECONDS) violations++;
    }
  }

  /// @dev Test-only ghost sabotage for the sensitivity meta-control.
  function sabotageGhostOutstanding(uint256 t, uint256 value) external {
    ghostLiveDebt[t] = value;
  }
}
