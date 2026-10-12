import { describe, expect, test } from 'bun:test';

import {
  J_WATCHER_IDLE_CANONICAL_AUDIT_MS,
  nextWatcherRpcBackoffMs,
  shouldAuditCanonicalWatcherState,
} from '../../../jurisdiction/adapter/watcher/observe/watcher-poll-policy';
import { resolveRpcWatcherPollMs } from '../../../jurisdiction/adapter/rpc/watcher/rpc-watcher-controller';
import { BLOCKCHAIN } from '../../../config/constants';

const idle = {
  currentHead: 42,
  lastObservedHead: 42,
  nowMs: 20_000,
  lastAuditAtMs: 10_000,
  hasRangeWork: false,
  hasPendingHistory: false,
  hasPendingReorg: false,
};

describe('J watcher idle canonical audit policy', () => {
  test('skips repeated block/header audits while the chain and local frontier are idle', () => {
    expect(shouldAuditCanonicalWatcherState(idle)).toBe(false);
  });

  test('audits every causal progress path immediately', () => {
    for (const change of [
      { currentHead: 43 },
      { hasRangeWork: true },
      { hasPendingHistory: true },
      { hasPendingReorg: true },
    ]) {
      expect(shouldAuditCanonicalWatcherState({ ...idle, ...change })).toBe(true);
    }
  });

  test('periodically revalidates a same-height head to detect silent reorgs', () => {
    expect(shouldAuditCanonicalWatcherState({
      ...idle,
      nowMs: idle.lastAuditAtMs + J_WATCHER_IDLE_CANONICAL_AUDIT_MS,
    })).toBe(true);
  });
});

describe('RPC watcher poll interval', () => {
  test('uses the adapter override instead of silently falling back to five seconds', () => {
    expect(resolveRpcWatcherPollMs(300)).toBe(300);
    expect(resolveRpcWatcherPollMs(undefined)).toBe(BLOCKCHAIN.J_WATCHER_POLL_INTERVAL_MS);
  });

  test('rejects invalid configured intervals', () => {
    expect(() => resolveRpcWatcherPollMs(0)).toThrow('J_WATCHER_POLL_INTERVAL_INVALID:0');
    expect(() => resolveRpcWatcherPollMs(1.5)).toThrow('J_WATCHER_POLL_INTERVAL_INVALID:1.5');
  });
});

describe('RPC watcher transport pressure', () => {
  test('keeps healthy catch-up immediate and retains pressure after a success', () => {
    expect(nextWatcherRpcBackoffMs(0, true)).toBe(0);
    const afterFailure = nextWatcherRpcBackoffMs(0, false);
    expect(afterFailure).toBe(1_000);
    const afterSuccess = nextWatcherRpcBackoffMs(afterFailure, true);
    expect(afterSuccess).toBe(750);
    expect(nextWatcherRpcBackoffMs(afterSuccess, false)).toBeGreaterThan(afterFailure);
  });

  test('bounds repeated failures and fully recovers after sustained success', () => {
    let backoff = 0;
    for (let attempt = 0; attempt < 10; attempt += 1) backoff = nextWatcherRpcBackoffMs(backoff, false);
    expect(backoff).toBe(30_000);
    for (let attempt = 0; attempt < 40; attempt += 1) backoff = nextWatcherRpcBackoffMs(backoff, true);
    expect(backoff).toBe(0);
  });
});
