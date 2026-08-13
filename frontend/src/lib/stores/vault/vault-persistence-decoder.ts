import { getAddress } from 'ethers';
import { decodeProtectedVaultSecrets } from '../../security/vaultProtection';
import type {
  RecoveryTowerConfig,
  Runtime,
  RuntimeRecoveryConfig,
  RuntimeRecoveryTowerFailureSummary,
  RuntimeRecoveryTowerReceiptSummary,
  Signer,
  RuntimesState,
} from './vault-recovery';
import { normalizeRuntimeId } from './vault-recovery';

type RecordValue = Record<string, unknown>;

const record = (value: unknown, code: string): RecordValue => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(code);
  return value as RecordValue;
};

const exactKeys = (value: RecordValue, allowed: readonly string[], code: string): void => {
  const extras = Object.keys(value).filter(key => !allowed.includes(key));
  if (extras.length > 0) throw new Error(`${code}:${extras.join(',')}`);
};

const string = (value: unknown, code: string): string => {
  if (typeof value !== 'string') throw new Error(code);
  return value;
};

const boolean = (value: unknown, code: string): boolean => {
  if (typeof value !== 'boolean') throw new Error(code);
  return value;
};

const integer = (value: unknown, code: string, minimum = 0): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error(code);
  return value;
};

const optionalInteger = (value: unknown, code: string): number | undefined =>
  value === undefined ? undefined : integer(value, code);

const decodeSigner = (value: unknown): Signer => {
  const raw = record(value, 'VAULT_SIGNER_INVALID');
  exactKeys(raw, ['index', 'derivationIndex', 'address', 'name', 'entityId', 'jurisdiction'], 'VAULT_SIGNER_KEYS_INVALID');
  const address = getAddress(string(raw['address'], 'VAULT_SIGNER_ADDRESS_INVALID')).toLowerCase();
  return {
    index: integer(raw['index'], 'VAULT_SIGNER_INDEX_INVALID'),
    ...(raw['derivationIndex'] === undefined ? {} : { derivationIndex: integer(raw['derivationIndex'], 'VAULT_SIGNER_DERIVATION_INDEX_INVALID') }),
    address,
    name: string(raw['name'], 'VAULT_SIGNER_NAME_INVALID'),
    ...(raw['entityId'] === undefined ? {} : { entityId: string(raw['entityId'], 'VAULT_SIGNER_ENTITY_ID_INVALID') }),
    ...(raw['jurisdiction'] === undefined ? {} : { jurisdiction: string(raw['jurisdiction'], 'VAULT_SIGNER_JURISDICTION_INVALID') }),
  };
};

const decodeTower = (value: unknown): RecoveryTowerConfig => {
  const raw = record(value, 'VAULT_RECOVERY_TOWER_INVALID');
  exactKeys(raw, ['id', 'url', 'towerMode', 'enabled'], 'VAULT_RECOVERY_TOWER_KEYS_INVALID');
  const towerMode = raw['towerMode'];
  if (towerMode !== undefined && towerMode !== 'blind_backup' && towerMode !== 'delayed_last_resort') {
    throw new Error('VAULT_RECOVERY_TOWER_MODE_INVALID');
  }
  return {
    ...(raw['id'] === undefined ? {} : { id: string(raw['id'], 'VAULT_RECOVERY_TOWER_ID_INVALID') }),
    url: string(raw['url'], 'VAULT_RECOVERY_TOWER_URL_INVALID'),
    ...(towerMode === undefined ? {} : { towerMode }),
    ...(raw['enabled'] === undefined ? {} : { enabled: boolean(raw['enabled'], 'VAULT_RECOVERY_TOWER_ENABLED_INVALID') }),
  };
};

const decodeTowerReceipt = (value: unknown): RuntimeRecoveryTowerReceiptSummary => {
  const raw = record(value, 'VAULT_RECOVERY_RECEIPT_INVALID');
  exactKeys(raw, ['towerUrl', 'towerMode', 'height', 'bundleHash', 'sequence', 'receivedAt', 'slot', 'storedBytes', 'maxStoredBytes', 'expiresAt', 'appointmentSequence'], 'VAULT_RECOVERY_RECEIPT_KEYS_INVALID');
  if (raw['towerMode'] !== 'blind_backup' && raw['towerMode'] !== 'delayed_last_resort') throw new Error('VAULT_RECOVERY_RECEIPT_MODE_INVALID');
  const appointmentSequence = raw['appointmentSequence'];
  const decodedAppointmentSequence = appointmentSequence === undefined || appointmentSequence === null
    ? appointmentSequence
    : integer(appointmentSequence, 'VAULT_RECOVERY_RECEIPT_APPOINTMENT_INVALID');
  return {
    towerUrl: string(raw['towerUrl'], 'VAULT_RECOVERY_RECEIPT_URL_INVALID'), towerMode: raw['towerMode'],
    height: integer(raw['height'], 'VAULT_RECOVERY_RECEIPT_HEIGHT_INVALID'), bundleHash: string(raw['bundleHash'], 'VAULT_RECOVERY_RECEIPT_HASH_INVALID'),
    sequence: integer(raw['sequence'], 'VAULT_RECOVERY_RECEIPT_SEQUENCE_INVALID'), receivedAt: integer(raw['receivedAt'], 'VAULT_RECOVERY_RECEIPT_TIME_INVALID'),
    ...optionalRecoveryNumbers(raw), ...(decodedAppointmentSequence === undefined ? {} : { appointmentSequence: decodedAppointmentSequence }),
  };
};

const optionalRecoveryNumbers = (raw: RecordValue): Partial<RuntimeRecoveryTowerReceiptSummary> => ({
  ...(raw['slot'] === undefined ? {} : { slot: integer(raw['slot'], 'VAULT_RECOVERY_RECEIPT_SLOT_INVALID') }),
  ...(raw['storedBytes'] === undefined ? {} : { storedBytes: integer(raw['storedBytes'], 'VAULT_RECOVERY_RECEIPT_STORED_BYTES_INVALID') }),
  ...(raw['maxStoredBytes'] === undefined ? {} : { maxStoredBytes: integer(raw['maxStoredBytes'], 'VAULT_RECOVERY_RECEIPT_MAX_BYTES_INVALID') }),
  ...(raw['expiresAt'] === undefined ? {} : { expiresAt: integer(raw['expiresAt'], 'VAULT_RECOVERY_RECEIPT_EXPIRES_INVALID') }),
});

const decodeTowerFailure = (value: unknown): RuntimeRecoveryTowerFailureSummary => {
  const raw = record(value, 'VAULT_RECOVERY_FAILURE_INVALID');
  exactKeys(raw, ['towerUrl', 'towerMode', 'checkedAt', 'error'], 'VAULT_RECOVERY_FAILURE_KEYS_INVALID');
  if (raw['towerMode'] !== 'blind_backup' && raw['towerMode'] !== 'delayed_last_resort') throw new Error('VAULT_RECOVERY_FAILURE_MODE_INVALID');
  return { towerUrl: string(raw['towerUrl'], 'VAULT_RECOVERY_FAILURE_URL_INVALID'), towerMode: raw['towerMode'], checkedAt: integer(raw['checkedAt'], 'VAULT_RECOVERY_FAILURE_TIME_INVALID'), error: string(raw['error'], 'VAULT_RECOVERY_FAILURE_ERROR_INVALID') };
};

const decodeRecovery = (value: unknown): RuntimeRecoveryConfig => {
  const raw = record(value, 'VAULT_RECOVERY_INVALID');
  exactKeys(raw, ['towers', 'useDefaultTowers', 'waitForTowerReceipts', 'minSuccessfulTowers', 'maxStoredBytes', 'lastKnownStoredBytes', 'lastQuotaWarningAt', 'lastTowerUploadAttemptAt', 'lastTowerUploadAttemptHeight', 'lastTowerReceipts', 'lastTowerFailures'], 'VAULT_RECOVERY_KEYS_INVALID');
  const towers = raw['towers']; const receipts = raw['lastTowerReceipts']; const failures = raw['lastTowerFailures'];
  if (towers !== undefined && !Array.isArray(towers)) throw new Error('VAULT_RECOVERY_TOWERS_INVALID');
  if (receipts !== undefined && !Array.isArray(receipts)) throw new Error('VAULT_RECOVERY_RECEIPTS_INVALID');
  if (failures !== undefined && !Array.isArray(failures)) throw new Error('VAULT_RECOVERY_FAILURES_INVALID');
  return {
    ...(towers === undefined ? {} : { towers: towers.map(decodeTower) }),
    ...(receipts === undefined ? {} : { lastTowerReceipts: receipts.map(decodeTowerReceipt) }),
    ...(failures === undefined ? {} : { lastTowerFailures: failures.map(decodeTowerFailure) }),
    ...decodeRecoveryScalars(raw),
  };
};

const decodeRecoveryScalars = (raw: RecordValue): RuntimeRecoveryConfig => ({
  ...(raw['useDefaultTowers'] === undefined ? {} : { useDefaultTowers: boolean(raw['useDefaultTowers'], 'VAULT_RECOVERY_DEFAULT_TOWERS_INVALID') }),
  ...(raw['waitForTowerReceipts'] === undefined ? {} : { waitForTowerReceipts: boolean(raw['waitForTowerReceipts'], 'VAULT_RECOVERY_WAIT_INVALID') }),
  ...Object.fromEntries(['minSuccessfulTowers', 'maxStoredBytes', 'lastKnownStoredBytes', 'lastQuotaWarningAt', 'lastTowerUploadAttemptAt', 'lastTowerUploadAttemptHeight'].flatMap(key => raw[key] === undefined ? [] : [[key, optionalInteger(raw[key], `VAULT_RECOVERY_${key.toUpperCase()}_INVALID`)]])),
});

export const decodePersistedRuntime = (value: unknown, persistedKey: string): Runtime => {
  const raw = record(value, 'VAULT_STORAGE_RUNTIME_INVALID');
  exactKeys(raw, ['id', 'label', 'protectedSecrets', 'signers', 'activeSignerIndex', 'loginType', 'requiresOnboarding', 'recovery', 'createdAt'], 'VAULT_STORAGE_RUNTIME_KEYS_INVALID');
  if (!Array.isArray(raw['signers'])) throw new Error('VAULT_STORAGE_SIGNERS_INVALID');
  const loginType = raw['loginType'];
  if (loginType !== undefined && loginType !== 'manual' && loginType !== 'demo') throw new Error('VAULT_STORAGE_LOGIN_TYPE_INVALID');
  const id = normalizeRuntimeId(string(raw['id'], 'VAULT_STORAGE_RUNTIME_ID_INVALID'));
  const canonicalPersistedKey = normalizeRuntimeId(persistedKey);
  if (!id || !canonicalPersistedKey || persistedKey !== canonicalPersistedKey || id !== canonicalPersistedKey) {
    throw new Error(`VAULT_STORAGE_RUNTIME_ID_KEY_MISMATCH:${persistedKey}:${String(raw['id'])}`);
  }
  const signers = raw['signers'].map(decodeSigner);
  const activeSignerIndex = integer(raw['activeSignerIndex'], 'VAULT_STORAGE_ACTIVE_SIGNER_INVALID');
  if (activeSignerIndex >= signers.length) throw new Error('VAULT_STORAGE_ACTIVE_SIGNER_OUT_OF_RANGE');
  return {
    id, label: string(raw['label'], 'VAULT_STORAGE_LABEL_INVALID'), seed: '',
    signers, activeSignerIndex,
    createdAt: integer(raw['createdAt'], 'VAULT_STORAGE_CREATED_AT_INVALID'),
    ...(raw['protectedSecrets'] === undefined ? {} : { protectedSecrets: decodeProtectedVaultSecrets(raw['protectedSecrets']) }),
    ...(loginType === undefined ? {} : { loginType }),
    ...(raw['requiresOnboarding'] === undefined ? {} : { requiresOnboarding: boolean(raw['requiresOnboarding'], 'VAULT_STORAGE_ONBOARDING_INVALID') }),
    ...(raw['recovery'] === undefined ? {} : { recovery: decodeRecovery(raw['recovery']) }),
  };
};

export const decodePersistedVaultState = (value: unknown): RuntimesState => {
  const raw = record(value, 'VAULT_STORAGE_ROOT_INVALID');
  exactKeys(raw, ['activeRuntimeId', 'runtimes'], 'VAULT_STORAGE_ROOT_KEYS_INVALID');
  const rawRuntimes = record(raw['runtimes'], 'VAULT_STORAGE_RUNTIMES_INVALID');
  const runtimes: Record<string, Runtime> = {};
  for (const [persistedKey, encodedRuntime] of Object.entries(rawRuntimes)) {
    const runtime = decodePersistedRuntime(encodedRuntime, persistedKey);
    if (Object.hasOwn(runtimes, runtime.id)) {
      throw new Error(`VAULT_STORAGE_DUPLICATE_RUNTIME_ID:${runtime.id}`);
    }
    runtimes[runtime.id] = runtime;
  }

  const activeRuntimeId = raw['activeRuntimeId'];
  if (Object.keys(runtimes).length === 0) {
    if (activeRuntimeId !== null) throw new Error('VAULT_STORAGE_ACTIVE_RUNTIME_INVALID');
    return { runtimes, activeRuntimeId: null };
  }
  if (typeof activeRuntimeId !== 'string') throw new Error('VAULT_STORAGE_ACTIVE_RUNTIME_INVALID');
  const normalizedActiveRuntimeId = normalizeRuntimeId(activeRuntimeId);
  if (
    !normalizedActiveRuntimeId
    || activeRuntimeId !== normalizedActiveRuntimeId
    || !Object.hasOwn(runtimes, normalizedActiveRuntimeId)
  ) {
    throw new Error(`VAULT_STORAGE_ACTIVE_RUNTIME_INVALID:${activeRuntimeId}`);
  }
  return { runtimes, activeRuntimeId: normalizedActiveRuntimeId };
};
