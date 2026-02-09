/**
 * Noble Crypto Provider (X25519 + ChaCha20-Poly1305)
 *
 * State-of-the-art onion routing encryption (Lightning/Tor pattern)
 * - X25519: Elliptic curve key agreement (32-byte keys)
 * - ChaCha20-Poly1305: Authenticated stream cipher (unlimited size, +16 byte overhead)
 * - Ephemeral keys per encryption (unlinkable)
 *
 * Future: Upgrade to X25519+Kyber hybrid (post-quantum)
 */

import type { CryptoProvider, CryptoKeyPair } from './crypto-provider';
import { x25519 } from '@noble/curves/ed25519.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';

export class NobleCryptoProvider implements CryptoProvider {
  async generateKeyPair(): Promise<CryptoKeyPair> {
    // Generate X25519 key pair (32 bytes each)
    const keyPair = x25519.keygen();

    return {
      publicKey: this.bytesToBase64(keyPair.publicKey),
      privateKey: this.bytesToBase64(keyPair.secretKey)
    };
  }

  async encrypt(data: string, recipientPubKey: string | undefined): Promise<string> {
    if (!recipientPubKey) {
      throw new Error('Recipient public key required for encryption');
    }

    // Generate ephemeral key pair (unlinkable to sender)
    const ephemeral = x25519.keygen();
    const ephemeralPriv = ephemeral.secretKey;
    const ephemeralPub = ephemeral.publicKey;

    // ECDH: derive shared secret
    const recipientPubBytes = this.parseKeyBytes(recipientPubKey, 'recipient public key');
    if (recipientPubBytes.length !== 32) {
      throw new Error(`Invalid recipient public key length: expected 32, got ${recipientPubBytes.length}`);
    }
    let sharedSecret: Uint8Array;
    try {
      sharedSecret = x25519.getSharedSecret(ephemeralPriv, recipientPubBytes);
    } catch (error) {
      const preview = recipientPubKey.slice(0, 24);
      console.error('[NOBLE_ENCRYPT_FAIL]', {
        error: error instanceof Error ? error.message : String(error),
        rawKeyLength: recipientPubKey.length,
        parsedKeyLength: recipientPubBytes.length,
        preview,
      });
      throw error;
    }

    // Derive ChaCha20-Poly1305 key from shared secret (use first 32 bytes)
    const key = sharedSecret.slice(0, 32);

    // Generate random nonce (12 bytes for ChaCha20-Poly1305)
    const nonce = crypto.getRandomValues(new Uint8Array(12));

    // Encrypt data
    const dataBytes = new TextEncoder().encode(data);
    const cipher = chacha20poly1305(key, nonce);
    const ciphertext = cipher.encrypt(dataBytes);

    // Pack: ephemeralPub (32) + nonce (12) + ciphertext (data.length + 16 for auth tag)
    const packed = new Uint8Array(32 + 12 + ciphertext.length);
    packed.set(ephemeralPub, 0);
    packed.set(nonce, 32);
    packed.set(ciphertext, 44);

    return this.bytesToBase64(packed);
  }

  async decrypt(encryptedData: string, privateKey: string): Promise<string> {
    // Unpack: ephemeralPub (32) + nonce (12) + ciphertext (rest)
    const packed = this.base64ToBytes(encryptedData);
    const ephemeralPub = packed.slice(0, 32);
    const nonce = packed.slice(32, 44);
    const ciphertext = packed.slice(44);

    // ECDH: derive shared secret
    const privKeyBytes = this.parseKeyBytes(privateKey, 'private key');
    if (privKeyBytes.length !== 32) {
      throw new Error(`Invalid private key length: expected 32, got ${privKeyBytes.length}`);
    }
    const sharedSecret = x25519.getSharedSecret(privKeyBytes, ephemeralPub);

    // Derive ChaCha20-Poly1305 key
    const key = sharedSecret.slice(0, 32);

    // Decrypt data
    const cipher = chacha20poly1305(key, nonce);
    const plaintext = cipher.decrypt(ciphertext);

    return new TextDecoder().decode(plaintext);
  }

  // Utility: Uint8Array → Base64
  private bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]!);
    }
    return btoa(binary);
  }

  // Utility: Base64 → Uint8Array
  private base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  // Accept both modern hex (0x + 64 chars) and legacy/base64 key encodings.
  private parseKeyBytes(raw: string, label: string): Uint8Array {
    const key = raw.trim();
    if (!key) throw new Error(`Missing ${label}`);

    const hex = key.startsWith('0x') ? key.slice(2) : key;
    if (/^[0-9a-fA-F]{64}$/.test(hex)) {
      const out = new Uint8Array(32);
      for (let i = 0; i < 32; i++) {
        const v = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        if (!Number.isFinite(v)) throw new Error(`Invalid hex ${label}`);
        out[i] = v;
      }
      return out;
    }

    if (key.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(key)) {
      throw new Error(`Unsupported ${label} format`);
    }
    let bytes: Uint8Array;
    try {
      bytes = this.base64ToBytes(key);
    } catch {
      throw new Error(`Unsupported ${label} format`);
    }
    if (bytes.length !== 32) {
      throw new Error(`Invalid ${label} length: expected 32, got ${bytes.length}`);
    }
    return bytes;
  }
}
