import type { EntityState, EntityTx, Env } from '../../../types';
import { cloneEntityState } from '../../../state-helpers';
import { buildValidatorEncryptionBoard } from '../../../networking/profile-encryption';
import { buildEntityProfileDescriptor, computeEntityProfileDescriptorHash } from '../../../networking/profile-descriptor';
import { requireCompleteValidatorEncryptionManifest } from '../../../protocol/htlc/validator-encryption';
import type { BoardMetadata } from '../../../networking/gossip';

type CertifyProfileTx = Extract<EntityTx, { type: 'certifyProfile' }>;

const signerKey = (value: string): string => String(value || '').trim().toLowerCase();

export const handleCertifyProfileEntityTx = (
  env: Env,
  entityState: EntityState,
  entityTx: CertifyProfileTx,
) => {
  const trustedBoard = buildValidatorEncryptionBoard(env, entityState);
  const manifest = requireCompleteValidatorEncryptionManifest(
    trustedBoard,
    entityTx.data.encryptionAttestations,
  );
  const attestationsBySigner = new Map(
    manifest.attestations.map((attestation) => [signerKey(attestation.signerId), attestation]),
  );
  const validators = trustedBoard.validators.map((member) => {
    const attestation = attestationsBySigner.get(signerKey(member.signerId));
    if (!attestation) {
      throw new Error(`PROFILE_CERTIFICATION_MANIFEST_SIGNER_MISSING:${member.signerId}`);
    }
    return {
      signer: member.signer,
      signerId: member.signerId,
      publicKey: attestation.publicKey,
      weight: member.weight,
    };
  });
  const board: BoardMetadata = {
    threshold: manifest.threshold,
    validators,
    encryptionAttestations: [...manifest.attestations],
  };
  const newState = cloneEntityState(entityState);
  newState.profileEncryptionManifest = manifest;
  const profileHash = computeEntityProfileDescriptorHash(buildEntityProfileDescriptor(newState, board));

  // The proposer may transport the public attestations, but it never chooses
  // the signed digest: every validator rebuilds this descriptor from replayed
  // Entity state and the exact current board before signing HashType `profile`.
  return {
    newState,
    outputs: [],
    hashesToSign: [{
      hash: profileHash,
      type: 'profile' as const,
      context: `profile:${manifest.hash}`,
    }],
  };
};
