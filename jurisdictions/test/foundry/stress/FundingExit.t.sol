// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {DisputeGasAdmissionTest} from "./DisputeGasAdmission.t.sol";
import {XlnHanko} from "../helpers/XlnHanko.sol";
import "../../../contracts/Types.sol";

/// Actual ERC20 custody; funding and exit use an already signed asset proof.
contract FundingExitTest is DisputeGasAdmissionTest {
  function _deposit(uint256 actor, uint256 amount) private {
    erc20.transfer(signer[actor], amount);
    vm.prank(signer[actor]);
    erc20.approve(address(dep), amount);
    Batch memory batch = XlnHanko.emptyBatch();
    batch.externalTokenToReserve = new ExternalTokenToReserve[](1);
    batch.externalTokenToReserve[0] = ExternalTokenToReserve(entity[actor], address(erc20), 0, 0, 1, amount);
    bytes memory encoded = abi.encode(batch);
    uint256 nonce = dep.entityNonces(entity[actor]) + 1;
    bytes memory signature = _hanko(actor, XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), encoded, nonce));
    vm.prank(signer[actor]);
    dep.processBatch(encoded, signature, nonce);
  }

  function _topUp(uint256 beneficiary, uint256 amount) private view returns (Batch memory batch) {
    batch = XlnHanko.emptyBatch();
    batch.reserveToCollateral = new ReserveToCollateral[](1);
    EntityAmount[] memory pairs = new EntityAmount[](1);
    pairs[0] = EntityAmount(entity[1-beneficiary], amount);
    batch.reserveToCollateral[0] = ReserveToCollateral(1, entity[beneficiary], pairs);
  }

  function _signedExit(uint256 actor, uint256 nonce, uint256 payment) private view returns (InitialDisputeProof memory) {
    ProofBody memory proof;
    proof.watchSeed = keccak256("funding-exit");
    proof.leftResponseSeconds = LEFT_RESPONSE_SECONDS;
    proof.rightResponseSeconds = RIGHT_RESPONSE_SECONDS;
    proof.tokenIds = new uint256[](1);
    proof.tokenIds[0] = 1;
    proof.offdeltas = new Int512[](1);
    proof.transformers = new TransformerClause[](0);
    bool actorIsLeft = entity[actor] < entity[1-actor];
    proof.offdeltas[0] = actorIsLeft && payment > 0 ? Int512(-1, type(uint256).max - payment + 1) : Int512(0, payment);
    bytes32 hash = keccak256(abi.encode(proof));
    return InitialDisputeProof(entity[1-actor], nonce, !actorIsLeft, hash, proof, proof.watchSeed,
      _hanko(1-actor, XlnHanko.disputeProofHash(address(dep), XlnHanko.accountKey(entity[0], entity[1]), nonce, !actorIsLeft, hash, proof.watchSeed)), "", "", bytes32(0));
  }

  function _exit(uint256 actor, InitialDisputeProof memory proof) private {
    // Peer stays offline after signing: only the funder starts and finalizes.
    Batch memory batch = XlnHanko.emptyBatch();
    batch.disputeStarts = new InitialDisputeProof[](1);
    batch.disputeStarts[0] = proof;
    _submitBudget(actor, batch);
    vm.warp(block.timestamp + DISPUTE_WINDOW_SECONDS);
    batch = XlnHanko.emptyBatch();
    batch.disputeFinalizations = new FinalDisputeProof[](1);
    batch.disputeFinalizations[0] = FinalDisputeProof(entity[1-actor], proof.nonce, proof.nonce, proof.proposerIsLeft, proof.proofbodyHash, proof.initialProofbody, "", "", "", entity[actor] < entity[1-actor], false);
    _submitBudget(actor, batch);
  }

  function _lifecycle(uint256 actor) private {
    _deposit(actor, 300);
    _deposit(2, 40);
    InitialDisputeProof memory proof = _signedExit(actor, 2, 60);
    _submitBudget(actor, _topUp(actor, 100));
    _submitBudget(actor, _topUp(actor, 50));
    _submitBudget(2, _topUp(actor, 40));
    bytes memory key = XlnHanko.accountKey(entity[0], entity[1]);
    (uint256 collateral,) = dep._collaterals(key, 1);
    assertEq(collateral, 190);
    _exit(actor, proof);
    assertEq(dep._reserves(entity[actor], 1), 280, "150 reserve plus 130 secured entitlement");
    assertEq(dep._reserves(entity[1-actor], 1), 60, "peer's signed payment");
    (collateral,) = dep._collaterals(key, 1);
    assertEq(collateral, 0, "complete exit clears custody");
    // Reopen with a fresh agreed proof. Zero collateral itself never removes
    // asset admission or requires a separate on-chain settlement handshake.
    proof = _signedExit(actor, 4, 0);
    _submitBudget(actor, _topUp(actor, 10));
    (collateral,) = dep._collaterals(key, 1);
    assertEq(collateral, 10, "unilateral funding after signed reopen");
    _exit(actor, proof);
    Batch memory withdraw = XlnHanko.emptyBatch();
    withdraw.reserveToExternalToken = new ReserveToExternalToken[](1);
    withdraw.reserveToExternalToken[0] = ReserveToExternalToken(bytes32(uint256(uint160(signer[actor]))), 1, 280);
    _submitBudget(actor, withdraw);
    assertEq(erc20.balanceOf(signer[actor]), 280, "external redemption");
    assertEq(erc20.balanceOf(address(dep)), 60, "remaining peer reserve");
  }

  function test_fundingTopupExitAndReopenLeft() public { _lifecycle(entity[0] < entity[1] ? 0 : 1); }
  function test_fundingTopupExitAndReopenRight() public { _lifecycle(entity[0] < entity[1] ? 1 : 0); }
}
