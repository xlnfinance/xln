// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {XlnFixture} from "../helpers/XlnFixture.sol";
import {XlnHanko} from "../helpers/XlnHanko.sol";
import "../../../contracts/Types.sol";

/// R-IMPLICIT-BASELINE, epoch 0: an empty-signature dispute start is refused (NotTheImplicitBaseline) before any epoch advance, even
/// when its shape is exactly the canonical one. Were it accepted at epoch 0 it would outrank nothing and erase every frame the two sides
/// co-signed (the tie trap of R-IMPLICIT-NONCE-FROM-CHAIN, one epoch earlier). The control: the same bytes are accepted after an advance.
contract ImplicitEpochZeroTest is XlnFixture {
  uint256 internal constant T = 1;

  function setUp() public { _deployXln(); }

  function _accountNonce(bytes32 a, bytes32 b) internal view returns (uint256 n) {
    (n, , , , , , , , , , , , , , , , ) = dep._accounts(XlnHanko.accountKey(a, b));
  }

  function _disputeHashOf(bytes32 a, bytes32 b) internal view returns (bytes32 h) {
    (, h, , , , , , , , , , , , , , , ) = dep._accounts(XlnHanko.accountKey(a, b));
  }

  function _fundCollateral(uint256 amount) internal {
    dep.mintToReserve(entity[0], T, amount);
    Batch memory b = XlnHanko.emptyBatch();
    b.reserveToCollateral = new ReserveToCollateral[](1);
    EntityAmount[] memory pairs = new EntityAmount[](1);
    pairs[0] = EntityAmount({ entity: entity[1], amount: amount });
    b.reserveToCollateral[0] = ReserveToCollateral({ tokenId: T, receivingEntity: entity[0], pairs: pairs });
    assertTrue(_submit(0, b));
  }

  /// @dev A co-signed withdrawal of `amount` by entity[0] from its collateral with entity[1]: the collateral-to-reserve advance of the epoch.
  function _withdraw(uint256 amount) internal {
    bool isLeft = entity[0] < entity[1];
    SettlementDiff[] memory diffs = new SettlementDiff[](1);
    diffs[0] = SettlementDiff({
      tokenId: T,
      leftDiff: SignedAmount(false, isLeft ? amount : 0),
      rightDiff: SignedAmount(false, isLeft ? 0 : amount),
      collateralDiff: SignedAmount(true, amount),
      ondeltaDiff: SignedAmount(isLeft, isLeft ? amount : 0)
    });
    uint256 nonce = _accountNonce(entity[0], entity[1]) + 1;
    bytes32 h = XlnHanko.cooperativeUpdateHash(address(dep), XlnHanko.accountKey(entity[0], entity[1]), nonce, diffs, new uint256[](0));
    Batch memory b = XlnHanko.emptyBatch();
    b.collateralToReserve = new CollateralToReserve[](1);
    b.collateralToReserve[0] = CollateralToReserve({ counterparty: entity[1], tokenId: T, amount: amount, nonce: nonce, sig: _hanko(1, h) });
    assertTrue(_submit(0, b));
  }

  /// @dev The canonical implicit start for the Account as it stands: empty signature, Right author, nonce stored + 1, floor windows,
  ///      watchSeed 0, every offdelta 0, no clause, no arguments.
  function _implicitStart() internal view returns (Batch memory b) {
    bytes memory key = XlnHanko.accountKey(entity[0], entity[1]);
    ProofBody memory pb;
    pb.leftResponseSeconds = LEFT_RESPONSE_SECONDS;
    pb.rightResponseSeconds = RIGHT_RESPONSE_SECONDS;
    pb.offdeltas = new Int512[](1);
    pb.tokenIds = new uint256[](1);
    pb.tokenIds[0] = T;
    pb.transformers = new TransformerClause[](0);
    b = XlnHanko.emptyBatch();
    b.disputeStarts = new InitialDisputeProof[](1);
    b.disputeStarts[0] = InitialDisputeProof({
      counterentity: entity[1], nonce: _accountNonce(entity[0], entity[1]) + 1, ondeltaEpoch: XlnHanko.currentEpoch(address(dep), key),
      proposerIsLeft: false, proofbodyHash: keccak256(abi.encode(pb)), initialProofbody: pb, watchSeed: bytes32(0), sig: "",
      starterInitialArguments: "", starterCounterArguments: "", starterCounterProofCommitment: bytes32(0)
    });
  }

  function _expectImplicitRefused(Batch memory b) internal {
    bytes memory encoded = abi.encode(b);
    uint256 nonce = dep.entityNonces(entity[0]) + 1;
    bytes32 h = XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), entity[0], encoded, nonce);
    bytes memory hanko = _hanko(0, h);
    vm.expectRevert(abi.encodeWithSignature("NotTheImplicitBaseline()"));
    dep.processBatch(entity[0], encoded, hanko, nonce);
    assertEq(dep.entityNonces(entity[0]), nonce - 1, "the refused batch takes no nonce");
  }

  /// A fresh Account with collateral at stake, no advance yet: the canonical implicit start is refused, nothing opens.
  function test_R_IMPLICIT_BASELINE_epochZeroRefusesTheCanonicalImplicitStart() public {
    _fundCollateral(1_000);
    assertEq(XlnHanko.currentEpoch(address(dep), XlnHanko.accountKey(entity[0], entity[1])), 0, "no advance yet");
    _expectImplicitRefused(_implicitStart());
    assertEq(_disputeHashOf(entity[0], entity[1]), bytes32(0), "no dispute opened");
  }

  /// Even at the nonce a co-signed frame would take (stored + 2): an empty signature at epoch 0 is refused whatever its nonce.
  function test_R_IMPLICIT_BASELINE_epochZeroRefusesTheImplicitStartAtAnyNonce() public {
    _fundCollateral(1_000);
    Batch memory b = _implicitStart();
    b.disputeStarts[0].nonce += 1;
    _expectImplicitRefused(b);
    b.disputeStarts[0].nonce += 4;
    _expectImplicitRefused(b);
    assertEq(_disputeHashOf(entity[0], entity[1]), bytes32(0), "no dispute opened");
  }

  /// Control: after an epoch advance the same shape is accepted, so the refusal above is the epoch and not a malformed start.
  function test_R_IMPLICIT_BASELINE_controlTheSameStartIsAcceptedAfterAnAdvance() public {
    _fundCollateral(1_000);
    _withdraw(100);
    assertEq(XlnHanko.currentEpoch(address(dep), XlnHanko.accountKey(entity[0], entity[1])), 1, "the withdrawal advanced the epoch");
    assertTrue(_submit(0, _implicitStart()), "the implicit start opens a dispute at epoch 1");
    assertTrue(_disputeHashOf(entity[0], entity[1]) != bytes32(0), "dispute opened");
  }

  // ─────────────── R-C2R-FOLD ───────────────

  /// @dev A signed proof at the Account's current epoch carrying `offdelta` (entity[1] signs it, entity[0] starts), nonce `nonce`.
  function _signedStart(uint256 nonce, int256 offdelta, uint256 epoch) internal view returns (Batch memory b) {
    bytes memory key = XlnHanko.accountKey(entity[0], entity[1]);
    ProofBody memory pb;
    pb.watchSeed = keccak256("r-c2r-fold");
    pb.leftResponseSeconds = LEFT_RESPONSE_SECONDS;
    pb.rightResponseSeconds = RIGHT_RESPONSE_SECONDS;
    pb.offdeltas = new Int512[](1);
    pb.offdeltas[0] = WideMath.fromInt(offdelta);
    pb.tokenIds = new uint256[](1);
    pb.tokenIds[0] = T;
    pb.transformers = new TransformerClause[](0);
    bytes32 hash = keccak256(abi.encode(pb));
    bool proposerIsLeft = entity[1] < entity[0];
    b = XlnHanko.emptyBatch();
    b.disputeStarts = new InitialDisputeProof[](1);
    b.disputeStarts[0] = InitialDisputeProof({
      counterentity: entity[1], nonce: nonce, ondeltaEpoch: epoch, proposerIsLeft: proposerIsLeft, proofbodyHash: hash,
      initialProofbody: pb, watchSeed: pb.watchSeed, sig: _hanko(1, XlnHanko.disputeProofHash(address(dep), key, nonce, proposerIsLeft, hash, pb.watchSeed)),
      starterInitialArguments: "", starterCounterArguments: "", starterCounterProofCommitment: bytes32(0)
    });
  }

  /// R-C2R-FOLD: a collateral-to-reserve shortcut advances the epoch without folding offdelta. entity[1] owes entity[0] 400 in a proof
  /// of epoch 0 (offdelta 400 for a Left payee, -400 otherwise); after entity[0] withdraws 100 by C2R that proof is void (skipped, epoch
  /// moved) and a dispute from the implicit proof settles at ondelta alone: the 400 is gone. The Runtime must therefore co-sign a C2R only
  /// while offdelta is zero, and send a settlement (which folds it) otherwise.
  function test_R_C2R_FOLD_aWithdrawalErasesTheOffdeltaOfTheOldEpoch() public {
    _fundCollateral(1_000);
    int256 owedToZero = entity[0] < entity[1] ? int256(400) : int256(-400); // entity[0] is the payee: Delta moves in its favour
    uint256 oldEpoch = XlnHanko.currentEpoch(address(dep), XlnHanko.accountKey(entity[0], entity[1]));
    _withdraw(100);
    // the old-epoch proof, with the nonce well above the stored one so that only the epoch is wrong
    _submitSkipped(0, _signedStart(_accountNonce(entity[0], entity[1]) + 2, owedToZero, oldEpoch), entity[1], T, OP_START, 11, _accountNonce(entity[0], entity[1]) + 2);

    uint256 implicitNonce = _accountNonce(entity[0], entity[1]) + 1;
    assertTrue(_submit(0, _implicitStart()), "the implicit proof of the new epoch opens");
    uint256 reserveBefore = dep._reserves(entity[0], T);
    bool startedByLeft = entity[0] < entity[1];
    Batch memory fin = XlnHanko.emptyBatch();
    fin.disputeFinalizations = new FinalDisputeProof[](1);
    ProofBody memory pb = _implicitStart().disputeStarts[0].initialProofbody;
    fin.disputeFinalizations[0] = FinalDisputeProof({
      counterentity: entity[1], initialNonce: implicitNonce, finalNonce: implicitNonce,
      proposerIsLeft: false, initialProofbodyHash: keccak256(abi.encode(pb)), finalProofbody: pb, starterArguments: "", otherArguments: "",
      sig: "", startedByLeft: startedByLeft, cooperative: false
    });
    vm.warp(block.timestamp + DISPUTE_WINDOW_SECONDS);
    assertTrue(_submit(0, fin), "starter finalizes the implicit proof after the window");

    assertEq(dep._reserves(entity[0], T) - reserveBefore, 900, "entity[0] takes the whole remaining collateral: the 400 owed to it is erased");
    assertEq(dep._reserves(entity[1], T), 0, "entity[1] keeps nothing of it, and was never charged the 400");
  }
}
