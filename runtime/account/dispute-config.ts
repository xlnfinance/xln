import type { AccountState } from '../types/account';

export type AccountDisputeConfig = AccountState['disputeConfig'];
export type AccountRoleEvidenceSource =
  | 'committed-profile'
  | 'verified-gossip-profile'
  | 'operator-config';
export type AccountRoleEvidence = {
  entityId: string;
  isHub: boolean;
  source: AccountRoleEvidenceSource;
};

const HUB_RESPONSE_SECONDS = 60 * 60;
const USER_RESPONSE_SECONDS = 24 * 60 * 60;
const MAX_ACCOUNT_DISPUTE_SECONDS = 365 * 24 * 60 * 60;

const requireResponseSeconds = (value: unknown, side: 'left' | 'right'): number => {
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 0xffff_ffff) {
    throw new Error(`ACCOUNT_DISPUTE_${side.toUpperCase()}_RESPONSE_SECONDS_INVALID:${String(value)}`);
  }
  return seconds;
};

/**
 * Validate the exact bilateral clock committed by every Account state root.
 * Zero is intentional: two parties may choose same-block finality. The only
 * protocol ceiling prevents an accidental account from remaining disputed for
 * more than one year; there is deliberately no jurisdiction-wide fallback.
 */
export const canonicalAccountDisputeConfig = (value: AccountDisputeConfig): AccountDisputeConfig => {
  if (!value || typeof value !== 'object') {
    throw new Error(`ACCOUNT_DISPUTE_CONFIG_INVALID:${String(value)}`);
  }
  const leftResponseSeconds = requireResponseSeconds(value.leftResponseSeconds, 'left');
  const rightResponseSeconds = requireResponseSeconds(value.rightResponseSeconds, 'right');
  if (leftResponseSeconds + rightResponseSeconds > MAX_ACCOUNT_DISPUTE_SECONDS) {
    throw new Error(
      `ACCOUNT_DISPUTE_RESPONSE_TOTAL_EXCEEDED:${leftResponseSeconds + rightResponseSeconds}`,
    );
  }
  return { leftResponseSeconds, rightResponseSeconds };
};

/** Defaults are materialized once at account creation and then signed. */
const defaultAccountDisputeConfig = (
  leftIsHub: boolean,
  rightIsHub: boolean,
): AccountDisputeConfig => ({
  leftResponseSeconds: leftIsHub ? HUB_RESPONSE_SECONDS : USER_RESPONSE_SECONDS,
  rightResponseSeconds: rightIsHub ? HUB_RESPONSE_SECONDS : USER_RESPONSE_SECONDS,
});

export const defaultAccountDisputeConfigForParties = (
  firstEntityId: string,
  firstIsHub: boolean,
  secondEntityId: string,
  secondIsHub: boolean,
): AccountDisputeConfig => {
  const first = String(firstEntityId).trim().toLowerCase();
  const second = String(secondEntityId).trim().toLowerCase();
  if (!first || !second || first === second) throw new Error('ACCOUNT_DISPUTE_PARTIES_INVALID');
  return first < second
    ? defaultAccountDisputeConfig(firstIsHub, secondIsHub)
    : defaultAccountDisputeConfig(secondIsHub, firstIsHub);
};

/**
 * Bind role provenance at the command boundary. Remote peers do not need a
 * local replica, but their role must come from exactly one authenticated
 * authority. If a committed replica is available it is the final conflict
 * check; orderbook capability is intentionally not role evidence.
 */
export const canonicalAccountRoleEvidence = (
  evidence: AccountRoleEvidence,
  expectedEntityId: string,
  committedIsHub?: boolean,
): AccountRoleEvidence => {
  const entityId = String(evidence?.entityId || '').trim().toLowerCase();
  const expected = String(expectedEntityId || '').trim().toLowerCase();
  if (!entityId || entityId !== expected || typeof evidence?.isHub !== 'boolean') {
    throw new Error(`ACCOUNT_ROLE_EVIDENCE_INVALID:${expected || String(expectedEntityId)}`);
  }
  if (
    evidence.source !== 'committed-profile'
    && evidence.source !== 'verified-gossip-profile'
    && evidence.source !== 'operator-config'
  ) {
    throw new Error(`ACCOUNT_ROLE_EVIDENCE_SOURCE_INVALID:${String(evidence.source)}`);
  }
  if (typeof committedIsHub === 'boolean' && committedIsHub !== evidence.isHub) {
    throw new Error(`ACCOUNT_ROLE_EVIDENCE_COMMITTED_CONFLICT:${entityId}`);
  }
  if (evidence.source === 'committed-profile' && typeof committedIsHub !== 'boolean') {
    throw new Error(`ACCOUNT_ROLE_EVIDENCE_COMMITTED_MISSING:${entityId}`);
  }
  return { entityId, isHub: evidence.isHub, source: evidence.source };
};

export const defaultAccountDisputeConfigForRoleEvidence = (
  first: AccountRoleEvidence,
  second: AccountRoleEvidence,
  committedRoles?: ReadonlyMap<string, boolean>,
): AccountDisputeConfig => {
  const firstEntityId = String(first?.entityId || '').trim().toLowerCase();
  const secondEntityId = String(second?.entityId || '').trim().toLowerCase();
  const canonicalFirst = canonicalAccountRoleEvidence(
    first,
    firstEntityId,
    committedRoles?.get(firstEntityId),
  );
  const canonicalSecond = canonicalAccountRoleEvidence(
    second,
    secondEntityId,
    committedRoles?.get(secondEntityId),
  );
  return defaultAccountDisputeConfigForParties(
    canonicalFirst.entityId,
    canonicalFirst.isHub,
    canonicalSecond.entityId,
    canonicalSecond.isHub,
  );
};
