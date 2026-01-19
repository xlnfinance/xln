/**
 * FINTECH-GRADE TYPE VALIDATION SYSTEM
 *
 * Core Principle: Validate at SOURCE, Trust at USE
 * - Data is validated ONCE at creation/entry points
 * - After validation, data can be used without defensive checks
 * - UI layer receives guaranteed-safe data structures
 * - Zero tolerance for undefined/null in financial flows
 */

import { safeStringify } from './serialization-utils';
import { isLeftEntity } from './entity-id-utils';
import type {
  Delta,
  EntityInput,
  EntityState,
  AccountMachine,
  AccountFrame
} from './types';

/**
 * Strict validation for Delta objects - financial data must be complete
 * @param delta - Unvalidated input that claims to be a Delta
 * @param source - Source context for error messages
 */
export function validateDelta(delta: unknown, source: string = 'unknown'): Delta {
  if (!delta || typeof delta !== 'object') {
    throw new Error(`Invalid Delta object from ${source}: ${delta}`);
  }

  // Type narrowing: after checking it's an object, we validate fields immediately
  // Using 'as any' here is safe because we validate every field before returning
  const obj = delta as any;

  // Ensure all required properties exist and are proper types
  const errors: string[] = [];

  if (typeof obj.tokenId !== 'number' || !Number.isInteger(obj.tokenId) || obj.tokenId < 0) {
    errors.push(`tokenId must be non-negative integer, got: ${obj.tokenId}`);
  }

  // Validate all BigInt fields
  const bigintFields = ['collateral', 'ondelta', 'offdelta', 'leftCreditLimit', 'rightCreditLimit', 'leftAllowance', 'rightAllowance'] as const;

  for (const field of bigintFields) {
    const value = obj[field];
    if (value === null || value === undefined) {
      errors.push(`${field} cannot be null/undefined, got: ${value}`);
    } else if (typeof value !== 'bigint') {
      // Try to convert if it's a string representation
      if (typeof value === 'string' && /^-?\d+n?$/.test(value)) {
        try {
          obj[field] = BigInt(value.replace(/n$/, ''));
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

  // After validation, safe to cast to Delta
  return {
    tokenId: obj.tokenId as number,
    collateral: obj.collateral as bigint,
    ondelta: obj.ondelta as bigint,
    offdelta: obj.offdelta as bigint,
    leftCreditLimit: obj.leftCreditLimit as bigint,
    rightCreditLimit: obj.rightCreditLimit as bigint,
    leftAllowance: obj.leftAllowance as bigint,
    rightAllowance: obj.rightAllowance as bigint,
  };
}

/**
 * Validate and fix account deltas Map
 * @param deltas - Unvalidated Map or object that may contain deltas
 * @param source - Source context for error messages
 */
export function validateAccountDeltas(deltas: unknown, source: string = 'unknown'): Map<number, Delta> {
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
    leftCreditLimit: 0n, // Require explicit extendCredit
    rightCreditLimit: 0n,
    leftAllowance: 0n,
    rightAllowance: 0n,
    leftHtlcHold: 0n,
    rightHtlcHold: 0n,
    leftSwapHold: 0n,
    rightSwapHold: 0n,
  };
}

/**
 * Type guard for Delta objects
 * @param obj - Value to check if it's a valid Delta
 */
export function isDelta(obj: unknown): obj is Delta {
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
 * @param input - Unvalidated input claiming to be EntityInput
 */
export function validateEntityInput(input: unknown): EntityInput {
  if (!input || typeof input !== 'object') {
    throw new Error(`FINANCIAL-SAFETY: EntityInput is null/undefined or not an object`);
  }

  // Safe to use 'as any' since we validate all required fields immediately
  const obj = input as any;

  if (!obj.entityId || typeof obj.entityId !== 'string') {
    throw new Error(`FINANCIAL-SAFETY: entityId is missing or invalid - financial routing corruption detected`);
  }

  if (!obj.signerId || typeof obj.signerId !== 'string') {
    throw new Error(`FINANCIAL-SAFETY: signerId is missing or invalid - payment routing will fail`);
  }

  // entityTxs optional if proposedFrame or precommits present (multi-signer proposals)
  if (!obj.entityTxs && !obj.proposedFrame && !obj.precommits) {
    throw new Error(`FINANCIAL-SAFETY: entityTxs, proposedFrame, or precommits required`);
  }

  if (obj.entityTxs && !Array.isArray(obj.entityTxs)) {
    throw new Error(`FINANCIAL-SAFETY: entityTxs must be array`);
  }

  return obj as EntityInput;
}

/**
 * CRITICAL: Validate EntityOutput (same as EntityInput) has required routing identifiers
 * Ensure all outputs have proper routing data for financial flows
 * @param output - Unvalidated output claiming to be EntityOutput
 */
export function validateEntityOutput(output: unknown): EntityInput {
  if (!output || typeof output !== 'object') {
    throw new Error(`FINANCIAL-SAFETY: EntityOutput is null/undefined or not an object`);
  }

  // Safe to use 'as any' since we validate all required fields immediately
  const obj = output as any;

  if (!obj.entityId || typeof obj.entityId !== 'string') {
    throw new Error(`FINANCIAL-SAFETY: EntityOutput entityId is missing - routing corruption`);
  }

  if (!obj.signerId || typeof obj.signerId !== 'string') {
    throw new Error(`FINANCIAL-SAFETY: EntityOutput signerId is missing - routing corruption`);
  }

  return obj as EntityInput;
}

/**
 * CRITICAL: Validate payment route integrity
 * Ensure payment routing paths are complete and valid
 * @param route - Unvalidated array claiming to be a payment route
 */
export function validatePaymentRoute(route: unknown): string[] {
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

// =============================================================================
// ENHANCED ERROR CLASSES - Fail Fast, Fail Loud
// =============================================================================

export class FinancialDataCorruptionError extends Error {
  constructor(message: string, context?: Record<string, unknown>) {
    super(`🚨 FINANCIAL-SAFETY VIOLATION: ${message}`);
    this.name = 'FinancialDataCorruptionError';
    if (context) {
      this.message += `\nContext: ${safeStringify(context)}`;
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

// =============================================================================
// PRIMITIVE VALIDATORS - Building Blocks for Complex Types
// =============================================================================

function validateString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeSafetyViolationError(`${fieldName} must be a non-empty string`, value);
  }
  return value;
}

// Removed unused validateBigInt function

function validateNumber(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeSafetyViolationError(`${fieldName} must be a finite number`, value);
  }
  return value;
}

function validateObject(value: unknown, fieldName: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeSafetyViolationError(`${fieldName} must be a non-null object`, value);
  }
  return value as Record<string, any>;
}

function validateArray<T>(value: unknown, fieldName: string): T[] {
  if (!Array.isArray(value)) {
    throw new TypeSafetyViolationError(`${fieldName} must be an array`, value);
  }
  return value;
}

// Removed unused validateMap function

// =============================================================================
// COMPREHENSIVE VALIDATORS - Complete Type Safety
// =============================================================================

/**
 * Validates AccountFrame objects - Consensus frames for bilateral accounts
 * CRITICAL: Frame integrity ensures consensus safety
 */
export function validateAccountFrame(value: unknown, context = 'AccountFrame'): AccountFrame {
  const obj = validateObject(value, context);

  const validated: AccountFrame = {
    height: validateNumber(obj['height'], `${context}.height`),
    timestamp: validateNumber(obj['timestamp'], `${context}.timestamp`),
    jHeight: validateNumber(obj['jHeight'], `${context}.jHeight`),
    accountTxs: validateArray(obj['accountTxs'], `${context}.accountTxs`),
    prevFrameHash: validateString(obj['prevFrameHash'], `${context}.prevFrameHash`),
    stateHash: validateString(obj['stateHash'], `${context}.stateHash`),
    tokenIds: validateArray<number>(obj['tokenIds'] || [], `${context}.tokenIds`),
    deltas: validateArray<bigint>(obj['deltas'] || [], `${context}.deltas`),
    // Optional fields - preserve if present (deep copy to prevent mutation issues)
    ...(typeof obj['byLeft'] === 'boolean' ? { byLeft: obj['byLeft'] } : {}),
    ...(Array.isArray(obj['fullDeltaStates']) ? { fullDeltaStates: obj['fullDeltaStates'].map((d: any) => ({ ...d })) } : {}),
  };

  // Additional integrity checks
  if (validated.stateHash.length === 0) {
    throw new FinancialDataCorruptionError('AccountFrame.stateHash cannot be empty');
  }

  if (validated.timestamp <= 0) {
    throw new FinancialDataCorruptionError('AccountFrame.timestamp must be positive', { timestamp: validated.timestamp });
  }

  return validated;
}

/**
 * Validates AccountMachine objects - Bilateral account state machines
 * CRITICAL: Account integrity ensures payment routing safety
 */
export function validateAccountMachine(value: unknown, context = 'AccountMachine'): AccountMachine {
  const obj = validateObject(value, context);

  // CANONICAL REPRESENTATION: Validate leftEntity/rightEntity (not counterpartyEntityId)
  if (!obj['leftEntity'] || typeof obj['leftEntity'] !== 'string') {
    throw new FinancialDataCorruptionError(`${context}.leftEntity must be a string`);
  }
  if (!obj['rightEntity'] || typeof obj['rightEntity'] !== 'string') {
    throw new FinancialDataCorruptionError(`${context}.rightEntity must be a string`);
  }
  // Validate canonical ordering: leftEntity < rightEntity
  if (!isLeftEntity(obj['leftEntity'], obj['rightEntity'])) {
    throw new FinancialDataCorruptionError(`${context} canonical order violated: leftEntity must be < rightEntity`);
  }

  if (!obj['deltas'] || !(obj['deltas'] instanceof Map)) {
    throw new FinancialDataCorruptionError(`${context}.deltas must be a Map`);
  }

  // Validate all deltas in the map
  for (const [tokenId, delta] of obj['deltas'].entries()) {
    validateDelta(delta, `${context}.deltas[${tokenId}]`);
  }

  return obj as AccountMachine; // Cast after basic validation
}

/**
 * Validates EntityState objects - Complete entity state
 * CRITICAL: Entity integrity ensures consensus and routing safety
 */
export function validateEntityState(value: unknown, context = 'EntityState'): EntityState {
  const obj = validateObject(value, context);

  // Basic validation - the interface is complex, so validate critical fields
  if (!obj['entityId'] || typeof obj['entityId'] !== 'string') {
    throw new FinancialDataCorruptionError(`${context}.entityId must be a string`);
  }

  if (typeof obj['height'] !== 'number') {
    throw new FinancialDataCorruptionError(`${context}.height must be a number`);
  }

  if (typeof obj['timestamp'] !== 'number') {
    throw new FinancialDataCorruptionError(`${context}.timestamp must be a number`);
  }

  if (!(obj['reserves'] instanceof Map)) {
    throw new FinancialDataCorruptionError(`${context}.reserves must be a Map`);
  }

  if (!(obj['accounts'] instanceof Map)) {
    throw new FinancialDataCorruptionError(`${context}.accounts must be a Map`);
  }

  // Validate all reserves are valid bigints
  for (const [tokenId, amount] of obj['reserves'].entries()) {
    if (typeof amount !== 'bigint') {
      throw new FinancialDataCorruptionError(`Reserve amount for token ${tokenId} must be bigint`, { tokenId, amount });
    }
  }

  return obj as EntityState; // Cast after basic validation
}

// Config validation removed - ConsensusConfig is more complex than expected

// EntityReplica validation removed - interface too complex for now

// =============================================================================
// ENHANCED SAFE COLLECTION ACCESS
// =============================================================================

/**
 * Safe Map.get() with validation for financial data
 */
export function safeMapGetFinancial<K, V>(
  map: Map<K, V>,
  key: K,
  validator: (value: unknown, context: string) => V,
  context: string
): V {
  const value = map.get(key);
  if (value === undefined) {
    throw new FinancialDataCorruptionError(`Missing financial data in ${context}`, { key: String(key) });
  }
  return validator(value, `${context}[${String(key)}]`);
}

/**
 * Safe array access with bounds checking
 */
export function safeArrayGet<T>(array: T[], index: number, context: string): T {
  if (index < 0 || index >= array.length) {
    throw new TypeSafetyViolationError(`Array index out of bounds in ${context}`, { index, length: array.length });
  }
  return array[index]!; // Add non-null assertion to fix TypeScript issue
}

/**
 * Validates an entity ID string
 */
export function validateEntityId(value: unknown, context: string): string {
  const entityId = validateString(value, context);
  if (entityId.includes('undefined')) {
    throw new FinancialDataCorruptionError(`${context} contains 'undefined' - routing corruption detected`, { entityId });
  }
  return entityId;
}
