import { ethers } from 'ethers';
import { TextDecoder, TextEncoder } from 'util';
import { deserializeTaggedJson, serializeTaggedJson } from '../serialization-utils';
import {
  computeRuntimeRecoveryBundleHash,
  validateRuntimeRecoveryBundle,
} from './bundle';
import type {
  EncryptedRuntimeRecoveryBundleV1,
  RuntimeRecoveryBundleV1,
} from './types';

const RECOVERY_LOOKUP_DOMAIN = 'xln:recovery:lookup:v1';
const RECOVERY_AES_KEY_DOMAIN = 'xln:recovery:key:v1';
const TOWER_APPOINTMENT_DOMAIN = 'xln:tower:appointment:v1';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toOwnedArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const view = bytes.slice();
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
};

const deriveAesKeyBytes = (runtimeId: string, runtimeSeed: string): Uint8Array =>
  ethers.getBytes(
    ethers.keccak256(
      ethers.toUtf8Bytes(`${RECOVERY_AES_KEY_DOMAIN}|${String(runtimeId).toLowerCase()}|${runtimeSeed}`),
    ),
  );

const importAesKey = async (runtimeId: string, runtimeSeed: string): Promise<CryptoKey> => {
  return crypto.subtle.importKey(
    'raw',
    toOwnedArrayBuffer(deriveAesKeyBytes(runtimeId, runtimeSeed)),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
};

export const deriveRuntimeRecoveryLookupKey = (runtimeId: string, runtimeSeed: string): string =>
  ethers.keccak256(
    ethers.toUtf8Bytes(`${RECOVERY_LOOKUP_DOMAIN}|${String(runtimeId).toLowerCase()}|${runtimeSeed}`),
  );

export const buildTowerAppointmentOwnerMessage = (
  runtimeId: string,
  lookupKey: string,
  bundleHash: string,
  height: number,
  signedAt: number,
): string =>
  `${TOWER_APPOINTMENT_DOMAIN}|${String(runtimeId).toLowerCase()}|${lookupKey}|${bundleHash}|${Math.max(0, Math.floor(Number(height || 0)))}|${Math.max(0, Math.floor(Number(signedAt || 0)))}`;

export const encryptRuntimeRecoveryBundle = async (
  bundle: RuntimeRecoveryBundleV1,
  runtimeSeed: string,
): Promise<EncryptedRuntimeRecoveryBundleV1> => {
  const validated = validateRuntimeRecoveryBundle(bundle);
  const key = await importAesKey(validated.runtimeId, runtimeSeed);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(serializeTaggedJson(validated));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext),
  );
  return {
    version: 1,
    runtimeId: validated.runtimeId,
    lookupKey: deriveRuntimeRecoveryLookupKey(validated.runtimeId, runtimeSeed),
    height: validated.runtimeHeight,
    createdAt: validated.createdAt,
    bundleHash: computeRuntimeRecoveryBundleHash(validated),
    iv: ethers.hexlify(iv),
    ciphertext: ethers.hexlify(ciphertext),
  };
};

export const decryptRuntimeRecoveryBundle = async (
  encrypted: EncryptedRuntimeRecoveryBundleV1,
  runtimeSeed: string,
): Promise<RuntimeRecoveryBundleV1> => {
  if (!encrypted || encrypted.version !== 1) {
    throw new Error(`RECOVERY_BUNDLE_ENCRYPTED_VERSION_UNSUPPORTED: ${String(encrypted?.version ?? 'unknown')}`);
  }
  const key = await importAesKey(encrypted.runtimeId, runtimeSeed);
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toOwnedArrayBuffer(ethers.getBytes(encrypted.iv)) },
      key,
      toOwnedArrayBuffer(ethers.getBytes(encrypted.ciphertext)),
    ),
  );
  const parsed = deserializeTaggedJson<RuntimeRecoveryBundleV1>(decoder.decode(plaintext));
  const validated = validateRuntimeRecoveryBundle(parsed);
  const bundleHash = computeRuntimeRecoveryBundleHash(validated);
  if (bundleHash !== encrypted.bundleHash) {
    throw new Error(`RECOVERY_BUNDLE_HASH_MISMATCH: expected=${encrypted.bundleHash} actual=${bundleHash}`);
  }
  const lookupKey = deriveRuntimeRecoveryLookupKey(validated.runtimeId, runtimeSeed);
  if (lookupKey !== encrypted.lookupKey) {
    throw new Error(`RECOVERY_LOOKUP_KEY_MISMATCH: expected=${encrypted.lookupKey} actual=${lookupKey}`);
  }
  return validated;
};
