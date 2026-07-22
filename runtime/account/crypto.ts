/**
 * Real cryptographic signatures for account consensus.
 * Canonical signerId is EOA address (lowercase). Keys are loaded via registerSignerKey.
 */

import * as secp256k1 from '@noble/secp256k1';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes } from '@noble/hashes/utils.js';
import { HDNodeWallet, getIndexedAccountPath, getBytes, keccak256 } from 'ethers';
import { Buffer as BufferPolyfill } from 'buffer';
import * as bip39 from 'bip39';

type RuntimeGlobal = typeof globalThis & {
  Bun?: unknown;
  Buffer?: typeof BufferPolyfill;
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

type SignerKeyStore = {
  privateKeys: Map<string, Uint8Array>;
  publicKeys: Map<string, Uint8Array>;
  addresses: Map<string, string>;
  externalPublicKeys: Map<string, Uint8Array>;
  numericKeys: Map<string, {
    privateKey: Uint8Array;
    publicKey: Uint8Array;
    address: string;
  }>;
  mnemonic?: string;
};

let nativeSecp256k1: NativeSecp256k1 | null | undefined;

const isBrowserRuntime = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.document !== 'undefined';

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
// Always install a sync HMAC implementation (Node/Bun fast path, browser fallback).
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

// Key material is scoped by the owning vault seed fingerprint. Multiple Env
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
    (globalThis as RuntimeGlobal).Buffer = BufferPolyfill;
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

const optionalScopeKey = (scope: SignerKeyScope): string | null => {
  const seed = seedFromScope(scope);
  if (seed === null || seed === undefined || toSeedBytes(seed).length === 0) return null;
  return bytesToHex(sha256(toSeedBytes(seed)));
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
    throw new Error(`DEPRECATED_SIGNER_PREFIX: signerId "${signerId}" must be numeric (e.g. "1")`);
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
export async function deriveSignerKey(masterSeed: Uint8Array | string, signerId: string): Promise<Uint8Array> {
  return deriveSignerKeySync(masterSeed, signerId);
}

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

const cacheNumericSigner = (seed: Uint8Array | string, signerId: string): Uint8Array => {
  const key = signerId.toLowerCase();
  const store = getSignerKeyStore(seed, true)!;
  const cached = store.numericKeys.get(key);
  if (cached) return cached.privateKey;
  const privateKey = deriveSignerKeySync(seed, signerId);
  const address = deriveSignerAddressSync(seed, signerId).toLowerCase();
  const publicKey = secp256k1.getPublicKey(privateKey);
  store.numericKeys.set(key, { privateKey, publicKey, address });
  registerSignerKey(seed, address, privateKey);
  return privateKey;
};

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
  if (cached) {
    assertSignerKeyMatchesId(canonicalSignerId, cached, 'getOrDeriveKey(cache)');
    return cached;
  }

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
  if (cached) {
    assertSignerKeyMatchesId(key, cached, 'getCachedSignerPrivateKey(cache)');
  }
  return cached;
}

/**
 * Resolve a key owned by this exact runtime. Numeric aliases are derived from
 * the caller's seed and can never select process-global state from another
 * Env. Address-shaped signer ids remain explicit cache entries and return null
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
  const cached = getSignerKeyStore(scope)?.privateKeys.get(key) || null;
  if (cached) {
    assertSignerKeyMatchesId(key, cached, 'getExactRegisteredSignerPrivateKey(cache)');
  }
  return cached;
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

// Export for runtime/hanko/signing.ts
export function getSignerPrivateKey(env: SignerKeyEnv, signerId: string): Uint8Array {
  const key = signerId.toLowerCase();
  if (parseSignerIndex(key) !== null) {
    if (env?.runtimeSeed === undefined || env?.runtimeSeed === null) {
      throw new Error(`CRYPTO_DETERMINISM_VIOLATION: getSignerPrivateKey called without env.runtimeSeed for signer ${key}`);
    }
    return getOrDeriveKey(env.runtimeSeed, key);
  }
  const exactRegistered = getExactRegisteredSignerPrivateKey(env, key);
  if (exactRegistered) {
    return exactRegistered;
  }
  if (isHexAddress(key)) {
    const registeredCount = getSignerKeyStore(env)?.privateKeys.size ?? 0;
    throw new Error(
      `MISSING_SIGNER_KEY: no registered private key for signer ${key}. ` +
      `This runtime must prewarm its local signer EOAs on env creation. ` +
      `registeredCount=${registeredCount}`,
    );
  }
  throw new Error(`UNSUPPORTED_SIGNER_ID: "${signerId}" is not numeric or a registered EOA address.`);
}

export function getSignerPublicKey(env: SignerKeyEnv, signerId: string): Uint8Array | null {
  const key = signerId.toLowerCase();
  if (parseSignerIndex(key) !== null) {
    if (env?.runtimeSeed === undefined || env?.runtimeSeed === null) {
      return null;
    }
    const privateKey = getOrDeriveKey(env.runtimeSeed, key);
    return secp256k1.getPublicKey(privateKey);
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
    const privateKey = getOrDeriveKey(env.runtimeSeed, key);
    return privateKeyToAddress(privateKey);
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
 * Register test keys for scenarios.
 * Deprecated: use real runtime seeds and numeric signer IDs instead.
 */
export async function registerTestKeys(_signerIds: string[]): Promise<void> {
  throw new Error('registerTestKeys is disabled. Use runtimeSeed + numeric signerIds (1,2,3...)');
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

export function signDigestBytesWithPrivateKey(
  privateKey: Uint8Array,
  messageBytes: Uint8Array,
): { signature: Uint8Array; recovery: number } {
  installHmacSync();
  if (messageBytes.length !== 32) {
    throw new Error(`SIGN_DIGEST_INVALID_LENGTH:${messageBytes.length}`);
  }
  const native = getNativeSecp256k1();
  if (native) {
    // Same raw secp256k1 ECDSA operation as noble, only through the native
    // backend available in Bun/Node. Browser builds keep the audited noble
    // fallback below; Hanko bytes and on-chain ecrecover compatibility do not
    // change.
    const { signature, recid } = native.ecdsaSign(messageBytes, privateKey);
    return { signature: new Uint8Array(signature), recovery: recid };
  }
  const [signature, recovery] = secp256k1.signSync(messageBytes, privateKey, { recovered: true, der: false });
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
    const native = getNativeSecp256k1();
    const publicKey = native
      ? native.ecdsaRecover(signature, recovery, messageBytes, false)
      : secp256k1.recoverPublicKey(messageBytes, signature, recovery, false);
    return `0x${keccak256(publicKey.slice(1)).slice(-40)}`.toLowerCase();
  } catch {
    return null;
  }
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
    // Deterministic fallback for replay/recovery: recover address from signature.
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
    const recovered = recoverAddressFromDigestSignature(
      parsed.digest,
      parsed.compact,
      parsed.recovery,
    );
    const expectedAddress = addressFromPublicKey(publicKey);
    if (!recovered || !expectedAddress || recovered !== expectedAddress) return false;
    if (/^0x[a-f0-9]{40}$/i.test(key) && expectedAddress !== key) return false;

    const native = getNativeSecp256k1();
    return native
      ? native.ecdsaVerify(parsed.compact, parsed.digest, publicKey)
      : secp256k1.verify(parsed.compact, parsed.digest, publicKey);
  } catch (error) {
    console.error(`❌ Signature verification error for ${signerId.slice(-4)}:`, error);
    return false;
  }
}

/**
 * Validate multiple signatures for account frame
 */
export function validateAccountSignatures(
  env: SignerKeyEnv,
  frameHash: string,
  signatures: string[],
  expectedSigners: string[]
): { valid: boolean; validSigners: string[] } {
  const validSigners: string[] = [];
  const remaining = new Set(expectedSigners);

  for (const signature of signatures) {
    for (const signer of Array.from(remaining)) {
      const isValid = verifyAccountSignature(env, signer, frameHash, signature);
      if (isValid) {
        validSigners.push(signer);
        remaining.delete(signer);
        break;
      }
    }
  }

  const allValid = validSigners.length === expectedSigners.length;
  return { valid: allValid, validSigners };
}
