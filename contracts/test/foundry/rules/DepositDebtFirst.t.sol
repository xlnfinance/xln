// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {XlnFixture} from "../helpers/XlnFixture.sol";
import {XlnHanko} from "../helpers/XlnHanko.sol";
import {Depository} from "../../../contracts/Depository.sol";
import {DepositoryDebtHarness} from "../../../contracts/mocks/DepositoryDebtHarness.sol";
import "../../../contracts/Types.sol";

/// @notice A reserve-to-collateral deposit pays the depositor's debts first. Four claims, each with the assertion that carries it:
///   1. the queue is paid before anything moves to collateral      (the creditor's reserve rises by the whole debt),
///   2. a call pays at most 32 claims                              (the creditor's gain and the cursor stop at 32 of 35),
///   3. what is spendable nets ALL the debt, paid or not           (the 51st unit is refused although 3550 sit in reserve),
///   4. a part-paid claim stays at the head until a later deposit  (the cursor rests on it, then the deposit pays only what is left).
/// Debts are seeded through the debt harness: the claims are what is under test, not how a dispute books them.
contract DepositDebtFirstTest is XlnFixture {
  uint256 internal constant T = 1;
  uint256 internal constant CHUNK = 32;
  uint256 internal constant SIZE = 100;

  bytes32 internal debtor;
  bytes32 internal creditor;

  function _newDepository() internal override returns (Depository) {
    return new DepositoryDebtHarness(address(ep), address(deltaTransformer));
  }

  function setUp() public {
    _deployXln();
    debtor = entity[0];
    creditor = entity[1];
  }

  function _seedDebts(uint256 count) internal {
    for (uint256 i = 0; i < count; i++) DepositoryDebtHarness(address(dep)).harnessAddDebt(debtor, T, creditor, SIZE);
  }

  function _depositBatch(uint256 amount) internal view returns (Batch memory b) {
    b = XlnHanko.emptyBatch();
    b.reserveToCollateral = new ReserveToCollateral[](1);
    EntityAmount[] memory pairs = new EntityAmount[](1);
    pairs[0] = EntityAmount({entity: creditor, amount: amount});
    b.reserveToCollateral[0] = ReserveToCollateral({tokenId: T, receivingEntity: debtor, pairs: pairs});
  }

  function _outstanding() internal view returns (uint256 low) {
    (uint256 high, uint256 middle, uint256 lowWord) = dep.debtOutstanding(debtor, T);
    assertEq(high, 0, "outstanding debt fits one word: high");
    assertEq(middle, 0, "outstanding debt fits one word: middle");
    return lowWord;
  }

  function _collateral() internal view returns (uint256 amount) {
    (amount,) = dep._collaterals(XlnHanko.accountKey(debtor, creditor), T);
  }

  /// @dev Claim 1. Carried by the creditor's reserve: with the enforcement call gone from the deposit, the batch still lands
  ///      (50 is spendable once the debt is netted) but the creditor stays at 0 and the debt stays outstanding.
  function test_R2C_DEBT_FIRST_theCreditorIsPaidBeforeAnythingMovesToCollateral() public {
    _seedDebts(1);
    dep.mintToReserve(debtor, T, SIZE + 50);

    _submit(0, _depositBatch(50));

    assertEq(dep._reserves(creditor, T), SIZE, "the creditor holds the whole debt");
    assertEq(_outstanding(), 0, "no debt is left outstanding");
    assertEq(dep.activeDebts(debtor), 0, "no claim is left active");
    assertEq(dep._reserves(debtor, T), 0, "the debtor kept only what the deposit moved");
    assertEq(_collateral(), 50, "the deposit itself reached the collateral");
  }

  /// @dev Claims 2 and 3 on one scenario: 35 claims of 100, 3550 in reserve. One call pays 32 of them (3200); the 3 left (300) are
  ///      netted from the reserve, so exactly 50 is spendable and the deposit of 50 lands, leaving a reserve equal to the debt.
  ///      Carried by: the creditor's 3200 and the cursor at 32 (the cap), the debtor's reserve of exactly 300 (the netting).
  function test_R2C_DEBT_FIRST_aCallPaysThirtyTwoClaimsAndTheRestStaysNetted() public {
    _seedDebts(35);
    dep.mintToReserve(debtor, T, 35 * SIZE + 50);

    _submit(0, _depositBatch(50));

    assertEq(dep._reserves(creditor, T), CHUNK * SIZE, "one call pays 32 claims, no more");
    assertEq(dep._debtIndex(debtor, T), CHUNK, "the cursor rests on the 33rd claim");
    assertEq(dep.activeDebts(debtor), 3, "three claims are still active");
    assertEq(_outstanding(), 3 * SIZE, "300 is still owed");
    assertEq(dep._reserves(debtor, T), 3 * SIZE, "the reserve left is exactly the debt left");
    assertEq(_collateral(), 50, "the deposit landed in the collateral");
  }

  /// @dev Claim 3, the refusal side: the same 3550 in reserve, but 3500 of it is owed. One unit above the 50 that is spendable is
  ///      refused with E3, and the refused batch undoes the debt payments as well (nothing moved). Carried by BatchFailed(E3): a
  ///      spendable amount that ignored the debt would let 51 land.
  function test_R2C_DEBT_FIRST_aDepositAboveWhatIsSpendableAfterAllDebtIsRefused() public {
    _seedDebts(35);
    dep.mintToReserve(debtor, T, 35 * SIZE + 50);

    _submitFailedUnmoved(0, _depositBatch(51), E3.selector, creditor, T);

    assertEq(_outstanding(), 35 * SIZE, "the refused batch left all 35 claims outstanding");
    assertEq(dep.activeDebts(debtor), 35, "and all of them active");
  }

  /// @dev Claim 4. 150 pays the first claim and half of the second: the second is the head, part paid, cursor on it. A later deposit
  ///      pays the 50 that is left, once. Carried by the cursor and the head's remainder after the first call (a head that was skipped
  ///      or dropped fails there) and by the creditor's total of exactly 200 after the deposit (paid twice or never fails there).
  function test_R2C_DEBT_FIRST_aPartPaidClaimStaysAtTheHeadUntilTheNextDepositPaysItOff() public {
    _seedDebts(2);
    dep.mintToReserve(debtor, T, 150);
    dep.enforceDebts(debtor, T, CHUNK);

    assertEq(dep.activeDebts(debtor), 1, "the part-paid claim is the one active claim");
    assertEq(dep._debtIndex(debtor, T), 1, "the cursor rests on it");
    (, Uint512 memory head) = dep._debts(debtor, T, 1);
    assertEq(head.high, 0, "its remainder is one word");
    assertEq(head.low, 50, "it still owes the 50 the reserve could not cover");

    dep.mintToReserve(debtor, T, 400);
    _submit(0, _depositBatch(300));

    assertEq(dep._reserves(creditor, T), 2 * SIZE, "the creditor holds both claims, each once");
    assertEq(_outstanding(), 0, "nothing is owed");
    assertEq(dep.activeDebts(debtor), 0, "no claim is active");
    assertEq(dep._debtIndex(debtor, T), 0, "the cursor is back at 0");
    assertEq(dep._reserves(debtor, T), 50, "the debtor kept the 350 the claims left, less the 300 deposited");
    assertEq(_collateral(), 300, "the deposit landed in the collateral");
  }
}
