import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { formatTokenAmount } from '../../../core/account/financial-utils';
import { deriveDelta, getTokenInfo, isLeftEntity } from '../../../core/account/utils';
import {
  decodeWalletPortfolioProjection,
  type WalletPortfolioDelta,
  type WalletPortfolioMath,
} from '../../../frontend/apps/wallet/src/wallet-portfolio-model';

const leftEntity = `0x${'11'.repeat(32)}`;
const rightEntity = `0x${'22'.repeat(32)}`;

const math: WalletPortfolioMath = {
  deriveDelta,
  formatTokenAmount,
  getTokenInfo,
  isLeftEntity,
};

const delta: WalletPortfolioDelta = {
  tokenId: 1,
  collateral: 100_000_000n,
  ondelta: 20_000_000n,
  offdelta: 0n,
  leftCreditLimit: 30_000_000n,
  rightCreditLimit: 40_000_000n,
  leftAllowance: 0n,
  rightAllowance: 0n,
  leftHold: 0n,
  rightHold: 0n,
};

const portfolioFrame = (activeEntityId = leftEntity) => ({
  height: 7,
  entities: [
    { entityId: leftEntity, label: 'Alice', height: 7 },
    { entityId: rightEntity, label: 'Hub', height: 7, isHub: true },
  ],
  activeEntityId,
  activeEntity: {
    core: {
      entityId: activeEntityId,
      reserves: new Map([[1, activeEntityId === leftEntity ? 200_000_000n : 50_000_000n]]),
    },
    accounts: {
      items: [{
        state: {
          leftEntity,
          rightEntity,
          deltas: new Map([[1, delta]]),
        },
      }],
      pageIndex: 0,
      pageCount: 1,
      totalItems: 1,
    },
  },
});

describe('React wallet assets and accounts projection', () => {
  test('derives left-side assets and Account capacities through canonical math', () => {
    const projection = decodeWalletPortfolioProjection(portfolioFrame(), math);
    expect(projection).toMatchObject({
      height: 7,
      activeEntityId: leftEntity,
      activeEntityLabel: 'Alice',
      accountsPage: 0,
      accountsPageCount: 1,
      accountsTotal: 1,
    });
    expect(projection.assets[0]).toMatchObject({
      tokenId: 1,
      symbol: 'USDC',
      reserve: 200_000_000n,
      accountSpendable: 50_000_000n,
      accountInboundCapacity: 120_000_000n,
      accountCount: 1,
    });
    expect(projection.accounts[0]).toMatchObject({
      counterpartyId: rightEntity,
      counterpartyLabel: 'Hub',
    });
    expect(projection.accounts[0]?.positions[0]).toMatchObject({
      spendable: 50_000_000n,
      inboundCapacity: 120_000_000n,
      ownCreditLimit: 30_000_000n,
      peerCreditLimit: 40_000_000n,
    });
    expect(projection.assets[0]?.reserveLabel).toContain('USDC');
  });

  test('flips the exact bilateral perspective for the right Entity', () => {
    const projection = decodeWalletPortfolioProjection(portfolioFrame(rightEntity), math);
    expect(projection.accounts[0]?.counterpartyId).toBe(leftEntity);
    expect(projection.accounts[0]?.positions[0]).toMatchObject({
      spendable: 120_000_000n,
      inboundCapacity: 50_000_000n,
      ownCreditLimit: 40_000_000n,
      peerCreditLimit: 30_000_000n,
    });
  });

  test('preserves the canonical empty Runtime projection', () => {
    expect(decodeWalletPortfolioProjection({
      height: 0,
      entities: [],
      activeEntityId: null,
      activeEntity: null,
    }, math)).toEqual({
      height: 0,
      entities: [],
      activeEntityId: '',
      activeEntityLabel: '',
      assets: [],
      accounts: [],
      accountsPage: 0,
      accountsPageCount: 0,
      accountsTotal: 0,
    });
  });

  test('rejects incomplete deltas and mismatched Account ownership', () => {
    const missingHold = portfolioFrame();
    const account = missingHold.activeEntity.accounts.items[0]!;
    account.state.deltas = new Map([[1, { ...delta, leftHold: undefined }]]);
    expect(() => decodeWalletPortfolioProjection(missingHold, math))
      .toThrow('WALLET_PORTFOLIO_DELTA_LEFT_HOLD_INVALID');

    const mismatched = portfolioFrame();
    mismatched.activeEntity.accounts.items[0]!.state.leftEntity = `0x${'33'.repeat(32)}`;
    expect(() => decodeWalletPortfolioProjection(mismatched, math))
      .toThrow('WALLET_PORTFOLIO_ACCOUNT_PERSPECTIVE_MISMATCH');
  });

  test('uses the shared query observer and tears down the real adapter boundary', () => {
    const source = readFileSync('frontend/apps/wallet/src/wallet-portfolio-source.ts', 'utf8');
    const boundary = readFileSync('frontend/apps/wallet/src/wallet-runtime-read-boundary.ts', 'utf8');
    const view = readFileSync('frontend/apps/wallet/src/wallet-portfolio.tsx', 'utf8');
    expect(source).toContain('createWalletRuntimeQueryClient');
    expect(source).toContain('RuntimeQueryObserver');
    expect(boundary).toContain('RuntimeQueryClient');
    expect(boundary).toContain("import('../../../../core/api/runtime-adapter/remote.ts')");
    expect(boundary.indexOf("import('../../../../core/support/process/runtime-process.ts')"))
      .toBeLessThan(boundary.indexOf("import('../../../../core/api/runtime-adapter/remote.ts')"));
    expect(boundary).toContain('catch (error: unknown)');
    expect(boundary).toContain('adapter.disconnect()');
    expect(source).toContain('this.observer?.destroy()');
    expect(source).toContain('this.adapter?.disconnect()');
    expect(source).toContain('this.started = false');
    expect(source).toContain("snapshot.status === 'error' && this.adapter?.status === 'error'");
    expect(view).toContain('useSyncExternalStore');
    expect(view).toContain('No optimistic or sample values.');
    expect(source).not.toContain('setInterval');
    expect(source).not.toContain('Math.random');
    expect(view).not.toContain('sampleBalance');
  });
});
