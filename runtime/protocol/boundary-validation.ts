import type { FrameLogEntry, LogCategory, LogLevel } from '../types/logging';

const isLogLevel = (value: unknown): value is LogLevel => {
  switch (value) {
    case 'trace':
    case 'debug':
    case 'info':
    case 'warn':
    case 'error':
      return true;
    default:
      return false;
  }
};

const isLogCategory = (value: unknown): value is LogCategory => {
  switch (value) {
    case 'consensus':
    case 'account':
    case 'jurisdiction':
    case 'evm':
    case 'network':
    case 'ui':
    case 'system':
      return true;
    default:
      return false;
  }
};

export const requireBoundaryRecord = (
  value: unknown,
  code: string,
): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Map) {
    throw new Error(code);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(code);
  return value as Record<string, unknown>;
};

export const requireExactBoundaryKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  code: string,
): void => {
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter(key => !Object.hasOwn(value, key));
  const extra = Object.keys(value).filter(key => !allowed.has(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`${code}:missing=${missing.join(',') || 'none'}:extra=${extra.join(',') || 'none'}`);
  }
};

export const requireBoundaryInteger = (
  value: unknown,
  code: string,
  minimum = 0,
): number => {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`${code}:${String(value)}`);
  }
  return Number(value);
};

export const validateFrameLogEntries = (value: unknown, invalidCode: string): FrameLogEntry[] => {
  if (!Array.isArray(value)) throw new Error(invalidCode);
  return value.map((entry, index) => {
    const code = `${invalidCode}:entry=${index}`;
    const log = requireBoundaryRecord(entry, code);
    requireExactBoundaryKeys(log, ['id', 'timestamp', 'level', 'category', 'message'], ['entityId', 'data'], code);
    const id = requireBoundaryInteger(log['id'], code, 0);
    const timestamp = requireBoundaryInteger(log['timestamp'], code, 0);
    const level = log['level'];
    const category = log['category'];
    const message = log['message'];
    const entityId = log['entityId'];
    const data = log['data'];
    if (!isLogLevel(level) || !isLogCategory(category) || typeof message !== 'string') {
      throw new Error(code);
    }
    if (entityId !== undefined && typeof entityId !== 'string') throw new Error(code);
    const decodedData = data === undefined ? undefined : requireBoundaryRecord(data, code);
    return {
      id,
      timestamp,
      level,
      category,
      message,
      ...(entityId === undefined ? {} : { entityId }),
      ...(decodedData === undefined ? {} : { data: decodedData }),
    };
  });
};
