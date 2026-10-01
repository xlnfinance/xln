// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {XlnFixture} from "../helpers/XlnFixture.sol";
import {XlnHanko} from "../helpers/XlnHanko.sol";
import "../../../contracts/Types.sol";

/// @notice The chain's payout of a signed proof body conserves value and books exactly the credit the body signed. One Account, one
///         token: the collateral is funded by LEFT (so ondelta is the deposit), both sides sign an offdelta, and the dispute runs to
///         its finalization. Delta = ondelta + offdelta is LEFT's allocation, and the three branches of the payout are the three tests:
///           split      0 < Delta < collateral: the collateral is divided, no debt;
///           left owes  Delta <= 0:             RIGHT takes all the collateral, LEFT owes -Delta;
///           right owes Delta >= collateral:    LEFT takes all the collateral, RIGHT owes Delta - collateral, paid first from RIGHT's
///                                              spendable reserve and booked as debt only for what the reserve cannot cover.
///         Each test states two things. Conservation: reserves of both sides plus the collateral are the same after the payout as
///         before it (a debt is a claim, never value). Credit: what the creditor received plus the debt booked is exactly the
///         shortfall the signed Delta implies, so the credit granted by the signatures is the credit the chain books, no more, no less.
contract DisputePayoutConservesTest is XlnFixture {
  uint256 internal constant T = 1;
  uint256 internal constant DEPOSIT = 1000;

  bytes32 internal left;
  bytes32 internal right;

  function setUp() public {
    _deployXln();
    (left, right) = entity[0] < entity[1] ? (entity[0], entity[1]) : (entity[1], entity[0]);
    _fundCollateral(DEPOSIT);
  }

  function _acct() internal view returns (bytes memory) {
    return XlnHanko.accountKey(entity[0], entity[1]);
  }

  function _indexOf(bytes32 who) internal view returns (uint256) {
    return who == entity[0] ? 0 : 1;
  }

  /// @dev LEFT moves `amount` from its reserve into the Account's collateral: collateral and ondelta both become `amount`.
  function _fundCollateral(uint256 amount) internal {
    dep.mintToReserve(left, T, amount);
    Batch memory b = XlnHanko.emptyBatch();
    b.reserveToCollateral = new ReserveToCollateral[](1);
    EntityAmount[] memory pairs = new EntityAmount[](1);
    pairs[0] = EntityAmount({entity: right, amount: amount});
    b.reserveToCollateral[0] = ReserveToCollateral({tokenId: T, receivingEntity: left, pairs: pairs});
    _submit(_indexOf(left), b);
  }

  function _proofBody(Int512 memory offdelta) internal pure returns (ProofBody memory pb) {
    pb.watchSeed = keccak256("conserve");
    pb.leftResponseSeconds = LEFT_RESPONSE_SECONDS;
    pb.rightResponseSeconds = RIGHT_RESPONSE_SECONDS;
    pb.offdeltas = new Int512[](1);
    pb.offdeltas[0] = offdelta;
    pb.tokenIds = new uint256[](1);
    pb.tokenIds[0] = T;
    pb.transformers = new TransformerClause[](0);
  }

  function _accountNonce() internal view returns (uint256 n) {
    (n, , , , , , , , , , , , , , , , ) = dep._accounts(_acct());
  }

  /// @dev Both Entity Hankos sign this proof at the next nonce; entity 0 starts the dispute, the window runs out, and it finalizes
  ///      on the signed proof: the payout under test.
  function _payOut(int256 offdelta) internal {
    ProofBody memory pb = _proofBody(WideMath.fromInt(offdelta));
    bytes32 pbHash = keccak256(abi.encode(pb));
    uint256 nonce = _accountNonce() + 1;
    bool startedByLeft = entity[0] < entity[1];
    bool proposerIsLeft = entity[1] < entity[0];

    Batch memory start = XlnHanko.emptyBatch();
    start.disputeStarts = new InitialDisputeProof[](1);
    start.disputeStarts[0] = InitialDisputeProof({
      counterentity: entity[1],
      nonce: nonce,
      ondeltaEpoch: XlnHanko.currentEpoch(address(dep), _acct()),
      proposerIsLeft: proposerIsLeft,
      proofbodyHash: pbHash,
      initialProofbody: pb,
      watchSeed: pb.watchSeed,
      sig: _hanko(1, XlnHanko.disputeProofHash(address(dep), _acct(), nonce, proposerIsLeft, pbHash, pb.watchSeed)),
      starterInitialArguments: "",
      starterCounterArguments: "",
      starterCounterProofCommitment: bytes32(0)
    });
    _submit(0, start);
    (, , uint256 disputeTimeout, , , , , , , , , , , , , , ) = dep._accounts(_acct());
    vm.warp(disputeTimeout + 1);

    Batch memory fin = XlnHanko.emptyBatch();
    fin.disputeFinalizations = new FinalDisputeProof[](1);
    fin.disputeFinalizations[0] = FinalDisputeProof({
      counterentity: entity[1],
      initialNonce: nonce,
      finalNonce: nonce,
      proposerIsLeft: proposerIsLeft,
      initialProofbodyHash: pbHash,
      finalProofbody: pb,
      starterArguments: "",
      otherArguments: "",
      sig: "",
      startedByLeft: startedByLeft,
      cooperative: false
    });
    _submit(0, fin);
  }

  function _collateral() internal view returns (uint256 amount) {
    (amount,) = dep._collaterals(_acct(), T);
  }

  /// @dev What the Account holds: both reserves and the collateral. A debt is not in it.
  function _pool() internal view returns (uint256) {
    return dep._reserves(left, T) + dep._reserves(right, T) + _collateral();
  }

  function _owed(bytes32 debtor) internal view returns (uint256 low) {
    (uint256 high, uint256 middle, uint256 lowWord) = dep.debtOutstanding(debtor, T);
    assertEq(high, 0, "the debt fits one word: high");
    assertEq(middle, 0, "the debt fits one word: middle");
    return lowWord;
  }

  /// @dev Split. Delta = 1000 - 600 = 400: LEFT 400 and RIGHT 600, the collateral emptied, nothing owed. Carried by the two
  ///      reserves summing to the pool before (a collateral paid out twice, or one side short, breaks it) and by no debt.
  function test_R_CONSERVE_aSplitPayoutMovesTheCollateralToTheTwoReservesAndNothingElse() public {
    uint256 poolBefore = _pool();
    assertEq(poolBefore, DEPOSIT, "setup: the pool is the deposit");

    _payOut(-600);

    assertEq(dep._reserves(left, T), 400, "LEFT is paid Delta");
    assertEq(dep._reserves(right, T), 600, "RIGHT is paid the rest of the collateral");
    assertEq(_collateral(), 0, "the collateral is emptied");
    assertEq(_pool(), poolBefore, "reserves plus collateral are what they were");
    assertEq(_owed(left) + _owed(right), 0, "a split books no debt");
  }

  /// @dev LEFT owes. Delta = 1000 - 1300 = -300: RIGHT takes the whole 1000, LEFT (no reserve left after funding) owes 300 to RIGHT.
  ///      Carried by the pool (the 300 is not value: a mutant that credits it makes the pool 1300), by LEFT's debt of exactly 300 to
  ///      RIGHT (a payout that forgets the debt leaves the creditor's claim nowhere), and by RIGHT's reserve of the collateral.
  function test_R_CONSERVE_aShortfallThatTheReserveCannotCoverIsBookedAsExactlyThatDebt() public {
    uint256 poolBefore = _pool();

    _payOut(-1300);

    assertEq(dep._reserves(right, T), DEPOSIT, "RIGHT takes all the collateral");
    assertEq(dep._reserves(left, T), 0, "LEFT holds nothing to pay with");
    assertEq(_pool(), poolBefore, "reserves plus collateral are what they were");
    assertEq(_owed(left), 300, "LEFT owes exactly the credit the signed offdelta granted");
    (bytes32 creditor, Uint512 memory amount) = dep._debts(left, T, 0);
    assertEq(creditor, right, "the claim belongs to RIGHT");
    assertEq(amount.high, 0, "the claim fits one word");
    assertEq(amount.low, 300, "the claim is the shortfall");
    assertEq(_owed(right), 0, "RIGHT owes nothing");
  }

  /// @dev RIGHT owes. Delta = 1000 + 1300 = 2300: LEFT takes the 1000, RIGHT owes 1300. RIGHT holds 100, which is spendable and is
  ///      paid first; the other 1200 is booked. Carried by the pool (1100 before and after: the payment moves between reserves), and
  ///      by paid + booked == 1300: what the creditor received and the debt booked are the whole shortfall, neither more nor less.
  function test_R_CONSERVE_aShortfallIsPaidFromTheDebtorsReserveFirstAndTheRemainderIsBooked() public {
    dep.mintToReserve(right, T, 100);
    uint256 poolBefore = _pool();
    assertEq(poolBefore, DEPOSIT + 100, "setup: the pool is the deposit and RIGHT's reserve");

    _payOut(1300);

    uint256 paid = dep._reserves(left, T) - DEPOSIT;
    assertEq(paid, 100, "RIGHT's whole spendable reserve went to LEFT");
    assertEq(dep._reserves(right, T), 0, "RIGHT paid what it could");
    assertEq(_pool(), poolBefore, "reserves plus collateral are what they were");
    assertEq(_owed(right), 1200, "RIGHT owes what the reserve could not cover");
    assertEq(paid + _owed(right), 1300, "paid plus booked is exactly Delta minus the collateral");
    (bytes32 creditor,) = dep._debts(right, T, 0);
    assertEq(creditor, left, "the claim belongs to LEFT");
    assertEq(_owed(left), 0, "LEFT owes nothing");
  }
}
