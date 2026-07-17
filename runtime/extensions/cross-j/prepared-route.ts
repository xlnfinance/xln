import type { CrossJurisdictionSwapRoute, EntityState } from '../../types';
import {
  cloneCrossJurisdictionRoute,
  CROSS_J_MIN_TARGET_RESPONSE_WINDOW_MS,
  CROSS_J_TARGET_REVEAL_SAFETY_MS,
  deriveCrossJurisdictionPullId,
  signedCrossJurisdictionAmountForBeneficiary,
  withCanonicalCrossJurisdictionRouteHash,
} from './index';

const normalizeEntityId = (value: unknown): string => String(value ?? '').trim().toLowerCase();

const sourceAccount = (state: EntityState, route: CrossJurisdictionSwapRoute) => {
  const self = normalizeEntityId(state.entityId);
  const sourceEntity = normalizeEntityId(route.source.entityId);
  const sourceCounterparty = normalizeEntityId(route.source.counterpartyEntityId);
  const expectedAccount = self === sourceEntity
    ? sourceCounterparty
    : self === sourceCounterparty
      ? sourceEntity
      : '';
  if (!expectedAccount) throw new Error(`CROSS_J_PREPARED_SOURCE_PARTICIPANT_INVALID:${route.orderId}`);
  for (const [accountId, account] of state.accounts) {
    if (normalizeEntityId(accountId) === expectedAccount) return account;
  }
  throw new Error(`CROSS_J_PREPARED_SOURCE_ACCOUNT_MISSING:${route.orderId}`);
};

export const committedCrossJSourceDisputeDelayMs = (
  state: EntityState,
  route: CrossJurisdictionSwapRoute,
): number => {
  const blockTimeMs = Number(state.config.jurisdiction?.blockTimeMs);
  if (!Number.isSafeInteger(blockTimeMs) || blockTimeMs <= 0) {
    throw new Error(`CROSS_J_PREPARED_BLOCK_TIME_MISSING:${route.orderId}`);
  }
  const disputeConfig = sourceAccount(state, route).disputeConfig;
  const delayUnits = Math.max(
    Number(disputeConfig.leftDisputeDelay),
    Number(disputeConfig.rightDisputeDelay),
  );
  if (!Number.isSafeInteger(delayUnits) || delayUnits <= 0) {
    throw new Error(`CROSS_J_PREPARED_DISPUTE_DELAY_INVALID:${route.orderId}`);
  }
  return delayUnits * 10 * blockTimeMs;
};

const assertBytes32 = (value: unknown, code: string): string => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error(code);
  return normalized;
};

const assertEqual = (actual: unknown, expected: unknown, code: string): void => {
  if (actual !== expected) throw new Error(`${code}:expected=${String(expected)}:actual=${String(actual)}`);
};

/** Validate only public, signed preparation data; private ladder seeds never enter replay. */
export const validatePreparedCrossJurisdictionRoute = (
  state: EntityState,
  rawRoute: CrossJurisdictionSwapRoute,
): CrossJurisdictionSwapRoute => {
  const route = withCanonicalCrossJurisdictionRouteHash(rawRoute);
  const sourcePull = route.sourcePull;
  const targetPull = route.targetPull;
  if (!sourcePull || !targetPull) throw new Error(`CROSS_J_PREPARED_PULLS_MISSING:${route.orderId}`);
  assertEqual(route.status, 'target_prepared', 'CROSS_J_PREPARED_STATUS_INVALID');
  const preparedAt = Number(route.updatedAt);
  const currentTimestamp = Number(state.timestamp);
  if (!Number.isSafeInteger(preparedAt) || preparedAt <= 0) {
    throw new Error(`CROSS_J_PREPARED_TIMESTAMP_INVALID:${route.orderId}`);
  }
  // A prepared route crosses an Entity boundary, so its authenticated origin
  // timestamp is normally older than the receiving Entity frame. Future data
  // is invalid; requiring equality would make ordinary transport delay fatal.
  if (!Number.isSafeInteger(currentTimestamp) || preparedAt > currentTimestamp) {
    throw new Error(`CROSS_J_PREPARED_TIMESTAMP_FUTURE:${route.orderId}`);
  }
  assertEqual(sourcePull.pullId, deriveCrossJurisdictionPullId(route, 'source'), 'CROSS_J_PREPARED_SOURCE_PULL_ID');
  assertEqual(targetPull.pullId, deriveCrossJurisdictionPullId(route, 'target'), 'CROSS_J_PREPARED_TARGET_PULL_ID');
  assertEqual(sourcePull.tokenId, Number(route.source.tokenId), 'CROSS_J_PREPARED_SOURCE_TOKEN');
  assertEqual(targetPull.tokenId, Number(route.target.tokenId), 'CROSS_J_PREPARED_TARGET_TOKEN');
  assertEqual(sourcePull.amount, BigInt(route.source.amount), 'CROSS_J_PREPARED_SOURCE_AMOUNT');
  assertEqual(targetPull.amount, BigInt(route.target.amount), 'CROSS_J_PREPARED_TARGET_AMOUNT');
  assertEqual(
    sourcePull.signedAmount,
    signedCrossJurisdictionAmountForBeneficiary(
      route.source.counterpartyEntityId,
      route.source.entityId,
      BigInt(route.source.amount),
    ),
    'CROSS_J_PREPARED_SOURCE_SIGNED_AMOUNT',
  );
  assertEqual(
    targetPull.signedAmount,
    signedCrossJurisdictionAmountForBeneficiary(
      route.target.counterpartyEntityId,
      route.target.entityId,
      BigInt(route.target.amount),
    ),
    'CROSS_J_PREPARED_TARGET_SIGNED_AMOUNT',
  );
  const sourceDeadline = Number(route.expiresAt);
  assertEqual(sourcePull.revealedUntilTimestamp, sourceDeadline, 'CROSS_J_PREPARED_SOURCE_DEADLINE');
  const responseWindow = Math.max(
    committedCrossJSourceDisputeDelayMs(state, route),
    CROSS_J_MIN_TARGET_RESPONSE_WINDOW_MS,
  );
  assertEqual(
    targetPull.revealedUntilTimestamp,
    sourceDeadline + responseWindow + CROSS_J_TARGET_REVEAL_SAFETY_MS,
    'CROSS_J_PREPARED_TARGET_DEADLINE',
  );
  const fullHash = assertBytes32(sourcePull.fullHash, 'CROSS_J_PREPARED_FULL_HASH_INVALID');
  const partialRoot = assertBytes32(sourcePull.partialRoot, 'CROSS_J_PREPARED_PARTIAL_ROOT_INVALID');
  assertEqual(assertBytes32(targetPull.fullHash, 'CROSS_J_PREPARED_FULL_HASH_INVALID'), fullHash, 'CROSS_J_PREPARED_FULL_HASH_MISMATCH');
  assertEqual(assertBytes32(targetPull.partialRoot, 'CROSS_J_PREPARED_PARTIAL_ROOT_INVALID'), partialRoot, 'CROSS_J_PREPARED_PARTIAL_ROOT_MISMATCH');
  return cloneCrossJurisdictionRoute(route);
};
