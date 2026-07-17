import type { FrameLogEntry, RuntimeInput } from '../types';

const LOG_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error']);
const LOG_CATEGORIES = new Set([
  'consensus',
  'account',
  'jurisdiction',
  'evm',
  'network',
  'ui',
  'system',
]);

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

const validateRuntimeInputEntry = (value: unknown, code: string): void => {
  const entry = requireBoundaryRecord(value, code);
  if (typeof entry['type'] !== 'string' || entry['type'].trim().length === 0) throw new Error(code);
};

const validateEntityInputEntry = (value: unknown, code: string): void => {
  const entry = requireBoundaryRecord(value, code);
  if (typeof entry['entityId'] !== 'string' || entry['entityId'].trim().length === 0) throw new Error(code);
};

export const validateRuntimeInputEnvelope = (
  value: unknown,
  context: string,
): RuntimeInput => {
  const input = requireBoundaryRecord(value, `${context}_INVALID`);
  requireExactBoundaryKeys(
    input,
    ['runtimeTxs', 'entityInputs'],
    ['jInputs', 'reliableReceipts', 'timestamp', 'queuedAt'],
    `${context}_FIELDS_INVALID`,
  );
  if (!Array.isArray(input['runtimeTxs']) || !Array.isArray(input['entityInputs'])) {
    throw new Error(`${context}_INVALID`);
  }
  input['runtimeTxs'].forEach((entry, index) =>
    validateRuntimeInputEntry(entry, `${context}_RUNTIME_TX_INVALID:index=${index}`));
  input['entityInputs'].forEach((entry, index) =>
    validateEntityInputEntry(entry, `${context}_ENTITY_INPUT_INVALID:index=${index}`));
  if (input['jInputs'] !== undefined) {
    if (!Array.isArray(input['jInputs'])) throw new Error(`${context}_J_INPUTS_INVALID`);
    input['jInputs'].forEach((entry, index) => {
      const jInput = requireBoundaryRecord(entry, `${context}_J_INPUT_INVALID:index=${index}`);
      requireExactBoundaryKeys(
        jInput,
        ['jurisdictionName', 'jTxs'],
        [],
        `${context}_J_INPUT_FIELDS_INVALID:index=${index}`,
      );
      if (typeof jInput['jurisdictionName'] !== 'string' || !Array.isArray(jInput['jTxs'])) {
        throw new Error(`${context}_J_INPUT_INVALID:index=${index}`);
      }
    });
  }
  if (input['reliableReceipts'] !== undefined && !Array.isArray(input['reliableReceipts'])) {
    throw new Error(`${context}_RELIABLE_RECEIPTS_INVALID`);
  }
  if (input['timestamp'] !== undefined) requireBoundaryInteger(input['timestamp'], `${context}_TIMESTAMP_INVALID`);
  if (input['queuedAt'] !== undefined) requireBoundaryInteger(input['queuedAt'], `${context}_QUEUED_AT_INVALID`);
  return input as unknown as RuntimeInput;
};

export const validateFrameLogEntries = (value: unknown, invalidCode: string): FrameLogEntry[] => {
  if (!Array.isArray(value)) throw new Error(invalidCode);
  return value.map((entry, index) => {
    const code = `${invalidCode}:entry=${index}`;
    const log = requireBoundaryRecord(entry, code);
    requireExactBoundaryKeys(log, ['id', 'timestamp', 'level', 'category', 'message'], ['entityId', 'data'], code);
    requireBoundaryInteger(log['id'], code, 0);
    requireBoundaryInteger(log['timestamp'], code, 0);
    if (!LOG_LEVELS.has(String(log['level'])) || !LOG_CATEGORIES.has(String(log['category']))) throw new Error(code);
    if (typeof log['message'] !== 'string') throw new Error(code);
    if (log['entityId'] !== undefined && typeof log['entityId'] !== 'string') throw new Error(code);
    if (log['data'] !== undefined) requireBoundaryRecord(log['data'], code);
    return log as unknown as FrameLogEntry;
  });
};
