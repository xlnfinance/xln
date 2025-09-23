/**
 * Strict validation utilities for financial data types
 * Ensures no undefined/null values in monetary calculations
 */

import { Delta } from './types';

/**
 * Strict validation for Delta objects - financial data must be complete
 */
export function validateDelta(delta: any, source: string = 'unknown'): Delta {
  if (!delta || typeof delta !== 'object') {
    throw new Error(`Invalid Delta object from ${source}: ${delta}`);
  }

  // Ensure all required properties exist and are proper types
  const errors: string[] = [];

  if (typeof delta.tokenId !== 'number' || !Number.isInteger(delta.tokenId) || delta.tokenId < 0) {
    errors.push(`tokenId must be non-negative integer, got: ${delta.tokenId}`);
  }

  // Validate all BigInt fields
  const bigintFields = ['collateral', 'ondelta', 'offdelta', 'leftCreditLimit', 'rightCreditLimit', 'leftAllowence', 'rightAllowence'];

  for (const field of bigintFields) {
    const value = delta[field];
    if (value === null || value === undefined) {
      errors.push(`${field} cannot be null/undefined, got: ${value}`);
    } else if (typeof value !== 'bigint') {
      // Try to convert if it's a string representation
      if (typeof value === 'string' && /^-?\d+n?$/.test(value)) {
        try {
          delta[field] = BigInt(value.replace(/n$/, ''));
        } catch (e) {
          errors.push(`${field} invalid BigInt string: ${value}`);
        }
      } else {
        errors.push(`${field} must be BigInt, got: ${typeof value} (${value})`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Delta validation failed from ${source}:\n${errors.join('\n')}`);
  }

  // Ensure we return a properly typed Delta
  return {
    tokenId: delta.tokenId,
    collateral: delta.collateral,
    ondelta: delta.ondelta,
    offdelta: delta.offdelta,
    leftCreditLimit: delta.leftCreditLimit,
    rightCreditLimit: delta.rightCreditLimit,
    leftAllowence: delta.leftAllowence,
    rightAllowence: delta.rightAllowence,
  };
}

/**
 * Validate and fix account deltas Map
 */
export function validateAccountDeltas(deltas: any, source: string = 'unknown'): Map<number, Delta> {
  if (!deltas) {
    console.warn(`No deltas provided from ${source}, returning empty Map`);
    return new Map();
  }

  // Handle both Map and plain object formats
  const result = new Map<number, Delta>();

  if (deltas instanceof Map) {
    for (const [tokenId, delta] of deltas.entries()) {
      try {
        const validatedDelta = validateDelta(delta, `${source}.Map[${tokenId}]`);
        result.set(tokenId, validatedDelta);
      } catch (error) {
        console.error(`Skipping invalid delta for token ${tokenId}:`, error);
      }
    }
  } else if (typeof deltas === 'object') {
    // Handle serialized Map or plain object
    for (const [tokenIdStr, delta] of Object.entries(deltas)) {
      const tokenId = parseInt(tokenIdStr, 10);
      if (isNaN(tokenId)) {
        console.error(`Invalid tokenId: ${tokenIdStr}`);
        continue;
      }

      try {
        const validatedDelta = validateDelta(delta, `${source}.Object[${tokenId}]`);
        result.set(tokenId, validatedDelta);
      } catch (error) {
        console.error(`Skipping invalid delta for token ${tokenId}:`, error);
      }
    }
  } else {
    console.error(`Invalid deltas format from ${source}:`, typeof deltas);
    return new Map();
  }

  console.log(`✅ Validated ${result.size} deltas from ${source}`);
  return result;
}

/**
 * Create a safe default Delta object with proper BigInt values
 */
export function createDefaultDelta(tokenId: number): Delta {
  return {
    tokenId,
    collateral: 0n,
    ondelta: 0n,
    offdelta: 0n,
    leftCreditLimit: 1000000000000000000000000n, // 1M with 18 decimals
    rightCreditLimit: 1000000000000000000000000n,
    leftAllowence: 0n,
    rightAllowence: 0n,
  };
}

/**
 * Type guard for Delta objects
 */
export function isDelta(obj: any): obj is Delta {
  try {
    validateDelta(obj, 'type-guard');
    return true;
  } catch {
    return false;
  }
}