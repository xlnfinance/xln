import { expect, test } from 'bun:test';

import { selectProfileBatch } from '../network/p2p/profile-batch';
import type { Profile } from '../entity/profile';

const profile = (index: number): Profile => ({
  entityId: `entity-${index}`,
  runtimeId: `runtime-${index}`,
  wsUrl: null,
  relays: [],
  lastUpdated: index,
  metadata: { isHub: false },
}) as Profile;

test('gossip batch caps explicit ids and never exceeds the server limit', () => {
  const profiles = Array.from({ length: 8 }, (_, index) => profile(index));
  const selected = selectProfileBatch(
    profiles,
    { ids: profiles.map(item => item.entityId), limit: 100 },
    3,
  );

  expect(selected).toHaveLength(3);
  expect(selected.map(item => item.entityId)).toEqual(['entity-2', 'entity-1', 'entity-0']);
});
