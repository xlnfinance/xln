/**
 * Exact wire decoder and deterministic selector for bounded Gossip batches.
 * Profiles and jurisdiction discovery share this request so relay and Runtime
 * cannot disagree about filters, limits, or optional discovery authority. [82/100]
 */

import { isHubProfile, type Profile } from '../../../entity/profile';
import { buildNetworkGraph, type NetworkGraph } from '../../../pathfinding/graph';
import { PathFinder } from '../../../pathfinding/pathfinding';
import { compareStableText } from '../../../protocol/serialization';
import {
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../../protocol/boundary-validation';

/**
 * Route-scoped discovery: the requester names a source and target and the
 * responder returns the profiles that make up to `maxRoutes` routes between
 * them (source/target profiles included when known). This is the default
 * pull-based lookup for user runtimes: nothing is pushed, a runtime asks for
 * exactly the chains it needs to pay someone.
 */
export type GossipRouteToRequest = {
  source: string;
  target: string;
  tokenId?: number;
  amount?: bigint;
  maxRoutes?: number;
};

export type GossipProfileBatchRequest = {
  ids?: string[];
  set?: 'default' | 'hubs';
  updatedSince?: number;
  limit?: number;
  includeJurisdictions?: boolean;
  routeTo?: GossipRouteToRequest;
};

export const DEFAULT_GOSSIP_BATCH_LIMIT = 1000;
export const MAX_GOSSIP_ROUTE_TO_ROUTES = 50;
export const DEFAULT_GOSSIP_ROUTE_TO_ROUTES = 50;
const MAX_ROUTE_TO_AMOUNT_DIGITS = 78;

const decodeRouteTo = (value: unknown): GossipRouteToRequest => {
  const routeTo = requireBoundaryRecord(value, 'P2P_GOSSIP_REQUEST_ROUTE_TO_INVALID');
  requireExactBoundaryKeys(
    routeTo,
    ['source', 'target'],
    ['tokenId', 'amount', 'maxRoutes'],
    'P2P_GOSSIP_REQUEST_ROUTE_TO_FIELDS_INVALID',
  );
  const source = routeTo['source'];
  const target = routeTo['target'];
  if (typeof source !== 'string' || source.length === 0 || source.length > 128
    || typeof target !== 'string' || target.length === 0 || target.length > 128) {
    throw new Error('P2P_GOSSIP_REQUEST_ROUTE_TO_ENDPOINTS_INVALID');
  }
  const tokenId = routeTo['tokenId'];
  if (tokenId !== undefined && (!Number.isSafeInteger(tokenId) || Number(tokenId) < 0)) {
    throw new Error('P2P_GOSSIP_REQUEST_ROUTE_TO_TOKEN_INVALID');
  }
  const amount = routeTo['amount'];
  if (amount !== undefined && (typeof amount !== 'string' || !/^[0-9]{1,78}$/.test(amount)
    || amount.length > MAX_ROUTE_TO_AMOUNT_DIGITS)) {
    throw new Error('P2P_GOSSIP_REQUEST_ROUTE_TO_AMOUNT_INVALID');
  }
  const maxRoutes = routeTo['maxRoutes'];
  if (maxRoutes !== undefined && (!Number.isSafeInteger(maxRoutes) || Number(maxRoutes) < 1)) {
    throw new Error('P2P_GOSSIP_REQUEST_ROUTE_TO_MAX_ROUTES_INVALID');
  }
  return {
    source: source.toLowerCase(),
    target: target.toLowerCase(),
    ...(tokenId === undefined ? {} : { tokenId: Number(tokenId) }),
    ...(amount === undefined ? {} : { amount: BigInt(amount) }),
    ...(maxRoutes === undefined ? {} : { maxRoutes: Math.min(MAX_GOSSIP_ROUTE_TO_ROUTES, Number(maxRoutes)) }),
  };
};

/** Wire form of a routeTo request (bigint amount travels as a decimal string). */
export const encodeRouteToRequest = (routeTo: GossipRouteToRequest): Record<string, unknown> => ({
  source: routeTo.source,
  target: routeTo.target,
  ...(routeTo.tokenId === undefined ? {} : { tokenId: routeTo.tokenId }),
  ...(routeTo.amount === undefined ? {} : { amount: routeTo.amount.toString() }),
  ...(routeTo.maxRoutes === undefined ? {} : { maxRoutes: routeTo.maxRoutes }),
});

export type RouteGraphCache = {
  get: (tokenId: number, profiles: readonly Profile[]) => NetworkGraph | undefined;
  set: (tokenId: number, profiles: readonly Profile[], graph: NetworkGraph) => void;
};

/**
 * Profiles that build up to `maxRoutes` routes from source to target. The graph
 * is only rebuilt when the profile array identity changes (callers hand a
 * stable array between announcements) so a busy responder answers many
 * lookups per rebuild.
 */
export const selectRouteProfiles = (
  profiles: readonly Profile[],
  routeTo: GossipRouteToRequest,
  graphCache?: RouteGraphCache,
): Profile[] => {
  const tokenId = routeTo.tokenId ?? 1;
  const profilesByEntityId = new Map(
    profiles.map(profile => [normalizeEntityId(profile.entityId), profile] as const),
  );
  const source = profilesByEntityId.get(routeTo.source);
  const target = profilesByEntityId.get(routeTo.target);
  const selected = new Map<string, Profile>();
  if (target) selected.set(routeTo.target, target);
  if (!source || !target) return Array.from(selected.values());
  let graph = graphCache?.get(tokenId, profiles);
  if (!graph) {
    graph = buildNetworkGraph(new Map(profiles.map(profile => [profile.entityId, profile] as const)), tokenId);
    graphCache?.set(tokenId, profiles, graph);
  }
  const routes = new PathFinder(graph).findRoutes(
    source.entityId,
    target.entityId,
    routeTo.amount ?? 1n,
    tokenId,
    Math.min(MAX_GOSSIP_ROUTE_TO_ROUTES, routeTo.maxRoutes ?? DEFAULT_GOSSIP_ROUTE_TO_ROUTES),
  );
  for (const route of routes) {
    for (const entityId of route.path) {
      const normalized = normalizeEntityId(entityId);
      if (normalized === routeTo.source) continue;
      const profile = profilesByEntityId.get(normalized);
      if (profile) selected.set(normalized, profile);
    }
  }
  return Array.from(selected.values());
};

/** Single-entry graph memo keyed by profile array identity + tokenId. */
export const createRouteGraphCache = (): RouteGraphCache => {
  let cached: { tokenId: number; profiles: readonly Profile[]; graph: NetworkGraph } | undefined;
  return {
    get: (tokenId, profiles) =>
      cached && cached.tokenId === tokenId && cached.profiles === profiles ? cached.graph : undefined,
    set: (tokenId, profiles, graph) => { cached = { tokenId, profiles, graph }; },
  };
};

export const decodeGossipProfileBatchRequest = (value: unknown): GossipProfileBatchRequest => {
  const request = requireBoundaryRecord(value, 'P2P_GOSSIP_REQUEST_INVALID');
  requireExactBoundaryKeys(
    request,
    [],
    ['ids', 'set', 'updatedSince', 'limit', 'includeJurisdictions', 'routeTo'],
    'P2P_GOSSIP_REQUEST_FIELDS_INVALID',
  );
  const routeTo = request['routeTo'] === undefined ? undefined : decodeRouteTo(request['routeTo']);
  const ids = request['ids'];
  if (ids !== undefined && (!Array.isArray(ids) || ids.some(
    id => typeof id !== 'string' || id.length > 128,
  ))) throw new Error('P2P_GOSSIP_REQUEST_IDS_INVALID');
  const set = request['set'];
  if (set !== undefined && set !== 'default' && set !== 'hubs') {
    throw new Error('P2P_GOSSIP_REQUEST_SET_INVALID');
  }
  for (const field of ['updatedSince', 'limit'] as const) {
    const candidate = request[field];
    if (candidate !== undefined && (!Number.isSafeInteger(candidate) || Number(candidate) < 0)) {
      throw new Error(`P2P_GOSSIP_REQUEST_${field.toUpperCase()}_INVALID`);
    }
  }
  const includeJurisdictions = request['includeJurisdictions'];
  if (includeJurisdictions !== undefined && typeof includeJurisdictions !== 'boolean') {
    throw new Error('P2P_GOSSIP_REQUEST_INCLUDE_JURISDICTIONS_INVALID');
  }
  return {
    ...(ids === undefined ? {} : { ids: [...ids] }),
    ...(set === undefined ? {} : { set }),
    ...(request['updatedSince'] === undefined ? {} : { updatedSince: Number(request['updatedSince']) }),
    ...(request['limit'] === undefined ? {} : { limit: Number(request['limit']) }),
    ...(includeJurisdictions === undefined ? {} : { includeJurisdictions }),
    ...(routeTo === undefined ? {} : { routeTo }),
  };
};

const normalizeEntityId = (entityId: unknown): string => String(entityId || '').toLowerCase();

const sortProfilesForBatch = (left: Profile, right: Profile): number => {
  const leftHub = isHubProfile(left);
  const rightHub = isHubProfile(right);
  if (leftHub !== rightHub) return leftHub ? -1 : 1;
  const leftTs = left.lastUpdated;
  const rightTs = right.lastUpdated;
  if (leftTs !== rightTs) return rightTs - leftTs;
  return compareStableText(String(left.entityId), String(right.entityId));
};

export const selectProfileBatch = (
  profiles: readonly Profile[],
  request: GossipProfileBatchRequest = {},
  defaultLimit: number = DEFAULT_GOSSIP_BATCH_LIMIT,
  graphCache?: RouteGraphCache,
): Profile[] => {
  const maxBatchSize = Math.max(1, Math.floor(defaultLimit));
  const explicitMatches = new Map<string, Profile>();
  const setMatches = new Map<string, Profile>();
  const ids = Array.isArray(request.ids)
    ? Array.from(
        new Set(
          request.ids
            .map(normalizeEntityId)
            .filter((entityId) => entityId.length > 0),
        ),
      ).slice(0, maxBatchSize)
    : [];
  const routeTo = request.routeTo;
  const set = request.set ?? (ids.length === 0 && routeTo === undefined ? 'default' : undefined);
  const updatedSince = typeof request.updatedSince === 'number' && Number.isFinite(request.updatedSince)
    ? request.updatedSince
    : null;
  const boundedLimit = typeof request.limit === 'number' && Number.isFinite(request.limit)
    ? Math.min(maxBatchSize, Math.max(1, Math.floor(request.limit)))
    : maxBatchSize;

  const profilesByEntityId = new Map(
    profiles.map(profile => [normalizeEntityId(profile.entityId), profile] as const),
  );
  for (const entityId of ids) {
    const profile = profilesByEntityId.get(entityId);
    if (profile) {
      explicitMatches.set(entityId, profile);
    }
  }

  let setProfiles: Profile[] = [];
  if (set === 'hubs') {
    setProfiles = [...profiles]
      .filter(isHubProfile)
      .sort(sortProfilesForBatch)
      .slice(0, boundedLimit);
  } else if (set === 'default') {
    setProfiles = [...profiles]
      .sort(sortProfilesForBatch)
      .slice(0, boundedLimit);
  }

  for (const profile of setProfiles) {
    const normalizedEntityId = normalizeEntityId(profile.entityId);
    if (updatedSince !== null && profile.lastUpdated <= updatedSince) {
      continue;
    }
    setMatches.set(normalizedEntityId, profile);
  }

  const routeMatches = new Map<string, Profile>();
  if (routeTo !== undefined) {
    for (const profile of selectRouteProfiles(profiles, routeTo, graphCache)) {
      routeMatches.set(normalizeEntityId(profile.entityId), profile);
    }
  }

  return Array.from(new Map<string, Profile>([...setMatches, ...routeMatches, ...explicitMatches]).values())
    .sort(sortProfilesForBatch)
    .slice(0, maxBatchSize);
};
