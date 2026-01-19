/**
 * Real cryptographic signatures for account consensus
 * Uses secp256k1 (Ethereum standard) with HMAC-derived keys from BrainVault seed
 */

import * as secp256k1 from '@noble/secp256k1';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes } from '@noble/hashes/utils.js';
import { keccak256 } from 'ethers';

// Configure @noble/secp256k1 HMAC (required for signing)
// Always install a sync HMAC implementation (Node/Bun fast path, browser fallback).
const installHmacSync = () => {
  if (secp256k1.utils.hmacSha256Sync) return;
  const isBrowser =
    typeof window !== 'undefined' &&
    typeof window.document !== 'undefined';
  const isNodeLike =
    !isBrowser &&
    (typeof (globalThis as any).Bun !== 'undefined' ||
      (typeof process !== 'undefined' && !!process.versions?.node));
  try {
    if (isNodeLike && typeof require !== 'undefined') {
      const crypto = require('crypto');
      if (crypto && typeof crypto.createHmac === 'function') {
        secp256k1.utils.hmacSha256Sync = (key: Uint8Array, ...messages: Uint8Array[]) => {
          const hmac = crypto.createHmac('sha256', Buffer.from(key));
          for (const msg of messages) hmac.update(Buffer.from(msg));
          return new Uint8Array(hmac.digest());
        };
        return;
      }
    }
  } catch (e) {
    console.warn('Failed to configure secp256k1 HMAC via crypto:', e);
  }
  secp256k1.utils.hmacSha256Sync = (key: Uint8Array, ...messages: Uint8Array[]) => {
    return hmac(sha256, key, concatBytes(...messages));
  };
};
installHmacSync();
// Browser: deriveSignerKeySync uses noble hashes (no async required)

// Global key cache (signerId → private/public key)
// Populated by runtime when BrainVault seed is provided
const signerKeys = new Map<string, Uint8Array>();
const signerPublicKeys = new Map<string, Uint8Array>();
const signerAddresses = new Map<string, string>();
const externalPublicKeys = new Map<string, Uint8Array>();
let runtimeSeedBytes: Uint8Array | null = null;
let runtimeSeedLocked = false;
const textEncoder = new TextEncoder();

const toSeedBytes = (seed: Uint8Array | string): Uint8Array =>
  typeof seed === 'string' ? textEncoder.encode(seed) : seed;

/**
 * Derive signer private key from BrainVault master seed
 * Formula: privateKey = HMAC-SHA256(masterSeed, signerId)
 * Browser-compatible (pure JS HMAC) and Node-compatible
 */
export async function deriveSignerKey(masterSeed: Uint8Array, signerId: string): Promise<Uint8Array> {
  return deriveSignerKeySync(masterSeed, signerId);
}

export function deriveSignerKeySync(masterSeed: Uint8Array, signerId: string): Uint8Array {
  const message = textEncoder.encode(signerId);
  return hmac(sha256, masterSeed, message);
}

export function setRuntimeSeed(seed: Uint8Array | string | null): void {
  if (runtimeSeedLocked) {
    console.warn('⚠️ Runtime seed update ignored (crypto lock enabled)');
    return;
  }
  runtimeSeedBytes = seed ? toSeedBytes(seed) : null;
  signerKeys.clear();
  signerPublicKeys.clear();
  signerAddresses.clear();
  externalPublicKeys.clear();
}

export function lockRuntimeSeedUpdates(locked: boolean): void {
  runtimeSeedLocked = locked;
}

const getOrDeriveKey = (envSeed: Uint8Array, signerId: string): Uint8Array => {
  console.log(`🔍 getOrDeriveKey: signerId=${signerId.slice(-4)}`);
  const cached = signerKeys.get(signerId);
  if (cached) {
    console.log(`✅ Found cached key for ${signerId.slice(-4)}`);
    return cached;
  }
  console.log(`⚠️ No cached key for ${signerId.slice(-4)}, deriving from env.runtimeSeed...`);

  // PURE: ONLY use env seed, NEVER fall back to global
  if (!envSeed) {
    throw new Error(`CRYPTO_DETERMINISM_VIOLATION: getOrDeriveKey called without env.runtimeSeed for signer ${signerId}`);
  }
  console.log(`✅ Deriving key from env seed (${envSeed.length} bytes)`);
  const derived = deriveSignerKeySync(envSeed, signerId);
  registerSignerKey(signerId, derived);
  console.log(`✅ Derived and registered key for ${signerId.slice(-4)}`);
  return derived;
};

/**
 * Get cached signer private key (no derivation, cache-only)
 * Used by components like BrowserVM that don't have env access
 */
export function getCachedSignerPrivateKey(signerId: string): Uint8Array | null {
  return signerKeys.get(signerId) || null;
}

/**
 * Get cached signer public key (no derivation, cache-only)
 * Used by components that don't have env access
 */
export function getCachedSignerPublicKey(signerId: string): Uint8Array | null {
  const external = externalPublicKeys.get(signerId);
  if (external) return external;
  const cached = signerPublicKeys.get(signerId);
  if (cached) return cached;
  // Try deriving from cached private key
  const privateKey = signerKeys.get(signerId);
  if (!privateKey) return null;
  const publicKey = secp256k1.getPublicKey(privateKey);
  signerPublicKeys.set(signerId, publicKey);
  return publicKey;
}

/**
 * Get cached signer address (no derivation, cache-only)
 * Used by components that don't have env access
 */
export function getCachedSignerAddress(signerId: string): string | null {
  const cached = signerAddresses.get(signerId);
  if (cached) return cached;
  // Try deriving from cached private key
  const privateKey = signerKeys.get(signerId);
  if (!privateKey) return null;
  const address = privateKeyToAddress(privateKey);
  signerAddresses.set(signerId, address);
  return address;
}

// Export for hanko-signing.ts
export function getSignerPrivateKey(env: any, signerId: string): Uint8Array {
  if (!env?.runtimeSeed) {
    throw new Error(`CRYPTO_DETERMINISM_VIOLATION: getSignerPrivateKey called without env.runtimeSeed for signer ${signerId}`);
  }
  const seed = textEncoder.encode(env.runtimeSeed);
  return getOrDeriveKey(seed, signerId);
}

export function getSignerPublicKey(env: any, signerId: string): Uint8Array | null {
  const external = externalPublicKeys.get(signerId);
  if (external) return external;
  const cached = signerPublicKeys.get(signerId);
  if (cached) return cached;

  // Try cached private key first
  const cachedPrivateKey = signerKeys.get(signerId);
  if (cachedPrivateKey) {
    const publicKey = secp256k1.getPublicKey(cachedPrivateKey);
    signerPublicKeys.set(signerId, publicKey);
    return publicKey;
  }

  // Derive from env if available
  if (!env?.runtimeSeed) {
    return null;
  }
  const seed = textEncoder.encode(env.runtimeSeed);
  const privateKey = getOrDeriveKey(seed, signerId);
  const publicKey = secp256k1.getPublicKey(privateKey);
  signerPublicKeys.set(signerId, publicKey);
  return publicKey;
}

const privateKeyToAddress = (privateKey: Uint8Array): string => {
  const publicKey = secp256k1.getPublicKey(privateKey, false); // uncompressed 65 bytes
  const hash = keccak256(publicKey.slice(1));
  return `0x${hash.slice(-40)}`.toLowerCase();
};

export function deriveSignerAddressSync(seed: Uint8Array | string, signerId: string): string {
  const seedBytes = toSeedBytes(seed);
  const privateKey = deriveSignerKeySync(seedBytes, signerId);
  return privateKeyToAddress(privateKey);
}

export function getSignerAddress(env: any, signerId: string): string | null {
  const cached = signerAddresses.get(signerId);
  if (cached) return cached;

  // Try cached private key first
  const cachedPrivateKey = signerKeys.get(signerId);
  if (cachedPrivateKey) {
    const address = privateKeyToAddress(cachedPrivateKey);
    signerAddresses.set(signerId, address);
    return address;
  }

  // Derive from env if available
  if (!env?.runtimeSeed) {
    return null;
  }
  const seed = textEncoder.encode(env.runtimeSeed);
  const privateKey = getOrDeriveKey(seed, signerId);
  const address = privateKeyToAddress(privateKey);
  signerAddresses.set(signerId, address);
  return address;
}

/**
 * Register signer keys derived from a deterministic seed
 * Formula: privateKey = HMAC-SHA256(seed, signerId)
 */
export async function registerSeededKeys(
  seed: Uint8Array | string,
  signerIds: string[]
): Promise<void> {
  const seedBytes = toSeedBytes(seed);
  setRuntimeSeed(seedBytes);

  for (const signerId of signerIds) {
    const privateKey = await deriveSignerKey(seedBytes, signerId);
    registerSignerKey(signerId, privateKey);
  }

  console.log(`🔑 Registered ${signerIds.length} keys from seed`);
}

/**
 * Register signer keys (called when BrainVault unlocked)
 */
export function registerSignerKey(signerId: string, privateKey: Uint8Array): void {
  signerKeys.set(signerId, privateKey);
  signerPublicKeys.set(signerId, secp256k1.getPublicKey(privateKey));
  signerAddresses.set(signerId, privateKeyToAddress(privateKey));
}

export function registerSignerPublicKey(signerId: string, publicKey: Uint8Array | string): void {
  console.log(`📝 registerSignerPublicKey: signerId=${signerId.slice(-4)}, publicKey type=${typeof publicKey}`);
  if (signerKeys.has(signerId)) {
    console.log(`⚠️ signerId ${signerId.slice(-4)} already has private key, skipping public key registration`);
    return;
  }
  const bytes =
    typeof publicKey === 'string'
      ? Uint8Array.from(Buffer.from(publicKey.replace(/^0x/, ''), 'hex'))
      : publicKey;
  console.log(`📝 Public key bytes: ${bytes.length}`);
  externalPublicKeys.set(signerId, bytes);
  signerPublicKeys.delete(signerId);
  console.log(`✅ Registered external public key for ${signerId.slice(-4)}, total: ${externalPublicKeys.size}`);
}

/**
 * Register test keys for scenarios (deterministic test keys from signerId)
 * Used in CLI scenarios when BrainVault not available
 */
export async function registerTestKeys(signerIds: string[]): Promise<void> {
  const testMasterSeed = new Uint8Array(32);
  testMasterSeed.fill(42); // Deterministic test seed
  setRuntimeSeed(testMasterSeed);

  // Use registerSeededKeys but suppress its log (we log our own below)
  const seedBytes = testMasterSeed;
  for (const signerId of signerIds) {
    const privateKey = await deriveSignerKey(seedBytes, signerId);
    registerSignerKey(signerId, privateKey);
  }
  console.log(`🔑 Registered ${signerIds.length} test keys (deterministic from signerId)`);
}

/**
 * Clear all registered keys (for testing isolation)
 */
export function clearSignerKeys(): void {
  signerKeys.clear();
  signerPublicKeys.clear();
  externalPublicKeys.clear();
}

/**
 * Sign account frame using secp256k1
 * Returns: 65-byte signature (r + s + recovery)
 */
export function signAccountFrame(
  env: any,
  signerId: string,
  frameHash: string
): string {
  if (!env?.runtimeSeed) {
    throw new Error(`CRYPTO_DETERMINISM_VIOLATION: signAccountFrame called without env.runtimeSeed for signer ${signerId}`);
  }
  const seed = textEncoder.encode(env.runtimeSeed);

  console.log(`🔑 signAccountFrame CALLED: signerId=${signerId.slice(-4)}, frameHash=${frameHash.slice(0, 10)}, source=env`);
  console.log(`🔑 Available signerKeys:`, Array.from(signerKeys.keys()).map(k => k.slice(-4)));
  console.log(`🔑 Available signerPublicKeys:`, Array.from(signerPublicKeys.keys()).map(k => k.slice(-4)));

  const messageHash = keccak256(Buffer.from(frameHash.replace('0x', ''), 'hex'));
  const signature = signDigest(seed, signerId, messageHash);
  console.log(`✍️ Signed frame ${frameHash.slice(0, 10)} by ${signerId.slice(-4)}: ${signature.slice(0, 20)}...`);
  return signature;
}

export function signDigest(seed: Uint8Array, signerId: string, digestHex: string): string {
  installHmacSync();

  const privateKey = getOrDeriveKey(seed, signerId);

  const messageBytes = Buffer.from(digestHex.replace('0x', ''), 'hex');
  const [signature, recovery] = secp256k1.signSync(messageBytes, privateKey, { recovered: true, der: false });
  const sigHex = Buffer.from(signature).toString('hex') + recovery.toString(16).padStart(2, '0');
  return `0x${sigHex}`;
}

/**
 * Verify account signature using secp256k1
 */
export function verifyAccountSignature(
  env: any,
  signerId: string,
  frameHash: string,
  signature: string
): boolean {
  // Real signature verification
  console.log(`🔍 VERIFY: signerId=${signerId.slice(-4)}, frameHash=${frameHash.slice(0, 10)}, sig=${signature.slice(0, 20)}...`);
  const publicKey = getSignerPublicKey(env, signerId);
  if (!publicKey) {
    console.warn(`⚠️ Cannot verify - no public key for signerId=${signerId.slice(-4)}`);
    console.warn(`⚠️ Available keys:`, Array.from(signerPublicKeys.keys()).map(k => k.slice(-4)));
    console.warn(`⚠️ Available external keys:`, Array.from(externalPublicKeys.keys()).map(k => k.slice(-4)));
    return false;
  }
  console.log(`✅ Found public key for ${signerId.slice(-4)} (${publicKey.length} bytes)`);

  try {
    // Extract compact signature (64 bytes) from hex
    const sigHex = signature.replace('0x', '');
    const sigBytes = Buffer.from(sigHex.slice(0, 128), 'hex'); // First 64 bytes (r + s)

    // Hash the frame hash
    const messageHash = keccak256(Buffer.from(frameHash.replace('0x', ''), 'hex'));
    const messageBytes = Buffer.from(messageHash.replace('0x', ''), 'hex');

    // Verify signature using @noble/secp256k1
    const isValid = secp256k1.verify(sigBytes, messageBytes, publicKey);

    if (isValid) {
      console.log(`✅ Valid signature from ${signerId.slice(-4)} for frame ${frameHash.slice(0, 10)}`);
    } else {
      console.log(`❌ Invalid signature from ${signerId.slice(-4)} for frame ${frameHash.slice(0, 10)}`);
    }

    return isValid;
  } catch (error) {
    console.error(`❌ Signature verification error for ${signerId.slice(-4)}:`, error);
    return false;
  }
}

/**
 * Validate multiple signatures for account frame
 */
export function validateAccountSignatures(
  env: any,
  frameHash: string,
  signatures: string[],
  expectedSigners: string[]
): { valid: boolean; validSigners: string[] } {
  const validSigners: string[] = [];
  const remaining = new Set(expectedSigners);

  for (const signature of signatures) {
    for (const signer of Array.from(remaining)) {
      const isValid = verifyAccountSignature(env, signer, frameHash, signature);
      if (isValid) {
        validSigners.push(signer);
        remaining.delete(signer);
        break;
      }
    }
  }

  const allValid = validSigners.length === expectedSigners.length;

  console.log(`🔍 Signature validation: ${validSigners.length}/${expectedSigners.length} valid (${allValid ? 'PASS' : 'FAIL'})`);

  return { valid: allValid, validSigners };
}
