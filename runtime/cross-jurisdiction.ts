import { ethers } from 'ethers';
import { isLeftEntity } from './entity-id-utils';
import type { CrossJurisdictionSwapRoute, CrossJurisdictionSwapStatus } from './types';
import {
  buildHashLadderProof,
  revealHashLadder,
  type HashLadderReveal,
} from './hashladder';

export const CROSS_J_DEFAULT_SOURCE_REVEAL_WINDOW_MS = 60_000;
export const CROSS_J_TARGET_REVEAL_SAFETY_MS = 60_000;
export const CROSS_J_MIN_TARGET_RESPONSE_WINDOW_MS = 24 * 60 * 60 * 1000;

const CROSS_J_STATUS_RANK: Record<CrossJurisdictionSwapStatus, number> = {
  intent: 10,
  target_prepared: 20,
  source_committed: 30,
  resting: 40,
  target_locked: 50,
  source_locked: 60,
  source_claimed: 70,
  target_claimed: 80,
  settled: 100,
  cancelled: 100,
  failed: 100,
};

export function isCrossJurisdictionTerminalStatus(status: CrossJurisdictionSwapStatus | undefined): boolean {
  return status === 'settled' || status === 'cancelled' || status === 'failed';
}

export function compareCrossJurisdictionRouteStatus(
  current: CrossJurisdictionSwapStatus | undefined,
  next: CrossJurisdictionSwapStatus | undefined,
): number {
  return (CROSS_J_STATUS_RANK[next || 'intent'] ?? 0) - (CROSS_J_STATUS_RANK[current || 'intent'] ?? 0);
}

export function isCrossJurisdictionRouteExpired(route: CrossJurisdictionSwapRoute, now: number): boolean {
  const expiresAt = Number(route.expiresAt || 0);
  return Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now;
}

export function isCrossJurisdictionPullExpired(
  route: CrossJurisdictionSwapRoute,
  leg: 'source' | 'target',
  now: number,
): boolean {
  const pull = leg === 'source' ? route.sourcePull : route.targetPull;
  const deadline = Number(pull?.revealedUntilTimestamp || 0);
  return Number.isFinite(deadline) && deadline > 0 && deadline <= now;
}

const normalizeEntityId = (value: string): string => String(value || '').toLowerCase();
const normalizeJurisdiction = (value: string): string => String(value || '').trim().toLowerCase();
const ROUTE_HASH_ABI_TYPES = [
  'string',
  'string',
  'string',
  'string',
  'string',
  'string',
  'uint256',
  'uint256',
  'string',
  'string',
  'string',
  'uint256',
  'uint256',
  'bool',
  'int256',
  'uint256',
] as const;

function requireRuntimeSeed(runtimeSeed: string | undefined): string {
  const seed = String(runtimeSeed || '').trim();
  if (!seed) {
    throw new Error('CRYPTO_DETERMINISM_VIOLATION: cross-jurisdiction hashladder requires env.runtimeSeed');
  }
  return seed;
}

export function deriveCrossJurisdictionPrivateSeed(
  runtimeSeed: string | undefined,
  route: CrossJurisdictionSwapRoute,
): string {
  const seed = requireRuntimeSeed(runtimeSeed);
  const routeHash = route.routeHash || deriveCrossJurisdictionRouteHash(route);
  return ethers.keccak256(ethers.toUtf8Bytes([
    'xln:cross-j:hashladder-private-seed:v1',
    seed,
    routeHash,
  ].join(':')));
}

export function stripCrossJurisdictionPrivateData(route: CrossJurisdictionSwapRoute): CrossJurisdictionSwapRoute {
  const { hashLadderPrivateSeed: _privateSeed, ...publicRoute } = route;
  return publicRoute;
}

export function deriveCrossJurisdictionRouteHash(route: CrossJurisdictionSwapRoute): string {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  return ethers.keccak256(abiCoder.encode(
    ROUTE_HASH_ABI_TYPES,
    [
      String(route.orderId || ''),
      normalizeEntityId(route.makerEntityId),
      normalizeEntityId(route.hubEntityId),
      normalizeJurisdiction(route.source.jurisdiction),
      normalizeEntityId(route.source.entityId),
      normalizeEntityId(route.source.counterpartyEntityId),
      String(Math.floor(Number(route.source.tokenId))),
      BigInt(route.source.amount),
      normalizeJurisdiction(route.target.jurisdiction),
      normalizeEntityId(route.target.entityId),
      normalizeEntityId(route.target.counterpartyEntityId),
      String(Math.floor(Number(route.target.tokenId))),
      BigInt(route.target.amount),
      route.priceTicks !== undefined,
      BigInt(route.priceTicks ?? 0n),
      BigInt(Math.floor(Number(route.expiresAt ?? 0))),
    ],
  ));
}

export function withCanonicalCrossJurisdictionRouteHash(route: CrossJurisdictionSwapRoute): CrossJurisdictionSwapRoute {
  const routeHash = deriveCrossJurisdictionRouteHash(route);
  if (route.routeHash && String(route.routeHash).toLowerCase() !== routeHash.toLowerCase()) {
    throw new Error(`CROSS_J_ROUTE_HASH_MISMATCH:${route.orderId}`);
  }
  return { ...route, routeHash };
}

export function deriveCrossJurisdictionPullId(route: CrossJurisdictionSwapRoute, leg: 'source' | 'target'): string {
  const routeHash = route.routeHash || deriveCrossJurisdictionRouteHash(route);
  return ethers.keccak256(ethers.toUtf8Bytes([
    'xln:cross-j:pull-id:v1',
    routeHash,
    leg,
  ].join(':')));
}

export function deriveCrossJurisdictionHashLadderProof(
  route: CrossJurisdictionSwapRoute,
) {
  const privateSeed = String(route.hashLadderPrivateSeed || '').trim();
  if (!privateSeed) throw new Error(`CROSS_J_HASHLADDER_PRIVATE_SEED_MISSING:${route.orderId}`);
  return buildHashLadderProof(privateSeed);
}

function signedAmountForBeneficiary(beneficiaryEntityId: string, counterpartyEntityId: string, amount: bigint): bigint {
  return isLeftEntity(normalizeEntityId(beneficiaryEntityId), normalizeEntityId(counterpartyEntityId))
    ? amount
    : -amount;
}

export function buildPreparedCrossJurisdictionRoute(
  route: CrossJurisdictionSwapRoute,
  options: {
    runtimeSeed?: string | undefined;
    sourceDisputeDelayMs: number;
    now: number;
  },
): CrossJurisdictionSwapRoute {
  const now = Math.floor(Number(options.now || 0));
  if (!Number.isFinite(now) || now <= 0) throw new Error(`CROSS_J_NOW_INVALID:${options.now}`);
  const sourceDisputeDelayMs = Math.floor(Number(options.sourceDisputeDelayMs || 0));
  if (!Number.isFinite(sourceDisputeDelayMs) || sourceDisputeDelayMs <= 0) {
    throw new Error(`CROSS_J_SOURCE_DISPUTE_DELAY_MS_INVALID:${options.sourceDisputeDelayMs}`);
  }
  const sourceRevealUntilTimestamp = Math.floor(Number(route.expiresAt ?? (now + CROSS_J_DEFAULT_SOURCE_REVEAL_WINDOW_MS)));
  if (!Number.isFinite(sourceRevealUntilTimestamp) || sourceRevealUntilTimestamp <= now) {
    throw new Error(`CROSS_J_SOURCE_REVEAL_TIMESTAMP_INVALID:${route.orderId}`);
  }
  const canonicalRoute = withCanonicalCrossJurisdictionRouteHash({
    ...route,
    expiresAt: route.expiresAt ?? sourceRevealUntilTimestamp,
  });
  const hashLadderPrivateSeed = canonicalRoute.hashLadderPrivateSeed || deriveCrossJurisdictionPrivateSeed(options.runtimeSeed, canonicalRoute);
  const seededRoute = { ...canonicalRoute, hashLadderPrivateSeed };
  const proof = deriveCrossJurisdictionHashLadderProof(seededRoute);
  const sourceAmount = BigInt(canonicalRoute.source.amount);
  const targetAmount = BigInt(canonicalRoute.target.amount);
  const sourcePullId = deriveCrossJurisdictionPullId(canonicalRoute, 'source');
  const targetPullId = deriveCrossJurisdictionPullId(canonicalRoute, 'target');
  const targetResponseWindowMs = Math.max(sourceDisputeDelayMs, CROSS_J_MIN_TARGET_RESPONSE_WINDOW_MS);
  const targetRevealUntilTimestamp = sourceRevealUntilTimestamp + targetResponseWindowMs + CROSS_J_TARGET_REVEAL_SAFETY_MS;
  return {
    ...canonicalRoute,
    hashLadderPrivateSeed,
    sourcePull: {
      pullId: sourcePullId,
      tokenId: Number(route.source.tokenId),
      amount: sourceAmount,
      signedAmount: signedAmountForBeneficiary(route.source.counterpartyEntityId, route.source.entityId, sourceAmount),
      revealedUntilTimestamp: sourceRevealUntilTimestamp,
      fullHash: proof.fullHash,
      partialRoot: proof.partialRoot,
    },
    targetPull: {
      pullId: targetPullId,
      tokenId: Number(route.target.tokenId),
      amount: targetAmount,
      signedAmount: signedAmountForBeneficiary(route.target.counterpartyEntityId, route.target.entityId, targetAmount),
      revealedUntilTimestamp: targetRevealUntilTimestamp,
      fullHash: proof.fullHash,
      partialRoot: proof.partialRoot,
    },
    status: 'target_prepared',
    updatedAt: now,
    expiresAt: Number(canonicalRoute.expiresAt ?? sourceRevealUntilTimestamp),
  };
}

export function buildCrossJurisdictionPullReveal(
  route: CrossJurisdictionSwapRoute,
  fillRatio: number,
): HashLadderReveal {
  const proof = deriveCrossJurisdictionHashLadderProof(route);
  return revealHashLadder(proof, fillRatio);
}
