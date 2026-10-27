import { describe, expect, test } from 'bun:test';
import { resolveRpcFinalityDepth } from '../../../../jurisdiction/adapter/rpc/rpc-finality';

describe('Tron jurisdiction finality', () => {
  test.each([123_456_789, 728_126_428, 3_448_148_188, 1])(
    'uses solidified finality for explicit Tron mode on chain %i',
    chainId => {
      // Identity belongs to the signing domain, not the finality selector.
      // An unlisted private TVM chain must never admit an unfinalized receipt
      // merely because it is absent from the public-network address book.
      expect(resolveRpcFinalityDepth({ mode: 'tron', chainId }, false)).toBe(0);
    },
  );

  test('rejects guessed confirmation depth on a private Tron jurisdiction', () => {
    expect(() => resolveRpcFinalityDepth({
      mode: 'tron', chainId: 123_456_789, confirmationDepth: 2,
    }, false)).toThrow('TRON_CONFIRMATION_DEPTH_FORBIDDEN');
  });

  test('retains explicit zero depth after Tron solidification', () => {
    expect(resolveRpcFinalityDepth({
      mode: 'tron', chainId: 123_456_789, confirmationDepth: 0,
    }, false)).toBe(0);
  });
});

describe('EVM jurisdiction finality remains unchanged', () => {
  test.each([
    { chainId: 1, expected: 12 },
    { chainId: 8453, expected: 2 },
    { chainId: 123_456_789, expected: 2 },
    { chainId: 31_337, expected: 0 },
    { chainId: 31_338, expected: 0 },
  ])('chain $chainId retains $expected confirmations', ({ chainId, expected }) => {
    expect(resolveRpcFinalityDepth({ mode: 'rpc', chainId }, false)).toBe(expected);
  });

  test('retains configured EVM depth and scenario override', () => {
    const config = { mode: 'rpc' as const, chainId: 8453, confirmationDepth: 7 };
    expect(resolveRpcFinalityDepth(config, false)).toBe(7);
    expect(resolveRpcFinalityDepth(config, true)).toBe(0);
  });
});

test.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid explicit finality depth %s', confirmationDepth => {
  expect(() => resolveRpcFinalityDepth({ mode: 'rpc', chainId: 1, confirmationDepth }, false)).toThrow('RPC_CONFIRMATION_DEPTH_INVALID');
});
