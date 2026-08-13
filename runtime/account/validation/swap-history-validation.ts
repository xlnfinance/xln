import { LIMITS } from '../../config/constants';
import type { SwapOrderHistoryEntry, SwapOrderResolveHistoryEntry } from '../../types/account';
import {
  FinancialDataCorruptionError,
  validateArray,
  validateMapInstance,
  validateObject,
} from '../../protocol/boundary/validation-primitives';

const HISTORY_FIELDS = new Set([
  'offerId', 'giveTokenId', 'giveAmount', 'originalGiveAmount', 'wantTokenId',
  'wantAmount', 'originalWantAmount', 'priceTicks', 'createdHeight',
  'crossJurisdiction', 'cancelRequested', 'lastUpdatedHeight', 'resolves',
]);
const RESOLVE_FIELDS = new Set([
  'fillRatio', 'fillNumerator', 'fillDenominator', 'cancelRemainder', 'height',
  'executionGiveAmount', 'executionWantAmount', 'feeTokenId', 'feeAmount',
  'comment',
]);

const assertExactFields = (
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  context: string,
): void => {
  const unexpected = Object.keys(value).filter(field => !allowed.has(field));
  if (unexpected.length > 0) {
    throw new FinancialDataCorruptionError(
      `${context} contains unexpected fields: ${unexpected.sort().join(',')}`,
    );
  }
};

const assertOptionalAmount = (value: unknown, context: string): void => {
  if (value !== undefined && (typeof value !== 'bigint' || value < 0n)) {
    throw new FinancialDataCorruptionError(
      `${context} must be a non-negative bigint`,
    );
  }
};

const assertResolve: (
  resolve: Record<string, unknown>,
  context: string,
) => asserts resolve is Record<string, unknown> & SwapOrderResolveHistoryEntry = (
  resolve,
  context,
) => {
  assertExactFields(resolve, RESOLVE_FIELDS, context);
  const ratio = resolve['fillRatio'];
  if (typeof ratio !== 'number' || !Number.isInteger(ratio) || ratio < 0 || ratio > 0xffff) {
    throw new FinancialDataCorruptionError(`${context}.fillRatio must be uint16`);
  }
  if (typeof resolve['cancelRemainder'] !== 'boolean') {
    throw new FinancialDataCorruptionError(`${context}.cancelRemainder must be boolean`);
  }
  const height = resolve['height'];
  if (typeof height !== 'number' || !Number.isSafeInteger(height) || height < 0) {
    throw new FinancialDataCorruptionError(
      `${context}.height must be a non-negative safe integer`,
    );
  }
  for (const field of [
    'fillNumerator',
    'fillDenominator',
    'executionGiveAmount',
    'executionWantAmount',
    'feeAmount',
  ] as const) {
    assertOptionalAmount(resolve[field], `${context}.${field}`);
  }
  const feeTokenId = resolve['feeTokenId'];
  if (
    feeTokenId !== undefined &&
    (!Number.isSafeInteger(feeTokenId) || Number(feeTokenId) <= 0)
  ) {
    throw new FinancialDataCorruptionError(
      `${context}.feeTokenId must be a positive safe integer`,
    );
  }
  const comment = resolve['comment'];
  if (
    comment !== undefined &&
    (typeof comment !== 'string' ||
      comment.length > LIMITS.MAX_ACCOUNT_SWAP_HISTORY_TEXT)
  ) {
    throw new FinancialDataCorruptionError(
      `${context}.comment must be at most ${LIMITS.MAX_ACCOUNT_SWAP_HISTORY_TEXT} characters`,
    );
  }
};

const validateResolve = (
  value: unknown,
  context: string,
): SwapOrderResolveHistoryEntry => {
  const resolve = validateObject(value, context);
  assertResolve(resolve, context);
  return resolve;
};

const assertEntry: (
  key: unknown,
  entry: Record<string, unknown>,
  context: string,
) => asserts entry is Record<string, unknown> & SwapOrderHistoryEntry = (
  key,
  entry,
  context,
) => {
  assertExactFields(entry, HISTORY_FIELDS, context);
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    key.length > LIMITS.MAX_ACCOUNT_SWAP_HISTORY_TEXT ||
    key.includes(':') ||
    entry['offerId'] !== key
  ) {
    throw new FinancialDataCorruptionError(
      `${context}.offerId must exactly match its bounded Map key`,
    );
  }
  for (const field of ['giveTokenId', 'wantTokenId'] as const) {
    if (!Number.isSafeInteger(entry[field]) || Number(entry[field]) <= 0) {
      throw new FinancialDataCorruptionError(
        `${context}.${field} must be a positive safe integer`,
      );
    }
  }
  for (const field of ['giveAmount', 'wantAmount'] as const) {
    if (typeof entry[field] !== 'bigint' || entry[field] <= 0n) {
      throw new FinancialDataCorruptionError(
        `${context}.${field} must be a positive bigint`,
      );
    }
  }
  for (const field of [
    'originalGiveAmount',
    'originalWantAmount',
    'priceTicks',
  ] as const) {
    assertOptionalAmount(entry[field], `${context}.${field}`);
  }
  for (const field of ['createdHeight', 'lastUpdatedHeight'] as const) {
    if (!Number.isSafeInteger(entry[field]) || Number(entry[field]) < 0) {
      throw new FinancialDataCorruptionError(
        `${context}.${field} must be a non-negative safe integer`,
      );
    }
  }
  if (typeof entry['cancelRequested'] !== 'boolean') {
    throw new FinancialDataCorruptionError(
      `${context}.cancelRequested must be boolean`,
    );
  }
  if (
    entry['crossJurisdiction'] !== undefined &&
    (typeof entry['crossJurisdiction'] !== 'object' ||
      entry['crossJurisdiction'] === null)
  ) {
    throw new FinancialDataCorruptionError(
      `${context}.crossJurisdiction must be an object`,
    );
  }
  const resolves = validateArray(entry['resolves'], `${context}.resolves`);
  if (resolves.length > LIMITS.MAX_ACCOUNT_SWAP_RESOLVES_PER_ORDER) {
    throw new FinancialDataCorruptionError(
      `ACCOUNT_SWAP_RESOLVE_HISTORY_LIMIT_EXCEEDED:${context}`,
    );
  }
  resolves.forEach((resolve, index) => {
    validateResolve(resolve, `${context}.resolves[${index}]`);
  });
};

const validateEntry = (
  key: unknown,
  value: unknown,
  context: string,
): SwapOrderHistoryEntry => {
  const entry = validateObject(value, context);
  assertEntry(key, entry, context);
  return entry;
};

export const validateSwapHistoryMap = (
  value: unknown,
  context: string,
  maxSize: number,
  limitCode: string,
): Map<string, SwapOrderHistoryEntry> => {
  const history = validateMapInstance(value, context);
  if (history.size > maxSize) {
    throw new FinancialDataCorruptionError(
      `${limitCode}:${context}:size=${history.size}:max=${maxSize}`,
    );
  }
  const validated = new Map<string, SwapOrderHistoryEntry>();
  for (const [key, entry] of history) {
    const decoded = validateEntry(key, entry, `${context}[${String(key)}]`);
    validated.set(decoded.offerId, decoded);
  }
  return validated;
};
