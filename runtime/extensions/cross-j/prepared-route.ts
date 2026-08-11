import type { CrossJurisdictionSwapRoute } from '../../types/cross-jurisdiction';
import type { EntityState } from '../../entity/types';
import { canonicalAccountDisputeConfig } from '../../account/dispute-config';
import {
  cloneCrossJurisdictionRoute,
  deriveCrossJurisdictionPullId,
  signedCrossJurisdictionAmountForBeneficiary,
  withCanonicalCrossJurisdictionRouteHash,
} from './index';

const normalizeEntityId = (value: unknown): string => String(value ?? '').trim().toLowerCase();

const accountForLeg = (
  state: EntityState,
  route: CrossJurisdictionSwapRoute,
  leg: 'source' | 'target',
) => {
  const self = normalizeEntityId(state.entityId);
  const routeLeg = route[leg];
  const entity = normalizeEntityId(routeLeg.entityId);
  const counterparty = normalizeEntityId(routeLeg.counterpartyEntityId);
  const expectedAccount = self === entity
    ? counterparty
    : self === counterparty
      ? entity
      : '';
  if (!expectedAccount) throw new Error(`CROSS_J_PREPARED_${leg.toUpperCase()}_PARTICIPANT_INVALID:${route.orderId}`);
  const account = state.accounts.get(expectedAccount);
  if (account) return account;
  throw new Error(`CROSS_J_PREPARED_${leg.toUpperCase()}_ACCOUNT_MISSING:${route.orderId}`);
};

const routeDisputeConfig = (
  route: CrossJurisdictionSwapRoute,
  leg: 'source' | 'target',
): ReturnType<typeof canonicalAccountDisputeConfig> => canonicalAccountDisputeConfig(
  leg === 'source' ? route.sourceDisputeConfig : route.targetDisputeConfig,
);

const assertAccountClockMatchesRoute = (
  state: EntityState,
  route: CrossJurisdictionSwapRoute,
  leg: 'source' | 'target',
) => {
  const account = accountForLeg(state, route, leg);
  const actual = canonicalAccountDisputeConfig(account.state.disputeConfig);
  const expected = routeDisputeConfig(route, leg);
  if (
    actual.leftResponseSeconds !== expected.leftResponseSeconds ||
    actual.rightResponseSeconds !== expected.rightResponseSeconds
  ) {
    throw new Error(
      `CROSS_J_PREPARED_${leg.toUpperCase()}_ACCOUNT_CLOCK_MISMATCH:${route.orderId}:` +
      `actual=${actual.leftResponseSeconds},${actual.rightResponseSeconds}:` +
      `route=${expected.leftResponseSeconds},${expected.rightResponseSeconds}`,
    );
  }
  return expected;
};

const responseWindowForEntity = (
  route: CrossJurisdictionSwapRoute,
  leg: 'source' | 'target',
  entityId: string,
): number => {
  const routeLeg = route[leg];
  const leftEntity = normalizeEntityId(routeLeg.entityId) < normalizeEntityId(routeLeg.counterpartyEntityId)
    ? normalizeEntityId(routeLeg.entityId)
    : normalizeEntityId(routeLeg.counterpartyEntityId);
  const config = routeDisputeConfig(route, leg);
  return normalizeEntityId(entityId) === leftEntity
    ? config.leftResponseSeconds
    : config.rightResponseSeconds;
};

export const committedCrossJSourceResponseWindowMs = (
  state: EntityState,
  route: CrossJurisdictionSwapRoute,
): number => {
  assertAccountClockMatchesRoute(state, route, 'source');
  return responseWindowForEntity(route, 'source', route.source.counterpartyEntityId) * 1_000;
};

const committedCrossJTargetResponseWindowMs = (
  state: EntityState,
  route: CrossJurisdictionSwapRoute,
): number => {
  assertAccountClockMatchesRoute(state, route, 'target');
  return responseWindowForEntity(route, 'target', route.target.counterpartyEntityId) * 1_000;
};

/**
 * Validate the local leg's exact signed Account clock. Source and Target use
 * independent dispute starts and beneficiary windows; no cross-route minimum,
 * equality rule, or invented relay margin is protocol authority.
 */
const assertLocalCrossJDisputeClock = (
  state: EntityState,
  route: CrossJurisdictionSwapRoute,
): void => {
  const self = normalizeEntityId(state.entityId);
  const onSourceLeg = self === normalizeEntityId(route.source.entityId)
    || self === normalizeEntityId(route.source.counterpartyEntityId);
  const onTargetLeg = self === normalizeEntityId(route.target.entityId)
    || self === normalizeEntityId(route.target.counterpartyEntityId);
  if (onSourceLeg) committedCrossJSourceResponseWindowMs(state, route);
  if (onTargetLeg) committedCrossJTargetResponseWindowMs(state, route);
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
  // Route hash commits both Account clocks. This makes the cross-domain safety
  // comparison deterministic instead of trusting mutable jurisdiction config.
  assertLocalCrossJDisputeClock(state, route);
  const fullHash = assertBytes32(sourcePull.fullHash, 'CROSS_J_PREPARED_FULL_HASH_INVALID');
  const partialRoot = assertBytes32(sourcePull.partialRoot, 'CROSS_J_PREPARED_PARTIAL_ROOT_INVALID');
  assertEqual(assertBytes32(targetPull.fullHash, 'CROSS_J_PREPARED_FULL_HASH_INVALID'), fullHash, 'CROSS_J_PREPARED_FULL_HASH_MISMATCH');
  assertEqual(assertBytes32(targetPull.partialRoot, 'CROSS_J_PREPARED_PARTIAL_ROOT_INVALID'), partialRoot, 'CROSS_J_PREPARED_PARTIAL_ROOT_MISMATCH');
  return cloneCrossJurisdictionRoute(route);
};
