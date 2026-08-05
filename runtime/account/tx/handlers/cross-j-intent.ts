import type { AccountReplica, AccountTx } from '../../../types/account';
import {
  deriveCanonicalCrossJurisdictionBookOwner,
  withCanonicalCrossJurisdictionRouteHash,
} from '../../../extensions/cross-j';
import { getJurisdictionStackId } from '../../../jurisdiction/machine/jurisdiction-stack';
import { safeStringify } from '../../../protocol/serialization';

type CrossJIntentTx = Extract<AccountTx, { type: 'cross_j_intent' }>;
type CrossJIntentRoute = CrossJIntentTx['data']['route'];
type CrossJIntentResult = { success: boolean; events: string[]; error?: string };

const normalizeEntityRef = (value: unknown): string => String(value ?? '').trim().toLowerCase();

const failure = (error: string): CrossJIntentResult => ({ success: false, events: [], error });

const canonicalRouteError = (route: CrossJIntentRoute): string | undefined => {
  try {
    const canonical = withCanonicalCrossJurisdictionRouteHash(route);
    return safeStringify(canonical) === safeStringify(route)
      ? undefined
      : 'Cross-j intent must contain the complete canonical route';
  } catch (error) {
    return `Cross-j intent invalid: ${error instanceof Error ? error.message : String(error)}`;
  }
};

const lifecycleError = (route: CrossJIntentRoute): string | undefined =>
  route.status === 'intent' && !route.sourcePull && !route.targetPull
    ? undefined
    : 'Cross-j intent contains prepared or committed fields';

const participantError = (
  account: AccountReplica,
  route: CrossJIntentRoute,
  byLeft: boolean,
): string | undefined => {
  const author = normalizeEntityRef(byLeft ? account.state.leftEntity : account.state.rightEntity);
  const sourceUser = normalizeEntityRef(route.source.entityId);
  const sourceHub = normalizeEntityRef(route.source.counterpartyEntityId);
  const accountEntities = new Set([
    normalizeEntityRef(account.state.leftEntity),
    normalizeEntityRef(account.state.rightEntity),
  ]);
  if (
    author !== sourceUser ||
    !accountEntities.has(sourceUser) ||
    !accountEntities.has(sourceHub) ||
    accountEntities.size !== 2
  ) {
    return 'Cross-j intent author or source Account endpoints mismatch';
  }
  return undefined;
};

const authorityError = (account: AccountReplica, route: CrossJIntentRoute): string | undefined => {
  if (normalizeEntityRef(route.makerEntityId) !== normalizeEntityRef(route.source.entityId)) {
    return 'Cross-j intent maker must be the source user entity';
  }
  if (normalizeEntityRef(route.source.jurisdiction) !== getJurisdictionStackId(account.state.domain)) {
    return 'Cross-j intent source jurisdiction does not match Account domain';
  }
  return normalizeEntityRef(route.bookOwnerEntityId) ===
    normalizeEntityRef(deriveCanonicalCrossJurisdictionBookOwner(route))
    ? undefined
    : 'Cross-j intent book owner is not canonical';
};

export const handleCrossJIntent = (
  account: AccountReplica,
  tx: CrossJIntentTx,
  byLeft: boolean,
): CrossJIntentResult => {
  const route = tx.data.route;
  const error = canonicalRouteError(route) ??
    lifecycleError(route) ??
    participantError(account, route, byLeft) ??
    authorityError(account, route);
  if (error) return failure(error);
  return { success: true, events: [`Cross-j intent committed: ${route.orderId}`] };
};
