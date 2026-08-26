// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import "../../../contracts/Depository.sol";
import "../../../contracts/HashLadder.sol";
import "../../../contracts/Types.sol";
import {XlnHanko} from "../helpers/XlnHanko.sol";

/// @notice Stateful handler for HashLadder.invariants.t.sol.
///
/// Drives Depository.processBatch().hashLadderRegistrations — the real outer
/// Entity-Hanko-authenticated reveal path — and ghosts the ordered registry
/// slots (revealerEntity, counterpartyEntity, ladderHash, role).
///
/// Doc invariants under test (fints hash-ladder reveal section):
/// - ORDERED PAIR: a registration by A with counterparty B never touches the
///   (B, A, ...) slot — the pair is never sorted because the reverse
///   participant must not write this slot.
/// - SOURCE SINGLE-SHOT: first Source write must land inside its signed
///   account window [S, S + ownerResponseSeconds]; exact retries are sticky
///   no-ops (ratio AND revealedAt unchanged); different ratios are E12.
/// - TARGET MONOTONE: lower replays are E12; equal/higher publications may
///   refresh revealedAt; fillRatio never decreases.
contract HashLadderHandler is CommonBase, StdCheats, StdUtils {
  uint256 public constant ACTORS = 4;
  uint256 public constant PAIRS = 6;
  uint32 public constant LEFT_RESPONSE_SECONDS = 50;
  uint32 public constant RIGHT_RESPONSE_SECONDS = 50;
  uint256 public constant DISPUTE_WINDOW_SECONDS =
    uint256(LEFT_RESPONSE_SECONDS) + uint256(RIGHT_RESPONSE_SECONDS);

  Depository public immutable dep;
  address public immutable admin;

  uint256[ACTORS] internal pk;
  bytes32[ACTORS] public entityOf;

  // ── ordered-slot ghost book ──
  struct SlotKey {
    uint256 writer; // actor index (Hanko-authenticated revealer)
    uint256 counterparty; // actor index
    bytes32 ladder; // ladderHash = keccak(fullHash, partialRoot)
    bool targetRole;
    uint16 ratio; // ghost value: accepted fillRatio
    uint256 revealedAt; // ghost value: accepted timestamp
  }
  SlotKey[] public slots;
  mapping(bytes32 => uint256) internal slotIndex; // packed-key -> index+1

  // ── oracles ──
  uint256 public sourceConflictingRetryAccepted; // different ratio replaced Source
  uint256 public targetLowerRetryAccepted; // lower ratio replaced Target
  uint256 public sourceOutsideWindowAccepted; // first Source write outside [S,S+W]

  // coverage
  uint256 public registrationsAccepted;
  uint256 public registrationsRejected;
  uint256 public disputesStarted;
  uint256 public sourceWrites;
  uint256 public targetWrites;

  struct DisputeGhost {
    bool active;
    uint256 leftActor;
    uint256 rightActor;
    uint256 startTimestamp;
    uint256 nonce;
    bytes32 proofbodyHash;
    bytes32 watchSeed;
  }
  mapping(uint256 => DisputeGhost) public disputes; // pairIndex => ghost

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

  function _accountNonce(bytes32 e1, bytes32 e2) internal view returns (uint256 n) {
    (n, , , , , , , , , , , , , , ) = dep._accounts(XlnHanko.accountKey(e1, e2));
  }

  function _disputeHash(bytes32 e1, bytes32 e2) internal view returns (bytes32 h) {
    (, h, , , , , , , , , , , , , ) = dep._accounts(XlnHanko.accountKey(e1, e2));
  }

  function slotCount() external view returns (uint256) {
    return slots.length;
  }

  function _slotKeyHash(uint256 writer, uint256 counterparty, bytes32 ladder, bool role)
    internal pure returns (bytes32)
  {
    return keccak256(abi.encode(writer, counterparty, ladder, role));
  }

  function _findSlot(uint256 writer, uint256 counterparty, bytes32 ladder, bool role)
    internal view returns (bool found, uint256 idx)
  {
    uint256 at = slotIndex[_slotKeyHash(writer, counterparty, ladder, role)];
    if (at == 0) return (false, 0);
    return (true, at - 1);
  }

  /// @dev Derives bucketed ladder material so the SAME ordered slot recurs
  ///      across calls and retry semantics (sticky/conflicting/refresh) are
  ///      exercised rather than always hitting fresh slots.
  function _ladderMaterial(uint256 bucket, uint16 ratio)
    internal pure returns (bytes32 fullHash, bytes32 partialRoot, HashLadderWitness memory w)
  {
    bytes32 fullSecret = keccak256(abi.encode(bucket, "full"));
    fullHash = HashLadder.hashFullSecret(fullSecret);
    w.fillRatio = ratio;
    w.fullSecret = fullSecret;
    if (ratio == type(uint16).max) {
      partialRoot = keccak256(abi.encode(bucket, "root"));
      return (fullHash, partialRoot, w);
    }
    for (uint8 i = 0; i < 4; i++) {
      bytes32 base = keccak256(abi.encode(bucket, "nib", i));
      w.reveals[i] = HashLadder.revealForNibble(base, HashLadder.nibbleAt(ratio, i));
    }
    partialRoot = HashLadder.partialRootFromReveals(ratio, w.reveals);
    return (fullHash, partialRoot, w);
  }

  // ═══════════════════════════ actions ═══════════════════════════

  /// @notice Opens a 50s/50s dispute so Source windows become reachable.
  function openDispute(uint256 fromSeed, uint256 cpSeed, uint256 seedNoise) external {
    (uint256 from, uint256 cp) = _distinct(fromSeed, cpSeed);
    _openDispute(from, cp, seedNoise);
  }

  function _openDispute(uint256 from, uint256 cp, uint256 seedNoise) internal returns (bool) {
    bytes32 me = entityOf[from];
    bytes32 other = entityOf[cp];
    if (_disputeHash(me, other) != bytes32(0)) return false;

    bytes32 watchSeed = keccak256(abi.encodePacked("hl", seedNoise));
    ProofBody memory pb;
    pb.watchSeed = watchSeed;
    pb.leftResponseSeconds = LEFT_RESPONSE_SECONDS;
    pb.rightResponseSeconds = RIGHT_RESPONSE_SECONDS;
    pb.offdeltas = new int256[](1);
    pb.tokenIds = new uint256[](1);
    pb.tokenIds[0] = 1;
    pb.transformers = new TransformerClause[](0);
    bytes32 pbHash = keccak256(abi.encode(pb));

    bytes memory key = XlnHanko.accountKey(me, other);
    uint256 nonce = _accountNonce(me, other) + 1;
    bool proposerIsLeft = other < me;
    bytes32 h = XlnHanko.disputeProofHash(address(dep), key, nonce, proposerIsLeft, pbHash, watchSeed);

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
        leftActor: me < other ? from : cp,
        rightActor: me < other ? cp : from,
        startTimestamp: vm.getBlockTimestamp(),
        nonce: nonce,
        proofbodyHash: pbHash,
        watchSeed: watchSeed
      });
      disputesStarted++;
      return true;
    }
    return false;
  }

  /// @notice The core action: one hash-ladder registration through
  ///         processBatch, ghost-checked against the ordered-slot rules.
  function registerReveal(
    uint256 fromSeed,
    uint256 cpSeed,
    uint256 roleSeed,
    uint256 ratioSeed,
    uint256 bucketSeed,
    uint256 warpSeed
  ) external {
    (uint256 from, uint256 cp) = _distinct(fromSeed, cpSeed);
    // 2 of 3 picks are Source so its window/sticky rules dominate the run.
    bool targetRole = roleSeed % 3 == 0;
    uint16 ratio = uint16(bound(uint256(ratioSeed), 1, type(uint16).max));
    uint256 bucket = bucketSeed % 4;

    // A Source write needs a live window. Half the time, self-open the
    // dispute at the current timestamp (a legal standalone action) so the
    // in-window accept path is reachable despite other actions warping time.
    if (!targetRole && warpSeed % 2 == 0) {
      if (_disputeHash(entityOf[from], entityOf[cp]) == bytes32(0)) {
        _openDispute(from, cp, warpSeed);
      }
    }

    DisputeGhost memory g = disputes[pairIndex(from, cp)];
    bool disputeLive = g.active && _disputeHash(entityOf[from], entityOf[cp]) != bytes32(0);
    uint256 ownerWindow = entityOf[from] < entityOf[cp]
      ? uint256(LEFT_RESPONSE_SECONDS)
      : uint256(RIGHT_RESPONSE_SECONDS);

    // Time jitter so writes also land outside windows — but never push a
    // still-open Source window past its end by accident: clamp to the edge.
    if (warpSeed % 3 == 0) {
      uint256 jitter = bound(warpSeed, 1, 120);
      if (!targetRole && disputeLive) {
        uint256 windowEnd = g.startTimestamp + ownerWindow;
        if (vm.getBlockTimestamp() <= windowEnd && vm.getBlockTimestamp() + jitter > windowEnd) {
          jitter = windowEnd - vm.getBlockTimestamp();
        }
      }
      if (jitter > 0) vm.warp(vm.getBlockTimestamp() + jitter);
    }

    (bytes32 fullHash, bytes32 partialRoot, HashLadderWitness memory w) =
      _ladderMaterial(bucket, ratio);
    bytes32 ladder = keccak256(abi.encodePacked(fullHash, partialRoot));

    Batch memory b = XlnHanko.emptyBatch();
    b.hashLadderRegistrations = new HashLadderRegistration[](1);
    b.hashLadderRegistrations[0] = HashLadderRegistration({
      counterpartyEntity: entityOf[cp],
      targetRole: targetRole,
      fullHash: fullHash,
      partialRoot: partialRoot,
      witness: w
    });

    (bool found, uint256 idx) = _findSlot(from, cp, ladder, targetRole);
    bool insideWindow = disputeLive
      && vm.getBlockTimestamp() >= g.startTimestamp
      && vm.getBlockTimestamp() <= g.startTimestamp + ownerWindow;

    if (_submit(from, b)) {
      registrationsAccepted++;
      if (targetRole) {
        targetWrites++;
        if (found && ratio < slots[idx].ratio) targetLowerRetryAccepted++;
      } else {
        sourceWrites++;
        if (found && ratio != slots[idx].ratio) sourceConflictingRetryAccepted++;
        if (!found && !insideWindow) sourceOutsideWindowAccepted++;
      }
      // Ghost-apply the exact contract admission rules.
      if (!found) {
        slotIndex[_slotKeyHash(from, cp, ladder, targetRole)] = slots.length + 1;
        slots.push(SlotKey({
          writer: from,
          counterparty: cp,
          ladder: ladder,
          targetRole: targetRole,
          ratio: ratio,
          revealedAt: vm.getBlockTimestamp()
        }));
      } else if (targetRole) {
        // equal/higher publication refreshes ratio and timestamp
        slots[idx].ratio = ratio;
        slots[idx].revealedAt = vm.getBlockTimestamp();
      }
      // Source exact retry: contract returned early; ghost stays sticky.
    } else {
      registrationsRejected++;
    }
  }

  /// @notice Warps into the owner window of a live dispute (mid-window), so
  ///          legal first-Source writes are reachable without relying on a
  ///          lucky selector/time alignment.
  function advanceToWindow(uint256 pairSeed) external {
    uint256 startAt = pairSeed % PAIRS;
    for (uint256 k = 0; k < PAIRS; k++) {
      uint256 pi = (startAt + k) % PAIRS;
      DisputeGhost memory g = disputes[pi];
      if (!g.active) continue;
      if (_disputeHash(entityOf[g.leftActor], entityOf[g.rightActor]) == bytes32(0)) continue;
      uint256 mid = g.startTimestamp + LEFT_RESPONSE_SECONDS / 2;
      if (vm.getBlockTimestamp() >= mid) return; // window gone or mid passed
      vm.warp(mid);
      return;
    }
  }

  /// @notice Warps past every live dispute timeout so finalize-adjacent
  ///         orderings (late writes) are reachable.
  function advance(uint256 blocks_, uint256 secs) external {
    blocks_ = bound(blocks_, 1, 200);
    secs = bound(secs, 1, 2000);
    vm.roll(vm.getBlockNumber() + blocks_);
    vm.warp(vm.getBlockTimestamp() + secs);
  }

  // ═══════════════════════════ verification ═══════════════════════════

  /// @dev Recomputes chain state for every ghost slot and its REVERSED pair.
  ///      Pure computation: the invariant functions assert on the result.
  function checkOrderedPairs() external view returns (uint256 violations) {
    for (uint256 i = 0; i < slots.length; i++) {
      SlotKey memory s = slots[i];
      (uint16 ratio, uint256 revealedAt) =
        dep.getHashLadderReveal(entityOf[s.writer], entityOf[s.counterparty], s.ladder, s.targetRole);
      if (ratio != s.ratio || revealedAt != s.revealedAt) violations++;

      (bool rfound, uint256 ridx) = _findSlot(s.counterparty, s.writer, s.ladder, s.targetRole);
      (uint16 rratio, uint256 rrevealedAt) =
        dep.getHashLadderReveal(entityOf[s.counterparty], entityOf[s.writer], s.ladder, s.targetRole);
      if (rfound) {
        if (rratio != slots[ridx].ratio || rrevealedAt != slots[ridx].revealedAt) violations++;
      } else {
        // The reverse participant never wrote this slot: it must read empty.
        if (rratio != 0 || rrevealedAt != 0) violations++;
      }
    }
  }
}
