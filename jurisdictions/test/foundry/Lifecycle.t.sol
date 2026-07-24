// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {XlnFixture} from "./helpers/XlnFixture.sol";
import {XlnHanko} from "./helpers/XlnHanko.sol";
import "../../contracts/Types.sol";

/// @notice Deterministic walkthroughs of the paths the invariant handler must
///         be able to reach. If one of these breaks, the corresponding
///         `invariant_*` result is vacuous and must not be trusted.
contract LifecycleTest is XlnFixture {
  uint256 internal constant T = 1;

  function setUp() public {
    _deployXln();
  }

  function _accountNonce(bytes32 a, bytes32 b) internal view returns (uint256 n) {
    (n,,,,,,,) = dep._accounts(XlnHanko.accountKey(a, b));
  }

  function _collateralOf(bytes32 a, bytes32 b, uint256 t) internal view returns (uint256 c) {
    (c,) = dep._collaterals(XlnHanko.accountKey(a, b), t);
  }

  function _disputeHashOf(bytes32 a, bytes32 b) internal view returns (bytes32 h) {
    (, h,,,,,,) = dep._accounts(XlnHanko.accountKey(a, b));
  }

  function _proofBody(bytes32 seed, uint256 tokenId, int256 offdelta)
    internal pure returns (ProofBody memory pb)
  {
    pb.watchSeed = seed;
    pb.offdeltas = new int256[](1);
    pb.offdeltas[0] = offdelta;
    pb.tokenIds = new uint256[](1);
    pb.tokenIds[0] = tokenId;
    pb.transformers = new TransformerClause[](0);
  }

  /// @dev A funds a collateral position with B.
  function _fundCollateral(uint256 amount) internal {
    dep.mintToReserve(entity[0], T, amount);
    Batch memory b = XlnHanko.emptyBatch();
    b.reserveToCollateral = new ReserveToCollateral[](1);
    EntityAmount[] memory pairs = new EntityAmount[](1);
    pairs[0] = EntityAmount({ entity: entity[1], amount: amount });
    b.reserveToCollateral[0] = ReserveToCollateral({
      tokenId: T, receivingEntity: entity[0], pairs: pairs
    });
    assertTrue(_submit(0, b));
  }

  // ─────────────── flashloans ───────────────

  /// @notice A flashloan is only repayable if the same batch brings value in.
  ///         Here the repayment source is a collateral withdrawal.
  function test_flashloanRepaidByCollateralWithdrawal() public {
    _fundCollateral(1_000);
    assertEq(dep._reserves(entity[0], T), 0);

    uint256 loan = 700;
    bytes32 me = entity[0];
    bytes32 other = entity[1];
    bool isLeft = me < other;

    SettlementDiff[] memory diffs = new SettlementDiff[](1);
    diffs[0] = SettlementDiff({
      tokenId: T,
      leftDiff: isLeft ? int256(700) : int256(0),
      rightDiff: isLeft ? int256(0) : int256(700),
      collateralDiff: -int256(700),
      ondeltaDiff: isLeft ? -int256(700) : int256(0)
    });
    uint256 nonce = _accountNonce(me, other) + 1;
    bytes32 h = XlnHanko.cooperativeUpdateHash(
      address(dep), XlnHanko.accountKey(me, other), nonce, diffs, new uint256[](0)
    );

    Batch memory b = XlnHanko.emptyBatch();
    b.flashloans = new Flashloan[](1);
    b.flashloans[0] = Flashloan({ tokenId: T, amount: loan });
    b.collateralToReserve = new CollateralToReserve[](1);
    b.collateralToReserve[0] = CollateralToReserve({
      counterparty: other, tokenId: T, amount: 700, nonce: nonce, sig: _hanko(1, h)
    });

    assertTrue(_submit(0, b));
    // Flash-minted 700 was burned; the 700 pulled out of collateral remains.
    assertEq(dep._reserves(entity[0], T), 700);
    assertEq(_collateralOf(me, other, T), 300);
  }

  /// @notice Duplicate tokenIds must aggregate, not double-credit the starting
  ///         snapshot (Depository.sol:485-504).
  function test_flashloanDuplicateTokenIdsAggregate() public {
    _fundCollateral(1_000);

    bytes32 me = entity[0];
    bytes32 other = entity[1];
    bool isLeft = me < other;
    SettlementDiff[] memory diffs = new SettlementDiff[](1);
    diffs[0] = SettlementDiff({
      tokenId: T,
      leftDiff: isLeft ? int256(1_000) : int256(0),
      rightDiff: isLeft ? int256(0) : int256(1_000),
      collateralDiff: -int256(1_000),
      ondeltaDiff: isLeft ? -int256(1_000) : int256(0)
    });
    uint256 nonce = _accountNonce(me, other) + 1;
    bytes32 h = XlnHanko.cooperativeUpdateHash(
      address(dep), XlnHanko.accountKey(me, other), nonce, diffs, new uint256[](0)
    );

    Batch memory b = XlnHanko.emptyBatch();
    b.flashloans = new Flashloan[](3);
    b.flashloans[0] = Flashloan({ tokenId: T, amount: 300 });
    b.flashloans[1] = Flashloan({ tokenId: T, amount: 400 });
    b.flashloans[2] = Flashloan({ tokenId: T, amount: 300 }); // 1000 total, same token
    b.collateralToReserve = new CollateralToReserve[](1);
    b.collateralToReserve[0] = CollateralToReserve({
      counterparty: other, tokenId: T, amount: 1_000, nonce: nonce, sig: _hanko(1, h)
    });

    assertTrue(_submit(0, b));
    assertEq(dep._reserves(entity[0], T), 1_000, "duplicate tokenIds mis-aggregated");
  }

  /// @notice An unrepaid flashloan must revert the whole batch.
  function test_flashloanUnrepaidReverts() public {
    dep.mintToReserve(entity[0], T, 100);
    Batch memory b = XlnHanko.emptyBatch();
    b.flashloans = new Flashloan[](1);
    b.flashloans[0] = Flashloan({ tokenId: T, amount: 500 });
    b.reserveToReserve = new ReserveToReserve[](1);
    b.reserveToReserve[0] = ReserveToReserve({
      receivingEntity: entity[2], tokenId: T, amount: 500
    });

    bytes memory encoded = abi.encode(b);
    uint256 nonce = dep.entityNonces(entity[0]) + 1;
    bytes32 h = XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), encoded, nonce);
    vm.expectRevert(); // E3 — flashloan not returned
    dep.processBatch(encoded, _hanko(0, h), nonce);
  }

  /// @notice Task item 2: overflow in the per-token flashloan aggregation.
  ///         `flashloanTotals[j] += amt` and `flashloanStarting + flashloanTotals`
  ///         are both checked arithmetic, and _increaseReserve additionally caps
  ///         reserves at int256.max — so a wrap-to-small `expectedFinal` is not
  ///         reachable.
  function test_flashloanAggregationCannotOverflow() public {
    Batch memory b = XlnHanko.emptyBatch();
    b.flashloans = new Flashloan[](2);
    b.flashloans[0] = Flashloan({ tokenId: T, amount: type(uint256).max / 2 + 1 });
    b.flashloans[1] = Flashloan({ tokenId: T, amount: type(uint256).max / 2 + 1 });

    bytes memory encoded = abi.encode(b);
    uint256 nonce = dep.entityNonces(entity[0]) + 1;
    bytes32 h = XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), encoded, nonce);
    vm.expectRevert(); // arithmetic overflow in the += aggregation
    dep.processBatch(encoded, _hanko(0, h), nonce);
  }

  function test_flashloanAboveInt256MaxReverts() public {
    Batch memory b = XlnHanko.emptyBatch();
    b.flashloans = new Flashloan[](1);
    b.flashloans[0] = Flashloan({ tokenId: T, amount: uint256(type(int256).max) + 1 });

    bytes memory encoded = abi.encode(b);
    uint256 nonce = dep.entityNonces(entity[0]) + 1;
    bytes32 h = XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), encoded, nonce);
    vm.expectRevert(bytes4(keccak256("E8()"))); // _increaseReserve ceiling
    dep.processBatch(encoded, _hanko(0, h), nonce);
  }

  // ─────────────── disputes ───────────────

  function _startDispute(uint256 starter, uint256 cp, int256 offdelta)
    internal returns (uint256 nonce, bytes32 pbHash, bytes32 seed)
  {
    bytes32 me = entity[starter];
    bytes32 other = entity[cp];
    seed = keccak256("seed");
    ProofBody memory pb = _proofBody(seed, T, offdelta);
    pbHash = keccak256(abi.encode(pb));
    nonce = _accountNonce(me, other) + 1;
    bytes32 h = XlnHanko.disputeProofHash(
      address(dep), XlnHanko.accountKey(me, other), nonce, pbHash, seed
    );

    Batch memory b = XlnHanko.emptyBatch();
    b.disputeStarts = new InitialDisputeProof[](1);
    b.disputeStarts[0] = InitialDisputeProof({
      counterentity: other,
      nonce: nonce,
      proofbodyHash: pbHash,
      initialProofbody: pb,
      watchSeed: seed,
      sig: _hanko(cp, h),
      starterInitialArguments: "",
      starterIncrementedArguments: ""
    });
    assertTrue(_submit(starter, b));
  }

  function _timeoutFinalize(uint256 other, uint256 nonce, bytes32 pbHash, bytes32 seed, int256 offdelta, bool startedByLeft)
    internal returns (Batch memory b)
  {
    b = XlnHanko.emptyBatch();
    b.disputeFinalizations = new FinalDisputeProof[](1);
    b.disputeFinalizations[0] = FinalDisputeProof({
      counterentity: entity[other],
      initialNonce: nonce,
      finalNonce: nonce,
      initialProofbodyHash: pbHash,
      finalProofbody: _proofBody(seed, T, offdelta),
      starterArguments: "",
      otherArguments: "",
      sig: "",
      startedByLeft: startedByLeft,
      cooperative: false
    });
  }

  function test_disputeStartThenTimeoutFinalizeByStarter() public {
    _fundCollateral(1_000);
    bool startedByLeft = entity[0] < entity[1];

    (uint256 nonce, bytes32 pbHash, bytes32 seed) = _startDispute(0, 1, int256(400));
    assertTrue(_disputeHashOf(entity[0], entity[1]) != bytes32(0), "dispute not recorded");

    Batch memory fin = _timeoutFinalize(1, nonce, pbHash, seed, 400, startedByLeft);

    // Too early: the starter must wait out defaultDisputeDelay.
    bytes memory encoded = abi.encode(fin);
    uint256 bn = dep.entityNonces(entity[0]) + 1;
    bytes32 bh = XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), encoded, bn);
    vm.expectRevert();
    dep.processBatch(encoded, _hanko(0, bh), bn);

    vm.roll(block.number + DISPUTE_DELAY);
    assertTrue(_submit(0, fin), "finalize after delay failed");

    assertEq(_disputeHashOf(entity[0], entity[1]), bytes32(0), "dispute not cleared");
    // Delta 400 of 1000 collateral: left gets 400, right gets 600.
    (bytes32 left, bytes32 right) = entity[0] < entity[1] ? (entity[0], entity[1]) : (entity[1], entity[0]);
    assertEq(dep._reserves(left, T), 400);
    assertEq(dep._reserves(right, T), 600);
  }

  function test_disputeFinalizeTwiceReverts() public {
    _fundCollateral(1_000);
    bool startedByLeft = entity[0] < entity[1];
    (uint256 nonce, bytes32 pbHash, bytes32 seed) = _startDispute(0, 1, int256(400));

    vm.roll(block.number + DISPUTE_DELAY);
    Batch memory fin = _timeoutFinalize(1, nonce, pbHash, seed, 400, startedByLeft);
    assertTrue(_submit(0, fin));

    bytes memory encoded = abi.encode(fin);
    uint256 bn = dep.entityNonces(entity[0]) + 1;
    bytes32 bh = XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), encoded, bn);
    vm.expectRevert(); // E5 — no active dispute
    dep.processBatch(encoded, _hanko(0, bh), bn);
  }

  function test_disputeStartOverLiveDisputeReverts() public {
    _fundCollateral(1_000);
    _startDispute(0, 1, int256(400));

    bytes32 me = entity[0];
    bytes32 other = entity[1];
    bytes32 seed2 = keccak256("seed2");
    ProofBody memory pb = _proofBody(seed2, T, 500);
    bytes32 pbHash2 = keccak256(abi.encode(pb));
    uint256 nonce2 = _accountNonce(me, other) + 1;
    bytes32 h = XlnHanko.disputeProofHash(
      address(dep), XlnHanko.accountKey(me, other), nonce2, pbHash2, seed2
    );

    Batch memory b = XlnHanko.emptyBatch();
    b.disputeStarts = new InitialDisputeProof[](1);
    b.disputeStarts[0] = InitialDisputeProof({
      counterentity: other, nonce: nonce2, proofbodyHash: pbHash2,
      initialProofbody: pb, watchSeed: seed2, sig: _hanko(1, h),
      starterInitialArguments: "", starterIncrementedArguments: ""
    });

    bytes memory encoded = abi.encode(b);
    uint256 bn = dep.entityNonces(me) + 1;
    bytes32 bh = XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), encoded, bn);
    vm.expectRevert(); // E6 — dispute in progress
    dep.processBatch(encoded, _hanko(0, bh), bn);
  }

  /// @notice The counterparty may finalize immediately — it is accepting the
  ///         starter's own proof, so the delay does not protect anyone.
  function test_disputeCounterpartyFinalizesImmediately() public {
    _fundCollateral(1_000);
    bool startedByLeft = entity[0] < entity[1];
    (uint256 nonce, bytes32 pbHash, bytes32 seed) = _startDispute(0, 1, int256(400));

    Batch memory fin = _timeoutFinalize(0, nonce, pbHash, seed, 400, startedByLeft);
    assertTrue(_submit(1, fin), "counterparty finalize failed");
    assertEq(_disputeHashOf(entity[0], entity[1]), bytes32(0));
  }

  // ─────────────── debt ───────────────

  /// @notice A negative delta with no collateral and no reserve mints debt.
  function test_disputeCreatesDebtWhenReserveIsShort() public {
    // No collateral, no reserves: delta -500 means LEFT owes RIGHT 500.
    (uint256 nonce, bytes32 pbHash, bytes32 seed) = _startDispute(0, 1, int256(-500));
    bool startedByLeft = entity[0] < entity[1];
    vm.roll(block.number + DISPUTE_DELAY);
    assertTrue(_submit(0, _timeoutFinalize(1, nonce, pbHash, seed, -500, startedByLeft)));

    (bytes32 left,) = entity[0] < entity[1] ? (entity[0], entity[1]) : (entity[1], entity[0]);
    assertEq(dep.debtOutstanding(left, T), 500, "debt not created");
    assertEq(dep._activeDebtsByToken(left, T), 1, "active debt count wrong");
  }
}
