// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {XlnFixture} from "../helpers/XlnFixture.sol";
import {XlnHanko} from "../helpers/XlnHanko.sol";
import {Vm} from "forge-std/Vm.sol";
import "../../../contracts/Types.sol";

/// Review of J5 (PR 54): can a third party turn someone else's good signed batch into a BatchFailed and burn its nonce?
contract J5AttacksTest is XlnFixture {
  uint256 internal constant T = 1;
  address internal attacker = address(0xBAD);

  function setUp() public { _deployXln(); }

  function _depositBatch(uint256 amount) internal view returns (Batch memory b) {
    b = XlnHanko.emptyBatch();
    b.externalTokenToReserve = new ExternalTokenToReserve[](1);
    b.externalTokenToReserve[0] = ExternalTokenToReserve({
      entity: entity[0], contractAddress: address(erc20), externalTokenId: 0, tokenType: 0, internalTokenId: T, amount: amount
    });
  }

  function _call(address from, uint256 actor, bytes memory encoded, uint256 nonce) internal returns (bool ok, bytes memory ret) {
    bytes32 h = XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), entity[actor], encoded, nonce);
    bytes memory data = abi.encodeCall(dep.processBatch, (entity[actor], encoded, _hanko(actor, h), nonce));
    vm.prank(from);
    (ok, ret) = address(dep).call(data);
  }

  /// The honest owner would submit from `signer[0]`, who holds the tokens and the allowance.
  function _fundOwner(uint256 amount) internal {
    erc20.mint(signer[0], amount);
    vm.prank(signer[0]);
    erc20.approve(address(dep), amount);
  }

  function test_ownerSubmitsDepositBatch_control() public {
    _fundOwner(400);
    bytes memory encoded = abi.encode(_depositBatch(400));
    vm.recordLogs();
    (bool ok,) = _call(signer[0], 0, encoded, 1);
    assertTrue(ok);
    assertFalse(XlnHanko.batchFailed(vm.getRecordedLogs()));
    assertEq(dep._reserves(entity[0], T), 400);
    assertEq(dep.entityNonces(entity[0]), 1);
  }

  /// Review finding F1, fixed: a batch with a deposit leg reverts whole (deposits pull from the caller, so whether one succeeds
  /// depends on who submits). A relayer without an allowance reverts, the signer's nonce stays open, and the owner lands it.
  function test_relayerWithoutAllowanceCannotBurnTheNonceOfADepositBatch() public {
    _fundOwner(400);
    bytes memory encoded = abi.encode(_depositBatch(400));
    vm.recordLogs();
    (bool ok, bytes memory ret) = _call(attacker, 0, encoded, 1);
    assertFalse(ok, "the relayer's call reverts");
    assertFalse(XlnHanko.batchFailed(vm.getRecordedLogs()), "no BatchFailed");
    assertEq(dep.entityNonces(entity[0]), 0, "the signer's nonce is untouched");
    assertEq(dep._reserves(entity[0], T), 0, "nothing deposited");
    ret; // the revert reason is the token's (no allowance), not ours
    // the owner, who did everything right, lands the same signed batch
    (bool ok2,) = _call(signer[0], 0, encoded, 1);
    assertTrue(ok2);
    assertEq(dep._reserves(entity[0], T), 400);
    assertEq(dep.entityNonces(entity[0]), 1);
  }

  /// Two legs in one batch: the deposit leg puts the whole batch on the reverting side, the payment beside it included.
  function test_J6_relayerCannotBurnTheNonceOfADepositBatchWithAPaymentBesideIt() public {
    _fundOwner(400);
    Batch memory b = _depositBatch(200);
    b.reserveToReserve = new ReserveToReserve[](1);
    b.reserveToReserve[0] = ReserveToReserve({ receivingEntity: entity[1], tokenId: T, amount: 200 });
    bytes memory encoded = abi.encode(b);
    (bool ok,) = _call(attacker, 0, encoded, 1);
    assertFalse(ok);
    assertEq(dep.entityNonces(entity[0]), 0);
    assertEq(dep._reserves(entity[1], T), 0);
  }

  /// A deposit leg that fails for a state reason (the payment beside it overdraws) reverts too, and takes no nonce.
  function test_J6_depositBatchWithAFailingPaymentRevertsWhole() public {
    _fundOwner(400);
    Batch memory b = _depositBatch(200);
    b.reserveToReserve = new ReserveToReserve[](1);
    b.reserveToReserve[0] = ReserveToReserve({ receivingEntity: entity[1], tokenId: T, amount: 5_000 });
    bytes memory encoded = abi.encode(b);
    vm.recordLogs();
    (bool ok,) = _call(signer[0], 0, encoded, 1);
    assertFalse(ok);
    assertFalse(XlnHanko.batchFailed(vm.getRecordedLogs()));
    assertEq(dep.entityNonces(entity[0]), 0);
    assertEq(erc20.balanceOf(signer[0]), 400, "the tokens were not pulled");
  }
}


/// R-SPLIT for the hash-ladder member of the dispute-op set: a ladder registration beside a failing payment reverts the batch.
contract J5SplitTest is XlnFixture {
  function setUp() public { _deployXln(); }

  function test_ladderRegistrationBesideFailingPaymentRevertsWhole() public {
    Batch memory b = XlnHanko.emptyBatch();
    b.reserveToReserve = new ReserveToReserve[](1);
    b.reserveToReserve[0] = ReserveToReserve({ receivingEntity: entity[1], tokenId: 1, amount: 5_000 }); // reserve is 0
    b.hashLadderRegistrations = new HashLadderRegistration[](1);
    bytes32[4] memory none;
    b.hashLadderRegistrations[0] = HashLadderRegistration({
      counterpartyEntity: entity[1], targetRole: false, fullHash: bytes32(uint256(1)), partialRoot: bytes32(uint256(2)),
      witness: HashLadderWitness({ fillRatio: 0, fullSecret: bytes32(0), reveals: none })
    });
    bytes memory encoded = abi.encode(b);
    bytes32 h = XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), entity[0], encoded, 1);
    vm.recordLogs();
    (bool ok,) = address(dep).call(abi.encodeCall(dep.processBatch, (entity[0], encoded, _hanko(0, h), 1)));
    assertFalse(ok, "reverts, does not soft-fail");
    assertFalse(XlnHanko.batchFailed(vm.getRecordedLogs()), "no BatchFailed");
    assertEq(dep.entityNonces(entity[0]), 0);
  }

  function _splitBody(int256 offdelta) internal pure returns (ProofBody memory pb) {
    pb.watchSeed = keccak256("r-split-counter");
    pb.leftResponseSeconds = 60;
    pb.rightResponseSeconds = 60;
    pb.offdeltas = new Int512[](1);
    pb.offdeltas[0] = WideMath.fromInt(offdelta);
    pb.tokenIds = new uint256[](1);
    pb.tokenIds[0] = 1;
    pb.transformers = new TransformerClause[](0);
  }

  /// R-SPLIT for the counter-dispute member: a good counter beside a failing payment reverts the batch (E3, from the payment), takes no
  /// nonce, and the same counter then lands alone. Needs a live dispute and a real newer state, so that the counter itself is good.
  function test_R_SPLIT_counterBesideFailingPaymentRevertsWhole() public {
    bytes memory key = XlnHanko.accountKey(entity[0], entity[1]);
    ProofBody memory initial = _splitBody(0);
    bytes32 initialHash = keccak256(abi.encode(initial));
    bool bProposes = entity[1] < entity[0];
    Batch memory start = XlnHanko.emptyBatch();
    start.disputeStarts = new InitialDisputeProof[](1);
    start.disputeStarts[0] = InitialDisputeProof({
      counterentity: entity[1], nonce: 1, ondeltaEpoch: XlnHanko.currentEpoch(address(dep), key), proposerIsLeft: bProposes,
      proofbodyHash: initialHash, initialProofbody: initial, watchSeed: initial.watchSeed,
      sig: _hanko(1, XlnHanko.disputeProofHash(address(dep), key, 1, bProposes, initialHash, initial.watchSeed)),
      starterInitialArguments: "", starterCounterArguments: "", starterCounterProofCommitment: bytes32(0)
    });
    assertTrue(_submit(0, start), "A starts the dispute");

    ProofBody memory newer = _splitBody(30);
    bytes32 newerHash = keccak256(abi.encode(newer));
    Batch memory b = XlnHanko.emptyBatch();
    b.counterDisputes = new CounterDisputeProof[](1);
    b.counterDisputes[0] = CounterDisputeProof({
      counterentity: entity[0], initialNonce: 1, initialProofbodyHash: initialHash, counterNonce: 3, proposerIsLeft: bProposes,
      counterProofbody: newer,
      sig: _hanko(0, XlnHanko.disputeProofHash(address(dep), key, 3, bProposes, newerHash, newer.watchSeed))
    });
    Batch memory withPayment = XlnHanko.emptyBatch(); // a new struct: `= b` would alias it
    withPayment.counterDisputes = b.counterDisputes;
    withPayment.reserveToReserve = new ReserveToReserve[](1);
    withPayment.reserveToReserve[0] = ReserveToReserve({ receivingEntity: entity[0], tokenId: 1, amount: 5_000 }); // B's reserve is 0

    bytes memory encoded = abi.encode(withPayment);
    uint256 nonce = dep.entityNonces(entity[1]) + 1;
    bytes32 h = XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), entity[1], encoded, nonce);
    vm.recordLogs();
    (bool ok, bytes memory ret) = address(dep).call(abi.encodeCall(dep.processBatch, (entity[1], encoded, _hanko(1, h), nonce)));
    assertFalse(ok, "reverts, does not soft-fail");
    assertEq(bytes4(ret), bytes4(keccak256("E3()")), "the payment is what fails");
    assertFalse(XlnHanko.batchFailed(vm.getRecordedLogs()), "no BatchFailed");
    assertEq(dep.entityNonces(entity[1]), nonce - 1, "no nonce taken");
    assertTrue(_submit(1, b), "the counter itself was good: it lands alone");
  }

  function _revealBatchWithFailingPayment() internal view returns (bytes memory) {
    Batch memory b = XlnHanko.emptyBatch();
    b.reserveToReserve = new ReserveToReserve[](1);
    b.reserveToReserve[0] = ReserveToReserve({ receivingEntity: entity[1], tokenId: 1, amount: 5_000 }); // reserve is 0
    b.revealSecrets = new SecretReveal[](1);
    b.revealSecrets[0] = SecretReveal({ transformer: address(deltaTransformer), secret: bytes32(uint256(7)) });
    return abi.encode(b);
  }

  /// R-SPLIT for the reveal member: a secret reveal beside a failing payment reverts the batch, takes no nonce, and the reveal is not recorded.
  function test_R_SPLIT_revealBesideFailingPaymentRevertsWhole() public {
    bytes memory encoded = _revealBatchWithFailingPayment();
    bytes32 h = XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), entity[0], encoded, 1);
    vm.recordLogs();
    (bool ok,) = address(dep).call(abi.encodeCall(dep.processBatch, (entity[0], encoded, _hanko(0, h), 1)));
    assertFalse(ok, "reverts, does not soft-fail");
    assertFalse(XlnHanko.batchFailed(vm.getRecordedLogs()), "no BatchFailed");
    assertEq(dep.entityNonces(entity[0]), 0, "no nonce taken");
    assertEq(deltaTransformer.hashToTimestamp(keccak256(abi.encode(bytes32(uint256(7))))), 0, "the reveal is rolled back");
  }
}

import {ERC721Mock} from "../../../contracts/ERC721Mock.sol";

/// Gas starvation: which call depths let a starved failure bubble up as an ordinary revert with >= 1/32 of the gas left?
/// Since the review fix a batch with a deposit leg reverts whole, so these two sweeps can no longer soft-fail: they are kept as
/// the pin that a deposit batch never returns as BatchFailed at any gas limit. The soft path is swept in vm/j5-review-extra.
contract J5GasDepthTest is XlnFixture {
  ERC721Mock internal nft;
  uint256 internal nftTokenId;

  function setUp() public {
    _deployXln();
    nft = new ERC721Mock("N", "N");
    nft.mint(signer[0], 7);
    bytes32 foundationId = bytes32(uint256(1));
    uint256 nonce = ep.entityActionNonces(foundationId) + 1;
    bytes32 actionHash = ep.computeFoundationActionHash(
      ep.FOUNDATION_REGISTER_TOKEN(), keccak256(abi.encode(address(dep), uint8(1), address(nft), uint256(7))), nonce
    );
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(FOUNDATION_PK, actionHash);
    nftTokenId = ep.foundationRegisterExternalToken(address(dep), 1, address(nft), 7, XlnHanko.encodeSingleSignerHanko(foundationId, v, r, s), nonce);
    vm.prank(signer[0]);
    nft.approve(address(dep), 7);
    erc20.mint(signer[0], 400);
    vm.prank(signer[0]);
    erc20.approve(address(dep), 400);
  }

  function _data(Batch memory b) internal view returns (bytes memory) {
    bytes memory encoded = abi.encode(b);
    bytes32 h = XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), entity[0], encoded, 1);
    return abi.encodeCall(dep.processBatch, (entity[0], encoded, _hanko(0, h), 1));
  }

  /// @return softFails gas limits at which the call returned normally with BatchFailed; okCount limits at which it landed
  function _sweep(bytes memory data, uint256 lo, uint256 hi, uint256 step) internal returns (uint256 softFails, uint256 okCount, uint256 firstSoft) {
    for (uint256 g = lo; g <= hi; g += step) {
      uint256 snap = vm.snapshotState();
      vm.recordLogs();
      vm.prank(signer[0]);
      (bool ok,) = address(dep).call{gas: g}(data);
      bool failedSoft = ok && XlnHanko.batchFailed(vm.getRecordedLogs());
      if (failedSoft) { if (softFails == 0) firstSoft = g; softFails++; }
      else if (ok) okCount++;
      vm.revertToState(snap);
    }
  }

  function test_gasSweep_erc20Deposit_depthTwo() public {
    Batch memory b = XlnHanko.emptyBatch();
    b.externalTokenToReserve = new ExternalTokenToReserve[](1);
    b.externalTokenToReserve[0] = ExternalTokenToReserve({ entity: entity[0], contractAddress: address(erc20), externalTokenId: 0, tokenType: 0, internalTokenId: 1, amount: 400 });
    (uint256 soft, uint256 landed,) = _sweep(_data(b), 150_000, 400_000, 250);
    emit log_named_uint("erc20: soft fails", soft);
    emit log_named_uint("erc20: landed", landed);
    assertEq(soft, 0, "a good ERC20 deposit batch never soft-fails from gas starvation");
    assertGt(landed, 0);
  }

  function test_F16_gasSweep_erc721Deposit_depthThree() public {
    Batch memory b = XlnHanko.emptyBatch();
    b.externalTokenToReserve = new ExternalTokenToReserve[](1);
    b.externalTokenToReserve[0] = ExternalTokenToReserve({ entity: entity[0], contractAddress: address(nft), externalTokenId: 7, tokenType: 1, internalTokenId: nftTokenId, amount: 1 });
    (uint256 soft, uint256 landed, uint256 first) = _sweep(_data(b), 100_000, 400_000, 250);
    emit log_named_uint("erc721: soft fails", soft);
    emit log_named_uint("erc721: first soft-fail gas limit", first);
    emit log_named_uint("erc721: landed", landed);
    assertEq(soft, 0, "a good ERC721 deposit batch never soft-fails from gas starvation");
    assertGt(landed, 0);
  }
}
