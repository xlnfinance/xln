import { createHash } from 'node:crypto';

type JsonLike = null | boolean | number | string | JsonLike[] | { [key: string]: JsonLike };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sortJson = (value: unknown): JsonLike => {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) {
    if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value;
    return String(value ?? '');
  }

  const result: Record<string, JsonLike> = {};
  for (const key of Object.keys(value).sort()) {
    if (key === 'deployVersion' || key === 'networkVersion' || key === 'lastUpdated') continue;
    result[key] = sortJson(value[key]);
  }
  return result;
};

export const computeJurisdictionsNetworkVersion = (
  payload: unknown,
  fallbackVersion = '1',
): string => {
  const version = isRecord(payload) ? String(payload['version'] || '').trim() || fallbackVersion : fallbackVersion;
  const canonical = JSON.stringify(sortJson(payload));
  const digest = createHash('sha256').update(canonical).digest('hex').slice(0, 12);
  return `v${version}-${digest}`;
};
