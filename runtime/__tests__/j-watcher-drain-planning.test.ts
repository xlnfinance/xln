import { describe, expect, test } from 'bun:test';

import { needsJWatcherPoll, type JWatcherDrainStatus } from '../jadapter/backlog-drain';

const status = (overrides: Partial<JWatcherDrainStatus> = {}): JWatcherDrainStatus => ({
  chainId: 31337,
  depositoryAddress: `0x${'11'.repeat(20)}`,
  targetBlock: 100,
  committedCursor: 100,
  replicas: [{
    key: 'entity:validator',
    localScannedThrough: 100,
    entityFinalizedThrough: 99,
    pendingDueFinality: true,
  }],
  ...overrides,
});

describe('scenario J-watcher drain planning', () => {
  test('freezes a reached chain target while Entity consensus finalizes it', () => {
    expect(needsJWatcherPoll(status())).toBe(false);
  });

  test('polls when either the watcher cursor or a fresh replica is behind', () => {
    expect(needsJWatcherPoll(status({ committedCursor: 99 }))).toBe(true);
    expect(needsJWatcherPoll(status({
      replicas: [{
        key: 'entity:validator',
        localScannedThrough: 99,
        entityFinalizedThrough: 99,
        pendingDueFinality: false,
      }],
    }))).toBe(true);
  });
});
