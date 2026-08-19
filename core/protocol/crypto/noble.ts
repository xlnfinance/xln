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

import type { CryptoProvider, CryptoKeyPair } from './provider';
import { x25519PublicKey, x25519RandomSecretKey, x25519SharedSecret } from './fast-x25519';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { decodeBase64Bytes, encodeBase64Bytes } from '../serialization/base64';

export type NobleCryptoProviderOptions = {
  deterministicSeed?: string;
};

export class NobleCryptoProvider implements CryptoProvider {
  private deterministicCounter = 0;

  constructor(private readonly options: NobleCryptoProviderOptions = {}) {}

  async generateKeyPair(): Promise<CryptoKeyPair> {
    // Generate X25519 key pair (32 bytes each)
    const keyPair = this.options.deterministicSeed
      ? await this.generateDeterministicKeyPair('keygen')
      : (() => { const secretKey = x25519RandomSecretKey(); return { secretKey, publicKey: x25519PublicKey(secretKey) }; })();

    return {
      publicKey: encodeBase64Bytes(keyPair.publicKey),
      privateKey: encodeBase64Bytes(keyPair.secretKey)
    };
  }

  async encrypt(data: string, recipientPubKey: string | undefined): Promise<string> {
    if (!recipientPubKey) {
      throw new Error('Recipient public key required for encryption');
    }

    // Generate an ephemeral key pair. Production HTLC admission leaves the
    // seed unset; consensus replay only validates the already-sealed payload.
    // Deterministic providers are reserved for explicit deterministic tests.
    const ephemeral = this.options.deterministicSeed
      ? await this.generateDeterministicKeyPair('encrypt-ephemeral')
      : (() => { const secretKey = x25519RandomSecretKey(); return { secretKey, publicKey: x25519PublicKey(secretKey) }; })();
    const ephemeralPriv = ephemeral.secretKey;
    const ephemeralPub = ephemeral.publicKey;

    // ECDH: derive shared secret
    const recipientPubBytes = this.parseKeyBytes(recipientPubKey, 'recipient public key');
    if (recipientPubBytes.length !== 32) {
      throw new Error(`Invalid recipient public key length: expected 32, got ${recipientPubBytes.length}`);
    }
    let sharedSecret: Uint8Array;
    try {
      sharedSecret = x25519SharedSecret(ephemeralPriv, recipientPubBytes);
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

    const nonce = this.options.deterministicSeed
      ? await this.deterministicBytes(12, 'chacha20poly1305-nonce')
      : crypto.getRandomValues(new Uint8Array(12));

    // Encrypt data
    const dataBytes = new TextEncoder().encode(data);
    const cipher = chacha20poly1305(key, nonce);
    const ciphertext = cipher.encrypt(dataBytes);

    // Pack: ephemeralPub (32) + nonce (12) + ciphertext (data.length + 16 for auth tag)
    const packed = new Uint8Array(32 + 12 + ciphertext.length);
    packed.set(ephemeralPub, 0);
    packed.set(nonce, 32);
    packed.set(ciphertext, 44);

    return encodeBase64Bytes(packed);
  }

  async decrypt(encryptedData: string, privateKey: string): Promise<string> {
    // Unpack: ephemeralPub (32) + nonce (12) + ciphertext (rest)
    const packed = decodeBase64Bytes(encryptedData);
    const ephemeralPub = packed.slice(0, 32);
    const nonce = packed.slice(32, 44);
    const ciphertext = packed.slice(44);

    // ECDH: derive shared secret
    const privKeyBytes = this.parseKeyBytes(privateKey, 'private key');
    if (privKeyBytes.length !== 32) {
      throw new Error(`Invalid private key length: expected 32, got ${privKeyBytes.length}`);
    }
    const sharedSecret = x25519SharedSecret(privKeyBytes, ephemeralPub);

    // Derive ChaCha20-Poly1305 key
    const key = sharedSecret.slice(0, 32);

    // Decrypt data
    const cipher = chacha20poly1305(key, nonce);
    const plaintext = cipher.decrypt(ciphertext);

    return new TextDecoder().decode(plaintext);
  }

  private async generateDeterministicKeyPair(label: string): Promise<{ publicKey: Uint8Array; secretKey: Uint8Array }> {
    const secretKey = await this.deterministicBytes(32, label);
    return {
      publicKey: x25519PublicKey(secretKey),
      secretKey,
    };
  }

  private async deterministicBytes(length: number, label: string): Promise<Uint8Array> {
    const seed = this.options.deterministicSeed;
    if (!seed) throw new Error('NOBLE_DETERMINISTIC_SEED_MISSING');
    const out = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const material = `${seed}:${label}:${this.deterministicCounter++}`;
      const digest = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material)),
      );
      const take = Math.min(digest.length, length - offset);
      out.set(digest.slice(0, take), offset);
      offset += take;
    }
    return out;
  }

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

    throw new Error(`Unsupported ${label} format`);
  }
}
