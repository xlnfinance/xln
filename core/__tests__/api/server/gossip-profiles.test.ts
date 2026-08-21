import { expect, test } from 'bun:test';

import { handleKnownProfileRequest } from '../../../api/server/network/gossip-profiles';
import type { Profile } from '../../../entity/profile';
import { safeParse } from '../../../protocol/serialization';
import { createEmptyEnv } from '../../../runtime';

const entityId = (index: number): string => `0x${index.toString(16).padStart(64, '0')}`;

const profile = (id: string, peers: string[] = []): Profile => ({
  entityId: id,
  entityEncryptionPublicKey: `0x${'11'.repeat(32)}`,
  runtimeId: `0x${id.slice(2, 42)}`,
  runtimeEncPubKey: `0x${'22'.repeat(32)}`,
  name: id.slice(-8),
  avatar: '',
  bio: '',
  website: '',
  lastUpdated: 1,
  publicAccounts: peers,
  accounts: peers.map(counterpartyId => ({ counterpartyId })),
  wsUrl: null,
  relays: [],
  metadata: { isHub: peers.length > 0 },
}) as Profile;

test('known-profile inspection resolves a large peer bundle from the keyed Runtime graph', async () => {
  const env = createEmptyEnv('gossip-profile-keyed-lookup');
  const hubId = entityId(10_001);
  const peerIds = Array.from({ length: 2_000 }, (_, index) => entityId(index + 1));
  for (const peerId of peerIds) env.gossip.profiles.set(peerId, profile(peerId));
  env.gossip.profiles.set(hubId, profile(hubId, peerIds));
  env.gossip.getProfiles = () => {
    throw new Error('GOSSIP_PROFILE_ROUTE_MUST_NOT_SCAN_DIRECTORY');
  };

  const response = handleKnownProfileRequest({
    request: new Request(`http://localhost/api/gossip/profile?entityId=${hubId}`),
    env,
    relayStore: null,
    headers: { 'content-type': 'application/json' },
  });
  const payload = safeParse(await response.text()) as { found: boolean; peers: Profile[] };

  expect(response.status).toBe(200);
  expect(payload.found).toBe(true);
  expect(payload.peers).toHaveLength(peerIds.length);
  expect(new Set(payload.peers.map(item => item.entityId)).size).toBe(peerIds.length);
});
