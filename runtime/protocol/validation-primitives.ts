import { safeStringify } from './serialization';

export class FinancialDataCorruptionError extends Error {
  constructor(message: string, context?: Record<string, unknown>) {
    super(`🚨 FINANCIAL-SAFETY VIOLATION: ${message}`);
    this.name = 'FinancialDataCorruptionError';
    if (!context) return;
    try {
      this.message += `\nContext: ${safeStringify(context)}`;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.message += `\nContext: [Unserializable: ${detail}]`;
    }
  }
}

export class TypeSafetyViolationError extends Error {
  constructor(message: string, value?: unknown) {
    super(`🛡️ TYPE-SAFETY VIOLATION: ${message}`);
    this.name = 'TypeSafetyViolationError';
    if (value !== undefined) {
      this.message += `\nReceived: ${typeof value} = ${String(value)}`;
    }
  }
}

export const validateString = (value: unknown, fieldName: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeSafetyViolationError(`${fieldName} must be a non-empty string`, value);
  }
  return value;
};

export const validateNumber = (value: unknown, fieldName: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeSafetyViolationError(`${fieldName} must be a finite number`, value);
  }
  return value;
};

export const validateObject = (
  value: unknown,
  fieldName: string,
): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeSafetyViolationError(`${fieldName} must be a non-null object`, value);
  }
  return value as Record<string, unknown>;
};

export const validateArray = <T>(value: unknown, fieldName: string): T[] => {
  if (!Array.isArray(value)) {
    throw new TypeSafetyViolationError(`${fieldName} must be an array`, value);
  }
  return value;
};

export const validateMapInstance = (
  value: unknown,
  fieldName: string,
): Map<unknown, unknown> => {
  if (!(value instanceof Map)) {
    throw new TypeSafetyViolationError(`${fieldName} must be a Map`, value);
  }
  return value;
};

export const safeMapGet = <K, V>(
  map: Map<K, V>,
  key: K,
  context: string,
): V => {
  const value = map.get(key);
  if (value === undefined) {
    throw new Error(`FINANCIAL-SAFETY: ${context} not found for key: ${key}`);
  }
  return value;
};

export const safeArrayGet = <T>(
  array: T[],
  index: number,
  context: string,
): T => {
  if (index < 0 || index >= array.length) {
    throw new TypeSafetyViolationError(
      `Array index out of bounds in ${context}`,
      { index, length: array.length },
    );
  }
  return array[index]!;
};
