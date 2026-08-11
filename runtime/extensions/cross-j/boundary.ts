import type { CrossJurisdictionSwapRoute } from '../../types/cross-jurisdiction';
import type { EntityInput } from '../../entity/types';
import type { EntityTx } from '../../types/entity-tx';
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
const CROSS_J_INTRA_RUNTIME_ENTITY_TX_TYPES = new Set<string>([
  'registerCrossJurisdictionSwap',
  'crossJurisdictionFillNotice',
  'requestCrossJurisdictionClear',
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
