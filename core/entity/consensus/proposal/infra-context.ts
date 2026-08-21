import type { EntityInfraContext } from '../../../types/entity/infra-context';
import type { EntityRuntimeContext } from '../../runtime-context';
import type { EntityReplica } from '../../types';
import type { EntityTx } from '../../../types/entity-tx';
import { compareStableText } from '../../../protocol/serialization';
import { timePerfPhase } from '../../../support/performance/profile';
import { getPrevFrameHash } from '../frame/lineage';


import {
  getEffectiveHtlcFrameTxs,
  materializeHtlcPreparedInfraContext,
} from '../../htlc/materialize-context';
import { requireEntityEncryptionPrivateKey } from '../../auth/crypto';
import {
  assertEntityInfraContextAuthority,
  validateEntityInfraContext,
} from '../frame/infra-context-validation';

type ProposerInfraContext = EntityRuntimeContext & {
  gossip?: {
    getProfiles?: () => import('../../profile').Profile[];
    getNetworkGraph?: () => {
      findPaths: (source: string, target: string, amount?: bigint, tokenId?: number) =>
        Promise<Array<{ path: string[] }>>;
    };
  };
};

type InfraProfile = import('../../profile').Profile;

type OnlineObservation = Readonly<{
  observed: Map<string, boolean>;
  missing: Set<string>;
  isOnline(peerEntityId: string): boolean;
}>;

const entityTxNeedsHtlcInfra = (tx: EntityTx): boolean =>
  tx.type === 'htlcPayment' ||
  (tx.type === 'accountInput' && 'proposal' in tx.data &&
    tx.data.proposal.frame.accountTxs.some(accountTx =>
      accountTx.type === 'htlc_lock' || accountTx.type === 'htlc_resolve'));

/** WAL contexts are bound to the exact applying replica and certified height. */
const resolveReplayEntityContext = (
  env: EntityRuntimeContext,
  replicaId: string,
  height: number,
): EntityInfraContext | undefined => {
  const contexts = env.infrastructure?.replayEntityContexts;
  if (!contexts) return undefined;
  return contexts.get(`${replicaId}:${height}`);
};

/** True when the WAL holds the persisted context for this replica's next frame (replay). */
export const hasReplayEntityContext = (env: EntityRuntimeContext, replica: EntityReplica): boolean =>
  resolveReplayEntityContext(
    env,
    `${replica.entityId.trim().toLowerCase()}:${replica.signerId.trim().toLowerCase()}`,
    replica.state.height + 1,
  ) !== undefined;

const createOnlineObservation = (
  profiles: readonly InfraProfile[],
  observeOnlineEntityIds: (ids: readonly string[]) => ReadonlySet<string>,
): OnlineObservation => {
  const observed = new Map<string, boolean>();
  const missing = new Set<string>();
  const profileEntityIds = new Set(profiles.map(profile => String(profile.entityId).toLowerCase()));
  return {
    observed,
    missing,
    isOnline(peerEntityId) {
      const canonical = peerEntityId.toLowerCase();
      const existing = observed.get(canonical);
      if (existing !== undefined) return existing;
      if (!profileEntityIds.has(canonical)) {
        missing.add(canonical);
        return false;
      }
      const online = observeOnlineEntityIds([canonical]).has(canonical);
      observed.set(canonical, online);
      return online;
    },
  };
};

const selectInfraProfiles = (
  entityId: string,
  htlcTxs: readonly EntityTx[],
  profiles: readonly InfraProfile[],
): { profiles: InfraProfile[]; routeEntityIds: Set<string>; needsRouteResolution: boolean } => {
  const routeEntityIds = new Set(htlcTxs.flatMap(tx =>
    tx.type === 'htlcPayment' ? tx.data.route.map(value => String(value).toLowerCase()) : []));
  const needsRouteResolution = htlcTxs.some(
    tx => tx.type === 'htlcPayment' && tx.data.route.length === 0,
  );
  const originatedPeerIds = new Set<string>([entityId, ...routeEntityIds]);
  return {
    routeEntityIds,
    needsRouteResolution,
    profiles: profiles.filter(profile =>
      needsRouteResolution || originatedPeerIds.has(String(profile.entityId).toLowerCase())),
  };
};

const requestMissingProfiles = (
  env: EntityRuntimeContext,
  entityId: string,
  missingProfilePeers: ReadonlySet<string>,
): void => {
  if (missingProfilePeers.size === 0) return;
  const missing = [...missingProfilePeers].sort(compareStableText);
  env.info('network', 'ENTITY_INFRA_NEXT_HOP_PROFILE_MISSING', { entityId, missing });
  const p2p = (env.infrastructure as {
    p2p?: { ensureProfiles?: (ids: string[]) => Promise<boolean> };
  } | undefined)?.p2p;
  void p2p?.ensureProfiles?.(missing)?.catch(() => undefined);
};

const materializeFreshEntityInfraContext = async (
  env: EntityRuntimeContext,
  replica: EntityReplica,
  proposalTxs: readonly EntityTx[],
): Promise<EntityInfraContext> => {
  const entityId = replica.entityId.trim().toLowerCase();
  const proposerSignerId = replica.signerId.trim().toLowerCase();
  const htlcTxs = getEffectiveHtlcFrameTxs(replica.state, proposalTxs).filter(entityTxNeedsHtlcInfra);
  const needsHtlcInfra = htlcTxs.length > 0;
  const getProfiles = (env as ProposerInfraContext).gossip?.getProfiles;
  if (needsHtlcInfra && !getProfiles) throw new Error('ENTITY_INFRA_GOSSIP_UNAVAILABLE');
  const allProfiles = needsHtlcInfra ? getProfiles!() : [];
  const selected = selectInfraProfiles(entityId, htlcTxs, allProfiles);
  const observeOnlineEntityIds = env.infrastructure?.observeOnlineEntityIds;
  if (needsHtlcInfra && !observeOnlineEntityIds) {
    throw new Error('ENTITY_INFRA_LIVENESS_OBSERVER_UNAVAILABLE');
  }
  const online = createOnlineObservation(allProfiles, observeOnlineEntityIds ?? (() => new Set()));
  const graph = (env as ProposerInfraContext).gossip?.getNetworkGraph?.();
  if (selected.needsRouteResolution && !graph) throw new Error('ENTITY_INFRA_ROUTE_RESOLVER_UNAVAILABLE');
  const resolveRoute = async (
    tx: Extract<EntityTx, { type: 'htlcPayment' }>,
  ): Promise<readonly string[]> => {
    const routes = await graph!.findPaths(entityId, tx.data.targetEntityId, tx.data.amount, tx.data.tokenId);
    const route = routes[0]?.path;
    if (!route) throw new Error(`HTLC_PAYMENT_ROUTE_NOT_FOUND:${entityId}:${tx.data.targetEntityId}`);
    return route;
  };
  const htlc = needsHtlcInfra
    ? await timePerfPhase('entity.infraMaterialize.htlc', () => materializeHtlcPreparedInfraContext({
        state: replica.state,
        proposalTxs,
        entityEncryptionPublicKey: replica.state.entityEncryptionPublicKey,
        entityEncryptionPrivateKey: requireEntityEncryptionPrivateKey(env, entityId),
        isEntityOnline: online.isOnline,
        profiles: selected.profiles,
        parentFrameHash: getPrevFrameHash(replica.state),
        height: replica.state.height + 1,
        resolveRoute,
      }))
    : { version: 1 as const, entries: [], originated: [] };
  for (const originated of htlc.originated) {
    for (const routeEntityId of originated.route) selected.routeEntityIds.add(routeEntityId);
    online.isOnline(originated.nextHopEntityId);
  }
  requestMissingProfiles(env, entityId, online.missing);
  const gossipProfiles = selected.profiles
    .filter(profile => selected.routeEntityIds.has(profile.entityId.toLowerCase()))
    .sort((left, right) => compareStableText(left.entityId, right.entityId));
  if (
    gossipProfiles.length !== selected.routeEntityIds.size ||
    new Set(gossipProfiles.map(profile => profile.entityId)).size !== gossipProfiles.length
  ) throw new Error('ENTITY_INFRA_PROFILE_SET_INCOMPLETE');
  const peerAssertions = [...online.observed.keys()].sort(compareStableText).map(peerEntityId => ({
    entityId: peerEntityId,
    online: online.observed.get(peerEntityId) ?? online.isOnline(peerEntityId),
  }));
  return timePerfPhase('entity.infraMaterialize.validate', () => validateEntityInfraContext({
    version: 1,
    proposerReplicaId: `${entityId}:${proposerSignerId}`,
    entityId,
    proposerSignerId,
    parentFrameHash: getPrevFrameHash(replica.state),
    height: replica.state.height + 1,
    gossipProfiles,
    peerAssertions,
    htlc,
  }));
};

/** Materialize public infrastructure only after the proposer fixes exact frame txs. */
export const materializeEntityInfraContext = async (
  env: EntityRuntimeContext,
  replica: EntityReplica,
  proposalTxs: readonly EntityTx[],
  // The caller must state whether these txs belong to the external Entity
  // input recorded by the WAL or to a Runtime-derived follow-up frame. A
  // default is unsafe: an omitted flag previously made multi-signer H+1
  // account-work reuse the external H context during replay.
  options: { usePersistedReplayContext: boolean },
): Promise<EntityInfraContext> => timePerfPhase('entity.infraMaterialize', async () => {
  const entityId = replica.entityId.trim().toLowerCase();
  const proposerSignerId = replica.signerId.trim().toLowerCase();
  const replayContext = !options.usePersistedReplayContext
    ? undefined
    : resolveReplayEntityContext(env, `${entityId}:${proposerSignerId}`, replica.state.height + 1);
  if (replayContext) {
    const decodedReplayContext = validateEntityInfraContext(replayContext);
    await assertEntityInfraContextAuthority(env, decodedReplayContext, replica.state);
    return structuredClone(decodedReplayContext);
  }
  const context = await materializeFreshEntityInfraContext(env, replica, proposalTxs);
  // validateEntityInfraContext already enforces MAX_FRAME_SIZE_BYTES on the
  // canonical encoding; re-encoding a multi-MB Hub context here was pure cost.
  await timePerfPhase('entity.infraMaterialize.authority', () =>
    assertEntityInfraContextAuthority(env, context, replica.state));
  return context;
});
