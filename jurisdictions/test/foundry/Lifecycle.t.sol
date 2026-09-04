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
    (n, , , , , , , , , , , , , , ) = dep._accounts(XlnHanko.accountKey(a, b));
  }

  function _collateralOf(bytes32 a, bytes32 b, uint256 t) internal view returns (uint256 c) {
    (c,) = dep._collaterals(XlnHanko.accountKey(a, b), t);
  }

  function _disputeHashOf(bytes32 a, bytes32 b) internal view returns (bytes32 h) {
    (, h, , , , , , , , , , , , , ) = dep._accounts(XlnHanko.accountKey(a, b));
  }

  function _proofBody(bytes32 seed, uint256 tokenId, int256 offdelta)
    internal pure returns (ProofBody memory pb)
  {
    pb.watchSeed = seed;
    pb.leftResponseSeconds = LEFT_RESPONSE_SECONDS;
    pb.rightResponseSeconds = RIGHT_RESPONSE_SECONDS;
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

  // ─────────────── implicit flash ───────────────
  //
  // Batch has no Flashloan[] any more. The batch initiator, on a token where it
  // owes nothing, may spend ahead of holding; the shortfall is a deficit that
  // later same-batch inflows repay first, and processBatch reverts E3 unless
  // every deficit is zero at the end. Batch order is fixed (deposits, R2R, C2R,
  // settlements, ..., R2C, external withdrawals), so a deficit opened by R2R can
  // be repaid by C2R/settlement, while one opened by an external withdrawal
  // never can.

  function _c2rLeg(uint256 from, uint256 cp, uint256 amount) internal view returns (CollateralToReserve memory) {
    bytes32 me = entity[from];
    bytes32 other = entity[cp];
    bool isLeft = me < other;
    int256 signed = int256(amount);
    SettlementDiff[] memory diffs = new SettlementDiff[](1);
    diffs[0] = SettlementDiff({
      tokenId: T,
      leftDiff: isLeft ? signed : int256(0),
      rightDiff: isLeft ? int256(0) : signed,
      collateralDiff: -signed,
      ondeltaDiff: isLeft ? -signed : int256(0)
    });
    uint256 nonce = _accountNonce(me, other) + 1;
    bytes32 h = XlnHanko.cooperativeUpdateHash(
      address(dep), XlnHanko.accountKey(me, other), nonce, diffs, new uint256[](0)
    );
    return CollateralToReserve({ counterparty: other, tokenId: T, amount: amount, nonce: nonce, sig: _hanko(cp, h) });
  }

  /// @dev Settlement between `payer` and `payee` where `payer` hands `amount`
  ///      of reserve to `payee`; signed by `signerIdx` (the non-initiator side).
  function _paySettlement(uint256 payer, uint256 payee, uint256 amount, uint256 signerIdx)
    internal view returns (Settlement memory)
  {
    bytes32 a = entity[payer];
    bytes32 b = entity[payee];
    (bytes32 left, bytes32 right) = a < b ? (a, b) : (b, a);
    int256 signed = int256(amount);
    SettlementDiff[] memory diffs = new SettlementDiff[](1);
    diffs[0] = SettlementDiff({
      tokenId: T,
      leftDiff: left == a ? -signed : signed,
      rightDiff: left == a ? signed : -signed,
      collateralDiff: 0,
      ondeltaDiff: 0
    });
    uint256 nonce = _accountNonce(a, b) + 1;
    bytes32 h = XlnHanko.cooperativeUpdateHash(
      address(dep), XlnHanko.accountKey(a, b), nonce, diffs, new uint256[](0)
    );
    return Settlement({
      leftEntity: left, rightEntity: right, diffs: diffs,
      forgiveDebtsInTokenIds: new uint256[](0), sig: _hanko(signerIdx, h), nonce: nonce
    });
  }

  function _expectE3(uint256 actor, Batch memory b) internal {
    bytes memory encoded = abi.encode(b);
    uint256 nonce = dep.entityNonces(entity[actor]) + 1;
    bytes32 h = XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), encoded, nonce);
    vm.expectRevert(bytes4(keccak256("E3()")));
    dep.processBatch(encoded, _hanko(actor, h), nonce);
  }

  /// @notice (a) R2R more than held, repaid by a same-batch collateral withdrawal.
  function test_implicitFlashR2RRepaidByC2R() public {
    _fundCollateral(1_000);
    dep.mintToReserve(entity[0], T, 100);
    assertEq(dep._reserves(entity[0], T), 100);

    Batch memory b = XlnHanko.emptyBatch();
    b.reserveToReserve = new ReserveToReserve[](1);
    b.reserveToReserve[0] = ReserveToReserve({ receivingEntity: entity[2], tokenId: T, amount: 700 });
    b.collateralToReserve = new CollateralToReserve[](1);
    b.collateralToReserve[0] = _c2rLeg(0, 1, 700);

    assertTrue(_submit(0, b));
    // 100 held + 700 pulled - 700 sent: exact, no inflated intermediate survives.
    assertEq(dep._reserves(entity[0], T), 100, "initiator reserve inexact");
    assertEq(dep._reserves(entity[2], T), 700, "counterparty did not receive");
    assertEq(_collateralOf(entity[0], entity[1], T), 300);
    assertEq(
      dep._reserves(entity[0], T) + dep._reserves(entity[2], T) + _collateralOf(entity[0], entity[1], T),
      1_100,
      "conservation"
    );
  }

  /// @notice (b) Same overdraw with no repayment reverts E3 and leaves no trace.
  function test_implicitFlashUnrepaidReverts() public {
    dep.mintToReserve(entity[0], T, 100);
    Batch memory b = XlnHanko.emptyBatch();
    b.reserveToReserve = new ReserveToReserve[](1);
    b.reserveToReserve[0] = ReserveToReserve({ receivingEntity: entity[2], tokenId: T, amount: 500 });
    _expectE3(0, b);
    assertEq(dep._reserves(entity[0], T), 100);
    assertEq(dep._reserves(entity[2], T), 0);
    assertEq(dep.entityNonces(entity[0]), 0);
  }

  /// @notice (b') A partial repayment is not enough: deficit 600, inflow 500 -> E3.
  function test_implicitFlashPartialRepaymentReverts() public {
    _fundCollateral(1_000);
    Batch memory b = XlnHanko.emptyBatch();
    b.reserveToReserve = new ReserveToReserve[](1);
    b.reserveToReserve[0] = ReserveToReserve({ receivingEntity: entity[2], tokenId: T, amount: 600 });
    b.collateralToReserve = new CollateralToReserve[](1);
    b.collateralToReserve[0] = _c2rLeg(0, 1, 500);
    _expectE3(0, b);
    assertEq(_collateralOf(entity[0], entity[1], T), 1_000);
  }

  /// @notice (c) An initiator with outstanding debt on the token cannot overdraw,
  ///         even when the same batch would have repaid the deficit.
  function test_implicitFlashDeniedToDebtor() public {
    bool zeroIsLeft = entity[0] < entity[1];
    uint256 debtor = zeroIsLeft ? 0 : 1;
    // Debtor parks collateral with entity[2] BEFORE the debt exists.
    dep.mintToReserve(entity[debtor], T, 1_000);
    Batch memory park = XlnHanko.emptyBatch();
    park.reserveToCollateral = new ReserveToCollateral[](1);
    EntityAmount[] memory pairs = new EntityAmount[](1);
    pairs[0] = EntityAmount({ entity: entity[2], amount: 1_000 });
    park.reserveToCollateral[0] = ReserveToCollateral({ tokenId: T, receivingEntity: entity[debtor], pairs: pairs });
    assertTrue(_submit(debtor, park));

    // Dispute 0<->1 with delta -500 and no collateral: LEFT owes RIGHT 500.
    (uint256 nonce, bytes32 pbHash, bytes32 seed) = _startDispute(0, 1, int256(-500));
    vm.warp(block.timestamp + DISPUTE_WINDOW_SECONDS);
    assertTrue(_submit(0, _timeoutFinalize(1, nonce, pbHash, seed, -500, zeroIsLeft)));
    assertEq(dep.debtOutstanding(entity[debtor], T), 500, "debt not created");
    assertEq(dep.activeDebts(entity[debtor]), 1);

    // Exactly the shape that succeeds for a debt-free initiator in (a).
    Batch memory b = XlnHanko.emptyBatch();
    b.reserveToReserve = new ReserveToReserve[](1);
    b.reserveToReserve[0] = ReserveToReserve({ receivingEntity: entity[3], tokenId: T, amount: 300 });
    b.collateralToReserve = new CollateralToReserve[](1);
    b.collateralToReserve[0] = _c2rLeg(debtor, 2, 300);
    _expectE3(debtor, b);
    assertEq(_collateralOf(entity[debtor], entity[2], T), 1_000);
    assertEq(dep._reserves(entity[3], T), 0);
  }

  /// @notice (d) A non-initiator reserve can never go negative: a settlement in
  ///         which the counterparty pays more than it holds reverts E3 even
  ///         though the counterparty signed it.
  function test_nonInitiatorNeverOverdraws() public {
    dep.mintToReserve(entity[1], T, 50);
    Batch memory b = XlnHanko.emptyBatch();
    b.settlements = new Settlement[](1);
    b.settlements[0] = _paySettlement(1, 0, 100, 1); // entity1 pays 100, holds 50
    _expectE3(0, b);
    assertEq(dep._reserves(entity[1], T), 50);
    assertEq(dep._reserves(entity[0], T), 0);
  }

  /// @notice (d') The initiator's own settlement leg MAY overdraw, provided a
  ///         later settlement in the same batch pays it back.
  function test_implicitFlashSettlementOverdrawRepaidBySettlement() public {
    dep.mintToReserve(entity[2], T, 1_000);
    Batch memory b = XlnHanko.emptyBatch();
    b.settlements = new Settlement[](2);
    b.settlements[0] = _paySettlement(0, 1, 400, 1); // initiator pays 400 from nothing
    b.settlements[1] = _paySettlement(2, 0, 400, 2); // entity2 pays initiator 400
    assertTrue(_submit(0, b));
    assertEq(dep._reserves(entity[0], T), 0);
    assertEq(dep._reserves(entity[1], T), 400);
    assertEq(dep._reserves(entity[2], T), 600);

    // Reversed order: the inflow lands before the overdraw, so it is plain
    // spending; the result is identical and no deficit is ever opened.
    Batch memory c = XlnHanko.emptyBatch();
    c.settlements = new Settlement[](2);
    c.settlements[0] = _paySettlement(2, 0, 100, 2);
    c.settlements[1] = _paySettlement(0, 1, 100, 1);
    assertTrue(_submit(0, c));
    assertEq(dep._reserves(entity[0], T), 0);
    assertEq(dep._reserves(entity[1], T), 500);
    assertEq(dep._reserves(entity[2], T), 500);
  }

  /// @notice (e) Deposit, overdraw, repay from collateral and withdraw the net
  ///         to the external token, all in one batch.
  function test_implicitFlashWithExternalDepositAndWithdraw() public {
    _fundCollateral(1_000); // token 1 == the listed ERC20
    address caller = signer[0];
    erc20.mint(caller, 400);
    vm.prank(caller);
    erc20.approve(address(dep), 400);
    uint256 backingBefore = erc20.balanceOf(address(dep));

    Batch memory b = XlnHanko.emptyBatch();
    b.externalTokenToReserve = new ExternalTokenToReserve[](1);
    b.externalTokenToReserve[0] = ExternalTokenToReserve({
      entity: entity[0], contractAddress: address(erc20), externalTokenId: 0, tokenType: 0, internalTokenId: T, amount: 400
    });
    b.reserveToReserve = new ReserveToReserve[](1);
    b.reserveToReserve[0] = ReserveToReserve({ receivingEntity: entity[2], tokenId: T, amount: 1_000 }); // holds 400
    b.collateralToReserve = new CollateralToReserve[](1);
    b.collateralToReserve[0] = _c2rLeg(0, 1, 900); // repays 600, leaves 300
    b.reserveToExternalToken = new ReserveToExternalToken[](1);
    b.reserveToExternalToken[0] = ReserveToExternalToken({
      receivingEntity: bytes32(uint256(uint160(caller))), tokenId: T, amount: 300
    });

    bytes memory encoded = abi.encode(b);
    uint256 nonce = dep.entityNonces(entity[0]) + 1;
    bytes32 h = XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), encoded, nonce);
    vm.prank(caller);
    dep.processBatch(encoded, _hanko(0, h), nonce);

    assertEq(dep._reserves(entity[0], T), 0, "initiator net must be zero");
    assertEq(dep._reserves(entity[2], T), 1_000);
    assertEq(_collateralOf(entity[0], entity[1], T), 100);
    assertEq(erc20.balanceOf(caller), 300);
    assertEq(erc20.balanceOf(address(dep)), backingBefore + 100, "external backing = deposit - withdrawal");
    assertEq(
      dep._reserves(entity[0], T) + dep._reserves(entity[2], T) + _collateralOf(entity[0], entity[1], T),
      1_100,
      "internal value = minted 1000 + net external 100"
    );
  }

  /// @notice (f) An external withdrawal runs last, so a deficit it opens can
  ///         never be repaid: overdrawing there always reverts E3.
  function test_implicitFlashExternalWithdrawalCannotBeRepaid() public {
    dep.mintToReserve(entity[0], T, 10);
    Batch memory b = XlnHanko.emptyBatch();
    b.reserveToExternalToken = new ReserveToExternalToken[](1);
    b.reserveToExternalToken[0] = ReserveToExternalToken({
      receivingEntity: bytes32(uint256(uint160(signer[0]))), tokenId: T, amount: 11
    });
    _expectE3(0, b);
    assertEq(dep._reserves(entity[0], T), 10);
  }

  // ─────────────── MAX_MONEY ───────────────

  /// @notice Reserves are capped at exactly 2^200; one more unit reverts E8.
  function test_reserveCapIsExactlyMaxMoney() public {
    dep.mintToReserve(entity[0], T, MAX_MONEY);
    assertEq(dep._reserves(entity[0], T), MAX_MONEY);
    vm.expectRevert(bytes4(keccak256("E8()")));
    dep.mintToReserve(entity[0], T, 1);
    vm.expectRevert(bytes4(keccak256("E8()")));
    dep.mintToReserve(entity[1], T, MAX_MONEY + 1);
    assertEq(dep._reserves(entity[1], T), 0);
  }

  /// @notice A proof body carrying |offdelta| > 2^200 is rejected E8 at dispute
  ///         start, before any account state is touched.
  function test_disputeStartRejectsOffdeltaAboveMaxMoney() public {
    _fundCollateral(1_000);
    bytes32 me = entity[0];
    bytes32 other = entity[1];
    bytes32 seed = keccak256("seed");
    ProofBody memory pb = _proofBody(seed, T, MAX_MONEY_INT + 1);
    bytes32 pbHash = keccak256(abi.encode(pb));
    uint256 nonce = _accountNonce(me, other) + 1;
    bool proposerIsLeft = other < me;
    bytes32 h = XlnHanko.disputeProofHash(
      address(dep), XlnHanko.accountKey(me, other), nonce, proposerIsLeft, pbHash, seed
    );
    Batch memory b = XlnHanko.emptyBatch();
    b.disputeStarts = new InitialDisputeProof[](1);
    b.disputeStarts[0] = InitialDisputeProof({
      counterentity: other, nonce: nonce, proposerIsLeft: proposerIsLeft, proofbodyHash: pbHash,
      initialProofbody: pb, watchSeed: seed, sig: _hanko(1, h),
      starterInitialArguments: "", starterCounterArguments: "", starterCounterProofCommitment: bytes32(0)
    });
    bytes memory encoded = abi.encode(b);
    uint256 bn = dep.entityNonces(me) + 1;
    bytes32 bh = XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), encoded, bn);
    vm.expectRevert(bytes4(keccak256("E8()")));
    dep.processBatch(encoded, _hanko(0, bh), bn);
    assertEq(_disputeHashOf(me, other), bytes32(0));

    // The exact bound is accepted.
    (, bytes32 okHash,) = _startDispute(0, 1, -MAX_MONEY_INT);
    assertTrue(okHash != bytes32(0));
    assertTrue(_disputeHashOf(me, other) != bytes32(0), "bounded offdelta must start a dispute");
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
    bool proposerIsLeft = other < me;
    bytes32 h = XlnHanko.disputeProofHash(
      address(dep), XlnHanko.accountKey(me, other), nonce, proposerIsLeft, pbHash, seed
    );

    Batch memory b = XlnHanko.emptyBatch();
    b.disputeStarts = new InitialDisputeProof[](1);
    b.disputeStarts[0] = InitialDisputeProof({
      counterentity: other,
      nonce: nonce,
      proposerIsLeft: proposerIsLeft,
      proofbodyHash: pbHash,
      initialProofbody: pb,
      watchSeed: seed,
      sig: _hanko(cp, h),
      starterInitialArguments: "",
      starterCounterArguments: "",
      starterCounterProofCommitment: bytes32(0)
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
      proposerIsLeft: !startedByLeft,
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

    // Too early: the starter must leave the full signed response sum for the
    // counterparty to reveal a newer state.
    bytes memory encoded = abi.encode(fin);
    uint256 bn = dep.entityNonces(entity[0]) + 1;
    bytes32 bh = XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), encoded, bn);
    vm.expectRevert();
    dep.processBatch(encoded, _hanko(0, bh), bn);

    vm.warp(block.timestamp + DISPUTE_WINDOW_SECONDS);
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

    vm.warp(block.timestamp + DISPUTE_WINDOW_SECONDS);
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
    bool proposerIsLeft = other < me;
    bytes32 h = XlnHanko.disputeProofHash(
      address(dep), XlnHanko.accountKey(me, other), nonce2, proposerIsLeft, pbHash2, seed2
    );

    Batch memory b = XlnHanko.emptyBatch();
    b.disputeStarts = new InitialDisputeProof[](1);
    b.disputeStarts[0] = InitialDisputeProof({
      counterentity: other, nonce: nonce2, proposerIsLeft: proposerIsLeft, proofbodyHash: pbHash2,
      initialProofbody: pb, watchSeed: seed2, sig: _hanko(1, h),
      starterInitialArguments: "", starterCounterArguments: "",
      starterCounterProofCommitment: bytes32(0)
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
    vm.warp(block.timestamp + DISPUTE_WINDOW_SECONDS);
    assertTrue(_submit(0, _timeoutFinalize(1, nonce, pbHash, seed, -500, startedByLeft)));

    (bytes32 left,) = entity[0] < entity[1] ? (entity[0], entity[1]) : (entity[1], entity[0]);
    assertEq(dep.debtOutstanding(left, T), 500, "debt not created");
    assertEq(dep.activeDebts(left), 1, "active debt count wrong");
  }
}
