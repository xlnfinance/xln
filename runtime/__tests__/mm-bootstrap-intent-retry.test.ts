import { describe, expect, test } from 'bun:test';

import {
  consumeExpiredBootstrapIntentAttempt,
  isBootstrapIntentAttemptExpired,
  MARKET_MAKER_BOOTSTRAP_INTENT_RETRY_MS,
} from '../orchestrator/mm-node-core';

/**
 * Regression for the bootstrap-cross stall: a cross-j offerId is stable for a
 * whole MARKET_MAKER_CROSS_EXPIRY_MS generation (default 24h), so the same
 * (hub, pair, level) reproduces the exact same offerId on every later wave.
 * If one submission attempt never produces durable progress (a rejected
 * fat-frame cohort, a dropped race, a stale nonce), `attemptedBootstrapIntentOrderIds`
 * must expire that attempt instead of blacklisting the offerId for the rest
 * of the run, or the coverage gap can never close.
 */
describe('bootstrap cross-j intent attempt retry', () => {
  test('isBootstrapIntentAttemptExpired is false immediately and true once the retry window elapses', () => {
    const attemptedAt = 1_000_000;
    expect(isBootstrapIntentAttemptExpired(attemptedAt, attemptedAt)).toBe(false);
    expect(isBootstrapIntentAttemptExpired(attemptedAt, attemptedAt + MARKET_MAKER_BOOTSTRAP_INTENT_RETRY_MS - 1)).toBe(false);
    expect(isBootstrapIntentAttemptExpired(attemptedAt, attemptedAt + MARKET_MAKER_BOOTSTRAP_INTENT_RETRY_MS)).toBe(true);
  });

  test('consumeExpiredBootstrapIntentAttempt keeps excluding a fresh attempt', () => {
    const attempted = new Map<string, number>([['offer-a', 1_000_000]]);
    const stillExcluded = consumeExpiredBootstrapIntentAttempt(attempted, 'offer-a', 1_000_500);
    expect(stillExcluded).toBe(true);
    expect(attempted.has('offer-a')).toBe(true);
  });

  test('consumeExpiredBootstrapIntentAttempt forgets a stale attempt so it can be retried', () => {
    const attempted = new Map<string, number>([['offer-a', 1_000_000]]);
    const now = 1_000_000 + MARKET_MAKER_BOOTSTRAP_INTENT_RETRY_MS + 1;
    const stillExcluded = consumeExpiredBootstrapIntentAttempt(attempted, 'offer-a', now);
    expect(stillExcluded).toBe(false);
    // Pruned, not just reported as expired: a permanently growing Map was the
    // original bug (never cleared for the lifetime of the bootstrap process).
    expect(attempted.has('offer-a')).toBe(false);
  });

  test('consumeExpiredBootstrapIntentAttempt is a no-op for an offerId that was never attempted', () => {
    const attempted = new Map<string, number>();
    expect(consumeExpiredBootstrapIntentAttempt(attempted, 'offer-never-tried', 1_000_000)).toBe(false);
    expect(attempted.size).toBe(0);
  });

  test('an offerId that never gains durable progress eventually becomes eligible again', () => {
    // Simulates the exact stuck-coverage-gap scenario: a cross-j offerId is
    // stable for a whole MARKET_MAKER_CROSS_EXPIRY_MS generation, so every
    // later bootstrap wave regenerates the identical offerId for that
    // (hub, pair, level). One rejected attempt must not make every future
    // wave see it as permanently excluded.
    const attempted = new Map<string, number>();
    const firstAttemptAt = 1_000_000;
    attempted.set('mmx-hub1-hub2-1-2-abcdef-sell-1', firstAttemptAt);

    // Many waves in the ultra-tight bootstrap loop (MARKET_MAKER_BOOTSTRAP_LOOP_MS
    // defaults to 1ms) all land inside the retry window and stay excluded.
    for (let waveMs = 1; waveMs < MARKET_MAKER_BOOTSTRAP_INTENT_RETRY_MS; waveMs += 500) {
      expect(consumeExpiredBootstrapIntentAttempt(
        attempted,
        'mmx-hub1-hub2-1-2-abcdef-sell-1',
        firstAttemptAt + waveMs,
      )).toBe(true);
    }

    // Once the retry window elapses with no durable progress ever recorded,
    // the same identical offerId must be retried, not starved forever.
    const laterWaveAt = firstAttemptAt + MARKET_MAKER_BOOTSTRAP_INTENT_RETRY_MS + 10;
    expect(consumeExpiredBootstrapIntentAttempt(
      attempted,
      'mmx-hub1-hub2-1-2-abcdef-sell-1',
      laterWaveAt,
    )).toBe(false);
  });
});
