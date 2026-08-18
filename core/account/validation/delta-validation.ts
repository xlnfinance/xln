import type { Delta } from '../../types/account';
import { assertAccountDeltaCapacity } from '../state/delta';
import {
  TypeSafetyViolationError,
  validateObject,
} from '../../protocol/boundary/validation-primitives';
import { INT256_MAX, INT256_MIN, UINT256_MAX } from '../../protocol/boundary/integer-ranges';
import { FINANCIAL, TOKENS } from '../../config/constants';

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

const UNSIGNED_FIELDS = [
  'collateral',
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
    tokenId < 0 ||
    tokenId > TOKENS.MAX_TOKEN_ID
  ) {
    errors.push(`tokenId must be integer in [0, ${TOKENS.MAX_TOKEN_ID}], got: ${String(tokenId)}`);
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
  for (const field of UNSIGNED_FIELDS) {
    const fieldValue = value[field];
    if (typeof fieldValue === 'bigint' && fieldValue < 0n) {
      errors.push(`${field} must be non-negative, got: ${fieldValue}`);
    } else if (typeof fieldValue === 'bigint') {
      const maximum = field.endsWith('CreditLimit') ? FINANCIAL.MAX_CREDIT_LIMIT : UINT256_MAX;
      if (fieldValue > maximum) errors.push(`${field} exceeds maximum ${maximum}, got: ${fieldValue}`);
    }
  }
  for (const field of ['ondelta', 'offdelta'] as const) {
    const fieldValue = value[field];
    if (typeof fieldValue === 'bigint' && (fieldValue < INT256_MIN || fieldValue > INT256_MAX)) {
      errors.push(`${field} must fit int256, got: ${fieldValue}`);
    }
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
    assertAccountDeltaCapacity(deltas.size, source);
    for (const [tokenId, delta] of deltas.entries()) {
      if (!Number.isSafeInteger(tokenId) || tokenId < 0 || tokenId > TOKENS.MAX_TOKEN_ID) {
        throw new TypeSafetyViolationError(
          `ACCOUNT_DELTAS_INVALID_TOKEN_ID: ${source}.Map key must be in [0, ${TOKENS.MAX_TOKEN_ID}]`,
          tokenId,
        );
      }
      result.set(tokenId, validateDelta(delta, `${source}.Map[${tokenId}]`));
    }
    return result;
  }
  const entries = validateObject(deltas, `AccountDeltas from ${source}`);
  assertAccountDeltaCapacity(Object.keys(entries).length, source);
  for (const [tokenIdText, delta] of Object.entries(entries)) {
    if (!/^(0|[1-9]\d*)$/.test(tokenIdText)) {
      throw new TypeSafetyViolationError(
        `ACCOUNT_DELTAS_INVALID_TOKEN_ID: ${source}.Object key must be a canonical non-negative integer`,
        tokenIdText,
      );
    }
    const tokenId = Number(tokenIdText);
    if (!Number.isSafeInteger(tokenId) || tokenId > TOKENS.MAX_TOKEN_ID) {
      throw new TypeSafetyViolationError(
        `ACCOUNT_DELTAS_INVALID_TOKEN_ID: ${source}.Object key must be in [0, ${TOKENS.MAX_TOKEN_ID}]`,
        tokenIdText,
      );
    }
    result.set(tokenId, validateDelta(delta, `${source}.Object[${tokenId}]`));
  }
  return result;
};
