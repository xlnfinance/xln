import {
  validateCrossJurisdictionFillProgress,
  withCanonicalCrossJurisdictionRouteHash,
} from '../../cross-jurisdiction';
import { cloneEntityState, addMessage } from '../../state-helpers';
import type { EntityInput, EntityState, EntityTx } from '../../types';
import { findAccountKey, normalizeEntityRef } from '../account-key';
import {
  findCrossJurisdictionOfferRoute,
  mergeCrossJurisdictionRoute,
} from '../cross-jurisdiction-helpers';
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
    addMessage(newState, `❌ Cross-j fill notice ${orderId} missing entity-level route`);
    return { newState, outputs, mempoolOps };
  }

  const offerRoute = findCrossJurisdictionOfferRoute(newState, orderId);
  if (offerRoute) {
    try {
      route = mergeCrossJurisdictionRoute(route, withCanonicalCrossJurisdictionRouteHash(offerRoute.route));
      newState.crossJurisdictionSwaps ||= new Map();
      newState.crossJurisdictionSwaps.set(orderId, route);
    } catch {
      // Keep the entity-level route; validation below will reject if it is unusable.
    }
  }

  const currentEntityId = normalizeEntityRef(newState.entityId);
  const routeBookOwner = normalizeEntityRef(route.bookOwnerEntityId || route.source.counterpartyEntityId || route.hubEntityId);
  const routeSourceHub = normalizeEntityRef(route.source.counterpartyEntityId);
  if (routeBookOwner !== currentEntityId && routeSourceHub !== currentEntityId) {
    addMessage(newState, `❌ Cross-j fill notice ${orderId} routed to wrong book owner/source hub`);
    return { newState, outputs, mempoolOps };
  }

  const allowed = route.status === 'resting' || route.status === 'partially_filled';
  if (!allowed) {
    addMessage(newState, `❌ Cross-j fill notice ${orderId} blocked in status ${route.status}`);
    return { newState, outputs, mempoolOps };
  }

  const validatedFill = validateCrossJurisdictionFillProgress(route, {
    fillSeq,
    cumulativeFillRatio,
    incrementalSourceAmount,
    incrementalTargetAmount,
    cumulativeSourceAmount,
    cumulativeTargetAmount,
  });
  if (!validatedFill.ok) {
    addMessage(newState, `❌ Cross-j fill notice ${orderId} blocked: ${validatedFill.error}`);
    return { newState, outputs, mempoolOps };
  }
  const fill = validatedFill.value;
  const accountId = findAccountKey(newState, route.source.entityId);
  if (!accountId) {
    addMessage(newState, `❌ Cross-j fill notice ${orderId} blocked: no source account`);
    return { newState, outputs, mempoolOps };
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
