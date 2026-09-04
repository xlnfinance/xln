/** Exact untrusted-bytes decoder for the canonical cross-j route. */

import type { CrossJurisdictionSwapRoute } from '../../types/cross-jurisdiction';
import {
  requireArray,
  requireBigInt,
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
  requireString,
} from '../../protocol/boundary/boundary-primitives';

const REQUIRED = [
  'orderId', 'makerEntityId', 'hubEntityId', 'source', 'target',
  'sourceDisputeConfig', 'targetDisputeConfig', 'status', 'createdAt', 'updatedAt',
] as const;
const OPTIONAL = [
  'routeHash', 'bookOwnerEntityId', 'venueId', 'sourceSignerId', 'sourceHubSignerId',
  'targetHubSignerId', 'targetSignerId', 'bookHubSignerId', 'sourcePull', 'targetPull',
  'sourceCloseProof', 'targetCloseProof', 'priceTicks', 'fillSeq', 'cumulativeFillRatio',
  'fillNumerator', 'fillDenominator', 'filledSourceAmount', 'filledTargetAmount',
  'pendingClearRequestedAt', 'domain',
  'timePolicy', 'clearingPolicy', 'riskMode', 'claimedRatio',
  'sourceRegistryFillRatio', 'targetRegistryFillRatio', 'sourceRegistryRecord',
  'targetRegistryRecord', 'pendingSourceRegistryReveal', 'pendingTargetRegistryReveal',
  'sourceClaimed', 'targetClaimed', 'expiresAt', 'settledAt', 'error', 'memo',
] as const;

const stringFields = [
  'orderId', 'makerEntityId', 'hubEntityId', 'routeHash', 'bookOwnerEntityId', 'venueId',
  'sourceSignerId', 'sourceHubSignerId', 'targetHubSignerId', 'targetSignerId',
  'bookHubSignerId', 'error', 'memo',
] as const;
const integerFields = [
  'createdAt', 'updatedAt', 'fillSeq', 'cumulativeFillRatio', 'pendingClearRequestedAt',
  'claimedRatio', 'sourceRegistryFillRatio', 'targetRegistryFillRatio', 'expiresAt', 'settledAt',
] as const;
const bigintFields = [
  'priceTicks', 'fillNumerator', 'fillDenominator', 'filledSourceAmount',
  'filledTargetAmount', 'sourceClaimed', 'targetClaimed',
] as const;

const requireLiteral = (value: unknown, allowed: readonly string[], code: string): void => {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new Error(code);
};

const validateLeg = (value: unknown, code: string): void => {
  const leg = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(
    leg,
    ['jurisdiction', 'entityId', 'counterpartyEntityId', 'tokenId', 'amount'],
    [],
    `${code}_FIELDS`,
  );
  requireString(leg['jurisdiction'], `${code}_JURISDICTION`);
  requireString(leg['entityId'], `${code}_ENTITY`);
  requireString(leg['counterpartyEntityId'], `${code}_COUNTERPARTY`);
  requireBoundaryInteger(leg['tokenId'], `${code}_TOKEN`, 1);
  requireBigInt(leg['amount'], `${code}_AMOUNT`, 1n);
};

const validateDisputeConfig = (value: unknown, code: string): void => {
  const config = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(config, ['leftResponseSeconds', 'rightResponseSeconds'], [], `${code}_FIELDS`);
  requireBoundaryInteger(config['leftResponseSeconds'], `${code}_LEFT`, 0);
  requireBoundaryInteger(config['rightResponseSeconds'], `${code}_RIGHT`, 0);
};

const validatePull = (value: unknown, code: string): void => {
  const pull = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(
    pull,
    ['pullId', 'tokenId', 'amount', 'signedAmount', 'fullHash', 'partialRoot'],
    [],
    `${code}_FIELDS`,
  );
  for (const field of ['pullId', 'fullHash', 'partialRoot']) requireString(pull[field], `${code}_${field}`);
  requireBoundaryInteger(pull['tokenId'], `${code}_TOKEN`, 1);
  requireBigInt(pull['amount'], `${code}_AMOUNT`, 0n);
  requireBigInt(pull['signedAmount'], `${code}_SIGNED_AMOUNT`);
};

const validateCloseProof = (value: unknown, code: string): void => {
  const proof = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(proof, [
    'orderId', 'routeHash', 'sourcePullId', 'targetPullId', 'fillRatio',
    'cumulativeSourceAmount', 'cumulativeTargetAmount', 'binaryHash', 'closeMode',
  ], [], `${code}_FIELDS`);
  for (const field of ['orderId', 'routeHash', 'sourcePullId', 'targetPullId', 'binaryHash']) {
    requireString(proof[field], `${code}_${field}`);
  }
  requireBoundaryInteger(proof['fillRatio'], `${code}_RATIO`, 0);
  requireBigInt(proof['cumulativeSourceAmount'], `${code}_SOURCE`, 0n);
  requireBigInt(proof['cumulativeTargetAmount'], `${code}_TARGET`, 0n);
  requireLiteral(proof['closeMode'], ['full', 'partial_cancel_remainder', 'pure_cancel'], `${code}_MODE`);
};

const validateDomain = (value: unknown, code: string): void => {
  const domain = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(domain, [
    'protocol', 'hashSchema', 'sourceStackId', 'targetStackId', 'sourceAssetRef', 'targetAssetRef',
  ], [
    'sourceEntityProviderAddress', 'targetEntityProviderAddress',
    'sourceDeltaTransformerAddress', 'targetDeltaTransformerAddress',
  ], `${code}_FIELDS`);
  requireLiteral(domain['protocol'], ['xln-cross-j'], `${code}_PROTOCOL`);
  requireLiteral(domain['hashSchema'], ['route-domain'], `${code}_SCHEMA`);
  for (const field of Object.keys(domain)) {
    if (field !== 'protocol' && field !== 'hashSchema') requireString(domain[field], `${code}_${field}`);
  }
};

const validateTimePolicy = (value: unknown, code: string): void => {
  const policy = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(policy, [
    'runtimeClock', 'settlementClock', 'deadlineConversion', 'runtimeExpiresAtMs', 'finalityPolicy',
  ], [], `${code}_FIELDS`);
  requireLiteral(policy['runtimeClock'], ['unix_ms'], `${code}_RUNTIME_CLOCK`);
  requireLiteral(policy['settlementClock'], ['unix_seconds'], `${code}_SETTLEMENT_CLOCK`);
  requireLiteral(policy['deadlineConversion'], ['floor_ms_to_unix_seconds'], `${code}_CONVERSION`);
  requireLiteral(policy['finalityPolicy'], ['independent_beneficiary_windows_pull_sum_finality'], `${code}_FINALITY`);
  requireBoundaryInteger(policy['runtimeExpiresAtMs'], `${code}_EXPIRES`, 0);
};

const validateRegistryRecord = (value: unknown, code: string): void => {
  const record = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(record, ['fillRatio', 'revealedAt'], [], `${code}_FIELDS`);
  requireBoundaryInteger(record['fillRatio'], `${code}_RATIO`, 0);
  requireBoundaryInteger(record['revealedAt'], `${code}_REVEALED_AT`, 0);
};

const validatePendingReveal = (value: unknown, code: string): void => {
  const reveal = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(reveal, ['fillRatio', 'fullSecret', 'reveals'], [], `${code}_FIELDS`);
  requireBoundaryInteger(reveal['fillRatio'], `${code}_RATIO`, 0);
  requireString(reveal['fullSecret'], `${code}_SECRET`);
  const reveals = requireArray(reveal['reveals'], `${code}_REVEALS`);
  if (reveals.length !== 4) throw new Error(`${code}_REVEALS_LENGTH`);
  reveals.forEach((entry, index) => requireString(entry, `${code}_REVEAL_${index}`));
};

export function assertCrossJurisdictionSwapRoute(
  value: unknown,
  code: string,
): asserts value is CrossJurisdictionSwapRoute {
  const route = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(route, REQUIRED, OPTIONAL, `${code}_FIELDS`);
  for (const field of stringFields) if (route[field] !== undefined) requireString(route[field], `${code}_${field}`);
  for (const field of integerFields) if (route[field] !== undefined) requireBoundaryInteger(route[field], `${code}_${field}`, 0);
  for (const field of bigintFields) if (route[field] !== undefined) requireBigInt(route[field], `${code}_${field}`);
  validateLeg(route['source'], `${code}_SOURCE`);
  validateLeg(route['target'], `${code}_TARGET`);
  validateDisputeConfig(route['sourceDisputeConfig'], `${code}_SOURCE_DISPUTE`);
  validateDisputeConfig(route['targetDisputeConfig'], `${code}_TARGET_DISPUTE`);
  if (route['sourcePull'] !== undefined) validatePull(route['sourcePull'], `${code}_SOURCE_PULL`);
  if (route['targetPull'] !== undefined) validatePull(route['targetPull'], `${code}_TARGET_PULL`);
  if (route['sourceCloseProof'] !== undefined) validateCloseProof(route['sourceCloseProof'], `${code}_SOURCE_CLOSE`);
  if (route['targetCloseProof'] !== undefined) validateCloseProof(route['targetCloseProof'], `${code}_TARGET_CLOSE`);
  if (route['domain'] !== undefined) validateDomain(route['domain'], `${code}_DOMAIN`);
  if (route['timePolicy'] !== undefined) validateTimePolicy(route['timePolicy'], `${code}_TIME`);
  if (route['sourceRegistryRecord'] !== undefined) validateRegistryRecord(route['sourceRegistryRecord'], `${code}_SOURCE_REGISTRY`);
  if (route['targetRegistryRecord'] !== undefined) validateRegistryRecord(route['targetRegistryRecord'], `${code}_TARGET_REGISTRY`);
  if (route['pendingSourceRegistryReveal'] !== undefined) validatePendingReveal(route['pendingSourceRegistryReveal'], `${code}_PENDING_SOURCE`);
  if (route['pendingTargetRegistryReveal'] !== undefined) validatePendingReveal(route['pendingTargetRegistryReveal'], `${code}_PENDING_TARGET`);
  requireLiteral(route['status'], [
    'intent', 'target_prepared', 'resting', 'partially_filled', 'clear_requested',
    'clearing', 'settled', 'cancelled', 'expired',
  ], `${code}_STATUS`);
  if (route['clearingPolicy'] !== undefined) requireLiteral(route['clearingPolicy'], ['manual', 'full_fill', 'cancel_and_clear'], `${code}_CLEARING`);
  if (route['riskMode'] !== undefined) requireLiteral(route['riskMode'], [
    'fully_collateralized', 'partially_collateralized', 'credit_line', 'unsecured_internalized',
  ], `${code}_RISK`);
}

const REQUIRED_ROUTE_TX_TYPES = new Set([
  'registerCrossJurisdictionSwap', 'prepareCrossJurisdictionSwap',
  'admitCrossJurisdictionBookOrder', 'crossJurisdictionBookOrderRemoved',
]);
const OPTIONAL_ROUTE_TX_TYPES = new Set([
  'requestCrossJurisdictionClear', 'removeCrossJurisdictionBookOrder',
]);

export const validateCrossJurisdictionRouteEntityTx = (
  type: string,
  data: unknown,
  code: string,
): void => {
  if (!REQUIRED_ROUTE_TX_TYPES.has(type) && !OPTIONAL_ROUTE_TX_TYPES.has(type)) return;
  const record = requireBoundaryRecord(data, code);
  if (record['route'] === undefined) {
    if (REQUIRED_ROUTE_TX_TYPES.has(type)) throw new Error(`${code}_ROUTE_REQUIRED`);
    return;
  }
  assertCrossJurisdictionSwapRoute(record['route'], `${code}_ROUTE`);
};
