import { describe, expect, test } from 'bun:test';
import {
  requireTrustedPaymentGateway,
  resolvePaymentDeadlineWindow,
} from '../protocol/payments/delivery';
import { HTLC } from '../constants';
import { calculateHopRevealHeight } from '../protocol/htlc/utils';
import { ASYNC_PAYMENT_EXPIRY_BLOCKS, ASYNC_PAYMENT_EXPIRY_MS } from '../types/payment';

describe('payment delivery modes', () => {
  test('async is a deterministic 24-hour window', () => {
    const deadline = resolvePaymentDeadlineWindow({
      mode: 'async',
      runtimeJHeight: 123,
      timestamp: 1_000,
      totalHops: 3,
    });
    expect(deadline.baseTimelock).toBe(BigInt(1_000 + ASYNC_PAYMENT_EXPIRY_MS));
    expect(deadline.baseHeight).toBe(123 + ASYNC_PAYMENT_EXPIRY_BLOCKS);
  });

  test('instant retains the short bounded window', () => {
    const deadline = resolvePaymentDeadlineWindow({
      mode: 'instant',
      runtimeJHeight: 123,
      timestamp: 1_000,
      totalHops: 3,
    });
    expect(deadline.baseTimelock).toBe(121_000n);
    expect(deadline.baseHeight).toBe(173);
  });

  test('reserves multiple jurisdiction blocks for every upstream reveal', () => {
    const baseHeight = 100;
    const upstream = calculateHopRevealHeight(baseHeight, 0, 3);
    const intermediary = calculateHopRevealHeight(baseHeight, 1, 3);
    const recipient = calculateHopRevealHeight(baseHeight, 2, 3);

    expect(upstream - intermediary).toBe(HTLC.MIN_REVEAL_HEIGHT_DELTA_BLOCKS);
    expect(intermediary - recipient).toBe(HTLC.MIN_REVEAL_HEIGHT_DELTA_BLOCKS);
    expect(HTLC.MIN_REVEAL_HEIGHT_DELTA_BLOCKS).toBeGreaterThan(1);
  });

  test('trusted delivery binds the declared gateway to the penultimate hop', () => {
    expect(requireTrustedPaymentGateway(['sender', 'hub', 'recipient'], 'recipient', 'hub')).toBe('hub');
    expect(() => requireTrustedPaymentGateway(['sender', 'recipient'], 'recipient', undefined)).toThrow(
      'TRUSTED_PAYMENT_GATEWAY_INVALID',
    );
    expect(() => requireTrustedPaymentGateway(['sender', 'hub', 'recipient'], 'recipient', 'other')).toThrow(
      'TRUSTED_PAYMENT_GATEWAY_INVALID',
    );
  });
});
