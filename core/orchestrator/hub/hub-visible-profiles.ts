import { verifiedGossipAccountRoleEvidence } from '../../account/config/role-evidence';
import { getJurisdictionIdentityRef } from '../../jurisdiction/machine/jurisdiction-runtime';
import { normalizeRuntimeId } from '../../network/p2p/auth/runtime-id';
import type { RuntimeReplica } from '../../runtime/types';
import { getEntityReplicaById } from '../mesh/mesh-common';

export type VisibleHubProfile = {
  name: string;
  hubName?: string;
  entityId: string;
  runtimeId: string;
  jurisdictionName: string;
  chainId?: number;
  depositoryAddress?: string;
  jurisdictionRef: string;
  roleEvidence: ReturnType<typeof verifiedGossipAccountRoleEvidence>;
};

export const normalizeJurisdictionDisplayName = (value: unknown): string =>
  String(value || '').trim();

/** Project only authenticated Hub gossip; a loaded committed User vetoes it. */
export const readVisibleHubProfiles = (
  env: RuntimeReplica,
  jurisdiction: unknown,
): VisibleHubProfile[] => (env.gossip?.getProfiles?.() || [])
  .filter(profile => profile.metadata?.isHub === true)
  .filter(profile => {
    const targetRef = getJurisdictionIdentityRef(jurisdiction);
    return !targetRef || getJurisdictionIdentityRef(profile.metadata?.jurisdiction) === targetRef;
  })
  .map(profile => {
    const chainId = Number(profile.metadata?.jurisdiction?.chainId || 0);
    const depositoryAddress = String(profile.metadata?.jurisdiction?.depositoryAddress || '').trim();
    const entityId = String(profile.entityId || '').toLowerCase();
    const committed = getEntityReplicaById(env, entityId);
    return {
      name: String(profile.name || '').trim(),
      hubName: typeof profile.metadata?.hubName === 'string' ? profile.metadata.hubName.trim() : '',
      entityId,
      runtimeId: normalizeRuntimeId(profile.runtimeId || ''),
      jurisdictionName: normalizeJurisdictionDisplayName(profile.metadata?.jurisdiction?.name),
      ...(Number.isFinite(chainId) && chainId > 0 ? { chainId: Math.floor(chainId) } : {}),
      ...(depositoryAddress ? { depositoryAddress } : {}),
      jurisdictionRef: getJurisdictionIdentityRef(profile.metadata?.jurisdiction),
      roleEvidence: verifiedGossipAccountRoleEvidence(
        entityId,
        true,
        committed ? committed.state.profile.isHub === true : undefined,
      ),
    };
  })
  .filter(profile => Boolean(
    profile.name && profile.entityId && profile.runtimeId
    && profile.jurisdictionName && profile.jurisdictionRef,
  ));
