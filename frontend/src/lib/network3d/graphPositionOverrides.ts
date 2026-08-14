import type { RuntimeGraphPosition } from './runtimeGraphProjection';
import { isUnknownRecord, parseJsonUnknown } from '$lib/utils/boundary';

export const GRAPH_POSITION_OVERRIDES_KEY = 'xln-graph-position-overrides-v1';

const normalizePosition = (value: unknown): RuntimeGraphPosition | null => {
  if (!isUnknownRecord(value)) return null;
  const x = Number(value['x']);
  const y = Number(value['y']);
  const z = Number(value['z']);
  if (![x, y, z].every(Number.isFinite)) return null;
  if (value['jurisdiction'] !== undefined && typeof value['jurisdiction'] !== 'string') return null;
  const jurisdiction = String(value['jurisdiction'] || '').trim();
  return { x, y, z, ...(jurisdiction ? { jurisdiction } : {}) };
};

export const readGraphPositionOverrides = (storage: Storage | null): Map<string, RuntimeGraphPosition> => {
  if (!storage) return new Map();
  const raw = storage.getItem(GRAPH_POSITION_OVERRIDES_KEY);
  if (!raw) return new Map();
  const parsed = parseJsonUnknown(raw, 'GRAPH_POSITION_OVERRIDES_JSON_INVALID');
  if (!isUnknownRecord(parsed)) return new Map();
  const entries = Object.entries(parsed).flatMap(([entityId, value]) => {
    const position = normalizePosition(value);
    return position ? [[entityId.toLowerCase(), position] as const] : [];
  });
  return new Map(entries);
};

export const writeGraphPositionOverride = (
  storage: Storage | null,
  entityId: string,
  position: RuntimeGraphPosition,
): Map<string, RuntimeGraphPosition> => {
  const current = readGraphPositionOverrides(storage);
  const normalized = normalizePosition(position);
  const normalizedId = String(entityId || '').trim().toLowerCase();
  if (!normalizedId || !normalized) throw new Error('Graph position override requires a valid entityId and x/y/z');
  current.set(normalizedId, normalized);
  if (storage) storage.setItem(GRAPH_POSITION_OVERRIDES_KEY, JSON.stringify(Object.fromEntries(current)));
  return current;
};
