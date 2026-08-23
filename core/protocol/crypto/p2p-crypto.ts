/**
 * P2P Encryption Layer (2019-style NaCl box approach)
 *
 * Uses X25519 + AES-256-GCM for message encryption.
 * Derives encryption keypair directly from seed (same as 2019 version).
 *
 * Wire format: ephemeralPub (32) + nonce (12) + ciphertext (data + 16 tag)
 */

import { x25519PublicKey, x25519RandomSecretKey, x25519SharedSecret } from './fast-x25519';
export { x25519SharedSecret } from './fast-x25519';
import { aead } from './fast-aead';
import { sha256 } from '@noble/hashes/sha2.js';
import { packTransportValue, unpackTransportValue } from '../../storage/codec/binary-codec';

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

  const hashResult = sha256(combined);
  // SHA256 always returns 32-byte Uint8Array - create mutable copy for clamping
  const privateKey = new Uint8Array(hashResult);

  // Clamp private key for X25519 (standard practice)
  // SHA256 guarantees 32 bytes, so indices 0 and 31 are always valid
  const byte0 = privateKey[0];
  const byte31 = privateKey[31];
  if (byte0 === undefined || byte31 === undefined) {
    throw new Error('P2P_DERIVE_ERROR: SHA256 returned invalid length');
  }
  privateKey[0] = byte0 & 248;
  privateKey[31] = (byte31 & 127) | 64;

  // Derive public key
  const publicKey = x25519PublicKey(privateKey);

  return { publicKey, privateKey };
}

/**
 * Encrypt message for recipient (ephemeral ECDH + AES-256-GCM)
 *
 * Wire format: ephemeralPub (32) + nonce (12) + ciphertext (data.length + 16)
 */
function encryptMessage(
  plaintext: Uint8Array,
  recipientPubKey: Uint8Array
): Uint8Array {
  // Generate ephemeral keypair (forward secrecy)
  const ephemeralPriv = x25519RandomSecretKey();
  const ephemeralPub = x25519PublicKey(ephemeralPriv);

  // ECDH: derive shared secret
  const sharedSecret = x25519SharedSecret(ephemeralPriv, recipientPubKey);

  // Use shared secret as AES-256-GCM key (first 32 bytes)
  const key = sharedSecret.slice(0, 32);

  // Random nonce (12 bytes for AES-256-GCM)
  const nonce = crypto.getRandomValues(new Uint8Array(12));

  // Encrypt
  const ciphertext = aead(key, nonce).encrypt(plaintext);

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
function decryptMessage(
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
  const sharedSecret = x25519SharedSecret(privateKey, ephemeralPub);

  // Use shared secret as key
  const key = sharedSecret.slice(0, 32);

  // Decrypt
  const plaintext = aead(key, nonce).decrypt(ciphertext);

  return plaintext;
}

/**
 * Seal a transport value for a recipient (ephemeral ECDH sealed box).
 * Plaintext is MessagePack (exact bigint/bytes round trip), never JSON text;
 * the ciphertext travels as raw bytes inside the MessagePack ws envelope.
 */
export function encryptPayload(data: unknown, recipientPubKey: Uint8Array): Uint8Array {
  return encryptMessage(packTransportValue(data), recipientPubKey);
}

export function decryptPayload(encrypted: Uint8Array, privateKey: Uint8Array): unknown {
  return unpackTransportValue(decryptMessage(encrypted, privateKey));
}

/** Fresh ephemeral X25519 keypair for one transport session. */
export function generateEphemeralKeyPair(): P2PKeyPair {
  const privateKey = x25519RandomSecretKey();
  return { privateKey, publicKey: x25519PublicKey(privateKey) };
}

const sessionNonce = (seq: number): Uint8Array => {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('P2P_SESSION_SEQ_INVALID');
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setUint32(4, Math.floor(seq / 0x1_0000_0000));
  new DataView(nonce.buffer).setUint32(8, seq >>> 0);
  return nonce;
};

/**
 * Seal a transport value under a per-session key with a counter nonce. The
 * caller owns the counter (one direction, strictly increasing, never reused
 * per key). Wire format: ciphertext (data + 16 tag) as raw bytes.
 */
export function encryptSessionPayload(data: unknown, key: Uint8Array, seq: number): Uint8Array {
  return aead(key, sessionNonce(seq)).encrypt(packTransportValue(data));
}

export function decryptSessionPayload(ciphertext: Uint8Array, key: Uint8Array, seq: number): unknown {
  if (ciphertext.length < 16) throw new Error('P2P_DECRYPT_ERROR: Message too short');
  return unpackTransportValue(aead(key, sessionNonce(seq)).decrypt(ciphertext));
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
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error(`P2P_INVALID_PUBKEY: Expected 64 hex chars, got ${clean.length}`);
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
