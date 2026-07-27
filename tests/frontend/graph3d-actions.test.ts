import { describe, expect, test } from 'bun:test';

import {
  buildGraphPaymentInput,
  calculateGraphEntityRadius,
  collectGraphTokenIds,
  getGraphEntitySizeForToken,
  parseGraphPaymentAmount,
} from '../../frontend/src/lib/view/panels/graph3d-actions';

describe('graph3d action helpers', () => {
  test('builds exact decimal payment amounts without floating-point math', () => {
    expect(parseGraphPaymentAmount('1.23456789', 6)).toBe(1_234_567n);
    const input = buildGraphPaymentInput(
      {
        id: 'job',
        from: 'alice',
        to: 'bob',
        tokenId: 1,
        amount: '2.5',
        tps: 0,
        sentCount: 0,
        startedAt: 1,
      },
      'signer',
      ['alice', 'hub', 'bob'],
      6,
    );
    expect(input.entityTxs[0]?.data.amount).toBe(2_500_000n);
    expect(() =>
      buildGraphPaymentInput(
        { id: 'bad', from: 'alice', to: 'bob', tokenId: 1, amount: '1', tps: 0, sentCount: 0, startedAt: 1 },
        'signer',
        ['alice', 'mallory'],
        6,
      ),
    ).toThrow('Route mismatch');
  });

  test('collects deterministic token ids and preserves the default token', () => {
    const replicas = new Map([
      [
        'alice:signer',
        {
          state: {
            reserves: new Map([
              [3, 1n],
              ['2', 1n],
            ]),
          },
        },
      ],
      ['bob:signer', { state: { reserves: new Map([[3, 2n]]) } }],
    ]);
    expect(collectGraphTokenIds(replicas)).toEqual([1, 2, 3]);
  });

  test('scales entity radius from the selected reserve token only', () => {
    expect(calculateGraphEntityRadius(0)).toBe(0.4);
    const replicas = new Map([['alice:signer', { state: { reserves: new Map([[1, 500_000_000_000n]]) } }]]);
    expect(
      getGraphEntitySizeForToken({
        replicas,
        entityId: 'alice',
        tokenId: 1,
        tokenDecimals: 6,
        sizeMultiplier: 1,
      }),
    ).toBe(0.8);
    expect(
      getGraphEntitySizeForToken({
        replicas,
        entityId: 'missing',
        tokenId: 1,
        tokenDecimals: 6,
        sizeMultiplier: 1,
      }),
    ).toBeCloseTo(0.64);
  });
});
