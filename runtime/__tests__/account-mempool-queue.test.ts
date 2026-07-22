import { describe, expect, test } from 'bun:test';

import {
  queueAccountMempoolTx,
  reconcilePendingSwapFillRatios,
  recordPendingSwapFillRatio,
} from '../entity/consensus/account-mempool-queue';
import { prependUniqueMempoolTxs } from '../account/consensus/helpers';
import { LIMITS } from '../constants';
import type { AccountMachine, AccountTx, EntityState } from '../types';

const PAYMENT: Extract<AccountTx, { type: 'direct_payment' }> = {
  type: 'direct_payment',
  data: {
    tokenId: 1,
    amount: 100_000_000n,
    route: ['0xrecipient'],
    fromEntityId: '0xsender',
    toEntityId: '0xrecipient',
    description: 'same user-visible payment bytes',
  },
};

const accountWithPending = (tx: AccountTx): Pick<AccountMachine, 'mempool' | 'pendingFrame'> => ({
  mempool: [],
  pendingFrame: {
    height: 7,
    timestamp: 1,
    jHeight: 1,
    accountTxs: [structuredClone(tx)],
    prevFrameHash: '0xprev',
    accountStateRoot: '0xroot',
    stateHash: '0xstate',
    deltas: [],
  },
});

describe('account mempool multiplicity', () => {
  test('keeps a second authorized payment while identical bytes are pending', () => {
    const account = accountWithPending(PAYMENT);

    expect(queueAccountMempoolTx(account, structuredClone(PAYMENT))).toBe(true);
    expect(account.mempool).toEqual([PAYMENT]);
    expect(account.pendingFrame?.accountTxs).toEqual([PAYMENT]);
  });

  test('still deduplicates idempotent lifecycle transactions', () => {
    const lifecycle: AccountTx = {
      type: 'swap_resolve',
      data: { offerId: 'offer-1', fillRatio: 1, cancelRemainder: true },
    };
    const account = accountWithPending(lifecycle);

    expect(queueAccountMempoolTx(account, structuredClone(lifecycle))).toBe(false);
    expect(account.mempool).toEqual([]);
  });

  test('records one canonical swap dispute intent outside the pending Account frame', () => {
    const state = { pendingSwapFillRatios: new Map() } as unknown as EntityState;
    const fill = {
      type: 'swap_resolve',
      data: { offerId: 'offer-1', fillRatio: 32_768, cancelRemainder: false },
    } as AccountTx;

    recordPendingSwapFillRatio(state, 'peer', fill);
    expect(state.pendingSwapFillRatios?.get('peer:offer-1' as never)).toBe(32_768);
    expect(() => recordPendingSwapFillRatio(state, 'peer', {
      ...fill,
      data: { ...fill.data, fillRatio: 16_384 },
    } as AccountTx)).toThrow('SWAP_DISPUTE_FILL_RATIO_CONFLICT');
  });

  test('removes rejected fill evidence once no matching tx remains', () => {
    const fill = {
      type: 'swap_resolve',
      data: { offerId: 'offer-1', fillRatio: 32_768, cancelRemainder: false },
    } as AccountTx;
    const state = { pendingSwapFillRatios: new Map() } as unknown as EntityState;
    const account = { mempool: [fill] } as Pick<AccountMachine, 'mempool' | 'pendingFrame'>;

    recordPendingSwapFillRatio(state, 'peer', fill);
    reconcilePendingSwapFillRatios(state, 'peer', account);
    expect(state.pendingSwapFillRatios?.size).toBe(1);

    account.mempool = [];
    reconcilePendingSwapFillRatios(state, 'peer', account);
    expect(state.pendingSwapFillRatios?.size).toBe(0);
  });

  test('counts pending and queued transactions under one outstanding limit', () => {
    const account = accountWithPending(PAYMENT);
    account.mempool = Array.from(
      { length: LIMITS.ACCOUNT_MEMPOOL_SIZE - 1 },
      () => structuredClone(PAYMENT),
    );

    expect(() => queueAccountMempoolTx(account, structuredClone(PAYMENT)))
      .toThrow('ACCOUNT_MEMPOOL_LIMIT_EXCEEDED');
    expect(account.mempool).toHaveLength(LIMITS.ACCOUNT_MEMPOOL_SIZE - 1);
    expect(account.pendingFrame?.accountTxs).toHaveLength(1);
  });

  test('rollback restores identical direct payments with their full multiplicity', () => {
    const account = accountWithPending(PAYMENT) as AccountMachine;
    account.mempool = [structuredClone(PAYMENT)];

    expect(prependUniqueMempoolTxs(account, [structuredClone(PAYMENT)])).toBe(1);
    expect(account.mempool).toEqual([PAYMENT, PAYMENT]);
  });
});
