/**
 * Real cryptographic signatures for account consensus.
 * Canonical signerId is EOA address (lowercase). Keys are loaded via registerSignerKey.
 */

import { cryptoSignPoolEnabled, ECDSA_SIGNATURE_BYTES, signDigestsBatchOnPool } from '../protocol/crypto/crypto-pool';
import { RecencyMemo } from '../support/collections/recency-memo';
import * as secp256k1 from '@noble/secp256k1';
import { countOpWithSite, OP_COUNTERS_ENABLED } from '../support/performance/op-counters';
import { getPerfMs } from '../support/time';
import { isBrowserRuntime } from '../support/platform-crypto';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes } from '@noble/hashes/utils.js';
import { HDNodeWallet, getIndexedAccountPath, getBytes, keccak256 } from 'ethers';
import { Buffer } from 'buffer';
import * as bip39 from 'bip39';

type RuntimeGlobal = typeof globalThis & {
  Bun?: unknown;
  Buffer?: typeof Buffer;
};

type NativeSecp256k1 = {
  ecdsaSign(message: Uint8Array, privateKey: Uint8Array): { signature: Uint8Array; recid: number };
  ecdsaRecover(signature: Uint8Array, recid: number, message: Uint8Array, compressed: boolean): Uint8Array;
  ecdsaVerify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean;
};

export type SignerKeyEnv = {
  runtimeSeed?: Uint8Array | string | null | undefined;
  quietRuntimeLogs?: boolean | undefined;
};

type SignerKeyScope = SignerKeyEnv | Uint8Array | string;

type NumericSignerKey = {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  address: string;
};

type SignerKeyStore = {
  privateKeys: Map<string, Uint8Array>;
  publicKeys: Map<string, Uint8Array>;
  addresses: Map<string, string>;
  externalPublicKeys: Map<string, Uint8Array>;
  numericKeys: Map<string, NumericSignerKey>;
  mnemonic?: string;
};

let nativeSecp256k1: NativeSecp256k1 | null | undefined;

const getNativeSecp256k1 = (): NativeSecp256k1 | null => {
  if (nativeSecp256k1 !== undefined) return nativeSecp256k1;
  nativeSecp256k1 = null;
  if (isBrowserRuntime()) return nativeSecp256k1;
  try {
    if (typeof require !== 'undefined') {
      nativeSecp256k1 = require('secp256k1') as NativeSecp256k1;
    }
  } catch {
    nativeSecp256k1 = null;
  }
  return nativeSecp256k1;
};

// Configure @noble/secp256k1 HMAC (required for signing)
// Always install a sync HMAC implementation (Node/Bun native path, browser portable path).
const installHmacSync = () => {
  if (secp256k1.utils.hmacSha256Sync) return;
  const isBrowser = isBrowserRuntime();
  const isNodeLike =
    !isBrowser &&
    (typeof (globalThis as RuntimeGlobal).Bun !== 'undefined' ||
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

// Key material is scoped by the owning vault seed fingerprint. Multiple RuntimeReplica
// instances may coexist in one JS process, so a process-global address map
// would let one runtime sign or submit as another runtime's validator. The raw
// seed is never used as a map key and clearing one vault cannot affect another.
const signerKeyStores = new Map<string, SignerKeyStore>();
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
// Ensure a full Buffer implementation exists before bip39 (Buffer.isBuffer is required).
const ensureGlobalBuffer = () => {
  const globalBuffer = (globalThis as RuntimeGlobal).Buffer;
  if (!globalBuffer || typeof globalBuffer.isBuffer !== 'function') {
    (globalThis as RuntimeGlobal).Buffer = Buffer;
  }
};

const toSeedBytes = (seed: Uint8Array | string): Uint8Array =>
  typeof seed === 'string' ? textEncoder.encode(seed) : seed;
const toSeedText = (seed: Uint8Array | string): string =>
  typeof seed === 'string' ? seed : textDecoder.decode(seed);

const seedFromScope = (scope: SignerKeyScope): Uint8Array | string | null => {
  if (typeof scope === 'string' || scope instanceof Uint8Array) return scope;
  return scope?.runtimeSeed ?? null;
};

const optionalScopeKeyUncached = (scope: SignerKeyScope): string | null => {
  const seed = seedFromScope(scope);
  if (seed === null || seed === undefined || toSeedBytes(seed).length === 0) return null;
  return bytesToHex(sha256(toSeedBytes(seed)));
};

// Every signer lookup hashed the seed again. The memo is keyed by the scope
// object (the Runtime context), never by the raw seed text, and re-derives if
// that object's seed field changes.
const scopeKeyMemo = new RecencyMemo<object, { seed: Uint8Array | string | null; key: string | null }>(256);
const optionalScopeKey = (scope: SignerKeyScope): string | null => {
  if (typeof scope === 'string' || scope === null || scope === undefined) return optionalScopeKeyUncached(scope);
  const seed = seedFromScope(scope);
  const hit = scopeKeyMemo.get(scope);
  if (hit && hit.seed === seed) return hit.key;
  const key = optionalScopeKeyUncached(scope);
  scopeKeyMemo.set(scope, { seed, key });
  return key;
};

const scopeKey = (scope: SignerKeyScope): string => {
  const key = optionalScopeKey(scope);
  if (!key) throw new Error('SIGNER_KEY_SCOPE_REQUIRED: non-empty runtimeSeed/vault identity is required');
  return key;
};

const createSignerKeyStore = (): SignerKeyStore => ({
  privateKeys: new Map(),
  publicKeys: new Map(),
  addresses: new Map(),
  externalPublicKeys: new Map(),
  numericKeys: new Map(),
});

const getSignerKeyStore = (scope: SignerKeyScope, create = false): SignerKeyStore | null => {
  const key = optionalScopeKey(scope);
  if (!key) {
    if (create) scopeKey(scope);
    return null;
  }
  const existing = signerKeyStores.get(key);
  if (existing || !create) return existing ?? null;
  const created = createSignerKeyStore();
  signerKeyStores.set(key, created);
  return created;
};

const parseSignerIndex = (signerId: string): number | null => {
  const trimmed = signerId.trim();
  if (/^s\d+$/.test(trimmed)) {
    throw new Error(`NONCANONICAL_SIGNER_PREFIX: signerId "${signerId}" must be numeric (e.g. "1")`);
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
  const store = getSignerKeyStore(seed, true)!;
  const seedText = toSeedText(seed).trim();
  if (store.mnemonic) return store.mnemonic;

  const normalized = seedText.toLowerCase().replace(/\s+/g, ' ');
  if (bip39.validateMnemonic(normalized)) {
    store.mnemonic = normalized;
    return normalized;
  }

  const entropy = sha256(toSeedBytes(seedText));
  const mnemonic = bip39.entropyToMnemonic(bytesToHex(entropy));
  store.mnemonic = mnemonic;
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
export function deriveSignerKeySync(masterSeed: Uint8Array | string, signerId: string): Uint8Array {
  const signerIndex = parseSignerIndex(signerId);
  if (signerIndex !== null) {
    return deriveBip39Key(masterSeed, signerIndex);
  }
  const message = textEncoder.encode(signerId);
  return hmac(sha256, toSeedBytes(masterSeed), message);
}

export function prewarmSignerKeyCache(seed: Uint8Array | string, count = 20): string[] {
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new Error(`SIGNER_CACHE_PREWARM_COUNT_INVALID:${String(count)}`);
  }
  const warmed: string[] = [];
  for (let i = 1; i <= count; i++) {
    const indexId = String(i);
    const privateKey = deriveSignerKeySync(seed, indexId);
    const address = deriveSignerAddressSync(seed, indexId).toLowerCase();
    registerSignerKey(seed, address, privateKey);
    warmed.push(address);
  }
  return warmed;
}

export function prewarmSignerLabels(seed: Uint8Array | string, signerLabels: readonly string[]): string[] {
  const warmed: string[] = [];
  const seen = new Set<string>();
  for (const rawLabel of signerLabels) {
    const signerLabel = String(rawLabel || '').trim();
    if (!signerLabel || seen.has(signerLabel)) continue;
    seen.add(signerLabel);
    const privateKey = deriveSignerKeySync(seed, signerLabel);
    const address = deriveSignerAddressSync(seed, signerLabel).toLowerCase();
    registerSignerKey(seed, address, privateKey);
    warmed.push(address);
  }
  return warmed;
}

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
};

const privateKeyToAddress = (privateKey: Uint8Array): string => {
  const publicKey = secp256k1.getPublicKey(privateKey, false); // uncompressed 65 bytes
  const hash = keccak256(publicKey.slice(1));
  return `0x${hash.slice(-40)}`.toLowerCase();
};

const assertSignerKeyMatchesId = (signerId: string, privateKey: Uint8Array, context: string): void => {
  if (!isHexAddress(signerId)) return;
  const expectedAddress = signerId.toLowerCase();
  const derivedAddress = privateKeyToAddress(privateKey);
  if (derivedAddress !== expectedAddress) {
    throw new Error(
      `SIGNER_KEY_MISMATCH: ${context} signerId=${expectedAddress} derived=${derivedAddress}`
    );
  }
};

const getOrDeriveNumericSigner = (
  seed: Uint8Array | string,
  signerId: string,
): NumericSignerKey => {
  const key = signerId.toLowerCase();
  const store = getSignerKeyStore(seed, true)!;
  const cached = store.numericKeys.get(key);
  if (cached) return cached;
  const privateKey = deriveSignerKeySync(seed, signerId);
  const address = deriveSignerAddressSync(seed, signerId).toLowerCase();
  const publicKey = secp256k1.getPublicKey(privateKey);
  const derived = { privateKey, publicKey, address };
  store.numericKeys.set(key, derived);
  registerSignerKey(seed, address, privateKey);
  return derived;
};

const cacheNumericSigner = (seed: Uint8Array | string, signerId: string): Uint8Array =>
  getOrDeriveNumericSigner(seed, signerId).privateKey;

const getOrDeriveKey = (envSeed: Uint8Array | string, signerId: string): Uint8Array => {
  const canonicalSignerId = signerId.toLowerCase();
  const signerIndex = parseSignerIndex(canonicalSignerId);
  if (signerIndex !== null) {
    if (envSeed === undefined || envSeed === null) {
      throw new Error(`CRYPTO_DETERMINISM_VIOLATION: getOrDeriveKey called without env.runtimeSeed for signer ${canonicalSignerId}`);
    }
    return cacheNumericSigner(envSeed, canonicalSignerId);
  }

  const store = getSignerKeyStore(envSeed);
  const cached = store?.privateKeys.get(signerId) || store?.privateKeys.get(canonicalSignerId);
  // Registration proved the key<->address binding; cache hits do not re-derive
  // the public point (that cost one keccak per lookup on every sign/verify).
  if (cached) return cached;

  if (envSeed === undefined || envSeed === null) {
    throw new Error(`CRYPTO_DETERMINISM_VIOLATION: getOrDeriveKey called without env.runtimeSeed for signer ${canonicalSignerId}`);
  }

  if (isHexAddress(canonicalSignerId)) {
    throw new Error(
      `MISSING_SIGNER_KEY: no registered private key for signer ${canonicalSignerId}. ` +
      `Prewarm local signer EOAs from env.runtimeSeed before signing.`
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
export function getCachedSignerPrivateKey(scope: SignerKeyScope, signerId: string): Uint8Array | null {
  const key = signerId.toLowerCase();
  if (parseSignerIndex(key) !== null) {
    throw new Error(`NUMERIC_SIGNER_CACHE_LOOKUP_FORBIDDEN: signerId=${key}`);
  }
  const cached = getSignerKeyStore(scope)?.privateKeys.get(key) || null;
  // Binding proven at registration; no per-lookup re-derivation.
  return cached;
}

/**
 * Resolve a key owned by this exact runtime. Numeric aliases are derived from
 * the caller's seed and can never select process-global state from another
 * RuntimeReplica. Address-shaped signer ids remain explicit cache entries and return null
 * when this process does not own their private key.
 */
export function getLocalSignerPrivateKey(env: SignerKeyEnv, signerId: string): Uint8Array | null {
  const key = signerId.toLowerCase();
  if (parseSignerIndex(key) !== null) {
    if (env?.runtimeSeed === undefined || env.runtimeSeed === null) {
      throw new Error(`CRYPTO_DETERMINISM_VIOLATION: numeric signer ${key} requires env.runtimeSeed`);
    }
    return getOrDeriveKey(env.runtimeSeed, key);
  }
  if (isHexAddress(key)) return getExactRegisteredSignerPrivateKey(env, key);
  throw new Error(`UNSUPPORTED_SIGNER_ID: "${signerId}" is not numeric or an EOA address.`);
}

const getExactRegisteredSignerPrivateKey = (
  scope: SignerKeyScope,
  signerId: string,
): Uint8Array | null => {
  const key = signerId.toLowerCase();
  // Binding proven at registration; no per-lookup re-derivation.
  return getSignerKeyStore(scope)?.privateKeys.get(key) || null;
};

const getExactRegisteredSignerPublicKey = (
  scope: SignerKeyScope,
  signerId: string,
): Uint8Array | null => {
  const key = signerId.toLowerCase();
  const store = getSignerKeyStore(scope);
  const cachedPrivateKey = getExactRegisteredSignerPrivateKey(scope, key);
  if (cachedPrivateKey) {
    const cachedPublicKey = store?.publicKeys.get(key);
    if (cachedPublicKey) return cachedPublicKey;
    const publicKey = secp256k1.getPublicKey(cachedPrivateKey);
    store!.publicKeys.set(key, publicKey);
    return publicKey;
  }
  return null;
};

const getExactRegisteredSignerAddress = (
  scope: SignerKeyScope,
  signerId: string,
): string | null => {
  const key = signerId.toLowerCase();
  const store = getSignerKeyStore(scope);
  const cachedPrivateKey = getExactRegisteredSignerPrivateKey(scope, key);
  if (!cachedPrivateKey) return null;
  const cachedAddress = store?.addresses.get(key);
  if (cachedAddress) return cachedAddress;
  const address = privateKeyToAddress(cachedPrivateKey);
  store!.addresses.set(key, address);
  return address;
};

/**
 * Get cached signer public key (no derivation, cache-only)
 * Used by components that don't have env access
 */
export function getCachedSignerPublicKey(scope: SignerKeyScope, signerId: string): Uint8Array | null {
  const key = signerId.toLowerCase();
  if (parseSignerIndex(key) !== null) {
    throw new Error(`NUMERIC_SIGNER_CACHE_LOOKUP_FORBIDDEN: signerId=${key}`);
  }
  const store = getSignerKeyStore(scope);
  const external = store?.externalPublicKeys.get(key);
  if (external) return external;
  const cached = store?.publicKeys.get(key);
  if (cached) return cached;
  // Try deriving from cached private key
  const privateKey = store?.privateKeys.get(key);
  if (!privateKey) return null;
  const publicKey = secp256k1.getPublicKey(privateKey);
  store!.publicKeys.set(key, publicKey);
  return publicKey;
}

/**
 * Get cached signer address (no derivation, cache-only)
 * Used by components that don't have env access
 */
export function getCachedSignerAddress(scope: SignerKeyScope, signerId: string): string | null {
  const key = signerId.toLowerCase();
  if (parseSignerIndex(key) !== null) {
    throw new Error(`NUMERIC_SIGNER_CACHE_LOOKUP_FORBIDDEN: signerId=${key}`);
  }
  const store = getSignerKeyStore(scope);
  const cached = store?.addresses.get(key);
  if (cached) return cached;
  // Try deriving from cached private key
  const privateKey = store?.privateKeys.get(key);
  if (!privateKey) return null;
  const address = privateKeyToAddress(privateKey);
  store!.addresses.set(key, address);
  return address;
}

export function getSignerPrivateKeyIfAvailable(env: SignerKeyEnv, signerId: string): Uint8Array | null {
  const key = signerId.toLowerCase();
  if (parseSignerIndex(key) !== null) {
    if (env?.runtimeSeed === undefined || env?.runtimeSeed === null) {
      throw new Error(`CRYPTO_DETERMINISM_VIOLATION: getSignerPrivateKey called without env.runtimeSeed for signer ${key}`);
    }
    return getOrDeriveKey(env.runtimeSeed, key);
  }
  const exactRegistered = getExactRegisteredSignerPrivateKey(env, key);
  if (exactRegistered) return exactRegistered;
  if (isHexAddress(key)) return null;
  throw new Error(`UNSUPPORTED_SIGNER_ID: "${signerId}" is not numeric or a registered EOA address.`);
}

/** Canonical EOA inventory owned by one Runtime; never exposes key bytes. */
export function getRegisteredLocalSignerIds(scope: SignerKeyScope): string[] {
  const privateKeys = getSignerKeyStore(scope)?.privateKeys;
  if (!privateKeys) return [];
  return [...privateKeys.keys()].filter(isHexAddress).sort();
}

// Export for core/hanko/signing.ts
export function getSignerPrivateKey(env: SignerKeyEnv, signerId: string): Uint8Array {
  const privateKey = getSignerPrivateKeyIfAvailable(env, signerId);
  if (privateKey) return privateKey;
  const key = signerId.toLowerCase();
  const registeredCount = getSignerKeyStore(env)?.privateKeys.size ?? 0;
  throw new Error(
    `MISSING_SIGNER_KEY: no registered private key for signer ${key}. ` +
    `This runtime must prewarm its local signer EOAs on env creation. ` +
    `registeredCount=${registeredCount}`,
  );
}

export function getSignerPublicKey(env: SignerKeyEnv, signerId: string): Uint8Array | null {
  const key = signerId.toLowerCase();
  if (parseSignerIndex(key) !== null) {
    if (env?.runtimeSeed === undefined || env?.runtimeSeed === null) {
      return null;
    }
    return getOrDeriveNumericSigner(env.runtimeSeed, key).publicKey;
  }
  const store = getSignerKeyStore(env);
  const exactRegistered = getExactRegisteredSignerPublicKey(env, key);
  if (exactRegistered) return exactRegistered;
  const external = store?.externalPublicKeys.get(key);
  if (external) return external;
  const cached = store?.publicKeys.get(key);
  if (cached) return cached;

  return null;
}

export function deriveSignerAddressSync(seed: Uint8Array | string, signerId: string): string {
  const privateKey = deriveSignerKeySync(seed, signerId);
  return privateKeyToAddress(privateKey);
}

export function getSignerAddress(env: SignerKeyEnv, signerId: string): string | null {
  const key = signerId.toLowerCase();
  if (parseSignerIndex(key) !== null) {
    if (env?.runtimeSeed === undefined || env?.runtimeSeed === null) {
      return null;
    }
    return getOrDeriveNumericSigner(env.runtimeSeed, key).address;
  }
  const exactRegistered = getExactRegisteredSignerAddress(env, key);
  if (exactRegistered) return exactRegistered;
  return isHexAddress(key) ? key : null;
}

/**
 * Register signer keys (called when BrainVault unlocked)
 */
export function registerSignerKey(
  scope: SignerKeyScope,
  signerId: string,
  privateKey: Uint8Array,
): void {
  const key = signerId.toLowerCase();
  if (parseSignerIndex(key) !== null) {
    throw new Error(`NUMERIC_SIGNER_REGISTRATION_FORBIDDEN: signerId=${key}`);
  }
  if (!isHexAddress(key)) {
    throw new Error(`SIGNER_ID_NOT_EOA: signerId=${key}`);
  }
  assertSignerKeyMatchesId(key, privateKey, 'registerSignerKey');
  const store = getSignerKeyStore(scope, true)!;
  const existing = store.privateKeys.get(key);
  if (existing && !equalBytes(existing, privateKey)) {
    const currentAddress = privateKeyToAddress(existing);
    const nextAddress = privateKeyToAddress(privateKey);
    throw new Error(
      `SIGNER_KEY_CONFLICT: signerId=${key} current=${currentAddress} next=${nextAddress}`
    );
  }
  store.privateKeys.set(key, privateKey);
  store.publicKeys.set(key, secp256k1.getPublicKey(privateKey));
  store.addresses.set(key, privateKeyToAddress(privateKey));
  store.externalPublicKeys.delete(key);
}

export function registerSignerPublicKey(
  scope: SignerKeyScope,
  signerId: string,
  publicKey: Uint8Array | string,
): void {
  const key = signerId.toLowerCase();
  if (parseSignerIndex(key) !== null) {
    throw new Error(`NUMERIC_SIGNER_REGISTRATION_FORBIDDEN: signerId=${key}`);
  }
  if (!isHexAddress(key)) {
    throw new Error(`SIGNER_PUBLIC_KEY_ID_NOT_EOA: signerId=${key}`);
  }
  const bytes =
    typeof publicKey === 'string'
      ? Uint8Array.from(Buffer.from(publicKey.replace(/^0x/, ''), 'hex'))
      : publicKey;
  const derivedAddress = addressFromPublicKey(bytes);
  if (!derivedAddress) {
    throw new Error(`SIGNER_PUBLIC_KEY_INVALID: signerId=${key}`);
  }
  if (isHexAddress(key) && derivedAddress !== key) {
    throw new Error(
      `SIGNER_PUBLIC_KEY_MISMATCH: signerId=${key} derived=${derivedAddress}`
    );
  }
  const canonicalBytes = secp256k1.Point.fromHex(bytes).toRawBytes(true);
  const store = getSignerKeyStore(scope, true)!;
  if (store.privateKeys.has(key)) return; // Local private key already proves the same EOA binding.
  const existing = store.externalPublicKeys.get(key);
  if (existing && !equalBytes(existing, canonicalBytes)) {
    throw new Error(`SIGNER_PUBLIC_KEY_CONFLICT: signerId=${key}`);
  }
  store.externalPublicKeys.set(key, canonicalBytes);
  store.publicKeys.delete(key);
}

/**
 * Clear all registered keys (for testing isolation)
 */
export function clearSignerKeys(scope: SignerKeyScope): void {
  signerKeyStores.delete(scopeKey(scope));
}

/**
 * Sign account frame using secp256k1
 * Returns: 65-byte signature (r + s + recovery)
 */
export function signAccountFrame(
  env: SignerKeyEnv,
  signerId: string,
  frameHash: string
): string {
  if (env?.runtimeSeed === undefined || env?.runtimeSeed === null) {
    throw new Error(`CRYPTO_DETERMINISM_VIOLATION: signAccountFrame called without env.runtimeSeed for signer ${signerId}`);
  }

  // CRITICAL: Sign raw hash - NO double hashing
  // On-chain _recoverSigner expects ecrecover(hash, sig) where hash is the raw 32-byte message
  // frameHash is already keccak256 output, sign it directly
  return signDigest(env, signerId, frameHash);
}

export function signDigest(scope: SignerKeyScope, signerId: string, digestHex: string): string {
  const seed = seedFromScope(scope);
  if (seed === null) {
    throw new Error(`CRYPTO_DETERMINISM_VIOLATION: signDigest called without runtimeSeed for signer ${signerId}`);
  }
  const privateKey = getOrDeriveKey(seed, signerId);
  const messageBytes = Buffer.from(digestHex.replace('0x', ''), 'hex');
  const { signature, recovery } = signDigestBytesWithPrivateKey(privateKey, messageBytes);
  const sigHex = Buffer.from(signature).toString('hex') + recovery.toString(16).padStart(2, '0');
  return `0x${sigHex}`;
}

/**
 * Sign many digests with one signer on the crypto worker pool. Same RFC 6979
 * deterministic secp256k1 operation as signDigest, so the bytes are identical;
 * returns null when no pool is available (caller signs synchronously).
 */
export async function signDigestsBatch(
  scope: SignerKeyScope,
  signerId: string,
  digestsHex: readonly string[],
): Promise<string[] | null> {
  const seed = seedFromScope(scope);
  if (seed === null) {
    throw new Error(`CRYPTO_DETERMINISM_VIOLATION: signDigestsBatch called without runtimeSeed for signer ${signerId}`);
  }
  if (digestsHex.length === 0 || !cryptoSignPoolEnabled()) return null;
  const privateKey = getOrDeriveKey(seed, signerId);
  const digests = new Uint8Array(digestsHex.length * 32);
  digestsHex.forEach((digestHex, index) => {
    const bytes = Buffer.from(digestHex.replace('0x', ''), 'hex');
    if (bytes.length !== 32) throw new Error(`SIGN_DIGEST_INVALID_LENGTH:${bytes.length}`);
    digests.set(bytes, index * 32);
  });
  const startedAt = OP_COUNTERS_ENABLED ? getPerfMs() : 0;
  const signatures = await signDigestsBatchOnPool(privateKey, digests);
  if (!signatures) return null;
  countOpWithSite('ecdsa.sign.pool', digestsHex.length, 3, OP_COUNTERS_ENABLED ? Math.round((getPerfMs() - startedAt) * 1_000) : 0);
  return digestsHex.map((_, index) => {
    const signature = signatures.subarray(index * ECDSA_SIGNATURE_BYTES, (index + 1) * ECDSA_SIGNATURE_BYTES);
    return `0x${Buffer.from(signature.subarray(0, 64)).toString('hex')}${(signature[64] ?? 0).toString(16).padStart(2, '0')}`;
  });
}

export function signDigestBytesWithPrivateKey(
  privateKey: Uint8Array,
  messageBytes: Uint8Array,
): { signature: Uint8Array; recovery: number } {
  if (messageBytes.length !== 32) {
    throw new Error(`SIGN_DIGEST_INVALID_LENGTH:${messageBytes.length}`);
  }
  installHmacSync();
  const startedAt = OP_COUNTERS_ENABLED ? getPerfMs() : 0;
  const native = getNativeSecp256k1();
  if (native) {
    // Same raw secp256k1 ECDSA operation as noble, only through the native
    // backend available in Bun/Node. Browser builds keep the audited noble
    // portable implementation below; Hanko bytes and on-chain ecrecover compatibility do not
    // change.
    const { signature, recid } = native.ecdsaSign(messageBytes, privateKey);
    countOpWithSite(
      'ecdsa.sign',
      0,
      3,
      OP_COUNTERS_ENABLED ? Math.round((getPerfMs() - startedAt) * 1_000) : 0,
    );
    return { signature: new Uint8Array(signature), recovery: recid };
  }
  const [signature, recovery] = secp256k1.signSync(messageBytes, privateKey, { recovered: true, der: false });
  countOpWithSite(
    'ecdsa.sign',
    0,
    3,
    OP_COUNTERS_ENABLED ? Math.round((getPerfMs() - startedAt) * 1_000) : 0,
  );
  return { signature, recovery };
}

export function recoverAddressFromDigestSignature(
  messageBytes: Uint8Array,
  signature: Uint8Array,
  recovery: number,
): string | null {
  if (messageBytes.length !== 32 || signature.length !== 64) return null;
  if (recovery !== 0 && recovery !== 1) return null;
  try {
    const startedAt = OP_COUNTERS_ENABLED ? getPerfMs() : 0;
    const native = getNativeSecp256k1();
    const publicKey = native
      ? native.ecdsaRecover(signature, recovery, messageBytes, false)
      : secp256k1.recoverPublicKey(messageBytes, signature, recovery, false);
    countOpWithSite(
      'ecdsa.recover',
      0,
      2,
      OP_COUNTERS_ENABLED ? Math.round((getPerfMs() - startedAt) * 1_000) : 0,
    );
    return `0x${keccak256(publicKey.slice(1)).slice(-40)}`.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * `ethers.recoverAddress(digest, signature)` for a 65-byte digest signature
 * (v = 0/1 or 27/28) on the native secp256k1 backend (~7x faster than the
 * portable curve). Returns lowercase, or null exactly where ethers throws
 * (malformed hex, non-canonical high-bit s, invalid r/s, unrecoverable).
 */
export function recoverDigestSignerAddress(digestHex: string, signatureHex: string): string | null {
  if (!/^0x[0-9a-f]{64}$/i.test(digestHex) || !/^0x(?:[0-9a-f]{128}|[0-9a-f]{130})$/i.test(signatureHex)) {
    return null;
  }
  const bytes = Buffer.from(signatureHex.slice(2), 'hex');
  let recovery: number;
  if (bytes.length === 64) {
    // EIP-2098 compact form: yParity lives in the top bit of s.
    recovery = bytes[32]! >> 7;
    bytes[32]! &= 0x7f;
  } else {
    recovery = bytes[64]!;
    if (recovery === 27 || recovery === 28) recovery -= 27;
    if (recovery !== 0 && recovery !== 1) return null;
    if ((bytes[32]! & 0x80) !== 0) return null;
  }
  return recoverAddressFromDigestSignature(
    Buffer.from(digestHex.slice(2), 'hex'),
    bytes.subarray(0, 64),
    recovery,
  );
}

type CanonicalDigestSignature = {
  compact: Uint8Array;
  digest: Uint8Array;
  recovery: 0 | 1;
};

const parseCanonicalDigestSignature = (
  digestHex: string,
  signatureHex: string,
): CanonicalDigestSignature | null => {
  if (!/^0x[0-9a-f]{64}$/i.test(digestHex) || !/^0x[0-9a-f]{130}$/i.test(signatureHex)) {
    return null;
  }
  const bytes = Buffer.from(signatureHex.slice(2), 'hex');
  const recovery = bytes[64];
  if (recovery !== 0 && recovery !== 1) return null;
  try {
    if (secp256k1.Signature.fromCompact(bytes.slice(0, 64)).hasHighS()) return null;
  } catch {
    return null;
  }
  return {
    compact: bytes.slice(0, 64),
    digest: Buffer.from(digestHex.slice(2), 'hex'),
    recovery,
  };
};

const addressFromPublicKey = (publicKey: Uint8Array): string | null => {
  try {
    const uncompressed = secp256k1.Point.fromHex(publicKey).toRawBytes(false);
    return `0x${keccak256(uncompressed.slice(1)).slice(-40)}`.toLowerCase();
  } catch {
    return null;
  }
};

/**
 * Verify account signature using secp256k1
 */
export function verifyAccountSignature(
  env: SignerKeyEnv,
  signerId: string,
  frameHash: string,
  signature: string
): boolean {
  const key = signerId.toLowerCase();
  const quiet = env?.quietRuntimeLogs === true;
  const parsed = parseCanonicalDigestSignature(frameHash, signature);
  if (!parsed) return false;
  const publicKey = getSignerPublicKey(env, key);
  if (!publicKey) {
    // Canonical address-authority path for replay/recovery: recover from the signature.
    // This removes runtime dependence on gossip key registration for account frame verification.
    if (/^0x[a-f0-9]{40}$/i.test(key)) {
      const recovered = recoverAddressFromDigestSignature(
        parsed.digest,
        parsed.compact,
        parsed.recovery,
      );
      if (recovered === key) {
        return true;
      }
    }

    if (!quiet) console.warn(`⚠️ Cannot verify - no public key for signerId=${key.slice(-4)}`);
    if (!quiet) {
      const store = getSignerKeyStore(env);
      console.warn(`⚠️ Available keys:`, Array.from(store?.publicKeys.keys() ?? []).map(k => k.slice(-4)));
      console.warn(`⚠️ Available external keys:`, Array.from(store?.externalPublicKeys.keys() ?? []).map(k => k.slice(-4)));
    }
    return false;
  }

  try {
    // Recover binds the canonical recovery byte to this digest. Verify against
    // the stored key would ignore v and accept either 0/1. Address equality
    // then binds the recovered signer to the registered public key — one EC
    // recover, not recover-plus-verify.
    const recovered = recoverAddressFromDigestSignature(
      parsed.digest,
      parsed.compact,
      parsed.recovery,
    );
    const expectedAddress = addressFromPublicKey(publicKey);
    if (!recovered || !expectedAddress || recovered !== expectedAddress) return false;
    if (/^0x[a-f0-9]{40}$/i.test(key) && expectedAddress !== key) return false;
    return true;
  } catch (error) {
    console.error(`❌ Signature verification error for ${signerId.slice(-4)}:`, error);
    return false;
  }
}
