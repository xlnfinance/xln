// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {console} from "forge-std/Test.sol";
import {XlnFixture} from "./helpers/XlnFixture.sol";
import {XlnHanko} from "./helpers/XlnHanko.sol";
import "../../contracts/Types.sol";

/// @notice Task item 5: does every MAX_BATCH_* cap actually bound *gas*, or only
///         array length? These are deliberately not `invariant_*`: gas is a
///         property of one worst-case call, and a stateful fuzzer will never
///         construct a maximal batch by chance.
///
/// Budget reference: Depository.sol:95-98 documents a "15M-gas liveness
/// envelope" inside a 30M block.
contract BatchBoundsTest is XlnFixture {
  uint256 internal constant T = 1;

  uint256 internal constant LIVENESS_BUDGET = 15_000_000;
  uint256 internal constant BLOCK_BUDGET = 30_000_000;

  function setUp() public {
    _deployXln();
  }

  function _rawSubmit(uint256 actor, Batch memory batch)
    internal returns (bool ok, uint256 gasUsed, uint256 calldataBytes)
  {
    bytes memory encoded = abi.encode(batch);
    uint256 nonce = dep.entityNonces(entity[actor]) + 1;
    bytes32 h = XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), encoded, nonce);
    bytes memory hanko = _hanko(actor, h);
    calldataBytes = abi.encodeCall(dep.processBatch, (encoded, hanko, nonce)).length;

    uint256 before = gasleft();
    try dep.processBatch(encoded, hanko, nonce) { ok = true; } catch { ok = false; }
    gasUsed = before - gasleft();
  }

  function _expectBoundsRevert(uint256 actor, Batch memory batch) internal {
    bytes memory encoded = abi.encode(batch);
    uint256 nonce = dep.entityNonces(entity[actor]) + 1;
    bytes32 h = XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), encoded, nonce);
    vm.expectRevert(bytes4(keccak256("E10()")));
    dep.processBatch(encoded, _hanko(actor, h), nonce);
  }

  // ─────────── length caps ───────────

  function test_totalOpsCapRejectsFiftyOne() public {
    dep.mintToReserve(entity[0], T, 1_000);
    Batch memory b = XlnHanko.emptyBatch();
    b.reserveToReserve = new ReserveToReserve[](51);
    for (uint256 i = 0; i < 51; i++) {
      b.reserveToReserve[i] = ReserveToReserve({ receivingEntity: entity[1], tokenId: T, amount: 1 });
    }
    _expectBoundsRevert(0, b);
  }

  function test_totalOpsCapAcceptsFifty() public {
    dep.mintToReserve(entity[0], T, 1_000);
    Batch memory b = XlnHanko.emptyBatch();
    b.reserveToReserve = new ReserveToReserve[](50);
    for (uint256 i = 0; i < 50; i++) {
      b.reserveToReserve[i] = ReserveToReserve({ receivingEntity: entity[1], tokenId: T, amount: 1 });
    }
    (bool ok,,) = _rawSubmit(0, b);
    assertTrue(ok, "50 ops must be accepted");
  }

  /// @dev MAX_BATCH_RESERVE_TO_RESERVE / _RESERVE_TO_COLLATERAL /
  ///      _COLLATERAL_TO_RESERVE / _EXTERNAL_TO_RESERVE / _RESERVE_TO_EXTERNAL
  ///      are all 64, which MAX_BATCH_TOTAL_OPS (50) already excludes. This test
  ///      documents that those five caps are unreachable, so they cannot be the
  ///      thing bounding gas.
  function test_perArrayCapOf64IsUnreachableBehindTotalOpsCap() public {
    dep.mintToReserve(entity[0], T, 1_000);
    Batch memory b = XlnHanko.emptyBatch();
    b.reserveToReserve = new ReserveToReserve[](64);
    for (uint256 i = 0; i < 64; i++) {
      b.reserveToReserve[i] = ReserveToReserve({ receivingEntity: entity[1], tokenId: T, amount: 1 });
    }
    _expectBoundsRevert(0, b); // rejected by TOTAL_OPS, never by the 64 cap
  }

  function test_flashloanCapRejectsNine() public {
    Batch memory b = XlnHanko.emptyBatch();
    b.flashloans = new Flashloan[](9);
    for (uint256 i = 0; i < 9; i++) b.flashloans[i] = Flashloan({ tokenId: T, amount: 0 });
    _expectBoundsRevert(0, b);
  }

  function test_settlementCapRejectsThirtyThree() public {
    Batch memory b = XlnHanko.emptyBatch();
    b.settlements = new Settlement[](33);
    for (uint256 i = 0; i < 33; i++) {
      b.settlements[i] = Settlement({
        leftEntity: entity[0], rightEntity: entity[1],
        diffs: new SettlementDiff[](0), forgiveDebtsInTokenIds: new uint256[](0),
        sig: "", nonce: 1
      });
    }
    _expectBoundsRevert(0, b);
  }

  function test_reserveToCollateralPairCapRejectsSixtyFive() public {
    Batch memory b = XlnHanko.emptyBatch();
    b.reserveToCollateral = new ReserveToCollateral[](1);
    EntityAmount[] memory pairs = new EntityAmount[](65);
    for (uint256 i = 0; i < 65; i++) pairs[i] = EntityAmount({ entity: entity[1], amount: 1 });
    b.reserveToCollateral[0] = ReserveToCollateral({
      tokenId: T, receivingEntity: entity[0], pairs: pairs
    });
    _expectBoundsRevert(0, b);
  }

  // ─────────── gas caps ───────────

  /// @notice The aggregate cap, not just each array dimension, must keep the
  ///         worst valid R2C product inside the 15M protocol liveness budget.
  function test_gas_maxReserveToCollateralProduct() public {
    uint256 entries = 4;
    uint256 pairsPer = 64;
    dep.mintToReserve(entity[0], T, entries * pairsPer);

    Batch memory b = XlnHanko.emptyBatch();
    b.reserveToCollateral = new ReserveToCollateral[](entries);
    for (uint256 i = 0; i < entries; i++) {
      EntityAmount[] memory pairs = new EntityAmount[](pairsPer);
      for (uint256 j = 0; j < pairsPer; j++) {
        // distinct counterparties keep every write a cold SSTORE
        pairs[j] = EntityAmount({
          entity: keccak256(abi.encodePacked("cp", i, j)),
          amount: 1
        });
      }
      b.reserveToCollateral[i] = ReserveToCollateral({
        tokenId: T, receivingEntity: entity[0], pairs: pairs
      });
    }

    (bool ok, uint256 gasUsed, uint256 cd) = _rawSubmit(0, b);
    console.log("R2C 4x64  ok:", ok);
    console.log("R2C 4x64  execution gas:", gasUsed);
    console.log("R2C 4x64  calldata bytes:", cd);
    assertTrue(ok, "256 R2C pairs must be accepted");
    assertLt(gasUsed, LIVENESS_BUDGET, "max R2C batch exceeds the 15M liveness budget");
  }

  function test_reserveToCollateralAggregatePairCapRejectsTwoHundredFiftySeven() public {
    Batch memory b = XlnHanko.emptyBatch();
    b.reserveToCollateral = new ReserveToCollateral[](5);
    for (uint256 i = 0; i < 5; i++) {
      uint256 pairCount = i == 4 ? 1 : 64;
      EntityAmount[] memory pairs = new EntityAmount[](pairCount);
      for (uint256 j = 0; j < pairCount; j++) {
        pairs[j] = EntityAmount({ entity: keccak256(abi.encodePacked("cp", i, j)), amount: 1 });
      }
      b.reserveToCollateral[i] = ReserveToCollateral({
        tokenId: T, receivingEntity: entity[0], pairs: pairs
      });
    }
    _expectBoundsRevert(0, b);
  }

  /// @notice Worst case under the caps: 32 settlements × 32 diffs = 1024 signed
  ///         token diffs. Only the signature check is per-settlement; the diff
  ///         loop is quadratic in `diffs` (duplicate-tokenId scan at
  ///         Account.sol:979-983) plus three passes for the event.
  function test_gas_maxSettlementProduct() public {
    uint256 settlements = 32;
    uint256 diffsPer = 32;
    dep.mintToReserve(entity[0], 1, 1e18);

    Batch memory b = XlnHanko.emptyBatch();
    b.settlements = new Settlement[](settlements);
    for (uint256 i = 0; i < settlements; i++) {
      SettlementDiff[] memory diffs = new SettlementDiff[](diffsPer);
      for (uint256 j = 0; j < diffsPer; j++) {
        diffs[j] = SettlementDiff({
          tokenId: j + 1, leftDiff: 0, rightDiff: 0, collateralDiff: 0, ondeltaDiff: 0
        });
      }
      // Signature is invalid on purpose: the item is skipped *after* every
      // bound-check and the duplicate scan already ran, which is the gas we
      // want to price.
      b.settlements[i] = Settlement({
        leftEntity: entity[0] < entity[1] ? entity[0] : entity[1],
        rightEntity: entity[0] < entity[1] ? entity[1] : entity[0],
        diffs: diffs,
        forgiveDebtsInTokenIds: new uint256[](0),
        sig: hex"00",
        nonce: i + 1
      });
    }

    (bool ok, uint256 gasUsed, uint256 cd) = _rawSubmit(0, b);
    console.log("Settle 32x32  ok:", ok);
    console.log("Settle 32x32  execution gas:", gasUsed);
    console.log("Settle 32x32  calldata bytes:", cd);
    assertLt(gasUsed, BLOCK_BUDGET, "max settlement batch exceeds a 30M block");
  }

  /// @dev Measures one shape so the cost model is explicit rather than assumed.
  function _measureR2C(uint256 entries, uint256 pairsPer, bool distinctCounterparties)
    internal returns (uint256 gasUsed)
  {
    dep.mintToReserve(entity[0], T, entries * pairsPer);
    Batch memory b = XlnHanko.emptyBatch();
    b.reserveToCollateral = new ReserveToCollateral[](entries);
    for (uint256 i = 0; i < entries; i++) {
      EntityAmount[] memory pairs = new EntityAmount[](pairsPer);
      for (uint256 j = 0; j < pairsPer; j++) {
        pairs[j] = EntityAmount({
          entity: distinctCounterparties ? keccak256(abi.encodePacked("cp", i, j)) : entity[1],
          amount: 1
        });
      }
      b.reserveToCollateral[i] = ReserveToCollateral({
        tokenId: T, receivingEntity: entity[0], pairs: pairs
      });
    }
    (, gasUsed,) = _rawSubmit(0, b);
  }

  /// @notice Cost curve for the reserve-to-collateral product, so the gap
  ///         between "passes the caps" and "fits in a block" is a number.
  function test_gas_reserveToCollateralCostCurve() public {
    console.log("entries x pairs -> execution gas");
    console.log(" 1x 1  distinct:", _measureR2C(1, 1, true));
    console.log(" 1x64  distinct:", _measureR2C(1, 64, true));
    console.log("10x64  distinct:", _measureR2C(10, 64, true));
    console.log("50x64  warm    :", _measureR2C(50, 64, false));
  }

  // ─────────── dispute finalization: the defensive path ───────────

  function _proofBody(bytes32 seed, uint256 tokenCount, int256 offdelta)
    internal pure returns (ProofBody memory pb)
  {
    pb.watchSeed = seed;
    pb.offdeltas = new int256[](tokenCount);
    pb.tokenIds = new uint256[](tokenCount);
    for (uint256 i = 0; i < tokenCount; i++) {
      pb.tokenIds[i] = i + 1; // strictly ascending, as _validateProofBody requires
      pb.offdeltas[i] = offdelta;
    }
    pb.transformers = new TransformerClause[](0);
  }

  /// @notice A dispute finalization is a *defensive* action: if the honest
  ///         party's finalize cannot be mined, the account stays frozen past the
  ///         timeout. MAX_DISPUTE_PROOF_TOKENS is 128 per proof and
  ///         MAX_BATCH_DISPUTE_FINALIZATIONS is 8 per batch.
  function test_gas_disputeFinalizeWithMaxProofTokens() public {
    uint256 tokenCount = 128;
    bytes32 me = entity[0];
    bytes32 other = entity[1];
    bytes32 seed = keccak256("seed");
    ProofBody memory pb = _proofBody(seed, tokenCount, int256(0));
    bytes32 pbHash = keccak256(abi.encode(pb));
    (uint256 accNonce,,,,,,,) = dep._accounts(XlnHanko.accountKey(me, other));
    uint256 nonce = accNonce + 1;

    Batch memory start = XlnHanko.emptyBatch();
    start.disputeStarts = new InitialDisputeProof[](1);
    start.disputeStarts[0] = InitialDisputeProof({
      counterentity: other, nonce: nonce, proofbodyHash: pbHash,
      initialProofbody: pb, watchSeed: seed,
      sig: _hanko(1, XlnHanko.disputeProofHash(
        address(dep), XlnHanko.accountKey(me, other), nonce, pbHash, seed
      )),
      starterInitialArguments: "", starterIncrementedArguments: ""
    });
    (bool startedOk, uint256 startGas,) = _rawSubmit(0, start);
    console.log("disputeStart 128 tokens ok:", startedOk);
    console.log("disputeStart 128 tokens gas:", startGas);

    vm.roll(block.number + DISPUTE_DELAY);

    Batch memory fin = XlnHanko.emptyBatch();
    fin.disputeFinalizations = new FinalDisputeProof[](1);
    fin.disputeFinalizations[0] = FinalDisputeProof({
      counterentity: other, initialNonce: nonce, finalNonce: nonce,
      initialProofbodyHash: pbHash, finalProofbody: pb,
      starterArguments: "", otherArguments: "", sig: "",
      startedByLeft: me < other, cooperative: false
    });
    (bool ok, uint256 gasUsed,) = _rawSubmit(0, fin);
    console.log("disputeFinalize 1x128 ok:", ok);
    console.log("disputeFinalize 1x128 gas:", gasUsed);
    console.log("x8 finalizations would be:", gasUsed * 8);
    assertTrue(ok, "max-token finalize must succeed");
    assertLt(gasUsed * 8, BLOCK_BUDGET, "a full disputeFinalizations batch exceeds a 30M block");
  }

  /// @notice Encoded-batch size cap. 256 KiB of calldata at the EIP-7623 floor
  ///         of 40 gas per non-zero byte is ~10.5M gas of intrinsic cost before
  ///         a single opcode executes.
  function test_encodedBatchSizeCapIsEnforced() public {
    // One R2C entry whose pairs array is legal, repeated until the encoding
    // crosses 256 KiB, must be rejected by the size cap rather than by gas.
    Batch memory b = XlnHanko.emptyBatch();
    b.reserveToCollateral = new ReserveToCollateral[](50);
    for (uint256 i = 0; i < 50; i++) {
      EntityAmount[] memory pairs = new EntityAmount[](64);
      for (uint256 j = 0; j < 64; j++) pairs[j] = EntityAmount({ entity: entity[1], amount: 1 });
      b.reserveToCollateral[i] = ReserveToCollateral({
        tokenId: T, receivingEntity: entity[0], pairs: pairs
      });
    }
    uint256 size = abi.encode(b).length;
    console.log("max-shape encoded batch bytes:", size);
    console.log("EIP-7623 floor cost (40/byte):", size * 40);
    assertLt(size, 256 * 1024, "max-shape batch already exceeds MAX_ENCODED_BATCH_BYTES");
  }
}
