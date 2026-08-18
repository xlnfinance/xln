import type { EntityInfraContext } from '../../../types/entity/infra-context';
import type { EntityRuntimeContext } from '../../runtime-context';
import type { EntityReplica } from '../../types';
import type { EntityTx } from '../../../types/entity-tx';
import { canonicalizeProfile } from '../../profile';
import { compareStableText } from '../../../protocol/serialization';
import { timePerfPhase } from '../../../support/performance/profile';
import { getPrevFrameHash } from '../frame/lineage';
import { encodeCanonicalConsensusValue } from '../../../protocol/serialization/canonical-consensus-value';
import { LIMITS } from '../../../config/constants';
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

const entityTxNeedsHtlcInfra = (tx: EntityTx): boolean =>
  tx.type === 'htlcPayment' ||
  (tx.type === 'accountInput' && 'proposal' in tx.data &&
    tx.data.proposal.frame.accountTxs.some(accountTx =>
      accountTx.type === 'htlc_lock' || accountTx.type === 'htlc_resolve'));

/**
 * WAL contexts are keyed `replicaId:height`; frames written before that key
 * carried one context per replica under the bare replica id, so accept it when
 * its certified height is the one being replayed.
 */
const resolveReplayEntityContext = (
  env: EntityRuntimeContext,
  replicaId: string,
  height: number,
): EntityInfraContext | undefined => {
  const contexts = env.infrastructure?.replayEntityContexts;
  if (!contexts) return undefined;
  const exact = contexts.get(`${replicaId}:${height}`);
  if (exact) return exact;
  const legacy = contexts.get(replicaId);
  return legacy && legacy.height === height ? legacy : undefined;
};

/** True when the WAL holds the persisted context for this replica's next frame (replay). */
export const hasReplayEntityContext = (env: EntityRuntimeContext, replica: EntityReplica): boolean =>
  resolveReplayEntityContext(
    env,
    `${replica.entityId.trim().toLowerCase()}:${replica.signerId.trim().toLowerCase()}`,
    replica.state.height + 1,
  ) !== undefined;

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
  const htlcTxs = getEffectiveHtlcFrameTxs(replica.state, proposalTxs).filter(entityTxNeedsHtlcInfra);
  const needsHtlcInfra = htlcTxs.length > 0;
  const getProfiles = (env as ProposerInfraContext).gossip?.getProfiles;
  if (needsHtlcInfra && !getProfiles) throw new Error('ENTITY_INFRA_GOSSIP_UNAVAILABLE');
  // Gossip already stores canonicalizeProfile() outputs. This call is identity
  // on cache hit; a miss means a freshly built (not yet ingested) object.
  const profiles = needsHtlcInfra ? getProfiles!() : [];
  const routeEntityIds = new Set(htlcTxs.flatMap(tx =>
    tx.type === 'htlcPayment' ? tx.data.route.map(value => String(value).toLowerCase()) : []));
  const needsRouteResolution = htlcTxs.some(tx => tx.type === 'htlcPayment' && tx.data.route.length === 0);
  // A Hub that only forwards needs no profile bytes at all; canonicalizing
  // every stored profile per frame (thousands, many freshly re-announced) was
  // ~250 ms per Hub frame. Only originated-route peers are canonicalized;
  // route resolution inside materialization may touch any hop, so an
  // unrouted payment falls back to the full set.
  const originatedPeerIds = new Set<string>([entityId, ...routeEntityIds]);
  const canonicalProfiles = profiles
    .filter(profile => needsRouteResolution || originatedPeerIds.has(String(profile.entityId).toLowerCase()))
    .map(profile => canonicalizeProfile(profile));
  const observeOnlineEntityIds = env.infrastructure?.observeOnlineEntityIds;
  if (needsHtlcInfra && !observeOnlineEntityIds) throw new Error('ENTITY_INFRA_LIVENESS_OBSERVER_UNAVAILABLE');
  const observedOnline = new Map<string, boolean>();
  const profileEntityIds = new Set(profiles.map(profile => String(profile.entityId).toLowerCase()));
  // Profiles are pull-only, so a next hop can be routable before its profile
  // reached this Runtime. Without a profile the peer cannot enter the context
  // (validators require a profile per assertion), so it is simply "offline"
  // for this frame — the HTLC is rejected as next_hop_offline instead of the
  // whole proposal dying on ENTITY_INFRA_PROFILE_SET_INCOMPLETE — and the
  // profile is fetched in the background for the retry.
  const missingProfilePeers = new Set<string>();
  const isEntityOnline = (peerEntityId: string): boolean => {
    const canonical = peerEntityId.toLowerCase();
    const existing = observedOnline.get(canonical);
    if (existing !== undefined) return existing;
    if (!profileEntityIds.has(canonical)) {
      missingProfilePeers.add(canonical);
      return false;
    }
    const online = observeOnlineEntityIds!([canonical]).has(canonical);
    observedOnline.set(canonical, online);
    return online;
  };
  const graph = (env as ProposerInfraContext).gossip?.getNetworkGraph?.();
  if (needsRouteResolution && !graph) throw new Error('ENTITY_INFRA_ROUTE_RESOLVER_UNAVAILABLE');
  const resolveRoute = async (tx: Extract<EntityTx, { type: 'htlcPayment' }>): Promise<readonly string[]> => {
    const routes = await graph!.findPaths(entityId, tx.data.targetEntityId, tx.data.amount, tx.data.tokenId);
    const route = routes[0]?.path;
    if (!route) throw new Error(`HTLC_PAYMENT_ROUTE_NOT_FOUND:${entityId}:${tx.data.targetEntityId}`);
    return route;
  };
  const htlc = needsHtlcInfra
    ? await materializeHtlcPreparedInfraContext({
        state: replica.state,
        proposalTxs,
        entityEncryptionPublicKey: replica.state.entityEncryptionPublicKey,
        entityEncryptionPrivateKey: requireEntityEncryptionPrivateKey(env, entityId),
        isEntityOnline,
        profiles: canonicalProfiles,
        parentFrameHash: getPrevFrameHash(replica.state),
        height: replica.state.height + 1,
        resolveRoute,
      })
    : { version: 1 as const, entries: [], originated: [] };
  // Only originated routes need profiles in the context (validators replay
  // fee quotes and hop keys from them). Forward next hops and peer assertions
  // do not: embedding every next hop's signed profile made a Hub frame grow by
  // ~30 KB per payment and cost a profile signature check per hop.
  for (const originated of htlc.originated) {
    for (const routeEntityId of originated.route) routeEntityIds.add(routeEntityId);
    isEntityOnline(originated.nextHopEntityId);
  }
  if (missingProfilePeers.size > 0) {
    const missing = [...missingProfilePeers].sort(compareStableText);
    env.info('network', 'ENTITY_INFRA_NEXT_HOP_PROFILE_MISSING', { entityId, missing });
    const p2p = (env.infrastructure as { p2p?: { ensureProfiles?: (ids: string[]) => Promise<boolean> } } | undefined)?.p2p;
    void p2p?.ensureProfiles?.(missing)?.catch(() => undefined);
  }
  const gossipProfiles = canonicalProfiles
    .filter(profile => routeEntityIds.has(profile.entityId.toLowerCase()))
    .sort((left, right) => compareStableText(left.entityId, right.entityId));
  if (gossipProfiles.length !== routeEntityIds.size || new Set(gossipProfiles.map(profile => profile.entityId)).size !== gossipProfiles.length) {
    throw new Error('ENTITY_INFRA_PROFILE_SET_INCOMPLETE');
  }
  const peerAssertions = [...observedOnline.keys()]
    .sort(compareStableText)
    .map(peerEntityId => ({
      entityId: peerEntityId,
      online: observedOnline.get(peerEntityId) ?? isEntityOnline(peerEntityId),
    }));
  const context = validateEntityInfraContext({
    version: 1,
    proposerReplicaId: `${entityId}:${proposerSignerId}`,
    entityId,
    proposerSignerId,
    parentFrameHash: getPrevFrameHash(replica.state),
    height: replica.state.height + 1,
    gossipProfiles,
    peerAssertions,
    htlc,
  });
  await assertEntityInfraContextAuthority(env, context, replica.state);
  const byteLength = new TextEncoder().encode(encodeCanonicalConsensusValue(context)).byteLength;
  if (byteLength > LIMITS.MAX_FRAME_SIZE_BYTES) {
    throw new Error(`ENTITY_INFRA_CONTEXT_BYTE_LIMIT_EXCEEDED:${byteLength}:${LIMITS.MAX_FRAME_SIZE_BYTES}`);
  }
  return context;
});
