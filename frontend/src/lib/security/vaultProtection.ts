export type VaultUnlockDurationMs = 600_000 | 86_400_000 | null;

export type ProtectedVaultSecretsV1 = {
  version: 1;
  iv: string;
  ciphertext: string;
  unlockUntil: number | null;
};

export type ProtectedVaultSecretsV2 = {
  version: 2;
  keyId: string;
  iv: string;
  ciphertext: string;
  unlockUntil: number | null;
};

export type ProtectedVaultSecrets = ProtectedVaultSecretsV1 | ProtectedVaultSecretsV2;

export type VaultSecrets = {
  seed: string;
  mnemonic12?: string;
};

export const redactVaultRuntimeForPersistence = <T extends Record<string, unknown>>(
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

const legacyKeyId = (runtimeId: string): string => runtimeId.trim().toLowerCase();

const randomKeyId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
};

const deviceKeyId = (runtimeId: string, protectedSecrets: ProtectedVaultSecrets): string =>
  protectedSecrets.version === 2
    ? `${legacyKeyId(runtimeId)}:${protectedSecrets.keyId}`
    : legacyKeyId(runtimeId);

const putDeviceKey = (runtimeId: string, protectedSecrets: ProtectedVaultSecretsV2, key: CryptoKey): Promise<IDBValidKey> =>
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
  if (left.version === 2 && right.version === 2) return left.keyId === right.keyId;
  return left.iv === right.iv && left.ciphertext === right.ciphertext;
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
  const protectedSecrets: ProtectedVaultSecretsV2 = {
    version: 2,
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
  protectedSecrets: ProtectedVaultSecrets,
): Promise<VaultSecrets | null> => {
  if (protectedSecrets.version !== 1 && protectedSecrets.version !== 2) {
    throw new Error('VAULT_PROTECTION_VERSION_UNSUPPORTED');
  }
  if (protectedSecrets.unlockUntil !== null && protectedSecrets.unlockUntil <= Date.now()) {
    if (protectedSecrets.version === 2) {
      await deleteVaultDeviceKey(runtimeId, protectedSecrets);
    }
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
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as Partial<VaultSecrets>;
    if (typeof parsed.seed !== 'string' || !parsed.seed.trim()) throw new Error('VAULT_SECRET_SEED_INVALID');
    return {
      seed: parsed.seed,
      ...(typeof parsed.mnemonic12 === 'string' && parsed.mnemonic12 ? { mnemonic12: parsed.mnemonic12 } : {}),
    };
  } catch (error) {
    throw new Error(`VAULT_DEVICE_DECRYPT_FAILED:${error instanceof Error ? error.message : String(error)}`);
  }
};
