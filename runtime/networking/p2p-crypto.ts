/**
 * P2P Encryption Layer (2019-style NaCl box approach)
 *
 * Uses X25519 + ChaCha20-Poly1305 for message encryption.
 * Derives encryption keypair directly from seed (same as 2019 version).
 *
 * Wire format: ephemeralPub (32) + nonce (12) + ciphertext (data + 16 tag)
 */

// @ts-ignore - Bun requires .js extension for noble imports
import { x25519 } from '@noble/curves/ed25519.js';
// @ts-ignore - Bun requires .js extension for noble imports
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
// @ts-ignore - Bun requires .js extension for noble imports
import { sha256 } from '@noble/hashes/sha2.js';

export type P2PKeyPair = {
  publicKey: Uint8Array;  // 32 bytes
  privateKey: Uint8Array; // 32 bytes
};

/**
 * Derive X25519 keypair from seed (like 2019: nacl.box.keyPair.fromSecretKey)
 * The seed is hashed to get a valid 32-byte X25519 private key.
 */
export function deriveEncryptionKeyPair(seed: Uint8Array | string): P2PKeyPair {
  // Normalize seed to bytes
  const seedBytes = typeof seed === 'string'
    ? new TextEncoder().encode(seed)
    : seed;

  // Hash seed to get 32-byte private key (ensures valid X25519 scalar)
  // Using domain separation to avoid key reuse with other derivations
  const domain = new TextEncoder().encode('xln-p2p-encryption-v1');
  const combined = new Uint8Array(domain.length + seedBytes.length);
  combined.set(domain, 0);
  combined.set(seedBytes, domain.length);

  const privateKey = sha256(combined);

  // Clamp private key for X25519 (standard practice)
  privateKey[0] &= 248;
  privateKey[31] &= 127;
  privateKey[31] |= 64;

  // Derive public key
  const publicKey = x25519.getPublicKey(privateKey);

  return { publicKey, privateKey };
}

/**
 * Encrypt message for recipient (ephemeral ECDH + ChaCha20-Poly1305)
 *
 * Wire format: ephemeralPub (32) + nonce (12) + ciphertext (data.length + 16)
 */
export function encryptMessage(
  plaintext: Uint8Array,
  recipientPubKey: Uint8Array
): Uint8Array {
  // Generate ephemeral keypair (forward secrecy)
  const ephemeralPriv = x25519.utils.randomPrivateKey();
  const ephemeralPub = x25519.getPublicKey(ephemeralPriv);

  // ECDH: derive shared secret
  const sharedSecret = x25519.getSharedSecret(ephemeralPriv, recipientPubKey);

  // Use shared secret as ChaCha20-Poly1305 key (first 32 bytes)
  const key = sharedSecret.slice(0, 32);

  // Random nonce (12 bytes for ChaCha20-Poly1305)
  const nonce = crypto.getRandomValues(new Uint8Array(12));

  // Encrypt
  const cipher = chacha20poly1305(key, nonce);
  const ciphertext = cipher.encrypt(plaintext);

  // Pack: ephemeralPub (32) + nonce (12) + ciphertext
  const packed = new Uint8Array(32 + 12 + ciphertext.length);
  packed.set(ephemeralPub, 0);
  packed.set(nonce, 32);
  packed.set(ciphertext, 44);

  return packed;
}

/**
 * Decrypt message with our private key
 */
export function decryptMessage(
  packed: Uint8Array,
  privateKey: Uint8Array
): Uint8Array {
  if (packed.length < 44 + 16) {
    throw new Error('P2P_DECRYPT_ERROR: Message too short');
  }

  // Unpack
  const ephemeralPub = packed.slice(0, 32);
  const nonce = packed.slice(32, 44);
  const ciphertext = packed.slice(44);

  // ECDH: derive shared secret
  const sharedSecret = x25519.getSharedSecret(privateKey, ephemeralPub);

  // Use shared secret as key
  const key = sharedSecret.slice(0, 32);

  // Decrypt
  const cipher = chacha20poly1305(key, nonce);
  const plaintext = cipher.decrypt(ciphertext);

  return plaintext;
}

/**
 * Encrypt JSON object for recipient
 */
export function encryptJSON(
  data: unknown,
  recipientPubKey: Uint8Array
): string {
  const json = JSON.stringify(data);
  const plaintext = new TextEncoder().encode(json);
  const encrypted = encryptMessage(plaintext, recipientPubKey);
  return bytesToBase64(encrypted);
}

/**
 * Decrypt JSON object with our private key
 */
export function decryptJSON<T = unknown>(
  encryptedBase64: string,
  privateKey: Uint8Array
): T {
  const encrypted = base64ToBytes(encryptedBase64);
  const plaintext = decryptMessage(encrypted, privateKey);
  const json = new TextDecoder().decode(plaintext);
  return JSON.parse(json) as T;
}

/**
 * Convert public key to hex string (for profile sharing)
 */
export function pubKeyToHex(pubKey: Uint8Array): string {
  return '0x' + Array.from(pubKey).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Convert hex string to public key bytes
 */
export function hexToPubKey(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length !== 64) {
    throw new Error(`P2P_INVALID_PUBKEY: Expected 64 hex chars, got ${clean.length}`);
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// Utility: Uint8Array → Base64
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Utility: Base64 → Uint8Array
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Export utilities for external use
export { bytesToBase64, base64ToBytes };
