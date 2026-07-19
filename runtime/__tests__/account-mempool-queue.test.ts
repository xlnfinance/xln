import { describe, expect, test } from 'bun:test';

import { queueAccountMempoolTx } from '../entity/consensus/account-mempool-queue';
import { prependUniqueMempoolTxs } from '../account/consensus/helpers';
import { LIMITS } from '../constants';
import type { AccountMachine, AccountTx } from '../types';

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
