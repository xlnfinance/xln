import { describe, expect, test } from 'bun:test';

import {
  choosePreferredMoveAssetSymbol,
  computeMoveSourceAvailableBalanceForEndpoint,
  getMoveMaxAmountForEndpoint,
  getPreferredMoveSourceAccountId,
} from '../../frontend/src/lib/components/Entity/move-balance';

const reserveBalance = (tokenId: number) => tokenId === 1 ? 100n : 0n;
const draftReserveDelta = (tokenId: number) => tokenId === 1 ? 25n : 0n;
const outgoingDebt = (tokenId: number) => tokenId === 1 ? 40n : 0n;
const accountSpendable = (sourceAccountId: string, tokenId: number) =>
  sourceAccountId === 'hub-a' && tokenId === 1 ? 70n
    : sourceAccountId === 'hub-b' && tokenId === 1 ? 120n
      : 0n;

describe('move balance helpers', () => {
  test('computes max amount per source endpoint', () => {
    expect(getMoveMaxAmountForEndpoint({
      from: 'external',
      reserveToken: { tokenId: 1 },
      externalToken: { balance: 50n },
      sourceAccountId: 'hub-a',
      reserveBalance,
      draftReserveDelta,
      outgoingDebt,
      accountSpendable,
    })).toBe(50n);
    expect(getMoveMaxAmountForEndpoint({
      from: 'reserve',
      reserveToken: { tokenId: 1 },
      externalToken: null,
      sourceAccountId: 'hub-a',
      reserveBalance,
      draftReserveDelta,
      outgoingDebt,
      accountSpendable,
    })).toBe(85n);
    expect(getMoveMaxAmountForEndpoint({
      from: 'account',
      reserveToken: { tokenId: 1 },
      externalToken: null,
      sourceAccountId: 'hub-b',
      reserveBalance,
      draftReserveDelta,
      outgoingDebt,
      accountSpendable,
    })).toBe(120n);
  });

  test('chooses preferred source account by requested amount then nonzero balance', () => {
    expect(getPreferredMoveSourceAccountId({
      current: 'hub-a',
      workspaceAccountIds: ['hub-a', 'hub-b'],
      tokenId: 1,
      requestedAmount: 60n,
      accountSpendable,
    })).toBe('hub-a');
    expect(getPreferredMoveSourceAccountId({
      current: 'hub-a',
      workspaceAccountIds: ['hub-a', 'hub-b'],
      tokenId: 1,
      requestedAmount: 90n,
      accountSpendable,
    })).toBe('hub-b');
    expect(getPreferredMoveSourceAccountId({
      current: 'unknown',
      workspaceAccountIds: ['hub-a', 'hub-b'],
      tokenId: 1,
      requestedAmount: 0n,
      accountSpendable,
    })).toBe('hub-a');
  });

  test('computes current source available balance with row fallback', () => {
    expect(computeMoveSourceAvailableBalanceForEndpoint({
      from: 'reserve',
      row: { externalBalance: 1n, reserveBalance: 80n, accountBalance: 2n },
      liveTransferToken: { tokenId: 1 },
      externalToken: null,
      reserveBalance,
      draftReserveDelta,
      outgoingDebt,
      sourceAccountId: 'hub-a',
      accountSpendable,
    })).toBe(65n);
    expect(computeMoveSourceAvailableBalanceForEndpoint({
      from: 'account',
      row: { externalBalance: 1n, reserveBalance: 80n, accountBalance: 2n },
      liveTransferToken: { tokenId: 1 },
      externalToken: null,
      reserveBalance,
      draftReserveDelta,
      outgoingDebt,
      sourceAccountId: 'hub-b',
      accountSpendable,
    })).toBe(120n);
  });

  test('prefers USDC then first token with positive balance', () => {
    expect(choosePreferredMoveAssetSymbol({
      candidates: [{ symbol: 'ETH' }, { symbol: 'USDC' }],
      availableBalance: () => 0n,
    })).toBe('USDC');
    expect(choosePreferredMoveAssetSymbol({
      candidates: [{ symbol: 'ETH' }, { symbol: 'DAI' }],
      availableBalance: (symbol) => symbol === 'DAI' ? 1n : 0n,
    })).toBe('DAI');
  });
});
