import { getSignerAddress, getSignerPublicKey, signAccountFrame } from '../account/crypto';
import { hasLocalSignerKey } from '../entity/crypto';
import type { EntityState, Env } from '../types';
import { serializeTaggedJson } from '../protocol/serialization';
import {
  computeValidatorEncryptionAttestationDigest,
  mergeValidatorEncryptionAttestations,
  requireCompleteValidatorEncryptionManifest,
  type ValidatorEncryptionAttestation,
  type ValidatorEncryptionBoard,
  type ValidatorEncryptionManifest,
} from '../protocol/htlc/validator-encryption';

export type ValidatorEncryptionAnnouncement = Readonly<{
  board: ValidatorEncryptionBoard;
  attestation: ValidatorEncryptionAttestation;
}>;

const PROFILE_ENCRYPTION_CACHE = Symbol.for('xln.runtime.profile-encryption-cache');
type ProfileEncryptionCache = Map<string, Map<string, ValidatorEncryptionAttestation>>;

const cacheForEnv = (env: Env): ProfileEncryptionCache => {
  const record = env as unknown as Record<PropertyKey, unknown>;
  const existing = record[PROFILE_ENCRYPTION_CACHE];
  if (existing instanceof Map) return existing as ProfileEncryptionCache;
  const created: ProfileEncryptionCache = new Map();
  record[PROFILE_ENCRYPTION_CACHE] = created;
  return created;
};

const entityKey = (entityId: string): string => entityId.trim().toLowerCase();
const signerKey = (signerId: string): string => signerId.trim().toLowerCase();

const requireUint16 = (value: bigint, code: string): number => {
  if (value <= 0n || value > 0xffffn) throw new Error(`${code}: ${value.toString()}`);
  return Number(value);
};

const publicKeyHex = (bytes: Uint8Array): string => {
  let result = '0x';
  for (const byte of bytes) result += byte.toString(16).padStart(2, '0');
  return result;
};

export const buildValidatorEncryptionBoard = (
  env: Env,
  state: EntityState,
): ValidatorEncryptionBoard => ({
  entityId: entityKey(state.entityId),
  threshold: requireUint16(state.config.threshold, 'PROFILE_ENCRYPTION_THRESHOLD_INVALID'),
  validators: state.config.validators.map((signerId) => {
    const signer = getSignerAddress(env, signerId);
    if (!signer) {
      throw new Error(`PROFILE_ENCRYPTION_BOARD_SIGNER_UNAVAILABLE: entity=${state.entityId} signerId=${signerId}`);
    }
    const weight = requireUint16(
      state.config.shares[signerId] ?? state.config.shares[signerKey(signerId)] ?? 0n,
      'PROFILE_ENCRYPTION_BOARD_WEIGHT_INVALID',
    );
    const canonicalSigner = signer.toLowerCase();
    // signerId is the consensus-state key, including numeric aliases. Replacing
    // it with the EOA makes a manifest valid at creation but impossible to
    // authenticate after restore, where validators/shares are keyed by alias.
    return { signerId: signerKey(signerId), signer: canonicalSigner, weight };
  }),
});

const findLocalReplica = (env: Env, entityId: string, signerId: string) => {
  const entity = entityKey(entityId);
  const signer = signerKey(signerId);
  for (const replica of env.eReplicas.values()) {
    if (entityKey(replica.entityId) === entity && signerKey(replica.signerId) === signer) return replica;
  }
  return null;
};

export const createLocalValidatorEncryptionAttestation = (
  env: Env,
  state: EntityState,
  signerId: string,
): ValidatorEncryptionAttestation => {
  if (!hasLocalSignerKey(env, signerId)) {
    throw new Error(`PROFILE_ENCRYPTION_LOCAL_SIGNER_KEY_REQUIRED: signerId=${signerId}`);
  }
  const board = buildValidatorEncryptionBoard(env, state);
  const signerAddress = getSignerAddress(env, signerId)?.toLowerCase();
  const member = board.validators.find((validator) => signerKey(validator.signerId) === signerKey(signerId));
  if (!member) throw new Error(`PROFILE_ENCRYPTION_SIGNER_NOT_ON_BOARD: signerId=${signerId}`);
  if (member.signer !== signerAddress) {
    throw new Error(`PROFILE_ENCRYPTION_SIGNER_IDENTITY_MISMATCH: signerId=${signerId}`);
  }
  const replica = findLocalReplica(env, state.entityId, signerId);
  const encryptionPublicKey = replica?.state.entityEncPubKey;
  if (!encryptionPublicKey) {
    throw new Error(`PROFILE_ENCRYPTION_LOCAL_X25519_KEY_REQUIRED: signerId=${signerId}`);
  }
  const body = {
    version: 'xln:validator-encryption-key:v1' as const,
    entityId: board.entityId,
    ...member,
    publicKey: publicKeyHex(getSignerPublicKey(env, signerId)!),
    encryptionPublicKey,
  };
  return { ...body, signature: signAccountFrame(env, signerId, computeValidatorEncryptionAttestationDigest(body)) };
};

const cacheForEntity = (env: Env, entityId: string): Map<string, ValidatorEncryptionAttestation> => {
  const byEntity = cacheForEnv(env);
  const key = entityKey(entityId);
  let bySigner = byEntity.get(key);
  if (!bySigner) {
    bySigner = new Map();
    byEntity.set(key, bySigner);
  }
  return bySigner;
};

export const mergeProfileEncryptionAttestations = (
  env: Env,
  board: ValidatorEncryptionBoard,
  incoming: Iterable<ValidatorEncryptionAttestation>,
): ValidatorEncryptionAttestation[] => {
  const cache = cacheForEntity(env, board.entityId);
  const merged = mergeValidatorEncryptionAttestations(board, [...cache.values(), ...incoming]);
  cache.clear();
  for (const attestation of merged) cache.set(signerKey(attestation.signerId), attestation);
  return merged;
};

export const collectLocalProfileEncryptionAnnouncements = (
  env: Env,
  entityIds?: ReadonlySet<string>,
): ValidatorEncryptionAnnouncement[] => {
  const announcements: ValidatorEncryptionAnnouncement[] = [];
  for (const replica of env.eReplicas.values()) {
    if (entityIds && !entityIds.has(entityKey(replica.entityId))) continue;
    if (!hasLocalSignerKey(env, replica.signerId)) continue;
    const board = buildValidatorEncryptionBoard(env, replica.state);
    const attestation = createLocalValidatorEncryptionAttestation(env, replica.state, replica.signerId);
    mergeProfileEncryptionAttestations(env, board, [attestation]);
    announcements.push({ board, attestation });
  }
  return announcements;
};

export const acceptProfileEncryptionAnnouncement = (
  env: Env,
  announcement: ValidatorEncryptionAnnouncement,
): ValidatorEncryptionAttestation[] => {
  const localReplica = [...env.eReplicas.values()].find(
    (replica) => entityKey(replica.entityId) === entityKey(announcement.board.entityId),
  );
  if (!localReplica) throw new Error(`PROFILE_ENCRYPTION_ENTITY_NOT_LOCAL: entity=${announcement.board.entityId}`);
  const trustedBoard = buildValidatorEncryptionBoard(env, localReplica.state);
  const trustedIdentity = serializeTaggedJson(trustedBoard);
  if (serializeTaggedJson(announcement.board) !== trustedIdentity) {
    throw new Error(`PROFILE_ENCRYPTION_BOARD_MISMATCH: entity=${announcement.board.entityId}`);
  }
  return mergeProfileEncryptionAttestations(env, trustedBoard, [announcement.attestation]);
};

export const getProfileEncryptionAttestations = (
  env: Env,
  entityId: string,
): ValidatorEncryptionAttestation[] => [...(cacheForEntity(env, entityId).values())];

export const requireProfileEncryptionManifest = (
  env: Env,
  state: EntityState,
): ValidatorEncryptionManifest => requireCompleteValidatorEncryptionManifest(
  buildValidatorEncryptionBoard(env, state),
  getProfileEncryptionAttestations(env, state.entityId),
);

export const getCompleteProfileEncryptionManifest = (
  env: Env,
  state: EntityState,
): ValidatorEncryptionManifest | null => {
  if (state.profileEncryptionManifest) {
    const restored = requireCompleteValidatorEncryptionManifest(
      buildValidatorEncryptionBoard(env, state),
      state.profileEncryptionManifest.attestations,
    );
    if (restored.hash !== state.profileEncryptionManifest.hash) {
      throw new Error(`PROFILE_ENCRYPTION_CERTIFIED_MANIFEST_CORRUPTION: entity=${state.entityId}`);
    }
    return restored;
  }
  const attestations = getProfileEncryptionAttestations(env, state.entityId);
  if (attestations.length !== state.config.validators.length) return null;
  return requireCompleteValidatorEncryptionManifest(buildValidatorEncryptionBoard(env, state), attestations);
};
