import { isUnknownRecord as isRecord, parseJsonUnknown } from '#lib/utils/boundary/index.ts';
import type { PushWakeRegistrationRecord } from './pushWakeTypes';
import { normalizeRuntimeId, normalizeEntityId, normalizeTowerUrl, normalizeTokenHash, normalizePlatform, normalizeChainId, normalizeAddress, normalizeHttpUrl } from './pushWakeBoundary';
const PUSH_WAKE_RECORDS_KEY = 'xln-push-wake-registrations-v1';
const readAllRecords = (): PushWakeRegistrationRecord[] => {
  if (typeof localStorage === 'undefined') return [];
  const raw = localStorage.getItem(PUSH_WAKE_RECORDS_KEY);
  if (!raw) return [];
  const parsed = parseJsonUnknown(raw, 'PUSH_WAKE_RECORDS_JSON_INVALID');
  if (!Array.isArray(parsed)) return [];
  const records: PushWakeRegistrationRecord[] = [];
  for (const candidate of parsed) {
    try {
      if (!isRecord(candidate)) continue;
      records.push({
        runtimeId: normalizeRuntimeId(candidate['runtimeId']),
        entityId: normalizeEntityId(candidate['entityId']),
        towerUrl: normalizeTowerUrl(candidate['towerUrl']),
        tokenHash: normalizeTokenHash(candidate['tokenHash']),
        platform: normalizePlatform(candidate['platform'], 'web'),
        chainId: normalizeChainId(candidate['chainId']),
        depositoryAddress: normalizeAddress(candidate['depositoryAddress'], 'PUSH_DEPOSITORY'),
        rpcUrl: normalizeHttpUrl(candidate['rpcUrl'], 'PUSH_RPC_URL'),
        updatedAt: Math.max(0, Math.floor(Number(candidate['updatedAt'] || 0))),
      });
    } catch {
      // Ignore malformed local status entries; server registrations remain authoritative.
    }
  }
  return records;
};

const writeAllRecords = (records: PushWakeRegistrationRecord[]): void => {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(PUSH_WAKE_RECORDS_KEY, JSON.stringify(records));
};

export const readPushWakeRegistrationRecords = (runtimeId?: string, entityId?: string): PushWakeRegistrationRecord[] => {
  const records = readAllRecords();
  const normalizedRuntimeId = runtimeId ? normalizeRuntimeId(runtimeId) : '';
  const normalizedEntityId = entityId ? normalizeEntityId(entityId) : '';
  return records.filter((record) =>
    (!normalizedRuntimeId || record.runtimeId === normalizedRuntimeId)
    && (!normalizedEntityId || record.entityId === normalizedEntityId),
  );
};

export const upsertPushWakeRegistrationRecord = (record: PushWakeRegistrationRecord): PushWakeRegistrationRecord[] => {
  const normalized: PushWakeRegistrationRecord = {
    runtimeId: normalizeRuntimeId(record.runtimeId),
    entityId: normalizeEntityId(record.entityId),
    towerUrl: normalizeTowerUrl(record.towerUrl),
    tokenHash: normalizeTokenHash(record.tokenHash),
    platform: normalizePlatform(record.platform, 'web'),
    chainId: normalizeChainId(record.chainId),
    depositoryAddress: normalizeAddress(record.depositoryAddress, 'PUSH_DEPOSITORY'),
    rpcUrl: normalizeHttpUrl(record.rpcUrl, 'PUSH_RPC_URL'),
    updatedAt: Math.max(0, Math.floor(Number(record.updatedAt || Date.now()))),
  };
  const next = readAllRecords()
    .filter((entry) => !(
      entry.runtimeId === normalized.runtimeId
      && entry.entityId === normalized.entityId
      && entry.towerUrl === normalized.towerUrl
      && entry.tokenHash === normalized.tokenHash
    ));
  next.push(normalized);
  writeAllRecords(next);
  return next;
};

export const removePushWakeRegistrationRecord = (record: Pick<PushWakeRegistrationRecord, 'runtimeId' | 'entityId' | 'towerUrl' | 'tokenHash'>): PushWakeRegistrationRecord[] => {
  const runtimeId = normalizeRuntimeId(record.runtimeId);
  const entityId = normalizeEntityId(record.entityId);
  const towerUrl = normalizeTowerUrl(record.towerUrl);
  const tokenHash = normalizeTokenHash(record.tokenHash);
  const next = readAllRecords().filter((entry) => !(
    entry.runtimeId === runtimeId
    && entry.entityId === entityId
    && entry.towerUrl === towerUrl
    && entry.tokenHash === tokenHash
  ));
  writeAllRecords(next);
  return next;
};
