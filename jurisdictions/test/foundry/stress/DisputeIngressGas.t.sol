// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {DisputeGasAdmissionTest} from "./DisputeGasAdmission.t.sol";
import {XlnHanko} from "../helpers/XlnHanko.sol";
import {Board} from "../../../contracts/EntityTypes.sol";
import "../../../contracts/Types.sol";
import {console} from "forge-std/Test.sol";

/// Public-company share spam must not enlarge another pair's exit proof.
contract DisputeIngressGasTest is DisputeGasAdmissionTest {
  // Keep the large stock transformer builder out of the donation test's
  // inlined call frame; use the same real proof construction and signatures.
  function originalProof() external view returns (ProofBody memory, bytes memory) {
    return _body(1, 32, 0, 0, false);
  }

  function _donatePublicCompanyShares() private {
    bytes32[] memory members = new bytes32[](1);
    members[0] = bytes32(uint256(uint160(signer[2])));
    uint16[] memory powers = new uint16[](1);
    powers[0] = 1;
    bytes memory board = abi.encode(Board(1, members, powers, 0, 0, 0));
    // No Foundation listing, mintToReserve, storage injection or A/B signature.
    // Each public company releases its own real ERC1155 shares into custody.
    for (uint256 tokenId = 2; tokenId <= 128; tokenId++) {
      uint256 company = ep.registerNumberedEntity(board);
      entity[2] = bytes32(company);
      bytes32 releaseHash = ep.computeReleaseControlSharesHankoHash(company, address(dep), 2, 0, "fund", 1);
      ep.releaseControlShares(company, address(dep), 2, 0, "fund", _hanko(2, releaseHash));
      assertEq(dep.getTokensLength() - 1, tokenId);
      Batch memory funding = XlnHanko.emptyBatch();
      funding.reserveToCollateral = new ReserveToCollateral[](2);
      for (uint256 side; side < 2; side++) {
        EntityAmount[] memory pairs = new EntityAmount[](1);
        pairs[0] = EntityAmount(entity[1-side], 1);
        funding.reserveToCollateral[side] = ReserveToCollateral(tokenId, entity[side], pairs);
      }
      bytes memory encoded = abi.encode(funding);
      uint256 nonce = dep.entityNonces(entity[2]) + 1;
      bytes memory sig = _hanko(2, XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), encoded, nonce));
      dep.processBatch(encoded, sig, nonce);
      assertEq(dep._reserves(entity[2], tokenId), 0, "donor deliberately spends its own shares");
      (uint256 collateral,) = dep._collaterals(XlnHanko.accountKey(entity[0], entity[1]), tokenId);
      assertEq(collateral, 2, "unsolicited custody is not signed asset admission");
    }
  }

  function test_unsolicitedCompanySharesCannotEnlargeExitProof() public {
    // Capture the exact peer signature BEFORE public-company share donations.
    (ProofBody memory proof, bytes memory args) = this.originalProof();
    bytes32 hash = keccak256(abi.encode(proof));
    bool proposerIsLeft = entity[1] < entity[0];
    bytes memory sig = _hanko(1, XlnHanko.disputeProofHash(address(dep), XlnHanko.accountKey(entity[0], entity[1]), 1, proposerIsLeft, hash, proof.watchSeed));
    _donatePublicCompanyShares();
    Batch memory start = XlnHanko.emptyBatch();
    start.disputeStarts = new InitialDisputeProof[](1);
    start.disputeStarts[0] = InitialDisputeProof(entity[1], 1, proposerIsLeft, hash, proof, proof.watchSeed, sig, args, "", bytes32(0));
    console.log("start total conservative gas", _submitBudget(0, start));
    vm.warp(block.timestamp + DISPUTE_WINDOW_SECONDS);
    Batch memory finish = XlnHanko.emptyBatch();
    finish.disputeFinalizations = new FinalDisputeProof[](1);
    bool starterIsLeft = entity[0] < entity[1];
    finish.disputeFinalizations[0] = FinalDisputeProof(entity[1], 1, 1, proposerIsLeft, hash, proof,
      args, "", "", starterIsLeft, false);
    console.log("finalize total conservative gas", _submitBudget(0, finish));
    (uint256 unsolicited,) = dep._collaterals(XlnHanko.accountKey(entity[0], entity[1]), 128);
    assertEq(unsolicited, 2, "exit touches only assets in the original signed proof");
  }
}
