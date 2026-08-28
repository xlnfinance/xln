import { normalizeEntityIdForRuntimeView } from '../../../packages/runtime-client/src/runtime-view-model';

export const requireRuntimeRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}_INVALID`);
  }
  return value as Record<string, unknown>;
};

export const requireRuntimeString = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}_INVALID`);
  return value.trim();
};

export const optionalRuntimeString = (value: unknown, label: string): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  return requireRuntimeString(value, label);
};

export const requireRuntimeInteger = (
  value: unknown,
  label: string,
  minimum = 0,
): number => {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`${label}_INVALID`);
  return Number(value);
};

export const optionalRuntimeInteger = (
  value: unknown,
  fallback: number,
  label: string,
): number => value === undefined ? fallback : requireRuntimeInteger(value, label);

export const requireRuntimeBigInt = (value: unknown, label: string): bigint => {
  if (typeof value !== 'bigint') throw new Error(`${label}_INVALID`);
  return value;
};

export const requireRuntimeMap = (
  value: unknown,
  label: string,
): ReadonlyMap<unknown, unknown> => {
  if (!(value instanceof Map)) throw new Error(`${label}_INVALID`);
  return value;
};

export const optionalRuntimeMap = (
  value: unknown,
  label: string,
): ReadonlyMap<unknown, unknown> => value === undefined
  ? new Map<unknown, unknown>()
  : requireRuntimeMap(value, label);

export const normalizeRequiredRuntimeEntityId = (value: unknown, label: string): string => {
  const normalized = normalizeEntityIdForRuntimeView(requireRuntimeString(value, label));
  if (!normalized) throw new Error(`${label}_INVALID`);
  return normalized;
};

export const optionalRuntimeEntityId = (value: unknown, label: string): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  return normalizeRequiredRuntimeEntityId(value, label);
};

export const requireRuntimeEnum = <Value extends string>(
  value: unknown,
  allowed: readonly Value[],
  label: string,
): Value => {
  if (typeof value !== 'string' || !allowed.includes(value as Value)) {
    throw new Error(`${label}_INVALID`);
  }
  return value as Value;
};
