import { ethers } from 'ethers';
import { isLeftEntity } from './entity-id-utils';
import type { CrossJurisdictionSwapRoute } from './types';
import {
  buildHashLadderProof,
  revealHashLadder,
  type HashLadderReveal,
} from './hashladder';

export const CROSS_J_SOURCE_REVEAL_BLOCKS = 50;
export const CROSS_J_TARGET_REVEAL_BLOCKS = 62;
export const CROSS_J_REVEAL_SAFETY_BLOCKS = CROSS_J_TARGET_REVEAL_BLOCKS - CROSS_J_SOURCE_REVEAL_BLOCKS;
export const CROSS_J_TARGET_TIMELOCK_SAFETY_MS = 60_000;

const normalizeEntityId = (value: string): string => String(value || '').toLowerCase();

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
  runtimeSeed: string | undefined,
  route: CrossJurisdictionSwapRoute,
) {
  return buildHashLadderProof([
    'xln:cross-j:hashladder:v1',
    runtimeSeed || 'runtime-seed-missing',
    route.orderId,
    route.source.entityId,
    route.source.counterpartyEntityId,
    route.target.entityId,
    route.target.counterpartyEntityId,
  ].join(':'));
}

export function deriveCrossJurisdictionHashLadderSeedHash(runtimeSeed: string | undefined): string {
  return ethers.keccak256(ethers.toUtf8Bytes(runtimeSeed || 'runtime-seed-missing'));
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
    sourceJHeight: number;
    targetJHeight: number;
    now: number;
  },
): CrossJurisdictionSwapRoute {
  const proof = deriveCrossJurisdictionHashLadderProof(options.runtimeSeed, route);
  const sourceAmount = BigInt(route.source.amount);
  const targetAmount = BigInt(route.target.amount);
  const sourcePullId = deriveCrossJurisdictionPullId(route, 'source');
  const targetPullId = deriveCrossJurisdictionPullId(route, 'target');
  return {
    ...route,
    sourcePull: {
      pullId: sourcePullId,
      tokenId: Number(route.source.tokenId),
      amount: sourceAmount,
      signedAmount: signedAmountForBeneficiary(route.source.counterpartyEntityId, route.source.entityId, sourceAmount),
      revealedUntilBlock: Number(options.sourceJHeight || 0) + CROSS_J_SOURCE_REVEAL_BLOCKS,
      fullHash: proof.fullHash,
      partialRoot: proof.partialRoot,
    },
    targetPull: {
      pullId: targetPullId,
      tokenId: Number(route.target.tokenId),
      amount: targetAmount,
      signedAmount: signedAmountForBeneficiary(route.target.counterpartyEntityId, route.target.entityId, targetAmount),
      revealedUntilBlock: Number(options.targetJHeight || 0) + CROSS_J_TARGET_REVEAL_BLOCKS,
      fullHash: proof.fullHash,
      partialRoot: proof.partialRoot,
    },
    hashLadderSeedHash: deriveCrossJurisdictionHashLadderSeedHash(options.runtimeSeed),
    status: 'target_prepared',
    updatedAt: options.now,
    expiresAt: route.expiresAt ?? (options.now + CROSS_J_TARGET_TIMELOCK_SAFETY_MS),
  };
}

export function buildCrossJurisdictionPullReveal(
  runtimeSeed: string | undefined,
  route: CrossJurisdictionSwapRoute,
  fillRatio: number,
): HashLadderReveal {
  if (route.hashLadderSeedHash && route.hashLadderSeedHash !== deriveCrossJurisdictionHashLadderSeedHash(runtimeSeed)) {
    throw new Error(`CROSS_J_HASHLADDER_SEED_MISMATCH:${route.orderId}`);
  }
  const proof = deriveCrossJurisdictionHashLadderProof(runtimeSeed, route);
  return revealHashLadder(proof, fillRatio);
}
