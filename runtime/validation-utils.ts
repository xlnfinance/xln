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
import { assertAccountJClaimAccumulatorState } from './account/j-claim-accumulator';
import type { CrontabState, CrontabTaskMethod, CrontabTaskState, ScheduledHook, ScheduledHookType } from './entity/scheduler-types';
import { validatePersistedValidatorEncryptionManifest } from './protocol/htlc/validator-encryption';
import { LIMITS, TOKENS } from './constants';
import { assertConsumptionAccumulatorState } from './entity/consumption-accumulator';
import { assertEntityAccountCountWithinLimit } from './entity/account-capacity';
import { assertAccountMempoolWithinLimit } from './account/mempool';
import { normalizeAccountStateDomain, sameAccountStateDomain } from './account/state-root';
import { assertEntityProviderActionIntent } from './entity/entity-provider-action';
import type { EntityProviderActionIntent } from './types/entity-provider-actions';
import { isRuntimeFailureSignal } from './protocol/failure-taxonomy';
import type { SwapOrderHistoryEntry, SwapOrderResolveHistoryEntry } from './types';

const MAX_UINT256 = (1n << 256n) - 1n;

const SWAP_HISTORY_FIELDS = new Set([
  'offerId', 'giveTokenId', 'giveAmount', 'originalGiveAmount', 'wantTokenId',
  'wantAmount', 'originalWantAmount', 'priceTicks', 'createdHeight',
  'crossJurisdiction', 'cancelRequested', 'lastUpdatedHeight', 'resolves',
]);
const SWAP_RESOLVE_FIELDS = new Set([
  'fillRatio', 'fillNumerator', 'fillDenominator', 'cancelRemainder', 'height',
  'executionGiveAmount', 'executionWantAmount', 'feeTokenId', 'feeAmount', 'comment',
]);

const assertExactFields = (value: Record<string, unknown>, allowed: Set<string>, context: string): void => {
  const unexpected = Object.keys(value).filter((field) => !allowed.has(field));
  if (unexpected.length > 0) {
    throw new FinancialDataCorruptionError(`${context} contains unexpected fields: ${unexpected.sort().join(',')}`);
  }
};

const assertOptionalNonNegativeBigint = (
  value: unknown,
  context: string,
): void => {
  if (value !== undefined && (typeof value !== 'bigint' || value < 0n)) {
    throw new FinancialDataCorruptionError(`${context} must be a non-negative bigint`);
  }
};

const validateSwapResolveHistoryEntry = (
  value: unknown,
  context: string,
): SwapOrderResolveHistoryEntry => {
  const resolve = validateObject(value, context);
  assertExactFields(resolve, SWAP_RESOLVE_FIELDS, context);
  if (!Number.isInteger(resolve['fillRatio']) || Number(resolve['fillRatio']) < 0 || Number(resolve['fillRatio']) > 0xffff) {
    throw new FinancialDataCorruptionError(`${context}.fillRatio must be uint16`);
  }
  if (typeof resolve['cancelRemainder'] !== 'boolean') {
    throw new FinancialDataCorruptionError(`${context}.cancelRemainder must be boolean`);
  }
  if (!Number.isSafeInteger(resolve['height']) || Number(resolve['height']) < 0) {
    throw new FinancialDataCorruptionError(`${context}.height must be a non-negative safe integer`);
  }
  for (const field of ['fillNumerator', 'fillDenominator', 'executionGiveAmount', 'executionWantAmount', 'feeAmount'] as const) {
    assertOptionalNonNegativeBigint(resolve[field], `${context}.${field}`);
  }
  if (resolve['feeTokenId'] !== undefined && (!Number.isSafeInteger(resolve['feeTokenId']) || Number(resolve['feeTokenId']) <= 0)) {
    throw new FinancialDataCorruptionError(`${context}.feeTokenId must be a positive safe integer`);
  }
  if (
    resolve['comment'] !== undefined &&
    (typeof resolve['comment'] !== 'string' || resolve['comment'].length > LIMITS.MAX_ACCOUNT_SWAP_HISTORY_TEXT)
  ) {
    throw new FinancialDataCorruptionError(
      `${context}.comment must be at most ${LIMITS.MAX_ACCOUNT_SWAP_HISTORY_TEXT} characters`,
    );
  }
  return resolve as unknown as SwapOrderResolveHistoryEntry;
};

const validateSwapHistoryEntry = (
  key: unknown,
  value: unknown,
  context: string,
): SwapOrderHistoryEntry => {
  const entry = validateObject(value, context);
  assertExactFields(entry, SWAP_HISTORY_FIELDS, context);
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    key.length > LIMITS.MAX_ACCOUNT_SWAP_HISTORY_TEXT ||
    key.includes(':') ||
    entry['offerId'] !== key
  ) {
    throw new FinancialDataCorruptionError(`${context}.offerId must exactly match its bounded Map key`);
  }
  for (const field of ['giveTokenId', 'wantTokenId'] as const) {
    if (!Number.isSafeInteger(entry[field]) || Number(entry[field]) <= 0) {
      throw new FinancialDataCorruptionError(`${context}.${field} must be a positive safe integer`);
    }
  }
  for (const field of ['giveAmount', 'wantAmount'] as const) {
    if (typeof entry[field] !== 'bigint' || entry[field] <= 0n) {
      throw new FinancialDataCorruptionError(`${context}.${field} must be a positive bigint`);
    }
  }
  for (const field of ['originalGiveAmount', 'originalWantAmount', 'priceTicks'] as const) {
    assertOptionalNonNegativeBigint(entry[field], `${context}.${field}`);
  }
  for (const field of ['createdHeight', 'lastUpdatedHeight'] as const) {
    if (!Number.isSafeInteger(entry[field]) || Number(entry[field]) < 0) {
      throw new FinancialDataCorruptionError(`${context}.${field} must be a non-negative safe integer`);
    }
  }
  if (typeof entry['cancelRequested'] !== 'boolean') {
    throw new FinancialDataCorruptionError(`${context}.cancelRequested must be boolean`);
  }
  if (entry['crossJurisdiction'] !== undefined && (typeof entry['crossJurisdiction'] !== 'object' || entry['crossJurisdiction'] === null)) {
    throw new FinancialDataCorruptionError(`${context}.crossJurisdiction must be an object`);
  }
  const resolves = validateArray(entry['resolves'], `${context}.resolves`);
  if (resolves.length > LIMITS.MAX_ACCOUNT_SWAP_RESOLVES_PER_ORDER) {
    throw new FinancialDataCorruptionError(`ACCOUNT_SWAP_RESOLVE_HISTORY_LIMIT_EXCEEDED:${context}`);
  }
  resolves.forEach((resolve, index) => validateSwapResolveHistoryEntry(resolve, `${context}.resolves[${index}]`));
  return entry as unknown as SwapOrderHistoryEntry;
};

const validateSwapHistoryMap = (
  value: unknown,
  context: string,
  maxSize: number,
  limitCode: string,
): Map<string, SwapOrderHistoryEntry> => {
  const history = validateMapInstance(value, context);
  if (history.size > maxSize) {
    throw new FinancialDataCorruptionError(`${limitCode}:${context}:size=${history.size}:max=${maxSize}`);
  }
  for (const [key, entry] of history) validateSwapHistoryEntry(key, entry, `${context}[${String(key)}]`);
  return history as Map<string, SwapOrderHistoryEntry>;
};

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
    obj['jPrefixAttestations'] === undefined &&
    obj['leaderTimeoutVote'] === undefined
  ) {
    throw new Error(
      `FINANCIAL-SAFETY: entityTxs, proposedFrame, hashPrecommits, jPrefixAttestations, or leaderTimeoutVote required`,
    );
  }

  if (obj['entityTxs'] !== undefined && !Array.isArray(obj['entityTxs'])) {
    throw new Error(`FINANCIAL-SAFETY: entityTxs must be array`);
  }
  if (
    obj['leaderTimeoutVote'] !== undefined &&
    (
      obj['entityTxs'] !== undefined ||
      obj['proposedFrame'] !== undefined ||
      obj['hashPrecommitFrame'] !== undefined ||
      obj['hashPrecommits'] !== undefined ||
      obj['jPrefixAttestations'] !== undefined
    )
  ) {
    throw new Error('FINANCIAL-SAFETY: leaderTimeoutVote must use a dedicated consensus lane');
  }
  if (obj['proposedFrame'] !== undefined) {
    validateProposedEntityFrame(obj['proposedFrame'], 'EntityInput.proposedFrame');
  }
  if (obj['hashPrecommits'] !== undefined) {
    const reference = obj['hashPrecommitFrame'];
    if (
      typeof reference !== 'object' ||
      reference === null ||
      !Number.isSafeInteger((reference as Record<string, unknown>)['height']) ||
      typeof (reference as Record<string, unknown>)['frameHash'] !== 'string' ||
      String((reference as Record<string, unknown>)['frameHash']).trim().length === 0
    ) {
      throw new Error('FINANCIAL-SAFETY: hashPrecommits require exact hashPrecommitFrame');
    }
  }
  if (obj['jPrefixAttestations'] !== undefined) {
    const attestations = validateMapInstance(obj['jPrefixAttestations'], 'EntityInput.jPrefixAttestations');
    if (attestations.size === 0) throw new Error('FINANCIAL-SAFETY: jPrefixAttestations cannot be empty');
    for (const [signerId, attestation] of attestations) {
      if (typeof signerId !== 'string' || signerId.trim().length === 0) {
        throw new Error('FINANCIAL-SAFETY: jPrefixAttestations signer must be non-empty string');
      }
      validateJPrefixAttestation(attestation, `EntityInput.jPrefixAttestations[${signerId}]`);
    }
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

const REBALANCE_POLICY_SIDES = new Set(['left', 'right']);
const REBALANCE_POLICY_FIELDS = new Set([
  'policyVersion', 'baseFee', 'liquidityFeeBps', 'gasFee', 'updatedAt',
]);

function validateRebalanceFeePolicies(value: unknown, fieldName: string): void {
  const policies = validateMapInstance(value, fieldName);
  for (const [tokenId, rawSides] of policies) {
    if (!Number.isSafeInteger(tokenId) || Number(tokenId) <= 0 || Number(tokenId) > TOKENS.MAX_TOKEN_ID) {
      throw new FinancialDataCorruptionError(`${fieldName} contains invalid tokenId ${String(tokenId)}`);
    }
    const sides = validateObject(rawSides, `${fieldName}[${String(tokenId)}]`);
    assertExactFields(sides, REBALANCE_POLICY_SIDES, `${fieldName}[${String(tokenId)}]`);
    if (sides['left'] === undefined && sides['right'] === undefined) {
      throw new FinancialDataCorruptionError(`${fieldName}[${String(tokenId)}] must contain left or right policy`);
    }
    for (const side of ['left', 'right'] as const) {
      if (sides[side] === undefined) continue;
      const policy = validateObject(sides[side], `${fieldName}[${String(tokenId)}].${side}`);
      assertExactFields(policy, REBALANCE_POLICY_FIELDS, `${fieldName}[${String(tokenId)}].${side}`);
      if (!Number.isSafeInteger(policy['policyVersion']) || Number(policy['policyVersion']) <= 0) {
        throw new FinancialDataCorruptionError(`${fieldName}[${String(tokenId)}].${side}.policyVersion is invalid`);
      }
      if (!Number.isSafeInteger(policy['updatedAt']) || Number(policy['updatedAt']) < 0) {
        throw new FinancialDataCorruptionError(`${fieldName}[${String(tokenId)}].${side}.updatedAt is invalid`);
      }
      for (const fee of ['baseFee', 'liquidityFeeBps', 'gasFee'] as const) {
        if (typeof policy[fee] !== 'bigint' || policy[fee] < 0n) {
          throw new FinancialDataCorruptionError(`${fieldName}[${String(tokenId)}].${side}.${fee} is invalid`);
        }
      }
      if ((policy['liquidityFeeBps'] as bigint) > 10_000n) {
        throw new FinancialDataCorruptionError(`${fieldName}[${String(tokenId)}].${side}.liquidityFeeBps exceeds 10000`);
      }
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
	    value === 'board_reseal' ||
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
	    case 'board_reseal': {
	      rejectUnexpectedKeys(
	        data,
	        ['activationJHeight', 'activationLogIndex', 'afterCounterpartyId'],
	        `${fieldName}.data`,
	      );
	      const activationJHeight = validateNumber(
	        data['activationJHeight'],
	        `${fieldName}.data.activationJHeight`,
	      );
	      const activationLogIndex = validateNumber(
	        data['activationLogIndex'],
	        `${fieldName}.data.activationLogIndex`,
	      );
	      if (
	        !Number.isSafeInteger(activationJHeight) ||
	        activationJHeight < 1 ||
	        !Number.isSafeInteger(activationLogIndex) ||
	        activationLogIndex < 0
	      ) {
	        throw new FinancialDataCorruptionError(`${fieldName}.data board activation position is invalid`);
	      }
	      const afterCounterpartyId = data['afterCounterpartyId'];
	      if (typeof afterCounterpartyId !== 'string') {
	        throw new FinancialDataCorruptionError(`${fieldName}.data.afterCounterpartyId must be a string`);
	      }
	      return {
	        id,
	        triggerAt,
	        type: hookType,
	        data: { activationJHeight, activationLogIndex, afterCounterpartyId },
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

const validatePendingAccountResend = (
  account: Record<string, unknown>,
  context: string,
): void => {
  const pendingFrame = account['pendingFrame'];
  const pendingInput = account['pendingAccountInput'];
  const targetSigner = account['pendingAccountInputSignerId'];
  const present = [pendingFrame, pendingInput, targetSigner].map(value => value !== undefined);
  if (present.every(value => !value)) return;
  if (!present.every(Boolean)) {
    throw new FinancialDataCorruptionError(
      `${context}.pendingFrame, pendingAccountInput and pendingAccountInputSignerId must be present together`,
    );
  }
  if (typeof targetSigner !== 'string' || targetSigner.trim().length === 0) {
    throw new FinancialDataCorruptionError(`${context}.pendingAccountInputSignerId must be a non-empty string`);
  }
  const input = validateObject(pendingInput, `${context}.pendingAccountInput`);
  if (input['kind'] !== 'frame' && input['kind'] !== 'frame_ack') {
    throw new FinancialDataCorruptionError(`${context}.pendingAccountInput must carry a frame proposal`);
  }
  const proposal = validateObject(input['proposal'], `${context}.pendingAccountInput.proposal`);
  const storedFrame = validateAccountFrame(pendingFrame, `${context}.pendingFrame`);
  const proposedFrame = validateAccountFrame(proposal['frame'], `${context}.pendingAccountInput.proposal.frame`);
  if (safeStringify(proposedFrame) !== safeStringify(storedFrame)) {
    throw new FinancialDataCorruptionError(
      `${context}.pendingAccountInput proposal must exactly match pendingFrame`,
    );
  }
  const proofHeader = validateObject(account['proofHeader'], `${context}.proofHeader`);
  if (input['fromEntityId'] !== proofHeader['fromEntity'] || input['toEntityId'] !== proofHeader['toEntity']) {
    throw new FinancialDataCorruptionError(`${context}.pendingAccountInput endpoints must match proofHeader`);
  }
  if (!sameAccountStateDomain(
    normalizeAccountStateDomain(account['domain'] as AccountMachine['domain']),
    normalizeAccountStateDomain(input['domain'] as AccountMachine['domain']),
  )) {
    throw new FinancialDataCorruptionError(`${context}.pendingAccountInput domain must match Account domain`);
  }
};

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
  try {
    normalizeAccountStateDomain(obj['domain'] as AccountMachine['domain']);
  } catch (error) {
    throw new FinancialDataCorruptionError(`${context}.domain is invalid`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  validateString(obj['status'], `${context}.status`);
  validateArray(obj['mempool'], `${context}.mempool`);
  assertAccountMempoolWithinLimit(
    obj as unknown as Pick<AccountMachine, 'mempool'>,
    `${context}.mempool`,
  );
  validateAccountFrame(obj['currentFrame'], `${context}.currentFrame`);
  validateMapInstance(obj['deltas'], `${context}.deltas`);
  validateMapInstance(obj['locks'], `${context}.locks`);
  validateMapInstance(obj['swapOffers'], `${context}.swapOffers`);
  if (obj['pulls'] !== undefined) {
    validateMapInstance(obj['pulls'], `${context}.pulls`);
  }
  if (obj['swapOrderHistory'] !== undefined) {
    validateSwapHistoryMap(
      obj['swapOrderHistory'],
      `${context}.swapOrderHistory`,
      LIMITS.MAX_ACCOUNT_SWAP_OFFERS + LIMITS.MAX_ACCOUNT_TERMINAL_SWAP_HISTORY,
      'ACCOUNT_SWAP_HISTORY_LIMIT_EXCEEDED',
    );
  }
  if (obj['swapClosedOrders'] !== undefined) {
    validateSwapHistoryMap(
      obj['swapClosedOrders'],
      `${context}.swapClosedOrders`,
      LIMITS.MAX_ACCOUNT_TERMINAL_SWAP_HISTORY,
      'ACCOUNT_TERMINAL_SWAP_HISTORY_LIMIT_EXCEEDED',
    );
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
  validatePendingAccountResend(obj, context);
  if (obj['pendingSignatures'] === undefined || obj['pendingSignatures'] === null) {
    obj['pendingSignatures'] = [];
  } else if (!Array.isArray(obj['pendingSignatures'])) {
    obj['pendingSignatures'] = [];
  } else {
    validateArray(obj['pendingSignatures'], `${context}.pendingSignatures`);
  }
  validateNumber(obj['rollbackCount'], `${context}.rollbackCount`);
  assertAccountJClaimAccumulatorState(obj['leftPendingJClaims'] as AccountMachine['leftPendingJClaims']);
  assertAccountJClaimAccumulatorState(obj['rightPendingJClaims'] as AccountMachine['rightPendingJClaims']);
  validateNumber(obj['lastFinalizedJHeight'], `${context}.lastFinalizedJHeight`);
  validateMapInstance(obj['pendingWithdrawals'], `${context}.pendingWithdrawals`);
  validateBigIntMapValues(obj['requestedRebalance'], `${context}.requestedRebalance`);
  validateRebalanceFeeStateMap(obj['requestedRebalanceFeeState'], `${context}.requestedRebalanceFeeState`);
  if (obj['rebalanceFeePolicies'] !== undefined) {
    validateRebalanceFeePolicies(obj['rebalanceFeePolicies'], `${context}.rebalanceFeePolicies`);
  }
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
  if (obj['entityCommandNonces'] !== undefined) {
    const commandNonces = validateObject(obj['entityCommandNonces'], `${context}.entityCommandNonces`);
    if (
      commandNonces['version'] !== 2 ||
      !/^0x[0-9a-f]{64}$/.test(String(commandNonces['boardHash'] ?? '')) ||
      !Number.isSafeInteger(commandNonces['boardEpoch']) ||
      Number(commandNonces['boardEpoch']) < 0
    ) {
      throw new FinancialDataCorruptionError(`${context}.entityCommandNonces header invalid`);
    }
    const bySigner = validateMapInstance(commandNonces['bySigner'], `${context}.entityCommandNonces.bySigner`);
    if (bySigner.size > LIMITS.MAX_VALIDATORS) {
      throw new FinancialDataCorruptionError(`${context}.entityCommandNonces exceeds bounded signer slots`);
    }
    for (const [rawSignerId, rawRecord] of bySigner) {
      const signerId = typeof rawSignerId === 'string' ? rawSignerId.trim().toLowerCase() : '';
      const record = rawRecord && typeof rawRecord === 'object'
        ? rawRecord as { nonce?: unknown; commandHash?: unknown }
        : null;
      if (
        !signerId ||
        Object.keys(record ?? {}).sort().join(',') !== 'commandHash,nonce' ||
        typeof record?.nonce !== 'bigint' ||
        record.nonce < 1n ||
        !/^0x[0-9a-f]{64}$/.test(String(record.commandHash ?? ''))
      ) {
        throw new FinancialDataCorruptionError(
          `${context}.entityCommandNonces contains invalid signer, nonce, or command hash`,
        );
      }
    }
  }
  if (obj['entityProviderActionState'] !== undefined) {
    const actionState = validateObject(
      obj['entityProviderActionState'],
      `${context}.entityProviderActionState`,
    );
    if (
      actionState['version'] !== 1 ||
      typeof actionState['confirmedNonce'] !== 'bigint' ||
      actionState['confirmedNonce'] < 0n ||
      actionState['confirmedNonce'] > MAX_UINT256 ||
      !Number.isSafeInteger(actionState['generation']) ||
      Number(actionState['generation']) < 0
    ) {
      throw new FinancialDataCorruptionError(`${context}.entityProviderActionState header invalid`);
    }
    if (actionState['pending'] !== undefined) {
      const pending = validateObject(
        actionState['pending'],
        `${context}.entityProviderActionState.pending`,
      );
      validateObject(pending['payload'], `${context}.entityProviderActionState.pending.payload`);
      if (
        typeof pending['actionNonce'] !== 'bigint' ||
        pending['actionNonce'] !== actionState['confirmedNonce'] + 1n ||
        pending['generation'] !== actionState['generation']
      ) {
        throw new FinancialDataCorruptionError(`${context}.entityProviderActionState.pending invalid`);
      }
      const jurisdiction = (obj['config'] as ConsensusConfig).jurisdiction;
      if (!jurisdiction || !jurisdiction.chainId) {
        throw new FinancialDataCorruptionError(`${context}.entityProviderActionState jurisdiction missing`);
      }
      try {
        assertEntityProviderActionIntent(pending as unknown as EntityProviderActionIntent, {
          chainId: jurisdiction.chainId,
          entityProviderAddress: jurisdiction.entityProviderAddress,
          depositoryAddress: jurisdiction.depositoryAddress,
          entityId: String(obj['entityId']),
        });
      } catch (error) {
        throw new FinancialDataCorruptionError(
          `${context}.entityProviderActionState.pending cryptographic binding invalid`,
          { cause: error instanceof Error ? error.message : String(error) },
        );
      }
    }
  }
  const messages = validateArray(obj['messages'], `${context}.messages`);
  if (messages.length > LIMITS.MESSAGE_HISTORY || messages.some(message => typeof message !== 'string')) {
    throw new FinancialDataCorruptionError(
      `${context}.messages must contain at most ${LIMITS.MESSAGE_HISTORY} strings`,
    );
  }
  const proposals = validateMapInstance(obj['proposals'], `${context}.proposals`);
  if (proposals.size > LIMITS.MAX_PROPOSALS_PER_ENTITY) {
    throw new FinancialDataCorruptionError(
      `${context}.proposals exceeds ${LIMITS.MAX_PROPOSALS_PER_ENTITY} bounded entries`,
    );
  }
  let pendingProposalCount = 0;
  let terminalProposalCount = 0;
  const pendingByProposer = new Set<string>();
  for (const [rawProposalId, rawProposal] of proposals) {
    const proposalId = typeof rawProposalId === 'string' ? rawProposalId : '';
    const proposal = validateObject(rawProposal, `${context}.proposals[${proposalId || 'invalid'}]`);
    const proposer = typeof proposal['proposer'] === 'string'
      ? proposal['proposer'].trim().toLowerCase()
      : '';
    const status = proposal['status'];
    const boardHash = String(proposal['boardHash'] ?? '').toLowerCase();
    const boardEpoch = proposal['boardEpoch'];
    const actionHash = String(proposal['actionHash'] ?? '').toLowerCase();
    const created = proposal['created'];
    if (
      !/^prop_[0-9a-f]{64}$/.test(proposalId) ||
      proposal['id'] !== proposalId ||
      !proposer ||
      !/^0x[0-9a-f]{64}$/.test(boardHash) ||
      !Number.isSafeInteger(boardEpoch) ||
      Number(boardEpoch) < 0 ||
      !/^0x[0-9a-f]{64}$/.test(actionHash) ||
      !(proposal['votes'] instanceof Map) ||
      (proposal['votes'] as Map<unknown, unknown>).size > LIMITS.MAX_VALIDATORS ||
      !Number.isSafeInteger(created) ||
      Number(created) < 0 ||
      (status !== 'pending' && status !== 'executed' && status !== 'rejected')
    ) {
      throw new FinancialDataCorruptionError(`${context}.proposals[${proposalId || 'invalid'}] invalid`);
    }
    if (status === 'pending') {
      pendingProposalCount += 1;
      if (pendingByProposer.has(proposer)) {
        throw new FinancialDataCorruptionError(`${context}.proposals has multiple pending entries for ${proposer}`);
      }
      pendingByProposer.add(proposer);
    } else {
      terminalProposalCount += 1;
    }
  }
  if (
    pendingProposalCount > LIMITS.MAX_PENDING_PROPOSALS_PER_ENTITY ||
    terminalProposalCount > LIMITS.MAX_TERMINAL_PROPOSALS_PER_ENTITY
  ) {
    throw new FinancialDataCorruptionError(
      `${context}.proposals pending/terminal bounds exceeded`,
      { pendingProposalCount, terminalProposalCount },
    );
  }
  if (obj['profileEncryptionManifest'] !== undefined) {
    try {
      validatePersistedValidatorEncryptionManifest(
        obj['entityId'] as string,
        obj['config'] as ConsensusConfig,
        obj['profileEncryptionManifest'] as never,
      );
    } catch (error) {
      throw new FinancialDataCorruptionError(
        `${context}.profileEncryptionManifest invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
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
  assertEntityAccountCountWithinLimit(
    obj['accounts'] as Map<string, unknown>,
    `${context}.accounts`,
  );
  if (obj['htlcNotes'] !== undefined) {
    const notes = validateMapInstance(obj['htlcNotes'], `${context}.htlcNotes`);
    if (notes.size > LIMITS.MAX_ENTITY_HTLC_NOTES) {
      throw new FinancialDataCorruptionError(
        `ENTITY_HTLC_NOTE_LIMIT_EXCEEDED:${context}:size=${notes.size}:max=${LIMITS.MAX_ENTITY_HTLC_NOTES}`,
      );
    }
    for (const [key, note] of notes) {
      if (
        typeof key !== 'string' ||
        key.length > LIMITS.MAX_ENTITY_HTLC_NOTE_LENGTH ||
        (!key.startsWith('hashlock:') && !key.startsWith('lock:')) ||
        key.endsWith(':')
      ) {
        throw new FinancialDataCorruptionError(`${context}.htlcNotes contains invalid key`);
      }
      if (
        typeof note !== 'string' ||
        note.length === 0 ||
        note.length > LIMITS.MAX_ENTITY_HTLC_NOTE_LENGTH
      ) {
        throw new FinancialDataCorruptionError(`${context}.htlcNotes contains invalid note`);
      }
    }
  }
  if (obj['deferredAccountProposals'] !== undefined) {
    const deferred = validateMapInstance(
      obj['deferredAccountProposals'],
      `${context}.deferredAccountProposals`,
    );
    if (deferred.size > LIMITS.MAX_ACCOUNTS_PER_ENTITY) {
      throw new FinancialDataCorruptionError(
        `${context}.deferredAccountProposals exceeds ${LIMITS.MAX_ACCOUNTS_PER_ENTITY}`,
      );
    }
    for (const [rawAccountId, rawWorkspaceHash] of deferred) {
      const accountId = String(rawAccountId ?? '');
      const workspaceHash = String(rawWorkspaceHash ?? '');
      if (!/^0x[0-9a-f]{64}$/.test(accountId) || accountId !== rawAccountId) {
        throw new FinancialDataCorruptionError(`${context}.deferredAccountProposals account invalid`);
      }
      if (!(obj['accounts'] as Map<string, unknown>).has(accountId)) {
        throw new FinancialDataCorruptionError(`${context}.deferredAccountProposals account missing`);
      }
      if (!/^0x[0-9a-f]{64}$/.test(workspaceHash) || workspaceHash !== rawWorkspaceHash) {
        throw new FinancialDataCorruptionError(`${context}.deferredAccountProposals workspace hash invalid`);
      }
    }
  }

  if (obj['consumptionAccumulator'] !== undefined) {
    try {
      assertConsumptionAccumulatorState(
        obj['consumptionAccumulator'] as NonNullable<EntityState['consumptionAccumulator']>,
      );
    } catch (error) {
      throw new FinancialDataCorruptionError(
        `${context}.consumptionAccumulator invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (obj['certifiedOutputSequences'] !== undefined) {
    const sequences = obj['certifiedOutputSequences'];
    if (!(sequences instanceof Map)) {
      throw new FinancialDataCorruptionError(`${context}.certifiedOutputSequences must be a Map`);
    }
    if (sequences.size > LIMITS.MAX_ACCOUNTS_PER_ENTITY) {
      throw new FinancialDataCorruptionError(
        `${context}.certifiedOutputSequences exceeds ${LIMITS.MAX_ACCOUNTS_PER_ENTITY}`,
      );
    }
    for (const [rawTarget, rawFrontier] of sequences) {
      const target = String(rawTarget ?? '').toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(target) || target !== rawTarget) {
        throw new FinancialDataCorruptionError(`${context}.certifiedOutputSequences target invalid`);
      }
      const frontier = validateObject(rawFrontier, `${context}.certifiedOutputSequences.${target}`);
      if (Object.keys(frontier).sort().join(',') !== 'lastSemanticHash,lastSequence') {
        throw new FinancialDataCorruptionError(`${context}.certifiedOutputSequences.${target} fields invalid`);
      }
      if (typeof frontier['lastSequence'] !== 'bigint' || frontier['lastSequence'] < 1n) {
        throw new FinancialDataCorruptionError(`${context}.certifiedOutputSequences.${target} sequence invalid`);
      }
      if (!/^0x[0-9a-f]{64}$/.test(String(frontier['lastSemanticHash'] ?? ''))) {
        throw new FinancialDataCorruptionError(`${context}.certifiedOutputSequences.${target} hash invalid`);
      }
    }
  }

  if (obj['certifiedBoardState'] !== undefined) {
    const registry = validateObject(obj['certifiedBoardState'], `${context}.certifiedBoardState`);
    const stackKey = String(registry['stackKey'] ?? '');
    const root = String(registry['boardRegistryRoot'] ?? '');
    const blockHash = String(registry['finalizedJBlockHash'] ?? '');
    const historyRoot = String(registry['eventHistoryRoot'] ?? '');
    const height = validateNumber(registry['finalizedJHeight'], `${context}.certifiedBoardState.finalizedJHeight`);
    if (
      !/^0x[0-9a-f]{64}$/.test(stackKey) ||
      !/^0x[0-9a-f]{64}$/.test(root) ||
      !/^0x[0-9a-f]{64}$/.test(blockHash) ||
      !/^0x[0-9a-f]{64}$/.test(historyRoot) ||
      !Number.isSafeInteger(height) ||
      height < 0
    ) {
      throw new FinancialDataCorruptionError(`${context}.certifiedBoardState invalid`);
    }
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

const J_PREFIX_CLAIM_KEYS = [
  'jurisdictionRef',
  'baseHeight',
  'scannedThroughHeight',
  'tipBlockHash',
  'eventHistoryRoot',
  'rangeHash',
  'blocks',
] as const;

const validateJPrefixClaim = (value: unknown, context: string): Record<string, unknown> => {
  const claim = validateObject(value, context);
  for (const key of ['jurisdictionRef', 'tipBlockHash', 'eventHistoryRoot', 'rangeHash'] as const) {
    validateString(claim[key], `${context}.${key}`);
  }
  for (const key of ['baseHeight', 'scannedThroughHeight'] as const) {
    const height = validateNumber(claim[key], `${context}.${key}`);
    if (!Number.isSafeInteger(height) || height < 0) {
      throw new FinancialDataCorruptionError(`${context}.${key} must be a non-negative safe integer`);
    }
  }
  validateArray(claim['blocks'], `${context}.blocks`);
  return claim;
};

const validateJPrefixAttestation = (value: unknown, context: string): void => {
  const attestation = validateJPrefixClaim(value, context);
  rejectUnexpectedKeys(attestation, [
    ...J_PREFIX_CLAIM_KEYS,
    'version',
    'entityId',
    'targetEntityHeight',
    'parentFrameHash',
    'validatorId',
    'headers',
    'signature',
  ], context);
  if (attestation['version'] !== 1) throw new FinancialDataCorruptionError(`${context}.version must be 1`);
  validateString(attestation['entityId'], `${context}.entityId`);
  validateString(attestation['parentFrameHash'], `${context}.parentFrameHash`);
  validateString(attestation['validatorId'], `${context}.validatorId`);
  validateString(attestation['signature'], `${context}.signature`);
  const targetHeight = validateNumber(attestation['targetEntityHeight'], `${context}.targetEntityHeight`);
  if (!Number.isSafeInteger(targetHeight) || targetHeight <= 0) {
    throw new FinancialDataCorruptionError(`${context}.targetEntityHeight must be a positive safe integer`);
  }
  const headers = validateArray<Record<string, unknown>>(attestation['headers'], `${context}.headers`);
  headers.forEach((headerValue, index) => {
    const header = validateObject(headerValue, `${context}.headers[${index}]`);
    rejectUnexpectedKeys(header, ['jHeight', 'jBlockHash'], `${context}.headers[${index}]`);
    validateNumber(header['jHeight'], `${context}.headers[${index}].jHeight`);
    validateString(header['jBlockHash'], `${context}.headers[${index}].jBlockHash`);
  });
};

const validateJPrefixCertificate = (value: unknown, context: string): void => {
  const certificate = validateObject(value, context);
  rejectUnexpectedKeys(certificate, [
    'version',
    'entityId',
    'targetEntityHeight',
    'parentFrameHash',
    'jurisdictionRef',
    'baseHeight',
    'selected',
    'attestations',
  ], context);
  if (certificate['version'] !== 1) throw new FinancialDataCorruptionError(`${context}.version must be 1`);
  validateString(certificate['entityId'], `${context}.entityId`);
  validateString(certificate['parentFrameHash'], `${context}.parentFrameHash`);
  validateString(certificate['jurisdictionRef'], `${context}.jurisdictionRef`);
  validateNumber(certificate['targetEntityHeight'], `${context}.targetEntityHeight`);
  validateNumber(certificate['baseHeight'], `${context}.baseHeight`);
  const selected = validateJPrefixClaim(certificate['selected'], `${context}.selected`);
  rejectUnexpectedKeys(selected, [...J_PREFIX_CLAIM_KEYS], `${context}.selected`);
  const attestations = validateMapInstance(certificate['attestations'], `${context}.attestations`);
  if (attestations.size === 0) throw new FinancialDataCorruptionError(`${context}.attestations cannot be empty`);
  for (const [signerId, attestation] of attestations) {
    validateString(signerId, `${context}.attestations.signerId`);
    validateJPrefixAttestation(attestation, `${context}.attestations[${String(signerId)}]`);
  }
};

export function validateProposedEntityFrame(value: unknown, context: string): ProposedEntityFrame {
  const obj = validateObject(value, context);
  rejectUnexpectedKeys(obj, [
    'height',
    'parentFrameHash',
    'stateRoot',
    'authorityRoot',
    'timestamp',
    'txs',
    'hash',
    'leader',
    'jPrefixCertificate',
    'hashesToSign',
    'collectedSigs',
    'hankos',
  ], context);
  validateNumber(obj['height'], `${context}.height`);
  validateString(obj['parentFrameHash'], `${context}.parentFrameHash`);
  const stateRoot = validateString(obj['stateRoot'], `${context}.stateRoot`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(stateRoot)) {
    throw new FinancialDataCorruptionError(`${context}.stateRoot must be bytes32 hex`);
  }
  const authorityRoot = validateString(obj['authorityRoot'], `${context}.authorityRoot`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(authorityRoot)) {
    throw new FinancialDataCorruptionError(`${context}.authorityRoot must be bytes32 hex`);
  }
  const timestamp = validateNumber(obj['timestamp'], `${context}.timestamp`);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new FinancialDataCorruptionError(`${context}.timestamp must be a non-negative safe integer`);
  }
  validateArray(obj['txs'], `${context}.txs`);
  validateString(obj['hash'], `${context}.hash`);
  if ('newState' in obj) {
    throw new FinancialDataCorruptionError(`${context}.newState is forbidden on the proposal boundary`);
  }
  const leader = validateObject(obj['leader'], `${context}.leader`);
  rejectUnexpectedKeys(
    leader,
    ['proposerSignerId', 'view', 'certificate', 'relayCertificate'],
    `${context}.leader`,
  );
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
  if (obj['jPrefixCertificate'] !== undefined) {
    validateJPrefixCertificate(obj['jPrefixCertificate'], `${context}.jPrefixCertificate`);
  }
  if ('outputs' in obj || 'jOutputs' in obj) {
    throw new FinancialDataCorruptionError(`${context} cannot carry proposer-supplied execution outputs`);
  }
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

const SUBMIT_RESULT_FINGERPRINT_LIMIT = 256;
const SUBMIT_RESULT_OUTCOMES = new Set([
  'submitted',
  'transientFailure',
  'terminalFailure',
  'reconciled',
]);

const validateSafeInteger = (
  value: unknown,
  context: string,
  minimum: number,
): number => {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new FinancialDataCorruptionError(
      `${context} must be a safe integer >= ${minimum}`,
    );
  }
  return Number(value);
};

const validateNonEmptyString = (value: unknown, context: string): string => {
  const validated = validateString(value, context);
  if (!validated.trim()) {
    throw new FinancialDataCorruptionError(`${context} must be non-empty`);
  }
  return validated;
};

const validateAdapterFailure = (value: unknown, context: string): void => {
  const failure = validateObject(value, context);
  rejectUnexpectedKeys(failure, ['category', 'code', 'message'], context);
  if (failure['category'] !== 'transient' && failure['category'] !== 'terminal') {
    throw new FinancialDataCorruptionError(`${context}.category invalid`);
  }
  validateNonEmptyString(failure['code'], `${context}.code`);
  validateNonEmptyString(failure['message'], `${context}.message`);
};

const validateSubmitFailure = (
  value: unknown,
  context: string,
  requireRuntimeFailure: boolean,
): void => {
  const failure = validateObject(value, context);
  const allowed = requireRuntimeFailure
    ? ['message', 'failedAt', 'failure', 'adapterFailure']
    : ['message', 'failedAt', 'adapterFailure'];
  rejectUnexpectedKeys(failure, allowed, context);
  const message = validateNonEmptyString(failure['message'], `${context}.message`);
  validateSafeInteger(failure['failedAt'], `${context}.failedAt`, 0);
  if (requireRuntimeFailure) {
    const signal = failure['failure'];
    if (!isRuntimeFailureSignal(signal)) {
      throw new FinancialDataCorruptionError(`${context}.failure must be canonical RuntimeFailureSignal`);
    }
    rejectUnexpectedKeys(
      signal as unknown as Record<string, unknown>,
      ['category', 'code', 'message', 'retryable', 'fatal'],
      `${context}.failure`,
    );
  }
  if (failure['adapterFailure'] !== undefined) {
    validateAdapterFailure(failure['adapterFailure'], `${context}.adapterFailure`);
    const adapterMessage = (failure['adapterFailure'] as Record<string, unknown>)['message'];
    if (adapterMessage !== message) {
      throw new FinancialDataCorruptionError(`${context}.adapterFailure.message must match message`);
    }
  }
};

const validateSubmitResultJournal = (
  state: Record<string, unknown>,
  context: string,
): void => {
  const fingerprintsValue = state['resultFingerprints'];
  const orderValue = state['resultFingerprintOrder'];
  if ((fingerprintsValue === undefined) !== (orderValue === undefined)) {
    throw new FinancialDataCorruptionError(`${context} fingerprint map/order must coexist`);
  }
  if (fingerprintsValue !== undefined) {
    const fingerprints = validateObject(fingerprintsValue, `${context}.resultFingerprints`);
    const ids = Object.keys(fingerprints);
    const order = validateArray(orderValue, `${context}.resultFingerprintOrder`);
    if (ids.length > SUBMIT_RESULT_FINGERPRINT_LIMIT || order.length > SUBMIT_RESULT_FINGERPRINT_LIMIT) {
      throw new FinancialDataCorruptionError(
        `${context} exceeds ${SUBMIT_RESULT_FINGERPRINT_LIMIT} result fingerprints`,
      );
    }
    const seen = new Set<string>();
    for (const [attemptId, fingerprint] of Object.entries(fingerprints)) {
      validateNonEmptyString(attemptId, `${context}.resultFingerprints key`);
      validateNonEmptyString(fingerprint, `${context}.resultFingerprints[${attemptId}]`);
    }
    for (let index = 0; index < order.length; index += 1) {
      const attemptId = validateNonEmptyString(order[index], `${context}.resultFingerprintOrder[${index}]`);
      if (seen.has(attemptId)) {
        throw new FinancialDataCorruptionError(`${context}.resultFingerprintOrder contains duplicate ${attemptId}`);
      }
      if (!Object.prototype.hasOwnProperty.call(fingerprints, attemptId)) {
        throw new FinancialDataCorruptionError(`${context}.resultFingerprintOrder contains unknown ${attemptId}`);
      }
      seen.add(attemptId);
    }
    if (seen.size !== ids.length) {
      throw new FinancialDataCorruptionError(`${context}.resultFingerprintOrder is incomplete`);
    }
  }

  const hasLastAttempt = state['lastResultAttemptId'] !== undefined;
  const hasAnyLastResult = hasLastAttempt || [
    'lastResultAt',
    'lastResultOutcome',
    'lastResultFingerprint',
  ].some((field) => state[field] !== undefined);
  if (hasAnyLastResult) {
    validateNonEmptyString(state['lastResultAttemptId'], `${context}.lastResultAttemptId`);
    validateSafeInteger(state['lastResultAt'], `${context}.lastResultAt`, 0);
    if (!SUBMIT_RESULT_OUTCOMES.has(String(state['lastResultOutcome'] ?? ''))) {
      throw new FinancialDataCorruptionError(`${context}.lastResultOutcome invalid`);
    }
    const fingerprint = validateNonEmptyString(
      state['lastResultFingerprint'],
      `${context}.lastResultFingerprint`,
    );
    const journal = state['resultFingerprints'];
    if (
      journal !== undefined &&
      (journal as Record<string, unknown>)[String(state['lastResultAttemptId'])] !== fingerprint
    ) {
      throw new FinancialDataCorruptionError(`${context}.last result must match fingerprint journal`);
    }
  }
};

function validateJSubmitState(value: unknown, context: string): void {
  const state = validateObject(value, context);
  rejectUnexpectedKeys(state, [
    'jurisdictionName', 'batchHash', 'entityNonce', 'batchGeneration',
    'submitAttempts', 'lastSubmittedAt', 'txHash', 'lastFailure',
    'terminalFailure', 'lastResultAttemptId', 'lastResultAt',
    'lastResultOutcome', 'lastResultFingerprint', 'resultFingerprints',
    'resultFingerprintOrder',
  ], context);
  validateNonEmptyString(state['jurisdictionName'], `${context}.jurisdictionName`);
  const batchHash = validateNonEmptyString(state['batchHash'], `${context}.batchHash`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(batchHash)) {
    throw new FinancialDataCorruptionError(`${context}.batchHash must be bytes32 hex`);
  }
  validateSafeInteger(state['entityNonce'], `${context}.entityNonce`, 0);
  validateSafeInteger(state['batchGeneration'], `${context}.batchGeneration`, 1);
  validateSafeInteger(state['submitAttempts'], `${context}.submitAttempts`, 1);
  validateSafeInteger(state['lastSubmittedAt'], `${context}.lastSubmittedAt`, 0);
  if (state['txHash'] !== undefined) validateNonEmptyString(state['txHash'], `${context}.txHash`);
  if (state['lastFailure'] !== undefined) {
    validateSubmitFailure(state['lastFailure'], `${context}.lastFailure`, true);
  }
  if (state['terminalFailure'] !== undefined) {
    validateSubmitFailure(state['terminalFailure'], `${context}.terminalFailure`, true);
  }
  validateSubmitResultJournal(state, context);
}

function validateEntityProviderActionSubmitState(value: unknown, context: string): void {
  const state = validateObject(value, context);
  rejectUnexpectedKeys(state, [
    'jurisdictionName', 'actionHash', 'actionNonce', 'generation',
    'submitAttempts', 'lastSubmittedAt', 'txHash', 'lastFailure',
    'terminalFailure', 'lastResultAttemptId', 'lastResultAt',
    'lastResultOutcome', 'lastResultFingerprint', 'resultFingerprints',
    'resultFingerprintOrder',
  ], context);
  validateNonEmptyString(state['jurisdictionName'], `${context}.jurisdictionName`);
  const actionHash = validateNonEmptyString(state['actionHash'], `${context}.actionHash`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(actionHash)) {
    throw new FinancialDataCorruptionError(`${context}.actionHash must be bytes32 hex`);
  }
  if (typeof state['actionNonce'] !== 'bigint' || state['actionNonce'] <= 0n || state['actionNonce'] > MAX_UINT256) {
    throw new FinancialDataCorruptionError(`${context}.actionNonce must be uint256 > 0`);
  }
  validateSafeInteger(state['generation'], `${context}.generation`, 1);
  validateSafeInteger(state['submitAttempts'], `${context}.submitAttempts`, 1);
  validateSafeInteger(state['lastSubmittedAt'], `${context}.lastSubmittedAt`, 0);
  if (state['txHash'] !== undefined) validateNonEmptyString(state['txHash'], `${context}.txHash`);
  if (state['lastFailure'] !== undefined) {
    validateSubmitFailure(state['lastFailure'], `${context}.lastFailure`, false);
  }
  if (state['terminalFailure'] !== undefined) {
    validateSubmitFailure(state['terminalFailure'], `${context}.terminalFailure`, false);
  }
  validateSubmitResultJournal(state, context);
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
  if (obj['validatorExecution'] !== undefined) {
    const execution = validateObject(obj['validatorExecution'], `${context}.validatorExecution`);
    validateString(execution['frameHash'], `${context}.validatorExecution.frameHash`);
    const executionHeight = validateNumber(execution['height'], `${context}.validatorExecution.height`);
    if (!Number.isSafeInteger(executionHeight) || executionHeight <= 0) {
      throw new FinancialDataCorruptionError(`${context}.validatorExecution.height must be a positive safe integer`);
    }
    const computed = validateEntityState(execution['state'], `${context}.validatorExecution.state`);
    if (computed.entityId !== entityId) {
      throw new FinancialDataCorruptionError(`${context}.validatorExecution.state.entityId must match replica.entityId`);
    }
    if (computed.height !== executionHeight) {
      throw new FinancialDataCorruptionError(`${context}.validatorExecution.state.height must match execution height`);
    }
    validateArray(execution['outputs'], `${context}.validatorExecution.outputs`);
    validateArray(execution['jOutputs'], `${context}.validatorExecution.jOutputs`);
    validateArray(execution['hashesToSign'], `${context}.validatorExecution.hashesToSign`);
    const storageChanges = validateArray(
      execution['storageChanges'],
      `${context}.validatorExecution.storageChanges`,
    );
    for (const [index, rawChange] of storageChanges.entries()) {
      const changeContext = `${context}.validatorExecution.storageChanges[${index}]`;
      const change = validateObject(rawChange, changeContext);
      const family = validateString(change['family'], `${changeContext}.family`);
      validateString(change['entityId'], `${changeContext}.entityId`);
      if (family === 'account') {
        assertExactFields(change, new Set(['family', 'entityId', 'counterpartyId']), changeContext);
        validateString(change['counterpartyId'], `${changeContext}.counterpartyId`);
      } else if (family === 'book') {
        assertExactFields(change, new Set(['family', 'entityId', 'pairId', 'deleted']), changeContext);
        validateString(change['pairId'], `${changeContext}.pairId`);
        if (change['deleted'] !== undefined && typeof change['deleted'] !== 'boolean') {
          throw new FinancialDataCorruptionError(`${changeContext}.deleted must be boolean`);
        }
      } else if (family === 'entity') {
        assertExactFields(change, new Set(['family', 'entityId']), changeContext);
      } else {
        throw new FinancialDataCorruptionError(`${changeContext}.family is invalid`);
      }
    }
    if (execution['consumptionNodeChanges'] !== undefined) {
      const changes = validateObject(
        execution['consumptionNodeChanges'],
        `${context}.validatorExecution.consumptionNodeChanges`,
      );
      validateArray(changes['newNodes'], `${context}.validatorExecution.consumptionNodeChanges.newNodes`);
      validateArray(
        changes['replacedNodeHashes'],
        `${context}.validatorExecution.consumptionNodeChanges.replacedNodeHashes`,
      );
    }
    if (execution['accountJClaimNodeChanges'] !== undefined) {
      const changes = validateObject(
        execution['accountJClaimNodeChanges'],
        `${context}.validatorExecution.accountJClaimNodeChanges`,
      );
      validateArray(changes['newNodes'], `${context}.validatorExecution.accountJClaimNodeChanges.newNodes`);
      validateArray(
        changes['replacedNodeHashes'],
        `${context}.validatorExecution.accountJClaimNodeChanges.replacedNodeHashes`,
      );
    }
  }
  if (obj['certifiedFrameLineage'] !== undefined) {
    const lineage = validateArray(obj['certifiedFrameLineage'], `${context}.certifiedFrameLineage`);
    lineage.forEach((linkValue, index) => {
      const link = validateObject(linkValue, `${context}.certifiedFrameLineage[${index}]`);
      validateProposedEntityFrame(link['frame'], `${context}.certifiedFrameLineage[${index}].frame`);
      const authority = validateObject(
        link['postAuthority'],
        `${context}.certifiedFrameLineage[${index}].postAuthority`,
      );
      validateObject(authority['config'], `${context}.certifiedFrameLineage[${index}].postAuthority.config`);
      validateObject(authority['leaderState'], `${context}.certifiedFrameLineage[${index}].postAuthority.leaderState`);
    });
  }
  if (obj['certifiedFrameAnchor'] !== undefined) {
    const anchor = validateObject(obj['certifiedFrameAnchor'], `${context}.certifiedFrameAnchor`);
    validateString(anchor['entityId'], `${context}.certifiedFrameAnchor.entityId`);
    validateNumber(anchor['height'], `${context}.certifiedFrameAnchor.height`);
    validateString(anchor['frameHash'], `${context}.certifiedFrameAnchor.frameHash`);
    validateString(anchor['stateRoot'], `${context}.certifiedFrameAnchor.stateRoot`);
    if (anchor['authorityEvidenceHash'] !== undefined) {
      const evidenceHash = validateString(
        anchor['authorityEvidenceHash'],
        `${context}.certifiedFrameAnchor.authorityEvidenceHash`,
      );
      if (!/^0x[0-9a-fA-F]{64}$/.test(evidenceHash)) {
        throw new FinancialDataCorruptionError(
          `${context}.certifiedFrameAnchor.authorityEvidenceHash must be bytes32 hex`,
        );
      }
    }
    if (anchor['runtimeCheckpoint'] !== undefined) {
      const checkpoint = validateObject(
        anchor['runtimeCheckpoint'],
        `${context}.certifiedFrameAnchor.runtimeCheckpoint`,
      );
      const runtimeHeight = validateNumber(
        checkpoint['runtimeHeight'],
        `${context}.certifiedFrameAnchor.runtimeCheckpoint.runtimeHeight`,
      );
      if (!Number.isSafeInteger(runtimeHeight) || runtimeHeight < 0) {
        throw new FinancialDataCorruptionError(
          `${context}.certifiedFrameAnchor.runtimeCheckpoint.runtimeHeight must be a non-negative safe integer`,
        );
      }
      const replicaSetRoot = validateString(
        checkpoint['replicaSetRoot'],
        `${context}.certifiedFrameAnchor.runtimeCheckpoint.replicaSetRoot`,
      );
      if (!/^0x[0-9a-fA-F]{64}$/.test(replicaSetRoot)) {
        throw new FinancialDataCorruptionError(
          `${context}.certifiedFrameAnchor.runtimeCheckpoint.replicaSetRoot must be bytes32 hex`,
        );
      }
    }
    const authority = validateObject(anchor['authority'], `${context}.certifiedFrameAnchor.authority`);
    validateObject(authority['config'], `${context}.certifiedFrameAnchor.authority.config`);
    validateObject(authority['leaderState'], `${context}.certifiedFrameAnchor.authority.leaderState`);
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
  if (obj['jPrefixRound'] !== undefined) {
    const round = validateObject(obj['jPrefixRound'], `${context}.jPrefixRound`);
    rejectUnexpectedKeys(
      round,
      ['targetEntityHeight', 'parentFrameHash', 'jurisdictionRef', 'baseHeight', 'attestations', 'certificate'],
      `${context}.jPrefixRound`,
    );
    validateNumber(round['targetEntityHeight'], `${context}.jPrefixRound.targetEntityHeight`);
    validateString(round['parentFrameHash'], `${context}.jPrefixRound.parentFrameHash`);
    validateString(round['jurisdictionRef'], `${context}.jPrefixRound.jurisdictionRef`);
    validateNumber(round['baseHeight'], `${context}.jPrefixRound.baseHeight`);
    const attestations = validateMapInstance(round['attestations'], `${context}.jPrefixRound.attestations`);
    for (const [signerId, attestation] of attestations) {
      validateString(signerId, `${context}.jPrefixRound.attestations.signerId`);
      validateJPrefixAttestation(attestation, `${context}.jPrefixRound.attestations[${String(signerId)}]`);
    }
    if (round['certificate'] !== undefined) {
      validateJPrefixCertificate(round['certificate'], `${context}.jPrefixRound.certificate`);
    }
  }
  if (obj['jSubmitState'] !== undefined) {
    validateJSubmitState(obj['jSubmitState'], `${context}.jSubmitState`);
  }
  if (obj['entityProviderActionSubmitState'] !== undefined) {
    validateEntityProviderActionSubmitState(
      obj['entityProviderActionSubmitState'],
      `${context}.entityProviderActionSubmitState`,
    );
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
