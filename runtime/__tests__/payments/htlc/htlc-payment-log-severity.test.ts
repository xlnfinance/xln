import { expect, test } from 'bun:test';
import {
  hashRawHtlcPaymentTx,
  validatePreparedHtlcPayment,
} from '../../../entity/htlc/payment-admission';
import { handleHtlcPayment } from '../../../entity/tx/handlers/htlc/payment';
import type { EntityCandidateEffect } from '../../../entity/types';
import type { EntityRuntimeContext } from '../../../entity/runtime-context';
import type { EntityTx } from '../../../types/entity-tx';

const id = (byte: string): string => `0x${byte.repeat(64)}`;

test('HTLC admission rejects atomically instead of committing a fail-soft no-op', async () => {
  const source = id('1');
  const nextHop = id('2');
  const tx = {
    type: 'htlcPayment',
    data: {
      targetEntityId: nextHop,
      tokenId: 1,
      amount: 1n,
      maxSenderDebit: 1n,
      route: [source, nextHop],
      deliveryMode: 'instant',
    },
  } as const satisfies EntityTx;
  const txHash = hashRawHtlcPaymentTx(tx);
  const delta = {
    tokenId: 1,
    collateral: 0n,
    ondelta: 0n,
    offdelta: 0n,
    leftCreditLimit: 0n,
    rightCreditLimit: 0n,
    leftAllowance: 0n,
    rightAllowance: 0n,
    leftHold: 0n,
    rightHold: 0n,
  };
  const state = {
    entityId: source,
    timestamp: 100,
    htlcRoutes: new Map(),
    accounts: new Map([[nextHop, {
      status: 'active',
      state: {
        leftEntity: source,
        rightEntity: nextHop,
        domain: { chainId: 31337, depositoryAddress: `0x${'11'.repeat(20)}` },
        deltas: new Map([[1, delta]]),
      },
    }]]),
  } as any;
  const prepared = {
    txHash,
    targetEntityId: nextHop,
    tokenId: 1,
    recipientAmount: 1n,
    route: [source, nextHop],
    description: '',
    deliveryMode: 'instant' as const,
    startedAtMs: 100,
    hashlock: id('3'),
    senderLockAmount: 1n,
    maxSenderDebit: 1n,
    totalFee: 0n,
    lockId: id('4'),
    timelock: 1_000n,
    revealBeforeHeight: 10,
    nextHopEntityId: nextHop,
    envelope: { version: 'xln:htlc-opaque:v1' as const, ciphertext: 'A'.repeat(64) },
  };
  const context = { htlc: { version: 1 as const, entries: [], originated: [prepared] } } as any;

  expect(() => validatePreparedHtlcPayment(state, tx, context))
    .toThrow(`HTLC_PAYMENT_OUTBOUND_CAPACITY_INSUFFICIENT:${txHash}`);
  expect(delta).toMatchObject({ collateral: 0n, leftHold: 0n, rightHold: 0n });

  delta.leftCreditLimit = 1n;
  expect(validatePreparedHtlcPayment(state, tx, context)).toBe(prepared);

  const routeCountBeforeFreeze = state.htlcRoutes.size;
  state.accounts.get(nextHop).status = 'disputed';
  expect(() => validatePreparedHtlcPayment(state, tx, context))
    .toThrow(`HTLC_PAYMENT_OUTBOUND_ACCOUNT_UNAVAILABLE:${txHash}`);
  const effects: EntityCandidateEffect[] = [];
  await expect(handleHtlcPayment(state, tx, {} as EntityRuntimeContext, effects, false, context))
    .rejects.toThrow(`HTLC_PAYMENT_OUTBOUND_ACCOUNT_UNAVAILABLE:${txHash}`);
  expect(state.htlcRoutes.size).toBe(routeCountBeforeFreeze);
  expect(state.lockBook?.size ?? 0).toBe(0);
  expect(effects).toEqual([]);
  expect(delta).toMatchObject({ collateral: 0n, leftHold: 0n, rightHold: 0n });
  state.accounts.get(nextHop).status = 'active';

  state.htlcRoutes.set(prepared.hashlock, { lockId: prepared.lockId });
  expect(() => validatePreparedHtlcPayment(state, tx, context))
    .toThrow(`HTLC_PAYMENT_HASHLOCK_ALREADY_ACTIVE:${prepared.hashlock}`);
});
