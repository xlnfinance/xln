import type { CrossJurisdictionSwapRoute } from '../../types/cross-jurisdiction';
import type { EntityInput } from '../../entity/types';
import type { EntityTx } from '../../types/entity-tx';
import { getEffectiveEntityInputTxs } from '../../entity/consensus/output/envelope';

/**
 * Cross-j Entity effects travel only as one committed Runtime output. The
 * admissible Entity edges are the two sibling pairs committed by the route:
 *
 *   source user <-> target user
 *   source hub  <-> target hub / canonical book owner
 *
 * The two same-jurisdiction edges are bilateral Account machines, never Entity
 * messages. A raw cross-j EntityTx is never network-deliverable; Runtime wraps
 * it after the source Entity frame commits and authenticates the source Runtime.
 */
const CROSS_J_INTRA_RUNTIME_ENTITY_TX_TYPES = new Set<string>([
  'prepareCrossJurisdictionSwap',
  'materializeCrossJurisdictionSwap',
  'registerCrossJurisdictionSwap',
  'crossJurisdictionFillNotice',
  'requestCrossJurisdictionClear',
  'materializeCrossJurisdictionClear',
  'crossPullClose',
  'crossJurisdictionSalvage',
  'crossJurisdictionForceSiblingDispute',
  'orderbookSweepCrossJurisdiction',
  'admitCrossJurisdictionBookOrder',
  'removeCrossJurisdictionBookOrder',
  'crossJurisdictionBookOrderRemoved',
]);

const isCrossJurisdictionIntraRuntimeTx = (tx: EntityTx | { type?: unknown } | null | undefined): boolean =>
  CROSS_J_INTRA_RUNTIME_ENTITY_TX_TYPES.has(String(tx?.type || ''));

export const entityInputHasCrossJurisdictionIntraRuntimeTx = (
  input: Pick<EntityInput, 'entityTxs'> | null | undefined,
): boolean => input ? (
  (input.entityTxs ?? []).some(tx => tx.type === 'runtimeOutput' && tx.data.protocol === 'cross-j') ||
  getEffectiveEntityInputTxs(input).some(isCrossJurisdictionIntraRuntimeTx)
) : false;

const normalizeEntityRef = (value: unknown): string => String(value || '').trim().toLowerCase();
const normalizeRuntimeRef = (value: unknown): string => String(value || '').trim().toLowerCase();

export type CrossJurisdictionRouteRuntimeResolver = (
  entityId: string,
  signerId: string,
) => string | null | undefined;

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

/** Exact signed Profile owners needed to prove the two sibling Runtime cohorts. */
export const crossJurisdictionRouteProfileEntityIds = (
  route: CrossJurisdictionSwapRoute,
): string[] => [...new Set([
  normalizeEntityRef(route.source?.entityId),
  normalizeEntityRef(route.target?.counterpartyEntityId),
  normalizeEntityRef(route.source?.counterpartyEntityId),
  normalizeEntityRef(route.target?.entityId),
].filter(Boolean))];

/** Board signer committed by the route for one exact cross-j Entity owner. */
export const crossJurisdictionRouteSigner = (
  route: CrossJurisdictionSwapRoute,
  entityId: string,
): string | null => {
  const target = normalizeEntityRef(entityId);
  if (!target) return null;
  if (normalizeEntityRef(route.source.entityId) === target) return normalizeEntityRef(route.sourceSignerId) || null;
  if (normalizeEntityRef(route.source.counterpartyEntityId) === target) {
    return normalizeEntityRef(route.sourceHubSignerId) || null;
  }
  if (normalizeEntityRef(route.target.entityId) === target) return normalizeEntityRef(route.targetHubSignerId) || null;
  if (normalizeEntityRef(route.target.counterpartyEntityId) === target) {
    return normalizeEntityRef(route.targetSignerId) || null;
  }
  const bookOwner = normalizeEntityRef(
    route.bookOwnerEntityId || route.source.counterpartyEntityId || route.hubEntityId,
  );
  if (bookOwner !== target) return null;
  if (bookOwner === normalizeEntityRef(route.source.counterpartyEntityId)) {
    return normalizeEntityRef(route.sourceHubSignerId) || null;
  }
  if (bookOwner === normalizeEntityRef(route.target.entityId)) {
    return normalizeEntityRef(route.targetHubSignerId) || null;
  }
  return null;
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

export const isCrossJurisdictionRouteParticipant = (
  route: CrossJurisdictionSwapRoute,
  entityId: string,
): boolean => {
  const participant = normalizeEntityRef(entityId);
  return Boolean(participant) && [
    route.source.entityId,
    route.source.counterpartyEntityId,
    route.target.entityId,
    route.target.counterpartyEntityId,
    route.bookOwnerEntityId,
    route.hubEntityId,
  ].some(candidate => normalizeEntityRef(candidate) === participant);
};

export const resolveCrossJurisdictionRuntimeTopology = (
  route: CrossJurisdictionSwapRoute,
  resolveRuntimeId: CrossJurisdictionRouteRuntimeResolver,
): CrossJurisdictionRuntimeTopology | null => {
  const sourceUserId = normalizeEntityRef(route.source?.entityId);
  const targetUserId = normalizeEntityRef(route.target?.counterpartyEntityId);
  const sourceHubId = normalizeEntityRef(route.source?.counterpartyEntityId);
  const targetHubId = normalizeEntityRef(route.target?.entityId);
  const sourceUserSignerId = normalizeEntityRef(route.sourceSignerId);
  const targetUserSignerId = normalizeEntityRef(route.targetSignerId);
  const sourceHubSignerId = normalizeEntityRef(route.sourceHubSignerId);
  const targetHubSignerId = normalizeEntityRef(route.targetHubSignerId);
  if (
    !sourceUserId || !targetUserId || sourceUserId === targetUserId ||
    !sourceHubId || !targetHubId || sourceHubId === targetHubId ||
    !sourceUserSignerId || !targetUserSignerId || !sourceHubSignerId || !targetHubSignerId
  ) return null;

  const sourceUserRuntimeId = normalizeRuntimeRef(resolveRuntimeId(sourceUserId, sourceUserSignerId));
  const targetUserRuntimeId = normalizeRuntimeRef(resolveRuntimeId(targetUserId, targetUserSignerId));
  const sourceHubRuntimeId = normalizeRuntimeRef(resolveRuntimeId(sourceHubId, sourceHubSignerId));
  const targetHubRuntimeId = normalizeRuntimeRef(resolveRuntimeId(targetHubId, targetHubSignerId));
  if (!sourceUserRuntimeId || !targetUserRuntimeId || !sourceHubRuntimeId || !targetHubRuntimeId) return null;
  if (sourceUserRuntimeId !== targetUserRuntimeId) return null;
  if (sourceHubRuntimeId !== targetHubRuntimeId) return null;
  if (sourceUserRuntimeId === sourceHubRuntimeId) return null;

  const bookOwnerId = normalizeEntityRef(route.bookOwnerEntityId || route.source?.counterpartyEntityId || route.hubEntityId);
  if (bookOwnerId) {
    const bookOwnerSignerId = bookOwnerId === sourceHubId
      ? sourceHubSignerId
      : bookOwnerId === targetHubId
        ? targetHubSignerId
        : '';
    if (!bookOwnerSignerId) return null;
    const bookOwnerRuntimeId = normalizeRuntimeRef(resolveRuntimeId(bookOwnerId, bookOwnerSignerId));
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
