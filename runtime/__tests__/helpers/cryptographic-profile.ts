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
} from '../../entity/profile';
import { canonicalizeProfile } from '../../entity/profile';
import { deriveEncryptionKeyPair, pubKeyToHex } from '../../protocol/crypto/p2p-crypto';
import {
  computeProfileHash,
  computeProfileRouteHash,
} from '../../entity/profile/profile-signing';

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
  const signer = deriveSignerAddressSync(signingSeed, signerId).toLowerCase();
  return { privateKey, signer };
};

export const deriveSingleSignerFixtureEntityId = (
  signingSeed: string,
  signerId = '1',
): string => generateLazyEntityId([deriveSignerAddressSync(signingSeed, signerId)], 1n).toLowerCase();

const fixtureEncryptionPublicKey = (options: CryptographicProfileOptions, signerId: string) => {
  const signer = fixtureSigner(options.signingSeed, signerId);
  const encryptionPublicKey = pubKeyToHex(deriveEncryptionKeyPair(
    `${options.signingSeed}:${signerId}:${options.entityId}:entity-encryption`,
  ).publicKey);
  return { signer: signer.signer, encryptionPublicKey };
};

export const buildCryptographicProfileFixture = (
  options: CryptographicProfileOptions,
): Profile => {
  const signerId = options.signerId ?? '1';
  const attested = fixtureEncryptionPublicKey(options, signerId);
  const profile: Profile = {
    entityId: options.entityId,
    entityEncryptionPublicKey: attested.encryptionPublicKey,
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
  });
  return canonicalizeProfile({
    ...entityCertified,
    runtimeSignature: signDigest(signingSeed, signerId, computeProfileRouteHash(entityCertified)),
  });
};
