// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {XlnFixture} from "./helpers/XlnFixture.sol";
import {HankoThresholdHandler} from "./handlers/HankoThresholdHandler.sol";
import {XlnHanko} from "./helpers/XlnHanko.sol";
import "../../contracts/HankoVerifier.sol";
import "../../contracts/EntityTypes.sol";

/// @notice Task C4, target 4: Hanko quorum cannot be satisfied below the
///         declared threshold weight, and HANKO_FIRST_MEMBER_EOA_REQUIRED
///         (HankoVerifier.sol:207-214) is not bypassable via nested claims.
///
/// The verifier is probed through EntityProvider.verifyCurrentHankoSignature,
/// the exact call Depository.processBatch performs (Depository.sol:334).
contract HankoThresholdInvariants is XlnFixture {
  HankoThresholdHandler internal handler;

  function setUp() public {
    _deployXln();
    uint256[4] memory keys = [pk[0], pk[1], pk[2], pk[3]];
    handler = new HankoThresholdHandler(ep, keys);

    targetContract(address(handler));
    bytes4[] memory selectors = new bytes4[](2);
    selectors[0] = handler.probe.selector;
    selectors[1] = handler.probeCanonical.selector;
    targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
  }

  // ═══════════════ invariants ═══════════════

  /// @notice INVARIANT 4a. No accepted proof contained a claim whose
  ///         ECDSA-backed power (signatures + recursively satisfied nested
  ///         claims) was below its declared threshold.
  function invariant_quorumNeverBelowThreshold() public view {
    assertEq(
      handler.thresholdBypassViolations(),
      0,
      "quorum satisfied below declared threshold weight"
    );
  }

  /// @notice INVARIANT 4b. No accepted proof had a claim whose first member
  ///         was a nested claim index or a non-EOA-form entity id.
  function invariant_firstMemberIsAlwaysEoaSignature() public view {
    assertEq(
      handler.firstMemberViolations(),
      0,
      "HANKO_FIRST_MEMBER_EOA_REQUIRED bypassed (nested or non-EOA first member)"
    );
  }

  /// @notice INVARIANT 4c. Proofs constructed to be unsatisfiable (threshold
  ///         above reachable power, unsatisfied nested base, nested first
  ///         member) were never accepted.
  function invariant_unsatisfiableProofsAreRejected() public view {
    assertEq(handler.mustFailAcceptedViolations(), 0, "known-unsatisfiable proof accepted");
  }

  /// @notice INVARIANT 4d (liveness mirror). Proofs constructed to be valid
  ///         were never rejected — guards against an over-strict verifier
  ///         silently locking lazy entities out of processBatch.
  function invariant_validProofsAreAccepted() public view {
    assertEq(handler.mustAcceptRejectedViolations(), 0, "known-valid proof rejected");
  }

  // ═══════════════ deterministic controls ═══════════════

  /// @notice CONTROL: a real 2-of-2 lazy board over two signatures verifies
  ///         and returns the last claim's entity id.
  function test_control_twoOfTwoLazyBoardAccepted() public {
    bytes32 hash = keccak256("control");
    (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(pk[0], hash);
    (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(pk[1], hash);

    bytes32[] memory members = new bytes32[](2);
    members[0] = bytes32(uint256(uint160(vm.addr(pk[0]))));
    members[1] = bytes32(uint256(uint160(vm.addr(pk[1]))));
    uint16[] memory powers = new uint16[](2);
    powers[0] = 1;
    powers[1] = 1;
    bytes32 lazyId = keccak256(abi.encode(Board({
      votingThreshold: 2,
      entityIds: members,
      votingPowers: powers,
      boardChangeDelay: 0,
      controlChangeDelay: 0,
      dividendChangeDelay: 0
    })));

    // Two packed signatures + one claim with both indexes, threshold 2.
    uint256[] memory indexes = new uint256[](2);
    indexes[0] = 0;
    indexes[1] = 1;
    uint256[] memory weights = new uint256[](2);
    weights[0] = 1;
    weights[1] = 1;
    HankoVerifier.HankoClaim[] memory claims = new HankoVerifier.HankoClaim[](1);
    claims[0] = HankoVerifier.HankoClaim({
      entityId: lazyId,
      entityIndexes: indexes,
      weights: weights,
      threshold: 2,
      boardChangeDelay: 0,
      controlChangeDelay: 0,
      dividendChangeDelay: 0
    });
    bytes1 bits = (v1 == 28 ? bytes1(0x01) : bytes1(0x00))
      | (v2 == 28 ? bytes1(0x02) : bytes1(0x00));
    bytes memory hanko = abi.encode(HankoVerifier.HankoBytes({
      placeholders: new bytes32[](0),
      packedSignatures: abi.encodePacked(r1, s1, r2, s2, bits),
      claims: claims,
      memberSignatures: new bytes[](0)
    }));

    (bytes32 entityId, bool ok) = ep.verifyCurrentHankoSignature(hanko, hash);
    assertTrue(ok, "2-of-2 lazy board rejected");
    assertEq(entityId, lazyId, "verifier returned the wrong entity");
  }

  /// @notice CONTROL: the same 2-of-2 lazy board with only ONE signature
  ///         (the absent signer supplied as a placeholder member, which by
  ///         design contributes zero voting power) must fail — quorum below
  ///         threshold weight is not acceptable.
  function test_control_oneSignatureBelowThresholdRejected() public {
    bytes32 hash = keccak256("control-low");
    (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(pk[0], hash);

    bytes32[] memory members = new bytes32[](2);
    members[0] = bytes32(uint256(uint160(vm.addr(pk[0]))));
    members[1] = bytes32(uint256(uint160(vm.addr(pk[1]))));
    uint16[] memory powers = new uint16[](2);
    powers[0] = 1;
    powers[1] = 1;
    bytes32 lazyId = keccak256(abi.encode(Board({
      votingThreshold: 2,
      entityIds: members,
      votingPowers: powers,
      boardChangeDelay: 0,
      controlChangeDelay: 0,
      dividendChangeDelay: 0
    })));

    // Member 0 = the one real signature; member 1 = placeholder of the absent
    // signer (0 voting power); threshold 2 cannot be reached.
    bytes32[] memory placeholders = new bytes32[](1);
    placeholders[0] = members[1];
    uint256[] memory indexes = new uint256[](2);
    indexes[0] = 1; // signature slot 0
    indexes[1] = 0; // placeholder 0
    uint256[] memory weights = new uint256[](2);
    weights[0] = 1;
    weights[1] = 1;
    HankoVerifier.HankoClaim[] memory claims = new HankoVerifier.HankoClaim[](1);
    claims[0] = HankoVerifier.HankoClaim({
      entityId: lazyId,
      entityIndexes: indexes,
      weights: weights,
      threshold: 2,
      boardChangeDelay: 0,
      controlChangeDelay: 0,
      dividendChangeDelay: 0
    });
    bytes1 bits = v1 == 28 ? bytes1(0x01) : bytes1(0x00);
    bytes memory hanko = abi.encode(HankoVerifier.HankoBytes({
      placeholders: placeholders,
      packedSignatures: abi.encodePacked(r1, s1, bits),
      claims: claims,
      memberSignatures: new bytes[](0)
    }));

    (bytes32 entityId, bool ok) = ep.verifyCurrentHankoSignature(hanko, hash);
    assertFalse(ok, "1 signature satisfied a 2-of-2 threshold");
    assertEq(entityId, bytes32(0), "failed verification must return a zero entity");
  }

  // ═══════════════ coverage report ═══════════════

  function invariant_callSummary() public view {
    console.log("probes             ", handler.probes());
    console.log("-- accepted        ", handler.accepted());
    console.log("-- rejected        ", handler.rejectedProbes());
    console.log("-- reverted        ", handler.revertedProbes());
    console.log("-- nested accepts  ", handler.nestedQuorumAccepts());
  }
}
