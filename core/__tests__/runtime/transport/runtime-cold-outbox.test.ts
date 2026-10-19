import { describe, expect, test } from 'bun:test';
import { makeAccount, putTestAccountDelta } from '../../helpers/cross-j';
import { buildLocalEntityProfile } from '../../../network/p2p/gossip/helper';
import { computeEntityProfileHash } from '../../../entity/profile/profile-descriptor';
import { PersistentEntityAccountMap } from '../../../entity/state/persistent-account-map';
import { computeEntityAccountValueHash } from '../../../entity/consensus/state-root';

import {
  closeInfraDb,
  createEmptyEnv,
  registerRuntimeFrameCommitCallback,
  startP2P,
  startRuntimeLoop,
  stopP2PAndWait,
  stopRuntimeLoopAndWait,
} from '../../../runtime';
import { createDirectRuntimeWsRoute } from '../../../network/p2p/direct-runtime-bun';
import { deriveSignerAddressSync } from '../../../account/crypto';
import { deriveEncryptionKeyPair, pubKeyToHex } from '../../../protocol/crypto/p2p-crypto';
import { validateDeliverableEntityInput } from '../../../runtime/delivery/topology/routing-validation';
import type { RuntimeEntityInputsEnvelope } from '../../../runtime/types';
import { bootstrapHub } from '../../../../scripts/bootstrap-hub';
import { verifyProfileSignature } from '../../../entity/profile/profile-signing';
import { parseProfile } from '../../../entity/profile';
import {
  buildCryptographicProfileFixture,
  certifySingleSignerProfileFixture,
  deriveSingleSignerFixtureEntityId,
} from '../../helpers/cryptographic-profile';

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 300 && !predicate(); attempt += 1) await Bun.sleep(5);
  expect(predicate()).toBe(true);
};

const createHub = (seed: string) => {
  const runtimeId = deriveSignerAddressSync(seed, '1').toLowerCase();
  const received: RuntimeEntityInputsEnvelope[] = [];
  const failures: string[] = [];
  const announcements: unknown[] = [];
  const order: string[] = [];
  const route = createDirectRuntimeWsRoute({
    runtimeId,
    runtimeSeed: seed,
    onEntityInputs: (_from, envelope) => { order.push('entity_inputs'); received.push(envelope); },
    onGossipAnnounce: (_from, payload) => { order.push('gossip_announce'); announcements.push(payload); },
    onDeliveryFailure: failure => { failures.push(failure.error); },
  });
  const server = Bun.serve<{ type: 'direct-runtime' }>({
    hostname: '127.0.0.1', port: 0,
    fetch(request, bunServer) {
      const decision = route.maybeUpgrade(request, bunServer);
      return decision.handled ? decision.response : new Response('websocket only', { status: 400 });
    },
    websocket: route.websocket,
  });
  const profile = certifySingleSignerProfileFixture({
    ...buildCryptographicProfileFixture({
      entityId: deriveSingleSignerFixtureEntityId(seed),
      signingSeed: seed,
      name: 'cold outbox hub',
      isHub: true,
      runtimeEncPubKey: pubKeyToHex(deriveEncryptionKeyPair(seed).publicKey),
      lastUpdated: Date.now(),
    }),
    wsUrl: `ws://127.0.0.1:${server.port}${route.path}`,
  }, seed);
  return { runtimeId, route, server, profile, received, failures, announcements, order };
};

describe('cold committed Runtime outbox', () => {
  test('certified routes and new credit limits publish on the authenticated socket without ordinary balance spam', async () => {
    const seed = 'late-local-direct-profile';
    const env = createEmptyEnv(seed, 1);
    env.runtimeConfig = { minFrameDelayMs: 0, loopIntervalMs: 1, storage: { enabled: false } };
    env.activeJurisdiction = 'Late Testnet';
    env.state.jReplicas.set('Late Testnet', {
      name: 'Late Testnet', chainId: 31337, blockNumber: 0n, stateRoot: new Uint8Array(32),
      mempool: [], blockDelayMs: 0, blockTimeMs: 1_000, lastBlockTimestamp: 0,
      position: { x: 0, y: 0, z: 0 }, rpcs: ['http://127.0.0.1:18545'],
      contracts: {
        account: `0x${'11'.repeat(20)}`, depository: `0x${'22'.repeat(20)}`,
        entityProvider: `0x${'33'.repeat(20)}`, deltaTransformer: `0x${'44'.repeat(20)}`,
      },
    });
    const hub = createHub(`${seed}-hub`);
    const p2p = startP2P(env, { relayUrls: [], signerId: '1' });
    if (!p2p) throw new Error('TEST_P2P_MISSING');
    try {
      hub.route.setReady(true);
      p2p.setReady(true);
      await p2p.admitSharedProfiles([hub.profile]);
      p2p.prepareEntityRoutes([hub.profile.entityId]);
      await waitFor(() => p2p.canDeliver(hub.runtimeId));
      expect(hub.announcements).toEqual([]);
      const local = await bootstrapHub(env, { name: 'Late owner', seed, signerId: '2' });
      if (!local) throw new Error('TEST_LATE_OWNER_MISSING');
      await p2p.announceProfilesForEntitiesNow([local.entityId]);
      const frame = { height: env.state.height, timestamp: env.state.timestamp };
      const envelope: RuntimeEntityInputsEnvelope = {
        sourceRuntimeId: env.runtimeId!, sourceRuntimeHeight: frame.height, sourceRuntimeTimestamp: frame.timestamp,
        entityInputs: [{ entityId: hub.profile.entityId, signerId: hub.runtimeId, runtimeId: hub.runtimeId, entityTxs: [] }],
      };
      expect(p2p.enqueueEntityInputsDelivery(hub.runtimeId, envelope).outcome).toBe('delivered');
      await waitFor(() => hub.received.length === 1);
      expect(hub.order).toEqual(['gossip_announce', 'entity_inputs']);
      const payload = hub.announcements[0] as { profiles: unknown[] };
      const profile = parseProfile(payload.profiles[0]);
      expect(profile.entityId).toBe(local.entityId);
      expect(profile.runtimeId).toBe(env.runtimeId);
      expect((await verifyProfileSignature(profile)).valid).toBe(true);
      await p2p.announceProfilesForEntitiesNow([local.entityId]);
      expect(p2p.enqueueEntityInputsDelivery(hub.runtimeId, envelope).outcome).toBe('delivered');
      await waitFor(() => hub.received.length === 2);
      expect(hub.order).toEqual(['gossip_announce', 'entity_inputs', 'entity_inputs']);
      expect(hub.announcements).toHaveLength(1);
      expect(hub.failures).toEqual([]);
      const owner = [...env.state.eReplicas.values()].find(replica => replica.entityId === local.entityId)!;
      const installCertifiedAccount = (limit: bigint, offdelta = 0n) => {
        const [left, right] = [local.entityId, hub.profile.entityId].sort();
        const account = makeAccount(left!, right!);
        account.publicPinned = true;
        putTestAccountDelta(account, { ...account.state.deltas.get(1)!,
          collateral: 0n, ondelta: 0n, offdelta, leftCreditLimit: limit, rightCreditLimit: limit });
        owner.state.accounts = owner.state.accounts.updated(hub.profile.entityId, account);
        const signed = certifySingleSignerProfileFixture(buildLocalEntityProfile(env, owner.state, env.state.timestamp), seed, '2');
        const hanko = signed.metadata.profileHanko;
        if (!hanko || !owner.hankoWitness) throw new Error('TEST_CURRENT_PROFILE_CERTIFICATE_MISSING');
        owner.hankoWitness.set(computeEntityProfileHash(owner.state), {
          hanko, type: 'profile', entityHeight: owner.state.height, createdAt: env.state.timestamp,
        });
      };
      installCertifiedAccount(100_000_000n);
      await p2p.announceProfilesForEntitiesNow([local.entityId]);
      await waitFor(() => hub.announcements.length === 2);
      // A signed policy increase must be visible before the one-hour heartbeat.
      installCertifiedAccount(103_000_000n);
      await p2p.announceProfilesForEntitiesNow([local.entityId]);
      await waitFor(() => hub.announcements.length === 3);
      const updated = parseProfile((hub.announcements[2] as { profiles: unknown[] }).profiles[0]);
      expect((await verifyProfileSignature(updated)).valid).toBe(true);
      expect(updated.accounts[0]?.tokenCapacities).toEqual({ '1': { inCapacity: 103_000_000n, outCapacity: 103_000_000n } });
      installCertifiedAccount(103_000_000n, 1n);
      await p2p.announceProfilesForEntitiesNow([local.entityId]);
      expect(hub.announcements).toHaveLength(3);
      // Restore an idle receiver: no outgoing payment may be required to
      // recreate the authenticated inbound route for an existing Account.
      await stopP2PAndWait(env);
      await waitFor(() => !hub.route.hasOpenSession(env.runtimeId!));
      owner.state.accounts = PersistentEntityAccountMap.fromMap(
        new Map([[hub.profile.entityId, makeAccount(local.entityId, hub.profile.entityId)]]),
        local.entityId, computeEntityAccountValueHash,
      );
      env.pendingNetworkOutputs = [];
      const restored = startP2P(env, { relayUrls: [], signerId: '1' });
      if (!restored) throw new Error('TEST_RESTORED_P2P_MISSING');
      await restored.admitSharedProfiles([hub.profile]);
      await waitFor(() => hub.route.canDeliver(env.runtimeId!));
      expect(env.pendingNetworkOutputs).toEqual([]);
      expect(hub.received).toHaveLength(2);

    } finally {
      await stopRuntimeLoopAndWait(env, 1_000);
      await stopP2PAndWait(env);
      await closeInfraDb(env);
      hub.server.stop(true);
    }
  });
  for (const profileTiming of ['before-startup', 'after-startup'] as const) {
    test(`dials a ${profileTiming} signed hub without unrelated inputs, then sends only when ready`, async () => {
      const label = `cold-outbox-${profileTiming}-${crypto.randomUUID()}`;
      const env = createEmptyEnv(label, 1);
      const hub = createHub(`${label}-hub`);
      const frame = { height: 7, timestamp: Date.now() };
      env.state.height = frame.height;
      env.state.timestamp = frame.timestamp;
      const sourceRuntimeId = env.runtimeId;
      if (!sourceRuntimeId) throw new Error('TEST_SOURCE_RUNTIME_ID_MISSING');
      const output = validateDeliverableEntityInput({
        runtimeId: hub.runtimeId,
        entityId: hub.profile.entityId,
        signerId: hub.runtimeId,
        entityTxs: [],
        sourceRuntimeFrame: frame,
      });
      const config = { relayUrls: [], signerId: '1' };
      const firstP2P = startP2P(env, config);
      if (!firstP2P) throw new Error('TEST_P2P_MISSING');
      const commits: number[] = [];
      const unsubscribe = registerRuntimeFrameCommitCallback(env, committed => { commits.push(committed.height); });
      try {
        if (profileTiming === 'before-startup') {
          await firstP2P.admitSharedProfiles([hub.profile]);
          expect(firstP2P.getVerifiedRuntimeRoute(hub.profile.entityId)?.runtimeId).toBe(hub.runtimeId);
          await stopP2PAndWait(env);
        }
        // Enter at the recovered committed-outbox boundary. The real Runtime
        // loop must open a cold transport itself: no input, flush, or fabricated
        // frame may be used to make the blocked queue look drained.
        env.pendingNetworkOutputs = [output];
        startRuntimeLoop(env);
        const p2p = startP2P(env, config);
        if (!p2p) throw new Error('TEST_P2P_MISSING');
        if (profileTiming === 'after-startup') await p2p.admitSharedProfiles([hub.profile]);
        expect(p2p.getVerifiedRuntimeRoute(hub.profile.entityId)?.runtimeId).toBe(hub.runtimeId);
        await waitFor(() => hub.route.hasOpenSession(sourceRuntimeId));
        // The server can finish authentication before the client receives it.
        await waitFor(() => p2p.getDirectPeerState().some(peer => peer.runtimeId === hub.runtimeId && peer.open));
        expect(p2p.getDirectPeerState()).toMatchObject([{ runtimeId: hub.runtimeId, open: true }]);
        expect(p2p.canDeliver(hub.runtimeId)).toBe(false);
        expect(env.pendingNetworkOutputs).toEqual([output]);
        expect(hub.received).toEqual([]);
        expect(commits).toEqual([]);

        hub.route.setReady(true);
        await waitFor(() => hub.received.length === 1 && env.pendingNetworkOutputs?.length === 0);
        const { sourceRuntimeFrame: _frame, ...input } = output;
        expect(hub.received).toEqual([{
          sourceRuntimeId,
          sourceRuntimeHeight: frame.height,
          sourceRuntimeTimestamp: frame.timestamp,
          entityInputs: [input],
        }]);
        expect(env.runtimeMempool).toMatchObject({ runtimeTxs: [], entityInputs: [] });
        expect(env.state.height).toBe(frame.height);
        expect(env.state.timestamp).toBe(frame.timestamp);
        expect(commits).toEqual([]);
        expect(hub.failures).toEqual([]);
        expect(env.infrastructure?.halted).not.toBe(true);
      } finally {
        unsubscribe();
        try {
          expect(await stopRuntimeLoopAndWait(env, 1_000)).toBe(true);
          await stopP2PAndWait(env);
          await closeInfraDb(env);
        } finally {
          hub.server.stop(true);
        }
      }
    });
  }
});
