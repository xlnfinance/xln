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
  DeliverableEntityInput,
  RoutedEntityInput,
  EntityState,
  AccountMachine,
  AccountFrame
} from './types';
import type { CrontabState, CrontabTaskMethod, CrontabTaskState, ScheduledHook, ScheduledHookType } from './crontab-types';

/**
 * Strict validation for Delta objects - financial data must be complete
 * @param delta - Unvalidated input that claims to be a Delta
 * @param source - Source context for error messages
 */
export function validateDelta(delta: unknown, source: string = 'unknown'): Delta {
  const obj = validateObject(delta, `Delta from ${source}`);

  // Ensure all required properties exist and are proper types
  const errors: string[] = [];

  const tokenId = obj['tokenId'];
  if (typeof tokenId !== 'number' || !Number.isInteger(tokenId) || tokenId < 0) {
    errors.push(`tokenId must be non-negative integer, got: ${String(tokenId)}`);
  }

  // Validate all BigInt fields
  const bigintFields = [
    'collateral',
    'ondelta',
    'offdelta',
    'leftCreditLimit',
    'rightCreditLimit',
    'leftAllowance',
    'rightAllowance',
  ] as const;

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
    tokenId: obj['tokenId'] as number,
    collateral: obj['collateral'] as bigint,
    ondelta: obj['ondelta'] as bigint,
    offdelta: obj['offdelta'] as bigint,
    leftCreditLimit: obj['leftCreditLimit'] as bigint,
    rightCreditLimit: obj['rightCreditLimit'] as bigint,
    leftAllowance: obj['leftAllowance'] as bigint,
    rightAllowance: obj['rightAllowance'] as bigint,
    ...(obj['leftHold'] === undefined ? {} : { leftHold: validateOptionalBigInt(obj['leftHold'], `${source}.leftHold`) }),
    ...(obj['rightHold'] === undefined ? {} : { rightHold: validateOptionalBigInt(obj['rightHold'], `${source}.rightHold`) }),
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
    leftHold: 0n,
    rightHold: 0n,
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
 * CRITICAL: Validate EntityInput has required routing identifiers.
 * signerId is an optional transport hint resolved at runtime boundary.
 * @param input - Unvalidated input claiming to be EntityInput
 */
export function validateEntityInput(input: unknown): RoutedEntityInput {
  const obj = validateObject(input, 'EntityInput');

  if (typeof obj['entityId'] !== 'string' || obj['entityId'].length === 0) {
    throw new Error(`FINANCIAL-SAFETY: entityId is missing or invalid - financial routing corruption detected`);
  }

  if (obj['signerId'] !== undefined && typeof obj['signerId'] !== 'string') {
    throw new Error(`FINANCIAL-SAFETY: signerId must be string when provided`);
  }

  // entityTxs optional if proposedFrame or hashPrecommits present (multi-signer proposals)
  if (obj['entityTxs'] === undefined && obj['proposedFrame'] === undefined && obj['hashPrecommits'] === undefined) {
    throw new Error(`FINANCIAL-SAFETY: entityTxs, proposedFrame, or hashPrecommits required`);
  }

  if (obj['entityTxs'] !== undefined && !Array.isArray(obj['entityTxs'])) {
    throw new Error(`FINANCIAL-SAFETY: entityTxs must be array`);
  }

  return obj as RoutedEntityInput;
}

/**
 * CRITICAL: Validate EntityOutput (same as EntityInput) has required routing identifiers.
 * Ensure all outputs have proper routing data for financial flows
 * @param output - Unvalidated output claiming to be EntityOutput
 */
export function validateEntityOutput(output: unknown): RoutedEntityInput {
  const obj = validateObject(output, 'EntityOutput');

  if (typeof obj['entityId'] !== 'string' || obj['entityId'].length === 0) {
    throw new Error(`FINANCIAL-SAFETY: EntityOutput entityId is missing - routing corruption`);
  }

  if (obj['signerId'] !== undefined && typeof obj['signerId'] !== 'string') {
    throw new Error(`FINANCIAL-SAFETY: EntityOutput signerId must be string when provided`);
  }

  return obj as RoutedEntityInput;
}

/**
 * CRITICAL: Validate a network-deliverable entity input.
 * These inputs must already have a resolved runtimeId before leaving the local runtime.
 */
export function validateDeliverableEntityInput(output: unknown): DeliverableEntityInput {
  const validated = validateEntityOutput(output);
  if (typeof validated.runtimeId !== 'string' || validated.runtimeId.trim().length === 0) {
    throw new Error('FINANCIAL-SAFETY: Deliverable EntityOutput missing runtimeId');
  }
  return validated as DeliverableEntityInput;
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
      try {
        this.message += `\nContext: ${safeStringify(context)}`;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.message += `\nContext: [Unserializable: ${detail}]`;
      }
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

function validateOptionalBigInt(value: unknown, fieldName: string): bigint {
  if (typeof value === 'bigint') return value;
  throw new TypeSafetyViolationError(`${fieldName} must be a bigint when present`, value);
}

function validateObject(value: unknown, fieldName: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeSafetyViolationError(`${fieldName} must be a non-null object`, value);
  }
  return value as Record<string, unknown>;
}

function validateArray<T>(value: unknown, fieldName: string): T[] {
  if (!Array.isArray(value)) {
    throw new TypeSafetyViolationError(`${fieldName} must be an array`, value);
  }
  return value;
}

// Removed unused validateMap function

function validateMapInstance(value: unknown, fieldName: string): Map<unknown, unknown> {
  if (!(value instanceof Map)) {
    throw new TypeSafetyViolationError(`${fieldName} must be a Map`, value);
  }
  return value;
}

function validateObservationArray(
  value: unknown,
  fieldName: string,
  finalizedField: 'observedAt' | 'finalizedAt',
): void {
  const entries = validateArray<Record<string, unknown>>(value, fieldName);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = validateObject(entries[index], `${fieldName}[${index}]`);
    validateNumber(entry['jHeight'], `${fieldName}[${index}].jHeight`);
    validateString(entry['jBlockHash'], `${fieldName}[${index}].jBlockHash`);
    validateArray(entry['events'], `${fieldName}[${index}].events`);
    validateNumber(entry[finalizedField], `${fieldName}[${index}].${finalizedField}`);
  }
}

function validateBigIntMapValues(value: unknown, fieldName: string): void {
  const map = validateMapInstance(value, fieldName);
  for (const [key, entryValue] of map.entries()) {
    if (typeof entryValue !== 'bigint') {
      throw new FinancialDataCorruptionError(`${fieldName}[${String(key)}] must be bigint`, {
        key: String(key),
        value: entryValue,
      });
    }
  }
}

function validateRebalanceFeeStateMap(value: unknown, fieldName: string): void {
  const map = validateMapInstance(value, fieldName);
  for (const [tokenId, rawFeeState] of map.entries()) {
    const feeState = validateObject(rawFeeState, `${fieldName}[${String(tokenId)}]`);
    validateNumber(feeState['feeTokenId'], `${fieldName}[${String(tokenId)}].feeTokenId`);
    if (typeof feeState['feePaidUpfront'] !== 'bigint') {
      throw new FinancialDataCorruptionError(`${fieldName}[${String(tokenId)}].feePaidUpfront must be bigint`);
    }
    if (typeof feeState['requestedAmount'] !== 'bigint') {
      throw new FinancialDataCorruptionError(`${fieldName}[${String(tokenId)}].requestedAmount must be bigint`);
    }
    validateNumber(feeState['policyVersion'], `${fieldName}[${String(tokenId)}].policyVersion`);
    validateNumber(feeState['requestedAt'], `${fieldName}[${String(tokenId)}].requestedAt`);
    if (typeof feeState['requestedByLeft'] !== 'boolean') {
      throw new FinancialDataCorruptionError(`${fieldName}[${String(tokenId)}].requestedByLeft must be boolean`);
    }
    validateNumber(feeState['jBatchSubmittedAt'], `${fieldName}[${String(tokenId)}].jBatchSubmittedAt`);
  }
}

function isValidCrontabTaskMethod(value: unknown): value is CrontabTaskMethod {
  return value === 'checkAccountTimeouts' || value === 'hubRebalance';
}

function isValidScheduledHookType(value: unknown): value is ScheduledHookType {
  return (
    value === 'htlc_timeout' ||
    value === 'dispute_deadline' ||
    value === 'htlc_secret_ack_timeout' ||
    value === 'settlement_window' ||
    value === 'watchdog' ||
    value === 'hub_rebalance_kick'
  );
}

function rejectUnexpectedKeys(
  obj: Record<string, unknown>,
  allowedKeys: readonly string[],
  fieldName: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.includes(key)) {
      throw new FinancialDataCorruptionError(`${fieldName} has unexpected key "${key}"`);
    }
  }
}

function validateCrontabTaskState(value: unknown, fieldName: string): CrontabTaskState {
  const obj = validateObject(value, fieldName);
  if (!isValidCrontabTaskMethod(obj['method'])) {
    throw new FinancialDataCorruptionError(`${fieldName}.method must be a known crontab task method`);
  }
  validateNumber(obj['intervalMs'], `${fieldName}.intervalMs`);
  validateNumber(obj['lastRun'], `${fieldName}.lastRun`);
  if (typeof obj['enabled'] !== 'boolean') {
    throw new FinancialDataCorruptionError(`${fieldName}.enabled must be a boolean`);
  }
  const params = validateObject(obj['params'], `${fieldName}.params`);
  for (const [paramKey, paramValue] of Object.entries(params)) {
    if (typeof paramValue !== 'string' && typeof paramValue !== 'number' && typeof paramValue !== 'boolean') {
      throw new FinancialDataCorruptionError(`${fieldName}.params.${paramKey} must be string | number | boolean`);
    }
  }
  return obj as CrontabTaskState;
}

function validateScheduledHook(value: unknown, fieldName: string): ScheduledHook {
  const obj = validateObject(value, fieldName);
  const id = validateString(obj['id'], `${fieldName}.id`);
  const triggerAt = validateNumber(obj['triggerAt'], `${fieldName}.triggerAt`);
  const hookType = obj['type'];
  if (!isValidScheduledHookType(hookType)) {
    throw new FinancialDataCorruptionError(`${fieldName}.type must be a known crontab hook type`);
  }
  const data = validateObject(obj['data'], `${fieldName}.data`);

  switch (hookType) {
    case 'htlc_timeout': {
      rejectUnexpectedKeys(data, ['accountId', 'lockId'], `${fieldName}.data`);
      return {
        id,
        triggerAt,
        type: hookType,
        data: {
          accountId: validateString(data['accountId'], `${fieldName}.data.accountId`),
          lockId: validateString(data['lockId'], `${fieldName}.data.lockId`),
        },
      };
    }
    case 'dispute_deadline': {
      rejectUnexpectedKeys(data, ['accountId'], `${fieldName}.data`);
      return {
        id,
        triggerAt,
        type: hookType,
        data: {
          accountId: validateString(data['accountId'], `${fieldName}.data.accountId`),
        },
      };
    }
    case 'htlc_secret_ack_timeout': {
      rejectUnexpectedKeys(data, ['hashlock', 'counterpartyEntityId', 'inboundLockId'], `${fieldName}.data`);
      return {
        id,
        triggerAt,
        type: hookType,
        data: {
          hashlock: validateString(data['hashlock'], `${fieldName}.data.hashlock`),
          counterpartyEntityId: validateString(data['counterpartyEntityId'], `${fieldName}.data.counterpartyEntityId`),
          inboundLockId: validateString(data['inboundLockId'], `${fieldName}.data.inboundLockId`),
        },
      };
    }
    case 'settlement_window':
    case 'watchdog': {
      rejectUnexpectedKeys(data, [], `${fieldName}.data`);
      return {
        id,
        triggerAt,
        type: hookType,
        data: {},
      };
    }
    case 'hub_rebalance_kick': {
      rejectUnexpectedKeys(data, ['reason', 'counterpartyId'], `${fieldName}.data`);
      return {
        id,
        triggerAt,
        type: hookType,
        data: {
          reason: validateString(data['reason'], `${fieldName}.data.reason`),
          counterpartyId: validateString(data['counterpartyId'], `${fieldName}.data.counterpartyId`),
        },
      };
    }
  }
}

function validateCrontabState(value: unknown, fieldName: string): CrontabState {
  const obj = validateObject(value, fieldName);
  const tasks = validateMapInstance(obj['tasks'], `${fieldName}.tasks`);
  const hooks = validateMapInstance(obj['hooks'], `${fieldName}.hooks`);
  for (const [taskKey, taskValue] of tasks.entries()) {
    if (!isValidCrontabTaskMethod(taskKey)) {
      throw new FinancialDataCorruptionError(`${fieldName}.tasks key must be a known crontab task method`);
    }
    const task = validateCrontabTaskState(taskValue, `${fieldName}.tasks[${String(taskKey)}]`);
    if (task.method !== taskKey) {
      throw new FinancialDataCorruptionError(`${fieldName}.tasks[${String(taskKey)}].method must match task key`);
    }
  }
  for (const [hookId, hookValue] of hooks.entries()) {
    if (typeof hookId !== 'string' || hookId.length === 0) {
      throw new FinancialDataCorruptionError(`${fieldName}.hooks key must be a non-empty string`);
    }
    const hook = validateScheduledHook(hookValue, `${fieldName}.hooks[${hookId}]`);
    if (hook.id !== hookId) {
      throw new FinancialDataCorruptionError(`${fieldName}.hooks[${hookId}].id must match hook key`);
    }
  }
  return obj as CrontabState;
}

// =============================================================================
// COMPREHENSIVE VALIDATORS - Complete Type Safety
// =============================================================================

/**
 * Validates AccountFrame objects - Consensus frames for bilateral accounts
 * CRITICAL: Frame integrity ensures consensus safety
 */
export function validateAccountFrame(value: unknown, context = 'AccountFrame'): AccountFrame {
  const obj = validateObject(value, context);
  const height = validateNumber(obj['height'], `${context}.height`);
  const prevFrameHashRaw = obj['prevFrameHash'];
  const prevFrameHash =
    typeof prevFrameHashRaw === 'string' && (prevFrameHashRaw.length > 0 || height === 0)
      ? prevFrameHashRaw
      : validateString(prevFrameHashRaw, `${context}.prevFrameHash`);
  const stateHashRaw = obj['stateHash'];
  const stateHash =
    typeof stateHashRaw === 'string' && (stateHashRaw.length > 0 || height === 0)
      ? stateHashRaw
      : validateString(stateHashRaw, `${context}.stateHash`);

  const validated: AccountFrame = {
    height,
    timestamp: validateNumber(obj['timestamp'], `${context}.timestamp`),
    jHeight: validateNumber(obj['jHeight'], `${context}.jHeight`),
    accountTxs: validateArray(obj['accountTxs'], `${context}.accountTxs`),
    prevFrameHash,
    stateHash,
    tokenIds: validateArray<number>(obj['tokenIds'] || [], `${context}.tokenIds`),
    deltas: validateArray<bigint>(obj['deltas'] || [], `${context}.deltas`),
    // Optional fields - preserve if present (deep copy to prevent mutation issues)
    ...(typeof obj['byLeft'] === 'boolean' ? { byLeft: obj['byLeft'] } : {}),
    ...(Array.isArray(obj['fullDeltaStates'])
      ? {
          fullDeltaStates: obj['fullDeltaStates'].map((deltaState, index) =>
            validateDelta(deltaState, `${context}.fullDeltaStates[${index}]`),
          ),
        }
      : {}),
  };

  // Additional integrity checks
  if (validated.height > 0 && validated.stateHash.length === 0) {
    throw new FinancialDataCorruptionError('AccountFrame.stateHash cannot be empty');
  }

  if (validated.height > 0 && validated.timestamp <= 0) {
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

  validateString(obj['status'], `${context}.status`);
  validateArray(obj['mempool'], `${context}.mempool`);
  validateAccountFrame(obj['currentFrame'], `${context}.currentFrame`);
  validateMapInstance(obj['deltas'], `${context}.deltas`);
  validateMapInstance(obj['locks'], `${context}.locks`);
  validateMapInstance(obj['swapOffers'], `${context}.swapOffers`);
  validateObject(obj['globalCreditLimits'], `${context}.globalCreditLimits`);
  if (typeof obj['globalCreditLimits']['ownLimit'] !== 'bigint') {
    throw new FinancialDataCorruptionError(`${context}.globalCreditLimits.ownLimit must be bigint`);
  }
  if (typeof obj['globalCreditLimits']['peerLimit'] !== 'bigint') {
    throw new FinancialDataCorruptionError(`${context}.globalCreditLimits.peerLimit must be bigint`);
  }
  validateNumber(obj['currentHeight'], `${context}.currentHeight`);
  validateArray(obj['pendingSignatures'], `${context}.pendingSignatures`);
  validateNumber(obj['rollbackCount'], `${context}.rollbackCount`);
  validateObservationArray(obj['leftJObservations'], `${context}.leftJObservations`, 'observedAt');
  validateObservationArray(obj['rightJObservations'], `${context}.rightJObservations`, 'observedAt');
  validateObservationArray(obj['jEventChain'], `${context}.jEventChain`, 'finalizedAt');
  validateNumber(obj['lastFinalizedJHeight'], `${context}.lastFinalizedJHeight`);
  validateArray(obj['frameHistory'], `${context}.frameHistory`);
  validateMapInstance(obj['pendingWithdrawals'], `${context}.pendingWithdrawals`);
  validateBigIntMapValues(obj['requestedRebalance'], `${context}.requestedRebalance`);
  validateRebalanceFeeStateMap(obj['requestedRebalanceFeeState'], `${context}.requestedRebalanceFeeState`);

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

  // Financial invariant: reserves must be keyed by numeric tokenId and valued by bigint.
  // Do not tolerate string token keys in live state; decode boundaries must canonicalize before this.
  for (const [tokenId, amount] of obj['reserves'].entries()) {
    if (typeof tokenId !== 'number' || !Number.isInteger(tokenId) || tokenId <= 0) {
      throw new FinancialDataCorruptionError(`Reserve token key must be a positive integer`, { tokenId });
    }
    if (typeof amount !== 'bigint') {
      throw new FinancialDataCorruptionError(`Reserve amount for token ${tokenId} must be bigint`, { tokenId, amount });
    }
  }

  for (const [accountId, accountMachine] of obj['accounts'].entries()) {
    validateAccountMachine(accountMachine, `${context}.accounts[${String(accountId)}]`);
  }

  if (obj['crontabState'] !== undefined) {
    validateCrontabState(obj['crontabState'], `${context}.crontabState`);
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
