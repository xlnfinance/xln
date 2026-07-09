import { expect, test } from 'bun:test';
import { compileOps } from '../settlement-ops';
import type { SettlementOp } from '../types';

test('compileOps rejects unknown settlement operation types without console fallback', () => {
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
