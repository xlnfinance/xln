/**
 * Real cryptographic signatures for account consensus.
 * Canonical signerId is EOA address (lowercase). Keys are loaded via registerSignerKey.
 */

import * as secp256k1 from '@noble/secp256k1';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes } from '@noble/hashes/utils.js';
import { HDNodeWallet, getIndexedAccountPath, getBytes, keccak256, recoverAddress } from 'ethers';
import { Buffer as BufferPolyfill } from 'buffer';
import * as bip39 from 'bip39';

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
let runtimeSeedLocked = false;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const mnemonicCache = new Map<string, string>();
const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
// Ensure a full Buffer implementation exists before bip39 (Buffer.isBuffer is required).
const ensureGlobalBuffer = () => {
  const globalBuffer = (globalThis as any).Buffer;
  if (!globalBuffer || typeof globalBuffer.isBuffer !== 'function') {
    (globalThis as any).Buffer = BufferPolyfill;
  }
};

const toSeedBytes = (seed: Uint8Array | string): Uint8Array =>
  typeof seed === 'string' ? textEncoder.encode(seed) : seed;
const toSeedText = (seed: Uint8Array | string): string =>
  typeof seed === 'string' ? seed : textDecoder.decode(seed);

const parseSignerIndex = (signerId: string): number | null => {
  const trimmed = signerId.trim();
  if (/^s\d+$/.test(trimmed)) {
    throw new Error(`DEPRECATED_SIGNER_PREFIX: signerId "${signerId}" must be numeric (e.g. "1")`);
  }
  const match = trimmed.match(/^(\d+)$/);
  if (!match) return null;
  const raw = Number(match[1]);
  if (!Number.isFinite(raw)) return null;
  const index = raw > 0 ? raw - 1 : 0;
  return index;
};

const resolveMnemonic = (seed: Uint8Array | string): string => {
  ensureGlobalBuffer();
  const seedText = toSeedText(seed).trim();
  const cached = mnemonicCache.get(seedText);
  if (cached) return cached;

  const normalized = seedText.toLowerCase().replace(/\s+/g, ' ');
  if (bip39.validateMnemonic(normalized)) {
    mnemonicCache.set(seedText, normalized);
    return normalized;
  }

  const entropy = sha256(toSeedBytes(seedText));
  const mnemonic = bip39.entropyToMnemonic(bytesToHex(entropy));
  mnemonicCache.set(seedText, mnemonic);
  return mnemonic;
};

const deriveBip39Key = (seed: Uint8Array | string, index: number): Uint8Array => {
  const mnemonic = resolveMnemonic(seed);
  const path = getIndexedAccountPath(index);
  const wallet = HDNodeWallet.fromPhrase(mnemonic, undefined, path);
  return getBytes(wallet.privateKey);
};

const isHexAddress = (value: string): boolean => /^0x[a-fA-F0-9]{40}$/.test(value.trim());

/**
 * Derive signer private key from BrainVault master seed.
 * Numeric signer IDs (1-based) use BIP-39 + account path derivation.
 */
export async function deriveSignerKey(masterSeed: Uint8Array | string, signerId: string): Promise<Uint8Array> {
  return deriveSignerKeySync(masterSeed, signerId);
}

export function deriveSignerKeySync(masterSeed: Uint8Array | string, signerId: string): Uint8Array {
  const signerIndex = parseSignerIndex(signerId);
  if (signerIndex !== null) {
    return deriveBip39Key(masterSeed, signerIndex);
  }
  const message = textEncoder.encode(signerId);
  return hmac(sha256, toSeedBytes(masterSeed), message);
}

export function prewarmSignerKeyCache(seed: Uint8Array | string, count = 20): string[] {
  const warmed: string[] = [];
  const max = Math.max(1, Math.floor(count));
  for (let i = 1; i <= max; i++) {
    const indexId = String(i);
    const privateKey = deriveSignerKeySync(seed, indexId);
    const address = deriveSignerAddressSync(seed, indexId).toLowerCase();
    registerSignerKey(address, privateKey);
    warmed.push(address);
  }
  return warmed;
}

export function setRuntimeSeed(seed: Uint8Array | string | null): void {
  if (runtimeSeedLocked) {
    console.warn('⚠️ Runtime seed update ignored (crypto lock enabled)');
    return;
  }
  signerKeys.clear();
  signerPublicKeys.clear();
  signerAddresses.clear();
  externalPublicKeys.clear();
  mnemonicCache.clear();
}

export function lockRuntimeSeedUpdates(locked: boolean): void {
  runtimeSeedLocked = locked;
}

const getOrDeriveKey = (envSeed: Uint8Array | string, signerId: string): Uint8Array => {
  const canonicalSignerId = signerId.toLowerCase();
  console.log(`🔍 getOrDeriveKey: signerId=${canonicalSignerId.slice(-4)}`);
  const cached = signerKeys.get(signerId) || signerKeys.get(canonicalSignerId);
  if (cached) {
    console.log(`✅ Found cached key for ${canonicalSignerId.slice(-4)}`);
    return cached;
  }
  console.log(`⚠️ No cached key for ${canonicalSignerId.slice(-4)}`);

  if (envSeed === undefined || envSeed === null) {
    throw new Error(`CRYPTO_DETERMINISM_VIOLATION: getOrDeriveKey called without env.runtimeSeed for signer ${canonicalSignerId}`);
  }

  const signerIndex = parseSignerIndex(canonicalSignerId);
  if (signerIndex !== null) {
    const seedLen = typeof envSeed === 'string' ? envSeed.length : envSeed.length;
    console.log(`✅ Deriving numeric signer key from env seed (${seedLen} bytes)`);
    const derived = deriveSignerKeySync(envSeed, canonicalSignerId);
    const address = deriveSignerAddressSync(envSeed, canonicalSignerId).toLowerCase();
    registerSignerKey(address, derived);
    return derived;
  }

  if (isHexAddress(canonicalSignerId)) {
    throw new Error(
      `MISSING_SIGNER_KEY: no registered private key for signer ${canonicalSignerId}. ` +
      `Register key via registerSignerKey(address, privateKey) before signing.`
    );
  }

  throw new Error(
    `UNSUPPORTED_SIGNER_ID: "${signerId}" is not numeric and implicit derivation is disabled.`
  );
};

/**
 * Get cached signer private key (no derivation, cache-only)
 * Used by components like BrowserVM that don't have env access
 */
export function getCachedSignerPrivateKey(signerId: string): Uint8Array | null {
  return signerKeys.get(signerId.toLowerCase()) || null;
}

/**
 * Get cached signer public key (no derivation, cache-only)
 * Used by components that don't have env access
 */
export function getCachedSignerPublicKey(signerId: string): Uint8Array | null {
  const key = signerId.toLowerCase();
  const external = externalPublicKeys.get(key);
  if (external) return external;
  const cached = signerPublicKeys.get(key);
  if (cached) return cached;
  // Try deriving from cached private key
  const privateKey = signerKeys.get(key);
  if (!privateKey) return null;
  const publicKey = secp256k1.getPublicKey(privateKey);
  signerPublicKeys.set(key, publicKey);
  return publicKey;
}

/**
 * Get cached signer address (no derivation, cache-only)
 * Used by components that don't have env access
 */
export function getCachedSignerAddress(signerId: string): string | null {
  const key = signerId.toLowerCase();
  const cached = signerAddresses.get(key);
  if (cached) return cached;
  // Try deriving from cached private key
  const privateKey = signerKeys.get(key);
  if (!privateKey) return null;
  const address = privateKeyToAddress(privateKey);
  signerAddresses.set(key, address);
  return address;
}

// Export for hanko-signing.ts
export function getSignerPrivateKey(env: any, signerId: string): Uint8Array {
  const key = signerId.toLowerCase();
  const cached = signerKeys.get(key);
  if (cached) return cached;
  if (env?.runtimeSeed === undefined || env?.runtimeSeed === null) {
    throw new Error(`CRYPTO_DETERMINISM_VIOLATION: getSignerPrivateKey called without env.runtimeSeed for signer ${key}`);
  }
  return getOrDeriveKey(env.runtimeSeed, key);
}

export function getSignerPublicKey(env: any, signerId: string): Uint8Array | null {
  const key = signerId.toLowerCase();
  const external = externalPublicKeys.get(key);
  if (external) return external;
  const cached = signerPublicKeys.get(key);
  if (cached) return cached;

  // Try cached private key first
  const cachedPrivateKey = signerKeys.get(key);
  if (cachedPrivateKey) {
    const publicKey = secp256k1.getPublicKey(cachedPrivateKey);
    signerPublicKeys.set(key, publicKey);
    return publicKey;
  }

  // Derive from env if available
  if (env?.runtimeSeed === undefined || env?.runtimeSeed === null) {
    return null;
  }
  const privateKey = getOrDeriveKey(env.runtimeSeed, key);
  const publicKey = secp256k1.getPublicKey(privateKey);
  signerPublicKeys.set(key, publicKey);
  return publicKey;
}

const privateKeyToAddress = (privateKey: Uint8Array): string => {
  const publicKey = secp256k1.getPublicKey(privateKey, false); // uncompressed 65 bytes
  const hash = keccak256(publicKey.slice(1));
  return `0x${hash.slice(-40)}`.toLowerCase();
};

export function deriveSignerAddressSync(seed: Uint8Array | string, signerId: string): string {
  const privateKey = deriveSignerKeySync(seed, signerId);
  return privateKeyToAddress(privateKey);
}

export function getSignerAddress(env: any, signerId: string): string | null {
  const key = signerId.toLowerCase();
  const cached = signerAddresses.get(key);
  if (cached) return cached;

  // Try cached private key first
  const cachedPrivateKey = signerKeys.get(key);
  if (cachedPrivateKey) {
    const address = privateKeyToAddress(cachedPrivateKey);
    signerAddresses.set(key, address);
    return address;
  }

  // Derive from env if available
  if (env?.runtimeSeed === undefined || env?.runtimeSeed === null) {
    return null;
  }
  const privateKey = getOrDeriveKey(env.runtimeSeed, key);
  const address = privateKeyToAddress(privateKey);
  signerAddresses.set(key, address);
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
  setRuntimeSeed(seed);

  for (const signerId of signerIds) {
    const privateKey = await deriveSignerKey(seed, signerId);
    registerSignerKey(signerId, privateKey);
  }

  console.log(`🔑 Registered ${signerIds.length} keys from seed`);
}

/**
 * Register signer keys (called when BrainVault unlocked)
 */
export function registerSignerKey(signerId: string, privateKey: Uint8Array): void {
  const key = signerId.toLowerCase();
  signerKeys.set(key, privateKey);
  signerPublicKeys.set(key, secp256k1.getPublicKey(privateKey));
  signerAddresses.set(key, privateKeyToAddress(privateKey));
}

export function registerSignerPublicKey(signerId: string, publicKey: Uint8Array | string): void {
  const key = signerId.toLowerCase();
  if (signerKeys.has(key)) return; // Already has private key
  const bytes =
    typeof publicKey === 'string'
      ? Uint8Array.from(Buffer.from(publicKey.replace(/^0x/, ''), 'hex'))
      : publicKey;
  externalPublicKeys.set(key, bytes);
  signerPublicKeys.delete(key);
}

/**
 * Register test keys for scenarios.
 * Deprecated: use real runtime seeds and numeric signer IDs instead.
 */
export async function registerTestKeys(_signerIds: string[]): Promise<void> {
  throw new Error('registerTestKeys is disabled. Use runtimeSeed + numeric signerIds (1,2,3...)');
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
  if (env?.runtimeSeed === undefined || env?.runtimeSeed === null) {
    throw new Error(`CRYPTO_DETERMINISM_VIOLATION: signAccountFrame called without env.runtimeSeed for signer ${signerId}`);
  }

  console.log(`🔑 signAccountFrame CALLED: signerId=${signerId.slice(-4)}, frameHash=${frameHash.slice(0, 10)}, source=env`);
  console.log(`🔑 Available signerKeys:`, Array.from(signerKeys.keys()).map(k => k.slice(-4)));
  console.log(`🔑 Available signerPublicKeys:`, Array.from(signerPublicKeys.keys()).map(k => k.slice(-4)));

  // CRITICAL: Sign raw hash - NO double hashing
  // On-chain _recoverSigner expects ecrecover(hash, sig) where hash is the raw 32-byte message
  // frameHash is already keccak256 output, sign it directly
  const signature = signDigest(env.runtimeSeed, signerId, frameHash);
  console.log(`✍️ Signed frame ${frameHash.slice(0, 10)} by ${signerId.slice(-4)}: ${signature.slice(0, 20)}...`);
  return signature;
}

export function signDigest(seed: Uint8Array | string, signerId: string, digestHex: string): string {
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
  const key = signerId.toLowerCase();
  const quiet = env?.quietRuntimeLogs === true;
  const publicKey = getSignerPublicKey(env, key);
  if (!publicKey) {
    // Deterministic fallback for replay/recovery: recover address from signature.
    // This removes runtime dependence on gossip key registration for account frame verification.
    if (/^0x[a-f0-9]{40}$/i.test(key)) {
      try {
        const recovered = recoverAddress(frameHash, signature).toLowerCase();
        if (recovered === key) {
          return true;
        }
      } catch (error) {
        if (!quiet) {
          console.warn(`⚠️ recoverAddress failed for signer ${key.slice(-4)}:`, error);
        }
      }
    }

    console.warn(`⚠️ Cannot verify - no public key for signerId=${key.slice(-4)}`);
    if (!quiet) {
      console.warn(`⚠️ Available keys:`, Array.from(signerPublicKeys.keys()).map(k => k.slice(-4)));
      console.warn(`⚠️ Available external keys:`, Array.from(externalPublicKeys.keys()).map(k => k.slice(-4)));
    }
    return false;
  }

  try {
    // Extract compact signature (64 bytes) from hex
    const sigHex = signature.replace('0x', '');
    const sigBytes = Buffer.from(sigHex.slice(0, 128), 'hex'); // First 64 bytes (r + s)

    // CRITICAL: Verify against raw hash - NO double hashing
    // Must match signAccountFrame and on-chain _recoverSigner behavior
    const messageBytes = Buffer.from(frameHash.replace('0x', ''), 'hex');

    // Verify signature using @noble/secp256k1
    const isValid = secp256k1.verify(sigBytes, messageBytes, publicKey);
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
  return { valid: allValid, validSigners };
}
