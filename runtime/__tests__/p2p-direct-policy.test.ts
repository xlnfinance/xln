import { describe, expect, test } from 'bun:test';
import { deriveSignerAddressSync } from '../account/crypto';
import { canonicalizeDirectRuntimeWsAudience } from '../network/p2p/hello-transcript';
import { RuntimeP2P } from '../network/p2p/p2p';
import { RuntimeWsClient } from '../network/p2p/ws-client';
import { isBrowserDirectWsEndpointAllowed } from '../network/p2p/p2p-endpoints';
import { deriveEncryptionKeyPair, hexToPubKey } from '../protocol/p2p-crypto';
import type { Profile } from '../entity/profile';
import type { RuntimeReplica } from '../runtime/types';

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
  } as unknown as RuntimeReplica,
  runtimeId: runtimeIdFor('local'),
  onEntityInputs: () => {},
  onGossipProfiles: () => {},
});

describe('RuntimeP2P direct transport policy', () => {
  test('requires TLS for public relay audiences while permitting a separate private dial target', () => {
    const options = {
      env: {
        runtimeSeed: 'p2p-relay-audience-policy',
        gossip: { getProfiles: () => [] },
        warn: () => {},
      } as unknown as RuntimeReplica,
      runtimeId: runtimeIdFor('relay-audience-policy'),
      relayUrls: ['ws://10.0.0.2:8080/relay'],
      onEntityInputs: () => {},
      onGossipProfiles: () => {},
    };

    expect(() => new RuntimeP2P(options)).toThrow('RUNTIME_WS_PUBLIC_PLAINTEXT_FORBIDDEN');
    expect(() => new RuntimeP2P({
      ...options,
      relayAudience: 'wss://relay.example/relay',
    })).toThrow('RUNTIME_WS_PUBLIC_PLAINTEXT_FORBIDDEN');
    expect(() => new RuntimeP2P({
      ...options,
      relayUrls: ['ws://127.0.0.1:8080/relay'],
      relayAudience: 'wss://relay.example/relay',
    })).not.toThrow();
    expect(() => new RuntimeP2P({
      ...options,
      relayUrls: ['wss://forwarder.example/relay'],
      relayAudience: 'wss://relay.example/relay',
    })).toThrow('P2P_RELAY_TRANSPORT_AUDIENCE_MISMATCH');
  });

  test('rejects wildcard direct websocket audiences', () => {
    expect(() => canonicalizeDirectRuntimeWsAudience('wss://0.0.0.0/direct-runtime'))
      .toThrow('DIRECT_RUNTIME_WS_AUDIENCE_WILDCARD_FORBIDDEN');
  });

  test('public browser pages never dial a gossip-advertised loopback endpoint', () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { protocol: 'https:', hostname: 'xln.finance' } },
    });
    try {
      expect(isBrowserDirectWsEndpointAllowed('ws://127.0.0.1:8080/direct-runtime')).toBe(false);
      expect(isBrowserDirectWsEndpointAllowed('wss://localhost:8443/direct-runtime')).toBe(false);
      expect(isBrowserDirectWsEndpointAllowed('wss://localhost.:8443/direct-runtime')).toBe(false);
      expect(isBrowserDirectWsEndpointAllowed('wss://[::ffff:7f00:1]:8443/direct-runtime')).toBe(false);
      expect(isBrowserDirectWsEndpointAllowed('wss://hub.example/direct-runtime')).toBe(true);
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
      else delete (globalThis as { window?: unknown }).window;
    }
  });

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

  test('ignores a signed public plaintext hub endpoint without throwing out of relay callbacks', () => {
    const hubRuntimeId = runtimeIdFor('plaintext-public-hub');
    const p2p = makeP2P([
      buildProfile('24', hubRuntimeId, key('24'), true, 'ws://attacker.example/direct-runtime'),
    ]);
    const internal = p2p as unknown as {
      getDirectPeerEndpoint: (runtimeId: string) => string | null;
      syncDirectPeerConnections: () => void;
    };

    expect(() => internal.syncDirectPeerConnections()).not.toThrow();
    expect(internal.getDirectPeerEndpoint(hubRuntimeId)).toBeNull();
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

  test('rebuilds and drains a terminal direct client instead of dropping its ownership', async () => {
    const hubRuntimeId = runtimeIdFor('terminal-direct-client');
    const endpoint = 'ws://127.0.0.1:1/direct-runtime';
    const profile = buildProfile('66', hubRuntimeId, key('66'), true, endpoint);
    const p2p = makeP2P([profile]);
    const terminalClient = new RuntimeWsClient({
      url: endpoint,
      runtimeId: runtimeIdFor('local'),
      signerId: '1',
      seed: 'p2p-direct-policy-local',
      useHelloAuth: true,
      expectedPeer: {
        role: 'direct-runtime-server',
        audience: endpoint,
        runtimeId: hubRuntimeId,
        encryptionPubKey: key('66'),
      },
      encryptionKeyPair: deriveEncryptionKeyPair('p2p-direct-policy-local'),
    });
    terminalClient.close();
    const internal = p2p as unknown as {
      directClients: Map<string, RuntimeWsClient>;
      directClientUrls: Map<string, string>;
      retiredClients: Set<RuntimeWsClient>;
      rememberVerifiedProfileRoute: (value: Profile) => void;
      ensureDirectClientForRuntime: (runtimeId: string) => void;
    };
    internal.rememberVerifiedProfileRoute(profile);
    internal.directClients.set(hubRuntimeId, terminalClient);
    internal.directClientUrls.set(hubRuntimeId, endpoint);
    try {
      internal.ensureDirectClientForRuntime(hubRuntimeId);
      const replacement = internal.directClients.get(hubRuntimeId);

      expect(replacement).toBeDefined();
      expect(replacement).not.toBe(terminalClient);
      expect(replacement?.isTerminallyClosed()).toBe(false);
      expect(internal.retiredClients.has(terminalClient)).toBe(true);
      await Bun.sleep(0);
      expect(internal.retiredClients.has(terminalClient)).toBe(false);
    } finally {
      p2p.close();
    }
  });
});
