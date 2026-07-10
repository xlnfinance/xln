import { describe, expect, test } from 'bun:test';

import {
  deriveDisputeFinalization,
  deriveDisputeTokenFinalization,
  type DisputeTokenFinalizationInput,
} from '../dispute-finalization';

const token = (
  partial: Partial<DisputeTokenFinalizationInput> = {},
): DisputeTokenFinalizationInput => ({
  tokenId: partial.tokenId ?? 1,
  leftReserve: partial.leftReserve ?? 100n,
  rightReserve: partial.rightReserve ?? 100n,
  collateral: partial.collateral ?? 100n,
  finalDelta: partial.finalDelta ?? 50n,
  ...(partial.existingDebtOutstanding
    ? { existingDebtOutstanding: partial.existingDebtOutstanding }
    : {}),
});

describe('deriveDisputeTokenFinalization', () => {
  test('matches the Depository counter-dispute reserve regression', () => {
    const result = deriveDisputeTokenFinalization(token({
      leftReserve: 700n,
      rightReserve: 0n,
      collateral: 300n,
      finalDelta: 100n,
    }));

    expect(result.collateralAllocation).toEqual({ left: 100n, right: 200n });
    expect(result.after.reserves).toEqual({ left: 800n, right: 200n });
    expect(result.after.collateral).toBe(0n);
    expect(result.after.ondelta).toBe(0n);
    expect(result.conservation.beforeTotal).toBe(1_000n);
    expect(result.conservation.afterTotal).toBe(1_000n);
  });

  test('splits a fully collateralized delta without reserve transfers', () => {
    const result = deriveDisputeTokenFinalization(token({ collateral: 100n, finalDelta: 70n }));

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
      finalDelta: 100n,
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
      finalDelta: -30n,
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
      finalDelta: -50n,
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
    expect(() => deriveDisputeTokenFinalization({ ...token(), finalDelta: -(1n << 255n) }))
      .toThrow('finalDelta cannot equal int256.min');
  });
});

describe('deriveDisputeFinalization', () => {
  test('composes four independent token rows with both delta signs', () => {
    const result = deriveDisputeFinalization([
      token({ tokenId: 1, collateral: 100n, finalDelta: 70n }),
      token({ tokenId: 2, collateral: 70n, finalDelta: 100n }),
      token({ tokenId: 3, collateral: 70n, finalDelta: -30n }),
      token({ tokenId: 4, collateral: 0n, finalDelta: 0n }),
    ]);

    expect(result.tokenCount).toBe(4);
    expect(result.tokens.map(({ tokenId }) => tokenId)).toEqual([1, 2, 3, 4]);
    expect(result.tokens.map(({ conservation }) => conservation.conserved)).toEqual([true, true, true, true]);
    expect(result.allTokensConserved).toBe(true);
  });

  test('rejects duplicate token rows', () => {
    expect(() => deriveDisputeFinalization([token({ tokenId: 1 }), token({ tokenId: 1 })]))
      .toThrow('tokenId.1 must be unique');
  });
});
