/**
 * Helper functions for gossip profile management
 * Builds and broadcasts entity profiles with account information
 */

import type { EntityState } from '../../../entity/types';
import type { RuntimeReplica } from '../../../runtime/types';
import type {
  Profile,
  ProfileJurisdiction,
  ProfileMirror,
} from '../../../entity/profile';
import { compareStableText } from '../../../protocol/serialization';
import { deriveSignerAddressSync, getSignerPrivateKeyIfAvailable } from '../../../account/crypto';
import { deriveEncryptionKeyPair, pubKeyToHex } from '../../../protocol/crypto/p2p-crypto';
import { buildEntityProfileDescriptor } from '../../../entity/profile/profile-descriptor';

type BuiltProfile = Omit<Profile, 'runtimeId' | 'runtimeEncPubKey'>;

const buildProfileJurisdiction = (state: EntityState): ProfileJurisdiction | undefined => {
  const jurisdiction = state.config?.jurisdiction;
  const name = typeof jurisdiction?.name === 'string' ? jurisdiction.name.trim() : '';
  if (!jurisdiction || !name) return undefined;
  return {
    name,
    ...(jurisdiction.chainId !== undefined ? { chainId: jurisdiction.chainId } : {}),
    ...(jurisdiction.entityProviderAddress
      ? { entityProviderAddress: jurisdiction.entityProviderAddress.toLowerCase() }
      : {}),
    ...(jurisdiction.depositoryAddress
      ? { depositoryAddress: jurisdiction.depositoryAddress.toLowerCase() }
      : {}),
  };
};

const buildProfileMirrors = (env: RuntimeReplica, entityState: EntityState): ProfileMirror[] => {
  const mirrors = new Map<string, ProfileMirror>();
  for (const replica of env.state.eReplicas?.values?.() || []) {
    const entityId = String(replica?.state?.entityId || replica?.entityId || '').trim();
    if (!entityId || entityId.toLowerCase() === entityState.entityId.toLowerCase()) continue;
    if (getSignerPrivateKeyIfAvailable(env, replica.signerId) === null) continue;
    const jurisdiction = buildProfileJurisdiction(replica.state);
    if (!jurisdiction) continue;
    mirrors.set(entityId.toLowerCase(), { entityId, jurisdiction });
  }
  return Array.from(mirrors.values()).sort((a, b) =>
    compareStableText(a.jurisdiction.name, b.jurisdiction.name) || compareStableText(a.entityId, b.entityId),
  );
};

/**
 * Build gossip profile from entity state
 * Includes all account capacities for routing
 */
function buildEntityProfile(
  entityState: EntityState,
  timestamp: number = 0,
): BuiltProfile {
  const descriptor = buildEntityProfileDescriptor(entityState);
  const profileName = String(entityState.profile.name || '').trim();
  if (!profileName) {
    throw new Error(`GOSSIP_PROFILE_NAME_REQUIRED: entity=${entityState.entityId}`);
  }

  // Build profile
  const profile: BuiltProfile = {
    entityId: descriptor.entityId,
    entityEncryptionPublicKey: descriptor.entityEncryptionPublicKey,
    name: descriptor.name,
    avatar: descriptor.avatar,
    bio: descriptor.bio,
    website: descriptor.website,
    lastUpdated: timestamp,
    publicAccounts: descriptor.publicAccounts,
    wsUrl: null,
    relays: [],
    metadata: descriptor.metadata,
    accounts: descriptor.accounts,
  };

  return profile;
}

const getNextProfileTimestamp = (env: RuntimeReplica, entityId: string, proposedTimestamp?: number): number => {
  const existingProfile = env.gossip.getProfiles().find((profile) => profile.entityId === entityId);
  const lastTimestamp = existingProfile?.lastUpdated ?? 0;
  const candidate = typeof proposedTimestamp === 'number' ? proposedTimestamp : env.state.timestamp;
  return Math.max(1, lastTimestamp + 1, candidate);
};

const resolveProfileRuntimeId = (env: RuntimeReplica, entityId: string): string => {
  if (typeof env.runtimeId === 'string' && env.runtimeId.trim().length > 0) {
    return env.runtimeId.trim().toLowerCase();
  }
  const runtimeSeed = typeof env.runtimeSeed === 'string' ? env.runtimeSeed.trim() : '';
  if (!runtimeSeed) {
    throw new Error(`GOSSIP_PROFILE_RUNTIME_ID_REQUIRED: entity=${entityId}`);
  }
  return deriveSignerAddressSync(runtimeSeed, '1').toLowerCase();
};

export const buildLocalEntityProfile = (
  env: RuntimeReplica,
  entityState: EntityState,
  timestamp: number = getNextProfileTimestamp(env, entityState.entityId),
): Profile => {
  const runtimeSeed = String(env.runtimeSeed || '').trim();
  if (!runtimeSeed) {
    throw new Error(`GOSSIP_PROFILE_RUNTIME_SEED_REQUIRED: entity=${entityState.entityId}`);
  }
  const profileTimestamp = Math.max(1, timestamp);
  const profile = buildEntityProfile(entityState, profileTimestamp);
  const jurisdiction = buildProfileJurisdiction(entityState);
  const mirrors = env.runtimeConfig?.advertiseProfileMirrors === true
    ? buildProfileMirrors(env, entityState)
    : [];
  return {
    ...profile,
    metadata: {
      ...profile.metadata,
      ...(jurisdiction ? { jurisdiction } : {}),
      ...(mirrors.length > 0 ? { mirrors } : {}),
    },
    runtimeId: resolveProfileRuntimeId(env, entityState.entityId),
    runtimeEncPubKey: pubKeyToHex(deriveEncryptionKeyPair(runtimeSeed).publicKey),
  };
};
