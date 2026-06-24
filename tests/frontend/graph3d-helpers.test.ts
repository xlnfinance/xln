import { describe, expect, test } from 'bun:test';

import {
  formatGraphMempoolTxLabel,
  graphReserveValue,
  graphReserveValues,
  graphTotalReserves,
} from '../../frontend/src/lib/view/panels/graph3d-helpers';

describe('graph3d helpers', () => {
  test('normalizes reserve maps and snapshot objects', () => {
    const reserveMap = new Map<string | number, bigint>([
      ['1', 10n],
      [2, 20n],
    ]);
    expect(graphReserveValues(reserveMap)).toEqual([10n, 20n]);
    expect(graphReserveValue(reserveMap, '1')).toBe(10n);
    expect(graphReserveValue(reserveMap, '2')).toBe(20n);

    const reserveObject = { '1': '30n', '2': 40n };
    expect(graphReserveValues(reserveObject)).toEqual([30n, 40n]);
    expect(graphReserveValue(reserveObject, '1')).toBe(30n);
    expect(graphTotalReserves({ state: { reserves: reserveObject } })).toBe(70n);
  });

  test('formats batch tx summaries for J-machine labels', () => {
    expect(formatGraphMempoolTxLabel({
      type: 'batch',
      entityId: '0xabc9',
      data: {
        batch: {
          reserveToReserve: [{}, {}],
          reserveToCollateral: [{}],
          settlements: [
            { diffs: [{ collateralDiff: -1n }, { collateralDiff: 2n }] },
            { diffs: [{ collateralDiff: -3n }] },
          ],
        },
      },
    })).toBe('E9: 2R2R +1R2C -2W +1D');
  });

  test('formats generic tx labels with block height and coarse amount', () => {
    expect(formatGraphMempoolTxLabel({
      type: 'payment',
      from: 'alice7',
      to: 'bob8',
      amount: 5_000_000n * 10n ** 18n,
    }, 12)).toBe('#12 PAYMENT: 7→8 $5M');
  });
});
