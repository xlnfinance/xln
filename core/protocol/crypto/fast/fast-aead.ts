/**
 * AEAD backend selection (same scheme as fast-x25519 / fast-keccak).
 *
 * Every transport envelope and every HTLC onion layer is one AEAD call. The
 * pure-JS ChaCha20-Poly1305 costs ~11 µs per 2 KB; Bun/Node ship no native
 * ChaCha, but node:crypto's AES-256-GCM (hardware AES) costs ~1.2 µs for the
 * same 2 KB. Both ends of every envelope run this code, so the cipher is an
 * internal choice: AES-256-GCM everywhere, noble's GCM in browsers. Key (32),
 * nonce (12), AAD and the 16-byte trailing tag keep the exact wire layout.
 */
import { gcm } from '@noble/ciphers/aes.js';
import { isBrowserRuntime } from '../../../support/platform-crypto';

type NodeCrypto = typeof import('node:crypto');

export type Aead = Readonly<{
  encrypt(plaintext: Uint8Array): Uint8Array;
  decrypt(ciphertext: Uint8Array): Uint8Array;
}>;

const TAG_BYTES = 16;
const ALGORITHM = 'aes-256-gcm';

const nativeAead = (crypto: NodeCrypto, key: Uint8Array, nonce: Uint8Array, aad?: Uint8Array): Aead => ({
  encrypt: (plaintext) => {
    const cipher = crypto.createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
    if (aad) cipher.setAAD(aad, { plaintextLength: plaintext.length });
    const body = cipher.update(plaintext);
    const tail = cipher.final();
    const tag = cipher.getAuthTag();
    const out = new Uint8Array(body.length + tail.length + tag.length);
    out.set(body, 0);
    out.set(tail, body.length);
    out.set(tag, body.length + tail.length);
    return out;
  },
  decrypt: (ciphertext) => {
    if (ciphertext.length < TAG_BYTES) throw new Error('AEAD_CIPHERTEXT_TOO_SHORT');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
    const bodyLength = ciphertext.length - TAG_BYTES;
    if (aad) decipher.setAAD(aad, { plaintextLength: bodyLength });
    decipher.setAuthTag(ciphertext.subarray(bodyLength));
    const body = decipher.update(ciphertext.subarray(0, bodyLength));
    const tail = decipher.final();
    const out = new Uint8Array(body.length + tail.length);
    out.set(body, 0);
    out.set(tail, body.length);
    return out;
  },
});

const probeKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const probeNonce = Uint8Array.from({ length: 12 }, (_, index) => 255 - index);
const probeAad = Uint8Array.from({ length: 7 }, (_, index) => index * 3);
const probePlain = Uint8Array.from({ length: 61 }, (_, index) => (index * 7) & 0xff);

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

const nativePassesProbe = (crypto: NodeCrypto): boolean => {
  try {
    const reference = gcm(probeKey, probeNonce, probeAad).encrypt(probePlain);
    const native = nativeAead(crypto, probeKey, probeNonce, probeAad);
    if (!bytesEqual(native.encrypt(probePlain), reference)) return false;
    if (!bytesEqual(native.decrypt(reference), probePlain)) return false;
    const tampered = reference.slice();
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    try {
      native.decrypt(tampered);
      return false;
    } catch {
      return true;
    }
  } catch {
    return false;
  }
};

let nodeCrypto: NodeCrypto | null = null;
try {
  if (!isBrowserRuntime() && typeof require !== 'undefined') {
    const loaded = require('crypto') as NodeCrypto;
    if (typeof loaded?.createCipheriv === 'function' && nativePassesProbe(loaded)) nodeCrypto = loaded;
  }
} catch {
  nodeCrypto = null;
}

export const aead = (key: Uint8Array, nonce: Uint8Array, aad?: Uint8Array): Aead => {
  if (key.length !== 32) throw new Error('AEAD_KEY_INVALID');
  if (nonce.length !== 12) throw new Error('AEAD_NONCE_INVALID');
  return nodeCrypto ? nativeAead(nodeCrypto, key, nonce, aad) : gcm(key, nonce, aad);
};

