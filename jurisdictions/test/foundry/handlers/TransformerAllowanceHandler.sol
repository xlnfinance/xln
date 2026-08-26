// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import "../../../contracts/Depository.sol";
import "../../../contracts/EntityProvider.sol";
import "../../../contracts/Types.sol";
import {TransformerLivenessHarness} from "../../../contracts/mocks/TransformerLivenessHarness.sol";
import {XlnHanko} from "../helpers/XlnHanko.sol";

/// @notice Stateful handler for TransformerAllowance.invariants.t.sol.
///
/// Drives REAL dispute start + finalize cycles whose signed ProofBody carries a
/// TransformerClause against the adversarial TransformerLivenessHarness (the
/// frozen mock implementing the canonical applyBatch ABI), then reconstructs
/// the exact applied account delta from reserve/debt movement:
///
///   Δ_applied = Δreserve(left) - Δdebt(left) + Δdebt(right)
///
/// which holds for all three custody branches of
/// Depository._applyAccountDelta when no pre-existing debt exists (the handler
/// enforces that precondition before observing).
///
/// Oracles:
/// - Account.sol:996 gate: a transformer request that changes delta j survives
///   only if the clause carries an allowance for j.
/// - Account.sol:_clampTransformerValue: an allowanced change lands exactly on
///   clamp(requested, prev - rightAllowance, prev + leftAllowance).
/// - finalize never changes Σreserves + Σcollateral for any token.
contract TransformerAllowanceHandler is CommonBase, StdCheats, StdUtils {
  uint256 public constant ACTORS = 4;
  uint256 public constant PAIRS = 6; // C(4,2)
  uint32 public constant LEFT_RESPONSE_SECONDS = 50;
  uint32 public constant RIGHT_RESPONSE_SECONDS = 50;
  uint256 public constant DISPUTE_WINDOW_SECONDS =
    uint256(LEFT_RESPONSE_SECONDS) + uint256(RIGHT_RESPONSE_SECONDS);

  Depository public immutable dep;
  address public immutable admin;
  TransformerLivenessHarness public immutable transformer;

  uint256[2] public TOKENS = [uint256(1), uint256(3)];

  uint256[ACTORS] internal pk;
  bytes32[ACTORS] public entityOf;

  // ── ghost accounting ──
  mapping(uint256 => uint256) public ghostMinted;

  // ── handler-side oracles ──
  uint256 public unallowancedChangeViolations; // the Account.sol:996 gate
  uint256 public clampViolations; // applied delta != clamp(requested, band)
  uint256 public finalizeValueViolations; // finalize moved Σreserves+Σcollateral

  // coverage counters
  uint256 public disputesStarted;
  uint256 public acceptedFinalizes;
  uint256 public rejectedFinalizes;
  uint256 public clampObservations; // clean finals where the oracle ran
  uint256 public activeClamps; // of those, how many actually clamped
  uint256 public starterEarlyAttempts;

  struct DisputeGhost {
    bool active;
    uint256 starter; // actor index
    uint256 counter; // actor index
    bool startedByLeft;
    uint256 startTimestamp;
    uint256 nonce;
    bytes32 proofbodyHash;
    bytes32 watchSeed;
    uint256 tokenId;
    int256 offdelta;
    uint8 mode; // 0 = Add, 1 = Absolute
    int256 value;
    bool hasAllowance;
    uint256 rightAllowance;
    uint256 leftAllowance;
  }
  mapping(uint256 => DisputeGhost) public disputes;

  constructor(
    Depository _dep,
    uint256[ACTORS] memory _pk,
    address _admin,
    TransformerLivenessHarness _transformer
  ) {
    dep = _dep;
    admin = _admin;
    transformer = _transformer;
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

  function _proofBody(DisputeGhost memory g) internal view returns (ProofBody memory pb) {
    pb.watchSeed = g.watchSeed;
    pb.leftResponseSeconds = LEFT_RESPONSE_SECONDS;
    pb.rightResponseSeconds = RIGHT_RESPONSE_SECONDS;
    pb.offdeltas = new int256[](1);
    pb.offdeltas[0] = g.offdelta;
    pb.tokenIds = new uint256[](1);
    pb.tokenIds[0] = g.tokenId;
    pb.transformers = new TransformerClause[](1);
    Allowance[] memory allowances = new Allowance[](g.hasAllowance ? 1 : 0);
    if (g.hasAllowance) {
      allowances[0] = Allowance({
        deltaIndex: 0,
        rightAllowance: g.rightAllowance,
        leftAllowance: g.leftAllowance
      });
    }
    pb.transformers[0] = TransformerClause({
      transformerAddress: address(transformer),
      encodedBatch: transformer.encode(
        g.mode == 0 ? TransformerLivenessHarness.Mode.Add : TransformerLivenessHarness.Mode.Absolute,
        0,
        g.value,
        g.tokenId
      ),
      allowances: allowances
    });
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

  // ═══════════════════════════ actions ═══════════════════════════

  function mint(uint256 actorSeed, uint256 tokenSeed, uint256 amount) external {
    uint256 a = _actor(actorSeed);
    uint256 t = _token(tokenSeed);
    amount = bound(amount, 1, 1e24);
    vm.prank(admin);
    try dep.mintToReserve(entityOf[a], t, amount) {
      ghostMinted[t] += amount;
    } catch {}
  }

  /// @notice Seeds collateral so finalizations exercise the split branch.
  function seedCollateral(uint256 fromSeed, uint256 cpSeed, uint256 tokenSeed, uint256 amount) external {
    (uint256 from, uint256 cp) = _distinct(fromSeed, cpSeed);
    uint256 t = _token(tokenSeed);
    amount = bound(amount, 1, _reserve(from, t) + 1);

    Batch memory b = XlnHanko.emptyBatch();
    b.reserveToCollateral = new ReserveToCollateral[](1);
    EntityAmount[] memory pairs = new EntityAmount[](1);
    pairs[0] = EntityAmount({ entity: entityOf[cp], amount: amount });
    b.reserveToCollateral[0] = ReserveToCollateral({
      tokenId: t,
      receivingEntity: entityOf[from],
      pairs: pairs
    });
    _submit(from, b);
  }

  /// @notice Opens a dispute whose signed ProofBody carries one transformer
  ///         clause (Add or Absolute mode) with fuzzed allowance presence.
  function startTransformedDispute(
    uint256 fromSeed,
    uint256 cpSeed,
    uint256 tokenSeed,
    int256 offdelta,
    uint8 mode,
    int256 value,
    uint256 rightAllowance,
    uint256 leftAllowance,
    uint256 seedNoise
  ) external {
    (uint256 from, uint256 cp) = _distinct(fromSeed, cpSeed);
    if (_disputeHash(entityOf[from], entityOf[cp]) != bytes32(0)) return; // already live
    uint256 t = _token(tokenSeed);
    offdelta = bound(offdelta, -1e21, 1e21);
    value = bound(value, -1e21, 1e21);
    rightAllowance = bound(rightAllowance, 0, 2e21);
    leftAllowance = bound(leftAllowance, 0, 2e21);
    bool hasAllowance = seedNoise % 2 == 0;
    mode = mode % 2;

    DisputeGhost memory g = DisputeGhost({
      active: true,
      starter: from,
      counter: cp,
      startedByLeft: entityOf[from] < entityOf[cp],
      startTimestamp: 0,
      nonce: _accountNonce(entityOf[from], entityOf[cp]) + 1,
      proofbodyHash: bytes32(0),
      watchSeed: keccak256(abi.encodePacked("ta", seedNoise)),
      tokenId: t,
      offdelta: offdelta,
      mode: mode,
      value: value,
      hasAllowance: hasAllowance,
      rightAllowance: rightAllowance,
      leftAllowance: leftAllowance
    });
    ProofBody memory pb = _proofBody(g);
    bytes32 pbHash = keccak256(abi.encode(pb));

    bytes memory key = XlnHanko.accountKey(entityOf[from], entityOf[cp]);
    bool proposerIsLeft = entityOf[cp] < entityOf[from];
    bytes32 h = XlnHanko.disputeProofHash(address(dep), key, g.nonce, proposerIsLeft, pbHash, g.watchSeed);

    Batch memory b = XlnHanko.emptyBatch();
    b.disputeStarts = new InitialDisputeProof[](1);
    b.disputeStarts[0] = InitialDisputeProof({
      counterentity: entityOf[cp],
      nonce: g.nonce,
      proposerIsLeft: proposerIsLeft,
      proofbodyHash: pbHash,
      initialProofbody: pb,
      watchSeed: g.watchSeed,
      sig: _hanko(cp, h),
      starterInitialArguments: "",
      starterCounterArguments: "",
      starterCounterProofCommitment: bytes32(0)
    });

    if (_submit(from, b)) {
      g.proofbodyHash = pbHash;
      g.startTimestamp = vm.getBlockTimestamp();
      disputes[pairIndex(from, cp)] = g;
      disputesStarted++;
    }
  }

  /// @notice Finalizes a live transformed dispute (starter needs the timeout,
  ///         counterparty may accept the pull-free initial state immediately)
  ///         and observes the applied account delta.
  function finalizeTransformed(uint256 pairSeed, uint256 bySeed) external {
    uint256 pi = pairSeed % PAIRS;
    if (!disputes[pi].active) {
      for (uint256 k = 0; k < PAIRS; k++) {
        uint256 cand = (pi + k) % PAIRS;
        if (disputes[cand].active) { pi = cand; break; }
      }
    }
    DisputeGhost memory g = disputes[pi];
    if (g.startTimestamp == 0) return;

    bool byStarter = bySeed % 2 == 0;
    uint256 caller = byStarter ? g.starter : g.counter;
    bytes32 me = entityOf[caller];
    bytes32 other = entityOf[byStarter ? g.counter : g.starter];

    ProofBody memory pb = _proofBody(g);
    Batch memory b = XlnHanko.emptyBatch();
    b.disputeFinalizations = new FinalDisputeProof[](1);
    b.disputeFinalizations[0] = FinalDisputeProof({
      counterentity: other,
      initialNonce: g.nonce,
      finalNonce: g.nonce,
      proposerIsLeft: entityOf[g.counter] < entityOf[g.starter],
      initialProofbodyHash: g.proofbodyHash,
      finalProofbody: pb,
      starterArguments: "",
      otherArguments: "",
      sig: "",
      startedByLeft: g.startedByLeft,
      cooperative: false
    });

    // ── oracle pre-state ──
    (bytes32 leftE, bytes32 rightE) = me < other ? (me, other) : (other, me);
    uint256 leftActor;
    uint256 rightActor;
    for (uint256 i = 0; i < ACTORS; i++) {
      if (entityOf[i] == leftE) leftActor = i;
      if (entityOf[i] == rightE) rightActor = i;
    }
    bool clean =
      dep.debtOutstanding(leftE, g.tokenId) == 0 && dep.debtOutstanding(rightE, g.tokenId) == 0;
    uint256 reserveLBefore = _reserve(leftActor, g.tokenId);
    uint256 reserveRBefore = _reserve(rightActor, g.tokenId);
    uint256[2] memory poolBefore;
    for (uint256 k = 0; k < 2; k++) poolBefore[k] = _totalInternal(TOKENS[k]);
    int256 prev = clean ? _ondelta(leftE, rightE, g.tokenId) + g.offdelta : int256(0);
    bool wasEarly = vm.getBlockTimestamp() < g.startTimestamp + DISPUTE_WINDOW_SECONDS;
    if (byStarter && wasEarly) starterEarlyAttempts++;

    if (_submit(caller, b)) {
      acceptedFinalizes++;
      disputes[pi].active = false;

      // Oracle 3: a finalization never changes the internal value pool.
      for (uint256 k = 0; k < 2; k++) {
        if (_totalInternal(TOKENS[k]) != poolBefore[k]) finalizeValueViolations++;
      }
      if (!clean) return;

      // Reconstruct the applied delta from custody movement (signed math: a
      // shortfall payment legitimately decreases the payer's reserve).
      int256 deltaObserved = int256(int256(_reserve(leftActor, g.tokenId)) - int256(reserveLBefore))
        - int256(dep.debtOutstanding(leftE, g.tokenId)) + int256(dep.debtOutstanding(rightE, g.tokenId));

      int256 requested = g.mode == 0 ? prev + g.value : g.value;
      if (requested != prev && !g.hasAllowance) {
        // Account.sol:996 — the batch must never have been accepted.
        unallowancedChangeViolations++;
        return;
      }
      clampObservations++;
      int256 expected = prev;
      if (g.hasAllowance) {
        int256 lower = prev - int256(g.rightAllowance);
        int256 upper = prev + int256(g.leftAllowance);
        expected = requested < lower ? lower : (requested > upper ? upper : requested);
        if (expected != requested) activeClamps++;
      } else if (requested != prev) {
        // unreachable unless the gate above missed it
        unallowancedChangeViolations++;
        return;
      }
      if (deltaObserved != expected) clampViolations++;
    } else {
      rejectedFinalizes++;
    }
  }

  /// @notice Warps exactly to a live dispute's timeout so the starter's legal
  ///         finalization path is reachable.
  function advancePastDisputeDelay(uint256 pairSeed) external {
    uint256 startAt = pairSeed % PAIRS;
    for (uint256 k = 0; k < PAIRS; k++) {
      uint256 pi = (startAt + k) % PAIRS;
      DisputeGhost memory g = disputes[pi];
      if (!g.active) continue;
      uint256 target = g.startTimestamp + DISPUTE_WINDOW_SECONDS;
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
}
