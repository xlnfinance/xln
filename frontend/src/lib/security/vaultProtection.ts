import { isUnknownRecord as isRecord, parseJsonUnknown } from '$lib/utils/boundary';

export type VaultUnlockDurationMs = 600_000 | 86_400_000 | null;

export type ProtectedVaultSecrets = {
  version: 1;
  keyId: string;
  iv: string;
  ciphertext: string;
  unlockUntil: number | null;
};

export type VaultSecrets = {
  seed: string;
  mnemonic12?: string;
};

const decodeVaultSecrets = (value: unknown): VaultSecrets => {
  if (!isRecord(value)) throw new Error('VAULT_SECRET_PAYLOAD_INVALID');
  const allowed = new Set(['seed', 'mnemonic12']);
  const extras = Object.keys(value).filter(key => !allowed.has(key));
  if (extras.length > 0) throw new Error(`VAULT_SECRET_FIELDS_INVALID:${extras.join(',')}`);
  const seed = value['seed'];
  if (typeof seed !== 'string' || !seed.trim()) throw new Error('VAULT_SECRET_SEED_INVALID');
  const mnemonic12 = value['mnemonic12'];
  if (mnemonic12 !== undefined && (typeof mnemonic12 !== 'string' || !mnemonic12.trim())) {
    throw new Error('VAULT_SECRET_MNEMONIC_INVALID');
  }
  return {
    seed,
    ...(typeof mnemonic12 === 'string' ? { mnemonic12 } : {}),
  };
};

const PROTECTED_VAULT_KEYS = ['version', 'keyId', 'iv', 'ciphertext', 'unlockUntil'] as const;
const KEY_ID_PATTERN = /^[0-9a-f]{32}$/;

const requireExactProtectedVaultKeys = (value: Record<string, unknown>): void => {
  const allowed = new Set<string>(PROTECTED_VAULT_KEYS);
  const missing = PROTECTED_VAULT_KEYS.filter(key => !Object.hasOwn(value, key));
  const extra = Object.keys(value).filter(key => !allowed.has(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`VAULT_PROTECTION_FIELDS_INVALID:missing=${missing.join(',') || 'none'}:extra=${extra.join(',') || 'none'}`);
  }
};

const requireBase64Bytes = (value: unknown, bytes: number | null, code: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(code);
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    throw new Error(code);
  }
  if ((bytes !== null && decoded.length !== bytes) || (bytes === null && decoded.length === 0)) {
    throw new Error(code);
  }
  return value;
};

export const decodeProtectedVaultSecrets = (value: unknown): ProtectedVaultSecrets => {
  if (!isRecord(value)) throw new Error('VAULT_PROTECTION_INVALID');
  requireExactProtectedVaultKeys(value);
  if (value['version'] !== 1) throw new Error('VAULT_PROTECTION_VERSION_UNSUPPORTED');
  if (typeof value['keyId'] !== 'string' || !KEY_ID_PATTERN.test(value['keyId'])) {
    throw new Error('VAULT_PROTECTION_KEY_ID_INVALID');
  }
  const unlockUntil = value['unlockUntil'];
  if (unlockUntil !== null && (
    typeof unlockUntil !== 'number'
    || !Number.isSafeInteger(unlockUntil)
    || unlockUntil < 0
  )) {
    throw new Error('VAULT_PROTECTION_UNLOCK_UNTIL_INVALID');
  }
  return {
    version: 1,
    keyId: value['keyId'],
    iv: requireBase64Bytes(value['iv'], 12, 'VAULT_PROTECTION_IV_INVALID'),
    ciphertext: requireBase64Bytes(value['ciphertext'], null, 'VAULT_PROTECTION_CIPHERTEXT_INVALID'),
    unlockUntil,
  };
};

export const redactVaultRuntimeForPersistence = <T extends {
  seed?: unknown;
  mnemonic12?: unknown;
  devicePassphrase?: unknown;
  env?: unknown;
}>(
  runtime: T,
): Omit<T, 'seed' | 'mnemonic12' | 'devicePassphrase' | 'env'> => {
  const { seed: _seed, mnemonic12: _mnemonic12, devicePassphrase: _devicePassphrase, env: _env, ...metadata } = runtime;
  return metadata;
};

const DB_NAME = 'xln-vault-keys-v1';
const STORE_NAME = 'keys';

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const base64ToBytes = (value: string): Uint8Array => {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
};

const asArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const openKeyDb = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('VAULT_KEY_DB_OPEN_FAILED'));
});

const withKeyStore = async <T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> => {
  const db = await openKeyDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
      let requestCompleted = false;
      let requestResult: T;
      let settled = false;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      request.onsuccess = () => {
        requestResult = request.result;
        requestCompleted = true;
      };
      request.onerror = () => fail(request.error ?? new Error('VAULT_KEY_DB_OPERATION_FAILED'));
      transaction.onerror = () => fail(transaction.error ?? new Error('VAULT_KEY_DB_TRANSACTION_FAILED'));
      transaction.onabort = () => fail(transaction.error ?? new Error('VAULT_KEY_DB_TRANSACTION_ABORTED'));
      transaction.oncomplete = () => {
        if (settled) return;
        if (!requestCompleted) {
          fail(new Error('VAULT_KEY_DB_TRANSACTION_COMPLETED_BEFORE_REQUEST'));
          return;
        }
        settled = true;
        resolve(requestResult!);
      };
    });
  } finally {
    db.close();
  }
};

const normalizedRuntimeKeyId = (runtimeId: string): string => runtimeId.trim().toLowerCase();

const randomKeyId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
};

const deviceKeyId = (runtimeId: string, protectedSecrets: ProtectedVaultSecrets): string =>
  `${normalizedRuntimeKeyId(runtimeId)}:${protectedSecrets.keyId}`;

const putDeviceKey = (runtimeId: string, protectedSecrets: ProtectedVaultSecrets, key: CryptoKey): Promise<IDBValidKey> =>
  withKeyStore('readwrite', store => store.put(key, deviceKeyId(runtimeId, protectedSecrets)));

const getDeviceKey = (runtimeId: string, protectedSecrets: ProtectedVaultSecrets): Promise<CryptoKey | undefined> =>
  withKeyStore('readonly', store => store.get(deviceKeyId(runtimeId, protectedSecrets)));

export const deleteVaultDeviceKey = (
  runtimeId: string,
  protectedSecrets: ProtectedVaultSecrets,
): Promise<undefined> =>
  withKeyStore('readwrite', store => store.delete(deviceKeyId(runtimeId, protectedSecrets))) as Promise<undefined>;

export const sameVaultProtectionLease = (
  left: ProtectedVaultSecrets | null | undefined,
  right: ProtectedVaultSecrets | null | undefined,
): boolean => {
  if (!left || !right || left.version !== right.version) return false;
  return left.keyId === right.keyId;
};

export const protectVaultSecrets = async (
  runtimeId: string,
  secrets: VaultSecrets,
  durationMs: VaultUnlockDurationMs,
): Promise<ProtectedVaultSecrets> => {
  if (!globalThis.crypto?.subtle || typeof indexedDB === 'undefined') {
    throw new Error('VAULT_DEVICE_ENCRYPTION_UNAVAILABLE');
  }
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(secrets));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asArrayBuffer(iv) },
    key,
    asArrayBuffer(plaintext),
  );
  const protectedSecrets: ProtectedVaultSecrets = {
    version: 1,
    keyId: randomKeyId(),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    unlockUntil: durationMs === null ? null : Date.now() + durationMs,
  };
  await putDeviceKey(runtimeId, protectedSecrets, key);
  return protectedSecrets;
};

export const unprotectVaultSecrets = async (
  runtimeId: string,
  encodedProtection: ProtectedVaultSecrets,
): Promise<VaultSecrets | null> => {
  const protectedSecrets = decodeProtectedVaultSecrets(encodedProtection);
  if (protectedSecrets.unlockUntil !== null && protectedSecrets.unlockUntil <= Date.now()) {
    await deleteVaultDeviceKey(runtimeId, protectedSecrets);
    return null;
  }
  const key = await getDeviceKey(runtimeId, protectedSecrets);
  if (!key) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: asArrayBuffer(base64ToBytes(protectedSecrets.iv)) },
      key,
      asArrayBuffer(base64ToBytes(protectedSecrets.ciphertext)),
    );
    return decodeVaultSecrets(parseJsonUnknown(new TextDecoder().decode(plaintext), 'VAULT_SECRET_PAYLOAD_JSON_INVALID'));
  } catch (error) {
    throw new Error(`VAULT_DEVICE_DECRYPT_FAILED:${error instanceof Error ? error.message : String(error)}`);
  }
};
