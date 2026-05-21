import { describe, expect, test } from 'bun:test';
import { deriveSignerAddressSync } from '../account-crypto';
import { RuntimeP2P } from '../networking/p2p';
import type { Profile } from '../networking/gossip';
import type { Env, RoutedEntityInput } from '../types';

const key = (byte: string): string => `0x${byte.repeat(32)}`;

const runtimeIdFor = (label: string): string =>
  deriveSignerAddressSync(`p2p-direct-policy-${label}`, '1').toLowerCase();

const buildProfile = (
  entityByte: string,
  runtimeId: string,
  runtimeEncPubKey: string,
  isHub: boolean,
  wsUrl: string | null,
): Profile => ({
  entityId: `0x${entityByte.repeat(32)}`,
  runtimeId,
  name: isHub ? 'hub' : 'user',
  avatar: '',
  bio: '',
  website: '',
  lastUpdated: 1,
  runtimeEncPubKey,
  publicAccounts: [],
  wsUrl,
  relays: [],
  metadata: {
    entityEncPubKey: runtimeEncPubKey,
    isHub,
    routingFeePPM: 1,
    baseFee: 0n,
    board: {
      threshold: 1,
      validators: [{
        signer: runtimeId,
        signerId: runtimeId,
        weight: 1,
        publicKey: `0x${entityByte.repeat(33)}`,
      }],
    },
  },
  accounts: [],
});

const makeP2P = (profiles: Profile[]): RuntimeP2P => new RuntimeP2P({
  env: {
    runtimeSeed: 'p2p-direct-policy-local',
    gossip: { getProfiles: () => profiles },
    warn: () => {},
  } as unknown as Env,
  runtimeId: runtimeIdFor('local'),
  onEntityInput: (_from: string, _input: RoutedEntityInput) => {},
  onGossipProfiles: () => {},
});

describe('RuntimeP2P direct transport policy', () => {
  test('ignores non-hub wsUrl endpoints', () => {
    const userRuntimeId = runtimeIdFor('user');
    const p2p = makeP2P([
      buildProfile('11', userRuntimeId, key('11'), false, 'ws://127.0.0.1:9101/direct-runtime'),
    ]);

    expect((p2p as unknown as { getDirectPeerEndpoint: (runtimeId: string) => string | null })
      .getDirectPeerEndpoint(userRuntimeId)).toBeNull();
  });

  test('allows hub wsUrl endpoints', () => {
    const hubRuntimeId = runtimeIdFor('hub');
    const endpoint = 'ws://127.0.0.1:9102/direct-runtime';
    const p2p = makeP2P([
      buildProfile('22', hubRuntimeId, key('22'), true, endpoint),
    ]);

    expect((p2p as unknown as { getDirectPeerEndpoint: (runtimeId: string) => string | null })
      .getDirectPeerEndpoint(hubRuntimeId)).toBe(endpoint);
  });
});
