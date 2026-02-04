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
import { signEntityHashes, verifyHankoForHash, signHashesAsSingleEntity } from '../hanko-signing';
import { getCachedSignerPublicKey, signDigest } from '../account-crypto';
import * as secp256k1 from '@noble/secp256k1';

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
 * Synchronous sign for backward compatibility (uses raw secp256k1)
 * Prefer async signProfile() which uses full Hanko mechanism
 */
export function signProfileSync(
  env: { runtimeSeed: Uint8Array | string },
  profile: Profile,
  signerId: string
): Profile {
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

  // Use signDigest which properly installs hmacSha256Sync before signing
  const sigHex = signDigest(env.runtimeSeed, signerId, hash);

  return {
    ...profileWithKey,
    metadata: {
      ...(profileWithKey.metadata || {}),
      profileSignature: sigHex,  // Legacy field for sync signing
    },
  };
}

/**
 * Verify profile using Hanko mechanism (same as accountFrame verification)
 * Falls back to legacy signature verification for migration
 */
export async function verifyProfileSignature(
  profile: Profile,
  env?: Env
): Promise<boolean> {
  // Prefer Hanko verification
  const hanko = profile.metadata?.['profileHanko'] as HankoString | undefined;
  if (hanko) {
    const hash = computeProfileHash(profile);
    const result = await verifyHankoForHash(hanko, hash, profile.entityId, env);
    return result.valid;
  }

  // Fallback: legacy signature verification (migration period)
  const signature = profile.metadata?.['profileSignature'];
  if (signature && typeof signature === 'string') {
    return verifyLegacySignature(profile, signature);
  }

  return false; // No signature
}

/**
 * Legacy signature verification (for profiles signed before Hanko migration)
 */
function verifyLegacySignature(profile: Profile, signature: string): boolean {
  try {
    const hash = computeProfileHash(profile);
    const hashBytes = Buffer.from(hash.replace('0x', ''), 'hex');

    // Get public key from entityPublicKey or board
    let publicKey: Uint8Array | null = null;

    const publicKeyHex = profile.metadata?.entityPublicKey;
    if (publicKeyHex && typeof publicKeyHex === 'string') {
      publicKey = hexToBytes(publicKeyHex);
    }

    if (!publicKey) {
      const boardMeta = profile.metadata?.board;
      if (boardMeta && typeof boardMeta === 'object' && 'validators' in boardMeta) {
        const firstValidator = boardMeta.validators[0];
        if (firstValidator?.publicKey) {
          publicKey = hexToBytes(firstValidator.publicKey);
        } else if (firstValidator?.signerId) {
          publicKey = getCachedSignerPublicKey(firstValidator.signerId);
        }
      }
    }

    if (!publicKey) return false;

    const sigHex = signature.replace('0x', '');
    const sigBytes = Buffer.from(sigHex.slice(0, 128), 'hex');

    return secp256k1.verify(sigBytes, hashBytes, publicKey);
  } catch (error) {
    console.warn('Legacy profile signature verification failed:', error);
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Check if profile has a valid signature (sync check for filtering)
 * Note: For full Hanko verification, use async verifyProfileSignature()
 */
export function hasValidProfileSignature(profile: Profile): boolean {
  return !!(profile.metadata?.['profileHanko'] || profile.metadata?.['profileSignature']);
}
