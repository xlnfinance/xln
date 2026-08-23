import { isLeftEntity } from '../../protocol/identity/entity-id';
import { requireBoundaryInteger } from '../../protocol/boundary-validation';
import {
  FinancialDataCorruptionError,
  validateObject,
  validateString,
} from '../../protocol/boundary/validation-primitives';
import type { AccountReplica } from '../../types/account';
import { assertAccountJClaimAccumulatorState } from '../j-claims/j-claim-accumulator';
import { assertAccountMempoolWithinLimit } from '../input/mempool';
import { validateDelta } from './delta-validation';
import { assertAccountDeltaCapacity } from '../state/delta';
import { decodeAccountFrame } from './frame-validation';
import { decodeAccountTxs } from '../tx-validation';
import { validatePendingAccountProposal } from './pending-proposal-validation';
import {
  validateRebalanceFeePolicies,
  validateRequestedRebalanceAmounts,
  validateRequestedRebalanceFeeState,
} from './rebalance-validation';
import { normalizeAccountStateDomain } from '../commitment/state-root';
import { assertSwapNetAuthorization } from '../swap/swap-net-authorization';
import { validateAccountFinancialMaps } from './financial-state-validation';
import { validateAccountStateCollection } from './collection-validation';

const LENDING_INTENTS = new Set([
  'fund',
  'borrow',
  'repay',
  'credit-grant',
  'credit-revoke',
  'close-request',
  'close-payout',
]);

const validateSwapOffers = (value: unknown, context: string): void => {
  const offers = validateAccountStateCollection(value, context);
  for (const [offerId, value] of offers) {
    const offer = validateObject(value, `${context}.${String(offerId)}`);
    try {
      assertSwapNetAuthorization({
        giveAmount: offer['giveAmount'] as bigint,
        wantAmount: offer['wantAmount'] as bigint,
        maxFee: offer['maxFee'] as bigint,
        minNetReceive: offer['minNetReceive'] as bigint,
      }, 0n, 0n, 0n, false);
    } catch (error) {
      throw new FinancialDataCorruptionError(`${context}.${String(offerId)} authorization is invalid`, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
};

const validateLendingIntents = (value: unknown, context: string): void => {
  if (value === undefined) return;
  const intents = validateAccountStateCollection(value, context);
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

const validateRebalanceState = (
  state: Record<string, unknown>,
  replica: Record<string, unknown>,
  context: string,
): void => {
  validateRequestedRebalanceAmounts(
    state['requestedRebalance'],
    `${context}.requestedRebalance`,
  );
  validateRequestedRebalanceFeeState(
    state['requestedRebalanceFeeState'],
    `${context}.requestedRebalanceFeeState`,
  );
  if (state['rebalanceFeePolicies'] !== undefined) {
    validateRebalanceFeePolicies(
      state['rebalanceFeePolicies'],
      `${context}.rebalanceFeePolicies`,
    );
  }
  const shadow = validateObject(replica['shadow'], `${context}.shadow`);
  const rebalance = validateObject(
    shadow['rebalance'],
    `${context}.shadow.rebalance`,
  );
  validateAccountStateCollection(rebalance['policy'], `${context}.shadow.rebalance.policy`);
  validateAccountStateCollection(
    rebalance['submittedAtByToken'],
    `${context}.shadow.rebalance.submittedAtByToken`,
  );
};

/**
 * Decode one bilateral Account snapshot at a trust boundary.
 * Reducers may trust the returned shape; persistence and network callers may not.
 */
function assertAccountReplica(
  account: Record<string, unknown>,
  context: string,
): asserts account is Record<string, unknown> & AccountReplica {
  const state = validateObject(account['state'], `${context}.state`);
  const left = validateString(state['leftEntity'], `${context}.state.leftEntity`);
  const right = validateString(state['rightEntity'], `${context}.state.rightEntity`);
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
    normalizeAccountStateDomain(state['domain']);
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
  const deltas = validateAccountStateCollection(state['deltas'], `${context}.state.deltas`);
  assertAccountDeltaCapacity(deltas.size, `${context}.deltas`);
  validateSwapOffers(state['swapOffers'], `${context}.state.swapOffers`);
  validateAccountFinancialMaps(state, account, context);
  validateLendingIntents(state['lendingIntents'], `${context}.state.lendingIntents`);
  requireBoundaryInteger(account['currentHeight'], `${context}.currentHeight`);
  validatePendingAccountProposal(account, context);
  requireBoundaryInteger(account['rollbackCount'], `${context}.rollbackCount`);
  assertAccountJClaimAccumulatorState(
    state['leftPendingJClaims'] as AccountReplica['state']['leftPendingJClaims'],
  );
  assertAccountJClaimAccumulatorState(
    state['rightPendingJClaims'] as AccountReplica['state']['rightPendingJClaims'],
  );
  requireBoundaryInteger(
    state['lastFinalizedJHeight'],
    `${context}.lastFinalizedJHeight`,
  );
  validateRebalanceState(state, account, context);
  for (const [tokenId, delta] of deltas) {
    validateDelta(delta, `${context}.deltas[${String(tokenId)}]`);
  }
}

export const validateAccountReplica = (
  value: unknown,
  context = 'AccountReplica',
): AccountReplica => {
  const account = validateObject(value, context);
  assertAccountReplica(account, context);
  return account;
};
