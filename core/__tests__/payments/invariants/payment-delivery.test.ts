import { describe, expect, test } from 'bun:test';
import {
  requireTrustedPaymentGateway,
  resolvePaymentDeadlineWindow,
} from '../../../protocol/payments/delivery';
import { HTLC } from '../../../config/constants';
import { calculateHopRevealHeight, calculateHopTimelock } from '../../../protocol/htlc/utils';
import { paymentExpiryBlocks, ASYNC_PAYMENT_EXPIRY_MS } from '../../../types/finance/payment';
import { toJHeight, toUnixMs } from '../../../protocol/units';

describe('payment delivery modes', () => {
  test('async is a deterministic 24-hour window', () => {
    const deadline = resolvePaymentDeadlineWindow({
      blockTimeMs: 10_000, mode: 'async',
      runtimeJHeight: toJHeight(123),
      timestamp: toUnixMs(1_000),
      totalHops: 3,
    });
    expect(deadline.baseTimelock).toBe(BigInt(1_000 + ASYNC_PAYMENT_EXPIRY_MS));
    expect(deadline.baseHeight).toBe(123 + paymentExpiryBlocks(ASYNC_PAYMENT_EXPIRY_MS, 10_000));
  });

  test('instant retains the short bounded window', () => {
    const deadline = resolvePaymentDeadlineWindow({
      blockTimeMs: 10_000, mode: 'instant',
      runtimeJHeight: toJHeight(123),
      timestamp: toUnixMs(1_000),
      totalHops: 3,
    });
    expect(deadline.baseTimelock).toBe(121_000n);
    expect(deadline.baseHeight).toBe(135);
  });

  test('reserves multiple jurisdiction blocks for every upstream reveal', () => {
    const baseHeight = 100;
    const upstream = calculateHopRevealHeight(baseHeight, 0, 3, 10_000);
    const intermediary = calculateHopRevealHeight(baseHeight, 1, 3, 10_000);
    const recipient = calculateHopRevealHeight(baseHeight, 2, 3, 10_000);

    expect(upstream - intermediary).toBe(3);
    expect(intermediary - recipient).toBe(3);
    expect(3).toBeGreaterThan(1);
  });

  test('charges the timelock delta exactly once per actual forward', () => {
    const sixHopWindow = resolvePaymentDeadlineWindow({
      blockTimeMs: 10_000, mode: 'instant',
      runtimeJHeight: toJHeight(0),
      timestamp: toUnixMs(0),
      totalHops: 6,
    });
    expect(calculateHopTimelock(sixHopWindow.baseTimelock, 0)).toBe(sixHopWindow.baseTimelock);
    expect(calculateHopTimelock(sixHopWindow.baseTimelock, 5)).toBe(70_000n);

    const maxHopWindow = resolvePaymentDeadlineWindow({
      blockTimeMs: 10_000, mode: 'instant',
      runtimeJHeight: toJHeight(0),
      timestamp: toUnixMs(0),
      totalHops: HTLC.MAX_HOPS,
    });
    const finalHop = calculateHopTimelock(maxHopWindow.baseTimelock, HTLC.MAX_HOPS - 1);
    expect(finalHop).toBeGreaterThan(BigInt(30_000));
    expect(() => calculateHopTimelock(maxHopWindow.baseTimelock, -1)).toThrow('HTLC_HOP_INDEX_INVALID');
  });

  test('trusted delivery permits exactly one declared gateway', () => {
    expect(requireTrustedPaymentGateway(['sender', 'hub', 'recipient'], 'recipient', 'hub')).toBe('hub');
    expect(() => requireTrustedPaymentGateway(['sender', 'recipient'], 'recipient', undefined)).toThrow(
      'TRUSTED_PAYMENT_GATEWAY_INVALID',
    );
    expect(() => requireTrustedPaymentGateway(['sender', 'hub', 'recipient'], 'recipient', 'other')).toThrow(
      'TRUSTED_PAYMENT_GATEWAY_INVALID',
    );
    expect(() => requireTrustedPaymentGateway(
      ['sender', 'untrusted', 'hub', 'recipient'], 'recipient', 'hub',
    )).toThrow('TRUSTED_PAYMENT_GATEWAY_INVALID');
    expect(() => requireTrustedPaymentGateway(
      ['sender', 'sender', 'recipient'], 'recipient', 'sender',
    )).toThrow('TRUSTED_PAYMENT_GATEWAY_INVALID');
  });
});
