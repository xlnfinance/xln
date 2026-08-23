import { aead } from '../crypto/fast/fast-aead';
import { x25519PublicKey, x25519SharedSecret } from '../crypto/fast/fast-x25519';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { decodeBase64Bytes, encodeBase64Bytes } from '../serialization/base64';
import { MAX_HTLC_BINARY_LAYER_BYTES } from './codec/binary';
import { RecencyMemo } from '../../support/collections/recency-memo';
import { computeIntegrityDigest } from '../../support/bytes/integrity-checksum';
import { countOp } from '../../support/performance/op-counters';

export const HTLC_OPAQUE_CIPHERTEXT_VERSION = 'xln:htlc-opaque:v1' as const;
export type OpaqueHtlcCiphertext = Readonly<{
  version: typeof HTLC_OPAQUE_CIPHERTEXT_VERSION;
  /** ephemeral X25519 public key || AES-256-GCM ciphertext+tag */
  ciphertext: string;
}>;

const EPHEMERAL_PUBLIC_KEY_BYTES = 32;
const AUTH_TAG_BYTES = 16;
const MAX_PACKED_BYTES = EPHEMERAL_PUBLIC_KEY_BYTES + MAX_HTLC_BINARY_LAYER_BYTES + AUTH_TAG_BYTES;

const keyBytes = (value: string, code: string): Uint8Array => {
  const trimmed = String(value || '').trim();
  const normalized = (trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error(code);
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  if (bytes.every(byte => byte === 0)) throw new Error(code);
  return bytes;
};

const keyHex = (value: Uint8Array): string =>
  `0x${Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('')}`;

export class HtlcCiphertextAuthenticationError extends Error {
  constructor(cause?: unknown) {
    super('HTLC_CIPHERTEXT_AUTHENTICATION_FAILED', { cause });
    this.name = 'HtlcCiphertextAuthenticationError';
  }
}

/**
 * Public key derived from each private key seen by this process. A keypair
 * check runs once per HTLC layer on every materialization; deriving the public
 * key is a full X25519 scalar multiplication, so the derivation is memoized on
 * the private-key string (a pure function of it). Bounded: an entity holds a
 * handful of encryption keys.
 */
const derivedPublicKeyHexByPrivateKey = new Map<string, string>();
const DERIVED_PUBLIC_KEY_MEMO_MAX = 64;

const derivePublicKeyHex = (entityPrivateKey: string): string => {
  const memoized = derivedPublicKeyHexByPrivateKey.get(entityPrivateKey);
  if (memoized !== undefined) return memoized;
  const privateKey = keyBytes(entityPrivateKey, 'HTLC_ENTITY_ENCRYPTION_PRIVATE_KEY_INVALID');
  const derived = keyHex(x25519PublicKey(privateKey));
  if (derivedPublicKeyHexByPrivateKey.size >= DERIVED_PUBLIC_KEY_MEMO_MAX) derivedPublicKeyHexByPrivateKey.clear();
  derivedPublicKeyHexByPrivateKey.set(entityPrivateKey, derived);
  return derived;
};

// A Hub checks its own keypair once per inbound layer; the pair is constant.
let verifiedKeypair: { publicKey: string; privateKey: string } | undefined;
export const assertEntityEncryptionKeypair = (
  entityPublicKey: string,
  entityPrivateKey: string,
): void => {
  if (verifiedKeypair?.publicKey === entityPublicKey && verifiedKeypair.privateKey === entityPrivateKey) return;
  const publicKey = keyBytes(entityPublicKey, 'HTLC_ENTITY_ENCRYPTION_PUBLIC_KEY_INVALID');
  if (derivePublicKeyHex(entityPrivateKey) !== keyHex(publicKey)) {
    throw new Error('HTLC_ENTITY_ENCRYPTION_KEYPAIR_MISMATCH');
  }
  verifiedKeypair = { publicKey: entityPublicKey, privateKey: entityPrivateKey };
};

const aeadKey = (shared: Uint8Array, context: Uint8Array): Uint8Array => {
  if (shared.every(byte => byte === 0)) throw new Error('HTLC_X25519_LOW_ORDER_SHARED_SECRET');
  return hkdf(
    sha256,
    shared,
    sha256(new TextEncoder().encode(`${HTLC_OPAQUE_CIPHERTEXT_VERSION}:hkdf-salt`)),
    context,
    32,
  );
};

const contextBytes = (contextHash: string): Uint8Array => {
  const normalized = String(contextHash || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error('HTLC_ENCRYPTION_CONTEXT_HASH_INVALID');
  return new TextEncoder().encode(`${HTLC_OPAQUE_CIPHERTEXT_VERSION}:${normalized}`);
};

const deriveNonce = (ephemeralPublicKey: Uint8Array, recipientPublicKey: Uint8Array, context: Uint8Array): Uint8Array => {
  const material = new Uint8Array(ephemeralPublicKey.length + recipientPublicKey.length + context.length);
  material.set(ephemeralPublicKey, 0);
  material.set(recipientPublicKey, ephemeralPublicKey.length);
  material.set(context, ephemeralPublicKey.length + recipientPublicKey.length);
  return sha256(material).slice(0, 12);
};

const opaqueHtlcCiphertextShape = (value: unknown): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const valueType = typeof value;
  if (valueType !== 'object') return valueType;
  const record = value as Record<string, unknown>;
  const ciphertext = record['ciphertext'];
  return [
    `keys=${Object.keys(record).sort().join(',')}`,
    `version=${typeof record['version']}:${String(record['version'] ?? '').slice(0, 40)}`,
    `ciphertext=${typeof ciphertext}:${typeof ciphertext === 'string' ? ciphertext.length : -1}`,
  ].join(':');
};

export const assertOpaqueHtlcCiphertext = (value: unknown): OpaqueHtlcCiphertext => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`HTLC_OPAQUE_CIPHERTEXT_INVALID:${opaqueHtlcCiphertextShape(value)}`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 2 || !keys.includes('ciphertext') || !keys.includes('version') ||
    record['version'] !== HTLC_OPAQUE_CIPHERTEXT_VERSION ||
    typeof record['ciphertext'] !== 'string' ||
    record['ciphertext'].length === 0 ||
    record['ciphertext'].length > Math.ceil(MAX_PACKED_BYTES / 3) * 4
  ) throw new Error(`HTLC_OPAQUE_CIPHERTEXT_INVALID:${opaqueHtlcCiphertextShape(value)}`);
  const ciphertext = record['ciphertext'];
  // The same layer text is asserted by ingress validation, onion decoding and
  // context materialization; a string that decoded canonically once still does.
  if (!canonicalCiphertexts.has(ciphertext)) {
    const packed = decodeBase64Bytes(ciphertext, 'HTLC_OPAQUE_CIPHERTEXT_BASE64_INVALID');
    if (packed.length < EPHEMERAL_PUBLIC_KEY_BYTES + AUTH_TAG_BYTES || packed.length > MAX_PACKED_BYTES) {
      throw new Error('HTLC_OPAQUE_CIPHERTEXT_SIZE_INVALID');
    }
    if (encodeBase64Bytes(packed) !== ciphertext) throw new Error('HTLC_OPAQUE_CIPHERTEXT_NON_CANONICAL');
    canonicalCiphertexts.set(ciphertext, true);
  }
  return { version: HTLC_OPAQUE_CIPHERTEXT_VERSION, ciphertext };
};
const canonicalCiphertexts = new RecencyMemo<string, true>(4_096);

const opaqueCiphertextHashMemo = new Map<string, string>();
const OPAQUE_CIPHERTEXT_HASH_MEMO_MAX = 8192;

export const hashOpaqueHtlcCiphertext = (value: OpaqueHtlcCiphertext): string => {
  const ciphertext = assertOpaqueHtlcCiphertext(value).ciphertext;
  const memoized = opaqueCiphertextHashMemo.get(ciphertext);
  if (memoized !== undefined) return memoized;
  const hash = computeIntegrityDigest(decodeBase64Bytes(ciphertext));
  if (opaqueCiphertextHashMemo.size >= OPAQUE_CIPHERTEXT_HASH_MEMO_MAX) opaqueCiphertextHashMemo.clear();
  opaqueCiphertextHashMemo.set(ciphertext, hash);
  return hash;
};

export const encryptOpaqueHtlcBytes = (
  plaintext: Uint8Array,
  recipientPublicKey: string,
  contextHash: string,
  ephemeralPrivateKey: string,
): OpaqueHtlcCiphertext => {
  if (plaintext.length > MAX_HTLC_BINARY_LAYER_BYTES) throw new Error('HTLC_ENCRYPTION_PLAINTEXT_TOO_LARGE');
  const recipient = keyBytes(recipientPublicKey, 'HTLC_ENTITY_ENCRYPTION_PUBLIC_KEY_INVALID');
  const ephemeralSecret = keyBytes(ephemeralPrivateKey, 'HTLC_EPHEMERAL_PRIVATE_KEY_INVALID');
  const ephemeralPublic = x25519PublicKey(ephemeralSecret);
  const shared = x25519SharedSecret(ephemeralSecret, recipient);
  const context = contextBytes(contextHash);
  const nonce = deriveNonce(ephemeralPublic, recipient, context);
  const encrypted = aead(aeadKey(shared, context), nonce, context).encrypt(plaintext);
  const packed = new Uint8Array(ephemeralPublic.length + encrypted.length);
  packed.set(ephemeralPublic, 0);
  packed.set(encrypted, ephemeralPublic.length);
  return assertOpaqueHtlcCiphertext({
    version: HTLC_OPAQUE_CIPHERTEXT_VERSION,
    ciphertext: encodeBase64Bytes(packed),
  });
};

/**
 * Decryption is a pure function of (ciphertext, keypair, context) and the same
 * layer is decrypted more than once per process: the proposer materializes it,
 * then the validator replay re-derives it from the committed frame — the same
 * process for a single-signer entity — and each is an X25519 scalar
 * multiplication. Memoize the plaintext by those inputs; the private key is
 * implied by the public key inside one process, so the key never enters the
 * memo key. Bounded to recent layers.
 */
// Generation ≈ a few Hub frames of inbound layers; a flat map that cleared at
// a fixed size dropped the layers the pool had just primed for this frame.
const decryptedLayerMemo = new RecencyMemo<string, Uint8Array>(16_384);

const decryptedLayerMemoKey = (ciphertext: OpaqueHtlcCiphertext, entityPublicKey: string, contextHash: string): string =>
  `${ciphertext.ciphertext}|${entityPublicKey}|${contextHash}`;

/** Worker-pool result for one layer; the synchronous decrypt then hits the memo. */
export const primeDecryptedOpaqueHtlcLayer = (
  ciphertext: OpaqueHtlcCiphertext,
  entityPublicKey: string,
  contextHash: string,
  plaintext: Uint8Array,
): void => {
  decryptedLayerMemo.set(decryptedLayerMemoKey(ciphertext, entityPublicKey, contextHash), plaintext.slice());
};

export const isDecryptedOpaqueHtlcLayerPrimed = (
  ciphertext: OpaqueHtlcCiphertext,
  entityPublicKey: string,
  contextHash: string,
): boolean => decryptedLayerMemo.has(decryptedLayerMemoKey(ciphertext, entityPublicKey, contextHash));

export const decryptOpaqueHtlcBytes = (
  ciphertext: OpaqueHtlcCiphertext,
  entityPublicKey: string,
  entityPrivateKey: string,
  contextHash: string,
): Uint8Array => {
  const memoKey = decryptedLayerMemoKey(ciphertext, entityPublicKey, contextHash);
  const memoized = decryptedLayerMemo.get(memoKey);
  if (memoized !== undefined) {
    countOp('htlc.layer.memoHit');
    assertEntityEncryptionKeypair(entityPublicKey, entityPrivateKey);
    return memoized.slice();
  }
  countOp('htlc.layer.memoMiss');
  const plaintext = decryptOpaqueHtlcBytesUncached(ciphertext, entityPublicKey, entityPrivateKey, contextHash);
  decryptedLayerMemo.set(memoKey, plaintext.slice());
  return plaintext;
};

const decryptOpaqueHtlcBytesUncached = (
  ciphertext: OpaqueHtlcCiphertext,
  entityPublicKey: string,
  entityPrivateKey: string,
  contextHash: string,
): Uint8Array => {
  const packed = decodeBase64Bytes(assertOpaqueHtlcCiphertext(ciphertext).ciphertext);
  const ephemeralPublic = packed.slice(0, EPHEMERAL_PUBLIC_KEY_BYTES);
  const encrypted = packed.slice(EPHEMERAL_PUBLIC_KEY_BYTES);
  const publicKey = keyBytes(entityPublicKey, 'HTLC_ENTITY_ENCRYPTION_PUBLIC_KEY_INVALID');
  const privateKey = keyBytes(entityPrivateKey, 'HTLC_ENTITY_ENCRYPTION_PRIVATE_KEY_INVALID');
  assertEntityEncryptionKeypair(entityPublicKey, entityPrivateKey);
  const context = contextBytes(contextHash);
  const nonce = deriveNonce(ephemeralPublic, publicKey, context);
  let plaintext: Uint8Array;
  try {
    const shared = x25519SharedSecret(privateKey, ephemeralPublic);
    plaintext = aead(aeadKey(shared, context), nonce, context).decrypt(encrypted);
  } catch (error) {
    throw new HtlcCiphertextAuthenticationError(error);
  }
  if (plaintext.length > MAX_HTLC_BINARY_LAYER_BYTES) throw new Error('HTLC_DECRYPTED_PLAINTEXT_TOO_LARGE');
  return plaintext;
};
