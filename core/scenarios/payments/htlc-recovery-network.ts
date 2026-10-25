import { defaultAccountDisputeConfigForParties } from '../../account/config/dispute-config';
/** Real sovereign Runtimes and authenticated sockets for the ACK recovery scenario. */
import { ethers } from 'ethers';
import { createEmptyEnv, closeRuntimeDb, closeInfraDb, processRuntime, enqueueRuntimeInput } from '../../runtime';
import type { RuntimeReplica } from '../../runtime/types';
import type { JurisdictionConfig } from '../../entity/types';
import type { JAdapter } from '../../jurisdiction/adapter/types';
import { createJAdapter } from '../../jurisdiction/adapter';
import { generateLazyEntityId } from '../../entity/factory';
import { getSignerPrivateKey } from '../../account/crypto';
import { createTestEntityImportRuntimeTx } from '../../qa/entity-creation-fixture';
import { bindScenarioJReplica, createJReplica, resolveScenarioBoardSigner } from '../harness/boot';
import { setScenarioStorageEnabled, requireRuntimeSeed, findReplica, processJEvents } from '../harness/helpers';
import { createDirectRuntimeWsRoute } from '../../network/p2p/direct-runtime-bun';
import { RuntimeWsClient } from '../../network/p2p/ws-client';
import { RuntimeP2P } from '../../network/p2p/p2p';
import { directRuntimeWsAudience } from '../../network/p2p/ws-protocol';
import { deriveEncryptionKeyPair } from '../../protocol/crypto/p2p-crypto';
import { announceCertifiedLocalProfiles } from '../../network/p2p/gossip/local-profile-lifecycle';
import { createRuntimeRoutingApi } from '../../runtime/loop/loop-routing';
import { notifyRuntimeStateChanged } from '../../runtime/frame/notifications';
import { deliveryAccepted, deliveryDeferred } from '../../protocol/payments/delivery-result';

export type RecoveryActor = {
  env: RuntimeReplica;
  adapter: JAdapter;
  seed: string;
  id: string;
  signer: string;
};

const routing = createRuntimeRoutingApi({ notifyEnvChange: notifyRuntimeStateChanged });

export const recoveryReplica = (actor: RecoveryActor) => findReplica(actor.env, actor.id)[1];

export const pumpRecoveryActors = async (
  actors: readonly RecoveryActor[],
  ready: () => boolean,
  label: string,
): Promise<void> => {
  for (let round = 0; round < 100 && !ready(); round++) {
    for (const actor of actors) await processRuntime(actor.env);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  if (!ready()) throw new Error(`HTLC_RECOVERY_NETWORK_TIMEOUT:${label}`);
};

const importActor = async (
  env: RuntimeReplica,
  adapter: JAdapter,
  jurisdiction: JurisdictionConfig,
): Promise<RecoveryActor> => {
  const seed = requireRuntimeSeed(env, 'HTLC recovery network');
  const signer = resolveScenarioBoardSigner(env, '1');
  const id = generateLazyEntityId([signer], 1n, env).toLowerCase();
  env.scenarioMode = true;
  env.quietRuntimeLogs = true;
  setScenarioStorageEnabled(env, true);
  adapter.registerEntityWallet?.(id, ethers.hexlify(getSignerPrivateKey(env, signer)));
  enqueueRuntimeInput(env, {
    runtimeTxs: [
      createTestEntityImportRuntimeTx(env, {
        entityId: id,
        signerId: signer,
        data: {
          isProposer: true,
          config: {
            mode: 'proposer-based',
            threshold: 1n,
            validators: [signer],
            shares: { [signer]: 1n },
            jurisdiction,
          },
        },
      }),
    ],
    entityInputs: [],
  });
  await processRuntime(env);
  await processRuntime(env, [
    {
      entityId: id,
      signerId: signer,
      entityTxs: [{ type: 'chatMessage', data: { message: 'publish recovery peer', timestamp: env.state.timestamp } }],
    },
  ]);
  // A live Runtime polls its watcher right after import, so a fresh lazy wallet
  // starts from the authenticated state anchor before any financial work.
  await processJEvents(env);
  return { env, adapter, seed, id, signer };
};

const createPeer = async (
  hub: RecoveryActor,
  name: string,
  jurisdiction: JurisdictionConfig,
): Promise<RecoveryActor> => {
  if (jurisdiction.chainId === undefined) throw new Error('HTLC_RECOVERY_CHAIN_ID_MISSING');
  const env = createEmptyEnv(`${hub.seed}:${name}`);
  env.state.timestamp = hub.env.state.timestamp;
  env.scenarioMode = true;
  const adapter = await createJAdapter({
    mode: 'rpc',
    chainId: jurisdiction.chainId,
    rpcUrl: jurisdiction.address,
    fromReplica: {
      contracts: { ...hub.adapter.addresses },
      entityProviderDeploymentBlock: hub.adapter.entityProviderDeploymentBlock,
    },
  });
  const replica = bindScenarioJReplica(
    env,
    createJReplica(env, jurisdiction.name, adapter.addresses.depository),
    adapter,
  );
  replica.rpcs = [jurisdiction.address];
  adapter.startWatching(env);
  return importActor(env, adapter, jurisdiction);
};

export const createRecoveryNetwork = async (
  env: RuntimeReplica,
  adapter: JAdapter,
  jurisdiction: JurisdictionConfig,
) => {
  const bun = (globalThis as typeof globalThis & { Bun?: Pick<typeof import('bun'), 'serve'> }).Bun;
  if (!bun) throw new Error('HTLC_RECOVERY_REQUIRES_BUN_SERVER');
  const hub = await importActor(env, adapter, jurisdiction);
  const alice = await createPeer(hub, 'alice', jurisdiction);
  const bob = await createPeer(hub, 'bob', jurisdiction);
  const actors = [hub, alice, bob];
  const failures: string[] = [];
  const route = createDirectRuntimeWsRoute({
    runtimeId: hub.signer,
    runtimeSeed: hub.seed,
    onEntityInputs: (from, envelope, timestamp, sessionAuthenticated) => {
      routing.handleInboundP2PEntityInputs(hub.env, from, envelope, timestamp, {
        envelopeSourceVerified: sessionAuthenticated === true,
        entityInputsValidated: true,
      });
    },
    onDeliveryFailure: failure => {
      failures.push(failure.error);
    },
  });
  const server = bun.serve<{ type: 'direct-runtime' }>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, bunServer) {
      const decision = route.maybeUpgrade(request, bunServer);
      return decision.handled ? decision.response : new Response('websocket only', { status: 400 });
    },
    websocket: route.websocket,
  });
  const clients: RuntimeWsClient[] = [];
  const bindHub = () => {
    hub.env.infrastructure ??= {};
    hub.env.infrastructure.directEntityInputsDispatch = route.sendEntityInputsDelivery;
    hub.env.infrastructure.canDeliverEntityInputs = route.canDeliver;
  };
  bindHub();
  route.setReady(true);
  for (const actor of [alice, bob]) {
    const client = new RuntimeWsClient({
      url: `ws://127.0.0.1:${server.port}${route.path}`,
      runtimeId: actor.signer,
      helloAudience: directRuntimeWsAudience(hub.signer),
      signerId: '1',
      seed: actor.seed,
      encryptionKeyPair: deriveEncryptionKeyPair(actor.seed),
      getTargetEncryptionKey: () => deriveEncryptionKeyPair(hub.seed).publicKey,
      onEntityInputs: (from, envelope, timestamp, sessionAuthenticated) => {
        routing.handleInboundP2PEntityInputs(actor.env, from, envelope, timestamp, {
          envelopeSourceVerified: sessionAuthenticated === true,
          entityInputsValidated: true,
        });
      },
      onError: error => {
        failures.push(error.message);
      },
    });
    clients.push(client);
    actor.env.infrastructure ??= {};
    actor.env.infrastructure.canDeliverEntityInputs = id => id === hub.signer && client.canDeliver();
    actor.env.infrastructure.directEntityInputsDispatch = (id, envelope, timestamp) => {
      if (id !== hub.signer) throw new Error(`HTLC_RECOVERY_UNEXPECTED_ROUTE:${id}`);
      return client.sendEntityInputsRaw(id, envelope, timestamp)
        ? deliveryAccepted('P2P_DIRECT_DELIVERED')
        : deliveryDeferred({ outcome: 'deferred', code: 'P2P_DIRECT_RECIPIENT_NOT_READY' });
    };
    await client.connect();
    client.setReady(true);
    await pumpRecoveryActors([], () => client.canDeliver() && route.canDeliver(actor.signer), 'socket readiness');
  }
  const shareProfiles = async () => {
    for (const actor of actors) await announceCertifiedLocalProfiles(actor.env, [actor.id]);
    for (const actor of actors) {
      const profiles = actors.map(peer => {
        const profile = peer.env.gossip.getProfile(peer.id);
        if (!profile) throw new Error(`HTLC_RECOVERY_PROFILE_MISSING:${peer.id}`);
        return profile;
      });
      const discovery = new RuntimeP2P({
        env: actor.env,
        runtimeId: actor.signer,
        relayUrls: [],
        onEntityInputs: (from, envelope) => {
          routing.handleInboundP2PEntityInputs(actor.env, from, envelope);
        },
        onGossipProfiles: () => notifyRuntimeStateChanged(actor.env),
      });
      await discovery.admitSharedProfiles(profiles);
      discovery.close();
      const infrastructure = actor.env.infrastructure;
      const canDeliver = infrastructure?.canDeliverEntityInputs;
      if (!infrastructure || !canDeliver) throw new Error('HTLC_RECOVERY_TRANSPORT_MISSING');
      infrastructure.observeOnlineEntityIds = ids =>
        new Set(
          ids.filter(id => {
            const peer = actors.find(candidate => candidate.id === id);
            return peer !== undefined && (peer === actor || canDeliver(peer.signer));
          }),
        );
    }
  };
  await shareProfiles();
  return {
    hub,
    alice,
    bob,
    actors,
    route,
    bindHub,
    clients,
    shareProfiles,
    assertHealthy: () => {
      if (failures.length) throw new Error(`HTLC_RECOVERY_SOCKET_FAILURE:${failures.join('|')}`);
    },
    close: async () => {
      for (const client of clients) await client.closeAndWait();
      server.stop(true);
      for (const actor of actors) {
        await actor.adapter.close();
        await closeRuntimeDb(actor.env);
        await closeInfraDb(actor.env);
      }
    },
  };
};

export const openRecoveryAccount = async (a: RecoveryActor, b: RecoveryActor, actors: RecoveryActor[]) => {
  await processRuntime(a.env, [
    {
      entityId: a.id,
      signerId: a.signer,
      entityTxs: [
        {
          type: 'openAccount',
          data: {
            targetEntityId: b.id,
            creditAmount: 10_000n,
            tokenId: 1,
            disputeConfig: defaultAccountDisputeConfigForParties(a.id, false, b.id, false),
          },
        },
      ],
    },
  ]);
  await pumpRecoveryActors(
    actors,
    () => {
      const left = recoveryReplica(a).state.accounts.get(b.id);
      const right = recoveryReplica(b).state.accounts.get(a.id);
      return !!left && !!right && !left.pendingFrame && !right.pendingFrame && left.currentHeight > 0;
    },
    'open bilateral account',
  );
  await processRuntime(b.env, [
    {
      entityId: b.id,
      signerId: b.signer,
      entityTxs: [
        {
          type: 'extendCredit',
          data: { counterpartyEntityId: a.id, tokenId: 1, amount: 10_000n },
        },
      ],
    },
  ]);
  await pumpRecoveryActors(
    actors,
    () => {
      const left = recoveryReplica(a).state.accounts.get(b.id);
      const right = recoveryReplica(b).state.accounts.get(a.id);
      return !!left && !!right && !left.pendingFrame && !right.pendingFrame && left.currentHeight > 1;
    },
    'bilateral credit',
  );
};
