import {
  canonicalAccountRoleEvidence,
  type AccountRoleEvidence,
} from './dispute-config';

/** Role factories keep every high-level account opener on one provenance path. */
export const committedAccountRoleEvidence = (
  entityId: string,
  isHub: boolean,
): AccountRoleEvidence => canonicalAccountRoleEvidence(
  { entityId, isHub, source: 'committed-profile' },
  entityId,
  isHub,
);

export const verifiedGossipAccountRoleEvidence = (
  entityId: string,
  advertisedIsHub: unknown,
  committedIsHub?: boolean,
): AccountRoleEvidence => {
  if (typeof advertisedIsHub !== 'boolean') {
    throw new Error(`ACCOUNT_ROLE_VERIFIED_GOSSIP_INVALID:${entityId}`);
  }
  return canonicalAccountRoleEvidence(
    { entityId, isHub: advertisedIsHub, source: 'verified-gossip-profile' },
    entityId,
    committedIsHub,
  );
};
