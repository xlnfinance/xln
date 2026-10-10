/**
 * Pure mirror of Depository._applyAccountDelta for deterministic previews.
 *
 * `existingDebtOutstanding` is the remaining aggregate lock at the supplied
 * reserve snapshot. Routing older FIFO debt requires the debt queue and belongs
 * to the caller; this helper mirrors the subsequent spendable-reserve check,
 * collateral allocation, reserve payment, and new-debt creation exactly.
 */

import { INT512_MAX, INT512_MIN, UINT256_MAX, UINT512_MAX, UINT768_MAX } from '../boundary/integer-ranges';

type DisputeDirectionAmounts = Readonly<{
  leftToRight: bigint;
  rightToLeft: bigint;
}>;

type DisputeSideAmounts = Readonly<{
  left: bigint;
  right: bigint;
}>;

export type DisputeTokenFinalizationInput = Readonly<{
  tokenId: number;
  leftReserve: bigint;
  rightReserve: bigint;
  collateral: bigint;
  ondelta: bigint;
  offdelta: bigint;
  existingDebtOutstanding?: DisputeSideAmounts;
}>;

export type DisputeTokenFinalization = Readonly<{
  tokenId: number;
  finalDelta: bigint;
  before: Readonly<{
    reserves: DisputeSideAmounts;
    collateral: bigint;
    debtOutstanding: DisputeSideAmounts;
    custodyTotal: bigint;
  }>;
  collateralAllocation: DisputeSideAmounts;
  shortfall: DisputeDirectionAmounts;
  reservePaid: DisputeDirectionAmounts;
  newDebt: DisputeDirectionAmounts;
  after: Readonly<{
    reserves: DisputeSideAmounts;
    collateral: 0n;
    ondelta: 0n;
    debtOutstanding: DisputeSideAmounts;
    custodyTotal: bigint;
  }>;
  conservation: Readonly<{
    beforeTotal: bigint;
    afterTotal: bigint;
    reserveIncrease: bigint;
    collateralDecrease: bigint;
    conserved: boolean;
  }>;
}>;

function fail(path: string, detail: string): never {
  throw new Error(`DISPUTE_FINALIZATION_INVALID: ${path} ${detail}`);
}

function requireTokenId(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) fail('tokenId', 'must be a non-negative safe integer');
}

function requireUint256(value: unknown, path: string): asserts value is bigint {
  if (typeof value !== 'bigint') fail(path, 'must be a bigint');
  if (value < 0n || value > UINT256_MAX) fail(path, 'must fit uint256');
}

function requireInt512(value: unknown, path: string): asserts value is bigint {
  if (typeof value !== 'bigint') fail(path, 'must be a bigint');
  if (value < INT512_MIN || value > INT512_MAX) fail(path, 'must fit int512');
}

function requireDebtAggregate(value: unknown, path: string): asserts value is bigint {
  if (typeof value !== 'bigint') fail(path, 'must be a bigint');
  if (value < 0n || value > UINT768_MAX) fail(path, 'must fit uint768');
}

function checkedDebtAdd(left: bigint, right: bigint, path: string): bigint {
  const result = left + right;
  requireDebtAggregate(result, path);
  return result;
}

function checkedAdd(left: bigint, right: bigint, path: string): bigint {
  const result = left + right;
  if (result > UINT256_MAX) fail(path, 'overflows uint256');
  return result;
}

function custodyTotal(leftReserve: bigint, rightReserve: bigint, collateral: bigint): bigint {
  return leftReserve + rightReserve + collateral;
}

function resolveDebt(input: DisputeTokenFinalizationInput): DisputeSideAmounts {
  const debt = input.existingDebtOutstanding ?? { left: 0n, right: 0n };
  requireDebtAggregate(debt.left, 'existingDebtOutstanding.left');
  requireDebtAggregate(debt.right, 'existingDebtOutstanding.right');
  return { left: debt.left, right: debt.right };
}

function spendableReserve(reserve: bigint, debtOutstanding: bigint): bigint {
  return reserve > debtOutstanding ? reserve - debtOutstanding : 0n;
}

function collateralAllocation(finalDelta: bigint, collateral: bigint): DisputeSideAmounts {
  const left = finalDelta <= 0n ? 0n : finalDelta >= collateral ? collateral : finalDelta;
  return { left, right: collateral - left };
}

function deriveShortfall(finalDelta: bigint, collateral: bigint): DisputeDirectionAmounts {
  return {
    leftToRight: finalDelta < 0n ? -finalDelta : 0n,
    rightToLeft: finalDelta > collateral ? finalDelta - collateral : 0n,
  };
}

function deriveReservePaid(
  input: DisputeTokenFinalizationInput,
  debt: DisputeSideAmounts,
  shortfall: DisputeDirectionAmounts,
): DisputeDirectionAmounts {
  const leftAvailable = spendableReserve(input.leftReserve, debt.left);
  const rightAvailable = spendableReserve(input.rightReserve, debt.right);
  return {
    leftToRight: leftAvailable < shortfall.leftToRight ? leftAvailable : shortfall.leftToRight,
    rightToLeft: rightAvailable < shortfall.rightToLeft ? rightAvailable : shortfall.rightToLeft,
  };
}

function derivePostReserves(
  input: DisputeTokenFinalizationInput,
  allocation: DisputeSideAmounts,
  paid: DisputeDirectionAmounts,
): DisputeSideAmounts {
  const leftBase = input.leftReserve - paid.leftToRight;
  const rightBase = input.rightReserve - paid.rightToLeft;
  return {
    left: checkedAdd(checkedAdd(leftBase, allocation.left, 'after.reserves.left'), paid.rightToLeft, 'after.reserves.left'),
    right: checkedAdd(checkedAdd(rightBase, allocation.right, 'after.reserves.right'), paid.leftToRight, 'after.reserves.right'),
  };
}

function validateInput(input: DisputeTokenFinalizationInput): void {
  requireTokenId(input.tokenId);
  requireUint256(input.leftReserve, 'leftReserve');
  requireUint256(input.rightReserve, 'rightReserve');
  requireUint256(input.collateral, 'collateral');
  requireInt512(input.ondelta, 'ondelta');
  requireInt512(input.offdelta, 'offdelta');
  // Allocation arithmetic is wider than either proof operand. Only the final
  // magnitude enters the two-word debt representation; custody stays uint256.
  const finalDelta = input.ondelta + input.offdelta;
  if (finalDelta < -UINT512_MAX || finalDelta > UINT512_MAX) {
    fail('finalDelta', 'magnitude exceeds uint512');
  }
}

function deriveNewDebt(
  shortfall: DisputeDirectionAmounts,
  paid: DisputeDirectionAmounts,
): DisputeDirectionAmounts {
  return {
    leftToRight: shortfall.leftToRight - paid.leftToRight,
    rightToLeft: shortfall.rightToLeft - paid.rightToLeft,
  };
}

function buildResult(
  input: DisputeTokenFinalizationInput,
  finalDelta: bigint,
  debt: DisputeSideAmounts,
  allocation: DisputeSideAmounts,
  shortfall: DisputeDirectionAmounts,
  paid: DisputeDirectionAmounts,
  newDebt: DisputeDirectionAmounts,
  reserves: DisputeSideAmounts,
): DisputeTokenFinalization {
  const beforeTotal = custodyTotal(input.leftReserve, input.rightReserve, input.collateral);
  const afterTotal = custodyTotal(reserves.left, reserves.right, 0n);
  const reserveIncrease = reserves.left + reserves.right - input.leftReserve - input.rightReserve;
  return {
    tokenId: input.tokenId,
    finalDelta,
    before: { reserves: { left: input.leftReserve, right: input.rightReserve }, collateral: input.collateral, debtOutstanding: debt, custodyTotal: beforeTotal },
    collateralAllocation: allocation,
    shortfall,
    reservePaid: paid,
    newDebt,
    after: {
      reserves,
      collateral: 0n,
      ondelta: 0n,
      debtOutstanding: {
        left: checkedDebtAdd(debt.left, newDebt.leftToRight, 'after.debtOutstanding.left'),
        right: checkedDebtAdd(debt.right, newDebt.rightToLeft, 'after.debtOutstanding.right'),
      },
      custodyTotal: afterTotal,
    },
    conservation: { beforeTotal, afterTotal, reserveIncrease, collateralDecrease: input.collateral, conserved: beforeTotal === afterTotal },
  };
}

export function deriveDisputeTokenFinalization(
  input: DisputeTokenFinalizationInput,
): DisputeTokenFinalization {
  validateInput(input);
  const finalDelta = input.ondelta + input.offdelta;
  const debt = resolveDebt(input);
  const allocation = collateralAllocation(finalDelta, input.collateral);
  const shortfall = deriveShortfall(finalDelta, input.collateral);
  const paid = deriveReservePaid(input, debt, shortfall);
  const newDebt = deriveNewDebt(shortfall, paid);
  const reserves = derivePostReserves(input, allocation, paid);
  return buildResult(input, finalDelta, debt, allocation, shortfall, paid, newDebt, reserves);
}
