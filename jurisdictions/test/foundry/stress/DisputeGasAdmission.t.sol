// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {console} from "forge-std/Test.sol";
import {XlnFixture, XlnHanko} from "../helpers/XlnFixture.sol";
import "../../../contracts/Types.sol";
import "../../../contracts/HashLadder.sol";
import {DeltaTransformer} from "../../../contracts/DeltaTransformer.sol";

/// Real signed starts/finalizations with a hard transaction allowance, not gas estimates.
contract DisputeGasAdmissionTest is XlnFixture {
  uint256 internal constant BUDGET = 5_000_000;

  uint16 internal pullRatio = 65535;
  uint256 internal chunkSize = 8;
  bool internal maximalStarter;
  bool internal irrelevantSecrets;

  function setUp() public { _deployXln(); }

  function _submitBudget(uint256 actor, Batch memory batch) internal returns (uint256 used) {
    bytes memory encoded = abi.encode(batch);
    uint256 nonce = dep.entityNonces(entity[actor]) + 1;
    bytes memory signature = _hanko(actor, XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), encoded, nonce));
    bytes memory data = abi.encodeCall(dep.processBatch, (encoded, signature, nonce));
    // Treat even zero bytes as nonzero. EIP-7623 is a FLOOR, not an
    // additional execution charge: max(intrinsic + execution, calldata floor).
    uint256 overhead = 21_000 + data.length * 16;
    uint256 floor = 21_000 + data.length * 40;
    require(overhead < BUDGET, "calldata exceeds gas budget");
    vm.cool(address(dep));
    vm.cool(address(ep));
    vm.cool(address(deltaTransformer));
    uint256 before = gasleft();
    (bool ok,) = address(dep).call{gas: BUDGET - overhead}(data);
    used = before - gasleft() + overhead;
    if (used < floor) used = floor;
    assertTrue(ok, "signed dispute must execute within 5M including calldata");
    assertLt(used, BUDGET, "total dispute budget");
  }

  function _ladder(uint256 index) internal view returns (bytes32 fullHash, bytes32 root, HashLadderWitness memory witness) {
    witness.fullSecret = keccak256(abi.encode(index, "full"));
    witness.fillRatio = pullRatio;
    fullHash = HashLadder.hashFullSecret(witness.fullSecret);
    if (pullRatio == 65535) return (fullHash, keccak256(abi.encode(index, "root")), witness);
    for (uint8 i; i < 4; i++) {
      bytes32 base = keccak256(abi.encode(index, "nib", i));
      witness.reveals[i] = HashLadder.revealForNibble(base, HashLadder.nibbleAt(pullRatio, i));
    }
    root = HashLadder.partialRootFromReveals(pullRatio, witness.reveals);
  }

  function _body(uint256 tokens, uint256 payments, uint256 swaps, uint256 pulls, bool wide) internal view returns (ProofBody memory pb, bytes memory arguments) {
    pb.watchSeed = keccak256("gas-admission");
    pb.leftResponseSeconds = LEFT_RESPONSE_SECONDS;
    pb.rightResponseSeconds = RIGHT_RESPONSE_SECONDS;
    pb.tokenIds = new uint256[](tokens);
    pb.offdeltas = new Int512[](tokens);
    for (uint256 i; i < tokens; i++) {
      pb.tokenIds[i] = i + 1;
      // Exercise cold debt creation; wide values require both Uint512 limbs.
      pb.offdeltas[i] = wide ? Int512(1, 1) : Int512(1, 0);
    }
    uint256 clauses = (payments + chunkSize - 1) / chunkSize + (swaps + chunkSize - 1) / chunkSize + (pulls + chunkSize - 1) / chunkSize;
    pb.transformers = new TransformerClause[](clauses);
    bytes[] memory args = new bytes[](clauses);
    uint256 clause;
    for (uint256 kind; kind < 3; kind++) {
      uint256 count = kind == 0 ? payments : kind == 1 ? swaps : pulls;
      for (uint256 offset; offset < count; offset += chunkSize) {
        uint256 n = count - offset < chunkSize ? count - offset : chunkSize;
        DeltaTransformer.Batch memory b;
        b.payment = new DeltaTransformer.Payment[](kind == 0 ? n : 0);
        b.swap = new DeltaTransformer.Swap[](kind == 1 ? n : 0);
        b.pull = new DeltaTransformer.Pull[](kind == 2 ? n : 0);
        DeltaTransformer.Arguments memory a;
        a.secrets = new bytes32[](kind == 0 ? n : 0);
        a.fillRatios = new uint16[](kind == 1 ? n : 0);
        for (uint256 i; i < n; i++) {
          if (kind == 0) {
            a.secrets[i] = keccak256(abi.encode(offset, i));
            b.payment[i] = DeltaTransformer.Payment(i % tokens, SignedAmount(false, 1), block.timestamp + DISPUTE_WINDOW_SECONDS + 100, keccak256(abi.encode(a.secrets[i])));
          } else if (kind == 1) {
            a.fillRatios[i] = 65535;
            b.swap[i] = DeltaTransformer.Swap(true, i % tokens, 1, (i + 1) % tokens, 1);
          } else {
            (bytes32 fullHash, bytes32 root,) = _ladder(offset + i);
            b.pull[i] = DeltaTransformer.Pull(i % tokens, SignedAmount(false, 10000), 0, fullHash, root, false);
          }
        }
        Allowance[] memory allowances = new Allowance[](tokens);
        for (uint256 i; i < tokens; i++) allowances[i] = Allowance(i, 100000, 100000);
        pb.transformers[clause] = TransformerClause(address(deltaTransformer), abi.encode(b), allowances);
        args[clause++] = abi.encode(a);
      }
    }
    arguments = clauses == 0 ? bytes("") : abi.encode(args);
  }

  function _exercise(uint256 tokens, uint256 payments, uint256 swaps, uint256 pulls, bool wide) internal {
    (ProofBody memory pb, bytes memory args) = _body(tokens, payments, swaps, pulls, wide);
    bytes memory starter = args;
    if (maximalStarter) {
      starter = new bytes(64 * 1024);
      for (uint256 offset; offset < starter.length; offset += 32) {
        assembly ("memory-safe") { mstore(add(add(starter, 32), offset), not(0)) }
      }
      for (uint256 i; i < args.length; i++) starter[i] = args[i];
    }
    if (irrelevantSecrets) {
      DeltaTransformer.Arguments memory noise;
      noise.fillRatios = new uint16[](0);
      noise.secrets = new bytes32[](2000);
      for (uint256 i; i < noise.secrets.length; i++) noise.secrets[i] = keccak256(abi.encode("irrelevant", i));
      bytes[] memory clauses = new bytes[](1);
      clauses[0] = abi.encode(noise);
      starter = abi.encode(clauses);
    }
    bytes32 hash = keccak256(abi.encode(pb));
    bool proposerIsLeft = entity[1] < entity[0];
    Batch memory start = XlnHanko.emptyBatch();
    start.disputeStarts = new InitialDisputeProof[](1);
    start.disputeStarts[0] = InitialDisputeProof(entity[1], 1, proposerIsLeft, hash, pb, pb.watchSeed,
      _hanko(1, XlnHanko.disputeProofHash(address(dep), XlnHanko.accountKey(entity[0], entity[1]), 1, proposerIsLeft, hash, pb.watchSeed)), starter, "", bytes32(0));
    console.log("start total conservative gas", _submitBudget(0, start));
    if (pulls > 0) {
      Batch memory reveal = XlnHanko.emptyBatch();
      reveal.hashLadderRegistrations = new HashLadderRegistration[](pulls);
      uint256 beneficiary = entity[0] < entity[1] ? 0 : 1;
      for (uint256 i; i < pulls; i++) {
        (bytes32 fullHash, bytes32 root, HashLadderWitness memory witness) = _ladder(i);
        reveal.hashLadderRegistrations[i] = HashLadderRegistration(entity[1-beneficiary], false, fullHash, root, witness);
      }
      console.log("reveal total conservative gas", _submitBudget(beneficiary, reveal));
    }
    vm.warp(block.timestamp + DISPUTE_WINDOW_SECONDS);
    Batch memory finish = XlnHanko.emptyBatch();
    finish.disputeFinalizations = new FinalDisputeProof[](1);
    finish.disputeFinalizations[0] = FinalDisputeProof(entity[0], 1, 1, proposerIsLeft, hash, pb, starter, args, "", entity[0] < entity[1], false);
    console.log("finalize total conservative gas", _submitBudget(1, finish));
  }

  function test_budget5m_coldDebts22() public { _exercise(22, 0, 0, 0, false); }
  function test_budget5m_wideColdDebts22() public { _exercise(22, 0, 0, 0, true); }
  function test_budget5m_payments32() public { _exercise(2, 32, 0, 0, false); }
  function test_budget5m_swaps32() public { _exercise(2, 0, 32, 0, false); }
  function test_budget5m_mixed32() public { _exercise(2, 16, 16, 0, false); }
  function test_budget5m_revealedPulls18() public { _exercise(2, 0, 0, 18, true); }
  function test_budget5m_mixedWithRevealedPulls() public { _exercise(3, 8, 8, 14, true); }

  function test_budget5m_irrelevantSecrets() public { irrelevantSecrets = true; chunkSize = 32; _exercise(7, 32, 0, 0, true); }

  function test_budget5m_maxStarterTenDebts() public { maximalStarter = true; _exercise(10, 0, 0, 0, true); }
  function test_budget5m_maxStarterMmFrontier() public { maximalStarter = true; _exercise(5, 0, 32, 18, true); }

  function test_budget5m_partialPulls18() public { pullRatio = 65534; _exercise(5, 0, 32, 18, true); }

  function test_budget5m_mmFrontier() public { _exercise(5, 0, 32, 18, true); }

  function testFuzz_budget5m_combinedStockFrontier(uint8 tokenSeed, uint8 paymentSeed, uint8 swapSeed, uint8 pullSeed) public {
    uint256 tokens = bound(uint256(tokenSeed), 1, 10);
    uint256 payments = bound(uint256(paymentSeed), 0, 32);
    uint256 swaps = bound(uint256(swapSeed), 0, 32);
    uint256 pulls = bound(uint256(pullSeed), 0, 18);
    uint256 charge = 3_000_000 + tokens * 200_000 + (10_000 + 50_000 + tokens * 4_000) * (payments + swaps + pulls);
    vm.assume(charge <= BUDGET && payments + swaps + pulls <= 32);
    maximalStarter = true;
    chunkSize = 1; // Full-width allowances may force one condition per clause.
    _exercise(tokens, payments, swaps, pulls, true);
  }
}
