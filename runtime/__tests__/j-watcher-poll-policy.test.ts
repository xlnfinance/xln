import { describe, expect, test } from 'bun:test';

import {
  J_WATCHER_IDLE_CANONICAL_AUDIT_MS,
  shouldAuditCanonicalWatcherState,
} from '../jadapter/watcher-poll-policy';

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
