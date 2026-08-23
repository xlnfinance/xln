/**
 * X25519 backend selection (same scheme as fast-keccak / fast-sha256): the
 * pure-JS @noble ladder costs ~330 µs per scalar multiplication; node:crypto's
 * native X25519 (Bun and Node) costs ~25 µs for the identical RFC 7748 result.
 * A Hub decrypts one onion layer per forwarded lock and a payer encrypts one
 * per hop, so this was ~4% of Hub CPU at 500 users. Browsers fall back to noble.
 */
import { x25519 } from '@noble/curves/ed25519.js';
import { isBrowserRuntime } from '../../../support/platform-crypto';

type NodeCrypto = typeof import('node:crypto');
type KeyObject = import('node:crypto').KeyObject;

const PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
]);
const SPKI_PREFIX = Uint8Array.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00]);

const withPrefix = (prefix: Uint8Array, raw: Uint8Array): Uint8Array => {
  const out = new Uint8Array(prefix.length + raw.length);
  out.set(prefix, 0);
  out.set(raw, prefix.length);
  return out;
};

const rawDiffieHellman = (crypto: NodeCrypto, privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array => {
  const shared = crypto.diffieHellman({
    privateKey: crypto.createPrivateKey({ key: Buffer.from(withPrefix(PKCS8_PREFIX, privateKey)), format: 'der', type: 'pkcs8' }),
    publicKey: crypto.createPublicKey({ key: Buffer.from(withPrefix(SPKI_PREFIX, publicKey)), format: 'der', type: 'spki' }),
  });
  return new Uint8Array(shared.buffer, shared.byteOffset, shared.byteLength);
};

const rawPublicKey = (crypto: NodeCrypto, privateKey: Uint8Array): Uint8Array => {
  const privateKeyObject = crypto.createPrivateKey({ key: Buffer.from(withPrefix(PKCS8_PREFIX, privateKey)), format: 'der', type: 'pkcs8' });
  const spki = crypto.createPublicKey(privateKeyObject).export({ format: 'der', type: 'spki' }) as Buffer;
  return new Uint8Array(spki.buffer, spki.byteOffset + spki.byteLength - 32, 32);
};

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

// Same self-test discipline as fast-keccak/fast-sha256: never trust a fast
// backend without checking it against the audited noble implementation on a
// fixed probe first. A wrong DER wrapping or a host where node:crypto's DH
// diverges from RFC 7748 would otherwise corrupt HTLC onion encryption and
// p2p session keys silently, forever.
const probeKeyA = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const probeKeyB = Uint8Array.from({ length: 32 }, (_, index) => index + 33);

const nativeX25519PassesProbe = (crypto: NodeCrypto): boolean => {
  try {
    const nativePubA = rawPublicKey(crypto, probeKeyA);
    const nativePubB = rawPublicKey(crypto, probeKeyB);
    if (!bytesEqual(nativePubA, x25519.getPublicKey(probeKeyA))) return false;
    if (!bytesEqual(nativePubB, x25519.getPublicKey(probeKeyB))) return false;
    const nativeShared = rawDiffieHellman(crypto, probeKeyA, nativePubB);
    if (!bytesEqual(nativeShared, x25519.getSharedSecret(probeKeyA, nativePubB))) return false;
    // DH must also be commutative through the native path itself.
    return bytesEqual(nativeShared, rawDiffieHellman(crypto, probeKeyB, nativePubA));
  } catch {
    return false;
  }
};

// Same loading scheme as the native secp256k1 backend in account/crypto.ts.
let nodeCrypto: NodeCrypto | null = null;
try {
  if (!isBrowserRuntime() && typeof require !== 'undefined') {
    const loaded = require('crypto') as NodeCrypto;
    if (
      typeof loaded?.diffieHellman === 'function' &&
      typeof loaded?.createPrivateKey === 'function' &&
      nativeX25519PassesProbe(loaded)
    ) {
      nodeCrypto = loaded;
    }
  }
} catch {
  nodeCrypto = null;
}

const hexOf = (bytes: Uint8Array): string => {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
};

// Entity/session private keys are few and reused for every layer; the KeyObject
// import is memoized on the raw key. Ephemeral keys (one per encryption) miss.
const privateKeyObjects = new Map<string, KeyObject>();
const PRIVATE_KEY_OBJECT_MEMO_MAX = 256;

const privateKeyObject = (crypto: NodeCrypto, privateKey: Uint8Array): KeyObject => {
  const key = hexOf(privateKey);
  const memoized = privateKeyObjects.get(key);
  if (memoized) return memoized;
  const created = crypto.createPrivateKey({
    key: Buffer.from(withPrefix(PKCS8_PREFIX, privateKey)),
    format: 'der',
    type: 'pkcs8',
  });
  if (privateKeyObjects.size >= PRIVATE_KEY_OBJECT_MEMO_MAX) privateKeyObjects.clear();
  privateKeyObjects.set(key, created);
  return created;
};

const assertKeyLength = (bytes: Uint8Array, label: string): void => {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new Error(`X25519_${label}_INVALID`);
};

/** RFC 7748 X25519(k, u): identical bytes on both backends. */
export const x25519SharedSecret = (privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array => {
  assertKeyLength(privateKey, 'PRIVATE_KEY');
  assertKeyLength(publicKey, 'PUBLIC_KEY');
  if (!nodeCrypto) return x25519.getSharedSecret(privateKey, publicKey);
  const shared = nodeCrypto.diffieHellman({
    privateKey: privateKeyObject(nodeCrypto, privateKey),
    publicKey: nodeCrypto.createPublicKey({
      key: Buffer.from(withPrefix(SPKI_PREFIX, publicKey)),
      format: 'der',
      type: 'spki',
    }),
  });
  return new Uint8Array(shared.buffer, shared.byteOffset, shared.byteLength);
};

/** X25519 public key for a 32-byte private scalar. */
export const x25519PublicKey = (privateKey: Uint8Array): Uint8Array => {
  assertKeyLength(privateKey, 'PRIVATE_KEY');
  if (!nodeCrypto) return x25519.getPublicKey(privateKey);
  const spki = nodeCrypto.createPublicKey(privateKeyObject(nodeCrypto, privateKey))
    .export({ format: 'der', type: 'spki' }) as Buffer;
  return new Uint8Array(spki.buffer, spki.byteOffset + spki.byteLength - 32, 32);
};

/** Fresh random X25519 private scalar (clamping happens inside the ladder). */
export const x25519RandomSecretKey = (): Uint8Array => x25519.utils.randomSecretKey();
