import { expect, test } from 'bun:test';
import {
  hashRawHtlcPaymentTx,
  validatePreparedHtlcPayment,
} from '../../../entity/paybook/payment-admission';
import { handleHtlcPayment } from '../../../entity/tx/handlers/htlc/payment';
import type { EntityCandidateEffect } from '../../../entity/types';
import type { EntityRuntimeContext } from '../../../entity/runtime-context';
import type { EntityTx } from '../../../types/entity-tx';
import { applyBookIntentProgram, createBookIntentProgram } from '../../../entity/books/book-intents';

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
    paybook: { entries: new Map(), feesEarned: 0n },
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
    timelock: 1_000n,
    revealBeforeHeight: 10,
    nextHopEntityId: nextHop,
    envelope: { version: 'xln:htlc-opaque:aes-gcm' as const, ciphertext: 'A'.repeat(64) },
  };
  const context = { htlc: { version: 1 as const, entries: [], originated: [prepared] } } as any;

  expect(() => validatePreparedHtlcPayment(state, tx, context))
    .toThrow(`HTLC_PAYMENT_OUTBOUND_CAPACITY_INSUFFICIENT:${txHash}`);
  expect(delta).toMatchObject({ collateral: 0n, leftHold: 0n, rightHold: 0n });

  delta.leftCreditLimit = 1n;
  expect(validatePreparedHtlcPayment(state, tx, context)).toBe(prepared);

  const paymentCountBeforeFreeze = state.paybook.entries.size;
  state.accounts.get(nextHop).status = 'disputed';
  expect(() => validatePreparedHtlcPayment(state, tx, context))
    .toThrow(`HTLC_PAYMENT_OUTBOUND_ACCOUNT_UNAVAILABLE:${txHash}`);
  const effects: EntityCandidateEffect[] = [];
  const rejectedProgram = createBookIntentProgram();
  await expect(handleHtlcPayment(
    state,
    tx,
    {} as EntityRuntimeContext,
    effects,
    false,
    context,
    rejectedProgram.openSlot(),
  ))
    .rejects.toThrow(`HTLC_PAYMENT_OUTBOUND_ACCOUNT_UNAVAILABLE:${txHash}`);
  expect(state.paybook.entries.size).toBe(paymentCountBeforeFreeze);
  expect(effects).toEqual([]);
  expect(delta).toMatchObject({ collateral: 0n, leftHold: 0n, rightHold: 0n });
  state.accounts.get(nextHop).status = 'active';

  const program = createBookIntentProgram();
  const result = await handleHtlcPayment(
    state,
    tx,
    { quietRuntimeLogs: true } as EntityRuntimeContext,
    effects,
    true,
    context,
    program.openSlot(),
  );
  expect(state.paybook.entries.size).toBe(0);
  expect(program.slots()).toMatchObject([{ position: 0, intents: [{
    kind: 'paybookSet',
    hashlock: prepared.hashlock,
  }] }]);
  expect(result.accountTxs).toEqual([{ accountId: nextHop, tx: {
    type: 'htlc_lock',
    data: {
      lockId: prepared.hashlock,
      hashlock: prepared.hashlock,
      timelock: prepared.timelock,
      revealBeforeHeight: prepared.revealBeforeHeight,
      amount: prepared.senderLockAmount,
      tokenId: prepared.tokenId,
      deliveryMode: prepared.deliveryMode,
      envelope: prepared.envelope,
    },
  } }]);
  await expect(handleHtlcPayment(
    state,
    tx,
    { quietRuntimeLogs: true } as EntityRuntimeContext,
    [],
    true,
    context,
    program.openSlot(),
  )).rejects.toThrow(`HTLC_PAYMENT_HASHLOCK_ALREADY_ACTIVE:${prepared.hashlock}`);
  expect(program.slots().map(slot => [slot.position, slot.intents.length])).toEqual([
    [0, 1],
    [1, 0],
  ]);
  applyBookIntentProgram(state, program);
  expect(state.paybook.entries.get(prepared.hashlock)).toEqual({
    hashlock: prepared.hashlock,
    tokenId: prepared.tokenId,
    amount: prepared.recipientAmount,
    startedAtMs: prepared.startedAtMs,
    originated: true,
    outboundEntity: prepared.nextHopEntityId,
    createdTimestamp: state.timestamp,
  });

  expect(() => validatePreparedHtlcPayment(state, tx, context))
    .toThrow(`HTLC_PAYMENT_HASHLOCK_ALREADY_ACTIVE:${prepared.hashlock}`);
});
