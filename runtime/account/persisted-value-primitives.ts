import {
  FinancialDataCorruptionError,
  validateMapInstance,
} from '../protocol/validation-primitives';
import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../protocol/boundary-validation';
import { TOKENS, UINT16_MAX } from '../config/constants';

const BYTES32 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const HEX = /^0x(?:[0-9a-f]{2})*$/;

export const UINT256_MAX = (1n << 256n) - 1n;
export const INT256_MIN = -(1n << 255n);
export const INT256_MAX = (1n << 255n) - 1n;

const corrupt = (context: string, message: string): never => {
  throw new FinancialDataCorruptionError(`${context} ${message}`);
};

export const persistedRecord = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  context: string,
): Record<string, unknown> => {
  let record: Record<string, unknown>;
  try {
    record = requireBoundaryRecord(value, context);
    requireExactBoundaryKeys(record, required, optional, `${context}.fields`);
  } catch (error) {
    corrupt(context, error instanceof Error ? error.message : String(error));
  }
  return record!;
};

export const persistedArray = (
  value: unknown,
  context: string,
  maximum = Number.MAX_SAFE_INTEGER,
): unknown[] => {
  if (!Array.isArray(value) || value.length > maximum) {
    corrupt(context, `must be an Array of at most ${maximum} entries`);
  }
  return value as unknown[];
};

export const persistedMap = (
  value: unknown,
  context: string,
  maximum = Number.MAX_SAFE_INTEGER,
): Map<unknown, unknown> => {
  let map: Map<unknown, unknown>;
  try {
    map = validateMapInstance(value, context);
  } catch (error) {
    corrupt(context, error instanceof Error ? error.message : String(error));
  }
  if (map!.size > maximum) corrupt(context, `exceeds ${maximum} entries`);
  return map!;
};

export const persistedString = (
  value: unknown,
  context: string,
  maximum = Number.MAX_SAFE_INTEGER,
): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    corrupt(context, `must be a non-empty string of at most ${maximum} characters`);
  }
  return value as string;
};

export const persistedEnum = <T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  context: string,
): T => {
  if (typeof value !== 'string' || !allowed.has(value as T)) {
    corrupt(context, `has invalid value ${String(value)}`);
  }
  return value as T;
};

export const persistedBoolean = (value: unknown, context: string): boolean => {
  if (typeof value !== 'boolean') corrupt(context, 'must be boolean');
  return value as boolean;
};

export const persistedUint = (
  value: unknown,
  context: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number => {
  const integer = requireBoundaryInteger(value, context);
  if (integer > maximum) corrupt(context, `must be <= ${maximum}`);
  return integer;
};

export const persistedUint16 = (value: unknown, context: string): number =>
  persistedUint(value, context, UINT16_MAX);

export const persistedTokenId = (value: unknown, context: string): number =>
  persistedUint(value, context, TOKENS.MAX_TOKEN_ID);

export const persistedBigInt = (
  value: unknown,
  context: string,
  minimum: bigint,
  maximum: bigint,
): bigint => {
  if (typeof value !== 'bigint' || value < minimum || value > maximum) {
    corrupt(context, `must be bigint in [${minimum},${maximum}]`);
  }
  return value as bigint;
};

export const persistedUint256 = (value: unknown, context: string): bigint =>
  persistedBigInt(value, context, 0n, UINT256_MAX);

export const persistedInt256 = (value: unknown, context: string): bigint =>
  persistedBigInt(value, context, INT256_MIN, INT256_MAX);

export const persistedBytes32 = (value: unknown, context: string): string => {
  const text = persistedString(value, context);
  if (!BYTES32.test(text)) corrupt(context, 'must be canonical lowercase bytes32');
  return text;
};

export const persistedAddress = (value: unknown, context: string): string => {
  const text = persistedString(value, context);
  if (!ADDRESS.test(text)) corrupt(context, 'must be canonical lowercase address');
  return text;
};

export const persistedHex = (value: unknown, context: string): string => {
  const text = persistedString(value, context);
  if (!HEX.test(text)) corrupt(context, 'must be canonical lowercase even-length hex');
  return text;
};

export const persistedOptional = (
  value: unknown,
  validate: (present: unknown) => void,
): void => {
  if (value !== undefined) validate(value);
};
