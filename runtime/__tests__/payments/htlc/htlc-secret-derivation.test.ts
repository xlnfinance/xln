import { expect, test } from 'bun:test';
import { generateHtlcPaymentPreimage } from '../../../entity/htlc/payment-admission';
import {
  getDeterministicHtlcTestSecret,
  withDeterministicHtlcTestSecret,
} from '../../../protocol/htlc/test-secret-capability';
import { hashHtlcSecret } from '../../../protocol/htlc/utils';
import { safeStringify } from '../../../protocol/serialization';
import type { EntityTx } from '../../../types/entity-tx';

const payment = (): Extract<EntityTx, { type: 'htlcPayment' }> => ({
  type: 'htlcPayment',
  data: {
    targetEntityId: `0x${'22'.repeat(32)}`,
    tokenId: 1,
    amount: 1n,
    maxSenderDebit: 1n,
    route: [],
    deliveryMode: 'instant',
  },
});

test('proposer creates an unpredictable preimage outside consensus bytes', () => {
  const generated = Array.from({ length: 16 }, generateHtlcPaymentPreimage);
  expect(generated.every(secret => /^0x[0-9a-f]{64}$/.test(secret))).toBe(true);
  expect(new Set(generated).size).toBe(generated.length);

  const secret = `0x${'11'.repeat(32)}`;
  const capable = withDeterministicHtlcTestSecret(payment(), secret);
  expect(getDeterministicHtlcTestSecret(capable)).toBe(secret);
  expect(capable.data.hashlock).toBe(hashHtlcSecret(secret).toLowerCase());
  expect(safeStringify(capable)).not.toContain(secret.slice(2));
});
