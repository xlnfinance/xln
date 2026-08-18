/**
 * Browser persistence and HTTP are untrusted input boundaries.  Parse only to
 * unknown here; each caller owns the exact decoder for its protocol payload.
 */
export const isUnknownRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const requireUnknownRecord = (value: unknown, code: string): Record<string, unknown> => {
  if (!isUnknownRecord(value)) throw new Error(code);
  return value;
};

export const rejectExtraKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  code: string,
): void => {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(code);
};

export const hasOnlyAllowedKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));

/** Throws unless every `required` key is present and no key falls outside `required` + `optional`. */
export const requireExactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  code: string,
): void => {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(code);
  }
};

export const optionalString = (value: unknown, code: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(code);
  return value;
};

export const optionalBoolean = (value: unknown, code: string): boolean | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(code);
  return value;
};

export const optionalFiniteNumber = (value: unknown, code: string): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(code);
  return value;
};

export const requireString = (value: unknown, code: string): string => {
  if (typeof value !== 'string') throw new Error(code);
  return value;
};

export const requireBoolean = (value: unknown, code: string): boolean => {
  if (typeof value !== 'boolean') throw new Error(code);
  return value;
};

export const requireFiniteNumber = (value: unknown, code: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(code);
  return value;
};

export const parseJsonUnknown = (serialized: string, code: string): unknown => {
  try {
    return JSON.parse(serialized) as unknown;
  } catch {
    throw new Error(code);
  }
};

export const readJsonUnknown = async (response: Response): Promise<unknown> => await response.json();
