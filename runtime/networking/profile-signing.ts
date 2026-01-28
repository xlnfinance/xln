/**
 * Profile Signing & Verification for XLN Gossip
 *
 * Signs profiles with entity's secp256k1 key to prevent spoofing.
 * Relay stores profiles as-is; clients verify signatures on receipt.
 */

import * as secp256k1 from '@noble/secp256k1';
import { keccak256 } from 'ethers';
import type { Profile } from '../gossip';
import { getSignerPrivateKey, getCachedSignerPublicKey } from '../account-crypto';

const PROFILE_SIGN_DOMAIN = 'xln-profile-v1';

/**
 * Canonical profile digest for signing
 * Excludes signature field to avoid circular reference
 */
function computeProfileDigest(profile: Profile): string {
  // Extract signable fields (exclude signature itself)
  const { metadata, ...rest } = profile;
  const { profileSignature, ...metadataWithoutSig } = metadata || {};

  const signable = {
    ...rest,
    metadata: metadataWithoutSig,
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
 * Sign a profile using entity's first validator key
 * Returns profile with signature in metadata
 */
export function signProfile(env: { runtimeSeed: Uint8Array | string }, profile: Profile, signerId: string): Profile {
  const digest = computeProfileDigest(profile);
  const digestBytes = Buffer.from(digest.replace('0x', ''), 'hex');

  // Get private key and sign
  const privateKey = getSignerPrivateKey(env, signerId);
  const [signature, recovery] = secp256k1.signSync(digestBytes, privateKey, { recovered: true, der: false });
  const sigHex = `0x${Buffer.from(signature).toString('hex')}${recovery.toString(16).padStart(2, '0')}`;

  // Add signature to metadata
  return {
    ...profile,
    metadata: {
      ...profile.metadata,
      profileSignature: sigHex,
    },
  };
}

/**
 * Verify profile signature using entityPublicKey from metadata
 * Returns true if signature is valid, false otherwise
 */
export function verifyProfileSignature(profile: Profile): boolean {
  const signature = profile.metadata?.profileSignature;
  if (!signature || typeof signature !== 'string') {
    return false; // No signature to verify
  }

  // Get public key from profile metadata (entityPublicKey)
  const publicKeyHex = profile.metadata?.entityPublicKey;
  if (!publicKeyHex || typeof publicKeyHex !== 'string') {
    // Try to get from cached keys (first validator)
    const boardMeta = profile.metadata?.board;
    if (!boardMeta || typeof boardMeta !== 'object' || !('validators' in boardMeta)) {
      return false;
    }
    const firstValidator = boardMeta.validators[0];
    if (!firstValidator?.signerId && !firstValidator?.publicKey) {
      return false;
    }

    const signerId = firstValidator.signerId;
    if (signerId) {
      const cachedKey = getCachedSignerPublicKey(signerId);
      if (!cachedKey) return false;
      return verifyWithPublicKey(profile, signature, cachedKey);
    }

    if (firstValidator.publicKey) {
      const keyBytes = hexToBytes(firstValidator.publicKey);
      return verifyWithPublicKey(profile, signature, keyBytes);
    }

    return false;
  }

  const publicKey = hexToBytes(publicKeyHex);
  return verifyWithPublicKey(profile, signature, publicKey);
}

function verifyWithPublicKey(profile: Profile, signature: string, publicKey: Uint8Array): boolean {
  try {
    const digest = computeProfileDigest(profile);
    const digestBytes = Buffer.from(digest.replace('0x', ''), 'hex');

    // Extract compact signature (64 bytes)
    const sigHex = signature.replace('0x', '');
    const sigBytes = Buffer.from(sigHex.slice(0, 128), 'hex');

    return secp256k1.verify(sigBytes, digestBytes, publicKey);
  } catch (error) {
    console.warn(`Profile signature verification failed:`, error);
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
 * Check if profile has a valid signature (for filtering)
 */
export function hasValidProfileSignature(profile: Profile): boolean {
  if (!profile.metadata?.profileSignature) return false;
  return verifyProfileSignature(profile);
}
