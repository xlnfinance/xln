import { createHash } from 'node:crypto';

type JsonPrimitive = string | number | boolean | null;
export type CanonicalJson = JsonPrimitive | readonly CanonicalJson[] | { readonly [key: string]: CanonicalJson };

const normalizeCanonicalJson = (value: unknown): CanonicalJson => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(normalizeCanonicalJson);
  if (typeof value !== 'object') throw new Error(`CANONICAL_JSON_VALUE_INVALID:${typeof value}`);

  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort((left, right) => left.localeCompare(right))
      .map(key => [key, normalizeCanonicalJson(record[key])]),
  );
};

export const canonicalJson = (value: unknown): string =>
  JSON.stringify(normalizeCanonicalJson(value));

export const prettyCanonicalJson = (value: unknown): string =>
  `${JSON.stringify(normalizeCanonicalJson(value), null, 2)}\n`;

export const sha256Text = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
