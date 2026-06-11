import {
  requireCrossJurisdictionFillProgress,
} from '../../cross-jurisdiction';
import { cloneEntityState, addMessage } from '../../state-helpers';
import type { EntityInput, EntityState, EntityTx } from '../../types';
import { findAccountKey, normalizeEntityRef } from '../account-key';
import type { MempoolOp } from './account';

type CrossJurisdictionFillNoticeTx = Extract<EntityTx, { type: 'crossJurisdictionFillNotice' }>;

type CrossJurisdictionFillResult = {
  newState: EntityState;
  outputs: EntityInput[];
  mempoolOps?: MempoolOp[];
};

export const handleCrossJurisdictionFillNoticeEntityTx = (
  entityState: EntityState,
  entityTx: CrossJurisdictionFillNoticeTx,
): CrossJurisdictionFillResult => {
  const {
    orderId,
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
        cancelRemainder: fill.nextRatio >= 65_535,
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
