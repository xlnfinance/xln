import { describe, expect, test } from 'bun:test';

import { admitLocalAccountTx } from '../account/local-tx-admission';
import { applyAccountInput } from '../account/consensus/index';
import { createLocalAccountInput } from '../account/input';
import { prependUniqueMempoolTxs } from '../account/consensus/helpers';
import { freezeAccountForDispute } from '../account/consensus/dispute-policy';
import { LIMITS } from '../constants';
import type { AccountState, AccountTx, RuntimeState } from '../types';

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

const accountWithPending = (tx: AccountTx): Pick<AccountState, 'mempool' | 'pendingFrame'> => ({
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
  test('routes local transactions through the canonical AccountInput boundary', async () => {
    const account = accountWithPending(PAYMENT) as AccountState;
    account.leftEntity = '0xsender';
    account.rightEntity = '0xrecipient';
    account.domain = { chainId: 1, depositoryAddress: '0xdepository' };
    account.watchSeed = `0x${'11'.repeat(32)}`;

    const input = createLocalAccountInput(account, '0xsender', [
      structuredClone(PAYMENT),
    ]);
    const result = await applyAccountInput({} as RuntimeState, account, input, {
      entityTimestamp: 1,
      finalizedJHeight: 0,
      owningEntityIsHub: false,
    });

    expect(result).toMatchObject({ success: true, admittedAccountTxCount: 1 });
    expect(account.mempool).toEqual([PAYMENT]);
  });

  test('keeps a second authorized payment while identical bytes are pending', () => {
    const account = accountWithPending(PAYMENT);

    expect(admitLocalAccountTx(account, structuredClone(PAYMENT))).toBe(true);
    expect(account.mempool).toEqual([PAYMENT]);
    expect(account.pendingFrame?.accountTxs).toEqual([PAYMENT]);
  });

  test('still deduplicates idempotent lifecycle transactions', () => {
    const lifecycle: AccountTx = {
      type: 'swap_resolve',
      data: { offerId: 'offer-1', fillRatio: 1, cancelRemainder: true },
    };
    const account = accountWithPending(lifecycle);

    expect(admitLocalAccountTx(account, structuredClone(lifecycle))).toBe(false);
    expect(account.mempool).toEqual([]);
  });

  test('moves pending unilateral evidence back to mempool before dispute freeze', () => {
    const fill: AccountTx = {
      type: 'swap_resolve',
      data: { offerId: 'offer-1', fillRatio: 32_768, cancelRemainder: false },
    };
    const account = accountWithPending(fill) as AccountState;
    account.mempool = [
      { type: 'pull_resolve', data: { pullId: 'pull-1', binary: '0x1234' } },
      structuredClone(PAYMENT),
    ];

    freezeAccountForDispute(account, true);

    expect(account.pendingFrame).toBeUndefined();
    expect(account.mempool.map(tx => tx.type)).toEqual(['swap_resolve', 'pull_resolve']);
    expect(account.mempool[0]).toEqual(fill);
  });

  test('counts pending and queued transactions under one outstanding limit', () => {
    const account = accountWithPending(PAYMENT);
    account.mempool = Array.from(
      { length: LIMITS.ACCOUNT_MEMPOOL_SIZE - 1 },
      () => structuredClone(PAYMENT),
    );

    expect(() => admitLocalAccountTx(account, structuredClone(PAYMENT)))
      .toThrow('ACCOUNT_MEMPOOL_LIMIT_EXCEEDED');
    expect(account.mempool).toHaveLength(LIMITS.ACCOUNT_MEMPOOL_SIZE - 1);
    expect(account.pendingFrame?.accountTxs).toHaveLength(1);
  });

  test('rollback restores identical direct payments with their full multiplicity', () => {
    const account = accountWithPending(PAYMENT) as AccountState;
    account.mempool = [structuredClone(PAYMENT)];

    expect(prependUniqueMempoolTxs(account, [structuredClone(PAYMENT)])).toBe(1);
    expect(account.mempool).toEqual([PAYMENT, PAYMENT]);
  });
});
