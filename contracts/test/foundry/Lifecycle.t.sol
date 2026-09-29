// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {XlnFixture} from "./helpers/XlnFixture.sol";
import {XlnHanko} from "./helpers/XlnHanko.sol";
import {Vm} from "forge-std/Vm.sol";
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
    pb.offdeltas = new Int512[](1);
    pb.offdeltas[0] = WideMath.fromInt(offdelta);
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

  function _assertR2cReserveLog(Vm.Log memory entry, bytes32 sender, uint256 balance) internal view {
    assertEq(entry.emitter, address(dep), "reserve event emitter");
    assertEq(entry.topics.length, 3, "reserve indexed fields");
    assertEq(entry.topics[0], keccak256("ReserveUpdated(bytes32,uint256,uint256)"), "reserve event order");
    assertEq(entry.topics[1], sender, "reserve event sender");
    assertEq(entry.topics[2], bytes32(T), "reserve event token");
    assertEq(entry.data, abi.encode(balance), "intermediate sender reserve");
  }

  function _assertR2cSettlementLog(
    Vm.Log memory entry, bytes32 sender, bytes32 peer, uint256 balance, uint256 amount
  ) internal view {
    bool isLeft = sender < peer;
    AccountSettlement[] memory expected = new AccountSettlement[](1);
    TokenSettlement[] memory tokens = new TokenSettlement[](1);
    tokens[0] = TokenSettlement({
      tokenId: T, leftReserve: isLeft ? balance : 0, rightReserve: isLeft ? 0 : balance,
      collateral: amount, ondelta: Int512(0, isLeft ? amount : 0)
    });
    expected[0] = AccountSettlement(isLeft ? sender : peer, isLeft ? peer : sender, tokens, 0);
    assertEq(entry.emitter, address(dep), "account event emitter");
    assertEq(entry.topics.length, 1, "account event indexed fields");
    assertEq(entry.topics[0], keccak256(
      "AccountSettled((bytes32,bytes32,(uint256,uint256,uint256,uint256,(int256,uint256))[],uint256)[])"
    ), "account event order");
    assertEq(entry.data, abi.encode(expected), "exact per-pair event state and nonce");
    (uint256 collateral, Int512 memory ondelta) = dep._collaterals(XlnHanko.accountKey(sender, peer), T);
    assertEq(collateral, amount, "per-pair stored collateral");
    assertEq(ondelta.high, 0, "per-pair stored offset high");
    assertEq(ondelta.low, isLeft ? amount : 0, "per-pair stored offset low");
    assertEq(_accountNonce(sender, peer), 0, "R2C account nonce unchanged");
  }

  function test_twoR2cPairsPreserveFinancialEventOrderAndIntermediateState() public {
    uint256[3] memory actors = [uint256(0), uint256(1), uint256(2)];
    for (uint256 i = 0; i < 3; i++) {
      for (uint256 j = i + 1; j < 3; j++) {
        if (entity[actors[i]] > entity[actors[j]]) (actors[i], actors[j]) = (actors[j], actors[i]);
      }
    }
    bytes32 sender = entity[actors[1]];
    dep.mintToReserve(sender, T, 31);
    EntityAmount[] memory pairs = new EntityAmount[](2);
    pairs[0] = EntityAmount(entity[actors[2]], 7);
    pairs[1] = EntityAmount(entity[actors[0]], 11); // Intentionally reverse peer order.
    Batch memory batch = XlnHanko.emptyBatch();
    batch.reserveToCollateral = new ReserveToCollateral[](1);
    batch.reserveToCollateral[0] = ReserveToCollateral(T, sender, pairs);
    vm.recordLogs();
    assertTrue(_submit(actors[1], batch));
    Vm.Log[] memory logs = vm.getRecordedLogs();
    assertEq(logs.length, 5, "four financial events then the batch receipt");
    _assertR2cReserveLog(logs[0], sender, 24);
    _assertR2cSettlementLog(logs[1], sender, pairs[0].entity, 24, 7);
    _assertR2cReserveLog(logs[2], sender, 13);
    _assertR2cSettlementLog(logs[3], sender, pairs[1].entity, 13, 11);
    assertEq(logs[4].topics[0], keccak256("HankoBatchProcessed(bytes32,bytes32,uint256)"), "receipt order");
    assertEq(dep._reserves(sender, T), 13, "final sender reserve");
    assertEq(dep.entityNonces(sender), 1, "one authenticated outer batch");
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

    SettlementDiff[] memory diffs = new SettlementDiff[](1);
    diffs[0] = SettlementDiff({
      tokenId: T,
      leftDiff: SignedAmount(false, isLeft ? amount : 0),
      rightDiff: SignedAmount(false, isLeft ? 0 : amount),
      collateralDiff: SignedAmount(amount != 0, amount),
      ondeltaDiff: SignedAmount(isLeft && amount != 0, isLeft ? amount : 0)
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

    SettlementDiff[] memory diffs = new SettlementDiff[](1);
    diffs[0] = SettlementDiff({
      tokenId: T,
      leftDiff: SignedAmount(left == a && amount != 0, amount),
      rightDiff: SignedAmount(left != a && amount != 0, amount),
      collateralDiff: SignedAmount(false, 0),
      ondeltaDiff: SignedAmount(false, 0)
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
    _assertDebt(entity[debtor], 500);
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

  // ─────────────── full-width money ───────────────

  function _assertDebt(bytes32 debtor, uint256 amount) internal view {
    (uint256 high, uint256 middle, uint256 low) = dep.debtOutstanding(debtor, T);
    assertEq(high, 0, "debt high limb");
    assertEq(middle, 0, "debt middle limb");
    assertEq(low, amount, "debt low limb");
  }

  /// @notice The actual reserve representation accepts uint256.max; adding one
  /// unit is a checked representation overflow and leaves the reserve intact.
  function test_reserveFullUint256ThenRepresentationOverflowIsAtomic() public {
    dep.mintToReserve(entity[0], T, type(uint256).max);
    assertEq(dep._reserves(entity[0], T), type(uint256).max);
    vm.expectRevert(abi.encodeWithSignature("Panic(uint256)", uint256(0x11)));
    dep.mintToReserve(entity[0], T, 1);
    assertEq(dep._reserves(entity[0], T), type(uint256).max, "overflow mutated reserve");
    assertEq(dep._reserves(entity[1], T), 0, "overflow mutated another reserve");
    assertEq(dep.entityNonces(entity[0]), 0, "overflow mutated nonce");
  }

  function _depositFullUint256(uint256 actor) internal {
    uint256 initialSupply = erc20.totalSupply();
    assertEq(erc20.balanceOf(address(this)), initialSupply);
    erc20.transfer(signer[actor], initialSupply);
    erc20.mint(signer[actor], type(uint256).max - initialSupply);
    vm.prank(signer[actor]);
    erc20.approve(address(dep), type(uint256).max);
    Batch memory b = XlnHanko.emptyBatch();
    b.externalTokenToReserve = new ExternalTokenToReserve[](1);
    b.externalTokenToReserve[0] = ExternalTokenToReserve({
      entity: entity[actor], contractAddress: address(erc20), externalTokenId: 0,
      tokenType: 0, internalTokenId: T, amount: type(uint256).max
    });
    bytes memory encoded = abi.encode(b);
    uint256 nonce = dep.entityNonces(entity[actor]) + 1;
    bytes memory hanko = _hanko(actor, XlnHanko.batchHash(dep.DOMAIN_SEPARATOR(), address(dep), encoded, nonce));
    vm.prank(signer[actor]);
    dep.processBatch(encoded, hanko, nonce);
    assertEq(erc20.balanceOf(address(dep)), type(uint256).max, "full ERC20 backing");
    assertEq(dep._reserves(entity[actor], T), type(uint256).max, "full deposited reserve");
    assertEq(erc20.balanceOf(signer[actor]), 0);
  }

  function _fullUint256ReserveR2CC2R(bool fundLeft) internal {
    uint256 from = (entity[0] < entity[1]) == fundLeft ? 0 : 1;
    uint256 cp = 1 - from;
    _depositFullUint256(from);
    _parkFullUint256(from, cp);
    _withdrawFullUint256(from, cp);
    _sendAndWithdrawFullUint256(from, cp);
  }

  function _parkFullUint256(uint256 from, uint256 cp) internal {
    Batch memory park = XlnHanko.emptyBatch();
    park.reserveToCollateral = new ReserveToCollateral[](1);
    EntityAmount[] memory pairs = new EntityAmount[](1);
    pairs[0] = EntityAmount({ entity: entity[cp], amount: type(uint256).max });
    park.reserveToCollateral[0] = ReserveToCollateral({ tokenId: T, receivingEntity: entity[from], pairs: pairs });
    assertTrue(_submit(from, park));
    assertEq(dep._reserves(entity[from], T), 0);
    (uint256 collateral, Int512 memory ondelta) = dep._collaterals(XlnHanko.accountKey(entity[from], entity[cp]), T);
    assertEq(collateral, type(uint256).max, "R2C full collateral");
    assertEq(ondelta.high, 0, "R2C offset high limb");
    assertEq(ondelta.low, entity[from] < entity[cp] ? type(uint256).max : 0, "R2C offset low limb");
    assertEq(_accountNonce(entity[from], entity[cp]), 0, "unilateral R2C changed account nonce");
  }

  function _withdrawFullUint256(uint256 from, uint256 cp) internal {
    // Counterparty's Hanko commits the exact full magnitude, direction and next
    // nonce. A cast through int256 would turn this legitimate C2R into -1.
    Batch memory withdraw = XlnHanko.emptyBatch();
    withdraw.collateralToReserve = new CollateralToReserve[](1);
    withdraw.collateralToReserve[0] = _c2rLeg(from, cp, type(uint256).max);
    assertTrue(_submit(from, withdraw));
    assertEq(dep._reserves(entity[from], T), type(uint256).max, "C2R exact reserve");
    (uint256 collateral, Int512 memory ondelta) = dep._collaterals(XlnHanko.accountKey(entity[from], entity[cp]), T);
    assertEq(collateral, 0, "C2R collateral cleared");
    assertEq(ondelta.high, 0, "C2R offset high limb");
    assertEq(ondelta.low, 0, "C2R offset low limb");
    assertEq(_accountNonce(entity[from], entity[cp]), 1, "C2R signed nonce");
    assertEq(dep.entityNonces(entity[from]), 3, "deposit/R2C/C2R outer nonces");
  }

  function _sendAndWithdrawFullUint256(uint256 from, uint256 cp) internal {
    Batch memory transfer = XlnHanko.emptyBatch();
    transfer.reserveToReserve = new ReserveToReserve[](1);
    transfer.reserveToReserve[0] = ReserveToReserve({
      receivingEntity: entity[cp], tokenId: T, amount: type(uint256).max
    });
    assertTrue(_submit(from, transfer));
    assertEq(dep._reserves(entity[from], T), 0);
    assertEq(dep._reserves(entity[cp], T), type(uint256).max);
    assertEq(erc20.balanceOf(address(dep)), type(uint256).max);
    Batch memory externalWithdraw = XlnHanko.emptyBatch();
    externalWithdraw.reserveToExternalToken = new ReserveToExternalToken[](1);
    externalWithdraw.reserveToExternalToken[0] = ReserveToExternalToken({
      receivingEntity: bytes32(uint256(uint160(signer[cp]))), tokenId: T, amount: type(uint256).max
    });
    assertTrue(_submit(cp, externalWithdraw));
    assertEq(erc20.balanceOf(address(dep)), 0, "external backing completely withdrawn");
    assertEq(erc20.balanceOf(signer[cp]), type(uint256).max, "full external withdrawal");
    for (uint256 i = 0; i < ACTORS; i++) assertEq(dep._reserves(entity[i], T), 0, "no residual reserve");
    assertEq(dep.entityNonces(entity[from]), 4, "sender outer nonce");
    assertEq(dep.entityNonces(entity[cp]), 1, "receiver outer nonce");
  }

  function test_fullUint256ReserveR2CC2RLeft() public {
    _fullUint256ReserveR2CC2R(true);
  }

  function test_fullUint256ReserveR2CC2RRight() public {
    _fullUint256ReserveR2CC2R(false);
  }

  function _leftActor() internal view returns (uint256) {
    return entity[0] < entity[1] ? 0 : 1;
  }

  function _assertWideAccount(uint256 nonce, uint256 collateral, int256 high, uint256 low) internal view {
    (uint256 storedCollateral, Int512 memory offset) = dep._collaterals(XlnHanko.accountKey(entity[0], entity[1]), T);
    assertEq(_accountNonce(entity[0], entity[1]), nonce, "exact account nonce");
    assertEq(storedCollateral, collateral, "exact account collateral");
    assertEq(offset.high, high, "exact account offset high");
    assertEq(offset.low, low, "exact account offset low");
  }

  function _signedWideSettlement(SignedAmount memory allocation, uint256 withdraw) internal {
    uint256 left = _leftActor();
    uint256 right = 1 - left;
    SettlementDiff[] memory diffs = new SettlementDiff[](1);
    diffs[0] = SettlementDiff({
      tokenId: T, leftDiff: SignedAmount(false, withdraw), rightDiff: SignedAmount(false, 0),
      collateralDiff: SignedAmount(withdraw != 0, withdraw), ondeltaDiff: allocation
    });
    uint256 nonce = _accountNonce(entity[left], entity[right]) + 1;
    bytes32 hash = XlnHanko.cooperativeUpdateHash(
      address(dep), XlnHanko.accountKey(entity[left], entity[right]), nonce, diffs, new uint256[](0)
    );
    Batch memory batch = XlnHanko.emptyBatch();
    batch.settlements = new Settlement[](1);
    batch.settlements[0] = Settlement(entity[left], entity[right], diffs, new uint256[](0), _hanko(right, hash), nonce);
    assertTrue(_submit(left, batch), "counterparty-authorized wide settlement");
  }

  function _threeSignedAllocationMovements(bool negative) internal {
    for (uint256 k = 1; k <= 3; k++) {
      _signedWideSettlement(SignedAmount(negative, type(uint256).max), 0);
      _assertWideAccount(k, 0, negative ? -int256(k) : int256(k - 1), negative ? k : type(uint256).max - k + 1);
      assertEq(dep._reserves(entity[0], T), 0, "allocation must not mint reserve");
      assertEq(dep._reserves(entity[1], T), 0, "allocation must not mint reserve");
      assertEq(dep.entityNonces(entity[_leftActor()]), k, "one outer signature per allocation update");
      _assertDebt(entity[0], 0);
      _assertDebt(entity[1], 0);
    }
  }

  function test_threePositiveFullUint256AllocationUpdatesRemainExact() public {
    _threeSignedAllocationMovements(false);
  }

  function test_threeNegativeFullUint256AllocationUpdatesRemainExact() public {
    _threeSignedAllocationMovements(true);
  }

  function _leftR2cFullUint256() internal {
    uint256 left = _leftActor();
    EntityAmount[] memory pairs = new EntityAmount[](1);
    pairs[0] = EntityAmount(entity[1 - left], type(uint256).max);
    Batch memory batch = XlnHanko.emptyBatch();
    batch.reserveToCollateral = new ReserveToCollateral[](1);
    batch.reserveToCollateral[0] = ReserveToCollateral(T, entity[left], pairs);
    assertTrue(_submit(left, batch), "left full-width R2C");
  }

  function _cooperativeDecreasePreservesWideAllocation(bool negative) internal {
    _threeSignedAllocationMovements(negative);
    uint256 left = _leftActor();
    _depositFullUint256(left);
    _leftR2cFullUint256();
    _assertWideAccount(3, type(uint256).max, negative ? int256(-2) : int256(3), negative ? 2 : type(uint256).max - 3);
    assertEq(dep._reserves(entity[left], T), 0);
    _signedWideSettlement(SignedAmount(true, type(uint256).max), type(uint256).max);
    _assertWideAccount(4, 0, negative ? int256(-3) : int256(2), negative ? 3 : type(uint256).max - 2);
    assertEq(dep._reserves(entity[left], T), type(uint256).max, "cooperative collateral withdrawal");
    assertEq(dep._reserves(entity[1 - left], T), 0);
    assertEq(erc20.balanceOf(address(dep)), type(uint256).max, "custody backing unchanged");
    assertEq(dep.entityNonces(entity[left]), 6, "three allocations, deposit, R2C, cooperative decrease");
  }

  function test_cooperativeCollateralDecreasePreservesPositiveWideAllocation() public {
    _cooperativeDecreasePreservesWideAllocation(false);
  }

  function test_cooperativeCollateralDecreasePreservesNegativeWideAllocation() public {
    _cooperativeDecreasePreservesWideAllocation(true);
  }

  function _rightC2rThenReturnReserve(uint256 k) internal {
    uint256 left = _leftActor();
    uint256 right = 1 - left;
    Batch memory withdraw = XlnHanko.emptyBatch();
    withdraw.collateralToReserve = new CollateralToReserve[](1);
    withdraw.collateralToReserve[0] = _c2rLeg(right, left, type(uint256).max);
    assertTrue(_submit(right, withdraw), "left authorizes right C2R");
    _assertWideAccount(k, 0, int256(k - 1), type(uint256).max - k + 1);
    assertEq(dep._reserves(entity[left], T), 0);
    assertEq(dep._reserves(entity[right], T), type(uint256).max);
    Batch memory transfer = XlnHanko.emptyBatch();
    transfer.reserveToReserve = new ReserveToReserve[](1);
    transfer.reserveToReserve[0] = ReserveToReserve(entity[left], T, type(uint256).max);
    assertTrue(_submit(right, transfer), "right returns the same backing");
    _assertWideAccount(k, 0, int256(k - 1), type(uint256).max - k + 1);
    assertEq(dep._reserves(entity[left], T), type(uint256).max);
    assertEq(dep._reserves(entity[right], T), 0);
    assertEq(dep.entityNonces(entity[right]), 2 * k, "C2R and R2R use fresh outer nonces");
  }

  function _threeLeftR2cRightC2rCycles() internal {
    uint256 left = _leftActor();
    _depositFullUint256(left);
    for (uint256 k = 1; k <= 3; k++) {
      _leftR2cFullUint256();
      _assertWideAccount(k - 1, type(uint256).max, int256(k - 1), type(uint256).max - k + 1);
      assertEq(dep._reserves(entity[left], T), 0);
      assertEq(dep._reserves(entity[1 - left], T), 0);
      assertEq(dep.entityNonces(entity[left]), k + 1, "deposit then one R2C per cycle");
      _rightC2rThenReturnReserve(k);
      assertEq(erc20.balanceOf(address(dep)), type(uint256).max, "same ERC20 backing through every cycle");
    }
  }

  function test_repeatedLeftR2cRightC2rRetainsWideOffsetAndMonotoneNonce() public {
    _threeLeftR2cRightC2rCycles();
  }

  function _startExactWideDispute(ProofBody memory proof) internal returns (uint256 nonce, bytes32 hash) {
    uint256 left = _leftActor();
    uint256 right = 1 - left;
    nonce = _accountNonce(entity[left], entity[right]) + 1;
    hash = keccak256(abi.encode(proof));
    bytes32 signedHash = XlnHanko.disputeProofHash(
      address(dep), XlnHanko.accountKey(entity[left], entity[right]), nonce, false, hash, proof.watchSeed
    );
    Batch memory start = XlnHanko.emptyBatch();
    start.disputeStarts = new InitialDisputeProof[](1);
    start.disputeStarts[0] = InitialDisputeProof({
      counterentity: entity[right], nonce: nonce, proposerIsLeft: false, proofbodyHash: hash,
      initialProofbody: proof, watchSeed: proof.watchSeed, sig: _hanko(right, signedHash),
      starterInitialArguments: "", starterCounterArguments: "", starterCounterProofCommitment: bytes32(0)
    });
    assertTrue(_submit(left, start), "right signs the exact wide-offset proof");
  }

  function _assertWideResetCustody(uint8 branch) internal view {
    uint256 left = _leftActor();
    uint256 right = 1 - left;
    uint256 leftReserve = branch == 0 ? 0 : branch == 1 ? 1 : type(uint256).max;
    uint256 rightReserve = branch == 0 ? type(uint256).max : branch == 1 ? type(uint256).max - 1 : 0;
    assertEq(dep._reserves(entity[left], T), leftReserve, "exact finalized left reserve");
    assertEq(dep._reserves(entity[right], T), rightReserve, "exact finalized right reserve");
    _assertDebt(entity[left], branch == 0 ? 1 : 0);
    _assertDebt(entity[right], branch == 2 ? 1 : 0);
    assertEq(dep.activeDebts(entity[left]), branch == 0 ? 1 : 0);
    assertEq(dep.activeDebts(entity[right]), branch == 2 ? 1 : 0);
    assertEq(erc20.balanceOf(address(dep)), type(uint256).max, "dispute preserves ERC20 backing");
  }

  function _wideAllocationReset(uint8 branch) internal {
    _threeLeftR2cRightC2rCycles();
    _leftR2cFullUint256();
    _assertWideAccount(3, type(uint256).max, 3, type(uint256).max - 3); // ondelta = 4*U.
    ProofBody memory proof = _proofBody(keccak256(abi.encode("wide-reset", branch)), T, 0);
    // Exact final allocations: -1, 1, U+1. These independent literals cancel
    // reachable ondelta=4*U; no storage injection or production math oracle.
    proof.offdeltas[0] = branch == 0 ? Int512(-4, 3) : branch == 1 ? Int512(-4, 5) : Int512(-3, 4);
    (uint256 nonce, bytes32 hash) = _startExactWideDispute(proof);
    _assertWideAccount(4, type(uint256).max, 3, type(uint256).max - 3);
    uint256 left = _leftActor();
    (, , uint256 timeout, , , , , , , , , , , , ) = dep._accounts(XlnHanko.accountKey(entity[0], entity[1]));
    vm.warp(timeout + 1);
    Batch memory finalization = _timeoutFinalize(1 - left, nonce, hash, proof.watchSeed, 0, true);
    finalization.disputeFinalizations[0].finalProofbody = proof;
    assertTrue(_submit(left, finalization), "starter finalizes exact proof after timeout");
    _assertWideAccount(5, 0, 0, 0);
    assertEq(_disputeHashOf(entity[0], entity[1]), bytes32(0), "closed dispute state");
    assertEq(dep.entityNonces(entity[left]), 7, "deposit, four R2C, dispute start and finalize");
    assertEq(dep.entityNonces(entity[1 - left]), 6, "counterparty outer nonce preserved");
    _assertWideResetCustody(branch);
  }

  function test_wideOffsetResetAfterNegativeAllocationFinalization() public {
    _wideAllocationReset(0);
  }

  function test_wideOffsetResetAfterSplitCollateralFinalization() public {
    _wideAllocationReset(1);
  }

  function test_wideOffsetResetAfterBeyondCollateralFinalization() public {
    _wideAllocationReset(2);
  }

  /// @notice A counterparty signs a full uint256 positive offdelta. It must
  /// survive the exact ProofBody hash, dispute start and debt-producing close.
  function test_disputeAcceptsFullUint256Offdelta() public {
    bytes32 me = entity[0];
    bytes32 other = entity[1];
    bytes32 seed = keccak256("full-uint256-proof");
    ProofBody memory pb = _proofBody(seed, T, 0);
    pb.offdeltas[0] = WideMath.fromUint(type(uint256).max);
    bytes32 pbHash = keccak256(abi.encode(pb));
    uint256 nonce = _accountNonce(me, other) + 1;
    bool proposerIsLeft = other < me;
    bytes32 h = XlnHanko.disputeProofHash(
      address(dep), XlnHanko.accountKey(me, other), nonce, proposerIsLeft, pbHash, seed
    );
    Batch memory start = XlnHanko.emptyBatch();
    start.disputeStarts = new InitialDisputeProof[](1);
    start.disputeStarts[0] = InitialDisputeProof({
      counterentity: other, nonce: nonce, proposerIsLeft: proposerIsLeft, proofbodyHash: pbHash,
      initialProofbody: pb, watchSeed: seed, sig: _hanko(1, h),
      starterInitialArguments: "", starterCounterArguments: "", starterCounterProofCommitment: bytes32(0)
    });
    assertTrue(_submit(0, start));
    assertTrue(_disputeHashOf(me, other) != bytes32(0), "full-width proof must start dispute");
    Batch memory fin = _timeoutFinalize(0, nonce, pbHash, seed, 0, me < other);
    fin.disputeFinalizations[0].finalProofbody = pb;
    assertTrue(_submit(1, fin), "counterparty accepts exact full-width signed proof");
    bytes32 right = me < other ? other : me;
    _assertDebt(right, type(uint256).max);
    assertEq(dep.activeDebts(right), 1);
    assertEq(_disputeHashOf(me, other), bytes32(0), "dispute cleared");
    assertEq(_collateralOf(me, other, T), 0);
    assertEq(dep._reserves(me, T), 0, "debt must not mint reserve");
    assertEq(dep._reserves(other, T), 0, "debt must not mint reserve");
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
    _assertDebt(left, 500);
    assertEq(dep.activeDebts(left), 1, "active debt count wrong");
  }
}
