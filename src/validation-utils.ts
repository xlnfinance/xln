/**
 * Strict validation utilities for financial data types
 * Ensures no undefined/null values in monetary calculations
 *
 * FINTECH-LEVEL TYPE SAFETY: Never allow undefined routing identifiers
 */

import { Delta, EntityInput } from './types';

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

// ============================================================================
// FINTECH-LEVEL TYPE SAFETY: ROUTING INTEGRITY VALIDATION
// ============================================================================

/**
 * CRITICAL: Validate EntityInput has required routing identifiers
 * Never allow undefined entityId/signerId in financial flows
 */
export function validateEntityInput(input: any): EntityInput {
  if (!input) {
    throw new Error(`FINANCIAL-SAFETY: EntityInput is null/undefined`);
  }

  if (!input.entityId || typeof input.entityId !== 'string') {
    throw new Error(`FINANCIAL-SAFETY: entityId is missing or invalid - financial routing corruption detected`);
  }

  if (!input.signerId || typeof input.signerId !== 'string') {
    throw new Error(`FINANCIAL-SAFETY: signerId is missing or invalid - payment routing will fail`);
  }

  if (!input.entityTxs || !Array.isArray(input.entityTxs)) {
    throw new Error(`FINANCIAL-SAFETY: entityTxs is missing or invalid`);
  }

  return input as EntityInput;
}

/**
 * CRITICAL: Validate EntityOutput (same as EntityInput) has required routing identifiers
 * Ensure all outputs have proper routing data for financial flows
 */
export function validateEntityOutput(output: any): EntityInput {
  if (!output) {
    throw new Error(`FINANCIAL-SAFETY: EntityOutput is null/undefined`);
  }

  if (!output.entityId || typeof output.entityId !== 'string') {
    throw new Error(`FINANCIAL-SAFETY: EntityOutput entityId is missing - routing corruption`);
  }

  if (!output.signerId || typeof output.signerId !== 'string') {
    throw new Error(`FINANCIAL-SAFETY: EntityOutput signerId is missing - routing corruption`);
  }

  return output as EntityInput;
}

/**
 * CRITICAL: Validate payment route integrity
 * Ensure payment routing paths are complete and valid
 */
export function validatePaymentRoute(route: any): string[] {
  if (!route || !Array.isArray(route)) {
    throw new Error(`FINANCIAL-SAFETY: Payment route must be a valid array`);
  }

  if (route.length === 0) {
    throw new Error(`FINANCIAL-SAFETY: Payment route cannot be empty`);
  }

  for (let i = 0; i < route.length; i++) {
    const entityId = route[i];
    if (!entityId || typeof entityId !== 'string') {
      throw new Error(`FINANCIAL-SAFETY: Route[${i}] is invalid - entity ID required for financial routing`);
    }
  }

  return route as string[];
}

/**
 * CRITICAL: Safe Map.get() for financial data
 * Replace all financial Map.get(id)! with null-safe patterns
 */
export function safeMapGet<K, V>(map: Map<K, V>, key: K, context: string): V {
  const value = map.get(key);
  if (value === undefined) {
    throw new Error(`FINANCIAL-SAFETY: ${context} not found for key: ${key}`);
  }
  return value;
}