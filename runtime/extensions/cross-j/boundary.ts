import type { CrossJurisdictionSwapRoute, EntityInput, EntityTx } from '../../types';
import { getEffectiveEntityInputTxs } from '../../entity/consensus/output-envelope';

/**
 * Cross-j Entity messages are runtime-local only. The only admissible edges are
 * the two sibling pairs committed by the route:
 *
 *   source user <-> target user
 *   source hub  <-> target hub / canonical book owner
 *
 * The two same-jurisdiction edges are bilateral Account machines, never Entity
 * messages. Consequently no cross-j EntityTx is network-deliverable, even when
 * all four route participants happen to form a known two-runtime topology.
 */
export const CROSS_J_INTRA_RUNTIME_ENTITY_TX_TYPES = new Set<string>([
  'requestCrossJurisdictionSwap',
  'prepareCrossJurisdictionSwap',
  'commitCrossJurisdictionSwap',
  'registerCrossJurisdictionSwap',
  'crossJurisdictionFillNotice',
  'requestCrossJurisdictionClear',
  'crossPullClose',
  'crossJurisdictionSalvage',
  'orderbookSweepCrossJurisdiction',
  'admitCrossJurisdictionBookOrder',
  'removeCrossJurisdictionBookOrder',
]);

export const isCrossJurisdictionIntraRuntimeTx = (tx: EntityTx | { type?: unknown } | null | undefined): boolean =>
  CROSS_J_INTRA_RUNTIME_ENTITY_TX_TYPES.has(String(tx?.type || ''));

export const entityInputHasCrossJurisdictionIntraRuntimeTx = (
  input: Pick<EntityInput, 'entityTxs'> | null | undefined,
): boolean => input ? (
  (input.entityTxs ?? []).some(tx => tx.type === 'runtimeOutput' && tx.data.protocol === 'cross-j') ||
  getEffectiveEntityInputTxs(input).some(isCrossJurisdictionIntraRuntimeTx)
) : false;

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

export const isCrossJurisdictionSiblingPair = (
  route: CrossJurisdictionSwapRoute,
  sourceEntityId: string,
  targetEntityId: string,
): boolean => {
  const source = normalizeEntityRef(sourceEntityId);
  const target = normalizeEntityRef(targetEntityId);
  if (!source || !target || source === target) return false;
  const sourceUser = normalizeEntityRef(route.source?.entityId);
  const targetUser = normalizeEntityRef(route.target?.counterpartyEntityId);
  const sourceHub = normalizeEntityRef(route.source?.counterpartyEntityId);
  const targetHub = normalizeEntityRef(route.target?.entityId);
  return (
    (source === sourceUser && target === targetUser) ||
    (source === targetUser && target === sourceUser) ||
    (source === sourceHub && target === targetHub) ||
    (source === targetHub && target === sourceHub)
  );
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
  _route: CrossJurisdictionSwapRoute,
  _localRuntimeId: string | null | undefined,
  _remoteRuntimeId: string | null | undefined,
  _resolveRuntimeId: CrossJurisdictionRouteRuntimeResolver,
): boolean => {
  return false;
};

export const isCrossJurisdictionEntityInputRemoteHopAllowed = (
  input: Pick<EntityInput, 'entityTxs'>,
  localRuntimeId: string | null | undefined,
  remoteRuntimeId: string | null | undefined,
  resolveRuntimeId: CrossJurisdictionRouteRuntimeResolver,
): boolean => {
  let sawCrossJ = false;
  for (const tx of getEffectiveEntityInputTxs(input)) {
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
