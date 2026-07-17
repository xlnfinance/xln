import { ethers } from 'ethers';
import { isLeftEntity } from '../../entity/id';
import type {
  AccountFrame,
  AccountInput,
  AccountTx,
  CrossJurisdictionBookAdmission,
  CrossJurisdictionBookAdmissionReceipt,
  CrossJurisdictionCloseProof,
  CrossJurisdictionRouteDomain,
  CrossJurisdictionSettlementPolicy,
  CrossJurisdictionPendingFill,
  CrossJurisdictionPullBinding,
  CrossJurisdictionPullLeg,
  CrossJurisdictionSwapLeg,
  CrossJurisdictionSwapRoute,
  CrossJurisdictionSwapStatus,
  CrossJurisdictionTimePolicy,
  Env,
  SwapOffer,
  SwapOrderHistoryEntry,
} from '../../types';
import {
  buildHashLadderProof,
  revealHashLadder,
  type HashLadderReveal,
} from '../../protocol/htlc/hash-ladder';
import {
  deriveCanonicalCrossJurisdictionBookOwner,
  deriveCanonicalCrossJurisdictionVenueId,
} from './market';
import { exactFillRatioToUint16 } from '../../orderbook/swap-execution';

export {
  deriveCanonicalCrossJurisdictionBookOwner,
  deriveCanonicalCrossJurisdictionBookOwnerForLegs,
  deriveCanonicalCrossJurisdictionMarket,
  deriveCanonicalCrossJurisdictionMarketForLegs,
  deriveCanonicalCrossJurisdictionVenueId,
  deriveCanonicalCrossJurisdictionVenueIdForLegs,
  type CanonicalCrossJurisdictionMarket,
} from './market';

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
  intent: new Set(['intent', 'target_prepared', 'target_locked', 'resting', 'cancelled', 'expired', 'failed']),
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

type CrossJurisdictionExactFillRatioInput = {
  fillNumerator?: bigint | undefined;
  fillDenominator?: bigint | undefined;
  orderId?: string | undefined;
};

type CrossJurisdictionExactFillRatio = {
  numerator: bigint;
  denominator: bigint;
};

const readCrossJurisdictionExactFillRatio = (
  input: CrossJurisdictionExactFillRatioInput,
  fallbackOrderId: string,
): CrossJurisdictionExactFillRatio | undefined => {
  const hasExactFillRatio = input.fillNumerator !== undefined || input.fillDenominator !== undefined;
  if (!hasExactFillRatio) return undefined;
  const orderId = input.orderId || fallbackOrderId;
  if (input.fillNumerator === undefined || input.fillDenominator === undefined) {
    throw new Error(`CROSS_J_EXACT_FILL_RATIO_INCOMPLETE:${orderId}`);
  }
  if (input.fillDenominator <= 0n || input.fillNumerator < 0n || input.fillNumerator > input.fillDenominator) {
    throw new Error(`CROSS_J_EXACT_FILL_RATIO_INVALID:${orderId}:${input.fillNumerator}/${input.fillDenominator}`);
  }
  return {
    numerator: input.fillNumerator,
    denominator: input.fillDenominator,
  };
};

type CrossJurisdictionCommittedProofRatioInput = {
  cumulativeFillRatio?: number | undefined;
  claimedRatio?: number | undefined;
  fillNumerator?: bigint | undefined;
  fillDenominator?: bigint | undefined;
  orderId?: string | undefined;
};

export function getCrossJurisdictionCommittedProofRatio(input: CrossJurisdictionCommittedProofRatioInput): number {
  const coarseFillRatio = Math.max(clampFillRatio(input.cumulativeFillRatio), clampFillRatio(input.claimedRatio));
  const exactFillRatio = readCrossJurisdictionExactFillRatio(input, 'unknown');
  if (!exactFillRatio) return coarseFillRatio;
  return Math.max(coarseFillRatio, exactFillRatioToUint16(exactFillRatio));
}

export function getCrossJurisdictionCommittedFillAmounts(route: CrossJurisdictionSwapRoute): {
  sourceTotal: bigint;
  targetTotal: bigint;
  filledSourceAmount: bigint;
  filledTargetAmount: bigint;
  fillRatio: number;
} {
  const sourceTotal = BigInt(route.source.amount);
  const targetTotal = BigInt(route.target.amount);
  const exactFillRatio = readCrossJurisdictionExactFillRatio(route, route.orderId);
  const exactSourceAmount = exactFillRatio
    ? scaleByExactRatio(sourceTotal, exactFillRatio.numerator, exactFillRatio.denominator)
    : undefined;
  const exactTargetAmount = exactFillRatio
    ? scaleByExactRatio(targetTotal, exactFillRatio.numerator, exactFillRatio.denominator)
    : undefined;
  const fillRatio = getCrossJurisdictionCommittedProofRatio(route);
  const quantizedSourceAmount = fillRatio >= CROSS_J_MAX_FILL_RATIO
    ? sourceTotal
    : (sourceTotal * BigInt(fillRatio)) / BigInt(CROSS_J_MAX_FILL_RATIO);
  const quantizedTargetAmount = fillRatio >= CROSS_J_MAX_FILL_RATIO
    ? targetTotal
    : (targetTotal * BigInt(fillRatio)) / BigInt(CROSS_J_MAX_FILL_RATIO);
  return {
    sourceTotal,
    targetTotal,
    filledSourceAmount: route.filledSourceAmount ?? exactSourceAmount ?? route.sourceClaimed ?? quantizedSourceAmount,
    filledTargetAmount: route.filledTargetAmount ?? exactTargetAmount ?? route.targetClaimed ?? quantizedTargetAmount,
    fillRatio,
  };
}

const committedFillAmountsHaveProgress = (
  committedFill: Pick<ReturnType<typeof getCrossJurisdictionCommittedFillAmounts>, 'fillRatio' | 'filledSourceAmount' | 'filledTargetAmount'>,
): boolean => (
  committedFill.fillRatio > 0 ||
  committedFill.filledSourceAmount > 0n ||
  committedFill.filledTargetAmount > 0n
);

export const hasCrossJurisdictionCommittedFill = (route: CrossJurisdictionSwapRoute): boolean =>
  committedFillAmountsHaveProgress(getCrossJurisdictionCommittedFillAmounts(route));

const ceilDiv = (numerator: bigint, denominator: bigint): bigint => {
  if (denominator <= 0n) throw new Error(`CROSS_J_CEIL_DIV_DENOMINATOR_INVALID:${denominator.toString()}`);
  return numerator <= 0n ? 0n : (numerator + denominator - 1n) / denominator;
};

const defaultQuantizationDust = (amount: bigint): bigint =>
  amount <= 0n ? 0n : ceilDiv(amount, BigInt(CROSS_J_MAX_FILL_RATIO));

const normalizeOptionalAddress = (value: unknown): string | undefined => {
  const text = String(value ?? '').trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(text) ? text : undefined;
};

const normalizeStackRef = (value: unknown): string =>
  String(value ?? '').trim().toLowerCase();

const defaultAssetRef = (jurisdiction: string, tokenId: number): string =>
  `${normalizeStackRef(jurisdiction)}:${Math.floor(Number(tokenId))}`;

const normalizeCrossJurisdictionRouteDomain = (
  route: CrossJurisdictionSwapRoute,
): CrossJurisdictionRouteDomain => {
  const sourceStackId = normalizeStackRef(route.domain?.sourceStackId || route.source.jurisdiction);
  const targetStackId = normalizeStackRef(route.domain?.targetStackId || route.target.jurisdiction);
  return {
    protocol: 'xln-cross-j',
    hashSchema: 'route-domain',
    sourceStackId,
    targetStackId,
    ...(normalizeOptionalAddress(route.domain?.sourceEntityProviderAddress)
      ? { sourceEntityProviderAddress: normalizeOptionalAddress(route.domain?.sourceEntityProviderAddress)! }
      : {}),
    ...(normalizeOptionalAddress(route.domain?.targetEntityProviderAddress)
      ? { targetEntityProviderAddress: normalizeOptionalAddress(route.domain?.targetEntityProviderAddress)! }
      : {}),
    ...(normalizeOptionalAddress(route.domain?.sourceDeltaTransformerAddress)
      ? { sourceDeltaTransformerAddress: normalizeOptionalAddress(route.domain?.sourceDeltaTransformerAddress)! }
      : {}),
    ...(normalizeOptionalAddress(route.domain?.targetDeltaTransformerAddress)
      ? { targetDeltaTransformerAddress: normalizeOptionalAddress(route.domain?.targetDeltaTransformerAddress)! }
      : {}),
    sourceAssetRef: String(route.domain?.sourceAssetRef || defaultAssetRef(route.source.jurisdiction, route.source.tokenId)).trim().toLowerCase(),
    targetAssetRef: String(route.domain?.targetAssetRef || defaultAssetRef(route.target.jurisdiction, route.target.tokenId)).trim().toLowerCase(),
  };
};

const normalizeCrossJurisdictionSettlementPolicy = (
  route: CrossJurisdictionSwapRoute,
): CrossJurisdictionSettlementPolicy => {
  const sourceAmount = BigInt(route.source.amount);
  const targetAmount = BigInt(route.target.amount);
  const maxSourceDust = route.settlementPolicy?.maxSourceDust ?? defaultQuantizationDust(sourceAmount);
  const maxTargetDust = route.settlementPolicy?.maxTargetDust ?? defaultQuantizationDust(targetAmount);
  if (maxSourceDust < 0n || maxTargetDust < 0n) {
    throw new Error(`CROSS_J_SETTLEMENT_POLICY_DUST_INVALID:${route.orderId}`);
  }
  return {
    roundingMode: 'uint16_ceil',
    maxSourceDust,
    maxTargetDust,
    ...(route.settlementPolicy?.minSourceFillAmount !== undefined
      ? { minSourceFillAmount: BigInt(route.settlementPolicy.minSourceFillAmount) }
      : {}),
    ...(route.settlementPolicy?.minTargetFillAmount !== undefined
      ? { minTargetFillAmount: BigInt(route.settlementPolicy.minTargetFillAmount) }
      : {}),
  };
};

const normalizeCrossJurisdictionTimePolicy = (
  route: CrossJurisdictionSwapRoute,
): CrossJurisdictionTimePolicy => {
  const runtimeExpiresAtMs = Math.floor(Number(route.timePolicy?.runtimeExpiresAtMs ?? route.expiresAt ?? 0));
  if (!Number.isFinite(runtimeExpiresAtMs) || runtimeExpiresAtMs < 0) {
    throw new Error(`CROSS_J_TIME_POLICY_EXPIRES_INVALID:${route.orderId}`);
  }
  return {
    runtimeClock: 'unix_ms',
    settlementClock: 'unix_seconds',
    deadlineConversion: 'floor_ms_to_unix_seconds',
    runtimeExpiresAtMs,
    finalityPolicy: 'source_deadline_then_target_safety',
  };
};

export function withCrossJurisdictionPolicyDefaults(route: CrossJurisdictionSwapRoute): CrossJurisdictionSwapRoute {
  return {
    ...route,
    riskMode: route.riskMode || 'fully_collateralized',
    domain: normalizeCrossJurisdictionRouteDomain(route),
    settlementPolicy: normalizeCrossJurisdictionSettlementPolicy(route),
    timePolicy: normalizeCrossJurisdictionTimePolicy(route),
  };
}

export function assertCrossJurisdictionRiskPolicy(route: CrossJurisdictionSwapRoute): void {
  const riskMode = route.riskMode || 'fully_collateralized';
  if (riskMode !== 'fully_collateralized') {
    throw new Error(`CROSS_J_RISK_MODE_UNSUPPORTED:${route.orderId}:${riskMode}`);
  }
}

export function projectCrossJurisdictionQuantizedClaim(
  total: bigint,
  input: {
    cumulativeFillRatio: number;
    fillNumerator?: bigint | undefined;
    fillDenominator?: bigint | undefined;
    orderId?: string | undefined;
  },
): { exactClaim: bigint; quantizedClaim: bigint; roundingDelta: bigint } {
  const ratio = clampFillRatio(input.cumulativeFillRatio);
  const quantizedClaim = ratio >= CROSS_J_MAX_FILL_RATIO
    ? total
    : (total * BigInt(ratio)) / BigInt(CROSS_J_MAX_FILL_RATIO);
  const exactFillRatio = readCrossJurisdictionExactFillRatio(input, 'quantized-claim');
  const exactClaim = exactFillRatio
    ? scaleByExactRatio(total, exactFillRatio.numerator, exactFillRatio.denominator)
    : quantizedClaim;
  return {
    exactClaim,
    quantizedClaim,
    roundingDelta: quantizedClaim >= exactClaim ? quantizedClaim - exactClaim : exactClaim - quantizedClaim,
  };
}

export function validateCrossJurisdictionQuantization(
  route: CrossJurisdictionSwapRoute,
  input: {
    cumulativeFillRatio: number;
    fillNumerator?: bigint | undefined;
    fillDenominator?: bigint | undefined;
    cumulativeSourceAmount: bigint;
    cumulativeTargetAmount: bigint;
  },
): string | null {
  const policy = normalizeCrossJurisdictionSettlementPolicy(route);
  if (input.cumulativeSourceAmount < (policy.minSourceFillAmount ?? 0n)) {
    return `source fill below minimum ${input.cumulativeSourceAmount} < ${policy.minSourceFillAmount}`;
  }
  if (input.cumulativeTargetAmount < (policy.minTargetFillAmount ?? 0n)) {
    return `target fill below minimum ${input.cumulativeTargetAmount} < ${policy.minTargetFillAmount}`;
  }

  const source = projectCrossJurisdictionQuantizedClaim(BigInt(route.source.amount), {
    ...input,
    orderId: route.orderId,
  });
  const target = projectCrossJurisdictionQuantizedClaim(BigInt(route.target.amount), {
    ...input,
    orderId: route.orderId,
  });
  if (source.exactClaim !== input.cumulativeSourceAmount) {
    return `source exact claim mismatch ${source.exactClaim} != ${input.cumulativeSourceAmount}`;
  }
  if (target.exactClaim !== input.cumulativeTargetAmount) {
    return `target exact claim mismatch ${target.exactClaim} != ${input.cumulativeTargetAmount}`;
  }
  if (source.roundingDelta > policy.maxSourceDust) {
    return `source quantization dust ${source.roundingDelta} > ${policy.maxSourceDust}`;
  }
  if (target.roundingDelta > policy.maxTargetDust) {
    return `target quantization dust ${target.roundingDelta} > ${policy.maxTargetDust}`;
  }
  return null;
}

export function validateCrossJurisdictionFillProgress(
  route: CrossJurisdictionSwapRoute,
  input: CrossJurisdictionFillProgressInput,
): { ok: true; value: CrossJurisdictionFillProgress } | { ok: false; error: string } {
  const previousSeq = Math.max(0, Math.floor(Number(route.fillSeq ?? 0) || 0));
  const nextSeq = input.fillSeq === undefined ? previousSeq + 1 : Math.floor(Number(input.fillSeq));
  if (!Number.isInteger(nextSeq) || nextSeq !== previousSeq + 1) {
    return { ok: false, error: `bad seq ${input.fillSeq}, expected ${previousSeq + 1}` };
  }

  let exactFillRatio: CrossJurisdictionExactFillRatio | undefined;
  try {
    exactFillRatio = readCrossJurisdictionExactFillRatio(input, route.orderId);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const previousRatio = getCrossJurisdictionCommittedProofRatio(route);
  const nextRatio = getCrossJurisdictionCommittedProofRatio({
    orderId: route.orderId,
    cumulativeFillRatio: input.cumulativeFillRatio,
    fillNumerator: input.fillNumerator,
    fillDenominator: input.fillDenominator,
  });
  if (nextRatio <= previousRatio) {
    return { ok: false, error: `non-monotonic ratio ${nextRatio} <= ${previousRatio}` };
  }

  const sourceTotal = BigInt(route.source.amount);
  const targetTotal = BigInt(route.target.amount);
  if (sourceTotal <= 0n || targetTotal <= 0n) {
    return { ok: false, error: 'invalid route amount' };
  }

  const committedFill = getCrossJurisdictionCommittedFillAmounts(route);
  const previousSourceAmount = committedFill.filledSourceAmount;
  const previousTargetAmount = committedFill.filledTargetAmount;
  // Runtime order progress is exact. `cumulativeFillRatio` is the coarse
  // uint16 projection used by hash-ladder/dispute plumbing; it must not round
  // economic amounts inside the committed orderbook path.
  const cumulativeSourceAmount = exactFillRatio
    ? scaleByExactRatio(sourceTotal, exactFillRatio.numerator, exactFillRatio.denominator)
    : (sourceTotal * BigInt(nextRatio)) / BigInt(CROSS_J_MAX_FILL_RATIO);
  const cumulativeTargetAmount = exactFillRatio
    ? scaleByExactRatio(targetTotal, exactFillRatio.numerator, exactFillRatio.denominator)
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
        `exact=${exactFillRatio ? `${exactFillRatio.numerator}/${exactFillRatio.denominator}` : 'none'})`,
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
  const quantizationError = validateCrossJurisdictionQuantization(route, {
    cumulativeFillRatio: nextRatio,
    fillNumerator: input.fillNumerator,
    fillDenominator: input.fillDenominator,
    cumulativeSourceAmount,
    cumulativeTargetAmount,
  });
  if (quantizationError) {
    return { ok: false, error: `quantization policy failed: ${quantizationError}` };
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
  const committedRatio = getCrossJurisdictionCommittedProofRatio(route);
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
  const committedFill = getCrossJurisdictionCommittedFillAmounts(route);
  const sourceTotal = BigInt(route.source.amount);
  const targetTotal = BigInt(route.target.amount);
  const claimAmountForRatio = (
    total: bigint,
    exactCommittedAmount: bigint | undefined,
    committedClaimAmount: bigint | undefined,
  ): bigint => {
    if (claimedRatio >= committedRatio && committedRatio > 0) {
      if (exactCommittedAmount !== undefined) return exactCommittedAmount;
      if (committedClaimAmount !== undefined && previousClaimedRatio >= committedRatio) return committedClaimAmount;
      if (
        route.fillNumerator !== undefined &&
        route.fillDenominator !== undefined
      ) {
        return scaleByExactRatio(total, route.fillNumerator, route.fillDenominator);
      }
    }
    return claimedRatio >= CROSS_J_MAX_FILL_RATIO
      ? total
      : (total * BigInt(claimedRatio)) / BigInt(CROSS_J_MAX_FILL_RATIO);
  };
  const sourceClaimed = claimAmountForRatio(
    sourceTotal,
    route.filledSourceAmount ?? committedFill.filledSourceAmount,
    route.sourceClaimed,
  );
  const targetClaimed = claimAmountForRatio(
    targetTotal,
    route.filledTargetAmount ?? committedFill.filledTargetAmount,
    route.targetClaimed,
  );
  return {
    ...route,
    claimedRatio,
    cumulativeFillRatio: Math.max(committedRatio, claimedRatio),
    sourceClaimed,
    targetClaimed,
    filledSourceAmount: route.filledSourceAmount ?? sourceClaimed,
    filledTargetAmount: route.filledTargetAmount ?? targetClaimed,
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
  'string',
  'string',
  'string',
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
  'uint256',
  'uint256',
  'string',
  'string',
  'string',
  'uint256',
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
  const {
    filledSourceAmount: cumulativeSourceAmount,
    filledTargetAmount: cumulativeTargetAmount,
    fillRatio,
  } = getCrossJurisdictionCommittedFillAmounts(canonical);
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

const cloneCrossJurisdictionRouteDomain = (
  domain: CrossJurisdictionRouteDomain | undefined,
): CrossJurisdictionRouteDomain | undefined => {
  if (!domain) return undefined;
  return {
    protocol: 'xln-cross-j',
    hashSchema: 'route-domain',
    sourceStackId: String(domain.sourceStackId || ''),
    targetStackId: String(domain.targetStackId || ''),
    ...(domain.sourceEntityProviderAddress ? { sourceEntityProviderAddress: String(domain.sourceEntityProviderAddress) } : {}),
    ...(domain.targetEntityProviderAddress ? { targetEntityProviderAddress: String(domain.targetEntityProviderAddress) } : {}),
    ...(domain.sourceDeltaTransformerAddress ? { sourceDeltaTransformerAddress: String(domain.sourceDeltaTransformerAddress) } : {}),
    ...(domain.targetDeltaTransformerAddress ? { targetDeltaTransformerAddress: String(domain.targetDeltaTransformerAddress) } : {}),
    sourceAssetRef: String(domain.sourceAssetRef || ''),
    targetAssetRef: String(domain.targetAssetRef || ''),
  };
};

const cloneCrossJurisdictionSettlementPolicy = (
  policy: CrossJurisdictionSettlementPolicy | undefined,
): CrossJurisdictionSettlementPolicy | undefined => {
  if (!policy) return undefined;
  return {
    roundingMode: 'uint16_ceil',
    maxSourceDust: BigInt(policy.maxSourceDust),
    maxTargetDust: BigInt(policy.maxTargetDust),
    ...(policy.minSourceFillAmount !== undefined ? { minSourceFillAmount: BigInt(policy.minSourceFillAmount) } : {}),
    ...(policy.minTargetFillAmount !== undefined ? { minTargetFillAmount: BigInt(policy.minTargetFillAmount) } : {}),
  };
};

const cloneCrossJurisdictionTimePolicy = (
  policy: CrossJurisdictionTimePolicy | undefined,
): CrossJurisdictionTimePolicy | undefined => {
  if (!policy) return undefined;
  return {
    runtimeClock: 'unix_ms',
    settlementClock: 'unix_seconds',
    deadlineConversion: 'floor_ms_to_unix_seconds',
    runtimeExpiresAtMs: Number(policy.runtimeExpiresAtMs || 0),
    finalityPolicy: 'source_deadline_then_target_safety',
  };
};

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
  const pendingClearRequestedAt = optionalNumber(route.pendingClearRequestedAt);
  const domain = cloneCrossJurisdictionRouteDomain(route.domain);
  const settlementPolicy = cloneCrossJurisdictionSettlementPolicy(route.settlementPolicy);
  const timePolicy = cloneCrossJurisdictionTimePolicy(route.timePolicy);
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
  if (pendingClearRequestedAt !== undefined) clone.pendingClearRequestedAt = pendingClearRequestedAt;
  if (domain) clone.domain = domain;
  if (settlementPolicy) clone.settlementPolicy = settlementPolicy;
  if (timePolicy) clone.timePolicy = timePolicy;
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
    receiptHash: String(receipt.receiptHash || ''),
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
    receiptHash: String(pendingFill.receiptHash || pendingFill.fillId || ''),
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
    firstSeenAt: Number(pendingFill.firstSeenAt || pendingFill.updatedAt || 0),
    ...(pendingFill.ttlExpiredAt !== undefined ? { ttlExpiredAt: Number(pendingFill.ttlExpiredAt) } : {}),
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
  const fillNumerator = optionalBigInt(binding.fillNumerator);
  const fillDenominator = optionalBigInt(binding.fillDenominator);
  const claimedRatio = optionalNumber(binding.claimedRatio);
  const filledSourceAmount = optionalBigInt(binding.filledSourceAmount);
  const filledTargetAmount = optionalBigInt(binding.filledTargetAmount);
  const sourceClaimed = optionalBigInt(binding.sourceClaimed);
  const targetClaimed = optionalBigInt(binding.targetClaimed);
  if (cumulativeFillRatio !== undefined) clone.cumulativeFillRatio = cumulativeFillRatio;
  if (fillNumerator !== undefined) clone.fillNumerator = fillNumerator;
  if (fillDenominator !== undefined) clone.fillDenominator = fillDenominator;
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
  const committedFill = getCrossJurisdictionCommittedFillAmounts(canonical);
  const hasCommittedFill = committedFillAmountsHaveProgress(committedFill);
  return cloneCrossJurisdictionPullBinding({
    orderId: canonical.orderId,
    routeHash: canonical.routeHash || deriveCrossJurisdictionRouteHash(canonical),
    leg,
    ...(canonical.targetReceipt ? { targetReceipt: canonical.targetReceipt } : {}),
    ...(canonical.sourceCloseProof ? { sourceCloseProof: canonical.sourceCloseProof } : {}),
    status: canonical.status,
    ...(canonical.cumulativeFillRatio !== undefined ? { cumulativeFillRatio: canonical.cumulativeFillRatio } : {}),
    ...(canonical.fillNumerator !== undefined ? { fillNumerator: canonical.fillNumerator } : {}),
    ...(canonical.fillDenominator !== undefined ? { fillDenominator: canonical.fillDenominator } : {}),
    ...(canonical.claimedRatio !== undefined ? { claimedRatio: canonical.claimedRatio } : {}),
    ...(hasCommittedFill ? { filledSourceAmount: committedFill.filledSourceAmount } : {}),
    ...(hasCommittedFill ? { filledTargetAmount: committedFill.filledTargetAmount } : {}),
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
  const committedFill = getCrossJurisdictionCommittedFillAmounts(route);
  const hasCommittedFill = committedFillAmountsHaveProgress(committedFill);
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
    ...(route.fillNumerator !== undefined ? { fillNumerator: route.fillNumerator } : {}),
    ...(route.fillDenominator !== undefined ? { fillDenominator: route.fillDenominator } : {}),
    ...(route.claimedRatio !== undefined ? { claimedRatio: route.claimedRatio } : {}),
    ...(hasCommittedFill ? { filledSourceAmount: committedFill.filledSourceAmount } : {}),
    ...(hasCommittedFill ? { filledTargetAmount: committedFill.filledTargetAmount } : {}),
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
  if (admission.pendingCancel) clone.pendingCancel = { ...admission.pendingCancel };
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
  if (tx.type === 'cross_j_intent') {
    return { ...tx, data: { route: cloneCrossJurisdictionRoute(tx.data.route) } };
  }
  if (tx.type === 'pull_lock' && tx.data.crossJurisdiction) {
    return {
      ...tx,
      data: {
        ...tx.data,
        crossJurisdiction: cloneCrossJurisdictionPullBinding(tx.data.crossJurisdiction),
        ...(tx.data.crossJurisdictionRoute
          ? { crossJurisdictionRoute: cloneCrossJurisdictionRoute(tx.data.crossJurisdictionRoute) }
          : {}),
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

export function cloneCrossJurisdictionAccountInputRoute<T extends AccountInput>(input: T): T;
export function cloneCrossJurisdictionAccountInputRoute(input: AccountInput): AccountInput {
  if (input.kind !== 'frame' && input.kind !== 'frame_ack') return input;
  return {
    ...input,
    proposal: {
      ...input.proposal,
      frame: cloneCrossJurisdictionAccountFrameRoute(input.proposal.frame),
    },
  };
}

export function deriveCrossJurisdictionRouteHash(route: CrossJurisdictionSwapRoute): string {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const policyRoute = withCrossJurisdictionPolicyDefaults(route);
  const domain = policyRoute.domain!;
  const settlementPolicy = policyRoute.settlementPolicy!;
  const timePolicy = policyRoute.timePolicy!;
  return ethers.keccak256(abiCoder.encode(
    ROUTE_HASH_ABI_TYPES,
    [
      String(policyRoute.orderId || ''),
      normalizeEntityId(policyRoute.bookOwnerEntityId || policyRoute.source.counterpartyEntityId || policyRoute.hubEntityId),
      String(policyRoute.venueId || ''),
      normalizeEntityId(policyRoute.makerEntityId),
      normalizeEntityId(policyRoute.hubEntityId),
      normalizeJurisdiction(policyRoute.source.jurisdiction),
      normalizeEntityId(policyRoute.source.entityId),
      normalizeEntityId(policyRoute.source.counterpartyEntityId),
      String(Math.floor(Number(policyRoute.source.tokenId))),
      BigInt(policyRoute.source.amount),
      normalizeJurisdiction(policyRoute.target.jurisdiction),
      normalizeEntityId(policyRoute.target.entityId),
      normalizeEntityId(policyRoute.target.counterpartyEntityId),
      String(Math.floor(Number(policyRoute.target.tokenId))),
      BigInt(policyRoute.target.amount),
      policyRoute.priceTicks !== undefined,
      BigInt(policyRoute.priceTicks ?? 0n),
      BigInt(Math.floor(Number(policyRoute.expiresAt ?? 0))),
      String(policyRoute.riskMode || ''),
      String(policyRoute.priceImprovementMode || ''),
      domain.protocol,
      domain.hashSchema,
      domain.sourceStackId,
      domain.targetStackId,
      domain.sourceEntityProviderAddress || '',
      domain.targetEntityProviderAddress || '',
      domain.sourceDeltaTransformerAddress || '',
      domain.targetDeltaTransformerAddress || '',
      domain.sourceAssetRef,
      domain.targetAssetRef,
      settlementPolicy.roundingMode,
      settlementPolicy.maxSourceDust,
      settlementPolicy.maxTargetDust,
      settlementPolicy.minSourceFillAmount ?? 0n,
      settlementPolicy.minTargetFillAmount ?? 0n,
      timePolicy.runtimeClock,
      timePolicy.settlementClock,
      timePolicy.deadlineConversion,
      BigInt(timePolicy.runtimeExpiresAtMs),
      timePolicy.finalityPolicy,
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

export function assertCrossJurisdictionPriceImprovementMode(
  mode: unknown,
  orderId: string,
): void {
  if (mode !== undefined && mode !== 'source_savings') {
    throw new Error(
      `CROSS_J_PRICE_IMPROVEMENT_MODE_UNSUPPORTED:${orderId}:${String(mode)}`,
    );
  }
}

export function withCanonicalCrossJurisdictionRouteHash(route: CrossJurisdictionSwapRoute): CrossJurisdictionSwapRoute {
  assertCrossJurisdictionPriceImprovementMode(route.priceImprovementMode, route.orderId);
  const withDefaults = withCrossJurisdictionPolicyDefaults(withCrossJurisdictionVenueDefaults(route));
  assertCrossJurisdictionRiskPolicy(withDefaults);
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

export function signedCrossJurisdictionAmountForBeneficiary(
  beneficiaryEntityId: string,
  counterpartyEntityId: string,
  amount: bigint,
): bigint {
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
      signedAmount: signedCrossJurisdictionAmountForBeneficiary(
        route.source.counterpartyEntityId,
        route.source.entityId,
        sourceAmount,
      ),
      revealedUntilTimestamp: sourceRevealUntilTimestamp,
      fullHash: proof.fullHash,
      partialRoot: proof.partialRoot,
    },
    targetPull: {
      pullId: targetPullId,
      tokenId: Number(route.target.tokenId),
      amount: targetAmount,
      signedAmount: signedCrossJurisdictionAmountForBeneficiary(
        route.target.counterpartyEntityId,
        route.target.entityId,
        targetAmount,
      ),
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
