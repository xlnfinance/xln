import type { AccountMachine, AccountTx } from '../../../types';
import {
  deriveCanonicalCrossJurisdictionBookOwner,
  withCanonicalCrossJurisdictionRouteHash,
} from '../../../extensions/cross-j';
import { getJurisdictionStackId } from '../../../jurisdiction/jurisdiction-stack';
import { safeStringify } from '../../../protocol/serialization';

type CrossJIntentTx = Extract<AccountTx, { type: 'cross_j_intent' }>;

const normalized = (value: unknown): string => String(value ?? '').trim().toLowerCase();

export const handleCrossJIntent = (
  account: AccountMachine,
  tx: CrossJIntentTx,
  byLeft: boolean,
): { success: boolean; events: string[]; error?: string } => {
  const route = tx.data.route;
  let canonical: typeof route;
  try {
    canonical = withCanonicalCrossJurisdictionRouteHash(route);
  } catch (error) {
    return { success: false, events: [], error: `Cross-j intent invalid: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (safeStringify(canonical) !== safeStringify(route)) {
    return { success: false, events: [], error: 'Cross-j intent must contain the complete canonical route' };
  }
  if (route.status !== 'intent' || route.sourcePull || route.targetPull || route.targetReceipt) {
    return { success: false, events: [], error: 'Cross-j intent contains prepared or committed fields' };
  }
  const author = normalized(byLeft ? account.leftEntity : account.rightEntity);
  const sourceUser = normalized(route.source.entityId);
  const sourceHub = normalized(route.source.counterpartyEntityId);
  const accountEntities = new Set([normalized(account.leftEntity), normalized(account.rightEntity)]);
  if (author !== sourceUser || !accountEntities.has(sourceUser) || !accountEntities.has(sourceHub) || accountEntities.size !== 2) {
    return { success: false, events: [], error: 'Cross-j intent author or source Account endpoints mismatch' };
  }
  if (normalized(route.makerEntityId) !== sourceUser) {
    return { success: false, events: [], error: 'Cross-j intent maker must be the source user entity' };
  }
  const sourceStack = normalized(route.source.jurisdiction);
  if (sourceStack !== getJurisdictionStackId(account.domain)) {
    return { success: false, events: [], error: 'Cross-j intent source jurisdiction does not match Account domain' };
  }
  if (normalized(route.bookOwnerEntityId) !== normalized(deriveCanonicalCrossJurisdictionBookOwner(route))) {
    return { success: false, events: [], error: 'Cross-j intent book owner is not canonical' };
  }
  return { success: true, events: [`Cross-j intent committed: ${route.orderId}`] };
};
