import type { RuntimeOverlayRecord } from '../types';

export const normalizeOverlayEntityId = (value: string): string =>
  String(value || '').toLowerCase();

export const storageOverlayRecordKey = (record: RuntimeOverlayRecord): string => {
  if (record.family === 'entity') return `e:${normalizeOverlayEntityId(record.entityId)}`;
  if (record.family === 'account') {
    return `a:${normalizeOverlayEntityId(record.entityId)}:${normalizeOverlayEntityId(record.counterpartyId)}`;
  }
  return `b:${normalizeOverlayEntityId(record.entityId)}:${String(record.pairId || '').trim()}`;
};

export const mergeStorageOverlayRecords = (
  base: readonly RuntimeOverlayRecord[] | undefined,
  extra: readonly RuntimeOverlayRecord[] | undefined,
): RuntimeOverlayRecord[] => {
  const byKey = new Map<string, RuntimeOverlayRecord>();
  for (const record of base ?? []) {
    byKey.set(storageOverlayRecordKey(record), { ...record });
  }
  for (const record of extra ?? []) {
    byKey.set(storageOverlayRecordKey(record), { ...record });
  }
  return Array.from(byKey.values());
};
