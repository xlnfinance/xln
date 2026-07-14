/**
 * FINTECH-GRADE TYPE VALIDATION SYSTEM
 *
 * Core Principle: Validate at SOURCE, Trust at USE
 * - Data is validated ONCE at creation/entry points
 * - After validation, data can be used without defensive checks
 * - UI layer receives guaranteed-safe data structures
 * - Zero tolerance for undefined/null in financial flows
 */

import { safeStringify } from './protocol/serialization';
import { isLeftEntity } from './entity/id';
import { assertAccountFrameDeltaIntegrity } from './account/frame';
import type {
  ConsensusConfig,
  Delta,
  DeliverableEntityInput,
  RoutedEntityInput,
  EntityReplica,
  EntityState,
  AccountMachine,
  AccountFrame,
  EntityLeaderTimeoutVote,
  ProposedEntityFrame,
} from './types';
import type { CrontabState, CrontabTaskMethod, CrontabTaskState, ScheduledHook, ScheduledHookType } from './entity/scheduler-types';

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
 * Validate account deltas from a Map or serialized object.
 *
 * This is a source boundary for financial data: every entry must be valid, and
 * malformed input fails the whole payload instead of returning a partial map.
 * @param deltas - Unvalidated Map or object that may contain deltas
 * @param source - Source context for error messages
 */
export function validateAccountDeltas(deltas: unknown, source: string = 'unknown'): Map<number, Delta> {
  if (deltas === null || deltas === undefined) {
    throw new TypeSafetyViolationError(`ACCOUNT_DELTAS_MISSING: ${source} must provide account deltas`, deltas);
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
      const validatedDelta = validateDelta(delta, `${source}.Map[${tokenId}]`);
      result.set(tokenId, validatedDelta);
    }
    return result;
  }

  const deltaObject = validateObject(deltas, `AccountDeltas from ${source}`);
  for (const [tokenIdStr, delta] of Object.entries(deltaObject)) {
    if (!/^(0|[1-9]\d*)$/.test(tokenIdStr)) {
      throw new TypeSafetyViolationError(
        `ACCOUNT_DELTAS_INVALID_TOKEN_ID: ${source}.Object key must be a canonical non-negative integer`,
        tokenIdStr,
      );
    }
    const tokenId = Number(tokenIdStr);
    const validatedDelta = validateDelta(delta, `${source}.Object[${tokenId}]`);
    result.set(tokenId, validatedDelta);
  }
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
 *
 * signerId is not a convenience hint. It selects the exact local replica that
 * proposes/signs the entity frame. Accepting entityId-only inputs makes routing
 * depend on ambient local state and can send a proposal through the wrong
 * jurisdiction sibling or a read-only imported replica.
 */
export function validateEntityInput(input: unknown): RoutedEntityInput {
  const obj = validateObject(input, 'EntityInput');

  if (typeof obj['entityId'] !== 'string' || obj['entityId'].length === 0) {
    throw new Error(`FINANCIAL-SAFETY: entityId is missing or invalid - financial routing corruption detected`);
  }

  if (typeof obj['signerId'] !== 'string' || obj['signerId'].trim().length === 0) {
    throw new Error(
      `FINANCIAL-SAFETY: signerId is missing - entity input must target an exact signer replica`,
    );
  }

  // entityTxs are optional for consensus protocol messages.
  if (
    obj['entityTxs'] === undefined &&
    obj['proposedFrame'] === undefined &&
    obj['hashPrecommits'] === undefined &&
    obj['leaderTimeoutVote'] === undefined
  ) {
    throw new Error(`FINANCIAL-SAFETY: entityTxs, proposedFrame, hashPrecommits, or leaderTimeoutVote required`);
  }

  if (obj['entityTxs'] !== undefined && !Array.isArray(obj['entityTxs'])) {
    throw new Error(`FINANCIAL-SAFETY: entityTxs must be array`);
  }

  return obj as unknown as RoutedEntityInput;
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

  if (typeof obj['signerId'] !== 'string' || obj['signerId'].trim().length === 0) {
    throw new Error(
      `FINANCIAL-SAFETY: EntityOutput signerId is missing - routed outputs must target an exact signer replica`,
    );
  }

  return obj as unknown as RoutedEntityInput;
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
  }
}

function validateBigIntRecordValues(value: unknown, fieldName: string): Record<string, bigint> {
  const obj = validateObject(value, fieldName);
  for (const [key, entryValue] of Object.entries(obj)) {
    if (typeof entryValue !== 'bigint') {
      throw new FinancialDataCorruptionError(`${fieldName}.${key} must be bigint`);
    }
  }
  return obj as Record<string, bigint>;
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
	    value === 'hub_rebalance_kick' ||
	    value === 'cross_j_orderbook_sweep'
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
  return obj as unknown as CrontabTaskState;
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
	    case 'cross_j_orderbook_sweep': {
	      rejectUnexpectedKeys(data, ['reason'], `${fieldName}.data`);
	      return {
	        id,
	        triggerAt,
	        type: hookType,
	        data: {
	          reason: validateString(data['reason'], `${fieldName}.data.reason`),
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
  return obj as unknown as CrontabState;
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
  const accountStateRoot = validateString(obj['accountStateRoot'], `${context}.accountStateRoot`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(accountStateRoot)) {
    throw new FinancialDataCorruptionError(`${context}.accountStateRoot must be bytes32 hex`);
  }

  const validated: AccountFrame = {
    height,
    timestamp: validateNumber(obj['timestamp'], `${context}.timestamp`),
    jHeight: validateNumber(obj['jHeight'], `${context}.jHeight`),
    accountTxs: validateArray(obj['accountTxs'], `${context}.accountTxs`),
    prevFrameHash,
    accountStateRoot,
    stateHash,
    deltas: validateArray(obj['deltas'] || [], `${context}.deltas`).map((deltaState, index) =>
      validateDelta(deltaState, `${context}.deltas[${index}]`),
    ),
    ...(typeof obj['byLeft'] === 'boolean' ? { byLeft: obj['byLeft'] } : {}),
  };

  // Additional integrity checks
  if (validated.height > 0 && validated.stateHash.length === 0) {
    throw new FinancialDataCorruptionError('AccountFrame.stateHash cannot be empty');
  }

  if (validated.height > 0 && validated.timestamp <= 0) {
    throw new FinancialDataCorruptionError('AccountFrame.timestamp must be positive', { timestamp: validated.timestamp });
  }
  try {
    assertAccountFrameDeltaIntegrity(validated, context);
  } catch (error) {
    throw new FinancialDataCorruptionError((error as Error).message);
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
  if (obj['pulls'] !== undefined) {
    validateMapInstance(obj['pulls'], `${context}.pulls`);
  }
  if (obj['swapOrderHistory'] !== undefined) {
    validateMapInstance(obj['swapOrderHistory'], `${context}.swapOrderHistory`);
  }
  if (obj['swapClosedOrders'] !== undefined) {
    validateMapInstance(obj['swapClosedOrders'], `${context}.swapClosedOrders`);
  }
  if (obj['lendingIntents'] !== undefined) {
    validateMapInstance(obj['lendingIntents'], `${context}.lendingIntents`);
    const allowedIntents = new Set([
      'fund',
      'borrow',
      'repay',
      'credit-grant',
      'credit-revoke',
      'close-request',
      'close-payout',
    ]);
    for (const [intentId, kind] of (obj['lendingIntents'] as Map<unknown, unknown>).entries()) {
      if (typeof intentId !== 'string' || typeof kind !== 'string' || !allowedIntents.has(kind)) {
        throw new FinancialDataCorruptionError(`${context}.lendingIntents contains invalid receipt`, {
          intentId,
          kind,
        });
      }
    }
  }
  const globalCreditLimits = validateObject(obj['globalCreditLimits'], `${context}.globalCreditLimits`);
  if (typeof globalCreditLimits['ownLimit'] !== 'bigint') {
    throw new FinancialDataCorruptionError(`${context}.globalCreditLimits.ownLimit must be bigint`);
  }
  if (typeof globalCreditLimits['peerLimit'] !== 'bigint') {
    throw new FinancialDataCorruptionError(`${context}.globalCreditLimits.peerLimit must be bigint`);
  }
  validateNumber(obj['currentHeight'], `${context}.currentHeight`);
  if (obj['pendingSignatures'] === undefined || obj['pendingSignatures'] === null) {
    obj['pendingSignatures'] = [];
  } else if (!Array.isArray(obj['pendingSignatures'])) {
    obj['pendingSignatures'] = [];
  } else {
    validateArray(obj['pendingSignatures'], `${context}.pendingSignatures`);
  }
  validateNumber(obj['rollbackCount'], `${context}.rollbackCount`);
  validateObservationArray(obj['leftJObservations'], `${context}.leftJObservations`, 'observedAt');
  validateObservationArray(obj['rightJObservations'], `${context}.rightJObservations`, 'observedAt');
  validateObservationArray(obj['jEventChain'], `${context}.jEventChain`, 'finalizedAt');
  validateNumber(obj['lastFinalizedJHeight'], `${context}.lastFinalizedJHeight`);
  validateMapInstance(obj['pendingWithdrawals'], `${context}.pendingWithdrawals`);
  validateBigIntMapValues(obj['requestedRebalance'], `${context}.requestedRebalance`);
  validateRebalanceFeeStateMap(obj['requestedRebalanceFeeState'], `${context}.requestedRebalanceFeeState`);
  const shadow = validateObject(obj['shadow'], `${context}.shadow`);
  const rebalanceShadow = validateObject(shadow['rebalance'], `${context}.shadow.rebalance`);
  validateMapInstance(rebalanceShadow['policy'], `${context}.shadow.rebalance.policy`);
  validateMapInstance(rebalanceShadow['submittedAtByToken'], `${context}.shadow.rebalance.submittedAtByToken`);

  // Validate all deltas in the map
  const deltas = obj['deltas'] as Map<unknown, unknown>;
  for (const [tokenId, delta] of deltas.entries()) {
    validateDelta(delta, `${context}.deltas[${tokenId}]`);
  }

  return obj as unknown as AccountMachine; // Cast after validation boundary
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

  validateConsensusConfig(obj['config'], `${context}.config`);
  if (obj['leaderState'] !== undefined) {
    const leader = validateObject(obj['leaderState'], `${context}.leaderState`);
    const activeValidatorId = validateString(leader['activeValidatorId'], `${context}.leaderState.activeValidatorId`).toLowerCase();
    const view = validateNumber(leader['view'], `${context}.leaderState.view`);
    const changedAtHeight = validateNumber(leader['changedAtHeight'], `${context}.leaderState.changedAtHeight`);
    const config = obj['config'] as ConsensusConfig;
    if (!Number.isSafeInteger(view) || view < 0 || !Number.isSafeInteger(changedAtHeight) || changedAtHeight < 0) {
      throw new FinancialDataCorruptionError(`${context}.leaderState counters must be non-negative safe integers`);
    }
    if (!config.validators.some((validator) => validator.toLowerCase() === activeValidatorId)) {
      throw new FinancialDataCorruptionError(`${context}.leaderState.activeValidatorId must be a board validator`);
    }
  }

  if (!(obj['reserves'] instanceof Map)) {
    throw new FinancialDataCorruptionError(`${context}.reserves must be a Map`);
  }

  if (!(obj['accounts'] instanceof Map)) {
    throw new FinancialDataCorruptionError(`${context}.accounts must be a Map`);
  }

  if (obj['externalWallet'] !== undefined) {
    const externalWallet = validateObject(obj['externalWallet'], `${context}.externalWallet`);
    validateMapInstance(externalWallet['balances'], `${context}.externalWallet.balances`);
    validateMapInstance(externalWallet['allowances'], `${context}.externalWallet.allowances`);
    for (const [owner, balances] of (externalWallet['balances'] as Map<unknown, unknown>).entries()) {
      if (typeof owner !== 'string') {
        throw new FinancialDataCorruptionError(`${context}.externalWallet.balances owner must be string`, { owner });
      }
      validateMapInstance(balances, `${context}.externalWallet.balances[${owner}]`);
      for (const [tokenKey, record] of (balances as Map<unknown, unknown>).entries()) {
        if (typeof tokenKey !== 'string') {
          throw new FinancialDataCorruptionError(`${context}.externalWallet balance token key must be string`, { tokenKey });
        }
        const balanceRecord = validateObject(record, `${context}.externalWallet.balances[${owner}][${tokenKey}]`);
        if (typeof balanceRecord['tokenAddress'] !== 'string') {
          throw new FinancialDataCorruptionError(`${context}.externalWallet balance tokenAddress must be string`);
        }
        if (typeof balanceRecord['balance'] !== 'bigint') {
          throw new FinancialDataCorruptionError(`${context}.externalWallet balance must be bigint`);
        }
        validateNumber(balanceRecord['jHeight'], `${context}.externalWallet balance jHeight`);
      }
    }
    for (const [owner, allowances] of (externalWallet['allowances'] as Map<unknown, unknown>).entries()) {
      if (typeof owner !== 'string') {
        throw new FinancialDataCorruptionError(`${context}.externalWallet.allowances owner must be string`, { owner });
      }
      validateMapInstance(allowances, `${context}.externalWallet.allowances[${owner}]`);
      for (const [allowanceKey, record] of (allowances as Map<unknown, unknown>).entries()) {
        if (typeof allowanceKey !== 'string') {
          throw new FinancialDataCorruptionError(`${context}.externalWallet allowance key must be string`, { allowanceKey });
        }
        const allowanceRecord = validateObject(record, `${context}.externalWallet.allowances[${owner}][${allowanceKey}]`);
        if (typeof allowanceRecord['tokenAddress'] !== 'string' || typeof allowanceRecord['spender'] !== 'string') {
          throw new FinancialDataCorruptionError(`${context}.externalWallet allowance addresses must be strings`);
        }
        if (typeof allowanceRecord['allowance'] !== 'bigint') {
          throw new FinancialDataCorruptionError(`${context}.externalWallet allowance must be bigint`);
        }
        validateNumber(allowanceRecord['jHeight'], `${context}.externalWallet allowance jHeight`);
      }
    }
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

  if (obj['lending'] !== undefined) {
    const lending = validateObject(obj['lending'], `${context}.lending`);
    validateMapInstance(lending['pools'], `${context}.lending.pools`);
    validateMapInstance(lending['loans'], `${context}.lending.loans`);
  }

  return obj as unknown as EntityState; // Cast after validation boundary
}

export function validateConsensusConfig(value: unknown, context = 'ConsensusConfig'): ConsensusConfig {
  const obj = validateObject(value, context);
  const mode = obj['mode'];
  if (mode !== 'proposer-based' && mode !== 'gossip-based') {
    throw new FinancialDataCorruptionError(`${context}.mode must be proposer-based or gossip-based`);
  }
  const threshold = obj['threshold'];
  if (typeof threshold !== 'bigint' || threshold <= 0n) {
    throw new FinancialDataCorruptionError(`${context}.threshold must be positive bigint`);
  }
  const validators = validateArray<unknown>(obj['validators'], `${context}.validators`);
  if (validators.length === 0) {
    throw new FinancialDataCorruptionError(`${context}.validators cannot be empty`);
  }
  const seen = new Set<string>();
  for (let index = 0; index < validators.length; index += 1) {
    const validator = validators[index];
    if (typeof validator !== 'string' || validator.trim().length === 0) {
      throw new FinancialDataCorruptionError(`${context}.validators[${index}] must be a non-empty string`);
    }
    const normalizedValidator = validator.trim().toLowerCase();
    if (seen.has(normalizedValidator)) {
      throw new FinancialDataCorruptionError(`${context}.validators has duplicate signer`, { validator });
    }
    seen.add(normalizedValidator);
  }
  const shares = validateBigIntRecordValues(obj['shares'], `${context}.shares`);
  const normalizedShares = new Map<string, bigint>();
  for (const [rawSigner, power] of Object.entries(shares)) {
    const signer = rawSigner.trim().toLowerCase();
    if (normalizedShares.has(signer)) {
      throw new FinancialDataCorruptionError(`${context}.shares has case-duplicate signer`, { rawSigner });
    }
    normalizedShares.set(signer, power);
  }
  let totalPower = 0n;
  for (const validator of validators) {
    const normalizedValidator = String(validator).trim().toLowerCase();
    const power = normalizedShares.get(normalizedValidator);
    if (typeof power !== 'bigint' || power <= 0n) {
      throw new FinancialDataCorruptionError(`${context}.shares missing positive power for validator`, { validator });
    }
    if (power > 0xffffn) {
      throw new FinancialDataCorruptionError(`${context}.shares exceeds uint16 board encoding`, { validator, power });
    }
    totalPower += power;
  }
  for (const shareSigner of Object.keys(shares)) {
    if (!seen.has(shareSigner.trim().toLowerCase())) {
      throw new FinancialDataCorruptionError(`${context}.shares contains signer outside validators`, { shareSigner });
    }
  }
  if (totalPower < threshold) {
    throw new FinancialDataCorruptionError(`${context}.threshold exceeds total validator power`, {
      threshold,
      totalPower,
    });
  }
  if (threshold > 0xffffn) {
    throw new FinancialDataCorruptionError(`${context}.threshold exceeds uint16 board encoding`, { threshold });
  }
  if (threshold * 3n <= totalPower * 2n) {
    throw new FinancialDataCorruptionError(
      `${context}.threshold must be strictly greater than two-thirds of total validator power`,
      { threshold, totalPower },
    );
  }
  return obj as unknown as ConsensusConfig;
}

const validateEntityLeaderVoteBody = (value: unknown, context: string): Record<string, unknown> => {
  const vote = validateObject(value, context);
  validateString(vote['entityId'], `${context}.entityId`);
  validateString(vote['previousFrameHash'], `${context}.previousFrameHash`);
  validateString(vote['previousLeaderId'], `${context}.previousLeaderId`);
  validateString(vote['nextLeaderId'], `${context}.nextLeaderId`);
  for (const field of ['targetHeight', 'fromView', 'toView'] as const) {
    const number = validateNumber(vote[field], `${context}.${field}`);
    if (!Number.isSafeInteger(number) || number < 0) {
      throw new FinancialDataCorruptionError(`${context}.${field} must be a non-negative safe integer`);
    }
  }
  if (Number(vote['toView']) !== Number(vote['fromView']) + 1) {
    throw new FinancialDataCorruptionError(`${context}.toView must advance exactly one view`);
  }
  return vote;
};

const validateEntityLeaderVote = (value: unknown, context: string): void => {
  const vote = validateEntityLeaderVoteBody(value, context);
  validateString(vote['voterId'], `${context}.voterId`);
  validateString(vote['signature'], `${context}.signature`);
  if (vote['preparedFrame'] !== undefined) {
    validateProposedEntityFrame(vote['preparedFrame'], `${context}.preparedFrame`);
  }
};

const validateEntityLeaderCertificate = (value: unknown, context: string): void => {
  const certificate = validateEntityLeaderVoteBody(value, context);
  const votes = validateMapInstance(certificate['votes'], `${context}.votes`);
  if (votes.size === 0) {
    throw new FinancialDataCorruptionError(`${context}.votes cannot be empty`);
  }
  for (const [signerId, signature] of votes.entries()) {
    if (typeof signerId !== 'string' || signerId.length === 0 || typeof signature !== 'string' || signature.length === 0) {
      throw new FinancialDataCorruptionError(`${context}.votes must map signer IDs to signatures`);
    }
  }
  if (certificate['preparedVotes'] !== undefined) {
    const preparedVotes = validateMapInstance(certificate['preparedVotes'], `${context}.preparedVotes`);
    if (preparedVotes.size !== votes.size) {
      throw new FinancialDataCorruptionError(`${context}.preparedVotes must cover every certificate vote`);
    }
    for (const [signerId, vote] of preparedVotes.entries()) {
      if (typeof signerId !== 'string' || signerId.length === 0) {
        throw new FinancialDataCorruptionError(`${context}.preparedVotes signer ID must be non-empty`);
      }
      validateEntityLeaderVote(vote, `${context}.preparedVotes[${signerId}]`);
      const voteObject = vote as EntityLeaderTimeoutVote;
      if (voteObject.voterId.toLowerCase() !== signerId.toLowerCase() || voteObject.signature !== votes.get(signerId)) {
        throw new FinancialDataCorruptionError(`${context}.preparedVotes must match votes signature and voterId`);
      }
    }
  }
  if (certificate['preparedFrameHash'] !== undefined) {
    validateString(certificate['preparedFrameHash'], `${context}.preparedFrameHash`);
  }
};

function validateProposedEntityFrame(value: unknown, context: string): ProposedEntityFrame {
  const obj = validateObject(value, context);
  validateNumber(obj['height'], `${context}.height`);
  validateArray(obj['txs'], `${context}.txs`);
  validateString(obj['hash'], `${context}.hash`);
  validateEntityState(obj['newState'], `${context}.newState`);
  const leader = validateObject(obj['leader'], `${context}.leader`);
  validateString(leader['proposerSignerId'], `${context}.leader.proposerSignerId`);
  const leaderView = validateNumber(leader['view'], `${context}.leader.view`);
  if (!Number.isSafeInteger(leaderView) || leaderView < 0) {
    throw new FinancialDataCorruptionError(`${context}.leader.view must be a non-negative safe integer`);
  }
  if (leader['certificate'] !== undefined) {
    validateEntityLeaderCertificate(leader['certificate'], `${context}.leader.certificate`);
  }
  if (leader['relayCertificate'] !== undefined) {
    validateEntityLeaderCertificate(leader['relayCertificate'], `${context}.leader.relayCertificate`);
  }
  if (obj['outputs'] !== undefined) validateArray(obj['outputs'], `${context}.outputs`);
  if (obj['jOutputs'] !== undefined) validateArray(obj['jOutputs'], `${context}.jOutputs`);
  if (obj['hashesToSign'] !== undefined) {
    const hashes = validateArray<Record<string, unknown>>(obj['hashesToSign'], `${context}.hashesToSign`);
    for (let index = 0; index < hashes.length; index += 1) {
      const entry = validateObject(hashes[index], `${context}.hashesToSign[${index}]`);
      validateString(entry['hash'], `${context}.hashesToSign[${index}].hash`);
      validateString(entry['type'], `${context}.hashesToSign[${index}].type`);
      validateString(entry['context'], `${context}.hashesToSign[${index}].context`);
    }
  }
  if (obj['collectedSigs'] !== undefined) {
    const sigs = validateMapInstance(obj['collectedSigs'], `${context}.collectedSigs`);
    for (const [signerId, signatures] of sigs.entries()) {
      if (typeof signerId !== 'string' || signerId.length === 0) {
        throw new FinancialDataCorruptionError(`${context}.collectedSigs signer must be string`);
      }
      validateArray(signatures, `${context}.collectedSigs[${signerId}]`);
    }
  }
  if (obj['hankos'] !== undefined) validateArray(obj['hankos'], `${context}.hankos`);
  return obj as unknown as ProposedEntityFrame;
}

export function validateEntityReplica(value: unknown, context = 'EntityReplica'): EntityReplica {
  const obj = validateObject(value, context);
  const entityId = validateString(obj['entityId'], `${context}.entityId`);
  validateString(obj['signerId'], `${context}.signerId`);
  const state = validateEntityState(obj['state'], `${context}.state`);
  if (state.entityId !== entityId) {
    throw new FinancialDataCorruptionError(`${context}.state.entityId must match replica.entityId`, {
      entityId,
      stateEntityId: state.entityId,
    });
  }
  validateArray(obj['mempool'], `${context}.mempool`);
  if (typeof obj['isProposer'] !== 'boolean') {
    throw new FinancialDataCorruptionError(`${context}.isProposer must be boolean`);
  }
  if (obj['proposal'] !== undefined) validateProposedEntityFrame(obj['proposal'], `${context}.proposal`);
  if (obj['lockedFrame'] !== undefined) validateProposedEntityFrame(obj['lockedFrame'], `${context}.lockedFrame`);
  if (obj['validatorComputedState'] !== undefined) {
    const computed = validateEntityState(obj['validatorComputedState'], `${context}.validatorComputedState`);
    if (computed.entityId !== entityId) {
      throw new FinancialDataCorruptionError(`${context}.validatorComputedState.entityId must match replica.entityId`);
    }
  }
  if (obj['position'] !== undefined) {
    const position = validateObject(obj['position'], `${context}.position`);
    validateNumber(position['x'], `${context}.position.x`);
    validateNumber(position['y'], `${context}.position.y`);
    validateNumber(position['z'], `${context}.position.z`);
  }
  if (obj['hankoWitness'] !== undefined) {
    const witness = validateMapInstance(obj['hankoWitness'], `${context}.hankoWitness`);
    for (const [hash, entryValue] of witness.entries()) {
      if (typeof hash !== 'string' || hash.length === 0) {
        throw new FinancialDataCorruptionError(`${context}.hankoWitness key must be a non-empty hash string`);
      }
      const entry = validateObject(entryValue, `${context}.hankoWitness[${hash}]`);
      validateString(entry['hanko'], `${context}.hankoWitness[${hash}].hanko`);
      validateString(entry['type'], `${context}.hankoWitness[${hash}].type`);
      validateNumber(entry['entityHeight'], `${context}.hankoWitness[${hash}].entityHeight`);
      validateNumber(entry['createdAt'], `${context}.hankoWitness[${hash}].createdAt`);
    }
  }
  if (obj['leaderVotes'] !== undefined) {
    const votes = validateMapInstance(obj['leaderVotes'], `${context}.leaderVotes`);
    for (const [signerId, vote] of votes.entries()) {
      if (typeof signerId !== 'string' || signerId.length === 0) {
        throw new FinancialDataCorruptionError(`${context}.leaderVotes signer must be non-empty string`);
      }
      validateEntityLeaderVote(vote, `${context}.leaderVotes[${signerId}]`);
    }
  }
  if (obj['pendingLeaderCertificate'] !== undefined) {
    validateEntityLeaderCertificate(obj['pendingLeaderCertificate'], `${context}.pendingLeaderCertificate`);
  }
  if (obj['lastConsensusProgressAt'] !== undefined) {
    const progressAt = validateNumber(obj['lastConsensusProgressAt'], `${context}.lastConsensusProgressAt`);
    if (!Number.isSafeInteger(progressAt) || progressAt < 0) {
      throw new FinancialDataCorruptionError(`${context}.lastConsensusProgressAt must be a non-negative safe integer`);
    }
  }
  if (obj['jHistory'] !== undefined) {
    const history = validateObject(obj['jHistory'], `${context}.jHistory`);
    validateString(history['jurisdictionRef'], `${context}.jHistory.jurisdictionRef`);
    const scannedThroughHeight = validateNumber(
      history['scannedThroughHeight'],
      `${context}.jHistory.scannedThroughHeight`,
    );
    if (!Number.isSafeInteger(scannedThroughHeight) || scannedThroughHeight < 0) {
      throw new FinancialDataCorruptionError(`${context}.jHistory.scannedThroughHeight must be a non-negative safe integer`);
    }
    validateString(history['tipBlockHash'], `${context}.jHistory.tipBlockHash`);
    const eventBlocks = validateMapInstance(history['eventBlocks'], `${context}.jHistory.eventBlocks`);
    for (const [height, blockValue] of eventBlocks.entries()) {
      if (!Number.isSafeInteger(height) || Number(height) <= 0) {
        throw new FinancialDataCorruptionError(`${context}.jHistory.eventBlocks key must be a positive safe integer`);
      }
      const block = validateObject(blockValue, `${context}.jHistory.eventBlocks[${String(height)}]`);
      validateString(block['jurisdictionRef'], `${context}.jHistory.eventBlocks[${String(height)}].jurisdictionRef`);
      if (validateNumber(block['jHeight'], `${context}.jHistory.eventBlocks[${String(height)}].jHeight`) !== height) {
        throw new FinancialDataCorruptionError(`${context}.jHistory event block height must match its map key`);
      }
      validateString(block['jBlockHash'], `${context}.jHistory.eventBlocks[${String(height)}].jBlockHash`);
      validateString(block['eventsHash'], `${context}.jHistory.eventBlocks[${String(height)}].eventsHash`);
      validateArray(block['events'], `${context}.jHistory.eventBlocks[${String(height)}].events`);
    }
    const blockHashes = validateMapInstance(history['blockHashes'], `${context}.jHistory.blockHashes`);
    for (const [height, hash] of blockHashes.entries()) {
      if (!Number.isSafeInteger(height) || Number(height) <= 0 || typeof hash !== 'string' || hash.length === 0) {
        throw new FinancialDataCorruptionError(`${context}.jHistory.blockHashes entries must be positive-height hashes`);
      }
    }
  }
  return obj as unknown as EntityReplica;
}

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
