import { ethers } from 'ethers';
import { isLeftEntity } from './entity-id-utils';
import type { CrossJurisdictionSwapRoute } from './types';
import {
  buildHashLadderProof,
  revealHashLadder,
  type HashLadderReveal,
} from './hashladder';

export const CROSS_J_DEFAULT_SOURCE_REVEAL_WINDOW_MS = 60_000;
export const CROSS_J_TARGET_REVEAL_SAFETY_MS = 60_000;
export const CROSS_J_MIN_TARGET_RESPONSE_WINDOW_MS = 24 * 60 * 60 * 1000;

const normalizeEntityId = (value: string): string => String(value || '').toLowerCase();

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
  return ethers.keccak256(ethers.toUtf8Bytes([
    'xln:cross-j:hashladder-private-seed:v1',
    seed,
    route.orderId,
    route.source.entityId,
    route.source.counterpartyEntityId,
    route.target.entityId,
    route.target.counterpartyEntityId,
  ].join(':')));
}

export function stripCrossJurisdictionPrivateData(route: CrossJurisdictionSwapRoute): CrossJurisdictionSwapRoute {
  const { hashLadderPrivateSeed: _privateSeed, ...publicRoute } = route;
  return publicRoute;
}

export function deriveCrossJurisdictionPullId(route: CrossJurisdictionSwapRoute, leg: 'source' | 'target'): string {
  return ethers.keccak256(ethers.toUtf8Bytes([
    'xln:cross-j:pull-id:v1',
    route.orderId,
    leg,
    route.source.entityId,
    route.source.counterpartyEntityId,
    route.target.entityId,
    route.target.counterpartyEntityId,
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
  const hashLadderPrivateSeed = route.hashLadderPrivateSeed || deriveCrossJurisdictionPrivateSeed(options.runtimeSeed, route);
  const seededRoute = { ...route, hashLadderPrivateSeed };
  const proof = deriveCrossJurisdictionHashLadderProof(seededRoute);
  const sourceAmount = BigInt(route.source.amount);
  const targetAmount = BigInt(route.target.amount);
  const sourcePullId = deriveCrossJurisdictionPullId(route, 'source');
  const targetPullId = deriveCrossJurisdictionPullId(route, 'target');
  const sourceRevealUntilTimestamp = Math.floor(Number(route.expiresAt ?? (now + CROSS_J_DEFAULT_SOURCE_REVEAL_WINDOW_MS)));
  if (!Number.isFinite(sourceRevealUntilTimestamp) || sourceRevealUntilTimestamp <= now) {
    throw new Error(`CROSS_J_SOURCE_REVEAL_TIMESTAMP_INVALID:${route.orderId}`);
  }
  const targetResponseWindowMs = Math.max(sourceDisputeDelayMs, CROSS_J_MIN_TARGET_RESPONSE_WINDOW_MS);
  const targetRevealUntilTimestamp = sourceRevealUntilTimestamp + targetResponseWindowMs + CROSS_J_TARGET_REVEAL_SAFETY_MS;
  return {
    ...route,
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
    expiresAt: route.expiresAt ?? sourceRevealUntilTimestamp,
  };
}

export function buildCrossJurisdictionPullReveal(
  route: CrossJurisdictionSwapRoute,
  fillRatio: number,
): HashLadderReveal {
  const proof = deriveCrossJurisdictionHashLadderProof(route);
  return revealHashLadder(proof, fillRatio);
}
