export type VaultUnlockDurationMs = 600_000 | 86_400_000 | null;

export type ProtectedVaultSecrets = {
  version: 1;
  iv: string;
  ciphertext: string;
  unlockUntil: number | null;
};

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
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('VAULT_KEY_DB_OPERATION_FAILED'));
      transaction.onabort = () => reject(transaction.error ?? new Error('VAULT_KEY_DB_TRANSACTION_ABORTED'));
    });
  } finally {
    db.close();
  }
};

const keyId = (runtimeId: string): string => runtimeId.trim().toLowerCase();

const putDeviceKey = (runtimeId: string, key: CryptoKey): Promise<IDBValidKey> =>
  withKeyStore('readwrite', store => store.put(key, keyId(runtimeId)));

const getDeviceKey = (runtimeId: string): Promise<CryptoKey | undefined> =>
  withKeyStore('readonly', store => store.get(keyId(runtimeId)));

export const deleteVaultDeviceKey = (runtimeId: string): Promise<undefined> =>
  withKeyStore('readwrite', store => store.delete(keyId(runtimeId))) as Promise<undefined>;

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
  await putDeviceKey(runtimeId, key);
  return {
    version: 1,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    unlockUntil: durationMs === null ? null : Date.now() + durationMs,
  };
};

export const unprotectVaultSecrets = async (
  runtimeId: string,
  protectedSecrets: ProtectedVaultSecrets,
): Promise<VaultSecrets | null> => {
  if (protectedSecrets.version !== 1) throw new Error('VAULT_PROTECTION_VERSION_UNSUPPORTED');
  if (protectedSecrets.unlockUntil !== null && protectedSecrets.unlockUntil <= Date.now()) {
    await deleteVaultDeviceKey(runtimeId);
    return null;
  }
  const key = await getDeviceKey(runtimeId);
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
