import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../protocol/boundary-validation';

export { requireBoundaryInteger, requireBoundaryRecord, requireExactBoundaryKeys };

export const requireStorageString = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(code);
  return value;
};

export const requireStorageHash = (value: unknown, code: string): string => {
  const hash = requireStorageString(value, code);
  if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error(code);
  return hash;
};

export const requireStorageHex = (value: unknown, code: string): string => {
  const hex = requireStorageString(value, code);
  if (!/^0x(?:[0-9a-f]{2})+$/.test(hex)) throw new Error(code);
  return hex;
};

export const requireStorageBigInt = (
  value: unknown,
  code: string,
  minimum = 0n,
): bigint => {
  if (typeof value !== 'bigint' || value < minimum) throw new Error(code);
  return value;
};

export const requireStorageArray = <T = unknown>(value: unknown, code: string): T[] => {
  if (!Array.isArray(value)) throw new Error(code);
  return value as T[];
};

export const requireStorageMap = <K = unknown, V = unknown>(
  value: unknown,
  code: string,
): Map<K, V> => {
  if (!(value instanceof Map)) throw new Error(code);
  return value as Map<K, V>;
};

export const requireStorageBoolean = (value: unknown, code: string): boolean => {
  if (typeof value !== 'boolean') throw new Error(code);
  return value;
};

export const requireStoragePath = (
  value: unknown,
  radix: 16 | 256,
  code: string,
): number[] => requireStorageArray(value, code).map((slot) => {
  if (!Number.isSafeInteger(slot) || Number(slot) < 0 || Number(slot) >= radix) throw new Error(code);
  return Number(slot);
});

export const requireStringArray = (value: unknown, code: string): string[] =>
  requireStorageArray(value, code).map(entry => requireStorageString(entry, code));

export const requireStorageRadix = (value: unknown, code: string): 16 | 256 => {
  if (value !== 16 && value !== 256) throw new Error(code);
  return value;
};
