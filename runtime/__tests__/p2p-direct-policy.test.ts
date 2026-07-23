import { describe, expect, test } from 'bun:test';
import { deriveSignerAddressSync } from '../account/crypto';
import { RuntimeP2P } from '../networking/p2p';
import { hexToPubKey } from '../networking/p2p-crypto';
import type { Profile } from '../networking/gossip';
import type { Env } from '../types';

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
  onEntityInputs: () => {},
  onGossipProfiles: () => {},
});

describe('RuntimeP2P direct transport policy', () => {
  test('rejects malformed X25519 public-key hex instead of decoding zeros', () => {
    expect(() => hexToPubKey(`0x${'zz'.repeat(32)}`)).toThrow('P2P_INVALID_PUBKEY');
  });

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

  test('does not use an unverified cached profile as encryption authority', () => {
    const runtimeId = runtimeIdFor('unverified-key');
    const p2p = makeP2P([
      buildProfile('23', runtimeId, key('23'), true, 'ws://127.0.0.1:9105/direct-runtime'),
    ]);

    expect((p2p as unknown as {
      resolveTargetEncryptionKey: (targetRuntimeId: string) => Uint8Array | null;
    }).resolveTargetEncryptionKey(runtimeId)).toBeNull();
  });

  test('rejects a transport encryption key that differs from the signed profile', () => {
    const hubRuntimeId = runtimeIdFor('signed-key');
    const p2p = makeP2P([
      buildProfile('33', hubRuntimeId, key('33'), true, 'ws://127.0.0.1:9103/direct-runtime'),
    ]);
    const internal = p2p as unknown as {
      rememberVerifiedProfileRoute: (profile: Profile) => void;
      validateTransportEncryptionHint: (runtimeId: string, pubKeyHex: string) => void;
      resolveTargetEncryptionKey: (runtimeId: string) => Uint8Array | null;
    };
    internal.rememberVerifiedProfileRoute(
      buildProfile('33', hubRuntimeId, key('33'), true, 'ws://127.0.0.1:9103/direct-runtime'),
    );

    expect(() => internal.validateTransportEncryptionHint(hubRuntimeId, key('33'))).not.toThrow();
    expect(() => internal.validateTransportEncryptionHint(hubRuntimeId, key('44')))
      .toThrow('P2P_TRANSPORT_ENCRYPTION_KEY_MISMATCH');
    expect(Buffer.from(internal.resolveTargetEncryptionKey(hubRuntimeId) ?? []).toString('hex'))
      .toBe('33'.repeat(32));
  });

  test('fails closed when signed profiles disagree on one runtime encryption key', () => {
    const hubRuntimeId = runtimeIdFor('conflicting-key');
    const p2p = makeP2P([
      buildProfile('44', hubRuntimeId, key('44'), true, 'ws://127.0.0.1:9104/direct-runtime'),
      buildProfile('55', hubRuntimeId, key('55'), true, 'ws://127.0.0.1:9104/direct-runtime'),
    ]);
    const internal = p2p as unknown as {
      rememberVerifiedProfileRoute: (profile: Profile) => void;
      resolveTargetEncryptionKey: (runtimeId: string) => Uint8Array | null;
    };
    internal.rememberVerifiedProfileRoute(
      buildProfile('44', hubRuntimeId, key('44'), true, 'ws://127.0.0.1:9104/direct-runtime'),
    );
    internal.rememberVerifiedProfileRoute(
      buildProfile('55', hubRuntimeId, key('55'), true, 'ws://127.0.0.1:9104/direct-runtime'),
    );

    expect(() => internal.resolveTargetEncryptionKey(hubRuntimeId))
      .toThrow('P2P_SIGNED_RUNTIME_KEY_CONFLICT');
  });
});
