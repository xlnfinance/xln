import {
  requireCrossJurisdictionFillProgress,
} from '../../cross-jurisdiction';
import { cloneEntityState, addMessage } from '../../state-helpers';
import type { CrossJurisdictionSwapRoute, EntityInput, EntityState, EntityTx } from '../../types';
import { findAccountKey, normalizeEntityRef } from '../account-key';
import type { MempoolOp } from './account';

type CrossJurisdictionFillNoticeTx = Extract<EntityTx, { type: 'crossJurisdictionFillNotice' }>;

type CrossJurisdictionFillResult = {
  newState: EntityState;
  outputs: EntityInput[];
  mempoolOps?: MempoolOp[];
};

const clampFillRatio = (value: unknown): number =>
  Math.max(0, Math.min(65_535, Math.floor(Number(value) || 0)));

const committedSourceAmount = (route: CrossJurisdictionSwapRoute): bigint => {
  const ratio = clampFillRatio(route.cumulativeFillRatio ?? route.claimedRatio);
  return route.filledSourceAmount ??
    route.sourceClaimed ??
    ((BigInt(route.source.amount) * BigInt(ratio)) / 65_535n);
};

const committedTargetAmount = (route: CrossJurisdictionSwapRoute): bigint => {
  const ratio = clampFillRatio(route.cumulativeFillRatio ?? route.claimedRatio);
  return route.filledTargetAmount ??
    route.targetClaimed ??
    ((BigInt(route.target.amount) * BigInt(ratio)) / 65_535n);
};

const sameCommittedFillNotice = (
  route: CrossJurisdictionSwapRoute,
  data: CrossJurisdictionFillNoticeTx['data'],
): boolean => (
  Math.floor(Number(route.fillSeq ?? 0)) === Math.floor(Number(data.fillSeq)) &&
  clampFillRatio(route.cumulativeFillRatio ?? route.claimedRatio) === clampFillRatio(data.cumulativeFillRatio) &&
  committedSourceAmount(route) === data.cumulativeSourceAmount &&
  committedTargetAmount(route) === data.cumulativeTargetAmount &&
  (route.fillNumerator ?? undefined) === (data.fillNumerator ?? undefined) &&
  (route.fillDenominator ?? undefined) === (data.fillDenominator ?? undefined)
);

export const handleCrossJurisdictionFillNoticeEntityTx = (
  entityState: EntityState,
  entityTx: CrossJurisdictionFillNoticeTx,
): CrossJurisdictionFillResult => {
  const {
    orderId,
    routeHash,
    previousFillSeq,
    fillSeq,
    incrementalSourceAmount,
    incrementalTargetAmount,
    cumulativeSourceAmount,
    cumulativeTargetAmount,
    cumulativeFillRatio,
    fillNumerator,
    fillDenominator,
    priceImprovementMode,
    priceImprovementAmount,
    priceImprovementTokenId,
    cancelRemainder,
    priceTicks,
    pairId,
  } = entityTx.data;
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const mempoolOps: MempoolOp[] = [];
  let route = newState.crossJurisdictionSwaps?.get(orderId);
  if (!route) {
    throw new Error(`CROSS_J_FILL_NOTICE_ROUTE_MISSING: order=${orderId}`);
  }

  // Fill notices are account writes, not book repairs. The book owner may create
  // a match, but only the source hub owns the source bilateral account that can
  // commit `cross_swap_fill_ack`. Do not rehydrate/merge from account offer state
  // here: a missing or stale entity route is corruption and must fail loudly.
  const currentEntityId = normalizeEntityRef(newState.entityId);
  const routeBookOwner = normalizeEntityRef(route.bookOwnerEntityId || route.source.counterpartyEntityId || route.hubEntityId);
  const routeSourceHub = normalizeEntityRef(route.source.counterpartyEntityId);
  if (routeSourceHub !== currentEntityId) {
    throw new Error(
      `CROSS_J_FILL_NOTICE_SOURCE_HUB_REQUIRED: order=${orderId} current=${newState.entityId} owner=${routeBookOwner} sourceHub=${routeSourceHub}`,
    );
  }

  if (
    routeHash &&
    route.routeHash &&
    routeHash.toLowerCase() !== route.routeHash.toLowerCase()
  ) {
    throw new Error(`CROSS_J_FILL_NOTICE_ROUTE_HASH_MISMATCH: order=${orderId} got=${routeHash} expected=${route.routeHash}`);
  }

  const currentFillSeq = Math.max(0, Math.floor(Number(route.fillSeq ?? 0) || 0));
  const noticeFillSeq = Math.floor(Number(fillSeq));
  if (noticeFillSeq <= currentFillSeq) {
    if (noticeFillSeq === currentFillSeq && !sameCommittedFillNotice(route, entityTx.data)) {
      throw new Error(`CROSS_J_FILL_NOTICE_STALE_CONFLICT: order=${orderId} seq=${noticeFillSeq} current=${currentFillSeq}`);
    }
    addMessage(newState, `🌉 Cross-j fill notice ${orderId} duplicate seq ${noticeFillSeq}`);
    return { newState, outputs, mempoolOps };
  }
  if (
    previousFillSeq !== undefined &&
    Math.floor(Number(previousFillSeq)) !== currentFillSeq
  ) {
    throw new Error(
      `CROSS_J_FILL_NOTICE_PREV_SEQ_MISMATCH: order=${orderId} prev=${previousFillSeq} current=${currentFillSeq}`,
    );
  }

  const allowed = route.status === 'resting' || route.status === 'partially_filled';
  if (!allowed) {
    throw new Error(`CROSS_J_FILL_NOTICE_STATUS_INVALID: order=${orderId} status=${route.status}`);
  }

  const fill = requireCrossJurisdictionFillProgress(route, {
    fillSeq,
    cumulativeFillRatio,
    fillNumerator,
    fillDenominator,
    incrementalSourceAmount,
    incrementalTargetAmount,
    cumulativeSourceAmount,
    cumulativeTargetAmount,
  }, 'CROSS_J_FILL_NOTICE_INVALID');
  const accountId = findAccountKey(newState, route.source.entityId);
  if (!accountId) {
    throw new Error(`CROSS_J_FILL_NOTICE_SOURCE_ACCOUNT_MISSING: order=${orderId} source=${route.source.entityId}`);
  }

  mempoolOps.push({
    accountId,
    tx: {
      type: 'cross_swap_fill_ack',
      data: {
        offerId: orderId,
        ...(route.routeHash ? { routeHash: route.routeHash } : {}),
        previousFillSeq: currentFillSeq,
        fillSeq: fill.fillSeq,
        incrementalSourceAmount: fill.incrementalSourceAmount,
        incrementalTargetAmount: fill.incrementalTargetAmount,
        cumulativeSourceAmount: fill.cumulativeSourceAmount,
        cumulativeTargetAmount: fill.cumulativeTargetAmount,
        cumulativeFillRatio: fill.nextRatio,
        ...(fill.fillNumerator !== undefined ? { fillNumerator: fill.fillNumerator } : {}),
        ...(fill.fillDenominator !== undefined ? { fillDenominator: fill.fillDenominator } : {}),
        executionSourceAmount: priceImprovementMode === 'source_savings' && (priceImprovementAmount ?? 0n) > 0n
          ? fill.incrementalSourceAmount - (priceImprovementAmount ?? 0n)
          : fill.incrementalSourceAmount,
        executionTargetAmount: priceImprovementMode === 'target_bonus' && (priceImprovementAmount ?? 0n) > 0n
          ? fill.incrementalTargetAmount + (priceImprovementAmount ?? 0n)
          : fill.incrementalTargetAmount,
        ...(priceImprovementMode ? { priceImprovementMode } : {}),
        ...(priceImprovementAmount !== undefined ? { priceImprovementAmount } : {}),
        ...(priceImprovementTokenId !== undefined ? { priceImprovementTokenId } : {}),
        cancelRemainder: Boolean(cancelRemainder) || fill.nextRatio >= 65_535,
        ...(priceTicks !== undefined ? { priceTicks } : {}),
        pairId,
        comment: `cross-j-fill-notice:${fill.nextRatio}`,
      },
    },
  });

  const firstValidator = entityState.config.validators[0];
  if (firstValidator) outputs.push({ entityId: newState.entityId, signerId: firstValidator, entityTxs: [] });
  addMessage(newState, `🌉 Cross-j fill notice ${orderId} queued account ack ${fill.nextRatio}/65535`);
  return { newState, outputs, mempoolOps };
};
