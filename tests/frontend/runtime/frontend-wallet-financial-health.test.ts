import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { formatTokenAmount } from '../../../core/account/financial-utils';
import { deriveDelta, getTokenInfo, isLeftEntity } from '../../../core/account/utils';
import {
  decodeWalletFinancialHealthProjection,
} from '../../../frontend/apps/wallet/src/wallet-financial-health-model';
import type { WalletPortfolioMath } from '../../../frontend/apps/wallet/src/wallet-portfolio-model';

const alice = `0x${'11'.repeat(32)}`;
const hub = `0x${'22'.repeat(32)}`;
const merchant = `0x${'33'.repeat(32)}`;
const depository = `0x${'44'.repeat(20)}`;

const math: WalletPortfolioMath = {
  deriveDelta,
  formatTokenAmount,
  getTokenInfo,
  isLeftEntity,
};

const debt = (direction: 'out' | 'in') => ({
  debtId: `debt-${direction}`,
  tokenId: 1,
  debtor: direction === 'out' ? alice : merchant,
  creditor: direction === 'out' ? hub : alice,
  counterparty: direction === 'out' ? hub : merchant,
  direction,
  createdAmount: direction === 'out' ? 150_000_000n : 80_000_000n,
  paidAmount: direction === 'out' ? 25_000_000n : 0n,
  remainingAmount: direction === 'out' ? 125_000_000n : 80_000_000n,
  createdDebtIndex: 1,
  currentDebtIndex: 1,
  status: 'open',
  createdAtBlock: 40,
  createdTxHash: '0xcreated',
  lastUpdatedBlock: direction === 'out' ? 48 : 47,
  lastUpdatedTxHash: '0xupdated',
  lastEventType: 'DebtCreated',
});

const account = (status: 'active' | 'dispute_preparing' | 'disputed') => ({
  status,
  currentHeight: 9,
  currentFrame: { height: 9 },
  state: {
    leftEntity: alice,
    rightEntity: hub,
    disputeConfig: { leftResponseSeconds: 3600, rightResponseSeconds: 7200 },
  },
  currentDisputeProofHanko: '0xlocal',
  counterpartyDisputeProofHanko: status === 'disputed' ? '0xpeer' : undefined,
});

const payload = () => ({
  frame: {
    height: 12,
    entities: [
      { entityId: alice, label: 'Alice', height: 12 },
      { entityId: hub, label: 'Hub', height: 12, isHub: true },
      { entityId: merchant, label: 'Merchant', height: 12 },
    ],
    activeEntityId: alice,
    activeEntity: {
      core: {
        entityId: alice,
        outDebtsByToken: new Map([[1, new Map([['debt-out', debt('out')]])]]),
        inDebtsByToken: new Map([[1, new Map([['debt-in', debt('in')]])]]),
      },
      accounts: {
        items: [account('disputed'), account('active')],
        pageIndex: 0,
        pageCount: 2,
        totalItems: 102,
      },
    },
  },
  solvency: {
    ok: true,
    height: 12,
    entityCount: 3,
    accountViews: 4,
    assets: [{
      stackId: `31337:${depository}`,
      chainId: 31337,
      depositoryAddress: depository,
      tokenId: 1,
      reserves: 300_000_000n,
      confirmedCollateral: 100_000_000n,
      internalValue: 400_000_000n,
      expectedInternalValue: null,
      delta: null,
      isValid: null,
    }],
    isValid: null,
  },
  activity: {
    ok: true,
    latestHeight: 12,
    nextBeforeHeight: 8,
    events: [{
      id: 'r12:runtime_input:0:directPayment',
      height: 12,
      timestamp: 1_800_000_000_000,
      kind: 'offchain',
      type: 'payment',
      source: 'runtime_input',
      direction: 'out',
      title: 'Payment sent',
      subtitle: '25 token 1 to Hub',
      status: 'committed',
      entityId: alice,
      counterpartyId: hub,
      tokenId: 1,
      amount: '25000000',
      rawType: 'direct_payment',
    }],
  },
  historyPage: 0,
});

describe('React wallet financial health projection', () => {
  test('decodes debt, dispute gates, unchecked solvency, and committed history', () => {
    const projection = decodeWalletFinancialHealthProjection(payload(), math);
    expect(projection).toMatchObject({
      height: 12,
      activeEntityId: alice,
      activeEntityLabel: 'Alice',
      solvencyStatus: 'unchecked',
      solvencyEntityCount: 3,
      solvencyAccountViews: 4,
      accountsPageCount: 2,
      accountsTotal: 102,
      historyNextBeforeHeight: 8,
    });
    expect(projection.debtGroups.map((group) => [group.direction, group.outstandingLabel])).toEqual([
      ['out', '125.0 USDC'],
      ['in', '80.0 USDC'],
    ]);
    expect(projection.debtGroups[0]?.entries[0]).toMatchObject({
      counterpartyId: hub,
      counterpartyLabel: 'Hub',
      remainingLabel: '125.0 USDC',
    });
    expect(projection.disputes).toEqual([expect.objectContaining({
      counterpartyId: hub,
      phase: 'disputed',
      responseWindowLabel: '3600s left · 7200s right',
      proofStatus: 'both-hankos',
    })]);
    expect(projection.solvencyAssets[0]).toMatchObject({
      symbol: 'USDC',
      internalValueLabel: '400.0 USDC',
      expectedValueLabel: 'Not supplied',
      deltaLabel: 'Not checked',
      status: 'unchecked',
    });
    expect(projection.history[0]).toMatchObject({
      title: 'Payment sent',
      amountLabel: '25.0 USDC',
      counterpartyId: hub,
    });
  });

  test('distinguishes verified balance from a conservation mismatch', () => {
    const balanced = payload();
    const asset = (balanced.solvency as { assets: Array<Record<string, unknown>> }).assets[0]!;
    asset['expectedInternalValue'] = 400_000_000n;
    asset['delta'] = 0n;
    asset['isValid'] = true;
    (balanced.solvency as Record<string, unknown>)['isValid'] = true;
    expect(decodeWalletFinancialHealthProjection(balanced, math).solvencyStatus).toBe('balanced');

    asset['expectedInternalValue'] = 500_000_000n;
    asset['delta'] = -100_000_000n;
    asset['isValid'] = false;
    (balanced.solvency as Record<string, unknown>)['isValid'] = false;
    const mismatched = decodeWalletFinancialHealthProjection(balanced, math);
    expect(mismatched.solvencyStatus).toBe('mismatch');
    expect(mismatched.solvencyAssets[0]?.deltaLabel).toBe('-100.0 USDC');
  });

  test('preserves an empty committed Runtime without manufacturing data', () => {
    const empty = {
      ...payload(),
      frame: { height: 0, entities: [], activeEntityId: null, activeEntity: null },
      solvency: {
        ok: true, height: 0, entityCount: 0, accountViews: 0, assets: [], isValid: null,
      },
      activity: null,
    };
    expect(decodeWalletFinancialHealthProjection(empty, math)).toMatchObject({
      height: 0,
      activeEntityId: '',
      debtGroups: [],
      disputes: [],
      history: [],
      solvencyStatus: 'unchecked',
    });
  });

  test('rejects inconsistent heights, debt arithmetic, and solvency claims', () => {
    const heightMismatch = payload();
    (heightMismatch.solvency as Record<string, unknown>)['height'] = 11;
    expect(() => decodeWalletFinancialHealthProjection(heightMismatch, math))
      .toThrow('WALLET_HEALTH_HEIGHT_MISMATCH');

    const debtMismatch = payload();
    const core = ((debtMismatch.frame as { activeEntity: { core: Record<string, unknown> } }).activeEntity.core);
    const entry = ((core['outDebtsByToken'] as Map<number, Map<string, Record<string, unknown>>>).get(1)?.get('debt-out'))!;
    entry['remainingAmount'] = 124_000_000n;
    expect(() => decodeWalletFinancialHealthProjection(debtMismatch, math))
      .toThrow('WALLET_HEALTH_DEBT_AMOUNT_MISMATCH');

    const falseBalance = payload();
    const asset = (falseBalance.solvency as { assets: Array<Record<string, unknown>> }).assets[0]!;
    asset['expectedInternalValue'] = 500_000_000n;
    asset['delta'] = 0n;
    asset['isValid'] = true;
    expect(() => decodeWalletFinancialHealthProjection(falseBalance, math))
      .toThrow('WALLET_HEALTH_SOLVENCY_RESULT_MISMATCH');

    const aggregateMismatch = payload();
    const aggregateAsset = (aggregateMismatch.solvency as { assets: Array<Record<string, unknown>> }).assets[0]!;
    aggregateAsset['expectedInternalValue'] = 400_000_000n;
    aggregateAsset['delta'] = 0n;
    aggregateAsset['isValid'] = true;
    expect(() => decodeWalletFinancialHealthProjection(aggregateMismatch, math))
      .toThrow('WALLET_HEALTH_SOLVENCY_OVERALL_MISMATCH');
  });

  test('uses a height-pinned read boundary and cleans every external subscription', () => {
    const source = readFileSync('frontend/apps/wallet/src/wallet-financial-health-source.ts', 'utf8');
    const boundary = readFileSync('frontend/apps/wallet/src/wallet-runtime-read-boundary.ts', 'utf8');
    const view = readFileSync('frontend/apps/wallet/src/wallet-financial-health.tsx', 'utf8');
    expect(source.indexOf('readSolvencySummary()')).toBeLessThan(source.indexOf('readViewFrame({'));
    expect(source).toContain('atHeight: height');
    expect(source).toContain('beforeHeight: this.historyCursors[this.historyPage] ?? height + 1');
    expect(source).toContain('RuntimeQueryObserver');
    expect(source).toContain('this.observer?.destroy()');
    expect(source).toContain('this.adapter?.disconnect()');
    expect(source).toContain('this.started = false');
    expect(boundary).toContain('adapter.disconnect()');
    expect(view).toContain('useSyncExternalStore');
    expect(view).toContain('Unchecked solvency is never presented as balanced');
    expect(source).not.toContain('.send(');
    expect(source).not.toContain('setInterval');
    expect(source).not.toContain('Math.random');
  });
});
