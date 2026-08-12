import type { AccountRoleEvidence } from '../../runtime/account/config/dispute-config';
import type { HubApiRow } from './api';
import type { CliSession } from './session';

const normalizedId = (value: unknown): string => String(value || '').trim().toLowerCase();

const committedRoleMap = (session: CliSession): Map<string, boolean> => {
  const roles = new Map<string, boolean>();
  for (const replica of session.env.state.eReplicas.values()) {
    const entityId = normalizedId(replica.state.entityId);
    const isHub = replica.state.profile?.isHub;
    if (entityId && typeof isHub === 'boolean') roles.set(entityId, isHub);
  }
  return roles;
};

export type CliHubPartyRoles = {
  entityRoleEvidence: AccountRoleEvidence;
  hubRoleEvidence: AccountRoleEvidence;
  committedRoles: ReadonlyMap<string, boolean>;
};

export const resolveCliHubPartyRoles = (
  session: CliSession,
  hubEntityId: string,
  publicHub?: HubApiRow,
): CliHubPartyRoles => {
  const sourceEntityId = normalizedId(session.entityId);
  const hubId = normalizedId(hubEntityId);
  const committedRoles = committedRoleMap(session);
  const sourceIsHub = committedRoles.get(sourceEntityId);
  const committedHubRole = committedRoles.get(hubId);
  const gossipHub = session.env.gossip.getProfiles().find(profile => (
    normalizedId(profile.entityId) === hubId && profile.metadata?.isHub === true
  ));
  const authorizedPublicHub = normalizedId(publicHub?.entityId) === hubId
    && publicHub?.metadata?.isHub === true
    && (publicHub.roleSource === 'verified-gossip-profile' || publicHub.roleSource === 'operator-config');
  if (typeof sourceIsHub !== 'boolean' || (committedHubRole !== true && !gossipHub && !authorizedPublicHub)) {
    throw new Error(`CLI_ACCOUNT_PARTY_ROLE_UNAVAILABLE:${sourceEntityId}:${hubId}`);
  }
  return {
    entityRoleEvidence: { entityId: sourceEntityId, isHub: sourceIsHub, source: 'committed-profile' },
    hubRoleEvidence: {
      entityId: hubId,
      isHub: true,
      source: committedHubRole === true
        ? 'committed-profile'
        : gossipHub
          ? 'verified-gossip-profile'
          : publicHub!.roleSource!,
    },
    committedRoles,
  };
};
