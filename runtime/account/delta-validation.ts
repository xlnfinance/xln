import type { Delta } from '../types';
import {
  TypeSafetyViolationError,
  validateObject,
} from '../protocol/validation-primitives';

const BIGINT_FIELDS = [
  'collateral',
  'ondelta',
  'offdelta',
  'leftCreditLimit',
  'rightCreditLimit',
  'leftAllowance',
  'rightAllowance',
  'leftHold',
  'rightHold',
] as const;

/** Decode one complete financial Delta. Missing capacity fields are corruption. */
export const validateDelta = (
  delta: unknown,
  source = 'unknown',
): Delta => {
  const value = validateObject(delta, `Delta from ${source}`);
  const errors: string[] = [];
  const tokenId = value['tokenId'];
  if (
    typeof tokenId !== 'number' ||
    !Number.isInteger(tokenId) ||
    tokenId < 0
  ) {
    errors.push(`tokenId must be non-negative integer, got: ${String(tokenId)}`);
  }
  for (const field of BIGINT_FIELDS) {
    const fieldValue = value[field];
    if (fieldValue === null || fieldValue === undefined) {
      errors.push(`${field} cannot be null/undefined, got: ${fieldValue}`);
      continue;
    }
    if (typeof fieldValue === 'bigint') continue;
    if (typeof fieldValue === 'string' && /^-?\d+n?$/.test(fieldValue)) {
      try {
        value[field] = BigInt(fieldValue.replace(/n$/, ''));
        continue;
      } catch {
        errors.push(`${field} invalid BigInt string: ${fieldValue}`);
        continue;
      }
    }
    errors.push(
      `${field} must be BigInt, got: ${typeof fieldValue} (${fieldValue})`,
    );
  }
  if (errors.length > 0) {
    throw new Error(
      `Delta validation failed from ${source}:\n${errors.join('\n')}`,
    );
  }
  return {
    tokenId: value['tokenId'] as number,
    collateral: value['collateral'] as bigint,
    ondelta: value['ondelta'] as bigint,
    offdelta: value['offdelta'] as bigint,
    leftCreditLimit: value['leftCreditLimit'] as bigint,
    rightCreditLimit: value['rightCreditLimit'] as bigint,
    leftAllowance: value['leftAllowance'] as bigint,
    rightAllowance: value['rightAllowance'] as bigint,
    leftHold: value['leftHold'] as bigint,
    rightHold: value['rightHold'] as bigint,
  };
};

/** Decode the complete token-indexed Delta map; partial success is forbidden. */
export const validateAccountDeltas = (
  deltas: unknown,
  source = 'unknown',
): Map<number, Delta> => {
  if (deltas === null || deltas === undefined) {
    throw new TypeSafetyViolationError(
      `ACCOUNT_DELTAS_MISSING: ${source} must provide account deltas`,
      deltas,
    );
  }
  const result = new Map<number, Delta>();
  if (deltas instanceof Map) {
    for (const [tokenId, delta] of deltas.entries()) {
      if (!Number.isInteger(tokenId) || tokenId < 0) {
        throw new TypeSafetyViolationError(
          `ACCOUNT_DELTAS_INVALID_TOKEN_ID: ${source}.Map key must be a non-negative integer`,
          tokenId,
        );
      }
      result.set(tokenId, validateDelta(delta, `${source}.Map[${tokenId}]`));
    }
    return result;
  }
  const entries = validateObject(deltas, `AccountDeltas from ${source}`);
  for (const [tokenIdText, delta] of Object.entries(entries)) {
    if (!/^(0|[1-9]\d*)$/.test(tokenIdText)) {
      throw new TypeSafetyViolationError(
        `ACCOUNT_DELTAS_INVALID_TOKEN_ID: ${source}.Object key must be a canonical non-negative integer`,
        tokenIdText,
      );
    }
    const tokenId = Number(tokenIdText);
    result.set(tokenId, validateDelta(delta, `${source}.Object[${tokenId}]`));
  }
  return result;
};

export const isDelta = (value: unknown): value is Delta => {
  try {
    validateDelta(value, 'type-guard');
    return true;
  } catch {
    return false;
  }
};
