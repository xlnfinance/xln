import { ethers } from 'ethers';
import { isLeftEntity } from './entity-id-utils';
import type {
  AccountFrame,
  AccountInput,
  AccountTx,
  CrossJurisdictionSwapRoute,
  CrossJurisdictionSwapStatus,
  Env,
  SwapOffer,
  SwapOrderHistoryEntry,
} from './types';
import {
  buildHashLadderProof,
  revealHashLadder,
  type HashLadderReveal,
} from './hashladder';

export const CROSS_J_DEFAULT_SOURCE_REVEAL_WINDOW_MS = 60_000;
export const CROSS_J_TARGET_REVEAL_SAFETY_MS = 60_000;
export const CROSS_J_MIN_TARGET_RESPONSE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const CROSS_J_MAX_FILL_RATIO = 65_535;

const CROSS_J_STATUS_RANK: Record<CrossJurisdictionSwapStatus, number> = {
  intent: 10,
  target_prepared: 20,
  source_committed: 30,
  resting: 40,
  partially_filled: 50,
  clear_requested: 60,
  clearing: 70,
  target_locked: 80,
  source_locked: 90,
  source_claimed: 100,
  target_claimed: 110,
  settled: 120,
  cancelled: 120,
  expired: 120,
  failed: 120,
};

export function isCrossJurisdictionTerminalStatus(status: CrossJurisdictionSwapStatus | undefined): boolean {
  return status === 'settled' || status === 'cancelled' || status === 'expired' || status === 'failed';
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

export type CrossJurisdictionFillProgressInput = {
  fillSeq?: number | undefined;
  cumulativeFillRatio: number;
  incrementalSourceAmount?: bigint | undefined;
  incrementalTargetAmount?: bigint | undefined;
  cumulativeSourceAmount?: bigint | undefined;
  cumulativeTargetAmount?: bigint | undefined;
};

export type CrossJurisdictionFillProgress = {
  fillSeq: number;
  previousRatio: number;
  nextRatio: number;
  previousSourceAmount: bigint;
  previousTargetAmount: bigint;
  cumulativeSourceAmount: bigint;
  cumulativeTargetAmount: bigint;
  incrementalSourceAmount: bigint;
  incrementalTargetAmount: bigint;
};

const clampFillRatio = (value: unknown): number =>
  Math.max(0, Math.min(CROSS_J_MAX_FILL_RATIO, Math.floor(Number(value) || 0)));

export function validateCrossJurisdictionFillProgress(
  route: CrossJurisdictionSwapRoute,
  input: CrossJurisdictionFillProgressInput,
): { ok: true; value: CrossJurisdictionFillProgress } | { ok: false; error: string } {
  const previousSeq = Math.max(0, Math.floor(Number(route.fillSeq ?? 0) || 0));
  const nextSeq = input.fillSeq === undefined ? previousSeq + 1 : Math.floor(Number(input.fillSeq));
  if (!Number.isInteger(nextSeq) || nextSeq !== previousSeq + 1) {
    return { ok: false, error: `bad seq ${input.fillSeq}, expected ${previousSeq + 1}` };
  }

  const previousRatio = Math.max(clampFillRatio(route.cumulativeFillRatio), clampFillRatio(route.claimedRatio));
  const nextRatio = clampFillRatio(input.cumulativeFillRatio);
  if (nextRatio <= previousRatio) {
    return { ok: false, error: `non-monotonic ratio ${nextRatio} <= ${previousRatio}` };
  }

  const sourceTotal = BigInt(route.source.amount);
  const targetTotal = BigInt(route.target.amount);
  if (sourceTotal <= 0n || targetTotal <= 0n) {
    return { ok: false, error: 'invalid route amount' };
  }

  const previousSourceAmount =
    route.filledSourceAmount ??
    route.sourceClaimed ??
    ((sourceTotal * BigInt(previousRatio)) / BigInt(CROSS_J_MAX_FILL_RATIO));
  const previousTargetAmount =
    route.filledTargetAmount ??
    route.targetClaimed ??
    ((targetTotal * BigInt(previousRatio)) / BigInt(CROSS_J_MAX_FILL_RATIO));
  const cumulativeSourceAmount =
    (sourceTotal * BigInt(nextRatio)) / BigInt(CROSS_J_MAX_FILL_RATIO);
  const cumulativeTargetAmount =
    (targetTotal * BigInt(nextRatio)) / BigInt(CROSS_J_MAX_FILL_RATIO);
  const incrementalSourceAmount = cumulativeSourceAmount - previousSourceAmount;
  const incrementalTargetAmount = cumulativeTargetAmount - previousTargetAmount;
  if (incrementalSourceAmount <= 0n || incrementalTargetAmount <= 0n) {
    return { ok: false, error: 'no incremental amount' };
  }

  if (input.cumulativeSourceAmount !== undefined && input.cumulativeSourceAmount !== cumulativeSourceAmount) {
    return { ok: false, error: `cumulative source mismatch: expected ${cumulativeSourceAmount}, got ${input.cumulativeSourceAmount}` };
  }
  if (input.cumulativeTargetAmount !== undefined && input.cumulativeTargetAmount !== cumulativeTargetAmount) {
    return { ok: false, error: `cumulative target mismatch: expected ${cumulativeTargetAmount}, got ${input.cumulativeTargetAmount}` };
  }
  if (input.incrementalSourceAmount !== undefined && input.incrementalSourceAmount !== incrementalSourceAmount) {
    return { ok: false, error: `incremental source mismatch: expected ${incrementalSourceAmount}, got ${input.incrementalSourceAmount}` };
  }
  if (input.incrementalTargetAmount !== undefined && input.incrementalTargetAmount !== incrementalTargetAmount) {
    return { ok: false, error: `incremental target mismatch: expected ${incrementalTargetAmount}, got ${input.incrementalTargetAmount}` };
  }

  return {
    ok: true,
    value: {
      fillSeq: nextSeq,
      previousRatio,
      nextRatio,
      previousSourceAmount,
      previousTargetAmount,
      cumulativeSourceAmount,
      cumulativeTargetAmount,
      incrementalSourceAmount,
      incrementalTargetAmount,
    },
  };
}

export function withCrossJurisdictionFillProgress(
  route: CrossJurisdictionSwapRoute,
  fill: CrossJurisdictionFillProgress,
  updatedAt: number,
): CrossJurisdictionSwapRoute {
  return {
    ...route,
    fillSeq: fill.fillSeq,
    cumulativeFillRatio: fill.nextRatio,
    claimedRatio: fill.nextRatio,
    filledSourceAmount: fill.cumulativeSourceAmount,
    filledTargetAmount: fill.cumulativeTargetAmount,
    sourceClaimed: fill.cumulativeSourceAmount,
    targetClaimed: fill.cumulativeTargetAmount,
    status: fill.nextRatio >= CROSS_J_MAX_FILL_RATIO ? 'clear_requested' : 'partially_filled',
    updatedAt,
  };
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
const crossJurisdictionAssetKey = (jurisdiction: string, tokenId: number): string =>
  `${normalizeJurisdiction(jurisdiction)}:${Math.floor(Number(tokenId) || 0)}`;

export type CanonicalCrossJurisdictionMarket = {
  sourceKey: string;
  targetKey: string;
  baseKey: string;
  quoteKey: string;
  sourceIsBase: boolean;
  venueId: string;
};

export function deriveCanonicalCrossJurisdictionMarket(route: CrossJurisdictionSwapRoute): CanonicalCrossJurisdictionMarket {
  return deriveCanonicalCrossJurisdictionMarketForLegs(
    route.source.jurisdiction,
    route.source.tokenId,
    route.target.jurisdiction,
    route.target.tokenId,
  );
}

export function deriveCanonicalCrossJurisdictionMarketForLegs(
  sourceJurisdiction: string,
  sourceTokenId: number,
  targetJurisdiction: string,
  targetTokenId: number,
): CanonicalCrossJurisdictionMarket {
  const sourceKey = crossJurisdictionAssetKey(sourceJurisdiction, sourceTokenId);
  const targetKey = crossJurisdictionAssetKey(targetJurisdiction, targetTokenId);
  const sourceIsBase = sourceKey <= targetKey;
  const baseKey = sourceIsBase ? sourceKey : targetKey;
  const quoteKey = sourceIsBase ? targetKey : sourceKey;
  return {
    sourceKey,
    targetKey,
    baseKey,
    quoteKey,
    sourceIsBase,
    venueId: `cross:${baseKey}/${quoteKey}`,
  };
}

export function deriveCanonicalCrossJurisdictionVenueId(route: CrossJurisdictionSwapRoute): string {
  return deriveCanonicalCrossJurisdictionMarket(route).venueId;
}

export function deriveCanonicalCrossJurisdictionVenueIdForLegs(
  sourceJurisdiction: string,
  sourceTokenId: number,
  targetJurisdiction: string,
  targetTokenId: number,
): string {
  return deriveCanonicalCrossJurisdictionMarketForLegs(
    sourceJurisdiction,
    sourceTokenId,
    targetJurisdiction,
    targetTokenId,
  ).venueId;
}

export function deriveCanonicalCrossJurisdictionBookOwner(route: CrossJurisdictionSwapRoute): string {
  return deriveCanonicalCrossJurisdictionBookOwnerForLegs(
    route.source.jurisdiction,
    route.source.tokenId,
    route.source.counterpartyEntityId,
    route.target.jurisdiction,
    route.target.tokenId,
    route.target.entityId,
  );
}

export function deriveCanonicalCrossJurisdictionBookOwnerForLegs(
  sourceJurisdiction: string,
  sourceTokenId: number,
  sourceHubEntityId: string,
  targetJurisdiction: string,
  targetTokenId: number,
  targetHubEntityId: string,
): string {
  const sourceKey = crossJurisdictionAssetKey(sourceJurisdiction, sourceTokenId);
  const targetKey = crossJurisdictionAssetKey(targetJurisdiction, targetTokenId);
  return normalizeEntityId(
    sourceKey <= targetKey
      ? sourceHubEntityId
      : targetHubEntityId,
  );
}
const ROUTE_HASH_ABI_TYPES = [
  'string',
  'string',
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
  'string',
  'string',
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

type LegacyPrivateRoute = CrossJurisdictionSwapRoute & { hashLadderPrivateSeed?: string };

const routePrivateSeedKey = (route: CrossJurisdictionSwapRoute): string =>
  (route.routeHash || deriveCrossJurisdictionRouteHash(route)).toLowerCase();

export function rememberCrossJurisdictionPrivateSeed(
  env: Pick<Env, 'crossJurisdictionPrivateSeeds'>,
  route: CrossJurisdictionSwapRoute,
  privateSeed: string,
): string {
  const seed = String(privateSeed || '').trim();
  if (!seed) throw new Error(`CROSS_J_HASHLADDER_PRIVATE_SEED_EMPTY:${route.orderId}`);
  env.crossJurisdictionPrivateSeeds ||= new Map();
  env.crossJurisdictionPrivateSeeds.set(routePrivateSeedKey(route), seed);
  return seed;
}

export function getCrossJurisdictionPrivateSeed(
  env: Pick<Env, 'crossJurisdictionPrivateSeeds' | 'runtimeSeed'>,
  route: CrossJurisdictionSwapRoute,
): string {
  const key = routePrivateSeedKey(route);
  const stored = env.crossJurisdictionPrivateSeeds?.get(key);
  if (stored) return stored;

  const legacySeed = String((route as LegacyPrivateRoute).hashLadderPrivateSeed || '').trim();
  if (legacySeed) return rememberCrossJurisdictionPrivateSeed(env, route, legacySeed);

  return rememberCrossJurisdictionPrivateSeed(
    env,
    route,
    deriveCrossJurisdictionPrivateSeed(env.runtimeSeed, route),
  );
}

export function stripCrossJurisdictionPrivateData(route: CrossJurisdictionSwapRoute): CrossJurisdictionSwapRoute {
  const { hashLadderPrivateSeed: _privateSeed, ...publicRoute } = route as LegacyPrivateRoute;
  return publicRoute;
}

export function stripCrossJurisdictionCarrierPrivateData<T extends { crossJurisdiction?: CrossJurisdictionSwapRoute }>(value: T): T {
  if (!value.crossJurisdiction) return value;
  return {
    ...value,
    crossJurisdiction: stripCrossJurisdictionPrivateData({ ...value.crossJurisdiction }),
  };
}

export const stripCrossJurisdictionSwapOfferPrivateData = (offer: SwapOffer): SwapOffer =>
  stripCrossJurisdictionCarrierPrivateData({ ...offer });

export const stripCrossJurisdictionSwapHistoryPrivateData = (entry: SwapOrderHistoryEntry): SwapOrderHistoryEntry =>
  stripCrossJurisdictionCarrierPrivateData({ ...entry });

export function stripCrossJurisdictionAccountTxPrivateData(tx: AccountTx): AccountTx {
  if (tx.type !== 'swap_offer' || !tx.data.crossJurisdiction) return tx;
  return {
    ...tx,
    data: {
      ...tx.data,
      crossJurisdiction: stripCrossJurisdictionPrivateData({ ...tx.data.crossJurisdiction }),
    },
  };
}

export function stripCrossJurisdictionAccountFramePrivateData(frame: AccountFrame): AccountFrame {
  return {
    ...frame,
    accountTxs: frame.accountTxs.map(stripCrossJurisdictionAccountTxPrivateData),
  };
}

export function stripCrossJurisdictionAccountInputPrivateData(input: AccountInput): AccountInput {
  if (input.kind !== 'frame' && input.kind !== 'frame_ack') return input;
  return {
    ...input,
    newAccountFrame: stripCrossJurisdictionAccountFramePrivateData(input.newAccountFrame),
  } as AccountInput;
}

export function deriveCrossJurisdictionRouteHash(route: CrossJurisdictionSwapRoute): string {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  return ethers.keccak256(abiCoder.encode(
    ROUTE_HASH_ABI_TYPES,
    [
      String(route.orderId || ''),
      normalizeEntityId(route.bookOwnerEntityId || route.source.counterpartyEntityId || route.hubEntityId),
      String(route.venueId || ''),
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
      String(route.riskMode || ''),
      String(route.clearingPolicy || ''),
    ],
  ));
}

export function withCrossJurisdictionVenueDefaults(route: CrossJurisdictionSwapRoute): CrossJurisdictionSwapRoute {
  const bookOwnerEntityId = normalizeEntityId(route.bookOwnerEntityId || deriveCanonicalCrossJurisdictionBookOwner(route));
  const venueId = route.venueId || deriveCanonicalCrossJurisdictionVenueId(route);
  return {
    ...route,
    bookOwnerEntityId,
    venueId,
    hubEntityId: route.hubEntityId || bookOwnerEntityId,
  };
}

export function withCanonicalCrossJurisdictionRouteHash(route: CrossJurisdictionSwapRoute): CrossJurisdictionSwapRoute {
  const withDefaults = withCrossJurisdictionVenueDefaults(route);
  const routeHash = deriveCrossJurisdictionRouteHash(withDefaults);
  if (withDefaults.routeHash && String(withDefaults.routeHash).toLowerCase() !== routeHash.toLowerCase()) {
    throw new Error(`CROSS_J_ROUTE_HASH_MISMATCH:${route.orderId}`);
  }
  return { ...withDefaults, routeHash };
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
  privateSeed: string,
) {
  const seed = String(privateSeed || '').trim();
  if (!seed) throw new Error(`CROSS_J_HASHLADDER_PRIVATE_SEED_MISSING:${route.orderId}`);
  return buildHashLadderProof(seed);
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
  const hashLadderPrivateSeed = deriveCrossJurisdictionPrivateSeed(options.runtimeSeed, canonicalRoute);
  const proof = deriveCrossJurisdictionHashLadderProof(canonicalRoute, hashLadderPrivateSeed);
  const sourceAmount = BigInt(canonicalRoute.source.amount);
  const targetAmount = BigInt(canonicalRoute.target.amount);
  const sourcePullId = deriveCrossJurisdictionPullId(canonicalRoute, 'source');
  const targetPullId = deriveCrossJurisdictionPullId(canonicalRoute, 'target');
  const targetResponseWindowMs = Math.max(sourceDisputeDelayMs, CROSS_J_MIN_TARGET_RESPONSE_WINDOW_MS);
  const targetRevealUntilTimestamp = sourceRevealUntilTimestamp + targetResponseWindowMs + CROSS_J_TARGET_REVEAL_SAFETY_MS;
  return {
    ...canonicalRoute,
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
  privateSeed: string,
): HashLadderReveal {
  const proof = deriveCrossJurisdictionHashLadderProof(route, privateSeed);
  return revealHashLadder(proof, fillRatio);
}
