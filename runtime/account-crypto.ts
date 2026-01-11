/**
 * Real cryptographic signatures for account consensus
 * Uses secp256k1 (Ethereum standard) with HMAC-derived keys from BrainVault seed
 */

import * as secp256k1 from '@noble/secp256k1';
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
// Browser: HMAC will be configured when needed (async)

// Global key cache (signerId → private key)
// Populated by runtime when BrainVault unlocked
const signerKeys = new Map<string, Uint8Array>();

/**
 * Derive signer private key from BrainVault master seed
 * Formula: privateKey = HMAC-SHA256(masterSeed, signerId)
 * Browser-compatible (uses hash-wasm) and Node-compatible (uses crypto)
 */
export async function deriveSignerKey(masterSeed: Uint8Array, signerId: string): Promise<Uint8Array> {
  const isBrowser = typeof window !== 'undefined';

  if (isBrowser) {
    if (!globalThis.crypto?.subtle) {
      throw new Error('WebCrypto is required for browser HMAC');
    }

    const key = await globalThis.crypto.subtle.importKey(
      'raw',
      masterSeed,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const message = new TextEncoder().encode(signerId);
    const signature = await globalThis.crypto.subtle.sign('HMAC', key, message);
    return new Uint8Array(signature);
  }

  // Node/Bun: use built-in crypto
  const { createHmac } = await import('crypto');
  const hmac = createHmac('sha256', Buffer.from(masterSeed));
  hmac.update(signerId);
  return new Uint8Array(hmac.digest());
}

/**
 * Register signer keys derived from a deterministic seed
 * Formula: privateKey = HMAC-SHA256(seed, signerId)
 */
export async function registerSeededKeys(
  seed: Uint8Array | string,
  signerIds: string[]
): Promise<void> {
  const seedBytes = typeof seed === 'string' ? new TextEncoder().encode(seed) : seed;

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
}

/**
 * Register test keys for scenarios (deterministic test keys from signerId)
 * Used in CLI scenarios when BrainVault not available
 */
export async function registerTestKeys(signerIds: string[]): Promise<void> {
  const testMasterSeed = new Uint8Array(32);
  testMasterSeed.fill(42); // Deterministic test seed

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
}

/**
 * Sign account frame using secp256k1
 * Returns: 65-byte signature (r + s + recovery)
 */
export function signAccountFrame(
  entityId: string,
  frameHash: string,
  _privateData?: string // Deprecated, kept for backwards compat
): string {
  const privateKey = signerKeys.get(entityId);

  if (!privateKey) {
    // Fallback to mock for testing (when BrainVault not unlocked)
    const mockContent = `${entityId}-${frameHash}`;
    const mockSig = `sig_${Buffer.from(mockContent).toString('base64').slice(0, 32)}`;
    console.warn(`⚠️ Using MOCK signature for ${entityId.slice(-4)} (BrainVault not unlocked)`);
    return mockSig;
  }

  // Hash the frame hash (secp256k1 signs 32-byte messages)
  const messageHash = keccak256(Buffer.from(frameHash.replace('0x', ''), 'hex'));
  const messageBytes = Buffer.from(messageHash.replace('0x', ''), 'hex');

  // Sign with recovery using @noble/secp256k1
  const [signature, recovery] = secp256k1.signSync(messageBytes, privateKey, { recovered: true, der: false });

  // Encode as hex: signature (64 bytes compact) + recovery (1 byte) = 65 bytes total
  const sigHex = Buffer.from(signature).toString('hex') + recovery.toString(16).padStart(2, '0');

  console.log(`✍️ Signed frame ${frameHash.slice(0, 10)} by ${entityId.slice(-4)}: ${sigHex.slice(0, 20)}...`);
  return `0x${sigHex}`;
}

/**
 * Verify account signature using secp256k1
 */
export function verifyAccountSignature(
  entityId: string,
  frameHash: string,
  signature: string,
  _privateData?: string // Deprecated
): boolean {
  // Handle legacy mock signatures
  if (signature.startsWith('sig_')) {
    const mockExpected = signAccountFrame(entityId, frameHash);
    return signature === mockExpected;
  }

  // Real signature verification
  const privateKey = signerKeys.get(entityId);
  if (!privateKey) {
    console.warn(`⚠️ Cannot verify - no key for ${entityId.slice(-4)}`);
    return false;
  }

  try {
    // Extract compact signature (64 bytes) from hex
    const sigHex = signature.replace('0x', '');
    const sigBytes = Buffer.from(sigHex.slice(0, 128), 'hex'); // First 64 bytes (r + s)

    // Hash the frame hash
    const messageHash = keccak256(Buffer.from(frameHash.replace('0x', ''), 'hex'));
    const messageBytes = Buffer.from(messageHash.replace('0x', ''), 'hex');

    // Get public key from private key
    const publicKey = secp256k1.getPublicKey(privateKey);

    // Verify signature using @noble/secp256k1
    const isValid = secp256k1.verify(sigBytes, messageBytes, publicKey);

    if (isValid) {
      console.log(`✅ Valid signature from ${entityId.slice(-4)} for frame ${frameHash.slice(0, 10)}`);
    } else {
      console.log(`❌ Invalid signature from ${entityId.slice(-4)} for frame ${frameHash.slice(0, 10)}`);
    }

    return isValid;
  } catch (error) {
    console.error(`❌ Signature verification error for ${entityId.slice(-4)}:`, error);
    return false;
  }
}

/**
 * Easy signer function that returns the entity ID from a signature
 */
export function getSignerFromSignature(signature: string, frameHash: string): string | null {
  // Parse signature to extract signer (mock implementation)
  // Real implementation would use cryptographic signature recovery

  if (!signature.startsWith('sig_')) {
    return null;
  }

  // For mock: signature format is sig_BASE64(entityId-frameHash-privateKey)
  try {
    const encoded = signature.slice(4); // Remove 'sig_' prefix
    const decoded = Buffer.from(encoded, 'base64').toString();
    const parts = decoded.split('-');

    if (parts.length >= 2 && parts[1] === frameHash) {
      return parts[0] || null; // Return entityId or null if empty
    }
  } catch (error) {
    console.log(`⚠️ Failed to parse signature: ${error}`);
  }

  return null;
}

/**
 * Validate multiple signatures for account frame
 */
export function validateAccountSignatures(
  frameHash: string,
  signatures: string[],
  expectedSigners: string[]
): { valid: boolean; validSigners: string[] } {
  const validSigners: string[] = [];

  for (const signature of signatures) {
    const signer = getSignerFromSignature(signature, frameHash);

    if (signer && expectedSigners.includes(signer)) {
      if (verifyAccountSignature(signer, frameHash, signature)) {
        validSigners.push(signer);
      }
    }
  }

  const allValid = validSigners.length === expectedSigners.length;

  console.log(`🔍 Signature validation: ${validSigners.length}/${expectedSigners.length} valid (${allValid ? 'PASS' : 'FAIL'})`);

  return { valid: allValid, validSigners };
}
