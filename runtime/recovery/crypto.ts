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
  TowerActivePayloadV1,
  TowerEncryptedPayloadV1,
  TowerModeV1,
} from './types';

const RECOVERY_LOOKUP_DOMAIN = 'xln:recovery:lookup:v1';
const RECOVERY_ACTION_LOOKUP_DOMAIN = 'xln:recovery:action-lookup:v1';
const RECOVERY_AES_KEY_DOMAIN = 'xln:recovery:key:v1';
const TOWER_PAYLOAD_AES_KEY_DOMAIN = 'xln:tower:payload-key:v1';
const TOWER_APPOINTMENT_DOMAIN = 'xln:tower:appointment:v1';
const WATCHTOWER_COUNTER_DISPUTE_DOMAIN = 'XLN_WATCHTOWER_COUNTER_DISPUTE_V1';

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

const normalizeTowerPublicKey = (publicKey: string): string =>
  ethers.SigningKey.computePublicKey(String(publicKey || '').trim(), true);

const deriveTowerPayloadAesKeyBytes = (
  sharedSecret: string,
  ephemeralPublicKey: string,
  towerPublicKey: string,
): Uint8Array =>
  ethers.getBytes(
    ethers.keccak256(
      ethers.solidityPacked(
        ['string', 'bytes', 'bytes', 'bytes'],
        [
          TOWER_PAYLOAD_AES_KEY_DOMAIN,
          ethers.getBytes(sharedSecret),
          ethers.getBytes(ephemeralPublicKey),
          ethers.getBytes(towerPublicKey),
        ],
      ),
    ),
  );

const importTowerPayloadAesKey = async (
  sharedSecret: string,
  ephemeralPublicKey: string,
  towerPublicKey: string,
): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    'raw',
    toOwnedArrayBuffer(deriveTowerPayloadAesKeyBytes(sharedSecret, ephemeralPublicKey, towerPublicKey)),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );

export const getTowerPayloadEncryptionPublicKey = (towerPrivateKey: string): string =>
  new ethers.SigningKey(String(towerPrivateKey || '').trim()).compressedPublicKey;

export const encryptTowerPayloadForPublicKey = async (
  plaintext: string,
  towerPublicKey: string,
): Promise<string> => {
  const normalizedTowerPublicKey = normalizeTowerPublicKey(towerPublicKey);
  const ephemeral = ethers.Wallet.createRandom();
  const ephemeralSigningKey = new ethers.SigningKey(ephemeral.privateKey);
  const ephemeralPublicKey = ephemeralSigningKey.compressedPublicKey;
  const sharedSecret = ephemeralSigningKey.computeSharedSecret(normalizedTowerPublicKey);
  const key = await importTowerPayloadAesKey(sharedSecret, ephemeralPublicKey, normalizedTowerPublicKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext)),
  );
  const encrypted: TowerEncryptedPayloadV1 = {
    version: 1,
    type: 'tower_encrypted_payload',
    alg: 'secp256k1-aes-256-gcm',
    epk: ephemeralPublicKey,
    iv: ethers.hexlify(iv),
    ciphertext: ethers.hexlify(ciphertext),
    plaintextHash: ethers.keccak256(ethers.toUtf8Bytes(plaintext)),
  };
  return serializeTaggedJson(encrypted);
};

export const decryptTowerPayloadWithPrivateKey = async (
  payload: string,
  towerPrivateKey: string,
): Promise<string> => {
  const raw = String(payload || '').trim();
  if (!raw) throw new Error('TOWER_PAYLOAD_EMPTY');
  const parsed = deserializeTaggedJson<Record<string, unknown>>(raw);
  if (parsed['type'] !== 'tower_encrypted_payload') {
    return raw;
  }
  if (parsed['version'] !== 1 || parsed['alg'] !== 'secp256k1-aes-256-gcm') {
    throw new Error('TOWER_PAYLOAD_ENCRYPTION_UNSUPPORTED');
  }
  const towerSigningKey = new ethers.SigningKey(String(towerPrivateKey || '').trim());
  const towerPublicKey = towerSigningKey.compressedPublicKey;
  const ephemeralPublicKey = normalizeTowerPublicKey(String(parsed['epk'] || ''));
  const sharedSecret = towerSigningKey.computeSharedSecret(ephemeralPublicKey);
  const key = await importTowerPayloadAesKey(sharedSecret, ephemeralPublicKey, towerPublicKey);
  const plaintext = decoder.decode(new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toOwnedArrayBuffer(ethers.getBytes(String(parsed['iv'] || '0x'))) },
      key,
      toOwnedArrayBuffer(ethers.getBytes(String(parsed['ciphertext'] || '0x'))),
    ),
  ));
  const expectedHash = String(parsed['plaintextHash'] || '').toLowerCase();
  const actualHash = ethers.keccak256(ethers.toUtf8Bytes(plaintext));
  if (expectedHash && expectedHash !== actualHash) {
    throw new Error(`TOWER_PAYLOAD_HASH_MISMATCH: expected=${expectedHash} actual=${actualHash}`);
  }
  return plaintext;
};

export const deriveRuntimeRecoveryLookupKey = (runtimeId: string, runtimeSeed: string): string =>
  ethers.keccak256(
    ethers.toUtf8Bytes(`${RECOVERY_LOOKUP_DOMAIN}|${String(runtimeId).toLowerCase()}|${runtimeSeed}`),
  );

export const deriveRuntimeRecoveryActionLookupKey = (
  runtimeId: string,
  runtimeSeed: string,
  entityId: string,
  counterentity: string,
): string => ethers.keccak256(
  ethers.toUtf8Bytes(
    `${RECOVERY_ACTION_LOOKUP_DOMAIN}|${String(runtimeId).toLowerCase()}|${String(entityId).toLowerCase()}|${String(counterentity).toLowerCase()}|${runtimeSeed}`,
  ),
);

export const computeTowerActivePayloadDigest = (payload: TowerActivePayloadV1 | null | undefined): string => {
  if (!payload) return ethers.ZeroHash;
  return ethers.keccak256(ethers.toUtf8Bytes(serializeTaggedJson(payload)));
};

export const buildTowerAppointmentOwnerMessage = (
  runtimeId: string,
  towerMode: TowerModeV1,
  lookupKey: string,
  slot: number,
  bundleHash: string,
  height: number,
  signedAt: number,
  activePayload?: TowerActivePayloadV1 | null,
): string =>
  `${TOWER_APPOINTMENT_DOMAIN}|${String(runtimeId).toLowerCase()}|${towerMode}|${lookupKey}|${Math.max(0, Math.floor(Number(slot || 0)))}|${bundleHash}|${Math.max(0, Math.floor(Number(height || 0)))}|${Math.max(0, Math.floor(Number(signedAt || 0)))}|${computeTowerActivePayloadDigest(activePayload)}`;

export const computeWatchtowerCounterDisputeAuthorizationHash = (
  chainId: number,
  depositoryAddress: string,
  towerAddress: string,
  entityId: string,
  counterentity: string,
  finalNonce: number,
  finalProofbodyHash: string,
  lastResortWindowBlocks: number,
  appointmentSequence: number,
): string => ethers.keccak256(
  ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'uint256', 'address', 'address', 'bytes32', 'bytes32', 'uint256', 'bytes32', 'uint256', 'uint256'],
    [
      ethers.keccak256(ethers.toUtf8Bytes(WATCHTOWER_COUNTER_DISPUTE_DOMAIN)),
      BigInt(Math.max(0, Math.floor(Number(chainId || 0)))),
      depositoryAddress,
      towerAddress,
      entityId,
      counterentity,
      BigInt(Math.max(0, Math.floor(Number(finalNonce || 0)))),
      finalProofbodyHash,
      BigInt(Math.max(0, Math.floor(Number(lastResortWindowBlocks || 0)))),
      BigInt(Math.max(0, Math.floor(Number(appointmentSequence || 0)))),
    ],
  ),
);

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
