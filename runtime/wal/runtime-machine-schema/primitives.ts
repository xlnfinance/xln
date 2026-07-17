import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../protocol/boundary-validation';

export { requireBoundaryInteger, requireBoundaryRecord, requireExactBoundaryKeys };

export const requireString = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(code);
  return value;
};

export const requireBoolean = (value: unknown, code: string): boolean => {
  if (typeof value !== 'boolean') throw new Error(code);
  return value;
};

export const requireFiniteNumber = (
  value: unknown,
  code: string,
  minimum?: number,
): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || (minimum !== undefined && value < minimum)) {
    throw new Error(code);
  }
  return value;
};

export const requireBigInt = (
  value: unknown,
  code: string,
  minimum?: bigint,
): bigint => {
  if (typeof value !== 'bigint' || (minimum !== undefined && value < minimum)) throw new Error(code);
  return value;
};

export const requireBytes = (value: unknown, code: string, length?: number): Uint8Array => {
  if (!(value instanceof Uint8Array) || (length !== undefined && value.byteLength !== length)) throw new Error(code);
  return value;
};

export const requireArray = (value: unknown, code: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(code);
  return value;
};

export const requireMap = (value: unknown, code: string): Map<unknown, unknown> => {
  if (!(value instanceof Map)) throw new Error(code);
  return value;
};

export const requireSet = (value: unknown, code: string): Set<unknown> => {
  if (!(value instanceof Set)) throw new Error(code);
  return value;
};

export const requireStringArray = (value: unknown, code: string): string[] =>
  requireArray(value, code).map((entry, index) => requireString(entry, `${code}_${index}`));

export const validateStringMap = (
  value: unknown,
  code: string,
  validateValue: (entry: unknown, code: string) => void,
): void => {
  for (const [key, entry] of requireMap(value, code)) {
    const normalizedKey = requireString(key, `${code}_KEY`);
    validateValue(entry, `${code}_${normalizedKey}`);
  }
};

export const validateStorageSafeValue = (
  value: unknown,
  code: string,
  ancestors: object[] = [],
): void => {
  if (
    value === null || value === undefined ||
    typeof value === 'string' || typeof value === 'boolean' || typeof value === 'bigint'
  ) return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(code);
    return;
  }
  if (typeof value !== 'object' || typeof value === 'function' || typeof value === 'symbol') throw new Error(code);
  if (value instanceof Uint8Array) return;
  if (ancestors.includes(value)) throw new Error(`${code}_CYCLE`);
  const nextAncestors = [...ancestors, value];
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateStorageSafeValue(entry, `${code}_${index}`, nextAncestors));
    return;
  }
  if (value instanceof Map) {
    for (const [key, entry] of value) {
      validateStorageSafeValue(key, `${code}_MAP_KEY`, nextAncestors);
      validateStorageSafeValue(entry, `${code}_MAP_VALUE`, nextAncestors);
    }
    return;
  }
  if (value instanceof Set) {
    for (const entry of value) validateStorageSafeValue(entry, `${code}_SET_VALUE`, nextAncestors);
    return;
  }
  const record = requireBoundaryRecord(value, code);
  for (const [key, entry] of Object.entries(record)) {
    validateStorageSafeValue(entry, `${code}_${key}`, nextAncestors);
  }
};
