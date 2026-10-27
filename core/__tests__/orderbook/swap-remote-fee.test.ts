import { expect, test } from 'bun:test';
import { listLiveEntitySummaries } from '../../api/runtime-adapter/read/context';
import { createEmptyEnv } from '../../runtime';
import { buildCryptographicProfileFixture } from '../helpers/cryptographic-profile';
import { entity } from '../helpers/cross-j';

test('runtime adapter projects the hub fee policy without an embedded wallet runtime', () => {
  const env = createEmptyEnv();
  const hubId = entity('11');
  const profile = buildCryptographicProfileFixture({ entityId: hubId, name: 'Hub', signingSeed: 'swap-fee', isHub: true });
  env.gossip.announce({ ...profile, metadata: { ...profile.metadata, swapTakerFeeBps: 25 } });
  const summary = listLiveEntitySummaries({ env }).find(row => row.entityId === hubId);
  expect(summary).toBeDefined();
  expect(Reflect.get(summary!, 'swapTakerFeeBps')).toBe(25);
});
