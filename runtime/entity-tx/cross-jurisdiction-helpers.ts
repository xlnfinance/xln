import {
  cloneCrossJurisdictionRoute,
  isCrossJurisdictionRouteTransitionAllowed,
  isCrossJurisdictionTerminalStatus,
} from '../cross-jurisdiction';
import {
  getJurisdictionStackId,
  isJurisdictionStackRef,
  requireRuntimeJurisdictionConfigByName,
} from '../jurisdiction-runtime';
import type { AccountTx, CrossJurisdictionSwapRoute, EntityState, Env } from '../types';

const normalizeEntityRef = (value: string): string => String(value || '').toLowerCase();
const normalizeAddress = (value: unknown): string => String(value || '').trim().toLowerCase();
const normalizeJurisdictionLabel = (value: unknown): string => String(value || '').trim().toLowerCase();

export const findCrossJurisdictionOfferRoute = (
  state: EntityState,
  orderId: string,
): { accountId: string; route: CrossJurisdictionSwapRoute } | null => {
  for (const [accountId, account] of state.accounts.entries()) {
    const route = account.swapOffers?.get(orderId)?.crossJurisdiction;
    if (route) return { accountId, route };
  }
  return null;
};

export const mergeCrossJurisdictionRoute = (
  existing: CrossJurisdictionSwapRoute | undefined,
  next: CrossJurisdictionSwapRoute,
): CrossJurisdictionSwapRoute => ({
  ...cloneCrossJurisdictionRoute(existing ?? next),
  ...cloneCrossJurisdictionRoute(next),
});

const sameCrossJurisdictionIntentTerms = (
  existing: CrossJurisdictionSwapRoute,
  next: CrossJurisdictionSwapRoute,
): boolean => {
  const toBigInt = (value: unknown): bigint => {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || !Number.isInteger(value)) throw new Error('non-integer bigint term');
      return BigInt(value);
    }
    if (typeof value === 'string') return BigInt(value);
    throw new Error('unsupported bigint term');
  };
  const sameBigInt = (left: unknown, right: unknown): boolean => {
    try {
      return toBigInt(left) === toBigInt(right);
    } catch {
      return false;
    }
  };
  return (
    String(existing.orderId || '') === String(next.orderId || '') &&
    normalizeEntityRef(existing.makerEntityId) === normalizeEntityRef(next.makerEntityId) &&
    normalizeEntityRef(existing.source.entityId) === normalizeEntityRef(next.source.entityId) &&
    normalizeEntityRef(existing.source.counterpartyEntityId) === normalizeEntityRef(next.source.counterpartyEntityId) &&
    normalizeEntityRef(existing.target.entityId) === normalizeEntityRef(next.target.entityId) &&
    normalizeEntityRef(existing.target.counterpartyEntityId) === normalizeEntityRef(next.target.counterpartyEntityId) &&
    Number(existing.source.tokenId) === Number(next.source.tokenId) &&
    Number(existing.target.tokenId) === Number(next.target.tokenId) &&
    sameBigInt(existing.source.amount, next.source.amount) &&
    sameBigInt(existing.target.amount, next.target.amount) &&
    sameBigInt(existing.priceTicks ?? 0n, next.priceTicks ?? 0n) &&
    Number(existing.expiresAt ?? 0) === Number(next.expiresAt ?? 0) &&
    String(existing.riskMode || '') === String(next.riskMode || '') &&
    String(existing.priceImprovementMode || '') === String(next.priceImprovementMode || '')
  );
};

export const validateCrossJurisdictionRouteTransition = (
  existing: CrossJurisdictionSwapRoute | undefined,
  next: CrossJurisdictionSwapRoute,
): string | null => {
  if (!existing) return null;
  if (existing.routeHash && next.routeHash && existing.routeHash.toLowerCase() !== next.routeHash.toLowerCase()) {
    const preparedIntentCommit =
      existing.status === 'intent' &&
      Boolean(next.sourcePull && next.targetPull) &&
      (next.status === 'resting' || next.status === 'target_prepared' || next.status === 'source_committed') &&
      sameCrossJurisdictionIntentTerms(existing, next);
    if (preparedIntentCommit) return null;
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

export const findCrossJurisdictionPullRoute = (
  state: EntityState,
  pullId: string,
): { route: CrossJurisdictionSwapRoute; leg: 'source' | 'target' } | null => {
  for (const route of state.crossJurisdictionSwaps?.values() ?? []) {
    if (route.sourcePull?.pullId === pullId) return { route, leg: 'source' };
    if (route.targetPull?.pullId === pullId) return { route, leg: 'target' };
  }
  return null;
};

export const hasCommittedCrossJurisdictionFill = (route: CrossJurisdictionSwapRoute): boolean => (
  Math.max(
    Math.floor(Number(route.cumulativeFillRatio ?? 0) || 0),
    Math.floor(Number(route.claimedRatio ?? 0) || 0),
  ) > 0 ||
  (route.filledSourceAmount ?? 0n) > 0n ||
  (route.filledTargetAmount ?? 0n) > 0n ||
  (route.sourceClaimed ?? 0n) > 0n ||
  (route.targetClaimed ?? 0n) > 0n
);

export const isCrossJurisdictionPullCancelWithinClear = (route: CrossJurisdictionSwapRoute): boolean => (
  route.status === 'clearing' ||
  route.status === 'source_claimed' ||
  route.status === 'target_claimed' ||
  route.status === 'settled' ||
  route.clearingPolicy === 'cancel_and_clear' ||
  route.clearingPolicy === 'full_fill'
);

export const canonicalizeCrossJurisdictionRouteForKnownEntities = (
  env: Env,
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
  const stackId = getJurisdictionStackId(jurisdiction);
  if (stackId) return stackId;
  const depository = normalizeAddress(jurisdiction.depositoryAddress);
  if (depository) return `depository:${depository}`;
  return `name:${normalizeJurisdictionLabel(jurisdiction.name)}`;
};

const routeJurisdictionMatchesLocal = (
  env: Env,
  state: EntityState,
  routeJurisdictionName: string,
): boolean => {
  const local = state.config?.jurisdiction;
  if (!local) return false;
  if (normalizeJurisdictionLabel(local.name) === normalizeJurisdictionLabel(routeJurisdictionName)) {
    return true;
  }
  let routeJurisdiction: typeof local | undefined;
  try {
    routeJurisdiction = requireRuntimeJurisdictionConfigByName(env, routeJurisdictionName);
  } catch {
    routeJurisdiction = undefined;
  }
  const localKey = jurisdictionIdentityKey(local);
  const routeKey = jurisdictionIdentityKey(routeJurisdiction);
  return Boolean(localKey && routeKey && localKey === routeKey);
};

export const validateCrossJurisdictionLocalBinding = (
  env: Env,
  state: EntityState,
  route: CrossJurisdictionSwapRoute,
): string | null => {
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
  if (!routeJurisdictionMatchesLocal(env, state, expected)) {
    return `route jurisdiction ${expected} does not match local jurisdiction ${state.config.jurisdiction.name}`;
  }
  return null;
};

type AccountMachineFromState = EntityState['accounts'] extends Map<string, infer T> ? T : never;

export const accountHasPullResolveQueued = (
  account: AccountMachineFromState,
  pullId: string,
): boolean => {
  const isResolve = (tx: AccountTx): boolean =>
    tx.type === 'pull_resolve' && tx.data.pullId === pullId;
  return account.mempool.some(isResolve) ||
    Boolean(account.pendingFrame?.accountTxs?.some(isResolve));
};

export const accountHasCrossSwapAckQueued = (
  account: AccountMachineFromState,
  offerId: string,
): boolean => {
  const isAck = (tx: AccountTx): boolean =>
    tx.type === 'cross_swap_fill_ack' && tx.data.offerId === offerId;
  return account.mempool.some(isAck) ||
    Boolean(account.pendingFrame?.accountTxs?.some(isAck));
};
