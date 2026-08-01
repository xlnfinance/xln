import { TOKENS, UINT16_MAX } from '../config/constants';
import { requireBoundaryInteger } from '../protocol/boundary-validation';
import {
  FinancialDataCorruptionError,
  validateArray,
  validateMapInstance,
  validateObject,
  validateString,
} from '../protocol/validation-primitives';

export const UINT256_MAX = (1n << 256n) - 1n;
export const INT256_MIN = -(1n << 255n);
export const INT256_MAX = (1n << 255n) - 1n;

const fail = (context: string, message: string): never => {
  throw new FinancialDataCorruptionError(`${context} ${message}`);
};

export const persistedRecord = (
  value: unknown,
  context: string,
): Record<string, unknown> => validateObject(value, context);

export const persistedArray = (
  value: unknown,
  context: string,
  maximum = Number.MAX_SAFE_INTEGER,
): unknown[] => {
  const array = validateArray(value, context);
  if (array.length > maximum) fail(context, `exceeds ${maximum} entries`);
  return array;
};

export const persistedMap = (
  value: unknown,
  context: string,
  maximum = Number.MAX_SAFE_INTEGER,
): Map<unknown, unknown> => {
  const map = validateMapInstance(value, context);
  if (map.size > maximum) fail(context, `exceeds ${maximum} entries`);
  return map;
};

export const persistedString = (
  value: unknown,
  context: string,
  maximum = Number.MAX_SAFE_INTEGER,
): string => {
  const text = validateString(value, context);
  if (!text || text.length > maximum) fail(context, `must contain 1..${maximum} characters`);
  return text;
};

export const persistedBoolean = (value: unknown, context: string): boolean => {
  if (typeof value !== 'boolean') fail(context, 'must be boolean');
  return value as boolean;
};

export const persistedUint = (
  value: unknown,
  context: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number => {
  const integer = requireBoundaryInteger(value, context);
  if (integer > maximum) fail(context, `must be <= ${maximum}`);
  return integer;
};

export const persistedTokenId = (value: unknown, context: string): number =>
  persistedUint(value, context, TOKENS.MAX_TOKEN_ID);

export const persistedBigInt = (
  value: unknown,
  context: string,
  minimum: bigint,
  maximum: bigint,
): bigint => {
  if (typeof value !== 'bigint' || value < minimum || value > maximum) {
    fail(context, `must be bigint in [${minimum},${maximum}]`);
  }
  return value as bigint;
};

export const persistedUint256 = (value: unknown, context: string): bigint =>
  persistedBigInt(value, context, 0n, UINT256_MAX);

export const persistedInt256 = (value: unknown, context: string): bigint =>
  persistedBigInt(value, context, INT256_MIN, INT256_MAX);

const canonicalHex = (value: unknown, context: string, bytes?: number): string => {
  const text = persistedString(value, context);
  const width = bytes === undefined ? '(?:[0-9a-f]{2})*' : `[0-9a-f]{${bytes * 2}}`;
  if (!new RegExp(`^0x${width}$`).test(text)) fail(context, 'must be canonical lowercase hex');
  return text;
};

export const persistedBytes32 = (value: unknown, context: string): string =>
  canonicalHex(value, context, 32);

export const persistedAddress = (value: unknown, context: string): string =>
  canonicalHex(value, context, 20);

export const persistedHex = (value: unknown, context: string): string =>
  canonicalHex(value, context);

export const persistedUint16 = (value: unknown, context: string): number =>
  persistedUint(value, context, UINT16_MAX);

export const persistedOptional = (
  value: unknown,
  validate: (present: unknown) => void,
): void => {
  if (value !== undefined) validate(value);
};
