import { describe, expect, test } from 'bun:test';
import type { PaybookEntry } from '../../../../entity/types';
import {
  isDisputeReadyPayment,
  isFinalRecipientPayment,
  isForwardingPayment,
  isSecretAckPendingPayment,
} from '../../../../entity/paybook/views';

const entry = (): PaybookEntry => ({
  hashlock: `0x${'11'.repeat(32)}`,
  createdTimestamp: 1,
});

describe('Paybook views', () => {
  test('one hashlock-keyed entry distinguishes inbound, forwarding and final payment state', () => {
    const payment = { ...entry(), inboundEntity: 'alice' };
    expect(isForwardingPayment(payment)).toBe(false);
    expect(isFinalRecipientPayment(payment)).toBe(true);
    Object.assign(payment, { outboundEntity: 'bob' });
    expect(isForwardingPayment(payment)).toBe(true);
    expect(isFinalRecipientPayment(payment)).toBe(false);
  });

  test('secret ACK deadline is read from the same Paybook entry', () => {
    const payment: PaybookEntry = {
      ...entry(),
      inboundEntity: 'alice',
      secret: `0x${'22'.repeat(32)}`,
      secretAckPending: true,
      secretAckStartedAt: 100,
      secretAckDeadlineAt: 150,
    };
    expect(isSecretAckPendingPayment(payment)).toBe(true);
    expect(isDisputeReadyPayment(payment, 149)).toBe(false);
    expect(isDisputeReadyPayment(payment, 150)).toBe(true);
  });
});
