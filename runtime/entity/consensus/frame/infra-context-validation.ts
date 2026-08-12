import { LIMITS } from '../../../config/constants';
import { parseProfile, type Profile } from '../../profile';
import { encodeCanonicalConsensusValue } from '../../../protocol/serialization/canonical-consensus-value';
import { validateHtlcPreparedInfraContext } from '../../htlc/prepared-context-validation';
import type { EntityInfraContext } from '../../../types/entity/infra-context';
import type { EntityRuntimeContext } from '../../runtime-context';
import { verifyProfileSignature } from '../../profile/profile-signing';
import type { EntityState } from '../../types';

const bytes32 = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value)) throw new Error(code);
  return value;
};

const exactKeys = (value: unknown, keys: readonly string[], code: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== [...keys].sort().join(',')) throw new Error(`${code}:FIELDS`);
  return record;
};

const canonicalProfile = (value: unknown): Profile => {
  const parsed = parseProfile(value);
  if (encodeCanonicalConsensusValue(value) !== encodeCanonicalConsensusValue(parsed)) {
    throw new Error(`ENTITY_INFRA_PROFILE_NONCANONICAL:${parsed.entityId}`);
  }
  return parsed;
};

/** One strict parser shared by network frame, deterministic apply, and WAL boundaries. */
export const validateEntityInfraContext = (value: unknown): EntityInfraContext => {
  const raw = exactKeys(value, [
    'version', 'proposerReplicaId', 'entityId', 'proposerSignerId', 'parentFrameHash',
    'height', 'gossipProfiles', 'peerAssertions', 'htlc',
  ], 'ENTITY_INFRA_CONTEXT_INVALID');
  if (raw['version'] !== 1) throw new Error('ENTITY_INFRA_CONTEXT_VERSION_INVALID');
  const entityId = bytes32(raw['entityId'], 'ENTITY_INFRA_ENTITY_ID_INVALID');
  const proposerSignerId = String(raw['proposerSignerId'] ?? '');
  if (!proposerSignerId || proposerSignerId !== proposerSignerId.trim().toLowerCase()) {
    throw new Error('ENTITY_INFRA_PROPOSER_SIGNER_ID_INVALID');
  }
  const proposerReplicaId = String(raw['proposerReplicaId'] ?? '');
  if (proposerReplicaId !== `${entityId}:${proposerSignerId}`) {
    throw new Error('ENTITY_INFRA_PROPOSER_REPLICA_ID_INVALID');
  }
  const parentFrameHash = String(raw['parentFrameHash'] ?? '');
  if (parentFrameHash !== 'genesis') bytes32(parentFrameHash, 'ENTITY_INFRA_PARENT_HASH_INVALID');
  const height = raw['height'];
  if (!Number.isSafeInteger(height) || Number(height) < 1) throw new Error('ENTITY_INFRA_HEIGHT_INVALID');
  if (!Array.isArray(raw['gossipProfiles'])) throw new Error('ENTITY_INFRA_PROFILES_INVALID');
  const gossipProfiles = raw['gossipProfiles'].map(canonicalProfile);
  let previousProfileId = '';
  for (const profile of gossipProfiles) {
    if (profile.entityId !== profile.entityId.toLowerCase() || profile.entityId <= previousProfileId) {
      throw new Error('ENTITY_INFRA_PROFILES_NONCANONICAL');
    }
    previousProfileId = profile.entityId;
  }
  if (!Array.isArray(raw['peerAssertions'])) throw new Error('ENTITY_INFRA_PEER_ASSERTIONS_INVALID');
  const profileIds = new Set(gossipProfiles.map(profile => profile.entityId));
  let previousPeerId = '';
  const peerAssertions = raw['peerAssertions'].map((value, index) => {
    const peer = exactKeys(value, ['entityId', 'online'], `ENTITY_INFRA_PEER_ASSERTION_INVALID:${index}`);
    const peerEntityId = bytes32(peer['entityId'], `ENTITY_INFRA_PEER_ENTITY_ID_INVALID:${index}`);
    if (peerEntityId <= previousPeerId || !profileIds.has(peerEntityId) || typeof peer['online'] !== 'boolean') {
      throw new Error(`ENTITY_INFRA_PEER_ASSERTION_NONCANONICAL:${index}`);
    }
    previousPeerId = peerEntityId;
    return { entityId: peerEntityId, online: peer['online'] };
  });
  const htlc = validateHtlcPreparedInfraContext(raw['htlc']);
  const requiredProfileIds = new Set(peerAssertions.map(assertion => assertion.entityId));
  for (const originated of htlc.originated) {
    for (const routeEntityId of originated.route) requiredProfileIds.add(routeEntityId);
  }
  for (const entry of htlc.entries) {
    if (entry.outcome.kind === 'forward') requiredProfileIds.add(entry.outcome.nextHopEntityId);
  }
  if (
    requiredProfileIds.size !== profileIds.size ||
    [...requiredProfileIds].some(profileId => !profileIds.has(profileId))
  ) {
    throw new Error('ENTITY_INFRA_PROFILE_SET_NOT_EXACT');
  }
  const context: EntityInfraContext = {
    version: 1, proposerReplicaId, entityId, proposerSignerId, parentFrameHash,
    height: Number(height), gossipProfiles, peerAssertions, htlc,
  };
  const bytes = new TextEncoder().encode(encodeCanonicalConsensusValue(context)).byteLength;
  if (bytes > LIMITS.MAX_FRAME_SIZE_BYTES) {
    throw new Error(`ENTITY_INFRA_CONTEXT_BYTE_LIMIT_EXCEEDED:${bytes}:${LIMITS.MAX_FRAME_SIZE_BYTES}`);
  }
  return context;
};

/** Authenticate every committed Profile before any key/domain/capacity is trusted. */
export const assertEntityInfraContextAuthority = async (
  env: EntityRuntimeContext,
  context: EntityInfraContext,
  observerState: EntityState,
): Promise<void> => {
  for (const profile of context.gossipProfiles) {
    const result = await verifyProfileSignature(profile, env, observerState);
    if (!result.valid) {
      throw new Error(
        `ENTITY_INFRA_PROFILE_AUTHORITY_INVALID:${profile.entityId}:${result.reason ?? 'unknown'}`,
      );
    }
  }
};
