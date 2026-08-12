import { expect, test } from 'bun:test';
import { compileOps, userAutoApprove } from '../../../protocol/settlement/operations';
import type { SettlementOp } from '../../../types/account';

test('compileOps rejects unknown settlement operation types without console substitution', () => {
  const originalWarn = console.warn;
  let warned = false;
  console.warn = () => {
    warned = true;
  };

  try {
    expect(() =>
      compileOps([
        { type: 'teleport', tokenId: 7, amount: 1n } as unknown as SettlementOp,
      ], true),
    ).toThrow('SETTLEMENT_UNKNOWN_OP_TYPE: type=teleport tokenId=7');
    expect(warned).toBe(false);
  } finally {
    console.warn = originalWarn;
  }
});

test('compileOps preserves valid proposer-left r2c settlement diff semantics', () => {
  const result = compileOps([{ type: 'r2c', tokenId: 1, amount: 10n }], true);

  expect(result.forgiveTokenIds).toEqual([]);
  expect(result.diffs).toEqual([{
    tokenId: 1,
    leftDiff: -10n,
    rightDiff: 0n,
    collateralDiff: 10n,
    ondeltaDiff: 10n,
  }]);
});

test('auto-approval rejects ondelta-only theft of either side collateral share', () => {
  const stealFromRight = {
    tokenId: 1,
    leftDiff: 0n,
    rightDiff: 0n,
    collateralDiff: 0n,
    ondeltaDiff: 100n,
  };
  const stealFromLeft = {
    ...stealFromRight,
    ondeltaDiff: -100n,
  };

  // Total collateral and both reserves stay unchanged. Only ownership moves:
  // left owns `ondelta`, while right owns `collateral - ondelta`.
  expect(userAutoApprove(stealFromRight, false)).toBe(false);
  expect(userAutoApprove(stealFromLeft, true)).toBe(false);
});

test('compileOps rejects settlements the Solidity ABI or Account contract cannot execute', () => {
  const int256Max = (1n << 255n) - 1n;
  const int256Min = -(1n << 255n);

  expect(() => compileOps([
    {
      type: 'rawDiff',
      tokenId: 1,
      leftDiff: int256Max + 1n,
      rightDiff: -(int256Max + 1n),
      collateralDiff: 0n,
      ondeltaDiff: 0n,
    },
  ], true)).toThrow('SETTLEMENT_INT256_RANGE:leftDiff:token=1');

  expect(() => compileOps([
    {
      type: 'rawDiff',
      tokenId: 2,
      leftDiff: int256Min,
      rightDiff: int256Max,
      collateralDiff: 1n,
      ondeltaDiff: 0n,
    },
  ], true)).toThrow('SETTLEMENT_INT256_NEGATION:leftDiff:token=2');

  expect(() => compileOps([
    {
      type: 'rawDiff',
      tokenId: 3,
      leftDiff: int256Max,
      rightDiff: 1n,
      collateralDiff: int256Min,
      ondeltaDiff: 0n,
    },
  ], true)).toThrow('SETTLEMENT_INT256_ADD_OVERFLOW:token=3');

  expect(() => compileOps(
    Array.from({ length: 33 }, (_, tokenId) => ({
      type: 'rawDiff' as const,
      tokenId,
      leftDiff: 0n,
      rightDiff: 0n,
      collateralDiff: 0n,
      ondeltaDiff: 0n,
    })),
    true,
  )).toThrow('SETTLEMENT_DIFF_LIMIT_EXCEEDED:33:32');

  expect(() => compileOps(
    Array.from({ length: 33 }, (_, tokenId) => ({ type: 'forgive' as const, tokenId })),
    true,
  )).toThrow('SETTLEMENT_FORGIVENESS_LIMIT_EXCEEDED:33:32');

  expect(() => compileOps([
    { type: 'forgive', tokenId: 7 },
    { type: 'forgive', tokenId: 7 },
  ], true)).toThrow('SETTLEMENT_DUPLICATE_FORGIVENESS_TOKEN:7');
});
