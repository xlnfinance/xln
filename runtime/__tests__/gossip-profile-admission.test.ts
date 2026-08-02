import { expect, test } from 'bun:test';

import { createGossipProfileAdmission } from '../api/server/gossip-profile-admission';

test('public gossip misses have bounded per-client and global admission', () => {
  const admission = createGossipProfileAdmission(1_000, 2, 3);
  expect(admission.admit('client-a', 1_000)).toBe(true);
  expect(admission.admit('client-a', 1_001)).toBe(true);
  expect(admission.admit('client-a', 1_002)).toBe(false);
  expect(admission.admit('client-b', 1_003)).toBe(true);
  expect(admission.admit('client-c', 1_004)).toBe(false);

  expect(admission.admit('client-a', 2_000)).toBe(true);
  expect(admission.retryAfterSeconds).toBe(1);
});
