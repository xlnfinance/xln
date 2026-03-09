/**
 * Profile Signing & Verification for XLN Gossip
 *
 * Uses the same Hanko mechanism as accountFrames, disputeHash, and settlements.
 * This is NOT a custom signing scheme - it's the generalized XLN hash signing.
 *
 * ARCHITECTURE:
 * - Profile hash computed from canonical JSON representation
 * - Signed using signHashesAsSingleEntity() (same as accountFrame signing)
 * - Verified using verifyHankoForHash() (same verification path)
 * - Hanko stored in profile.metadata.profileHanko (ABI-encoded HankoBytes)
 *
 * KEY BINDING:
 * - Hanko contains claim for entityId
 * - Verification checks signer against entity's board validators
 * - Same security model as all other entity operations
 */

import { keccak256 } from 'ethers';
import { canonicalizeProfile, type Profile } from './gossip';
import type { Env, HankoString } from '../types';
import { inspectHankoForHash, signHashesAsSingleEntity, verifyHankoForHash } from '../hanko-signing';
import { getSignerAddress, getSignerPublicKey } from '../account-crypto';
import { serializeTaggedJson } from '../serialization-utils';

const PROFILE_SIGN_DOMAIN = 'xln-profile-v1';
const bytesToHex = (bytes: Uint8Array): string =>
  `0x${Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')}`;

/**
 * Canonical profile hash for signing
 * Excludes hanko field to avoid circular reference
 */
export function computeProfileHash(profile: Profile): string {
  const { metadata, ...rest } = profile;
  const { profileHanko, ...metadataClean } = metadata || {};

  const signable = {
    ...rest,
    metadata: metadataClean,
  };

  const json = serializeTaggedJson(signable);
  const message = `${PROFILE_SIGN_DOMAIN}:${json}`;

  return keccak256(new TextEncoder().encode(message));
}

/**
 * Sign a profile using Hanko mechanism (same as accountFrames)
 * Returns profile with hanko in metadata
 */
export async function signProfile(
  env: Env,
  profile: Profile,
  signerId: string
): Promise<Profile> {
  const canonicalProfile = canonicalizeProfile(profile);
  const existingPubKey = canonicalProfile.metadata.entityPublicKey;
  let entityPublicKey = existingPubKey;
  if (!entityPublicKey) {
    const signerPublicKey = getSignerPublicKey(env, signerId);
    if (!signerPublicKey) {
      throw new Error(`PROFILE_SIGN_ENTITY_PUBLIC_KEY_REQUIRED: entity=${canonicalProfile.entityId} signerId=${signerId}`);
    }
    entityPublicKey = bytesToHex(signerPublicKey);
  }

  const profileWithKey = entityPublicKey
    ? { ...canonicalProfile, metadata: { ...canonicalProfile.metadata, entityPublicKey } }
    : canonicalProfile;

  const hash = computeProfileHash(profileWithKey);

  // Use same signing mechanism as accountFrames
  const hankos = await signHashesAsSingleEntity(
    env,
    canonicalProfile.entityId,
    signerId,
    [hash]
  );

  const profileHanko = hankos[0];
  if (!profileHanko) {
    throw new Error('PROFILE_SIGN_FAILED: No hanko returned');
  }

  // Fail fast if we just produced a non-canonical lazy-entity hanko.
  // This catches wrong signer-key selection at the source runtime.
  try {
    const details = await inspectHankoForHash(profileHanko, hash);
    const reconstructedBoardHash = details.claims[0]?.reconstructedBoardHash?.toLowerCase();
    const expectedEntityId = canonicalProfile.entityId.toLowerCase();
    if (reconstructedBoardHash && reconstructedBoardHash !== expectedEntityId) {
      const recovered = details.recoveredAddresses[0] || 'none';
      const envSignerAddress = getSignerAddress(env, signerId) || 'none';
      throw new Error(
        `PROFILE_SIGN_SOURCE_MISMATCH: entity=${expectedEntityId} signerId=${signerId} ` +
        `envSigner=${envSignerAddress} recovered=${recovered} reconstructed=${reconstructedBoardHash}`,
      );
    }
  } catch (error) {
    throw error instanceof Error
      ? error
      : new Error(`PROFILE_SIGN_SOURCE_INSPECT_FAILED: ${String(error)}`);
  }

  return canonicalizeProfile({
    ...profileWithKey,
    metadata: {
      ...profileWithKey.metadata,
      profileHanko,
    },
  });
}

/**
 * Verify profile using Hanko mechanism (same as accountFrame verification)
 * Self-contained: Hanko embeds the board, no external lookup needed
 */
export type ProfileVerifyResult = {
  valid: boolean;
  reason?: string;
  hash?: string;
  signerId?: string;
};

export async function verifyProfileSignature(
  profile: Profile,
  env?: Env
): Promise<ProfileVerifyResult> {
  const canonicalProfile = canonicalizeProfile(profile);
  // Prefer Hanko verification
  const hanko = canonicalProfile.metadata['profileHanko'] as HankoString | undefined;
  if (hanko) {
    const hash = computeProfileHash(canonicalProfile);
    const result = await verifyHankoForHash(hanko, hash, canonicalProfile.entityId, env);
    if (!result.valid) {
      return {
        valid: false,
        reason: `hanko_invalid: entityId=${result.entityId?.slice(-8) || 'none'}`,
        hash,
      };
    }
    return { valid: true, hash };
  }

  return { valid: false, reason: 'no_signature' };
}

/**
 * Check if profile has a valid signature (sync check for filtering)
 * Note: For full Hanko verification, use async verifyProfileSignature()
 */
export function hasValidProfileSignature(profile: Profile): boolean {
  return !!profile.metadata.profileHanko;
}
