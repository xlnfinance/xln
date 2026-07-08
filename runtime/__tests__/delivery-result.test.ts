import { expect, test } from 'bun:test';

import {
  deliveryAccepted,
  deliveryDeferred,
  deliveryFailure,
  isDeliveryDelivered,
  isDeliveryResult,
  requireDeliveryDelivered,
  requireDeliveryResult,
  shouldRetryDelivery,
} from '../delivery-result';

test('delivery result helpers validate the shared delivery contract', () => {
  const delivered = deliveryAccepted('DELIVERED');
  expect(isDeliveryResult(delivered)).toBe(true);
  expect(isDeliveryDelivered(delivered)).toBe(true);
  expect(shouldRetryDelivery(delivered)).toBe(false);
  expect(requireDeliveryResult(delivered, 'TEST_INVALID')).toBe(delivered);

  expect(isDeliveryResult(true)).toBe(false);
  expect(isDeliveryResult({ outcome: 'delivered', code: 'PARTIAL' })).toBe(false);
  expect(() => requireDeliveryResult(true, 'TEST_INVALID')).toThrow(
    'TEST_INVALID: expected DeliveryResult',
  );
});

test('delivered assertion centralizes hard delivery requirements', () => {
  const delivered = deliveryAccepted('DELIVERED');
  expect(requireDeliveryDelivered(delivered, 'MUST_DELIVER')).toBe(delivered);

  const deferred = deliveryDeferred({ outcome: 'deferred', code: 'DEFERRED' });
  expect(() => requireDeliveryDelivered(
    deferred,
    (delivery) => `MUST_DELIVER: code=${delivery.code}`,
  )).toThrow('MUST_DELIVER: code=DEFERRED');
});

test('delivery retry helper retains only non-terminal delivery attempts', () => {
  const deferred = deliveryDeferred({ outcome: 'deferred', code: 'DEFERRED' });
  expect(isDeliveryDelivered(deferred)).toBe(false);
  expect(shouldRetryDelivery(deferred)).toBe(true);

  const retryableFailure = deliveryFailure({
    category: 'TransientRace',
    code: 'TRANSIENT',
    terminal: false,
  });
  expect(shouldRetryDelivery(retryableFailure)).toBe(true);

  const expiredFailure = deliveryFailure({
    category: 'TransientRace',
    code: 'EXPIRED',
    terminal: true,
  });
  expect(shouldRetryDelivery(expiredFailure)).toBe(false);
});
