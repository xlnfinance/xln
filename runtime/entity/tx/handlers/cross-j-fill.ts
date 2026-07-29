import {
  CROSS_J_MAX_FILL_RATIO,
  assertCrossJurisdictionPriceImprovementMode,
  getCrossJurisdictionCommittedFillAmounts,
  getCrossJurisdictionCommittedProofRatio,
  requireCrossJurisdictionFillProgress,
} from '../../../extensions/cross-j/index';
import { cloneEntityState } from '../../../state-helpers';
import { addMessage } from '../../frame-events';
import type { CrossJurisdictionSwapRoute, EntityInput, EntityState, EntityTx } from '../../../types';
import { findAccountKey, normalizeEntityRef } from '../account-key';
import type { AccountTxTarget } from './account';

type CrossJurisdictionFillNoticeTx = Extract<EntityTx, { type: 'crossJurisdictionFillNotice' }>;

type CrossJurisdictionFillResult = {
  newState: EntityState;
  outputs: EntityInput[];
  accountTxs?: AccountTxTarget[];
};

const sameCommittedFillNotice = (
  route: CrossJurisdictionSwapRoute,
  data: CrossJurisdictionFillNoticeTx['data'],
): boolean => {
  const committed = getCrossJurisdictionCommittedFillAmounts(route);
  const noticeRatio = getCrossJurisdictionCommittedProofRatio({
    orderId: data.orderId,
    cumulativeFillRatio: data.cumulativeFillRatio,
    fillNumerator: data.fillNumerator,
    fillDenominator: data.fillDenominator,
  });
  return (
    Math.floor(Number(route.fillSeq ?? 0)) === Math.floor(Number(data.fillSeq)) &&
    committed.fillRatio === noticeRatio &&
    committed.filledSourceAmount === data.cumulativeSourceAmount &&
    committed.filledTargetAmount === data.cumulativeTargetAmount &&
    (route.fillNumerator ?? undefined) === (data.fillNumerator ?? undefined) &&
    (route.fillDenominator ?? undefined) === (data.fillDenominator ?? undefined)
  );
};

const requireSourceHubRoute = (
  state: EntityState,
  orderId: string,
): CrossJurisdictionSwapRoute => {
  const route = state.crossJurisdictionSwaps?.get(orderId);
  if (!route) throw new Error(`CROSS_J_FILL_NOTICE_ROUTE_MISSING: order=${orderId}`);

  // A fill notice writes the source bilateral Account. The book owner may
  // discover a match, but it cannot repair or impersonate the source hub.
  const currentEntityId = normalizeEntityRef(state.entityId);
  const bookOwner = normalizeEntityRef(
    route.bookOwnerEntityId || route.source.counterpartyEntityId || route.hubEntityId,
  );
  const sourceHub = normalizeEntityRef(route.source.counterpartyEntityId);
  if (sourceHub !== currentEntityId) {
    throw new Error(
      `CROSS_J_FILL_NOTICE_SOURCE_HUB_REQUIRED: order=${orderId} current=${state.entityId} ` +
      `owner=${bookOwner} sourceHub=${sourceHub}`,
    );
  }
  return route;
};

const assertFillNoticeSequence = (
  route: CrossJurisdictionSwapRoute,
  data: CrossJurisdictionFillNoticeTx['data'],
): 'duplicate' | 'next' => {
  const current = Math.max(0, Math.floor(Number(route.fillSeq ?? 0) || 0));
  const incoming = Math.floor(Number(data.fillSeq));
  if (incoming <= current) {
    if (incoming === current && !sameCommittedFillNotice(route, data)) {
      throw new Error(
        `CROSS_J_FILL_NOTICE_STALE_CONFLICT: order=${data.orderId} seq=${incoming} current=${current}`,
      );
    }
    return 'duplicate';
  }
  if (
    data.previousFillSeq !== undefined &&
    Math.floor(Number(data.previousFillSeq)) !== current
  ) {
    throw new Error(
      `CROSS_J_FILL_NOTICE_PREV_SEQ_MISMATCH: order=${data.orderId} ` +
      `prev=${data.previousFillSeq} current=${current}`,
    );
  }
  return 'next';
};

export const handleCrossJurisdictionFillNoticeEntityTx = (
  entityState: EntityState,
  entityTx: CrossJurisdictionFillNoticeTx,
): CrossJurisdictionFillResult => {
  const {
    orderId,
    routeHash,
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
  assertCrossJurisdictionPriceImprovementMode(priceImprovementMode, orderId);
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const accountTxs: AccountTxTarget[] = [];
  const route = requireSourceHubRoute(newState, orderId);

  if (
    routeHash &&
    route.routeHash &&
    routeHash.toLowerCase() !== route.routeHash.toLowerCase()
  ) {
    throw new Error(`CROSS_J_FILL_NOTICE_ROUTE_HASH_MISMATCH: order=${orderId} got=${routeHash} expected=${route.routeHash}`);
  }

  const currentFillSeq = Math.max(0, Math.floor(Number(route.fillSeq ?? 0) || 0));
  if (assertFillNoticeSequence(route, entityTx.data) === 'duplicate') {
    addMessage(newState, `🌉 Cross-j fill notice ${orderId} duplicate seq ${Math.floor(Number(fillSeq))}`);
    return { newState, outputs, accountTxs };
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

  accountTxs.push({
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
        executionSourceAmount: (priceImprovementAmount ?? 0n) > 0n
          ? fill.incrementalSourceAmount - (priceImprovementAmount ?? 0n)
          : fill.incrementalSourceAmount,
        executionTargetAmount: fill.incrementalTargetAmount,
        ...(priceImprovementMode ? { priceImprovementMode } : {}),
        ...(priceImprovementAmount !== undefined ? { priceImprovementAmount } : {}),
        ...(priceImprovementTokenId !== undefined ? { priceImprovementTokenId } : {}),
        cancelRemainder: Boolean(cancelRemainder) || fill.nextRatio >= CROSS_J_MAX_FILL_RATIO,
        ...(priceTicks !== undefined ? { priceTicks } : {}),
        pairId,
        comment: `cross-j-fill-notice:${fill.nextRatio}`,
      },
    },
  });

  const firstValidator = entityState.config.validators[0];
  if (firstValidator) outputs.push({ entityId: newState.entityId, signerId: firstValidator, entityTxs: [] });
  addMessage(newState, `🌉 Cross-j fill notice ${orderId} queued account ack ${fill.nextRatio}/${CROSS_J_MAX_FILL_RATIO}`);
  return { newState, outputs, accountTxs };
};
