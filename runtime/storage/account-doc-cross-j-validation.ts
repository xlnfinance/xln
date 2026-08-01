import {
  deriveCanonicalCrossJurisdictionBookOwner,
  deriveCanonicalCrossJurisdictionVenueId,
  deriveCrossJurisdictionPullId,
  getCrossJurisdictionCommittedFillAmounts,
  signedCrossJurisdictionAmountForBeneficiary,
  withCanonicalCrossJurisdictionRouteHash,
} from '../extensions/cross-j';
import { FINANCIAL, UINT16_MAX } from '../config/constants';
import type {
  CrossJurisdictionPullBinding,
  CrossJurisdictionSwapRoute,
} from '../types/cross-jurisdiction';
import {
  UINT256_MAX,
  bytes,
  integer,
  shape,
  text,
  token,
  uint,
  uint256,
} from './account-doc-validation-primitives';

const STATUSES = new Set([
  'intent', 'target_prepared', 'source_committed', 'resting', 'partially_filled',
  'clear_requested', 'clearing', 'target_locked', 'source_locked', 'source_claimed',
  'target_claimed', 'settled', 'cancelled', 'expired', 'failed',
]);
const CLEARING_POLICIES = new Set(['manual', 'full_fill', 'cancel_and_clear']);

const literal = (value: unknown, allowed: ReadonlySet<string>, code: string): string => {
  if (typeof value !== 'string' || !allowed.has(value)) throw new Error(code);
  return value;
};

const optionalRatio = (value: unknown, code: string): void => {
  if (value !== undefined) uint(value, code, UINT16_MAX);
};

const validateExactRatio = (value: Record<string, unknown>, code: string): void => {
  const numerator = value['fillNumerator'];
  const denominator = value['fillDenominator'];
  if ((numerator === undefined) !== (denominator === undefined)) throw new Error(`${code}_PAIR`);
  if (numerator === undefined) return;
  const parsedNumerator = uint256(numerator, `${code}_NUMERATOR`);
  const parsedDenominator = integer(denominator, 1n, UINT256_MAX, `${code}_DENOMINATOR`);
  if (parsedNumerator > parsedDenominator) throw new Error(`${code}_ORDER`);
};

const validateProgress = (value: Record<string, unknown>, code: string): void => {
  optionalRatio(value['cumulativeFillRatio'], `${code}_CUMULATIVE_RATIO`);
  optionalRatio(value['claimedRatio'], `${code}_CLAIMED_RATIO`);
  validateExactRatio(value, `${code}_EXACT_RATIO`);
  for (const field of ['filledSourceAmount', 'filledTargetAmount', 'sourceClaimed', 'targetClaimed']) {
    if (value[field] !== undefined) uint256(value[field], `${code}_${field}`);
  }
  if (
    typeof value['claimedRatio'] === 'number' &&
    typeof value['cumulativeFillRatio'] === 'number' &&
    value['claimedRatio'] > value['cumulativeFillRatio']
  ) throw new Error(`${code}_CLAIMED_RATIO_ORDER`);
};

const validateCloseProof = (value: unknown, code: string): Record<string, unknown> => {
  const proof = shape(value, [
    'orderId', 'routeHash', 'sourcePullId', 'targetPullId', 'fillRatio',
    'cumulativeSourceAmount', 'cumulativeTargetAmount', 'binaryHash', 'closeMode',
  ], [], code);
  text(proof['orderId'], `${code}_ORDER_ID`);
  for (const field of ['routeHash', 'sourcePullId', 'targetPullId', 'binaryHash']) bytes(proof[field], 32, `${code}_${field}`);
  uint(proof['fillRatio'], `${code}_RATIO`, UINT16_MAX);
  integer(proof['cumulativeSourceAmount'], 0n, FINANCIAL.MAX_PAYMENT_AMOUNT, `${code}_SOURCE_AMOUNT`);
  integer(proof['cumulativeTargetAmount'], 0n, FINANCIAL.MAX_PAYMENT_AMOUNT, `${code}_TARGET_AMOUNT`);
  literal(proof['closeMode'], new Set(['full', 'partial_cancel_remainder', 'pure_cancel']), `${code}_MODE`);
  return proof;
};

export const validateStoredCrossJurisdictionPullBinding = (
  value: unknown,
  code: string,
): CrossJurisdictionPullBinding => {
  const binding = shape<CrossJurisdictionPullBinding & Record<string, unknown>>(value,
    ['orderId', 'routeHash', 'leg'], [
      'sourceCloseProof', 'status', 'cumulativeFillRatio', 'fillNumerator',
      'fillDenominator', 'claimedRatio', 'filledSourceAmount', 'filledTargetAmount',
      'sourceClaimed', 'targetClaimed', 'clearingPolicy',
    ], code);
  text(binding['orderId'], `${code}_ORDER_ID`);
  bytes(binding['routeHash'], 32, `${code}_ROUTE_HASH`);
  literal(binding['leg'], new Set(['source', 'target']), `${code}_LEG`);
  if (binding['status'] !== undefined) literal(binding['status'], STATUSES, `${code}_STATUS`);
  if (binding['clearingPolicy'] !== undefined) literal(binding['clearingPolicy'], CLEARING_POLICIES, `${code}_CLEARING`);
  validateProgress(binding, code);
  if (binding['sourceCloseProof'] !== undefined) {
    const proof = validateCloseProof(binding['sourceCloseProof'], `${code}_CLOSE_PROOF`);
    if (proof['orderId'] !== binding['orderId'] || proof['routeHash'] !== binding['routeHash']) throw new Error(`${code}_CLOSE_BINDING`);
  }
  return binding;
};

const validateLeg = (value: unknown, code: string): Record<string, unknown> => {
  const leg = shape(value, ['jurisdiction', 'entityId', 'counterpartyEntityId', 'tokenId', 'amount'], [], code);
  text(leg['jurisdiction'], `${code}_JURISDICTION`, 512);
  const entityId = bytes(leg['entityId'], 32, `${code}_ENTITY`);
  const counterpartyId = bytes(leg['counterpartyEntityId'], 32, `${code}_COUNTERPARTY`);
  if (entityId === counterpartyId) throw new Error(`${code}_SELF`);
  token(leg['tokenId'], `${code}_TOKEN`);
  integer(leg['amount'], 1n, FINANCIAL.MAX_PAYMENT_AMOUNT, `${code}_AMOUNT`);
  return leg;
};

const validatePullLeg = (value: unknown, code: string): Record<string, unknown> => {
  const pull = shape(value, [
    'pullId', 'tokenId', 'amount', 'signedAmount', 'revealedUntilTimestamp',
    'fullHash', 'partialRoot',
  ], [], code);
  bytes(pull['pullId'], 32, `${code}_ID`);
  token(pull['tokenId'], `${code}_TOKEN`);
  integer(pull['amount'], 1n, FINANCIAL.MAX_PAYMENT_AMOUNT, `${code}_AMOUNT`);
  const signed = integer(pull['signedAmount'], -FINANCIAL.MAX_PAYMENT_AMOUNT, FINANCIAL.MAX_PAYMENT_AMOUNT, `${code}_SIGNED`);
  if (signed === 0n || (signed < 0n ? -signed : signed) !== pull['amount']) throw new Error(`${code}_SIGNED_AMOUNT`);
  uint(pull['revealedUntilTimestamp'], `${code}_DEADLINE`);
  bytes(pull['fullHash'], 32, `${code}_FULL_HASH`);
  bytes(pull['partialRoot'], 32, `${code}_PARTIAL_ROOT`);
  return pull;
};

const validateRoutePolicies = (route: Record<string, unknown>, code: string): void => {
  const domain = shape(route['domain'], [
    'protocol', 'hashSchema', 'sourceStackId', 'targetStackId', 'sourceAssetRef', 'targetAssetRef',
  ], ['sourceEntityProviderAddress', 'targetEntityProviderAddress', 'sourceDeltaTransformerAddress', 'targetDeltaTransformerAddress'], `${code}_DOMAIN`);
  if (domain['protocol'] !== 'xln-cross-j' || domain['hashSchema'] !== 'route-domain') throw new Error(`${code}_DOMAIN_VERSION`);
  for (const field of ['sourceStackId', 'targetStackId', 'sourceAssetRef', 'targetAssetRef']) text(domain[field], `${code}_DOMAIN_${field}`, 512);
  for (const field of ['sourceEntityProviderAddress', 'targetEntityProviderAddress', 'sourceDeltaTransformerAddress', 'targetDeltaTransformerAddress']) {
    if (domain[field] !== undefined) bytes(domain[field], 20, `${code}_DOMAIN_${field}`);
  }
  const policy = shape(route['settlementPolicy'], ['roundingMode', 'maxSourceDust', 'maxTargetDust'], ['minSourceFillAmount', 'minTargetFillAmount'], `${code}_SETTLEMENT_POLICY`);
  if (policy['roundingMode'] !== 'uint16_ceil') throw new Error(`${code}_ROUNDING`);
  uint256(policy['maxSourceDust'], `${code}_SOURCE_DUST`); uint256(policy['maxTargetDust'], `${code}_TARGET_DUST`);
  if (policy['minSourceFillAmount'] !== undefined) integer(policy['minSourceFillAmount'], 1n, FINANCIAL.MAX_PAYMENT_AMOUNT, `${code}_MIN_SOURCE`);
  if (policy['minTargetFillAmount'] !== undefined) integer(policy['minTargetFillAmount'], 1n, FINANCIAL.MAX_PAYMENT_AMOUNT, `${code}_MIN_TARGET`);
  const time = shape(route['timePolicy'], ['runtimeClock', 'settlementClock', 'deadlineConversion', 'runtimeExpiresAtMs', 'finalityPolicy'], [], `${code}_TIME_POLICY`);
  if (time['runtimeClock'] !== 'unix_ms' || time['settlementClock'] !== 'unix_seconds' || time['deadlineConversion'] !== 'floor_ms_to_unix_seconds' || time['finalityPolicy'] !== 'source_deadline_then_target_safety') throw new Error(`${code}_TIME_POLICY_VERSION`);
  uint(time['runtimeExpiresAtMs'], `${code}_RUNTIME_EXPIRES`);
};

const validateRouteOptionals = (route: Record<string, unknown>, code: string): void => {
  for (const field of ['sourceSignerId', 'sourceHubSignerId', 'targetHubSignerId', 'targetSignerId', 'bookHubSignerId']) if (route[field] !== undefined) bytes(route[field], 20, `${code}_${field}`);
  if (route['priceTicks'] !== undefined) integer(route['priceTicks'], 1n, UINT256_MAX, `${code}_PRICE`);
  for (const field of ['fillSeq', 'pendingClearRequestedAt', 'expiresAt', 'settledAt']) if (route[field] !== undefined) uint(route[field], `${code}_${field}`);
  optionalRatio(route['cumulativeFillRatio'], `${code}_CUMULATIVE_RATIO`);
  optionalRatio(route['claimedRatio'], `${code}_CLAIMED_RATIO`);
  validateProgress(route, code);
  if (route['priceImprovementSourceAmount'] !== undefined) uint256(route['priceImprovementSourceAmount'], `${code}_PRICE_IMPROVEMENT`);
  if (route['clearingPolicy'] !== undefined) literal(route['clearingPolicy'], CLEARING_POLICIES, `${code}_CLEARING`);
  if (route['priceImprovementMode'] !== undefined && route['priceImprovementMode'] !== 'source_savings') throw new Error(`${code}_PRICE_MODE`);
  if (route['riskMode'] !== 'fully_collateralized') throw new Error(`${code}_RISK_MODE`);
  if (route['error'] !== undefined) text(route['error'], `${code}_ERROR`, 1_024);
  if (route['memo'] !== undefined) text(route['memo'], `${code}_MEMO`, 256);
};

export const validateStoredCrossJurisdictionRoute = (
  value: unknown,
  code: string,
): CrossJurisdictionSwapRoute => {
  const route = shape<CrossJurisdictionSwapRoute & Record<string, unknown>>(value,
    ['orderId', 'makerEntityId', 'hubEntityId', 'source', 'target', 'status', 'createdAt', 'updatedAt'], [
      'routeHash', 'bookOwnerEntityId', 'venueId', 'sourceSignerId', 'sourceHubSignerId',
      'targetHubSignerId', 'targetSignerId', 'bookHubSignerId', 'sourcePull', 'targetPull',
      'sourceCloseProof', 'targetCloseProof', 'priceTicks', 'fillSeq', 'cumulativeFillRatio',
      'fillNumerator', 'fillDenominator', 'filledSourceAmount', 'filledTargetAmount',
      'priceImprovementSourceAmount', 'pendingClearRequestedAt', 'domain', 'settlementPolicy',
      'timePolicy', 'clearingPolicy', 'priceImprovementMode', 'riskMode', 'claimedRatio',
      'sourceClaimed', 'targetClaimed', 'expiresAt', 'settledAt', 'error', 'memo',
    ], code);
  text(route['orderId'], `${code}_ORDER_ID`);
  for (const field of ['makerEntityId', 'hubEntityId', 'bookOwnerEntityId']) bytes(route[field], 32, `${code}_${field}`);
  text(route['venueId'], `${code}_VENUE`, 1_024);
  const source = validateLeg(route['source'], `${code}_SOURCE`);
  const target = validateLeg(route['target'], `${code}_TARGET`);
  literal(route['status'], STATUSES, `${code}_STATUS`);
  const createdAt = uint(route['createdAt'], `${code}_CREATED`);
  if (uint(route['updatedAt'], `${code}_UPDATED`) < createdAt) throw new Error(`${code}_UPDATED_ORDER`);
  bytes(route['routeHash'], 32, `${code}_HASH`);
  validateRoutePolicies(route, code); validateRouteOptionals(route, code);
  if (route['sourcePull'] !== undefined) validatePullLeg(route['sourcePull'], `${code}_SOURCE_PULL`);
  if (route['targetPull'] !== undefined) validatePullLeg(route['targetPull'], `${code}_TARGET_PULL`);
  if ((route['sourcePull'] === undefined) !== (route['targetPull'] === undefined)) throw new Error(`${code}_PULL_PAIR`);
  if (route['sourceCloseProof'] !== undefined) validateCloseProof(route['sourceCloseProof'], `${code}_SOURCE_CLOSE`);
  if (route['targetCloseProof'] !== undefined) validateCloseProof(route['targetCloseProof'], `${code}_TARGET_CLOSE`);
  const canonical = withCanonicalCrossJurisdictionRouteHash(route);
  if (route.bookOwnerEntityId !== deriveCanonicalCrossJurisdictionBookOwner(route) || route.venueId !== deriveCanonicalCrossJurisdictionVenueId(route)) throw new Error(`${code}_MARKET_BINDING`);
  if (route.makerEntityId !== source['entityId'] || source['jurisdiction'] === target['jurisdiction'] && source['tokenId'] === target['tokenId']) throw new Error(`${code}_ECONOMIC_ROUTE`);
  if (canonical.routeHash !== route.routeHash) throw new Error(`${code}_CANONICAL_HASH`);
  return route;
};

export const assertStoredCrossJurisdictionOfferBinding = (
  route: CrossJurisdictionSwapRoute,
  offer: Record<string, unknown>,
  pulls: Map<unknown, unknown>,
  leftEntity: string,
  rightEntity: string,
  code: string,
): void => {
  const sourcePull = route.sourcePull; const targetPull = route.targetPull;
  if (!sourcePull || !targetPull) throw new Error(`${code}_PULLS_MISSING`);
  if (route.orderId !== offer['offerId'] || route.source.tokenId !== offer['giveTokenId'] || route.target.tokenId !== offer['wantTokenId']) throw new Error(`${code}_OFFER_TERMS`);
  const maker = offer['makerIsLeft'] === true ? leftEntity : rightEntity;
  const sourceParties = new Set([route.source.entityId, route.source.counterpartyEntityId]);
  if (route.makerEntityId !== maker || sourceParties.size !== 2 || !sourceParties.has(leftEntity) || !sourceParties.has(rightEntity)) throw new Error(`${code}_ACCOUNT_BINDING`);
  if (sourcePull.pullId !== deriveCrossJurisdictionPullId(route, 'source') || targetPull.pullId !== deriveCrossJurisdictionPullId(route, 'target')) throw new Error(`${code}_PULL_IDS`);
  if (sourcePull.tokenId !== route.source.tokenId || targetPull.tokenId !== route.target.tokenId) throw new Error(`${code}_PULL_TOKENS`);
  if (sourcePull.amount !== route.source.amount || targetPull.amount !== route.target.amount) throw new Error(`${code}_PULL_AMOUNTS`);
  if (sourcePull.signedAmount !== signedCrossJurisdictionAmountForBeneficiary(route.source.counterpartyEntityId, route.source.entityId, route.source.amount) || targetPull.signedAmount !== signedCrossJurisdictionAmountForBeneficiary(route.target.counterpartyEntityId, route.target.entityId, route.target.amount)) throw new Error(`${code}_SIGNED_AMOUNTS`);
  if (sourcePull.fullHash !== targetPull.fullHash || sourcePull.partialRoot !== targetPull.partialRoot || sourcePull.revealedUntilTimestamp !== route.expiresAt || targetPull.revealedUntilTimestamp <= sourcePull.revealedUntilTimestamp) throw new Error(`${code}_PULL_PROOF`);
  const paired = shape(pulls.get(sourcePull.pullId), ['pullId', 'tokenId', 'amount', 'revealedUntilTimestamp', 'fullHash', 'partialRoot', 'createdHeight', 'createdTimestamp'], ['claimedRatio', 'claimedAmount', 'crossJurisdiction'], `${code}_PAIRED_PULL`);
  const binding = validateStoredCrossJurisdictionPullBinding(paired['crossJurisdiction'], `${code}_PULL_BINDING`);
  if (paired['tokenId'] !== sourcePull.tokenId || paired['amount'] !== sourcePull.signedAmount || paired['fullHash'] !== sourcePull.fullHash || paired['partialRoot'] !== sourcePull.partialRoot || paired['revealedUntilTimestamp'] !== sourcePull.revealedUntilTimestamp || binding.leg !== 'source' || binding.orderId !== route.orderId || binding.routeHash !== route.routeHash) throw new Error(`${code}_SOURCE_BINDING`);
  const progress = getCrossJurisdictionCommittedFillAmounts(route);
  if (offer['giveAmount'] !== route.source.amount - progress.filledSourceAmount || offer['wantAmount'] !== route.target.amount - progress.filledTargetAmount) throw new Error(`${code}_REMAINING_AMOUNTS`);
};
