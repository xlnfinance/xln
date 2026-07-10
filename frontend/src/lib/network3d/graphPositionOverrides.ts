import type { RuntimeGraphPosition } from './runtimeGraphProjection';

export const GRAPH_POSITION_OVERRIDES_KEY = 'xln-graph-position-overrides-v2';

const normalizePosition = (value: unknown): RuntimeGraphPosition | null => {
  const candidate = value as Partial<RuntimeGraphPosition> | null;
  const x = Number(candidate?.x);
  const y = Number(candidate?.y);
  const z = Number(candidate?.z);
  if (![x, y, z].every(Number.isFinite)) return null;
  const jurisdiction = String(candidate?.jurisdiction || '').trim();
  return { x, y, z, ...(jurisdiction ? { jurisdiction } : {}) };
};

export const readGraphPositionOverrides = (storage: Storage | null): Map<string, RuntimeGraphPosition> => {
  if (!storage) return new Map();
  const raw = storage.getItem(GRAPH_POSITION_OVERRIDES_KEY);
  if (!raw) return new Map();
  const parsed = JSON.parse(raw) as Record<string, unknown>;
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

export const clearGraphPositionOverrides = (storage: Storage | null): void => {
  storage?.removeItem(GRAPH_POSITION_OVERRIDES_KEY);
};
