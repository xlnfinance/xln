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
} from '../../paybook/materialize-context';
import { requireEntityEncryptionPrivateKey } from '../../auth/crypto';
import {
  assertEntityInfraContextAuthority,
  validateEntityInfraContext,
} from '../frame/infra-context-validation';

type ProposerInfraContext = EntityRuntimeContext & {
  gossip?: {
    getProfiles?: () => import('../../profile').Profile[];
    getProfile?: (entityId: string) => import('../../profile').Profile | undefined;
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

/** True while journal replay owns this frame: every proposer commit must then
 * consume its persisted context; nothing is materialized from live infra. */
export const replayEntityContextsInstalled = (env: EntityRuntimeContext): boolean =>
  env.infrastructure?.replayEntityContexts !== undefined;

/** WAL contexts are bound to the exact applying replica and certified height.
 * Replay never falls back to live materialization: a missing context means the
 * journal is incomplete, and re-materializing would be a second source of
 * truth that native replay cannot reproduce. */
const requireReplayEntityContext = (
  env: EntityRuntimeContext,
  replicaId: string,
  height: number,
): EntityInfraContext => {
  const contexts = env.infrastructure?.replayEntityContexts;
  if (!contexts) throw new Error(`ENTITY_REPLAY_CONTEXTS_NOT_INSTALLED:${replicaId}:${height}`);
  const context = contexts.get(`${replicaId}:${height}`);
  if (!context) throw new Error(`ENTITY_REPLAY_CONTEXT_MISSING:${replicaId}:${height}`);
  return context;
};

const createOnlineObservation = (
  hasProfile: (entityId: string) => boolean,
  observeOnlineEntityIds: (ids: readonly string[]) => ReadonlySet<string>,
): OnlineObservation => {
  const observed = new Map<string, boolean>();
  const missing = new Set<string>();
  return {
    observed,
    missing,
    isOnline(peerEntityId) {
      const canonical = peerEntityId.toLowerCase();
      const existing = observed.get(canonical);
      if (existing !== undefined) return existing;
      if (!hasProfile(canonical)) {
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
  getProfile: (entityId: string) => InfraProfile | undefined,
  allProfiles: readonly InfraProfile[],
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
    profiles: needsRouteResolution
      ? [...allProfiles]
      : [...originatedPeerIds].flatMap(id => {
          const profile = getProfile(id);
          return profile ? [profile] : [];
        }),
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
  const gossip = (env as ProposerInfraContext).gossip;
  const getProfiles = gossip?.getProfiles;
  const getProfile = gossip?.getProfile;
  if (needsHtlcInfra && (!getProfiles || !getProfile)) throw new Error('ENTITY_INFRA_GOSSIP_UNAVAILABLE');
  const needsRouteResolution = htlcTxs.some(
    tx => tx.type === 'htlcPayment' && tx.data.route.length === 0,
  );
  const allProfiles = needsRouteResolution ? getProfiles!() : [];
  const selected = selectInfraProfiles(entityId, htlcTxs, getProfile ?? (() => undefined), allProfiles);
  const observeOnlineEntityIds = env.infrastructure?.observeOnlineEntityIds;
  if (needsHtlcInfra && !observeOnlineEntityIds) {
    throw new Error('ENTITY_INFRA_LIVENESS_OBSERVER_UNAVAILABLE');
  }
  const online = createOnlineObservation(
    id => getProfile?.(id) !== undefined,
    observeOnlineEntityIds ?? (() => new Set()),
  );
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
  if (options.usePersistedReplayContext && replayEntityContextsInstalled(env)) {
    const replayContext = requireReplayEntityContext(
      env,
      `${entityId}:${proposerSignerId}`,
      replica.state.height + 1,
    );
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
