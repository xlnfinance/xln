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
  limit?: number;
  includeJurisdictions?: boolean;
  routeTo?: GossipRouteToRequest;
  /**
   * Neighbourhood depth for `ids`: 1 returns the named profiles only, 2 adds
   * their publicAccounts peers, 3 the peers of those. Lets a sender see the
   * surroundings of a target and pick a route itself.
   */
  depth?: number;
  /**
   * Masked lookup: every profile whose entityId starts with `prefix`, ordered
   * by entityId, at most `limit` (default 100) per page, continuing after the
   * exclusive `after` cursor. The responder never learns which one is wanted.
   */
  prefix?: string;
  after?: string;
  /**
   * Relay sequence cursor: only profiles the responder stored after this
   * sequence are returned. A profile-clock watermark is deliberately not a
   * sync primitive: independent Runtime clocks can otherwise hide a valid
   * profile forever. The response carries the exact next cursor.
   */
  sinceSeq?: number;
};

export const DEFAULT_GOSSIP_BATCH_LIMIT = 1000;
export const MAX_GOSSIP_IDS_DEPTH = 3;
export const DEFAULT_GOSSIP_PREFIX_LIMIT = 100;
const MIN_GOSSIP_PREFIX_CHARS = 4;
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
const selectRouteProfiles = (
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
    ['ids', 'set', 'limit', 'includeJurisdictions', 'routeTo', 'sinceSeq', 'depth', 'prefix', 'after'],
    'P2P_GOSSIP_REQUEST_FIELDS_INVALID',
  );
  const routeTo = request['routeTo'] === undefined ? undefined : decodeRouteTo(request['routeTo']);
  const ids = request['ids'];
  if (ids !== undefined && (
    !Array.isArray(ids) ||
    ids.length > DEFAULT_GOSSIP_BATCH_LIMIT ||
    ids.some(id => typeof id !== 'string' || id.length > 128)
  )) throw new Error('P2P_GOSSIP_REQUEST_IDS_INVALID');
  const set = request['set'];
  if (set !== undefined && set !== 'default' && set !== 'hubs') {
    throw new Error('P2P_GOSSIP_REQUEST_SET_INVALID');
  }
  const depth = request['depth'];
  if (depth !== undefined && (!Number.isSafeInteger(depth) || Number(depth) < 1 || Number(depth) > MAX_GOSSIP_IDS_DEPTH)) {
    throw new Error('P2P_GOSSIP_REQUEST_DEPTH_INVALID');
  }
  const prefix = request['prefix'];
  if (prefix !== undefined && (typeof prefix !== 'string' || !/^0x[0-9a-fA-F]{2,64}$/.test(prefix)
    || prefix.length < 2 + MIN_GOSSIP_PREFIX_CHARS)) {
    throw new Error('P2P_GOSSIP_REQUEST_PREFIX_INVALID');
  }
  const after = request['after'];
  if (after !== undefined && (typeof after !== 'string' || after.length > 128)) {
    throw new Error('P2P_GOSSIP_REQUEST_AFTER_INVALID');
  }
  for (const field of ['limit', 'sinceSeq'] as const) {
    const candidate = request[field];
    if (candidate !== undefined && (!Number.isSafeInteger(candidate) || Number(candidate) < 0)) {
      throw new Error(`P2P_GOSSIP_REQUEST_${field.toUpperCase()}_INVALID`);
    }
  }
  const includeJurisdictions = request['includeJurisdictions'];
  if (includeJurisdictions !== undefined && typeof includeJurisdictions !== 'boolean') {
    throw new Error('P2P_GOSSIP_REQUEST_INCLUDE_JURISDICTIONS_INVALID');
  }
  if (request['sinceSeq'] !== undefined && (ids !== undefined || routeTo !== undefined || prefix !== undefined)) {
    throw new Error('P2P_GOSSIP_REQUEST_CURSOR_SCOPE_INVALID');
  }
  return {
    ...(ids === undefined ? {} : { ids: [...ids] }),
    ...(set === undefined ? {} : { set }),
    ...(request['limit'] === undefined ? {} : { limit: Number(request['limit']) }),
    ...(request['sinceSeq'] === undefined ? {} : { sinceSeq: Number(request['sinceSeq']) }),
    ...(depth === undefined ? {} : { depth: Number(depth) }),
    ...(prefix === undefined ? {} : { prefix: prefix.toLowerCase() }),
    ...(after === undefined ? {} : { after: after.toLowerCase() }),
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
  const prefix = request.prefix;
  const set = request.set ?? (ids.length === 0 && routeTo === undefined && prefix === undefined ? 'default' : undefined);
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
  // Neighbourhood expansion: peers of the named profiles, breadth-first, up to
  // `depth` levels and the batch cap.
  const depth = Math.min(MAX_GOSSIP_IDS_DEPTH, Math.max(1, Math.floor(request.depth ?? 1)));
  let frontier = Array.from(explicitMatches.values());
  for (let level = 1; level < depth && frontier.length > 0 && explicitMatches.size < maxBatchSize; level += 1) {
    const next: Profile[] = [];
    for (const profile of frontier) {
      for (const peerId of profile.publicAccounts) {
        const normalizedPeerId = normalizeEntityId(peerId);
        if (explicitMatches.has(normalizedPeerId)) continue;
        const peer = profilesByEntityId.get(normalizedPeerId);
        if (!peer) continue;
        explicitMatches.set(normalizedPeerId, peer);
        next.push(peer);
        if (explicitMatches.size >= maxBatchSize) break;
      }
      if (explicitMatches.size >= maxBatchSize) break;
    }
    frontier = next;
  }

  const prefixMatches: Profile[] = [];
  if (prefix !== undefined) {
    const after = request.after ?? '';
    const pageLimit = typeof request.limit === 'number' && Number.isFinite(request.limit)
      ? Math.min(maxBatchSize, Math.max(1, Math.floor(request.limit)))
      : Math.min(maxBatchSize, DEFAULT_GOSSIP_PREFIX_LIMIT);
    prefixMatches.push(...Array.from(profilesByEntityId.entries())
      .filter(([entityId]) => entityId.startsWith(prefix) && entityId > after)
      .sort(([left], [right]) => compareStableText(left, right))
      .slice(0, pageLimit)
      .map(([, profile]) => profile));
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
    setMatches.set(normalizedEntityId, profile);
  }

  const routeMatches = new Map<string, Profile>();
  if (routeTo !== undefined) {
    for (const profile of selectRouteProfiles(profiles, routeTo, graphCache)) {
      routeMatches.set(normalizeEntityId(profile.entityId), profile);
    }
  }

  if (prefix !== undefined && setMatches.size === 0 && routeMatches.size === 0 && explicitMatches.size === 0) {
    // A masked page keeps its entityId order so the caller can continue with
    // `after` = last returned id.
    return prefixMatches;
  }
  const prefixById = new Map(prefixMatches.map(profile => [normalizeEntityId(profile.entityId), profile] as const));
  return Array.from(new Map<string, Profile>([...setMatches, ...routeMatches, ...prefixById, ...explicitMatches]).values())
    .sort(sortProfilesForBatch)
    .slice(0, maxBatchSize);
};
