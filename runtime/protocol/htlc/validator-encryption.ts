import { Signature, computeAddress, getAddress, keccak256, recoverAddress } from 'ethers';
import { compareStableText, serializeTaggedJson } from '../serialization';

export const VALIDATOR_ENCRYPTION_ATTESTATION_VERSION = 'xln:validator-encryption-key:v1' as const;
export const ENTITY_PROFILE_CERTIFICATION_VERSION = 'xln:entity-profile-certification:v1' as const;

export type ValidatorEncryptionBoardMember = Readonly<{
  signerId: string;
  signer: string;
  publicKey?: string;
  weight: number;
}>;

export type ValidatorEncryptionBoard = Readonly<{
  entityId: string;
  threshold: number;
  validators: readonly ValidatorEncryptionBoardMember[];
}>;

export type ValidatorEncryptionAttestation = Readonly<{
  version: typeof VALIDATOR_ENCRYPTION_ATTESTATION_VERSION;
  entityId: string;
  signerId: string;
  signer: string;
  publicKey: string;
  weight: number;
  encryptionPublicKey: string;
  signature: string;
}>;

export type ValidatorEncryptionManifest = Readonly<{
  entityId: string;
  threshold: number;
  attestations: readonly ValidatorEncryptionAttestation[];
  hash: string;
}>;

export type EntityProfileCertificationWitness = Readonly<{
  profileHash: string;
  routingStateHash: string;
  hanko: string;
}>;

export type CertifiedValidatorEncryptionManifest = Readonly<{
  manifest: ValidatorEncryptionManifest;
  profileCertification: EntityProfileCertificationWitness;
  /** Certified board order, never the signerId-sorted manifest order. */
  recipientSignerId: string;
}>;

const normalizeBytes32 = (value: string, code: string): string => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error(code);
  return normalized;
};

/**
 * The Entity Hanko signs one compact commitment to both halves of a public
 * profile. `manifestHash` binds every validator X25519 key; `routingStateHash`
 * binds the remaining advertised capacities/policy. Onion layers can carry
 * only these two hashes plus the Hanko and still prove the embedded manifest
 * was certified by the Entity board.
 */
export const computeEntityProfileCertificationHash = (
  manifestHash: string,
  routingStateHash: string,
): string => keccak256(new TextEncoder().encode(serializeTaggedJson({
  version: ENTITY_PROFILE_CERTIFICATION_VERSION,
  manifestHash: normalizeBytes32(manifestHash, 'ENTITY_PROFILE_MANIFEST_HASH_INVALID'),
  routingStateHash: normalizeBytes32(routingStateHash, 'ENTITY_PROFILE_ROUTING_STATE_HASH_INVALID'),
})));

export const validateEntityProfileCertificationWitness = (
  manifestHash: string,
  witness: EntityProfileCertificationWitness,
): EntityProfileCertificationWitness => {
  const routingStateHash = normalizeBytes32(
    witness.routingStateHash,
    'ENTITY_PROFILE_ROUTING_STATE_HASH_INVALID',
  );
  const profileHash = normalizeBytes32(witness.profileHash, 'ENTITY_PROFILE_HASH_INVALID');
  if (profileHash !== computeEntityProfileCertificationHash(manifestHash, routingStateHash)) {
    throw new Error('ENTITY_PROFILE_MANIFEST_CERTIFICATION_MISMATCH');
  }
  const hanko = String(witness.hanko || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]+$/.test(hanko) || hanko.length % 2 !== 0) {
    throw new Error('ENTITY_PROFILE_HANKO_INVALID');
  }
  return { profileHash, routingStateHash, hanko };
};

const SECP256K1_HALF_ORDER = BigInt('0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0');

const normalizeSignerId = (value: string): string => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) throw new Error('VALIDATOR_ENCRYPTION_SIGNER_ID_REQUIRED');
  return normalized;
};

const normalizeAddress = (value: string, code: string): string => {
  try {
    return getAddress(value).toLowerCase();
  } catch {
    throw new Error(`${code}: ${String(value || '')}`);
  }
};

const normalizeSecpPublicKey = (value: string): string => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^0x(?:[0-9a-f]{66}|[0-9a-f]{130})$/.test(normalized)) {
    throw new Error('VALIDATOR_ENCRYPTION_SIGNING_PUBLIC_KEY_INVALID');
  }
  try {
    computeAddress(normalized);
  } catch {
    throw new Error('VALIDATOR_ENCRYPTION_SIGNING_PUBLIC_KEY_INVALID');
  }
  return normalized;
};

export const normalizeValidatorEncryptionPublicKey = (value: string): string => {
  const trimmed = String(value || '').trim();
  const normalized = (trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new Error('VALIDATOR_ENCRYPTION_X25519_PUBLIC_KEY_INVALID');
  }
  return normalized;
};

const normalizeWeight = (value: number): number => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffff) {
    throw new Error(`VALIDATOR_ENCRYPTION_WEIGHT_INVALID: ${String(value)}`);
  }
  return value;
};

const normalizeEntityId = (value: string): string => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) throw new Error('VALIDATOR_ENCRYPTION_ENTITY_ID_REQUIRED');
  return normalized;
};

const attestationBody = (attestation: Omit<ValidatorEncryptionAttestation, 'signature'>) => ({
  version: VALIDATOR_ENCRYPTION_ATTESTATION_VERSION,
  entityId: normalizeEntityId(attestation.entityId),
  signerId: normalizeSignerId(attestation.signerId),
  signer: normalizeAddress(attestation.signer, 'VALIDATOR_ENCRYPTION_SIGNER_INVALID'),
  publicKey: normalizeSecpPublicKey(attestation.publicKey),
  weight: normalizeWeight(attestation.weight),
  encryptionPublicKey: normalizeValidatorEncryptionPublicKey(attestation.encryptionPublicKey),
});

export const computeValidatorEncryptionAttestationDigest = (
  attestation: Omit<ValidatorEncryptionAttestation, 'signature'>,
): string => keccak256(new TextEncoder().encode(serializeTaggedJson(attestationBody(attestation))));

const normalizeSignature = (value: string): string => {
  if (!/^0x[0-9a-f]{130}$/i.test(value)) {
    throw new Error('VALIDATOR_ENCRYPTION_SIGNATURE_INVALID');
  }
  const parsed = Signature.from(value);
  if (BigInt(parsed.s) === 0n || BigInt(parsed.s) > SECP256K1_HALF_ORDER) {
    throw new Error('VALIDATOR_ENCRYPTION_SIGNATURE_NON_CANONICAL');
  }
  return parsed.serialized.toLowerCase();
};

const normalizeAttestation = (attestation: ValidatorEncryptionAttestation): ValidatorEncryptionAttestation => ({
  ...attestationBody(attestation),
  signature: normalizeSignature(attestation.signature),
});

const boardMemberBySignerId = (
  board: ValidatorEncryptionBoard,
  signerId: string,
): ValidatorEncryptionBoardMember | undefined => {
  const target = normalizeSignerId(signerId);
  return board.validators.find((validator) => normalizeSignerId(validator.signerId) === target);
};

export const verifyValidatorEncryptionAttestation = (
  board: ValidatorEncryptionBoard,
  rawAttestation: ValidatorEncryptionAttestation,
): ValidatorEncryptionAttestation => {
  const attestation = normalizeAttestation(rawAttestation);
  if (attestation.entityId !== normalizeEntityId(board.entityId)) {
    throw new Error('VALIDATOR_ENCRYPTION_ATTESTATION_ENTITY_MISMATCH');
  }
  const member = boardMemberBySignerId(board, attestation.signerId);
  if (!member) throw new Error('VALIDATOR_ENCRYPTION_ATTESTATION_UNKNOWN_SIGNER');
  const memberSigner = normalizeAddress(member.signer, 'VALIDATOR_ENCRYPTION_BOARD_SIGNER_INVALID');
  const memberPublicKey = member.publicKey ? normalizeSecpPublicKey(member.publicKey) : null;
  if (attestation.signer !== memberSigner || (memberPublicKey && attestation.publicKey !== memberPublicKey)) {
    throw new Error('VALIDATOR_ENCRYPTION_ATTESTATION_BOARD_IDENTITY_MISMATCH');
  }
  if (attestation.weight !== normalizeWeight(member.weight)) {
    throw new Error('VALIDATOR_ENCRYPTION_ATTESTATION_WEIGHT_MISMATCH');
  }
  if (computeAddress(attestation.publicKey).toLowerCase() !== attestation.signer) {
    throw new Error('VALIDATOR_ENCRYPTION_ATTESTATION_PUBLIC_KEY_MISMATCH');
  }
  const digest = computeValidatorEncryptionAttestationDigest(attestation);
  if (recoverAddress(digest, attestation.signature).toLowerCase() !== attestation.signer) {
    throw new Error('VALIDATOR_ENCRYPTION_ATTESTATION_SIGNATURE_MISMATCH');
  }
  return attestation;
};

const attestationIdentity = (attestation: ValidatorEncryptionAttestation): string =>
  serializeTaggedJson(attestation);

export const mergeValidatorEncryptionAttestations = (
  board: ValidatorEncryptionBoard,
  sources: Iterable<ValidatorEncryptionAttestation>,
): ValidatorEncryptionAttestation[] => {
  const merged = new Map<string, ValidatorEncryptionAttestation>();
  for (const source of sources) {
    const attestation = verifyValidatorEncryptionAttestation(board, source);
    const signerId = normalizeSignerId(attestation.signerId);
    const existing = merged.get(signerId);
    if (existing && attestationIdentity(existing) !== attestationIdentity(attestation)) {
      throw new Error(`VALIDATOR_ENCRYPTION_ATTESTATION_CONFLICT: signerId=${signerId}`);
    }
    merged.set(signerId, attestation);
  }
  return [...merged.values()].sort((left, right) => compareStableText(left.signerId, right.signerId));
};

const manifestBody = (
  board: ValidatorEncryptionBoard,
  attestations: readonly ValidatorEncryptionAttestation[],
) => ({
  version: VALIDATOR_ENCRYPTION_ATTESTATION_VERSION,
  entityId: normalizeEntityId(board.entityId),
  threshold: normalizeWeight(board.threshold),
  validators: attestations.map(({ signature: _signature, ...body }) => body),
});

export const requireCompleteValidatorEncryptionManifest = (
  board: ValidatorEncryptionBoard,
  sources: Iterable<ValidatorEncryptionAttestation>,
): ValidatorEncryptionManifest => {
  const attestations = mergeValidatorEncryptionAttestations(board, sources);
  if (attestations.length !== board.validators.length) {
    throw new Error(
      `VALIDATOR_ENCRYPTION_MANIFEST_INCOMPLETE: have=${attestations.length} expected=${board.validators.length}`,
    );
  }
  for (const validator of board.validators) {
    if (!attestations.some((entry) => entry.signerId === normalizeSignerId(validator.signerId))) {
      throw new Error(`VALIDATOR_ENCRYPTION_MANIFEST_MISSING_SIGNER: signerId=${validator.signerId}`);
    }
  }
  const uniqueEncryptionKeys = new Set(attestations.map((entry) => entry.encryptionPublicKey));
  if (uniqueEncryptionKeys.size !== attestations.length) {
    throw new Error('VALIDATOR_ENCRYPTION_MANIFEST_DUPLICATE_PUBLIC_KEY');
  }
  const hash = keccak256(new TextEncoder().encode(serializeTaggedJson(manifestBody(board, attestations))));
  return { entityId: normalizeEntityId(board.entityId), threshold: normalizeWeight(board.threshold), attestations, hash };
};

type ValidatorEncryptionConsensusConfig = Readonly<{
  threshold: bigint;
  validators: readonly string[];
  shares: Readonly<Record<string, bigint>>;
}>;

const uint16FromBigInt = (value: bigint, code: string): number => {
  if (value <= 0n || value > 0xffffn) throw new Error(`${code}: ${value.toString()}`);
  return Number(value);
};

/**
 * Rebuild a persisted public manifest from the exact consensus board aliases.
 * The signing address/public key still comes from each self-attestation, but
 * signerId, weight, threshold and Entity are fixed by consensus state. The
 * canonical equality check rejects extra/private fields and non-canonical
 * ordering at the restore boundary.
 */
export const validatePersistedValidatorEncryptionManifest = (
  entityId: string,
  config: ValidatorEncryptionConsensusConfig,
  manifest: ValidatorEncryptionManifest,
): ValidatorEncryptionManifest => {
  const attestationsBySigner = new Map<string, ValidatorEncryptionAttestation>();
  for (const attestation of manifest.attestations) {
    const key = normalizeSignerId(attestation.signerId);
    if (attestationsBySigner.has(key)) {
      throw new Error(`VALIDATOR_ENCRYPTION_MANIFEST_DUPLICATE_SIGNER: signerId=${key}`);
    }
    attestationsBySigner.set(key, attestation);
  }
  const board: ValidatorEncryptionBoard = {
    entityId: normalizeEntityId(entityId),
    threshold: uint16FromBigInt(config.threshold, 'VALIDATOR_ENCRYPTION_CONFIG_THRESHOLD_INVALID'),
    validators: config.validators.map((rawSignerId) => {
      const signerId = normalizeSignerId(rawSignerId);
      const attestation = attestationsBySigner.get(signerId);
      if (!attestation) {
        throw new Error(`VALIDATOR_ENCRYPTION_MANIFEST_MISSING_SIGNER: signerId=${signerId}`);
      }
      const weight = config.shares[rawSignerId] ?? config.shares[signerId] ?? 0n;
      return {
        signerId,
        signer: attestation.signer,
        publicKey: attestation.publicKey,
        weight: uint16FromBigInt(weight, 'VALIDATOR_ENCRYPTION_CONFIG_WEIGHT_INVALID'),
      };
    }),
  };
  const canonical = requireCompleteValidatorEncryptionManifest(board, manifest.attestations);
  if (serializeTaggedJson(manifest) !== serializeTaggedJson(canonical)) {
    throw new Error('VALIDATOR_ENCRYPTION_MANIFEST_NON_CANONICAL');
  }
  return canonical;
};

/** Validate a public manifest when only its self-attestations are available. */
export const validateSelfContainedValidatorEncryptionManifest = (
  manifest: ValidatorEncryptionManifest,
): ValidatorEncryptionManifest => {
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.attestations)) {
    throw new Error('VALIDATOR_ENCRYPTION_MANIFEST_INVALID');
  }
  const board: ValidatorEncryptionBoard = {
    entityId: normalizeEntityId(manifest.entityId),
    threshold: normalizeWeight(manifest.threshold),
    validators: manifest.attestations.map((attestation) => ({
      signerId: attestation.signerId,
      signer: attestation.signer,
      publicKey: attestation.publicKey,
      weight: attestation.weight,
    })),
  };
  const canonical = requireCompleteValidatorEncryptionManifest(board, manifest.attestations);
  const totalWeight = canonical.attestations.reduce((sum, attestation) => sum + attestation.weight, 0);
  if (canonical.threshold > totalWeight) {
    throw new Error(
      `VALIDATOR_ENCRYPTION_MANIFEST_THRESHOLD_UNREACHABLE: threshold=${canonical.threshold} total=${totalWeight}`,
    );
  }
  if (serializeTaggedJson(manifest) !== serializeTaggedJson(canonical)) {
    throw new Error('VALIDATOR_ENCRYPTION_MANIFEST_NON_CANONICAL');
  }
  return canonical;
};
