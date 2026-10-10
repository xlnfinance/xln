import { describe, expect, test } from 'bun:test';

import {
  deriveDisputeTokenFinalization,
  type DisputeTokenFinalizationInput,
} from '../../../protocol/dispute/finalization';

const token = (
  partial: Partial<DisputeTokenFinalizationInput> = {},
): DisputeTokenFinalizationInput => ({
  tokenId: partial.tokenId ?? 1,
  leftReserve: partial.leftReserve ?? 100n,
  rightReserve: partial.rightReserve ?? 100n,
  collateral: partial.collateral ?? 100n,
  ondelta: partial.ondelta ?? 0n,
  offdelta: partial.offdelta ?? 50n,
  ...(partial.existingDebtOutstanding
    ? { existingDebtOutstanding: partial.existingDebtOutstanding }
    : {}),
});

describe('deriveDisputeTokenFinalization', () => {
  test('records a complete two-word debt and three-word aggregate', () => {
    const previous = (1n << 512n) + 3n;
    const result = deriveDisputeTokenFinalization(token({
      leftReserve: 0n, rightReserve: 0n, collateral: 0n,
      ondelta: 0n, offdelta: -(1n << 256n),
      existingDebtOutstanding: { left: previous, right: 0n },
    }));
    expect(result.newDebt.leftToRight).toBe(1n << 256n);
    expect(result.after.debtOutstanding.left).toBe(previous + (1n << 256n));
    expect(result.conservation.conserved).toBe(true);
  });

  test('cumulative allocation and proof cancel exactly above uint256', () => {
    const result = deriveDisputeTokenFinalization(token({
      leftReserve: 0n, rightReserve: 0n, collateral: 0n,
      ondelta: 1n << 300n, offdelta: -(1n << 300n) - 7n,
    }));
    expect(result.finalDelta).toBe(-7n);
    expect(result.newDebt.leftToRight).toBe(7n);
  });

  test('a debt aggregate rejects true unsigned768 overflow', () => {
    expect(() => deriveDisputeTokenFinalization(token({
      leftReserve: 0n, rightReserve: 0n, collateral: 0n,
      ondelta: 0n, offdelta: -1n,
      existingDebtOutstanding: { left: (1n << 768n) - 1n, right: 0n },
    }))).toThrow('after.debtOutstanding.left must fit uint768');
  });

  test('matches the Depository counter-dispute reserve regression', () => {
    const result = deriveDisputeTokenFinalization(token({
      leftReserve: 700n,
      rightReserve: 0n,
      collateral: 300n,
      offdelta: 100n,
    }));

    expect(result.collateralAllocation).toEqual({ left: 100n, right: 200n });
    expect(result.after.reserves).toEqual({ left: 800n, right: 200n });
    expect(result.after.collateral).toBe(0n);
    expect(result.after.ondelta).toBe(0n);
    expect(result.conservation.beforeTotal).toBe(1_000n);
    expect(result.conservation.afterTotal).toBe(1_000n);
  });

  test('splits a fully collateralized delta without reserve transfers', () => {
    const result = deriveDisputeTokenFinalization(token({ collateral: 100n, offdelta: 70n }));

    expect(result.collateralAllocation).toEqual({ left: 70n, right: 30n });
    expect(result.shortfall).toEqual({ leftToRight: 0n, rightToLeft: 0n });
    expect(result.reservePaid).toEqual({ leftToRight: 0n, rightToLeft: 0n });
    expect(result.after.reserves).toEqual({ left: 170n, right: 130n });
    expect(result.after.collateral).toBe(0n);
    expect(result.after.ondelta).toBe(0n);
    expect(result.conservation).toEqual({
      beforeTotal: 300n,
      afterTotal: 300n,
      reserveIncrease: 100n,
      collateralDecrease: 100n,
      conserved: true,
    });
  });

  test('settles a 70/30 collateral and reserve-backed right debt', () => {
    const result = deriveDisputeTokenFinalization(token({
      leftReserve: 10n,
      rightReserve: 60n,
      collateral: 70n,
      offdelta: 100n,
    }));

    expect(result.collateralAllocation).toEqual({ left: 70n, right: 0n });
    expect(result.shortfall).toEqual({ leftToRight: 0n, rightToLeft: 30n });
    expect(result.reservePaid).toEqual({ leftToRight: 0n, rightToLeft: 30n });
    expect(result.newDebt).toEqual({ leftToRight: 0n, rightToLeft: 0n });
    expect(result.after.reserves).toEqual({ left: 110n, right: 30n });
    expect(result.conservation.conserved).toBe(true);
  });

  test('uses left reserve then creates debt for a negative-delta shortfall', () => {
    const result = deriveDisputeTokenFinalization(token({
      leftReserve: 10n,
      rightReserve: 5n,
      collateral: 70n,
      offdelta: -30n,
    }));

    expect(result.collateralAllocation).toEqual({ left: 0n, right: 70n });
    expect(result.shortfall).toEqual({ leftToRight: 30n, rightToLeft: 0n });
    expect(result.reservePaid).toEqual({ leftToRight: 10n, rightToLeft: 0n });
    expect(result.newDebt).toEqual({ leftToRight: 20n, rightToLeft: 0n });
    expect(result.after.reserves).toEqual({ left: 0n, right: 85n });
    expect(result.after.debtOutstanding.left).toBe(20n);
    expect(result.conservation.conserved).toBe(true);
  });

  test('respects existing debtOutstanding when calculating spendable reserve', () => {
    const result = deriveDisputeTokenFinalization(token({
      leftReserve: 100n,
      rightReserve: 0n,
      collateral: 0n,
      offdelta: -50n,
      existingDebtOutstanding: { left: 80n, right: 0n },
    }));

    expect(result.reservePaid.leftToRight).toBe(20n);
    expect(result.newDebt.leftToRight).toBe(30n);
    expect(result.after.reserves).toEqual({ left: 80n, right: 20n });
    expect(result.after.debtOutstanding.left).toBe(110n);
  });

  test('fails fast on non-bigint money and Solidity overflow edges', () => {
    expect(() => deriveDisputeTokenFinalization({ ...token(), leftReserve: 1 as never }))
      .toThrow('leftReserve must be a bigint');
    expect(() => deriveDisputeTokenFinalization({ ...token(), ondelta: 1 as never }))
      .toThrow('ondelta must be a bigint');
    expect(() => deriveDisputeTokenFinalization({
      ...token(),
      ondelta: -(1n << 511n),
      offdelta: -(1n << 511n),
    })).toThrow('finalDelta magnitude exceeds uint512');
  });

  test('matches Solidity wide-delta finalization after same-nonce R2C crosses int256.max', () => {
    const int256Max = (1n << 255n) - 1n;
    const result = deriveDisputeTokenFinalization(token({
      leftReserve: 0n,
      rightReserve: 0n,
      collateral: int256Max - 9n,
      ondelta: int256Max - 9n,
      offdelta: 10n,
    }));

    expect(result.finalDelta).toBe(int256Max + 1n);
    expect(result.collateralAllocation).toEqual({ left: int256Max - 9n, right: 0n });
    expect(result.newDebt).toEqual({ leftToRight: 0n, rightToLeft: 10n });
    expect(result.after.reserves).toEqual({ left: int256Max - 9n, right: 0n });
    expect(result.conservation.conserved).toBe(true);
  });

  test('mirrors Solidity int256.min signed-magnitude settlement without negation', () => {
    const result = deriveDisputeTokenFinalization(token({
      leftReserve: 0n,
      rightReserve: 0n,
      collateral: 100n,
      ondelta: 0n,
      offdelta: -(1n << 255n),
    }));

    expect(result.finalDelta).toBe(-(1n << 255n));
    expect(result.collateralAllocation).toEqual({ left: 0n, right: 100n });
    expect(result.newDebt).toEqual({ leftToRight: 1n << 255n, rightToLeft: 0n });
    expect(result.after.reserves).toEqual({ left: 0n, right: 100n });
    expect(result.conservation.conserved).toBe(true);
  });
});
