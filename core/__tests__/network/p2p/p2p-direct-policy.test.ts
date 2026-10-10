import { describe, expect, test } from 'bun:test';
import { deriveSignerAddressSync } from '../../../account/crypto';
import { reportDirectClientError, RuntimeP2P } from '../../../network/p2p/p2p';
import { hexToPubKey } from '../../../protocol/crypto/p2p-crypto';
import type { Profile } from '../../../entity/profile';
import type { RuntimeReplica } from '../../../runtime/types';

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
    gossip: {
      getProfiles: () => profiles,
      getProfile: (entityId: string) => profiles.find(profile => profile.entityId === entityId),
      getProfileByRuntimeId: (runtimeId: string) =>
        profiles.find(profile => profile.runtimeId === runtimeId && profile.metadata?.isHub === true) ??
        profiles.find(profile => profile.runtimeId === runtimeId),
    },
    warn: () => {},
  } as unknown as RuntimeReplica,
  runtimeId: runtimeIdFor('local'),
  onEntityInputs: () => {},
  onGossipProfiles: () => {},
});

describe('RuntimeP2P direct transport policy', () => {
  test('sends the signed local profile on the exact authenticated direct socket without a relay', async () => {
    const targetRuntimeId = runtimeIdFor('profile-target');
    const profile = buildProfile('10', runtimeIdFor('profile-source'), key('10'), false, null);
    const sent: Array<{ to: string; payload: unknown }> = [];
    const directClient = {
      isOpen: () => true,
      sendGossipAnnounce: (to: string, payload: unknown) => {
        sent.push({ to, payload });
        return true;
      },
    };
    const p2p = Object.create(RuntimeP2P.prototype) as RuntimeP2P & Record<string, any>;
    p2p.closing = false;
    p2p.closed = false;
    p2p.backgroundIoPaused = false;
    p2p.directClients = new Map([[targetRuntimeId, directClient]]);
    p2p.directPublishedProfiles = new Map();
    p2p.getLocalProfilesForEntities = async () => [profile];
    p2p.rememberAnnouncedProfile = () => undefined;
    p2p.env = { gossip: { announce: () => undefined } };

    await p2p.announceLocalProfilesToDirectRuntime(targetRuntimeId, directClient);

    expect(sent).toEqual([{
      to: targetRuntimeId,
      payload: { profiles: [profile], jurisdictions: [] },
    }]);
  });

  test('relay_inbound_entity_inputs_rejected', async () => {
    const errors: string[] = [];
    const env = {
      runtimeId: runtimeIdFor('relay-victim'),
      state: { height: 3, timestamp: 3 },
      infrastructure: {},
      error: (_category: string, message: string) => { errors.push(message); },
      warn: () => {},
    } as unknown as RuntimeReplica;
    const p2p = Object.create(RuntimeP2P.prototype) as RuntimeP2P & Record<string, unknown>;
    let admitted = 0;
    let sourceChecks = 0;
    p2p.env = env;
    p2p.runtimeId = runtimeIdFor('relay-victim');
    p2p.closing = false;
    p2p.closed = false;
    p2p.scheduleProfilePrefetch = () => { sourceChecks += 1; };
    p2p.onEntityInputs = () => { admitted += 1; };
    const envelope = {
      sourceRuntimeId: runtimeIdFor('relay-attacker'),
      sourceSignature: `0x${'11'.repeat(65)}`,
      sourceRuntimeHeight: 1,
      sourceRuntimeTimestamp: 1,
      entityInputs: [{
        entityId: `0x${'21'.repeat(32)}`,
        runtimeId: runtimeIdFor('relay-victim'),
        signerId: runtimeIdFor('relay-victim'),
        entityTxs: [],
      }],
    };
    const accept = (p2p as unknown as {
      acceptInboundEntityInputs(
        transport: 'relay' | 'direct',
        from: string,
        envelope: unknown,
        timestamp: number | undefined,
        sessionAuthenticated?: boolean,
      ): Promise<void>;
    }).acceptInboundEntityInputs.bind(p2p);

    // Financial bytes never travel over a relay; even a "session authenticated"
    // claim cannot admit them. The reject happens before source verification,
    // profile prefetch or Runtime intake, and never touches the Runtime state.
    await expect(accept('relay', runtimeIdFor('relay-attacker'), envelope, 1, true))
      .rejects.toThrow('P2P_RELAY_ENTITY_INPUTS_FORBIDDEN');
    expect(admitted).toBe(0);
    expect(sourceChecks).toBe(0);
    expect(env.infrastructure?.operatorStatus).toBeUndefined();
    expect(errors).toEqual([]);
  });

  test('halts on a correlated post-WAL delivery rejection', () => {
    const env = {
      state: { height: 41, timestamp: 123 },
      infrastructure: {},
      error: () => {},
      warn: () => {},
    } as unknown as RuntimeReplica;

    reportDirectClientError(
      env,
      'ws://127.0.0.1:9100/direct-runtime',
      runtimeIdFor('target'),
      new Error('P2P_REMOTE_REJECTED:id=ack-h7:reason=target refused input'),
    );

    expect(env.infrastructure?.operatorStatus).toBe('HALTED_REQUIRES_OPERATOR');
    expect(env.infrastructure?.fatalDebugPayload).toMatchObject({
      height: 41,
      timestamp: 123,
      message: expect.stringContaining('P2P_REMOTE_REJECTED:id=ack-h7'),
    });
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

  test('a re-keyed runtime resolves to its newest signed profile key, never a halt', () => {
    // Routes are bound to the announcing Runtime, so two keys for one Runtime
    // mean it re-keyed and some profiles are stale. The conflict used to
    // throw on the send path and halt every sender to that Runtime.
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
    internal.rememberVerifiedProfileRoute({
      ...buildProfile('55', hubRuntimeId, key('55'), true, 'ws://127.0.0.1:9104/direct-runtime'),
      lastUpdated: 2,
    });

    expect(Buffer.from(internal.resolveTargetEncryptionKey(hubRuntimeId) ?? []).toString('hex'))
      .toBe('55'.repeat(32));
  });

  test('a direct announcement carries only the announcing runtime\'s own profiles', async () => {
    // Anyone can self-sign a lazy Entity profile. Unbound, it could claim a
    // victim Runtime's id with another key or endpoint (Rust RUNTIME_BINDING).
    const announcer = runtimeIdFor('announcer');
    const victim = runtimeIdFor('victim');
    const p2p = makeP2P([]);
    const admitted: unknown[][] = [];
    const internal = p2p as unknown as {
      applyIncomingProfiles: (from: string, profiles: unknown[]) => Promise<void>;
    };
    internal.applyIncomingProfiles = async (_from, profiles) => { admitted.push(profiles); };
    const own = buildProfile('66', announcer, key('66'), false, null);
    const claimed = buildProfile('77', victim, key('77'), true, 'ws://127.0.0.1:9107/direct-runtime');
    await p2p.admitGossipAnnouncement(announcer, { profiles: [own, claimed], jurisdictions: [] });
    expect(admitted).toEqual([[own]]);
  });
});
