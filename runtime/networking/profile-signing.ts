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
import type { Profile } from './gossip';
import type { Env, HankoString } from '../types';
import { signHashesAsSingleEntity, verifyHankoForHash } from '../hanko-signing';
import { getCachedSignerPublicKey } from '../account-crypto';

const PROFILE_SIGN_DOMAIN = 'xln-profile-v1';
const bytesToHex = (bytes: Uint8Array): string =>
  `0x${Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')}`;

/**
 * Canonical profile hash for signing
 * Excludes hanko field to avoid circular reference
 */
export function computeProfileHash(profile: Profile): string {
  const { metadata, ...rest } = profile;
  const { profileHanko, profileSignature, ...metadataClean } = metadata || {};

  const signable = {
    ...rest,
    metadata: metadataClean,
  };

  // Sort keys for deterministic serialization
  const ordered = sortObjectKeys(signable);
  const json = JSON.stringify(ordered, replacer);
  const message = `${PROFILE_SIGN_DOMAIN}:${json}`;

  return keccak256(new TextEncoder().encode(message));
}

/**
 * JSON replacer for bigint/Map serialization
 */
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'string') {
    const match = value.match(/^BigInt\(([-\d]+)\)$/);
    if (match) return match[1];
  }
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Map) return Object.fromEntries(value);
  return value;
}

/**
 * Recursively sort object keys for deterministic output
 */
function sortObjectKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sortObjectKeys);

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortObjectKeys((obj as Record<string, unknown>)[key]);
  }
  return sorted;
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
  const existingPubKey = profile.metadata?.entityPublicKey;
  let entityPublicKey = existingPubKey;
  if (!entityPublicKey) {
    const cached = getCachedSignerPublicKey(signerId);
    if (cached) {
      entityPublicKey = bytesToHex(cached);
    }
  }

  const profileWithKey = entityPublicKey
    ? { ...profile, metadata: { ...profile.metadata, entityPublicKey } }
    : profile;

  const hash = computeProfileHash(profileWithKey);

  // Use same signing mechanism as accountFrames
  const hankos = await signHashesAsSingleEntity(
    env,
    profile.entityId,
    signerId,
    [hash]
  );

  const profileHanko = hankos[0];
  if (!profileHanko) {
    throw new Error('PROFILE_SIGN_FAILED: No hanko returned');
  }

  return {
    ...profileWithKey,
    metadata: {
      ...(profileWithKey.metadata || {}),
      profileHanko,
    },
  };
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
  // Prefer Hanko verification
  const hanko = profile.metadata?.['profileHanko'] as HankoString | undefined;
  if (hanko) {
    const hash = computeProfileHash(profile);
    const result = await verifyHankoForHash(hanko, hash, profile.entityId, env);
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
  return !!profile.metadata?.['profileHanko'];
}
