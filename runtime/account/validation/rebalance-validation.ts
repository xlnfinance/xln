import { TOKENS } from '../../config/constants';
import {
  FinancialDataCorruptionError,
  validateMapInstance,
  validateNumber,
  validateObject,
} from '../../protocol/validation-primitives';

const POLICY_SIDES = new Set(['left', 'right']);
const POLICY_FIELDS = new Set([
  'policyVersion',
  'baseFee',
  'liquidityFeeBps',
  'gasFee',
  'updatedAt',
]);

const assertExactFields = (
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  context: string,
): void => {
  const unexpected = Object.keys(value).filter((field) => !allowed.has(field));
  if (unexpected.length > 0) {
    throw new FinancialDataCorruptionError(
      `${context} contains unexpected fields: ${unexpected.sort().join(',')}`,
    );
  }
};

export const validateRequestedRebalanceAmounts = (
  value: unknown,
  context: string,
): void => {
  const amounts = validateMapInstance(value, context);
  for (const [tokenId, amount] of amounts) {
    if (typeof amount !== 'bigint') {
      throw new FinancialDataCorruptionError(
        `${context}[${String(tokenId)}] must be bigint`,
        { key: String(tokenId), value: amount },
      );
    }
  }
};

export const validateRequestedRebalanceFeeState = (
  value: unknown,
  context: string,
): void => {
  const states = validateMapInstance(value, context);
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

const validatePolicy = (value: unknown, context: string): void => {
  const policy = validateObject(value, context);
  assertExactFields(policy, POLICY_FIELDS, context);
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

export const validateRebalanceFeePolicies = (
  value: unknown,
  context: string,
): void => {
  const policies = validateMapInstance(value, context);
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
    if (sides['left'] !== undefined) validatePolicy(sides['left'], `${item}.left`);
    if (sides['right'] !== undefined) validatePolicy(sides['right'], `${item}.right`);
  }
};
