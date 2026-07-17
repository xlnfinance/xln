import { HDNodeWallet, Mnemonic, getIndexedAccountPath } from 'ethers';
import type { SigningKey } from 'ethers';
import { buildRuntimeAdapterOwnerBindingDigest } from '@xln/runtime/radapter/owner-binding';
import { normalizeRuntimeId } from './runtimeCommandIntentCodec';

type RuntimeCommandJournalKeys = {
  encryption: CryptoKey;
  inputHmac: CryptoKey;
  ownerSigningKey: SigningKey;
};

const encoder = new TextEncoder();
const keyring = new Map<string, RuntimeCommandJournalKeys>();
const keyEpochs = new Map<string, number>();
const VAULT_RUNTIME_ID_PATTERN = /^0x[0-9a-f]{40}$/;

// Deliberately memory-only. Persisting either derived key next to IndexedDB
// ciphertext recreates the exact device-key failure this journal must avoid.

const ownedArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const normalizeVaultRuntimeId = (value: unknown): string => {
  const runtimeId = normalizeRuntimeId(value);
  if (!VAULT_RUNTIME_ID_PATTERN.test(runtimeId)) {
    throw new Error('RUNTIME_COMMAND_JOURNAL_RUNTIME_ID_INVALID');
  }
  return runtimeId;
};

const requireSubtleCrypto = (): SubtleCrypto => {
  if (!globalThis.crypto?.subtle) {
    throw new Error('RUNTIME_COMMAND_JOURNAL_PROTECTION_UNAVAILABLE');
  }
  return globalThis.crypto.subtle;
};

const normalizeWalletSeed = (seed: string): string => {
  const normalized = String(seed || '').trim().replace(/\s+/g, ' ');
  if (!normalized) throw new Error('RUNTIME_COMMAND_JOURNAL_WALLET_SEED_REQUIRED');
  return normalized;
};

const walletRuntimeId = (seed: string): string => {
  try {
    const mnemonic = Mnemonic.fromPhrase(normalizeWalletSeed(seed));
    return HDNodeWallet.fromMnemonic(mnemonic, getIndexedAccountPath(0)).address.toLowerCase();
  } catch (error) {
    throw new Error('RUNTIME_COMMAND_JOURNAL_WALLET_SEED_INVALID', { cause: error });
  }
};

const deriveKeys = async (runtimeId: string, seed: string): Promise<RuntimeCommandJournalKeys> => {
  const subtle = requireSubtleCrypto();
  const material = await subtle.importKey(
    'raw',
    ownedArrayBuffer(encoder.encode(normalizeWalletSeed(seed))),
    'HKDF',
    false,
    ['deriveKey'],
  );
  const salt = ownedArrayBuffer(encoder.encode(`xln-runtime-command-journal-v2:${runtimeId}`));
  const encryption = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: ownedArrayBuffer(encoder.encode('aes-gcm-record')) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const inputHmac = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: ownedArrayBuffer(encoder.encode('input-identity-hmac')) },
    material,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
  const ownerWallet = HDNodeWallet.fromMnemonic(
    Mnemonic.fromPhrase(normalizeWalletSeed(seed)),
    getIndexedAccountPath(0),
  );
  if (ownerWallet.address.toLowerCase() !== runtimeId) {
    throw new Error(`RUNTIME_COMMAND_JOURNAL_VAULT_ID_MISMATCH:${runtimeId}`);
  }
  return { encryption, inputHmac, ownerSigningKey: ownerWallet.signingKey };
};

export const installRuntimeCommandJournalKeys = async (
  runtimeIdValue: string,
  seed: string,
): Promise<void> => {
  const runtimeId = normalizeVaultRuntimeId(runtimeIdValue);
  // Do not let callers attach an unlocked wallet to an arbitrary remote ID:
  // only the wallet that owns runtime signer slot 1 may unlock its journal.
  if (walletRuntimeId(seed) !== runtimeId) {
    throw new Error(`RUNTIME_COMMAND_JOURNAL_VAULT_ID_MISMATCH:${runtimeId}`);
  }
  const epoch = (keyEpochs.get(runtimeId) ?? 0) + 1;
  keyEpochs.set(runtimeId, epoch);
  const keys = await deriveKeys(runtimeId, seed);
  if (keyEpochs.get(runtimeId) !== epoch) {
    throw new Error(`RUNTIME_COMMAND_JOURNAL_KEY_INSTALL_INTERRUPTED:${runtimeId}`);
  }
  keyring.set(runtimeId, keys);
};

export const lockRuntimeCommandJournal = (runtimeIdValue: string): void => {
  const runtimeId = normalizeVaultRuntimeId(runtimeIdValue);
  keyEpochs.set(runtimeId, (keyEpochs.get(runtimeId) ?? 0) + 1);
  keyring.delete(runtimeId);
};

export const isRuntimeCommandJournalUnlocked = (runtimeIdValue: string): boolean => {
  const runtimeId = String(runtimeIdValue || '').trim().toLowerCase();
  return VAULT_RUNTIME_ID_PATTERN.test(runtimeId) && keyring.has(runtimeId);
};

export const requireRuntimeCommandJournalKeys = (
  runtimeIdValue: string,
): RuntimeCommandJournalKeys => {
  const runtimeId = normalizeVaultRuntimeId(runtimeIdValue);
  const keys = keyring.get(runtimeId);
  if (!keys) throw new Error(`RUNTIME_COMMAND_JOURNAL_LOCKED:${runtimeId}`);
  return keys;
};

export const computeRuntimeCommandInputHmac = async (
  runtimeIdValue: string,
  commandId: string,
  encodedInput: string,
): Promise<string> => {
  const runtimeId = normalizeVaultRuntimeId(runtimeIdValue);
  const { inputHmac } = requireRuntimeCommandJournalKeys(runtimeId);
  const signature = new Uint8Array(await requireSubtleCrypto().sign(
    'HMAC',
    inputHmac,
    ownedArrayBuffer(encoder.encode(`${String(commandId || '').trim()}\0${encodedInput}`)),
  ));
  return `0x${Array.from(signature, byte => byte.toString(16).padStart(2, '0')).join('')}`;
};

export const signRuntimeAdapterOwnerBinding = (
  runtimeIdValue: string,
  challenge: string,
  capability: string,
): string => {
  const runtimeId = normalizeVaultRuntimeId(runtimeIdValue);
  const { ownerSigningKey } = requireRuntimeCommandJournalKeys(runtimeId);
  return ownerSigningKey.sign(
    buildRuntimeAdapterOwnerBindingDigest(runtimeId, challenge, capability),
  ).serialized.toLowerCase();
};
