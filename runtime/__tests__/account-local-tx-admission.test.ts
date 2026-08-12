import { describe, expect, test } from 'bun:test';

import { admitLocalAccountTx } from '../account/input/local-tx-admission';
import { applyAccountInput } from '../account/consensus/index';
import { proposeAccountFrame } from '../account/consensus/proposal/propose';
import { createLocalAccountInput } from '../account/input';
import { prependUniqueMempoolTxs } from '../account/consensus/helpers';
import {
  canProcessAccountTxForDisputeStatus,
  freezeAccountForDispute,
  isDisputeStartedByLeft,
  returnPreparedAccountToActive,
} from '../account/consensus/dispute/policy';
import { LIMITS } from '../config/constants';
import type { AccountReplica, AccountTx } from '../types/account';
import { createEmptyEnv } from '../runtime';
import { createAccountConsensusContext } from '../entity/account-consensus-context';
import { makeAccount as makeCanonicalAccount } from './helpers/cross-j';

const accountContext = () =>
  createAccountConsensusContext(createEmptyEnv('account-local-tx-admission'));

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

const accountWithPending = (tx: AccountTx): AccountReplica => {
  const account = makeCanonicalAccount('0xsender', '0xrecipient', {
    chainId: 1,
    depositoryAddress: `0x${'11'.repeat(20)}`,
  });
  account.pendingFrame = {
    height: 7,
    timestamp: 1,
    jHeight: 1,
    accountTxs: [structuredClone(tx)],
    prevFrameHash: '0xprev',
    accountStateRoot: '0xroot',
    stateHash: '0xstate',
    deltas: [],
  };
  return account;
};

describe('account mempool multiplicity', () => {
  test('accepts only an exact bilateral dispute starter', () => {
    expect(isDisputeStartedByLeft('0x01', '0x01', '0x02')).toBe(true);
    expect(isDisputeStartedByLeft('0x02', '0x01', '0x02')).toBe(false);
    expect(() => isDisputeStartedByLeft('0x00', '0x01', '0x02'))
      .toThrow('DISPUTE_STARTER_NOT_A_PARTY');
  });

  test('routes local transactions through the canonical AccountInput boundary', async () => {
    const account = accountWithPending(PAYMENT);

    const input = createLocalAccountInput(account.state, '0xsender', [
      structuredClone(PAYMENT),
    ]);
    const result = await applyAccountInput(accountContext(), account, input, {
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
    const account = accountWithPending(fill);
    account.mempool = [
      {
        type: 'cross_pull_close',
        data: {
          pullId: 'pull-1', binary: '0x1234',
          proof: {
            orderId: 'order-1', routeHash: `0x${'11'.repeat(32)}`,
            sourcePullId: 'pull-1', targetPullId: 'pull-2', fillRatio: 1,
            cumulativeSourceAmount: 1n, cumulativeTargetAmount: 1n,
            binaryHash: `0x${'22'.repeat(32)}`, closeMode: 'partial_cancel_remainder',
          },
        },
      },
      structuredClone(PAYMENT),
    ];

    freezeAccountForDispute(account, true);

    expect(account.pendingFrame).toBeUndefined();
    expect(account.mempool.map(tx => tx.type)).toEqual(['swap_resolve', 'cross_pull_close']);
    expect(account.mempool[0]).toEqual(fill);
  });

  test('defers a pending J claim through preparation and drops it after permanent close', () => {
    const claim: AccountTx = {
      type: 'j_event_claim',
      data: {
        jHeight: 3,
        jBlockHash: `0x${'33'.repeat(32)}`,
        events: [],
      },
    };
    const account = accountWithPending(claim);
    account.status = 'dispute_preparing';

    freezeAccountForDispute(account, false);

    expect(account.pendingFrame).toBeUndefined();
    expect(account.mempool).toEqual([claim]);

    account.status = 'disputed';
    freezeAccountForDispute(account, false);

    expect(account.mempool).toEqual([]);
  });

  test('returning preparation to active reopens the deferred J claim lane', () => {
    const claim: AccountTx = {
      type: 'j_event_claim',
      data: {
        jHeight: 4,
        jBlockHash: `0x${'44'.repeat(32)}`,
        events: [],
      },
    };
    const account = accountWithPending(claim);
    account.status = 'dispute_preparing';
    account.disputePrepare = {
      startedAt: 1,
      readyAfter: 1,
      reason: 'cross-j-recovery',
    };

    returnPreparedAccountToActive(account);

    expect(account.status).toBe('active');
    expect(account.disputePrepare).toBeUndefined();
    expect(account.pendingFrame).toBeUndefined();
    expect(account.mempool).toEqual([claim]);
    expect(canProcessAccountTxForDisputeStatus(account.status)).toBe(true);
  });

  test('direct proposal cannot consume deferred work from a preparing Account', async () => {
    const claim: AccountTx = {
      type: 'j_event_claim',
      data: {
        jHeight: 5,
        jBlockHash: `0x${'55'.repeat(32)}`,
        events: [],
      },
    };
    const account = accountWithPending(PAYMENT);
    delete account.pendingFrame;
    account.status = 'dispute_preparing';
    account.mempool = [claim];
    const before = structuredClone(account);

    const result = await proposeAccountFrame(accountContext(), account, 1);

    expect(result.success).toBe(false);
    expect(result.error).toBe('ACCOUNT_PROPOSAL_STATUS_FROZEN:dispute_preparing');
    expect(account).toEqual(before);
  });

  test('preparation return rejects active and permanently disputed Accounts', () => {
    const active = accountWithPending(PAYMENT);
    expect(() => returnPreparedAccountToActive(active))
      .toThrow('ACCOUNT_DISPUTE_PREPARATION_RETURN_INVALID:active');
    active.status = 'disputed';
    expect(() => returnPreparedAccountToActive(active))
      .toThrow('ACCOUNT_DISPUTE_PREPARATION_RETURN_INVALID:disputed');
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

  test('rejects an oversized local batch without partially admitting it', async () => {
    const account = accountWithPending(PAYMENT);
    account.mempool = Array.from(
      { length: LIMITS.ACCOUNT_MEMPOOL_SIZE - 2 },
      () => structuredClone(PAYMENT),
    );
    const before = structuredClone(account.mempool);
    const input = createLocalAccountInput(account.state, '0xsender', [
      structuredClone(PAYMENT),
      structuredClone(PAYMENT),
    ]);

    await expect(applyAccountInput(accountContext(), account, input))
      .rejects.toThrow('ACCOUNT_MEMPOOL_LIMIT_EXCEEDED');
    expect(account.mempool).toEqual(before);
  });

  test('rejects a malformed local envelope before mempool mutation', async () => {
    const account = accountWithPending(PAYMENT);
    const input = {
      ...createLocalAccountInput(account.state, '0xsender', [structuredClone(PAYMENT)]),
      toEntityId: '0xthird-party',
    };

    const result = await applyAccountInput(accountContext(), account, input);
    expect(result.success).toBe(false);
    expect(result.error).toContain('ACCOUNT_INPUT_PARTY_MISMATCH');
    expect(account.mempool).toEqual([]);
  });

  test('rollback restores identical direct payments with their full multiplicity', () => {
    const account = accountWithPending(PAYMENT);
    account.mempool = [structuredClone(PAYMENT)];

    expect(prependUniqueMempoolTxs(account, [structuredClone(PAYMENT)])).toBe(1);
    expect(account.mempool).toEqual([PAYMENT, PAYMENT]);
  });
});
