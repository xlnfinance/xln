import { describe, expect, test } from 'bun:test';

import {
  buildGraphAvailableRoutes,
  findGraphReplicaByEntityId,
  formatGraphDualConnectionAccountInfo,
  formatGraphDualConnectionAccountInfoFromReplicas,
  formatGraphEntityBalanceInfo,
  formatGraphEntityReserveBalances,
  formatGraphEntityShortName,
  formatGraphEntityShortNameFromReplicas,
  formatGraphFinancialAmount,
  formatGraphMempoolTxLabel,
  formatGraphReserveBadge,
  getGraphEntityNameFromGossip,
  getGraphSignerIdForEntity,
  graphEntityHasReserves,
  graphReserveValue,
  graphReserveValues,
  graphTotalReserves,
  parseGraphScenarioSteps,
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

  test('formats graph entity labels and account tooltips from replica maps', () => {
    const tokenDelta = { tokenId: 1 };
    const replicas = new Map([
      ['bob:signer', {
        signerId: 'prod-JPM-signer',
        state: {
          reserves: new Map<string, bigint>([['1', 2500n]]),
          accounts: new Map(),
        },
      }],
      ['alice:signer', {
        signerId: 'alice',
        state: {
          accounts: new Map([
            ['bob', { deltas: new Map<number, unknown>([[1, tokenDelta]]) }],
          ]),
        },
      }],
    ]);

    expect(findGraphReplicaByEntityId(replicas, 'bob')?.signerId).toBe('prod-JPM-signer');
    expect(formatGraphEntityBalanceInfo({
      entityId: 'bob',
      replicas,
      selectedTokenId: 1,
      getTokenSymbol: (tokenId) => tokenId === 1 ? 'USDC' : `TKN${tokenId}`,
    })).toBe('▸ USDC: 2.50k');
    expect(formatGraphEntityShortNameFromReplicas({
      entityId: 'bob',
      replicas,
      getEntityShortId: () => null,
    })).toBe('JPM (bob)');
    expect(formatGraphDualConnectionAccountInfoFromReplicas({
      entityA: 'bob',
      entityB: 'alice',
      replicas,
      selectedTokenId: 1,
      getAccountTokenDelta: (account, tokenId) => (account as { deltas: Map<number, unknown> }).deltas.get(tokenId) ?? null,
      deriveEntry: (_delta, isLeft) => ({
        delta: isLeft ? 10_000000000000000000 : -10_000000000000000000,
        ownCreditLimit: isLeft ? 20_000000000000000000 : 30_000000000000000000,
        peerCreditLimit: isLeft ? 40_000000000000000000 : 50_000000000000000000,
        collateral: isLeft ? 60_000000000000000000 : 70_000000000000000000,
      }),
      getEntityShortName: (entityId) => entityId.toUpperCase(),
    })).toEqual({
      left: 'Their Credit: 40\nCollateral: 60\nOur Credit: 20\nNet: 10',
      right: 'Our Credit: 30\nCollateral: 70\nTheir Credit: 50\nNet: -10',
      leftEntity: 'ALICE',
      rightEntity: 'BOB',
    });
  });

  test('extracts graph gossip names, signer ids, reserve presence, and payment routes', () => {
    const replicas = new Map([
      ['alice:signer-a', {
        state: {
          reserves: new Map<string, bigint>([['1', 1n]]),
          accounts: new Map([['hub', {}]]),
        },
      }],
      ['hub:signer-h', {
        state: {
          reserves: new Map<string, bigint>([['1', 0n]]),
          accounts: new Map([['bob', {}], ['alice', {}]]),
        },
      }],
      ['bob:signer-b', {
        state: {
          accounts: new Map([['alice', {}]]),
        },
      }],
    ]);

    expect(getGraphEntityNameFromGossip({
      getProfiles: () => [{ entityId: 'alice', name: 'Alice Bank' }],
    }, 'alice')).toBe('Alice Bank');
    expect(getGraphSignerIdForEntity(replicas, 'alice')).toBe('signer-a');
    expect(getGraphSignerIdForEntity(replicas, 'missing')).toBe('missing');
    expect(graphEntityHasReserves(replicas, 'alice')).toBe(true);
    expect(graphEntityHasReserves(replicas, 'hub')).toBe(false);
    expect(buildGraphAvailableRoutes({
      replicas,
      from: 'alice',
      to: 'bob',
      getEntityShortName: (id) => id.toUpperCase(),
    })).toEqual([
      {
        from: 'alice',
        to: 'bob',
        path: ['alice', 'hub', 'bob'],
        type: 'multihop',
        description: 'ALICE → HUB → BOB',
        cost: 2,
        hops: 2,
      },
    ]);
    expect(buildGraphAvailableRoutes({
      replicas,
      from: 'alice',
      to: 'hub',
      getEntityShortName: (id) => id.toUpperCase(),
    })[0]).toMatchObject({
      path: ['alice', 'hub'],
      type: 'direct',
      description: 'Direct: ALICE → HUB',
    });
  });

  test('parses scenario timeline sections for the graph overlay', () => {
    expect(parseGraphScenarioSteps(`
===
t=10
title: Open account
description: Alice opens a hub account.
# ignored comment
pay alice hub
BroadcastFrame
===
t=25
title: Settle
description: Settlement finalizes.
settle alice hub
===
t=30
description: Missing title should be ignored.
noop
    `)).toEqual([
      {
        timestamp: 10,
        title: 'Open account',
        description: 'Alice opens a hub account.',
        actions: ['pay alice hub'],
      },
      {
        timestamp: 25,
        title: 'Settle',
        description: 'Settlement finalizes.',
        actions: ['settle alice hub'],
      },
    ]);
  });
});
