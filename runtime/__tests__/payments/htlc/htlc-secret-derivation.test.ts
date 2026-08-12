import { expect, test } from 'bun:test';
import { deriveHtlcPaymentSecret } from '../../../entity/htlc/payment-admission';

const id = (byte: string): string => `0x${byte.repeat(64)}`;
const privateKey = `0x${'11'.repeat(32)}`;
const context = {
  sourceEntityId: id('2'), parentFrameHash: id('3'), height: 7, txIndex: 1, txHash: id('4'),
};

test('payment preimage derivation is stable for retry and separated by every public binding', () => {
  const first = deriveHtlcPaymentSecret(privateKey, context);
  expect(deriveHtlcPaymentSecret(privateKey, context)).toBe(first);
  expect(deriveHtlcPaymentSecret(privateKey, { ...context, sourceEntityId: id('5') })).not.toBe(first);
  expect(deriveHtlcPaymentSecret(privateKey, { ...context, parentFrameHash: id('6') })).not.toBe(first);
  expect(deriveHtlcPaymentSecret(privateKey, { ...context, height: 8 })).not.toBe(first);
  expect(deriveHtlcPaymentSecret(privateKey, { ...context, txIndex: 2 })).not.toBe(first);
  expect(deriveHtlcPaymentSecret(privateKey, { ...context, txHash: id('7') })).not.toBe(first);
  expect(JSON.stringify(context)).not.toContain(privateKey.slice(2));
});
