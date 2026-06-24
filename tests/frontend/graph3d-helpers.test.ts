import { describe, expect, test } from 'bun:test';

import {
  formatGraphDualConnectionAccountInfo,
  formatGraphEntityReserveBalances,
  formatGraphEntityShortName,
  formatGraphFinancialAmount,
  formatGraphMempoolTxLabel,
  formatGraphReserveBadge,
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

  test('formats graph financial amounts and reserve badges', () => {
    expect(formatGraphFinancialAmount(0n)).toBe('0');
    expect(formatGraphFinancialAmount(1234567890000000000n)).toBe('1.2345');
    expect(formatGraphFinancialAmount(-2_000000000000000000n)).toBe('-2');
    expect(formatGraphReserveBadge(2_500_000n * 10n ** 18n)).toBe(' $2.5M');
    expect(formatGraphReserveBadge(25_000n * 10n ** 18n)).toBe(' $25K');
  });

  test('formats entity reserve tooltip lines', () => {
    expect(formatGraphEntityReserveBalances({
      reserves: new Map<string, bigint>([['1', 1500n], ['2', 0n]]),
      selectedTokenId: 1,
      getTokenSymbol: (tokenId) => tokenId === 1 ? 'USDC' : 'ETH',
    })).toBe('▸ USDC: 1.50k\n  ETH: 0.00k');
    expect(formatGraphEntityReserveBalances({
      reserves: new Map(),
      selectedTokenId: 1,
      getTokenSymbol: String,
    })).toBe('  No token reserves');
  });

  test('formats entity short names from runtime short id and signer id', () => {
    expect(formatGraphEntityShortName({
      entityId: 'entity-2',
      runtimeShortId: '2',
      signerId: null,
    })).toBe('Alice (entity-2)');
    expect(formatGraphEntityShortName({
      entityId: 'entity-jpm',
      signerId: 'prod-JPM-signer',
    })).toBe('JPM (entity-jpm)');
    expect(formatGraphEntityShortName({
      entityId: 'entity-fed',
      signerId: 'us_federal_reserve_root',
    })).toBe('Federal Reserve (entity-fed)');
    expect(formatGraphEntityShortName({
      entityId: 'entity-unknown',
      signerId: 'unknown-bank',
    })).toBe('Bank (entity-unknown)');
  });

  test('formats dual account tooltip text', () => {
    const tokenDelta = { tokenId: 2 };
    const accountData = { deltas: new Map<number, unknown>([[2, tokenDelta]]) };
    const info = formatGraphDualConnectionAccountInfo({
      leftId: 'alice',
      rightId: 'bob',
      accountData,
      selectedTokenId: 1,
      getAccountTokenDelta: (account, tokenId) => (account as typeof accountData).deltas.get(tokenId) ?? null,
      deriveEntry: (_delta, isLeft) => ({
        delta: isLeft ? 2_000000000000000000 : -2_000000000000000000,
        ownCreditLimit: isLeft ? 5_000000000000000000 : 6_000000000000000000,
        peerCreditLimit: isLeft ? 7_000000000000000000 : 8_000000000000000000,
        collateral: isLeft ? 3_000000000000000000 : 4_000000000000000000,
      }),
      getEntityShortName: (entityId) => entityId.toUpperCase(),
    });
    expect(info).toEqual({
      left: 'Their Credit: 7\nCollateral: 3\nOur Credit: 5\nNet: 2',
      right: 'Our Credit: 6\nCollateral: 4\nTheir Credit: 8\nNet: -2',
      leftEntity: 'ALICE',
      rightEntity: 'BOB',
    });
  });
});
