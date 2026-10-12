import { describe, expect, test } from 'bun:test';

import {
  isJWatcherDrainComplete,
  observeJWatcherDrainProgress,
  getJWatcherDrainProgressKey,
  needsJWatcherPoll,
  type JWatcherDrainStatus,
} from '../../../jurisdiction/adapter/operations/backlog-drain-status';

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

  test('funded wallet reload accepts the authenticated 1136–1186 empty tail, but waits for financial finality', () => {
    // The live reload trace retained Entity height 1135 while the watcher
    // authenticated 51 empty blocks. Empty suffixes below the 100-block
    // liveness interval must not require another financial frame to open UI.
    const emptyTail = status({
      targetBlock: 1186,
      committedCursor: 1135,
      authenticatedThrough: 1186,
      replicas: [{
        key: 'entity:validator',
        localScannedThrough: 1135,
        authenticatedThrough: 1186,
        entityFinalizedThrough: 1135,
        pendingDueFinality: false,
      }],
    });
    expect(isJWatcherDrainComplete(emptyTail)).toBe(true);
    expect(needsJWatcherPoll(emptyTail)).toBe(false);
    expect(isJWatcherDrainComplete({
      ...emptyTail,
      replicas: emptyTail.replicas.map(replica => ({ ...replica, pendingDueFinality: true })),
    })).toBe(false);
  });

  test('does not require a global cursor beyond the common durable Entity prefix', () => {
    const emptyTail = status({
      committedCursor: 99,
      replicas: [{
        key: 'affected:validator',
        localScannedThrough: 100,
        authenticatedThrough: 100,
        entityFinalizedThrough: 100,
        pendingDueFinality: false,
      }, {
        key: 'unaffected:validator',
        localScannedThrough: 99,
        authenticatedThrough: 100,
        entityFinalizedThrough: 99,
        pendingDueFinality: false,
      }],
    });
    expect(needsJWatcherPoll(emptyTail)).toBe(false);
    expect(isJWatcherDrainComplete(emptyTail)).toBe(true);
  });

  test('does not fabricate Entity finality for an authenticated empty tail', () => {
    const emptyTail = status({
      targetBlock: 5_783,
      committedCursor: 23,
      authenticatedThrough: 5_783,
      replicas: [{
        key: 'affected:validator',
        localScannedThrough: 5_783,
        authenticatedThrough: 5_783,
        entityFinalizedThrough: 5_783,
        pendingDueFinality: false,
      }, {
        key: 'unaffected:validator',
        localScannedThrough: 5_783,
        authenticatedThrough: 5_783,
        entityFinalizedThrough: 23,
        pendingDueFinality: false,
      }],
    });
    expect(needsJWatcherPoll(emptyTail)).toBe(false);
    expect(isJWatcherDrainComplete(emptyTail)).toBe(true);
  });

  test('commits the WAL cursor after a meaningful range becomes durable', () => {
    expect(needsJWatcherPoll(status({
      committedCursor: 99,
      replicas: [{
        key: 'entity:validator',
        localScannedThrough: 100,
        authenticatedThrough: 100,
        entityFinalizedThrough: 100,
        pendingDueFinality: false,
      }],
    }))).toBe(true);
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

  test('new blocks cannot hide stalled finalization of a captured target', () => {
    const initial = status();
    const progress = observeJWatcherDrainProgress(null, getJWatcherDrainProgressKey(initial), 0);
    const newer = status({
      authenticatedThrough: 200,
      replicas: initial.replicas.map(replica => ({
        ...replica, localScannedThrough: 200, authenticatedThrough: 200,
      })),
    });
    expect(isJWatcherDrainComplete(newer)).toBe(false);
    expect(getJWatcherDrainProgressKey(newer)).toBe(progress.fingerprint);
    expect(() => observeJWatcherDrainProgress(progress, getJWatcherDrainProgressKey(newer), 60_000))
      .toThrow('J_WATCHER_DRAIN_STALLED:idleMs=60000');
  });

  test('keeps a progressing catch-up alive beyond its first minute, then rejects a stall', () => {
    let progress = observeJWatcherDrainProgress(null, 'cursor=0', 0);
    for (let height = 1; height <= 10; height += 1) {
      progress = observeJWatcherDrainProgress(progress, `cursor=${height}`, height * 30_000);
    }
    expect(progress.lastProgressAt).toBe(300_000);
    expect(() => observeJWatcherDrainProgress(progress, 'cursor=10', 360_000))
      .toThrow('J_WATCHER_DRAIN_STALLED:idleMs=60000:timeoutMs=60000:cursor=10');
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
