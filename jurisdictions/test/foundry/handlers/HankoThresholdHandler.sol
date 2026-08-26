// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import "../../../contracts/EntityProvider.sol";
import "../../../contracts/EntityTypes.sol";
import "../../../contracts/HankoVerifier.sol";

/// @notice Stateful handler for HankoThreshold.invariants.t.sol.
///
/// Probes HankoVerifier.verify through the production entrypoint
/// EntityProvider.verifyCurrentHankoSignature (the exact call processBatch
/// makes) with seed-generated proofs: nested claims, placeholder members,
/// lazy boards (entityId == keccak(Board)) and adversarial shapes.
///
/// Ghost model (deliberately NOT a verifier reimplementation — it is the
/// sound *lower bound* of real ECDSA backing):
///   backing(claim) = Σ weights of signature members
///                  + Σ weights of nested members whose own backing ≥ threshold
///
/// The contract counts a nested member's weight unconditionally, but every
/// nested claim must itself pass its threshold or the whole proof fails, so
/// on any ACCEPTED proof backing(claim) == contract votingPower. Therefore
/// "accepted while backing < threshold" is exactly a quorum bypass.
///
/// First-member rule (HankoVerifier.sol:207-214, on-chain mirror of the TS
/// HANKO_FIRST_MEMBER_EOA_REQUIRED): member 0 of every claim must be a
/// signature/placeholder index whose entityId is EOA-form (nonzero, ≤
/// uint160 max) — never a nested claim index.
contract HankoThresholdHandler is CommonBase, StdCheats, StdUtils {
  uint256 public constant KEYS = 4;

  EntityProvider public immutable ep;

  uint256[KEYS] internal pk;
  address[KEYS] public signerOf;

  // ── oracles ──
  uint256 public thresholdBypassViolations; // accepted while backing < threshold
  uint256 public firstMemberViolations; // accepted with nested/non-EOA first member
  uint256 public mustFailAcceptedViolations; // known-unsatisfiable proof accepted
  uint256 public mustAcceptRejectedViolations; // known-good proof rejected

  // coverage
  uint256 public probes;
  uint256 public accepted;
  uint256 public rejectedProbes;
  uint256 public revertedProbes;
  uint256 public nestedQuorumAccepts; // accepted proofs using a nested claim

  constructor(EntityProvider _ep, uint256[KEYS] memory _pk) {
    ep = _ep;
    for (uint256 i = 0; i < KEYS; i++) {
      pk[i] = _pk[i];
      signerOf[i] = vm.addr(_pk[i]);
    }
  }

  // ═══════════════ shared ghost model ═══════════════

  struct GhostClaim {
    uint256[] entityIndexes;
    uint256[] weights;
    uint256 threshold;
    uint256 sigPower; // Σ weights over signature members
    bool firstMemberNested; // first index points at a claim
    bool firstMemberEoaForm; // first memberId nonzero and ≤ uint160 max
    bytes32 entityId;
  }

  struct Built {
    HankoVerifier.HankoBytes hanko;
    GhostClaim[] ghosts;
    uint256 firstClaimIndex; // placeholders + signatures
  }

  function _u(uint256 seed, uint256 salt) internal pure returns (uint256) {
    return uint256(keccak256(abi.encode(seed, salt)));
  }

  function _isEoaForm(bytes32 id) internal pure returns (bool) {
    return id != bytes32(0) && uint256(id) <= type(uint160).max;
  }

  /// @dev Lazy entity id for an exact board shape (mirrors XlnHanko.lazyEntityId
  ///      for arbitrary member lists; accepted while EntityProvider holds no
  ///      registration for the id).
  function _lazyBoardId(
    uint256 threshold,
    bytes32[] memory memberIds,
    uint256[] memory weights
  ) internal pure returns (bytes32) {
    uint16[] memory powers = new uint16[](weights.length);
    for (uint256 i = 0; i < weights.length; i++) powers[i] = uint16(weights[i]);
    return keccak256(abi.encode(Board({
      votingThreshold: uint16(threshold),
      entityIds: memberIds,
      votingPowers: powers,
      boardChangeDelay: 0,
      controlChangeDelay: 0,
      dividendChangeDelay: 0
    })));
  }

  /// @dev Recursive ghost backing — sound lower bound of ECDSA-backed power.
  function _backing(Built memory b, uint256 c) internal pure returns (uint256) {
    GhostClaim memory g = b.ghosts[c];
    uint256 total = g.sigPower;
    for (uint256 m = 0; m < g.entityIndexes.length; m++) {
      uint256 idx = g.entityIndexes[m];
      if (idx >= b.firstClaimIndex) {
        uint256 ni = idx - b.firstClaimIndex;
        if (ni < c && _backing(b, ni) >= b.ghosts[ni].threshold) {
          total += g.weights[m];
        }
      }
    }
    return total;
  }

  function _probe(Built memory b, bytes32 hash) internal returns (bool ok) {
    probes++;
    bytes memory encoded = abi.encode(b.hanko);
    try ep.verifyCurrentHankoSignature(encoded, hash) returns (bytes32, bool success) {
      ok = success;
      if (ok) accepted++; else rejectedProbes++;
    } catch {
      revertedProbes++;
    }
  }

  function _checkAcceptedGhost(Built memory b) internal {
    bool usedNested = false;
    for (uint256 c = 0; c < b.ghosts.length; c++) {
      if (_backing(b, c) < b.ghosts[c].threshold) thresholdBypassViolations++;
      if (b.ghosts[c].firstMemberNested || !b.ghosts[c].firstMemberEoaForm) firstMemberViolations++;
      for (uint256 m = 0; m < b.ghosts[c].entityIndexes.length && !usedNested; m++) {
        if (b.ghosts[c].entityIndexes[m] >= b.firstClaimIndex) usedNested = true;
      }
    }
    if (usedNested) nestedQuorumAccepts++;
  }

  // ═══════════════ random construction ═══════════════

  /// @notice Adversarial shape: random member kinds, thresholds, lazy or bogus
  ///         entity ids, EOA and non-EOA placeholders, nested references.
  ///         Most shapes revert (shape errors) or fail — the oracle only fires
  ///         on accepts, which is exactly the bypass signal we hunt for.
  function probe(uint256 seed) external {
    bytes32 hash = bytes32(_u(seed, 0));
    uint256 nSigs = 1 + _u(seed, 1) % 3;
    uint256 nPh = _u(seed, 2) % 3;
    uint256 nClaims = 1 + _u(seed, 3) % 3;
    uint256 offset = _u(seed, 4) % KEYS;

    Built memory b;
    b.hanko.placeholders = new bytes32[](nPh);
    for (uint256 i = 0; i < nPh; i++) {
      // 1 in 8 placeholders is EOA-form so placeholder-first-member acceptance
      // stays reachable; the rest exercise the InvalidHankoFirstMember revert.
      if (_u(seed, 100 + i) % 8 == 0) {
        b.hanko.placeholders[i] = bytes32(uint256(uint160(address(uint160(_u(seed, 200 + i))))));
      } else {
        b.hanko.placeholders[i] = bytes32(_u(seed, 300 + i));
      }
    }

    // Each signature slot uses a distinct key (i + offset) mod KEYS so
    // DuplicateHankoSigner never masks the properties under test.
    bytes memory sigs = new bytes(nSigs * 64);
    bytes memory bits = new bytes((nSigs + 7) / 8);
    for (uint256 i = 0; i < nSigs; i++) {
      uint256 keyIdx = (i + offset) % KEYS;
      (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk[keyIdx], hash);
      assembly ("memory-safe") {
        mstore(add(sigs, add(0x20, mul(i, 64))), r)
        mstore(add(sigs, add(0x40, mul(i, 64))), s)
      }
      if (v == 28) {
        bits[i / 8] = bytes1(uint8(bits[i / 8]) | uint8(1 << (i % 8)));
      }
    }
    b.hanko.packedSignatures = abi.encodePacked(sigs, bits);

    b.firstClaimIndex = nPh + nSigs;
    b.ghosts = new GhostClaim[](nClaims);
    b.hanko.claims = new HankoVerifier.HankoClaim[](nClaims);

    for (uint256 c = 0; c < nClaims; c++) {
      uint256 nMembers = 1 + _u(seed, 500 + c) % 3;
      uint256[] memory indexes = new uint256[](nMembers);
      uint256[] memory weights = new uint256[](nMembers);
      bytes32[] memory memberIds = new bytes32[](nMembers);
      GhostClaim memory g;
      g.entityIndexes = indexes;
      g.weights = weights;

      for (uint256 m = 0; m < nMembers; m++) {
        weights[m] = 1 + _u(seed, 600 + c * 10 + m) % 3;
        uint256 kind = _u(seed, 700 + c * 10 + m) % 3;
        if (kind == 1 && nPh > 0) {
          indexes[m] = _u(seed, 900 + c * 10 + m) % nPh; // placeholder member
          memberIds[m] = b.hanko.placeholders[indexes[m]];
        } else if (kind == 2 && c > 0) {
          uint256 ni = _u(seed, 1000 + c * 10 + m) % c; // nested claim member
          indexes[m] = b.firstClaimIndex + ni;
          memberIds[m] = b.ghosts[ni].entityId;
        } else {
          uint256 si = _u(seed, 1100 + c * 10 + m) % nSigs; // signature member
          indexes[m] = nPh + si;
          memberIds[m] = bytes32(uint256(uint160(signerOf[(si + offset) % KEYS])));
          g.sigPower += weights[m];
        }
      }
      g.threshold = 1 + _u(seed, 1200 + c) % 4;
      g.firstMemberNested = indexes[0] >= b.firstClaimIndex;
      g.firstMemberEoaForm = _isEoaForm(memberIds[0]);
      g.entityId = _u(seed, 1300 + c) % 2 == 0
        ? _lazyBoardId(g.threshold, memberIds, weights)
        : bytes32(_u(seed, 1400 + c));
      b.ghosts[c] = g;

      b.hanko.claims[c] = HankoVerifier.HankoClaim({
        entityId: g.entityId,
        entityIndexes: indexes,
        weights: weights,
        threshold: g.threshold,
        boardChangeDelay: 0,
        controlChangeDelay: 0,
        dividendChangeDelay: 0
      });
    }

    if (_probe(b, hash)) _checkAcceptedGhost(b);
  }

  // ═══════════════ canonical construction ═══════════════

  /// @notice Well-formed two-claim proofs with a KNOWN expectation.
  ///
  /// claim0 (nested base): members [sig_a(w1)] (+ sig_b(w1) when wide).
  /// claim1 (outer, lazy): members [sig_c(w1) FIRST, claim0(w1)?].
  ///
  /// variant 0: nested + both satisfied → MUST ACCEPT
  /// variant 1: outer threshold one above reachable power → MUST NOT ACCEPT
  ///            (quorum below declared threshold weight)
  /// variant 2: nested claim threshold unsatisfiable → MUST NOT ACCEPT
  ///            (a nested claim may not lend weight it does not have)
  /// variant 3: outer first member is the nested claim index → MUST NOT ACCEPT
  ///            (HANKO_FIRST_MEMBER_EOA_REQUIRED via nested claims)
  function probeCanonical(uint256 seed) external {
    bytes32 hash = bytes32(_u(seed, 0));
    uint256 variant = _u(seed, 1) % 4;
    bool wide = _u(seed, 2) % 2 == 1; // 2-of-2 base board vs 1-of-1
    bool useNested = variant != 3; // variant 3 puts the claim first instead

    Built memory b;
    uint256 nSigs = wide ? 3 : 2;
    b.hanko.placeholders = new bytes32[](0);
    bytes memory sigs = new bytes(nSigs * 64);
    bytes memory bits = new bytes((nSigs + 7) / 8);
    for (uint256 i = 0; i < nSigs; i++) {
      (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk[i], hash);
      assembly ("memory-safe") {
        mstore(add(sigs, add(0x20, mul(i, 64))), r)
        mstore(add(sigs, add(0x40, mul(i, 64))), s)
      }
      if (v == 28) {
        bits[i / 8] = bytes1(uint8(bits[i / 8]) | uint8(1 << (i % 8)));
      }
    }
    b.hanko.packedSignatures = abi.encodePacked(sigs, bits);
    b.firstClaimIndex = nSigs;

    b.ghosts = new GhostClaim[](2);
    b.hanko.claims = new HankoVerifier.HankoClaim[](2);

    // claim 0: base board [sig0] or [sig0, sig1]
    {
      uint256[] memory indexes = new uint256[](wide ? 2 : 1);
      uint256[] memory weights = new uint256[](wide ? 2 : 1);
      bytes32[] memory memberIds = new bytes32[](wide ? 2 : 1);
      for (uint256 m = 0; m < indexes.length; m++) {
        indexes[m] = m;
        weights[m] = 1;
        memberIds[m] = bytes32(uint256(uint160(signerOf[m])));
      }
      GhostClaim memory g0;
      g0.entityIndexes = indexes;
      g0.weights = weights;
      g0.sigPower = indexes.length;
      g0.threshold = wide ? 2 : 1;
      if (variant == 2) g0.threshold = indexes.length + 1; // unsatisfiable
      g0.firstMemberNested = false;
      g0.firstMemberEoaForm = true;
      g0.entityId = _lazyBoardId(g0.threshold, memberIds, weights);
      b.ghosts[0] = g0;
      b.hanko.claims[0] = HankoVerifier.HankoClaim({
        entityId: g0.entityId,
        entityIndexes: indexes,
        weights: weights,
        threshold: g0.threshold,
        boardChangeDelay: 0,
        controlChangeDelay: 0,
        dividendChangeDelay: 0
      });
    }

    // claim 1: outer lazy board [sig2 FIRST, claim0?]
    {
      uint256 n = useNested ? 2 : 1;
      uint256[] memory indexes = new uint256[](n);
      uint256[] memory weights = new uint256[](n);
      bytes32[] memory memberIds = new bytes32[](n);
      GhostClaim memory g1;
      g1.entityIndexes = indexes;
      g1.weights = weights;
      indexes[0] = nSigs - 1; // a real signature is always member 0...
      weights[0] = 1;
      memberIds[0] = bytes32(uint256(uint160(signerOf[nSigs - 1])));
      g1.sigPower = 1;
      uint256 reachable = 1;
      if (variant == 3) {
        // ...except here: the nested claim is placed first (adversarial).
        indexes[0] = b.firstClaimIndex; // claim0
        memberIds[0] = b.ghosts[0].entityId;
        g1.sigPower = 0;
        indexes[1] = nSigs - 1;
        weights[1] = 1;
        memberIds[1] = bytes32(uint256(uint160(signerOf[nSigs - 1])));
        g1.sigPower = 1;
        reachable = 2; // weight flows only if the shape is otherwise legal
      } else if (useNested) {
        indexes[1] = b.firstClaimIndex; // claim0
        weights[1] = 1;
        memberIds[1] = b.ghosts[0].entityId;
        reachable = 2;
      }
      g1.threshold = variant == 1 ? reachable + 1 : 2;
      g1.firstMemberNested = indexes[0] >= b.firstClaimIndex;
      g1.firstMemberEoaForm = _isEoaForm(memberIds[0]);
      g1.entityId = _lazyBoardId(g1.threshold, memberIds, weights);
      b.ghosts[1] = g1;
      b.hanko.claims[1] = HankoVerifier.HankoClaim({
        entityId: g1.entityId,
        entityIndexes: indexes,
        weights: weights,
        threshold: g1.threshold,
        boardChangeDelay: 0,
        controlChangeDelay: 0,
        dividendChangeDelay: 0
      });
    }

    // Ghost expectation by construction:
    //  variant 0: base satisfied, outer reachable power 2 ≥ threshold 2 → accept
    //  variant 1: outer threshold 3 > reachable 2 → reject
    //  variant 2: base unsatisfiable → whole proof must fail
    //  variant 3: nested-first-member → must fail (InvalidHankoFirstMember)
    bool mustAccept = variant == 0;
    bool ok = _probe(b, hash);
    if (ok) {
      _checkAcceptedGhost(b);
      if (!mustAccept) mustFailAcceptedViolations++;
    } else if (mustAccept) {
      mustAcceptRejectedViolations++;
    }
  }
}
