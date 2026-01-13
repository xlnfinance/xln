/**
 * Real cryptographic signatures for account consensus
 * Uses secp256k1 (Ethereum standard) with HMAC-derived keys from BrainVault seed
 */

import * as secp256k1 from '@noble/secp256k1';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak256 } from 'ethers';

// Configure @noble/secp256k1 HMAC (required for signing)
// Node/Bun environment: use crypto module synchronously
const isBrowser = typeof window !== 'undefined';
if (!isBrowser && typeof require !== 'undefined') {
  try {
    const crypto = require('crypto');
    secp256k1.utils.hmacSha256Sync = (key: Uint8Array, ...messages: Uint8Array[]) => {
      const hmac = crypto.createHmac('sha256', Buffer.from(key));
      for (const msg of messages) hmac.update(Buffer.from(msg));
      return new Uint8Array(hmac.digest());
    };
  } catch (e) {
    console.warn('Failed to configure secp256k1 HMAC:', e);
  }
}
// Browser: deriveSignerKeySync uses noble hashes (no async required)

// Global key cache (signerId → private/public key)
// Populated by runtime when BrainVault seed is provided
const signerKeys = new Map<string, Uint8Array>();
const signerPublicKeys = new Map<string, Uint8Array>();
const signerAddresses = new Map<string, string>();
let runtimeSeedBytes: Uint8Array | null = null;
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
  runtimeSeedBytes = seed ? toSeedBytes(seed) : null;
  signerKeys.clear();
  signerPublicKeys.clear();
  signerAddresses.clear();
}

const getOrDeriveKey = (signerId: string): Uint8Array | null => {
  const cached = signerKeys.get(signerId);
  if (cached) return cached;
  if (!runtimeSeedBytes) return null;
  const derived = deriveSignerKeySync(runtimeSeedBytes, signerId);
  registerSignerKey(signerId, derived);
  return derived;
};

export function getSignerPublicKey(signerId: string): Uint8Array | null {
  const cached = signerPublicKeys.get(signerId);
  if (cached) return cached;
  const privateKey = getOrDeriveKey(signerId);
  if (!privateKey) return null;
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

export function getSignerAddress(signerId: string): string | null {
  const cached = signerAddresses.get(signerId);
  if (cached) return cached;
  const privateKey = getOrDeriveKey(signerId);
  if (!privateKey) return null;
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
}

/**
 * Sign account frame using secp256k1
 * Returns: 65-byte signature (r + s + recovery)
 */
export function signAccountFrame(
  signerId: string,
  frameHash: string,
  _privateData?: string // Deprecated, kept for backwards compat
): string {
  const messageHash = keccak256(Buffer.from(frameHash.replace('0x', ''), 'hex'));
  const signature = signDigest(signerId, messageHash);
  console.log(`✍️ Signed frame ${frameHash.slice(0, 10)} by ${signerId.slice(-4)}: ${signature.slice(0, 20)}...`);
  return signature;
}

export function signDigest(signerId: string, digestHex: string): string {
  const privateKey = getOrDeriveKey(signerId);
  if (!privateKey) {
    throw new Error(`SIGNER_KEY_MISSING: No key or runtime seed for signer ${signerId}`);
  }

  const messageBytes = Buffer.from(digestHex.replace('0x', ''), 'hex');
  const [signature, recovery] = secp256k1.signSync(messageBytes, privateKey, { recovered: true, der: false });
  const sigHex = Buffer.from(signature).toString('hex') + recovery.toString(16).padStart(2, '0');
  return `0x${sigHex}`;
}

/**
 * Verify account signature using secp256k1
 */
export function verifyAccountSignature(
  signerId: string,
  frameHash: string,
  signature: string,
  _privateData?: string // Deprecated
): boolean {
  // Real signature verification
  const publicKey = getSignerPublicKey(signerId);
  if (!publicKey) {
    console.warn(`⚠️ Cannot verify - no key for ${signerId.slice(-4)}`);
    return false;
  }

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
 * Easy signer function that returns the entity ID from a signature
 */
/**
 * Validate multiple signatures for account frame
 */
export function validateAccountSignatures(
  frameHash: string,
  signatures: string[],
  expectedSigners: string[]
): { valid: boolean; validSigners: string[] } {
  const validSigners: string[] = [];
  const remaining = new Set(expectedSigners);

  for (const signature of signatures) {
    for (const signer of Array.from(remaining)) {
      if (verifyAccountSignature(signer, frameHash, signature)) {
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
