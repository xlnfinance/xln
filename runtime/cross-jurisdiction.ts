import { ethers } from 'ethers';
import { isLeftEntity } from './entity-id-utils';
import type {
  AccountFrame,
  AccountInput,
  AccountTx,
  CrossJurisdictionBookAdmission,
  CrossJurisdictionBookAdmissionReceipt,
  CrossJurisdictionCloseProof,
  CrossJurisdictionPendingFill,
  CrossJurisdictionPullBinding,
  CrossJurisdictionPullLeg,
  CrossJurisdictionSwapLeg,
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
import {
  deriveCanonicalCrossJurisdictionBookOwner,
  deriveCanonicalCrossJurisdictionVenueId,
} from './cross-jurisdiction-market';

export {
  deriveCanonicalCrossJurisdictionBookOwner,
  deriveCanonicalCrossJurisdictionBookOwnerForLegs,
  deriveCanonicalCrossJurisdictionMarket,
  deriveCanonicalCrossJurisdictionMarketForLegs,
  deriveCanonicalCrossJurisdictionVenueId,
  deriveCanonicalCrossJurisdictionVenueIdForLegs,
  type CanonicalCrossJurisdictionMarket,
} from './cross-jurisdiction-market';

export const CROSS_J_DEFAULT_SOURCE_REVEAL_WINDOW_MS = 60_000;
export const CROSS_J_TARGET_REVEAL_SAFETY_MS = 60_000;
export const CROSS_J_MIN_TARGET_RESPONSE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const CROSS_J_MAX_FILL_RATIO = 65_535;

const CROSS_J_STATUS_RANK: Record<CrossJurisdictionSwapStatus, number> = {
  intent: 10,
  target_prepared: 20,
  source_committed: 30,
  // Pull locks are pre-book safety states. They must rank below `resting`,
  // otherwise admission merges can keep a non-working route inside the matcher.
  target_locked: 35,
  source_locked: 36,
  resting: 40,
  partially_filled: 50,
  clear_requested: 60,
  clearing: 70,
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

const CROSS_J_ALLOWED_TRANSITIONS: Record<CrossJurisdictionSwapStatus, ReadonlySet<CrossJurisdictionSwapStatus>> = {
  intent: new Set(['intent', 'target_prepared', 'resting', 'cancelled', 'expired', 'failed']),
  target_prepared: new Set(['target_prepared', 'source_committed', 'target_locked', 'resting', 'clearing', 'cancelled', 'expired', 'failed']),
  source_committed: new Set(['source_committed', 'source_locked', 'resting', 'cancelled', 'expired', 'failed']),
  target_locked: new Set(['target_locked', 'source_locked', 'resting', 'clearing', 'cancelled', 'expired', 'failed']),
  source_locked: new Set(['source_locked', 'resting', 'cancelled', 'expired', 'failed']),
  resting: new Set(['resting', 'partially_filled', 'clear_requested', 'clearing', 'cancelled', 'expired', 'failed']),
  partially_filled: new Set(['partially_filled', 'clear_requested', 'clearing', 'cancelled', 'expired', 'failed']),
  clear_requested: new Set(['clear_requested', 'clearing', 'source_claimed', 'cancelled', 'expired', 'failed']),
  clearing: new Set(['clearing', 'source_claimed', 'target_claimed', 'settled', 'cancelled', 'expired', 'failed']),
  source_claimed: new Set(['source_claimed', 'target_claimed', 'settled', 'failed']),
  target_claimed: new Set(['target_claimed', 'settled', 'failed']),
  settled: new Set(['settled']),
  cancelled: new Set(['cancelled']),
  expired: new Set(['expired']),
  failed: new Set(['failed']),
};

export function isCrossJurisdictionRouteTransitionAllowed(
  current: CrossJurisdictionSwapStatus | undefined,
  next: CrossJurisdictionSwapStatus | undefined,
): boolean {
  if (!current || !next) return true;
  return Boolean(CROSS_J_ALLOWED_TRANSITIONS[current]?.has(next));
}

export function transitionCrossJurisdictionRouteStatus(
  route: CrossJurisdictionSwapRoute,
  nextStatus: CrossJurisdictionSwapStatus,
  updatedAt: number,
): CrossJurisdictionSwapRoute {
  if (!isCrossJurisdictionRouteTransitionAllowed(route.status, nextStatus)) {
    throw new Error(
      `CROSS_J_ROUTE_TRANSITION_INVALID: route=${route.orderId} ${route.status || 'intent'}->${nextStatus}`,
    );
  }
  route.status = nextStatus;
  route.updatedAt = updatedAt;
  return route;
}

export function isCrossJurisdictionRouteExpired(route: CrossJurisdictionSwapRoute, now: number): boolean {
  const expiresAt = Number(route.expiresAt || 0);
  return Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now;
}

export type CrossJurisdictionFillProgressInput = {
  fillSeq?: number | undefined;
  cumulativeFillRatio: number;
  fillNumerator?: bigint | undefined;
  fillDenominator?: bigint | undefined;
  incrementalSourceAmount?: bigint | undefined;
  incrementalTargetAmount?: bigint | undefined;
  cumulativeSourceAmount?: bigint | undefined;
  cumulativeTargetAmount?: bigint | undefined;
};

export type CrossJurisdictionFillProgress = {
  fillSeq: number;
  previousRatio: number;
  nextRatio: number;
  fillNumerator?: bigint | undefined;
  fillDenominator?: bigint | undefined;
  previousSourceAmount: bigint;
  previousTargetAmount: bigint;
  cumulativeSourceAmount: bigint;
  cumulativeTargetAmount: bigint;
  incrementalSourceAmount: bigint;
  incrementalTargetAmount: bigint;
};

const clampFillRatio = (value: unknown): number =>
  Math.max(0, Math.min(CROSS_J_MAX_FILL_RATIO, Math.floor(Number(value) || 0)));

const scaleByExactRatio = (total: bigint, numerator: bigint, denominator: bigint): bigint =>
  numerator >= denominator ? total : (total * numerator) / denominator;

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
  if ((input.fillNumerator === undefined) !== (input.fillDenominator === undefined)) {
    return { ok: false, error: 'exact fill ratio must include numerator and denominator' };
  }
  if (input.fillNumerator !== undefined && input.fillDenominator !== undefined) {
    if (input.fillDenominator <= 0n) return { ok: false, error: 'exact fill denominator must be positive' };
    if (input.fillNumerator < 0n || input.fillNumerator > input.fillDenominator) {
      return { ok: false, error: 'exact fill numerator out of range' };
    }
  }
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
  // Runtime order progress is exact. `cumulativeFillRatio` is the coarse
  // uint16 projection used by hash-ladder/dispute plumbing; it must not round
  // economic amounts inside the committed orderbook path.
  const useExactRatio = input.fillNumerator !== undefined && input.fillDenominator !== undefined;
  const cumulativeSourceAmount = useExactRatio
    ? scaleByExactRatio(sourceTotal, input.fillNumerator!, input.fillDenominator!)
    : (sourceTotal * BigInt(nextRatio)) / BigInt(CROSS_J_MAX_FILL_RATIO);
  const cumulativeTargetAmount = useExactRatio
    ? scaleByExactRatio(targetTotal, input.fillNumerator!, input.fillDenominator!)
    : (targetTotal * BigInt(nextRatio)) / BigInt(CROSS_J_MAX_FILL_RATIO);
  const incrementalSourceAmount = cumulativeSourceAmount - previousSourceAmount;
  const incrementalTargetAmount = cumulativeTargetAmount - previousTargetAmount;
  if (incrementalSourceAmount <= 0n || incrementalTargetAmount <= 0n) {
    return { ok: false, error: 'no incremental amount' };
  }

  if (input.cumulativeSourceAmount !== undefined && input.cumulativeSourceAmount !== cumulativeSourceAmount) {
    return {
      ok: false,
      error: `cumulative source mismatch: expected ${cumulativeSourceAmount}, got ${input.cumulativeSourceAmount} ` +
        `(previous=${previousSourceAmount}, total=${sourceTotal}, ratio=${nextRatio}, ` +
        `exact=${useExactRatio ? `${input.fillNumerator}/${input.fillDenominator}` : 'none'})`,
    };
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
      fillNumerator: input.fillNumerator,
      fillDenominator: input.fillDenominator,
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
    ...(fill.fillNumerator !== undefined ? { fillNumerator: fill.fillNumerator } : {}),
    ...(fill.fillDenominator !== undefined ? { fillDenominator: fill.fillDenominator } : {}),
    claimedRatio: fill.nextRatio,
    filledSourceAmount: fill.cumulativeSourceAmount,
    filledTargetAmount: fill.cumulativeTargetAmount,
    sourceClaimed: fill.cumulativeSourceAmount,
    targetClaimed: fill.cumulativeTargetAmount,
    status: fill.nextRatio >= CROSS_J_MAX_FILL_RATIO ? 'clear_requested' : 'partially_filled',
    updatedAt,
  };
}

export function requireCrossJurisdictionFillProgress(
  route: CrossJurisdictionSwapRoute,
  input: CrossJurisdictionFillProgressInput,
  errorPrefix: string,
): CrossJurisdictionFillProgress {
  const validatedFill = validateCrossJurisdictionFillProgress(route, input);
  if (!validatedFill.ok) {
    throw new Error(`${errorPrefix}: route=${route.orderId} ${validatedFill.error}`);
  }
  return validatedFill.value;
}

export function applyCrossJurisdictionFillProgress(
  route: CrossJurisdictionSwapRoute,
  input: CrossJurisdictionFillProgressInput,
  updatedAt: number,
  errorPrefix: string,
): CrossJurisdictionSwapRoute {
  return withCrossJurisdictionFillProgress(
    route,
    requireCrossJurisdictionFillProgress(route, input, errorPrefix),
    updatedAt,
  );
}

export function withCrossJurisdictionClaimProgress(
  route: CrossJurisdictionSwapRoute,
  fillRatio: number,
  updatedAt: number,
): CrossJurisdictionSwapRoute {
  const nextRatio = clampFillRatio(fillRatio);
  const previousClaimedRatio = clampFillRatio(route.claimedRatio);
  const committedRatio = Math.max(clampFillRatio(route.cumulativeFillRatio), previousClaimedRatio);
  if (nextRatio <= 0) {
    throw new Error(`CROSS_J_CLAIM_PROGRESS_INVALID: route=${route.orderId} zero ratio`);
  }
  if (committedRatio <= 0) {
    throw new Error(`CROSS_J_CLAIM_PROGRESS_INVALID: route=${route.orderId} no committed fill`);
  }
  if (nextRatio < previousClaimedRatio) {
    throw new Error(
      `CROSS_J_CLAIM_PROGRESS_INVALID: route=${route.orderId} stale ratio ${nextRatio} < ${previousClaimedRatio}`,
    );
  }
  if (nextRatio > committedRatio) {
    throw new Error(
      `CROSS_J_CLAIM_PROGRESS_INVALID: route=${route.orderId} ratio ${nextRatio} > committed ${committedRatio}`,
    );
  }

  const claimedRatio = Math.max(previousClaimedRatio, nextRatio);
  const sourceClaimed = (BigInt(route.source.amount) * BigInt(claimedRatio)) / BigInt(CROSS_J_MAX_FILL_RATIO);
  const targetClaimed = (BigInt(route.target.amount) * BigInt(claimedRatio)) / BigInt(CROSS_J_MAX_FILL_RATIO);
  return {
    ...route,
    claimedRatio,
    cumulativeFillRatio: Math.max(clampFillRatio(route.cumulativeFillRatio), claimedRatio),
    sourceClaimed,
    targetClaimed,
    filledSourceAmount: sourceClaimed,
    filledTargetAmount: targetClaimed,
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

const normalizeJurisdiction = (value: string): string => String(value || '').trim().toLowerCase();
const normalizeEntityId = (value: string): string => String(value || '').toLowerCase();
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

const optionalString = (value: unknown): string | undefined => {
  const text = String(value ?? '').trim();
  return text ? text : undefined;
};

const optionalNumber = (value: unknown): number | undefined =>
  value === undefined || value === null ? undefined : Number(value);

const optionalBigInt = (value: unknown): bigint | undefined =>
  value === undefined || value === null ? undefined : BigInt(value as bigint | number | string);

const optionalStatus = (value: unknown): CrossJurisdictionSwapStatus | undefined =>
  typeof value === 'string' ? (value as CrossJurisdictionSwapStatus) : undefined;

const cloneCrossJurisdictionSwapLeg = (value: CrossJurisdictionSwapLeg): CrossJurisdictionSwapLeg => ({
  jurisdiction: String(value.jurisdiction || ''),
  entityId: String(value.entityId || ''),
  counterpartyEntityId: String(value.counterpartyEntityId || ''),
  tokenId: Number(value.tokenId),
  amount: BigInt(value.amount),
});

const cloneCrossJurisdictionPullLeg = (value: CrossJurisdictionPullLeg | undefined): CrossJurisdictionPullLeg | undefined => {
  if (!value) return undefined;
  return {
    pullId: String(value.pullId || ''),
    tokenId: Number(value.tokenId),
    amount: BigInt(value.amount),
    signedAmount: BigInt(value.signedAmount),
    revealedUntilTimestamp: Number(value.revealedUntilTimestamp),
    fullHash: String(value.fullHash || ''),
    partialRoot: String(value.partialRoot || ''),
  };
};

export function hashCrossJurisdictionCloseBinary(binary: string): string {
  return ethers.keccak256(String(binary || '0x') as `0x${string}`);
}

export function cloneCrossJurisdictionCloseProof(
  proof: CrossJurisdictionCloseProof,
): CrossJurisdictionCloseProof {
  return {
    orderId: String(proof.orderId || ''),
    routeHash: String(proof.routeHash || ''),
    sourcePullId: String(proof.sourcePullId || ''),
    targetPullId: String(proof.targetPullId || ''),
    fillRatio: Math.max(0, Math.min(CROSS_J_MAX_FILL_RATIO, Math.floor(Number(proof.fillRatio) || 0))),
    cumulativeSourceAmount: BigInt(proof.cumulativeSourceAmount ?? 0n),
    cumulativeTargetAmount: BigInt(proof.cumulativeTargetAmount ?? 0n),
    binaryHash: String(proof.binaryHash || ''),
    closeMode: proof.closeMode === 'full'
      ? 'full'
      : proof.closeMode === 'pure_cancel'
        ? 'pure_cancel'
        : 'partial_cancel_remainder',
  };
}

export function buildCrossJurisdictionCloseProof(
  route: CrossJurisdictionSwapRoute,
  binary: string,
): CrossJurisdictionCloseProof {
  const canonical = withCanonicalCrossJurisdictionRouteHash(route);
  if (!canonical.sourcePull || !canonical.targetPull) {
    throw new Error(`CROSS_J_CLOSE_PROOF_PULLS_MISSING:${canonical.orderId}`);
  }
  const fillRatio = Math.max(
    0,
    Math.min(
      CROSS_J_MAX_FILL_RATIO,
      Math.floor(Number(canonical.cumulativeFillRatio ?? canonical.claimedRatio ?? 0) || 0),
    ),
  );
  const sourceTotal = BigInt(canonical.source.amount);
  const targetTotal = BigInt(canonical.target.amount);
  const cumulativeSourceAmount =
    canonical.filledSourceAmount ??
    canonical.sourceClaimed ??
    ((sourceTotal * BigInt(fillRatio)) / BigInt(CROSS_J_MAX_FILL_RATIO));
  const cumulativeTargetAmount =
    canonical.filledTargetAmount ??
    canonical.targetClaimed ??
    ((targetTotal * BigInt(fillRatio)) / BigInt(CROSS_J_MAX_FILL_RATIO));
  return cloneCrossJurisdictionCloseProof({
    orderId: canonical.orderId,
    routeHash: canonical.routeHash || deriveCrossJurisdictionRouteHash(canonical),
    sourcePullId: canonical.sourcePull.pullId,
    targetPullId: canonical.targetPull.pullId,
    fillRatio,
    cumulativeSourceAmount,
    cumulativeTargetAmount,
    binaryHash: hashCrossJurisdictionCloseBinary(binary),
    closeMode: fillRatio >= CROSS_J_MAX_FILL_RATIO
      ? 'full'
      : fillRatio <= 0
        ? 'pure_cancel'
        : 'partial_cancel_remainder',
  });
}

export function getCrossJurisdictionPrivateSeed(
  env: Pick<Env, 'runtimeSeed'>,
  route: CrossJurisdictionSwapRoute,
): string {
  return deriveCrossJurisdictionPrivateSeed(env.runtimeSeed, route);
}

export function cloneCrossJurisdictionRoute(route: CrossJurisdictionSwapRoute): CrossJurisdictionSwapRoute {
  const clone: CrossJurisdictionSwapRoute = {
    orderId: String(route.orderId || ''),
    makerEntityId: String(route.makerEntityId || ''),
    hubEntityId: String(route.hubEntityId || ''),
    source: cloneCrossJurisdictionSwapLeg(route.source),
    target: cloneCrossJurisdictionSwapLeg(route.target),
    status: optionalStatus(route.status) ?? 'intent',
    createdAt: Number(route.createdAt || 0),
    updatedAt: Number(route.updatedAt || 0),
  };
  const routeHash = optionalString(route.routeHash);
  const bookOwnerEntityId = optionalString(route.bookOwnerEntityId);
  const venueId = optionalString(route.venueId);
  const sourceSignerId = optionalString(route.sourceSignerId);
  const sourceHubSignerId = optionalString(route.sourceHubSignerId);
  const targetHubSignerId = optionalString(route.targetHubSignerId);
  const targetSignerId = optionalString(route.targetSignerId);
  const bookHubSignerId = optionalString(route.bookHubSignerId);
  const sourcePull = cloneCrossJurisdictionPullLeg(route.sourcePull);
  const targetPull = cloneCrossJurisdictionPullLeg(route.targetPull);
  const targetReceipt = route.targetReceipt
    ? cloneCrossJurisdictionBookAdmissionReceipt(route.targetReceipt)
    : undefined;
  const sourceCloseProof = route.sourceCloseProof
    ? cloneCrossJurisdictionCloseProof(route.sourceCloseProof)
    : undefined;
  const targetCloseProof = route.targetCloseProof
    ? cloneCrossJurisdictionCloseProof(route.targetCloseProof)
    : undefined;
  const priceTicks = optionalBigInt(route.priceTicks);
  const fillSeq = optionalNumber(route.fillSeq);
  const cumulativeFillRatio = optionalNumber(route.cumulativeFillRatio);
  const fillNumerator = optionalBigInt(route.fillNumerator);
  const fillDenominator = optionalBigInt(route.fillDenominator);
  const filledSourceAmount = optionalBigInt(route.filledSourceAmount);
  const filledTargetAmount = optionalBigInt(route.filledTargetAmount);
  const priceImprovementSourceAmount = optionalBigInt(route.priceImprovementSourceAmount);
  const priceImprovementTargetAmount = optionalBigInt(route.priceImprovementTargetAmount);
  const pendingClearRequestedAt = optionalNumber(route.pendingClearRequestedAt);
  const claimedRatio = optionalNumber(route.claimedRatio);
  const sourceClaimed = optionalBigInt(route.sourceClaimed);
  const targetClaimed = optionalBigInt(route.targetClaimed);
  const expiresAt = optionalNumber(route.expiresAt);
  const settledAt = optionalNumber(route.settledAt);
  const error = optionalString(route.error);
  const memo = optionalString(route.memo);

  if (routeHash) clone.routeHash = routeHash;
  if (bookOwnerEntityId) clone.bookOwnerEntityId = bookOwnerEntityId;
  if (venueId) clone.venueId = venueId;
  if (sourceSignerId) clone.sourceSignerId = sourceSignerId;
  if (sourceHubSignerId) clone.sourceHubSignerId = sourceHubSignerId;
  if (targetHubSignerId) clone.targetHubSignerId = targetHubSignerId;
  if (targetSignerId) clone.targetSignerId = targetSignerId;
  if (bookHubSignerId) clone.bookHubSignerId = bookHubSignerId;
  if (sourcePull) clone.sourcePull = sourcePull;
  if (targetPull) clone.targetPull = targetPull;
  if (targetReceipt) clone.targetReceipt = targetReceipt;
  if (sourceCloseProof) clone.sourceCloseProof = sourceCloseProof;
  if (targetCloseProof) clone.targetCloseProof = targetCloseProof;
  if (priceTicks !== undefined) clone.priceTicks = priceTicks;
  if (fillSeq !== undefined) clone.fillSeq = fillSeq;
  if (cumulativeFillRatio !== undefined) clone.cumulativeFillRatio = cumulativeFillRatio;
  if (fillNumerator !== undefined) clone.fillNumerator = fillNumerator;
  if (fillDenominator !== undefined) clone.fillDenominator = fillDenominator;
  if (filledSourceAmount !== undefined) clone.filledSourceAmount = filledSourceAmount;
  if (filledTargetAmount !== undefined) clone.filledTargetAmount = filledTargetAmount;
  if (priceImprovementSourceAmount !== undefined) clone.priceImprovementSourceAmount = priceImprovementSourceAmount;
  if (priceImprovementTargetAmount !== undefined) clone.priceImprovementTargetAmount = priceImprovementTargetAmount;
  if (pendingClearRequestedAt !== undefined) clone.pendingClearRequestedAt = pendingClearRequestedAt;
  if (route.clearingPolicy) clone.clearingPolicy = route.clearingPolicy;
  if (route.priceImprovementMode) clone.priceImprovementMode = route.priceImprovementMode;
  if (route.riskMode) clone.riskMode = route.riskMode;
  if (claimedRatio !== undefined) clone.claimedRatio = claimedRatio;
  if (sourceClaimed !== undefined) clone.sourceClaimed = sourceClaimed;
  if (targetClaimed !== undefined) clone.targetClaimed = targetClaimed;
  if (expiresAt !== undefined) clone.expiresAt = expiresAt;
  if (settledAt !== undefined) clone.settledAt = settledAt;
  if (error) clone.error = error;
  if (memo) clone.memo = memo;
  return clone;
}

export function cloneCrossJurisdictionBookAdmissionReceipt(
  receipt: CrossJurisdictionBookAdmissionReceipt,
): CrossJurisdictionBookAdmissionReceipt {
  return {
    leg: receipt.leg,
    orderId: String(receipt.orderId || ''),
    routeHash: String(receipt.routeHash || ''),
    hubEntityId: String(receipt.hubEntityId || ''),
    counterpartyEntityId: String(receipt.counterpartyEntityId || ''),
    pullId: String(receipt.pullId || ''),
    tokenId: Number(receipt.tokenId),
    signedAmount: BigInt(receipt.signedAmount),
    revealedUntilTimestamp: Number(receipt.revealedUntilTimestamp),
    fullHash: String(receipt.fullHash || ''),
    partialRoot: String(receipt.partialRoot || ''),
    committedAt: Number(receipt.committedAt || 0),
  };
}

function cloneCrossJurisdictionPendingFill(
  pendingFill: CrossJurisdictionPendingFill,
): CrossJurisdictionPendingFill {
  return {
    fillId: String(pendingFill.fillId || ''),
    ackKind: pendingFill.ackKind === 'cancel' ? 'cancel' : 'fill',
    fillSeq: Math.max(0, Math.floor(Number(pendingFill.fillSeq ?? 0) || 0)),
    ...(pendingFill.previousFillSeq !== undefined
      ? { previousFillSeq: Math.max(0, Math.floor(Number(pendingFill.previousFillSeq) || 0)) }
      : {}),
    cumulativeFillRatio: Math.max(0, Math.floor(Number(pendingFill.cumulativeFillRatio ?? 0) || 0)),
    cumulativeSourceAmount: BigInt(pendingFill.cumulativeSourceAmount ?? 0n),
    cumulativeTargetAmount: BigInt(pendingFill.cumulativeTargetAmount ?? 0n),
    ...(pendingFill.fillNumerator !== undefined ? { fillNumerator: BigInt(pendingFill.fillNumerator) } : {}),
    ...(pendingFill.fillDenominator !== undefined ? { fillDenominator: BigInt(pendingFill.fillDenominator) } : {}),
    routeHash: String(pendingFill.routeHash || ''),
    updatedAt: Number(pendingFill.updatedAt || 0),
  };
}

export function cloneCrossJurisdictionPullBinding(
  binding: CrossJurisdictionPullBinding,
): CrossJurisdictionPullBinding {
  const clone: CrossJurisdictionPullBinding = {
    orderId: String(binding.orderId || ''),
    routeHash: String(binding.routeHash || ''),
    leg: binding.leg,
  };
  if (binding.targetReceipt) {
    clone.targetReceipt = cloneCrossJurisdictionBookAdmissionReceipt(binding.targetReceipt);
  }
  if (binding.sourceCloseProof) {
    clone.sourceCloseProof = cloneCrossJurisdictionCloseProof(binding.sourceCloseProof);
  }
  if (binding.status) clone.status = binding.status;
  const cumulativeFillRatio = optionalNumber(binding.cumulativeFillRatio);
  const claimedRatio = optionalNumber(binding.claimedRatio);
  const filledSourceAmount = optionalBigInt(binding.filledSourceAmount);
  const filledTargetAmount = optionalBigInt(binding.filledTargetAmount);
  const sourceClaimed = optionalBigInt(binding.sourceClaimed);
  const targetClaimed = optionalBigInt(binding.targetClaimed);
  if (cumulativeFillRatio !== undefined) clone.cumulativeFillRatio = cumulativeFillRatio;
  if (claimedRatio !== undefined) clone.claimedRatio = claimedRatio;
  if (filledSourceAmount !== undefined) clone.filledSourceAmount = filledSourceAmount;
  if (filledTargetAmount !== undefined) clone.filledTargetAmount = filledTargetAmount;
  if (sourceClaimed !== undefined) clone.sourceClaimed = sourceClaimed;
  if (targetClaimed !== undefined) clone.targetClaimed = targetClaimed;
  if (binding.clearingPolicy) clone.clearingPolicy = binding.clearingPolicy;
  return clone;
}

export function buildCrossJurisdictionPullBinding(
  route: CrossJurisdictionSwapRoute,
  leg: CrossJurisdictionPullBinding['leg'],
): CrossJurisdictionPullBinding {
  const canonical = withCanonicalCrossJurisdictionRouteHash(route);
  return cloneCrossJurisdictionPullBinding({
    orderId: canonical.orderId,
    routeHash: canonical.routeHash || deriveCrossJurisdictionRouteHash(canonical),
    leg,
    ...(canonical.targetReceipt ? { targetReceipt: canonical.targetReceipt } : {}),
    ...(canonical.sourceCloseProof ? { sourceCloseProof: canonical.sourceCloseProof } : {}),
    status: canonical.status,
    ...(canonical.cumulativeFillRatio !== undefined ? { cumulativeFillRatio: canonical.cumulativeFillRatio } : {}),
    ...(canonical.claimedRatio !== undefined ? { claimedRatio: canonical.claimedRatio } : {}),
    ...(canonical.filledSourceAmount !== undefined ? { filledSourceAmount: canonical.filledSourceAmount } : {}),
    ...(canonical.filledTargetAmount !== undefined ? { filledTargetAmount: canonical.filledTargetAmount } : {}),
    ...(canonical.sourceClaimed !== undefined ? { sourceClaimed: canonical.sourceClaimed } : {}),
    ...(canonical.targetClaimed !== undefined ? { targetClaimed: canonical.targetClaimed } : {}),
    ...(canonical.clearingPolicy ? { clearingPolicy: canonical.clearingPolicy } : {}),
  });
}

export function buildCommittedCrossJurisdictionPullBinding(
  route: CrossJurisdictionSwapRoute,
  leg: CrossJurisdictionPullBinding['leg'],
): CrossJurisdictionPullBinding {
  const routeHash = String(route.routeHash || '').toLowerCase();
  if (!routeHash) throw new Error(`CROSS_J_ROUTE_HASH_MISSING:${route.orderId}`);
  // Use this only after the route has entered committed account state. Immutable
  // economic terms were already route-hash checked at admission/swap_offer time;
  // fill progress is mutable and deliberately not part of the route hash.
  return cloneCrossJurisdictionPullBinding({
    orderId: String(route.orderId || ''),
    routeHash,
    leg,
    ...(route.targetReceipt ? { targetReceipt: route.targetReceipt } : {}),
    ...(route.sourceCloseProof ? { sourceCloseProof: route.sourceCloseProof } : {}),
    status: route.status,
    ...(route.cumulativeFillRatio !== undefined ? { cumulativeFillRatio: route.cumulativeFillRatio } : {}),
    ...(route.claimedRatio !== undefined ? { claimedRatio: route.claimedRatio } : {}),
    ...(route.filledSourceAmount !== undefined ? { filledSourceAmount: route.filledSourceAmount } : {}),
    ...(route.filledTargetAmount !== undefined ? { filledTargetAmount: route.filledTargetAmount } : {}),
    ...(route.sourceClaimed !== undefined ? { sourceClaimed: route.sourceClaimed } : {}),
    ...(route.targetClaimed !== undefined ? { targetClaimed: route.targetClaimed } : {}),
    ...(route.clearingPolicy ? { clearingPolicy: route.clearingPolicy } : {}),
  });
}

export function cloneCrossJurisdictionBookAdmission(
  admission: CrossJurisdictionBookAdmission,
): CrossJurisdictionBookAdmission {
  const clone: CrossJurisdictionBookAdmission = {
    orderId: String(admission.orderId || ''),
    routeHash: String(admission.routeHash || ''),
    sourceEntityId: String(admission.sourceEntityId || ''),
    bookOwnerEntityId: String(admission.bookOwnerEntityId || ''),
    status: admission.status || 'pending',
    route: cloneCrossJurisdictionRoute(admission.route),
    updatedAt: Number(admission.updatedAt || 0),
  };
  if (admission.sourceReceipt) {
    clone.sourceReceipt = cloneCrossJurisdictionBookAdmissionReceipt(admission.sourceReceipt);
  }
  if (admission.targetReceipt) {
    clone.targetReceipt = cloneCrossJurisdictionBookAdmissionReceipt(admission.targetReceipt);
  }
  const admittedAt = optionalNumber(admission.admittedAt);
  const resolvingAt = optionalNumber(admission.resolvingAt);
  const closedAt = optionalNumber(admission.closedAt);
  const closeReason = optionalString(admission.closeReason);
  if (admittedAt !== undefined) clone.admittedAt = admittedAt;
  if (resolvingAt !== undefined) clone.resolvingAt = resolvingAt;
  if (closedAt !== undefined) clone.closedAt = closedAt;
  if (closeReason) clone.closeReason = closeReason;
  if (admission.pendingFill) clone.pendingFill = cloneCrossJurisdictionPendingFill(admission.pendingFill);
  return clone;
}

export function cloneCrossJurisdictionCarrierRoute<T extends { crossJurisdiction?: CrossJurisdictionSwapRoute }>(value: T): T {
  if (!value.crossJurisdiction) return value;
  return {
    ...value,
    crossJurisdiction: cloneCrossJurisdictionRoute(value.crossJurisdiction),
  };
}

export const cloneCrossJurisdictionSwapOfferRoute = (offer: SwapOffer): SwapOffer =>
  cloneCrossJurisdictionCarrierRoute({ ...offer });

export const cloneCrossJurisdictionSwapHistoryRoute = (entry: SwapOrderHistoryEntry): SwapOrderHistoryEntry =>
  cloneCrossJurisdictionCarrierRoute({ ...entry });

export function cloneCrossJurisdictionAccountTxRoute(tx: AccountTx): AccountTx {
  if (tx.type === 'pull_lock' && tx.data.crossJurisdiction) {
    return {
      ...tx,
      data: {
        ...tx.data,
        crossJurisdiction: cloneCrossJurisdictionPullBinding(tx.data.crossJurisdiction),
      },
    };
  }
  if (tx.type !== 'swap_offer' || !tx.data.crossJurisdiction) return tx;
  return {
    ...tx,
    data: {
      ...tx.data,
      crossJurisdiction: cloneCrossJurisdictionRoute(tx.data.crossJurisdiction),
    },
  };
}

export function cloneCrossJurisdictionAccountFrameRoute(frame: AccountFrame): AccountFrame {
  return {
    ...frame,
    accountTxs: frame.accountTxs.map(cloneCrossJurisdictionAccountTxRoute),
  };
}

export function cloneCrossJurisdictionAccountInputRoute(input: AccountInput): AccountInput {
  if (input.kind !== 'frame' && input.kind !== 'frame_ack') return input;
  return {
    ...input,
    newAccountFrame: cloneCrossJurisdictionAccountFrameRoute(input.newAccountFrame),
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
      String(route.priceImprovementMode || ''),
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

const assertCrossJurisdictionAssetRouteIsUseful = (route: CrossJurisdictionSwapRoute): void => {
  const sameJurisdiction = normalizeJurisdiction(route.source.jurisdiction) === normalizeJurisdiction(route.target.jurisdiction);
  const sameToken = Number(route.source.tokenId) === Number(route.target.tokenId);
  if (sameJurisdiction && sameToken) {
    throw new Error(
      `CROSS_J_SAME_JURISDICTION_TOKEN_INVALID:${route.orderId}:` +
        `${route.source.jurisdiction}:${route.source.tokenId}`,
    );
  }
};

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
  assertCrossJurisdictionAssetRouteIsUseful(canonicalRoute);
  const privateSeed = deriveCrossJurisdictionPrivateSeed(options.runtimeSeed, canonicalRoute);
  const proof = deriveCrossJurisdictionHashLadderProof(canonicalRoute, privateSeed);
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
