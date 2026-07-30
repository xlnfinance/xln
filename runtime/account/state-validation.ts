import { LIMITS } from '../config/constants';
import { isLeftEntity } from '../protocol/entity-id';
import { requireBoundaryInteger } from '../protocol/boundary-validation';
import {
  FinancialDataCorruptionError,
  validateArray,
  validateMapInstance,
  validateObject,
  validateString,
} from '../protocol/validation-primitives';
import type { AccountReplica } from '../types/account';
import { assertAccountJClaimAccumulatorState } from './j-claim-accumulator';
import { assertAccountMempoolWithinLimit } from './mempool';
import { validateDelta } from './delta-validation';
import { assertAccountDeltaCapacity } from './delta-capacity';
import { decodeAccountFrame } from './frame-validation';
import { decodeAccountTxs } from './tx-validation';
import { validatePendingAccountResend } from './pending-resend-validation';
import {
  validateRebalanceFeePolicies,
  validateRequestedRebalanceAmounts,
  validateRequestedRebalanceFeeState,
} from './rebalance-validation';
import { normalizeAccountStateDomain } from './state-root';
import { validateSwapHistoryMap } from './swap-history-validation';

const LENDING_INTENTS = new Set([
  'fund',
  'borrow',
  'repay',
  'credit-grant',
  'credit-revoke',
  'close-request',
  'close-payout',
]);

const validateLendingIntents = (value: unknown, context: string): void => {
  if (value === undefined) return;
  const intents = validateMapInstance(value, context);
  for (const [intentId, kind] of intents) {
    if (
      typeof intentId !== 'string' ||
      typeof kind !== 'string' ||
      !LENDING_INTENTS.has(kind)
    ) {
      throw new FinancialDataCorruptionError(`${context} contains invalid receipt`, {
        intentId,
        kind,
      });
    }
  }
};

const validateSwapHistories = (
  account: Record<string, unknown>,
  context: string,
): void => {
  if (account['swapOrderHistory'] !== undefined) {
    validateSwapHistoryMap(
      account['swapOrderHistory'],
      `${context}.swapOrderHistory`,
      LIMITS.MAX_ACCOUNT_SWAP_OFFERS + LIMITS.MAX_ACCOUNT_TERMINAL_SWAP_HISTORY,
      'ACCOUNT_SWAP_HISTORY_LIMIT_EXCEEDED',
    );
  }
  if (account['swapClosedOrders'] !== undefined) {
    validateSwapHistoryMap(
      account['swapClosedOrders'],
      `${context}.swapClosedOrders`,
      LIMITS.MAX_ACCOUNT_TERMINAL_SWAP_HISTORY,
      'ACCOUNT_TERMINAL_SWAP_HISTORY_LIMIT_EXCEEDED',
    );
  }
};

const validateCreditLimits = (value: unknown, context: string): void => {
  const limits = validateObject(value, context);
  for (const side of ['ownLimit', 'peerLimit'] as const) {
    if (typeof limits[side] !== 'bigint') {
      throw new FinancialDataCorruptionError(`${context}.${side} must be bigint`);
    }
  }
};

const validatePendingSignatures = (
  account: Record<string, unknown>,
  context: string,
): void => {
  const signatures = validateArray(
    account['pendingSignatures'],
    `${context}.pendingSignatures`,
  );
  signatures.forEach((signature, index) =>
    validateString(signature, `${context}.pendingSignatures[${index}]`));
};

const validateRebalanceState = (
  account: Record<string, unknown>,
  context: string,
): void => {
  validateRequestedRebalanceAmounts(
    account['requestedRebalance'],
    `${context}.requestedRebalance`,
  );
  validateRequestedRebalanceFeeState(
    account['requestedRebalanceFeeState'],
    `${context}.requestedRebalanceFeeState`,
  );
  if (account['rebalanceFeePolicies'] !== undefined) {
    validateRebalanceFeePolicies(
      account['rebalanceFeePolicies'],
      `${context}.rebalanceFeePolicies`,
    );
  }
  const shadow = validateObject(account['shadow'], `${context}.shadow`);
  const rebalance = validateObject(
    shadow['rebalance'],
    `${context}.shadow.rebalance`,
  );
  validateMapInstance(rebalance['policy'], `${context}.shadow.rebalance.policy`);
  validateMapInstance(
    rebalance['submittedAtByToken'],
    `${context}.shadow.rebalance.submittedAtByToken`,
  );
};

/**
 * Decode one bilateral Account snapshot at a trust boundary.
 * Reducers may trust the returned shape; persistence and network callers may not.
 */
function assertAccountState(
  account: Record<string, unknown>,
  context: string,
): asserts account is Record<string, unknown> & AccountReplica {
  const left = validateString(account['leftEntity'], `${context}.leftEntity`);
  const right = validateString(account['rightEntity'], `${context}.rightEntity`);
  if (
    left !== left.trim().toLowerCase() ||
    right !== right.trim().toLowerCase()
  ) {
    throw new FinancialDataCorruptionError(
      `${context} participants must use canonical lowercase entity IDs`,
    );
  }
  if (!left || !right || !isLeftEntity(left, right)) {
    throw new FinancialDataCorruptionError(
      `${context} canonical order violated: leftEntity must be < rightEntity`,
    );
  }
  try {
    normalizeAccountStateDomain(account['domain'] as AccountReplica['domain']);
  } catch (error) {
    throw new FinancialDataCorruptionError(`${context}.domain is invalid`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  const status = validateString(account['status'], `${context}.status`);
  if (
    status !== 'active'
    && status !== 'dispute_preparing'
    && status !== 'disputed'
  ) {
    throw new FinancialDataCorruptionError(`${context}.status is invalid`);
  }
  decodeAccountTxs(account['mempool'], `${context}.mempool`);
  assertAccountMempoolWithinLimit(
    account as Pick<AccountReplica, 'mempool'>,
    `${context}.mempool`,
  );
  decodeAccountFrame(account['currentFrame'], `${context}.currentFrame`);
  const deltas = validateMapInstance(account['deltas'], `${context}.deltas`);
  assertAccountDeltaCapacity(deltas.size, `${context}.deltas`);
  validateMapInstance(account['locks'], `${context}.locks`);
  validateMapInstance(account['swapOffers'], `${context}.swapOffers`);
  if (account['pulls'] !== undefined) {
    validateMapInstance(account['pulls'], `${context}.pulls`);
  }
  validateSwapHistories(account, context);
  validateLendingIntents(account['lendingIntents'], `${context}.lendingIntents`);
  validateCreditLimits(account['globalCreditLimits'], `${context}.globalCreditLimits`);
  requireBoundaryInteger(account['currentHeight'], `${context}.currentHeight`);
  validatePendingAccountResend(account, context);
  validatePendingSignatures(account, context);
  requireBoundaryInteger(account['rollbackCount'], `${context}.rollbackCount`);
  assertAccountJClaimAccumulatorState(
    account['leftPendingJClaims'] as AccountReplica['leftPendingJClaims'],
  );
  assertAccountJClaimAccumulatorState(
    account['rightPendingJClaims'] as AccountReplica['rightPendingJClaims'],
  );
  requireBoundaryInteger(
    account['lastFinalizedJHeight'],
    `${context}.lastFinalizedJHeight`,
  );
  validateMapInstance(account['pendingWithdrawals'], `${context}.pendingWithdrawals`);
  validateRebalanceState(account, context);
  for (const [tokenId, delta] of deltas) {
    validateDelta(delta, `${context}.deltas[${String(tokenId)}]`);
  }
}

export const validateAccountState = (
  value: unknown,
  context = 'AccountReplica',
): AccountReplica => {
  const account = validateObject(value, context);
  assertAccountState(account, context);
  return account;
};
