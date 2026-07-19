import { describe, expect, test } from 'bun:test';

import {
  needsJWatcherPoll,
  observeJWatcherDrainProgress,
  type JWatcherDrainStatus,
} from '../jadapter/backlog-drain';

const status = (overrides: Partial<JWatcherDrainStatus> = {}): JWatcherDrainStatus => ({
  chainId: 31337,
  depositoryAddress: `0x${'11'.repeat(20)}`,
  targetBlock: 100,
  committedCursor: 100,
  authenticatedThrough: 100,
  replicas: [{
    key: 'entity:validator',
    localScannedThrough: 100,
    authenticatedThrough: 100,
    entityFinalizedThrough: 99,
    pendingDueFinality: true,
  }],
  ...overrides,
});

describe('scenario J-watcher drain planning', () => {
  test('freezes a reached chain target while Entity consensus finalizes it', () => {
    expect(needsJWatcherPoll(status())).toBe(false);
  });

  test('accepts a transient authenticated empty suffix without advancing the WAL cursor', () => {
    expect(needsJWatcherPoll(status({
      committedCursor: 99,
      replicas: [{
        key: 'entity:validator',
        localScannedThrough: 99,
        authenticatedThrough: 100,
        entityFinalizedThrough: 99,
        pendingDueFinality: false,
      }],
    }))).toBe(false);
  });

  test('commits the WAL cursor after a meaningful range becomes durable', () => {
    expect(needsJWatcherPoll(status({ committedCursor: 99 }))).toBe(true);
  });

  test('polls when either the authenticated watcher scan or a fresh replica is behind', () => {
    expect(needsJWatcherPoll(status({ authenticatedThrough: 99 }))).toBe(true);
    expect(needsJWatcherPoll(status({
      replicas: [{
        key: 'entity:validator',
        localScannedThrough: 99,
        authenticatedThrough: 0,
        entityFinalizedThrough: 99,
        pendingDueFinality: false,
      }],
    }))).toBe(true);
  });

  test('allows transient duplicate polls but fails after the bounded stall deadline', () => {
    const first = observeJWatcherDrainProgress(null, 'cursor=338', 1_000, 120_000);
    expect(observeJWatcherDrainProgress(first, 'cursor=338', 120_999, 120_000)).toEqual({
      ...first,
      retrying: true,
    });
    expect(() => observeJWatcherDrainProgress(first, 'cursor=338', 121_000, 120_000))
      .toThrow('J_WATCHER_DRAIN_STALLED:idleMs=120000:timeoutMs=120000:cursor=338');
  });

  test('resets the stall deadline whenever the drain fingerprint advances', () => {
    const first = observeJWatcherDrainProgress(null, 'cursor=338', 1_000, 120_000);
    expect(observeJWatcherDrainProgress(first, 'cursor=339', 120_999, 120_000)).toEqual({
      fingerprint: 'cursor=339',
      lastProgressAt: 120_999,
      retrying: false,
    });
  });
});
