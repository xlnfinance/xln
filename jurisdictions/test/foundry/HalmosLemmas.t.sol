// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import "../../../contracts/HashLadder.sol";
import "../../../contracts/mocks/TransformerLivenessHarness.sol";
import {SettlementDeltasHarness} from "./helpers/SettlementDeltasHarness.sol";

/// @notice Small sign-free lemmas for Halmos over the REAL production
///         bytecode, plus plain-Forge execution of the same properties.
///
/// Each lemma has one internal body `_lemma_*`, a `test_*_halmos` wrapper
/// (Foundry fuzzing) and a `check_*` wrapper (Halmos symbolic execution:
/// halmos 0.3.3 only collects functions named check_*/invariant_*).
///
/// Why these shapes: processBatch's entity-nonce lemma needs a valid ECDSA
/// Hanko (vm.sign is concrete-only), so Halmos cannot walk it; that property
/// is covered statefully by DepositoryConservation.invariants.t.sol instead.
/// Account.prepareSettlementDeltas — the owner of the Account.sol:996
/// allowance gate and the clamp band — performs no signature verification,
/// so SettlementDeltasHarness executes the exact library code with symbolic
/// inputs. HashLadder math and HashLadderRegistry's ordered-pair slots are
/// likewise signature-free.
///
/// Bounded model (documented in proofs/solidity/report.md):
///   |ondelta|, |offdelta|, |value| ≤ 2^40, allowances ≤ 2^40, digit ≤ 15,
///   1 token, 1 transformer clause, empty argument wrappers.
contract HalmosLemmas is Test {
  SettlementDeltasHarness internal harness;
  TransformerLivenessHarness internal transformer;

  int256 internal constant BOUND = 1099511627776; // 2^40

  function setUp() public {
    transformer = new TransformerLivenessHarness();
    harness = new SettlementDeltasHarness(transformer);
  }

  // ═══════════════ lemma 1: the allowance gate (Account.sol:996) ═══════════════

  /// @notice With NO allowance on delta 0, the pipeline reverts — with the
  ///          transformer-execution error, not a tolerated artifact — if and
  ///          only if the transformer actually changes delta 0. A surviving
  ///          change is exactly the banned "value moved without
  ///          _hasTransformerAllowance" (Account.sol:996).
  function _lemma_allowanceGate(
    int256 ondelta,
    int256 offdelta,
    int256 value,
    uint8 modeSel
  ) internal {
    vm.assume(ondelta >= -BOUND && ondelta <= BOUND);
    vm.assume(offdelta >= -BOUND && offdelta <= BOUND);
    vm.assume(value >= -BOUND && value <= BOUND);
    vm.assume(modeSel <= 1);

    TransformerLivenessHarness.Mode mode =
      modeSel == 0 ? TransformerLivenessHarness.Mode.Add : TransformerLivenessHarness.Mode.Absolute;
    (int256 delta0, , bool reverted, bool gasArtifact) =
      harness.run(ondelta, offdelta, 1, mode, value, false, 0, 0);

    int256 prev = ondelta + offdelta;
    int256 requested = modeSel == 0 ? prev + value : value;
    bool changed = requested != prev;

    // A real (non-artifact) revert is allowed only when a change was requested.
    assertTrue(
      !reverted || gasArtifact || changed,
      "gate: accepted batch must leave the delta untouched without an allowance"
    );
    if (!reverted) {
      assertEq(delta0, prev, "gate: un-allowanced run must return the untouched delta");
    }
  }

  function test_allowanceGate_halmos(int256 ondelta, int256 offdelta, int256 value, uint8 modeSel)
    external
  {
    _lemma_allowanceGate(ondelta, offdelta, value, modeSel);
  }

  function check_allowanceGate(int256 ondelta, int256 offdelta, int256 value, uint8 modeSel)
    external
  {
    _lemma_allowanceGate(ondelta, offdelta, value, modeSel);
  }

  // ═══════════════ lemma 2: the clamp band (Account.sol:_clampTransformerValue) ═══════════════

  /// @notice With an allowance on delta 0, the pipeline never reverts (except
  ///         the tolerated halmos gas artifact) and the applied delta equals
  ///         EXACTLY clamp(requested, prev ± allowances); the negative-delta
  ///         bitmap agrees with the sign of the result.
  function _lemma_clampExact(
    int256 ondelta,
    int256 offdelta,
    int256 value,
    uint256 rightAllowance,
    uint256 leftAllowance,
    uint8 modeSel
  ) internal {
    vm.assume(ondelta >= -BOUND && ondelta <= BOUND);
    vm.assume(offdelta >= -BOUND && offdelta <= BOUND);
    vm.assume(value >= -BOUND && value <= BOUND);
    vm.assume(rightAllowance <= uint256(BOUND));
    vm.assume(leftAllowance <= uint256(BOUND));
    vm.assume(modeSel <= 1);

    TransformerLivenessHarness.Mode mode =
      modeSel == 0 ? TransformerLivenessHarness.Mode.Add : TransformerLivenessHarness.Mode.Absolute;
    (int256 delta0, uint256 bitmap, bool reverted, bool gasArtifact) =
      harness.run(ondelta, offdelta, 1, mode, value, true, rightAllowance, leftAllowance);

    assertTrue(!reverted || gasArtifact, "clamp: allowanced clause must never revert here");
    if (reverted) return; // tolerated halmos gas artifact only

    int256 prev = ondelta + offdelta;
    int256 requested = modeSel == 0 ? prev + value : value;
    int256 lower = prev - int256(rightAllowance);
    int256 upper = prev + int256(leftAllowance);
    int256 expected = requested < lower ? lower : (requested > upper ? upper : requested);

    assertEq(delta0, expected, "clamp: applied delta is not the exact band clamp");
    assertEq(delta0 < 0, bitmap & 1 == 1, "clamp: sign/bitmap disagreement");
  }

  function test_clampExact_halmos(
    int256 ondelta,
    int256 offdelta,
    int256 value,
    uint256 rightAllowance,
    uint256 leftAllowance,
    uint8 modeSel
  ) external {
    _lemma_clampExact(ondelta, offdelta, value, rightAllowance, leftAllowance, modeSel);
  }

  function check_clampExact(
    int256 ondelta,
    int256 offdelta,
    int256 value,
    uint256 rightAllowance,
    uint256 leftAllowance,
    uint8 modeSel
  ) external {
    _lemma_clampExact(ondelta, offdelta, value, rightAllowance, leftAllowance, modeSel);
  }

  // ═══════════════ lemma 3: ordered-pair slot isolation (registry) ═══════════════

  /// @notice A full-fill TARGET registration by `writer` against `counterparty`
  ///         writes exactly the ordered slot (writer, counterparty, ladder):
  ///         the reversed slot reads (0, 0).
  function _lemma_orderedPairIsolation(
    bytes32 writer,
    bytes32 counterparty,
    bytes32 fullSecret
  ) internal {
    vm.assume(writer != counterparty);

    (uint16 ratio, uint256 revealedAt) = harness.registerTarget(writer, counterparty, fullSecret);
    assertEq(uint256(ratio), type(uint16).max, "ordered-pair: direct slot ratio");
    assertGt(revealedAt, 0, "ordered-pair: direct slot timestamp");

    (uint16 revRatio, uint256 revTs) = harness.readReverse(writer, counterparty, fullSecret);
    assertEq(uint256(revRatio), 0, "ordered-pair: write leaked into the reversed slot");
    assertEq(revTs, 0, "ordered-pair: write leaked into the reversed slot");
  }

  function test_orderedPairIsolation_halmos(bytes32 writer, bytes32 counterparty, bytes32 fullSecret)
    external
  {
    _lemma_orderedPairIsolation(writer, counterparty, fullSecret);
  }

  function check_orderedPairIsolation(
    bytes32 writer,
    bytes32 counterparty,
    bytes32 fullSecret
  ) external {
    _lemma_orderedPairIsolation(writer, counterparty, fullSecret);
  }

  // ═══════════════ lemma 4: hash-ladder math ═══════════════

  /// @notice The four nibbles of a uint16 fill ratio reconstruct it exactly.
  function _lemma_nibbleReconstruct(uint16 ratio) internal pure {
    uint256 reconstructed = uint256(HashLadder.nibbleAt(ratio, 0)) << 12
      | uint256(HashLadder.nibbleAt(ratio, 1)) << 8
      | uint256(HashLadder.nibbleAt(ratio, 2)) << 4
      | uint256(HashLadder.nibbleAt(ratio, 3));
    assertEq(reconstructed, uint256(ratio), "nibbleAt does not reconstruct the ratio");
  }

  function test_nibbleReconstruct_halmos(uint16 ratio) external pure {
    _lemma_nibbleReconstruct(ratio);
  }

  function check_nibbleReconstruct(uint16 ratio) external pure {
    _lemma_nibbleReconstruct(ratio);
  }

  /// @notice rootFromReveal(revealForNibble(base, digit), digit) == rootFromBase(base)
  ///         for every digit 0..15: a correct prover's reveal always verifies.
  function _lemma_rootRoundTrip(bytes32 base, uint8 digit) internal pure {
    vm.assume(digit <= 15);
    bytes32 reveal = HashLadder.revealForNibble(base, digit);
    assertEq(
      HashLadder.rootFromReveal(reveal, digit),
      HashLadder.rootFromBase(base),
      "honest reveal does not hash back to the committed root"
    );
  }

  function test_rootRoundTrip_halmos(bytes32 base, uint8 digit) external pure {
    _lemma_rootRoundTrip(base, digit);
  }

  function check_rootRoundTrip(bytes32 base, uint8 digit) external pure {
    _lemma_rootRoundTrip(base, digit);
  }

  // ═══════════════ appendix: the gas-artifact reproducer (c4-adversary A7) ═══════════════

  /// @notice GAS-ARTIFACT ARTIFACT (halmos FAIL / EVM PASS, by design).
  ///
  /// Concrete run: delta 0 = 5+0, the clause requests Add(7) — a definite
  /// change — with NO allowance. On a real EVM (forge, 300M gas limit) the
  /// pipeline reverts at the Account.sol:996-1000 gate with
  /// TransformerExecutionFailed: `reverted && !gasArtifact` holds and the
  /// forge wrapper (`test_gateZeroConcrete_halmos`) PASSES under forge.
  ///
  /// Symbolic run: halmos 0.3.3 models `gasleft()` symbolically, so the
  /// earlier `TransformerGasBudgetUnavailable` branch (Account.sol:887)
  /// becomes feasible and `check_gateZeroConcrete` reports a counterexample
  /// — `reverted && !gasArtifact` fails in-model even though no concrete EVM
  /// caller with the configured 300M limit can reach that branch first in a
  /// single-clause body. THIS IS THE JUSTIFICATION ARTIFACT for the harness's
  /// exactly-one-selector tolerance (helpers/SettlementDeltasHarness.sol):
  /// the tolerated revert can never mask a real gate failure on the EVM,
  /// because on the EVM the gate fires with a DIFFERENT selector.
  ///
  /// WARNING (audit A7 caveat): the tolerance is valid ONLY for this
  /// single-clause, empty-arguments harness. With >= 2 clauses a genuinely
  /// gas-starved second clause legitimately emits
  /// TransformerGasBudgetUnavailable at Account.sol:887, and a decoder-site
  /// gas revert additionally exists at Account.sol:1102-1104 — do NOT
  /// copy the tolerance into a multi-clause or non-empty-arguments harness.
  function _gateZeroConcreteBody() internal {
    (int256 delta0, , bool reverted, bool gasArtifact) =
      harness.run(5, 0, 1, TransformerLivenessHarness.Mode.Add, 7, false, 0, 0);
    assertTrue(reverted && !gasArtifact, "EVM gate must fire with a real error, not the gas artifact");
    assertEq(delta0, 0, "no delta may be applied without an allowance");
  }

  /// @dev Halmos-collected form (check_* prefix): expected to FAIL under
  ///      halmos (symbolic gas artifact) while passing on the EVM.
  function check_gateZeroConcrete() external {
    _gateZeroConcreteBody();
  }

  /// @dev Forge-side wrapper of the same property: green in the forge gate.
  function test_gateZeroConcrete_halmos() external {
    _gateZeroConcreteBody();
  }
}
