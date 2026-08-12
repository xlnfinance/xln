import type { EntityState, HashToSign } from '../../../../types';
import type { EntityRuntimeContext } from '../../../../runtime-context';
import type { EntityTx } from '../../../../../types/entity-tx';
import { prepareEntityTxState } from '../../../../state-clone';
import { buildValidatorEncryptionBoard } from '../../../../profile/profile-encryption';
import {
  buildEntityProfileDescriptor,
  computeEntityProfileDescriptorHash,
} from '../../../../profile/profile-descriptor';
import {
  requireCompleteValidatorEncryptionManifest,
  validatePersistedValidatorEncryptionManifest,
} from '../../../../../protocol/htlc/validator-encryption';

type CertifyProfileTx = Extract<EntityTx, { type: 'certifyProfile' }>;

const signerKey = (value: string): string => value.trim().toLowerCase();

export const buildCurrentEntityProfileHashToSign = (
  entityState: EntityState,
): HashToSign | null => {
  const stored = entityState.profileEncryptionManifest;
  if (!stored) return null;
  const manifest = validatePersistedValidatorEncryptionManifest(
    entityState.entityId,
    entityState.config,
    stored,
  );
  const attestationsBySigner = new Map(
    manifest.attestations.map((attestation) => [signerKey(attestation.signerId), attestation]),
  );
  const board: Parameters<typeof buildEntityProfileDescriptor>[1] = {
    threshold: manifest.threshold,
    // Gossip descriptors preserve the consensus config's validator order.
    // The manifest attestations have their own canonical sort, so iterating
    // them directly can sign a hash different from buildEntityProfile().
    validators: entityState.config.validators.map((rawSignerId) => {
      const attestation = attestationsBySigner.get(signerKey(rawSignerId));
      if (!attestation) {
        throw new Error(`PROFILE_CERTIFICATION_MANIFEST_SIGNER_MISSING:${rawSignerId}`);
      }
      return {
        signer: attestation.signer,
        signerId: attestation.signerId,
        publicKey: attestation.publicKey,
        weight: attestation.weight,
      };
    }),
    encryptionAttestations: [...manifest.attestations],
  };
  return {
    hash: computeEntityProfileDescriptorHash(buildEntityProfileDescriptor(entityState, board)),
    type: 'profile',
    context: `profile:${manifest.hash}`,
  };
};

export const handleCertifyProfileEntityTx = (
  env: EntityRuntimeContext,
  entityState: EntityState,
  entityTx: CertifyProfileTx,
  mutableFrameState = false,
) => {
  const trustedBoard = buildValidatorEncryptionBoard(env, entityState);
  const manifest = requireCompleteValidatorEncryptionManifest(
    trustedBoard,
    entityTx.data.encryptionAttestations,
  );
  const newState = prepareEntityTxState(entityState, mutableFrameState);
  newState.profileEncryptionManifest = manifest;

  // The transaction installs only the public encryption manifest. The frame
  // reducer derives the one final post-state profile digest after every Entity
  // transaction has applied, then includes it in the frame's unified Hanko
  // map. Signing here could certify an intermediate profile when later
  // transactions in the same frame change an Account or routing policy.
  return {
    newState,
    outputs: [],
  };
};
