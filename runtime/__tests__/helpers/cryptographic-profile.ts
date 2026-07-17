import { SigningKey, hexlify } from 'ethers';
import {
  deriveSignerAddressSync,
  deriveSignerKeySync,
  signDigest,
} from '../../account/crypto';
import { generateLazyEntityId } from '../../entity/factory';
import { buildSingleSignerHanko } from '../../hanko/batch';
import type {
  Profile,
  ProfileAccount,
  ProfileJurisdiction,
} from '../../networking/gossip';
import { canonicalizeProfile } from '../../networking/gossip';
import { deriveEncryptionKeyPair, pubKeyToHex } from '../../networking/p2p-crypto';
import {
  computeProfileHash,
  computeProfileRouteHash,
} from '../../networking/profile-signing';
import { computeValidatorEncryptionAttestationDigest } from '../../protocol/htlc/validator-encryption';

type CryptographicProfileOptions = Readonly<{
  entityId: string;
  signingSeed: string;
  signerId?: string;
  name: string;
  runtimeId?: string;
  runtimeEncPubKey?: string;
  lastUpdated?: number;
  isHub?: boolean;
  jurisdiction?: ProfileJurisdiction;
  publicAccounts?: string[];
  accounts?: ProfileAccount[];
}>;

const fixtureSigner = (signingSeed: string, signerId: string) => {
  const privateKey = deriveSignerKeySync(signingSeed, signerId);
  const publicKey = new SigningKey(hexlify(privateKey)).publicKey.toLowerCase();
  const signer = deriveSignerAddressSync(signingSeed, signerId).toLowerCase();
  return { privateKey, publicKey, signer };
};

export const deriveSingleSignerFixtureEntityId = (
  signingSeed: string,
  signerId = '1',
): string => generateLazyEntityId([deriveSignerAddressSync(signingSeed, signerId)], 1n).toLowerCase();

const buildAttestedBoard = (options: CryptographicProfileOptions, signerId: string) => {
  const signer = fixtureSigner(options.signingSeed, signerId);
  const encryptionPublicKey = pubKeyToHex(deriveEncryptionKeyPair(
    `${options.signingSeed}:${signerId}:${options.entityId}:validator-encryption`,
  ).publicKey);
  const attestationBody = {
    version: 'xln:validator-encryption-key:v1' as const,
    entityId: options.entityId,
    signerId: signer.signer,
    signer: signer.signer,
    publicKey: signer.publicKey,
    weight: 1,
    encryptionPublicKey,
  };
  const signature = signDigest(
    options.signingSeed,
    signerId,
    computeValidatorEncryptionAttestationDigest(attestationBody),
  );
  return {
    signer: signer.signer,
    encryptionPublicKey,
    board: {
      threshold: 1,
      validators: [{
        signer: signer.signer,
        signerId: signer.signer,
        publicKey: signer.publicKey,
        weight: 1,
      }],
      encryptionAttestations: [{ ...attestationBody, signature }],
    },
  };
};

export const buildCryptographicProfileFixture = (
  options: CryptographicProfileOptions,
): Profile => {
  const signerId = options.signerId ?? '1';
  const attested = buildAttestedBoard(options, signerId);
  const profile: Profile = {
    entityId: options.entityId,
    name: options.name,
    avatar: '', bio: '', website: '',
    lastUpdated: options.lastUpdated ?? 1,
    runtimeId: options.runtimeId ?? attested.signer,
    runtimeEncPubKey: options.runtimeEncPubKey ?? attested.encryptionPublicKey,
    publicAccounts: options.publicAccounts ?? [],
    wsUrl: null, relays: [],
    metadata: {
      isHub: options.isHub ?? false,
      routingFeePPM: 1, baseFee: 0n,
      ...(options.jurisdiction ? { jurisdiction: options.jurisdiction } : {}),
      board: attested.board,
    },
    accounts: options.accounts ?? [],
  };
  return canonicalizeProfile(profile);
};

export const certifySingleSignerProfileFixture = (
  profile: Profile,
  signingSeed: string,
  signerId = '1',
): Profile => {
  const expectedEntityId = deriveSingleSignerFixtureEntityId(signingSeed, signerId);
  if (profile.entityId.toLowerCase() !== expectedEntityId) {
    throw new Error(`TEST_PROFILE_LAZY_ENTITY_ID_MISMATCH: expected=${expectedEntityId} actual=${profile.entityId}`);
  }
  const signer = fixtureSigner(signingSeed, signerId);
  const profileHash = computeProfileHash(profile);
  const entityCertified = canonicalizeProfile({
    ...profile,
    metadata: {
      ...profile.metadata,
      profileHanko: buildSingleSignerHanko(profile.entityId, profileHash, signer.privateKey),
    },
    runtimeSignerId: signer.signer,
  });
  return canonicalizeProfile({
    ...entityCertified,
    runtimeSignature: signDigest(signingSeed, signerId, computeProfileRouteHash(entityCertified)),
  });
};
