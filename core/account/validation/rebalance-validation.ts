import { validTermNoticeSeconds } from '../config/term-notice';
import { TOKENS } from '../../config/constants';
import {
  FinancialDataCorruptionError,
  validateNumber,
  validateObject,
} from '../../protocol/boundary/validation-primitives';
import { validateAccountStateCollection } from './collection-validation';

const POLICY_SIDES = new Set(['left', 'right']);
const POLICY_FIELDS = new Set([
  'policyVersion',
  'baseFee',
  'liquidityFeeBps',
  'gasFee',
  'updatedAt',
  'noticePeriodSeconds',
  'effectiveAt',
  'previous',
]);

const assertExactFields = (value: Record<string, unknown>, allowed: ReadonlySet<string>, context: string): void => {
  const unexpected = Object.keys(value).filter(field => !allowed.has(field));
  if (unexpected.length > 0) {
    throw new FinancialDataCorruptionError(`${context} contains unexpected fields: ${unexpected.sort().join(',')}`);
  }
};

export const validateRequestedRebalanceAmounts = (value: unknown, context: string): void => {
  const amounts = validateAccountStateCollection(value, context);
  for (const [tokenId, amount] of amounts) {
    if (typeof amount !== 'bigint') {
      throw new FinancialDataCorruptionError(`${context}[${String(tokenId)}] must be bigint`, {
        key: String(tokenId),
        value: amount,
      });
    }
  }
};

export const validateRequestedRebalanceFeeState = (value: unknown, context: string): void => {
  const states = validateAccountStateCollection(value, context);
  for (const [tokenId, rawState] of states) {
    const item = `${context}[${String(tokenId)}]`;
    const state = validateObject(rawState, item);
    validateNumber(state['feeTokenId'], `${item}.feeTokenId`);
    if (typeof state['feePaidUpfront'] !== 'bigint') {
      throw new FinancialDataCorruptionError(`${item}.feePaidUpfront must be bigint`);
    }
    if (typeof state['requestedAmount'] !== 'bigint') {
      throw new FinancialDataCorruptionError(`${item}.requestedAmount must be bigint`);
    }
    validateNumber(state['policyVersion'], `${item}.policyVersion`);
    validateNumber(state['requestedAt'], `${item}.requestedAt`);
    if (typeof state['requestedByLeft'] !== 'boolean') {
      throw new FinancialDataCorruptionError(`${item}.requestedByLeft must be boolean`);
    }
  }
};

export const validateRebalanceFeePolicySnapshot = (value: unknown, context: string, previous = false): void => {
  const policy = validateObject(value, context);
  assertExactFields(
    policy,
    previous
      ? new Set([...POLICY_FIELDS].filter(field => field !== 'previous' && field !== 'effectiveAt'))
      : POLICY_FIELDS,
    context,
  );
  const noticePeriod = policy['noticePeriodSeconds'];
  if (typeof noticePeriod !== 'number' || !validTermNoticeSeconds(noticePeriod)) {
    throw new FinancialDataCorruptionError(`${context}.noticePeriodSeconds is invalid`);
  }
  if (!previous) {
    if (!Number.isSafeInteger(policy['effectiveAt']) || Number(policy['effectiveAt']) < Number(policy['updatedAt'])) {
      throw new FinancialDataCorruptionError(`${context}.effectiveAt is invalid`);
    }
    if (policy['previous'] !== undefined) {
      validateRebalanceFeePolicySnapshot(policy['previous'], `${context}.previous`, true);
      const old = validateObject(policy['previous'], `${context}.previous`);
      if (
        Number(old['policyVersion']) >= Number(policy['policyVersion']) ||
        Number(old['updatedAt']) > Number(policy['updatedAt']) ||
        Number(policy['effectiveAt']) < Number(policy['updatedAt']) + Number(old['noticePeriodSeconds']) * 1000
      ) {
        throw new FinancialDataCorruptionError(`${context}.notice is too short`);
      }
    } else if (policy['effectiveAt'] !== policy['updatedAt']) {
      throw new FinancialDataCorruptionError(`${context}.previous is missing`);
    }
  }
  if (!Number.isSafeInteger(policy['policyVersion']) || Number(policy['policyVersion']) <= 0) {
    throw new FinancialDataCorruptionError(`${context}.policyVersion is invalid`);
  }
  if (!Number.isSafeInteger(policy['updatedAt']) || Number(policy['updatedAt']) < 0) {
    throw new FinancialDataCorruptionError(`${context}.updatedAt is invalid`);
  }
  for (const fee of ['baseFee', 'liquidityFeeBps', 'gasFee'] as const) {
    if (typeof policy[fee] !== 'bigint' || policy[fee] < 0n) {
      throw new FinancialDataCorruptionError(`${context}.${fee} is invalid`);
    }
  }
  const liquidityFeeBps = policy['liquidityFeeBps'];
  if (typeof liquidityFeeBps !== 'bigint') {
    throw new FinancialDataCorruptionError(`${context}.liquidityFeeBps is invalid`);
  }
  if (liquidityFeeBps > 10_000n) {
    throw new FinancialDataCorruptionError(`${context}.liquidityFeeBps exceeds 10000`);
  }
};

export const validateRebalanceFeePolicies = (value: unknown, context: string): void => {
  const policies = validateAccountStateCollection(value, context);
  for (const [tokenId, rawSides] of policies) {
    if (!Number.isSafeInteger(tokenId) || Number(tokenId) <= 0 || Number(tokenId) > TOKENS.MAX_TOKEN_ID) {
      throw new FinancialDataCorruptionError(`${context} contains invalid tokenId ${String(tokenId)}`);
    }
    const item = `${context}[${String(tokenId)}]`;
    const sides = validateObject(rawSides, item);
    assertExactFields(sides, POLICY_SIDES, item);
    if (sides['left'] === undefined && sides['right'] === undefined) {
      throw new FinancialDataCorruptionError(`${item} must contain left or right policy`);
    }
    if (sides['left'] !== undefined) validateRebalanceFeePolicySnapshot(sides['left'], `${item}.left`);
    if (sides['right'] !== undefined) validateRebalanceFeePolicySnapshot(sides['right'], `${item}.right`);
  }
};
