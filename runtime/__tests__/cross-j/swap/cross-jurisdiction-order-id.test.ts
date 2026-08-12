import { describe, expect, test } from 'bun:test';

import { requireCrossJurisdictionOrderId } from '../../../runtime/jurisdiction-api';

describe('cross-jurisdiction order id', () => {
  test('normalizes the caller-owned idempotency key', () => {
    expect(requireCrossJurisdictionOrderId('  order:42  ')).toBe('order:42');
  });

  test('rejects identities that cannot be used as durable keys', () => {
    expect(() => requireCrossJurisdictionOrderId('')).toThrow('CROSS_SWAP_ORDER_ID_REQUIRED');
    expect(() => requireCrossJurisdictionOrderId('left\0right')).toThrow('CROSS_SWAP_ORDER_ID_INVALID');
    expect(() => requireCrossJurisdictionOrderId('🛡️'.repeat(100))).toThrow('CROSS_SWAP_ORDER_ID_TOO_LARGE');
  });
});
