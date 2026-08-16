import { normalizeEntityRef } from '../account-key';
import {
  cloneCrossJurisdictionRoute,
  isCrossJurisdictionRouteTransitionAllowed,
  isCrossJurisdictionTerminalStatus,
} from '../../../extensions/cross-j';
import {
  getJurisdictionStackId,
  isJurisdictionStackRef,
} from '../../../jurisdiction/machine/jurisdiction-runtime';
import type { AccountTx } from '../../../types/account';
import type { CrossJurisdictionSwapRoute } from '../../../types/cross-jurisdiction';
import type { EntityState } from '../../types';
import type { EntityRuntimeContext } from '../../runtime-context';

const normalizeAddress = (value: unknown): string => String(value || '').trim().toLowerCase();

export const findCrossJurisdictionOfferRoute = (
  state: EntityState,
  orderId: string,
): { accountId: string; route: CrossJurisdictionSwapRoute } | null => {
  const mirroredRoute = state.crossJurisdictionSwaps?.get(orderId);
  if (!mirroredRoute) return null;
  const self = normalizeEntityRef(state.entityId);
  const sourceEntity = normalizeEntityRef(mirroredRoute.source.entityId);
  const sourceCounterparty = normalizeEntityRef(
    mirroredRoute.source.counterpartyEntityId,
  );
  const accountId = self === sourceEntity
    ? sourceCounterparty
    : self === sourceCounterparty
      ? sourceEntity
      : '';
  if (!accountId) return null;
  const route = state.accounts
    .get(accountId)
    ?.state.swapOffers
    ?.get(orderId)
    ?.crossJurisdiction;
  return route ? { accountId, route } : null;
};

export const mergeCrossJurisdictionRoute = (
  existing: CrossJurisdictionSwapRoute | undefined,
  next: CrossJurisdictionSwapRoute,
): CrossJurisdictionSwapRoute => ({
  ...cloneCrossJurisdictionRoute(existing ?? next),
  ...cloneCrossJurisdictionRoute(next),
});

export const validateCrossJurisdictionRouteTransition = (
  existing: CrossJurisdictionSwapRoute | undefined,
  next: CrossJurisdictionSwapRoute,
): string | null => {
  if (!existing) return null;
  if (existing.routeHash && next.routeHash && existing.routeHash.toLowerCase() !== next.routeHash.toLowerCase()) {
    return 'route hash mismatch';
  }
  if (isCrossJurisdictionTerminalStatus(existing.status)) {
    return `terminal state ${existing.status}`;
  }
  if (!isCrossJurisdictionRouteTransitionAllowed(existing.status, next.status)) {
    return `invalid transition ${existing.status}->${next.status}`;
  }
  return null;
};

export const isCrossJurisdictionRouteParticipant = (
  entityId: string,
  route: CrossJurisdictionSwapRoute,
): boolean => {
  const current = normalizeEntityRef(entityId);
  return [
    route.source.entityId,
    route.source.counterpartyEntityId,
    route.target.entityId,
    route.target.counterpartyEntityId,
    route.bookOwnerEntityId,
    route.hubEntityId,
  ].some(candidate => candidate && normalizeEntityRef(candidate) === current);
};

export const canonicalizeCrossJurisdictionRouteForKnownEntities = (
  env: EntityRuntimeContext,
  state: EntityState,
  route: CrossJurisdictionSwapRoute,
): CrossJurisdictionSwapRoute => {
  void env;
  void state;
  // Jurisdiction labels are part of route identity and may be local aliases for
  // the same chain/depository. Rewriting them after signing changes routeHash
  // and breaks prepared pull commitments. Identity binding is enforced below.
  return route;
};

const jurisdictionIdentityKey = (jurisdiction: { name?: string; chainId?: number; depositoryAddress?: string } | undefined | null): string => {
  if (!jurisdiction) return '';
  return getJurisdictionStackId(jurisdiction);
};

const routeJurisdictionMatchesLocal = (
  state: EntityState,
  routeJurisdictionName: string,
): boolean => {
  const local = state.config?.jurisdiction;
  if (!local) return false;
  const localKey = jurisdictionIdentityKey(local);
  return Boolean(localKey && localKey.toLowerCase() === routeJurisdictionName.trim().toLowerCase());
};

const routeSignerHintForLocalEntity = (
  state: EntityState,
  route: CrossJurisdictionSwapRoute,
): string | null => {
  const local = normalizeEntityRef(state.entityId);
  if (normalizeEntityRef(route.source.entityId) === local) return normalizeAddress(route.sourceSignerId);
  if (normalizeEntityRef(route.source.counterpartyEntityId) === local) return normalizeAddress(route.sourceHubSignerId);
  if (normalizeEntityRef(route.target.entityId) === local) return normalizeAddress(route.targetHubSignerId);
  if (normalizeEntityRef(route.target.counterpartyEntityId) === local) return normalizeAddress(route.targetSignerId);
  return null;
};

export const validateCrossJurisdictionLocalBinding = (
  env: EntityRuntimeContext,
  state: EntityState,
  route: CrossJurisdictionSwapRoute,
): string | null => {
  void env;
  const local = normalizeEntityRef(state.entityId);
  if (!state.config?.jurisdiction) return 'local jurisdiction unknown';

  const sourceParticipant =
    normalizeEntityRef(route.source.entityId) === local ||
    normalizeEntityRef(route.source.counterpartyEntityId) === local;
  const targetParticipant =
    normalizeEntityRef(route.target.entityId) === local ||
    normalizeEntityRef(route.target.counterpartyEntityId) === local;
  if (!sourceParticipant && !targetParticipant) return null;

  const expected = sourceParticipant
    ? String(route.source.jurisdiction || '').trim()
    : String(route.target.jurisdiction || '').trim();
  if (!expected) return 'route jurisdiction missing';
  if (!isJurisdictionStackRef(expected)) return `route jurisdiction must be stack ref, got ${expected}`;
  if (!routeJurisdictionMatchesLocal(state, expected)) {
    return `route jurisdiction ${expected} does not match local jurisdiction ${state.config.jurisdiction.name}`;
  }
  const signerHint = routeSignerHintForLocalEntity(state, route);
  if (signerHint) {
    const validators = new Set((state.config.validators || []).map(normalizeAddress).filter(Boolean));
    if (validators.size > 0 && !validators.has(signerHint)) {
      return `route signer ${signerHint} is not a validator for local entity`;
    }
  }
  return null;
};

type AccountStateFromEntity = EntityState['accounts'] extends ReadonlyMap<string, infer T> ? T : never;

export const accountHasCrossPullCloseQueued = (
  account: AccountStateFromEntity,
  pullId: string,
): boolean => {
  const isResolve = (tx: AccountTx): boolean =>
    tx.type === 'cross_pull_close' && tx.data.pullId === pullId;
  return account.mempool.some(isResolve) ||
    Boolean(account.pendingFrame?.accountTxs?.some(isResolve));
};

export const accountHasCrossSwapAckQueued = (
  account: AccountStateFromEntity,
  offerId: string,
): boolean => {
  const isAck = (tx: AccountTx): boolean =>
    tx.type === 'cross_swap_fill_ack' && tx.data.offerId === offerId;
  return account.mempool.some(isAck) ||
    Boolean(account.pendingFrame?.accountTxs?.some(isAck));
};
