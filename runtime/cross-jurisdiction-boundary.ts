import type { CrossJurisdictionSwapRoute, EntityInput, EntityTx } from './types';

/**
 * Cross-j swaps are a two-runtime system protocol.
 *
 * V1 deliberately supports exactly two runtime groups:
 * - user runtime: source user entity + target user sibling entity;
 * - hub runtime: source hub entity + target hub sibling entity/book owner.
 *
 * This is not generic P2P delivery between arbitrary entities. A cross-j system
 * tx may cross the network only when its route proves the sender/receiver are
 * the two paired runtimes above. Route-less cross-j maintenance txs stay local.
 *
 * The comments here are intentionally strict: allowing three or more runtimes
 * would require a separate signed inter-entity authorization and replay model.
 */
export const CROSS_J_INTRA_RUNTIME_ENTITY_TX_TYPES = new Set<string>([
  'requestCrossJurisdictionSwap',
  'prepareCrossJurisdictionSwap',
  'commitCrossJurisdictionSwap',
  'registerCrossJurisdictionSwap',
  'crossJurisdictionFillNotice',
  'requestCrossJurisdictionClear',
  'crossJurisdictionSalvage',
  'orderbookSweepCrossJurisdiction',
  'removeCrossJurisdictionBookOrder',
]);

export const isCrossJurisdictionIntraRuntimeTx = (tx: EntityTx | { type?: unknown } | null | undefined): boolean =>
  CROSS_J_INTRA_RUNTIME_ENTITY_TX_TYPES.has(String(tx?.type || ''));

export const entityInputHasCrossJurisdictionIntraRuntimeTx = (
  input: Pick<EntityInput, 'entityTxs'> | null | undefined,
): boolean => (input?.entityTxs || []).some(isCrossJurisdictionIntraRuntimeTx);

const normalizeEntityRef = (value: unknown): string => String(value || '').trim().toLowerCase();
const normalizeRuntimeRef = (value: unknown): string => String(value || '').trim().toLowerCase();

export type CrossJurisdictionRouteRuntimeResolver = (entityId: string) => string | null | undefined;

export type CrossJurisdictionRuntimeTopology = {
  sourceUserRuntimeId: string;
  targetUserRuntimeId: string;
  sourceHubRuntimeId: string;
  targetHubRuntimeId: string;
  userRuntimeId: string;
  hubRuntimeId: string;
};

export const extractCrossJurisdictionRouteFromTx = (
  tx: EntityTx | { data?: unknown } | null | undefined,
): CrossJurisdictionSwapRoute | null => {
  const data = (tx as { data?: unknown } | null | undefined)?.data;
  if (!data || typeof data !== 'object') return null;
  const route = (data as { route?: unknown }).route;
  return route && typeof route === 'object' ? route as CrossJurisdictionSwapRoute : null;
};

export const getCrossJurisdictionRouteEntityIds = (route: CrossJurisdictionSwapRoute): string[] => {
  const ids = [
    route.source?.entityId,
    route.target?.counterpartyEntityId,
    route.source?.counterpartyEntityId,
    route.target?.entityId,
    route.bookOwnerEntityId,
    route.hubEntityId,
  ].map(normalizeEntityRef).filter(Boolean);
  return [...new Set(ids)];
};

export const resolveCrossJurisdictionRuntimeTopology = (
  route: CrossJurisdictionSwapRoute,
  resolveRuntimeId: CrossJurisdictionRouteRuntimeResolver,
): CrossJurisdictionRuntimeTopology | null => {
  const sourceUserId = normalizeEntityRef(route.source?.entityId);
  const targetUserId = normalizeEntityRef(route.target?.counterpartyEntityId);
  const sourceHubId = normalizeEntityRef(route.source?.counterpartyEntityId);
  const targetHubId = normalizeEntityRef(route.target?.entityId);
  if (!sourceUserId || !targetUserId || !sourceHubId || !targetHubId) return null;

  const sourceUserRuntimeId = normalizeRuntimeRef(resolveRuntimeId(sourceUserId));
  const targetUserRuntimeId = normalizeRuntimeRef(resolveRuntimeId(targetUserId));
  const sourceHubRuntimeId = normalizeRuntimeRef(resolveRuntimeId(sourceHubId));
  const targetHubRuntimeId = normalizeRuntimeRef(resolveRuntimeId(targetHubId));
  if (!sourceUserRuntimeId || !targetUserRuntimeId || !sourceHubRuntimeId || !targetHubRuntimeId) return null;
  if (sourceUserRuntimeId !== targetUserRuntimeId) return null;
  if (sourceHubRuntimeId !== targetHubRuntimeId) return null;
  if (sourceUserRuntimeId === sourceHubRuntimeId) return null;

  const bookOwnerId = normalizeEntityRef(route.bookOwnerEntityId || route.source?.counterpartyEntityId || route.hubEntityId);
  if (bookOwnerId) {
    const bookOwnerRuntimeId = normalizeRuntimeRef(resolveRuntimeId(bookOwnerId));
    if (!bookOwnerRuntimeId || bookOwnerRuntimeId !== sourceHubRuntimeId) return null;
  }

  return {
    sourceUserRuntimeId,
    targetUserRuntimeId,
    sourceHubRuntimeId,
    targetHubRuntimeId,
    userRuntimeId: sourceUserRuntimeId,
    hubRuntimeId: sourceHubRuntimeId,
  };
};

export const isCrossJurisdictionRouteRemoteHopAllowed = (
  route: CrossJurisdictionSwapRoute,
  localRuntimeId: string | null | undefined,
  remoteRuntimeId: string | null | undefined,
  resolveRuntimeId: CrossJurisdictionRouteRuntimeResolver,
): boolean => {
  const local = normalizeRuntimeRef(localRuntimeId);
  const remote = normalizeRuntimeRef(remoteRuntimeId);
  if (!local || !remote || local === remote) return false;

  const topology = resolveCrossJurisdictionRuntimeTopology(route, resolveRuntimeId);
  if (!topology) return false;

  return (
    (local === topology.userRuntimeId && remote === topology.hubRuntimeId) ||
    (local === topology.hubRuntimeId && remote === topology.userRuntimeId)
  );
};

export const isCrossJurisdictionEntityInputRemoteHopAllowed = (
  input: Pick<EntityInput, 'entityTxs'>,
  localRuntimeId: string | null | undefined,
  remoteRuntimeId: string | null | undefined,
  resolveRuntimeId: CrossJurisdictionRouteRuntimeResolver,
): boolean => {
  let sawCrossJ = false;
  for (const tx of input.entityTxs || []) {
    if (!isCrossJurisdictionIntraRuntimeTx(tx)) continue;
    sawCrossJ = true;
    const route = extractCrossJurisdictionRouteFromTx(tx);
    if (!route) return false;
    if (!isCrossJurisdictionRouteRemoteHopAllowed(route, localRuntimeId, remoteRuntimeId, resolveRuntimeId)) {
      return false;
    }
  }
  return sawCrossJ;
};
