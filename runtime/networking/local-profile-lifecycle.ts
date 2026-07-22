import { getSignerPrivateKeyIfAvailable } from '../account/crypto';
import { isEntityActiveLeader } from '../entity/consensus/leader';
import type { EntityInput, EntityReplica, Env } from '../types';
import {
  collectLocalProfileEncryptionAnnouncements,
  getCompleteProfileEncryptionManifest,
  buildValidatorEncryptionBoard,
} from './profile-encryption';
import { buildLocalEntityProfile } from './gossip-helper';
import { computeProfileHash, signProfileRuntimeRoute } from './profile-signing';
import { compareStableText } from '../protocol/serialization';
import {
  requireCompleteValidatorEncryptionManifest,
  type ValidatorEncryptionAttestation,
  type ValidatorEncryptionManifest,
} from '../protocol/htlc/validator-encryption';

const normalize = (value: string): string => value.trim().toLowerCase();

const hasLocalSigner = (env: Env, signerId: string): boolean => {
  return getSignerPrivateKeyIfAvailable(env, signerId) !== null;
};

const entityReplicas = (env: Env, entityId: string): EntityReplica[] => {
  const normalizedEntityId = normalize(entityId);
  return [...env.eReplicas.values()].filter(
    (replica) => normalize(replica.entityId) === normalizedEntityId,
  );
};

const hasCertificationTx = (txs: readonly { type: string }[] | undefined): boolean =>
  txs?.some((tx) => tx.type === 'certifyProfile') === true;

const hasPendingCertification = (env: Env, entityId: string): boolean => {
  const normalizedEntityId = normalize(entityId);
  for (const replica of entityReplicas(env, normalizedEntityId)) {
    if (
      hasCertificationTx(replica.mempool)
      || hasCertificationTx(replica.proposal?.txs)
      || hasCertificationTx(replica.lockedFrame?.txs)
    ) return true;
  }
  for (const input of [
    ...(env.runtimeMempool?.entityInputs ?? []),
    ...(env.runtimeInput?.entityInputs ?? []),
  ]) {
    if (normalize(input.entityId) === normalizedEntityId && hasCertificationTx(input.entityTxs)) return true;
  }
  return false;
};

const currentProfileIsCertified = (
  env: Env,
  replica: EntityReplica,
  manifest: ValidatorEncryptionManifest,
): boolean => {
  if (replica.state.profileEncryptionManifest?.hash !== manifest.hash) return false;
  const profile = buildLocalEntityProfile(env, replica.state, 1);
  const witness = replica.hankoWitness?.get(computeProfileHash(profile));
  return witness?.type === 'profile';
};

/**
 * Build the one real Entity transaction that certifies the current public
 * routing descriptor. Attestations are public inputs; validators independently
 * rebuild the exact descriptor/hash in handleCertifyProfileEntityTx.
 */
export const buildLocalProfileCertificationInput = (
  env: Env,
  entityId: string,
  encryptionAttestations?: readonly ValidatorEncryptionAttestation[],
): EntityInput | null => {
  const replicas = entityReplicas(env, entityId);
  const leader = replicas.find((replica) => isEntityActiveLeader(replica));
  if (!leader || !hasLocalSigner(env, leader.signerId)) return null;

  const manifest = encryptionAttestations
    ? requireCompleteValidatorEncryptionManifest(
        buildValidatorEncryptionBoard(env, leader.state),
        encryptionAttestations,
      )
    : getCompleteProfileEncryptionManifest(env, leader.state);
  if (!manifest || currentProfileIsCertified(env, leader, manifest)) return null;
  if (hasPendingCertification(env, entityId)) return null;

  return {
    entityId: leader.entityId,
    signerId: leader.signerId,
    entityTxs: [{
      type: 'certifyProfile',
      data: { encryptionAttestations: [...manifest.attestations] },
    }],
  };
};

/** Collect due profile certifications even when no P2P transport is running. */
export const collectDueLocalProfileCertificationInputs = (
  env: Env,
  candidateEntityIds?: ReadonlySet<string>,
): EntityInput[] => {
  const candidates = candidateEntityIds
    ? new Set([...candidateEntityIds].map(normalize))
    : undefined;
  const localEntityIds = new Set(
    [...env.eReplicas.values()]
      .filter((replica) => (!candidates || candidates.has(normalize(replica.entityId))))
      .filter((replica) => hasLocalSigner(env, replica.signerId))
      .map((replica) => normalize(replica.entityId)),
  );
  const inputs: EntityInput[] = [];
  for (const entityId of [...localEntityIds].sort(compareStableText)) {
    const state = entityReplicas(env, entityId)[0]?.state;
    if (!state) continue;
    // A persisted manifest already contains the complete signed validator-key
    // board. Re-signing and re-merging every local attestation on each Account
    // update was a pure CPU tax; only incomplete initial certification needs
    // fresh local announcements.
    let manifest = getCompleteProfileEncryptionManifest(env, state);
    if (!manifest) {
      collectLocalProfileEncryptionAnnouncements(env, new Set([entityId]));
      manifest = getCompleteProfileEncryptionManifest(env, state);
    }
    if (!manifest) continue;
    const input = buildLocalProfileCertificationInput(env, entityId, manifest.attestations);
    if (input) inputs.push(input);
  }
  return inputs;
};

/**
 * Announce only a profile whose exact current descriptor already has a
 * committed Entity Hanko witness. Missing witnesses remain non-routable.
 */
export const announceCertifiedLocalProfiles = async (
  env: Env,
  entityIds: readonly string[],
): Promise<number> => {
  let announced = 0;
  for (const entityId of [...new Set(entityIds.map(normalize))].sort(compareStableText)) {
    const existing = env.gossip.getProfiles().find((profile) => normalize(profile.entityId) === entityId);
    const candidates = entityReplicas(env, entityId)
      .filter((replica) => hasLocalSigner(env, replica.signerId))
      .sort((left, right) => compareStableText(normalize(left.signerId), normalize(right.signerId)));
    for (const replica of candidates) {
      if (!replica.state.profileEncryptionManifest) continue;
      const latestProfileWitness = [...(replica.hankoWitness?.entries() ?? [])]
        .filter(([, witness]) => witness.type === 'profile')
        .sort((left, right) => (
          right[1].entityHeight - left[1].entityHeight
          || right[1].createdAt - left[1].createdAt
          || compareStableText(left[0], right[0])
        ))[0];
      if (
        existing
        && latestProfileWitness
        && computeProfileHash(existing) === latestProfileWitness[0]
        && existing.metadata.profileHanko === latestProfileWitness[1].hanko
      ) {
        break;
      }
      const profile = buildLocalEntityProfile(env, replica.state);
      const witness = replica.hankoWitness?.get(computeProfileHash(profile));
      if (!witness || witness.type !== 'profile') continue;
      profile.metadata.profileHanko = witness.hanko;
      env.gossip.announce(await signProfileRuntimeRoute(env, profile, replica.signerId));
      announced += 1;
      break;
    }
  }
  return announced;
};
