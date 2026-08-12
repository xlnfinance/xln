import {
  CROSS_J_MAX_FILL_RATIO,
  assertCrossJurisdictionPriceImprovementMode,
  getCrossJurisdictionCommittedFillAmounts,
  getCrossJurisdictionCommittedProofRatio,
  requireCrossJurisdictionFillProgress,
} from '../../../../extensions/cross-j/index';
import { prepareEntityTxState } from '../../../state-clone';
import { addMessage } from '../../../frame-events';
import type { CrossJurisdictionSwapRoute } from '../../../../types/cross-jurisdiction';
import type { EntityInput, EntityState } from '../../../types';
import type { EntityTx } from '../../../../types/entity-tx';
import type { CrossSwapFillAckData } from '../../../../types/account';
import { findAccountKey, normalizeEntityRef } from '../../account-key';
import type { AccountTxTarget } from '../account';

type CrossJurisdictionFillNoticeTx = Extract<EntityTx, { type: 'crossJurisdictionFillNotice' }>;

type CrossJurisdictionFillResult = {
  newState: EntityState;
  outputs: EntityInput[];
  accountTxs?: AccountTxTarget[];
};

const sameExactFillFields = (
  route: CrossJurisdictionSwapRoute,
  data: CrossJurisdictionFillNoticeTx['data'],
): boolean => {
  const routeHasExact = route.fillNumerator !== undefined || route.fillDenominator !== undefined;
  const dataHasExact = data.fillNumerator !== undefined || data.fillDenominator !== undefined;
  if (!routeHasExact && !dataHasExact) return true;
  // buildCrossJurisdictionCancelAck must send bigint fields; for never-filled
  // routes it uses the 0/1 sentinel. That is absent exact ratio, not progress.
  if (
    !routeHasExact &&
    data.fillNumerator === 0n &&
    data.fillDenominator === 1n &&
    Math.floor(Number(data.fillSeq)) === 0
  ) {
    return true;
  }
  return route.fillNumerator === data.fillNumerator && route.fillDenominator === data.fillDenominator;
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
    sameExactFillFields(route, data)
  );
};

const requireHubRoute = (
  state: EntityState,
  orderId: string,
): { route: CrossJurisdictionSwapRoute; role: 'source' | 'target' } => {
  const route = state.crossJurisdictionSwaps?.get(orderId);
  if (!route) throw new Error(`CROSS_J_FILL_NOTICE_ROUTE_MISSING: order=${orderId}`);

  const currentEntityId = normalizeEntityRef(state.entityId);
  const bookOwner = normalizeEntityRef(
    route.bookOwnerEntityId || route.source.counterpartyEntityId || route.hubEntityId,
  );
  const sourceHub = normalizeEntityRef(route.source.counterpartyEntityId);
  const targetHub = normalizeEntityRef(route.target.entityId);
  if (sourceHub !== currentEntityId && targetHub !== currentEntityId) {
    throw new Error(
      `CROSS_J_FILL_NOTICE_SOURCE_HUB_REQUIRED: order=${orderId} current=${state.entityId} ` +
      `owner=${bookOwner} sourceHub=${sourceHub} targetHub=${targetHub}`,
    );
  }
  return { route, role: sourceHub === currentEntityId ? 'source' : 'target' };
};

const buildFillAckData = (
  route: CrossJurisdictionSwapRoute,
  data: CrossJurisdictionFillNoticeTx['data'],
): CrossSwapFillAckData => {
  const currentFillSeq = Math.max(0, Math.floor(Number(route.fillSeq ?? 0) || 0));
  const sameSeqCancel = Boolean(data.cancelRemainder) && data.fillSeq === currentFillSeq;
  if (sameSeqCancel) {
    if (!sameCommittedFillNotice(route, data) || data.incrementalSourceAmount !== 0n || data.incrementalTargetAmount !== 0n) {
      throw new Error(`CROSS_J_FILL_NOTICE_CANCEL_PROGRESS_MISMATCH:${data.orderId}`);
    }
    return {
      offerId: data.orderId,
      ...(route.routeHash ? { routeHash: route.routeHash } : {}),
      previousFillSeq: currentFillSeq,
      fillSeq: currentFillSeq,
      incrementalSourceAmount: 0n,
      incrementalTargetAmount: 0n,
      cumulativeSourceAmount: data.cumulativeSourceAmount,
      cumulativeTargetAmount: data.cumulativeTargetAmount,
      cumulativeFillRatio: data.cumulativeFillRatio,
      fillNumerator: data.fillNumerator,
      fillDenominator: data.fillDenominator,
      ackKind: 'cancel',
      executionSourceAmount: 0n,
      executionTargetAmount: 0n,
      cancelRemainder: true,
      pairId: data.pairId,
      comment: 'cross-j-cancel-request',
    };
  }
  const fill = requireCrossJurisdictionFillProgress(route, data, 'CROSS_J_FILL_NOTICE_INVALID');
  return {
    offerId: data.orderId,
    ...(route.routeHash ? { routeHash: route.routeHash } : {}),
    previousFillSeq: currentFillSeq,
    fillSeq: fill.fillSeq,
    incrementalSourceAmount: fill.incrementalSourceAmount,
    incrementalTargetAmount: fill.incrementalTargetAmount,
    cumulativeSourceAmount: fill.cumulativeSourceAmount,
    cumulativeTargetAmount: fill.cumulativeTargetAmount,
    cumulativeFillRatio: fill.nextRatio,
    fillNumerator: fill.fillNumerator,
    fillDenominator: fill.fillDenominator,
    ackKind: 'fill',
    executionSourceAmount: (data.priceImprovementAmount ?? 0n) > 0n
      ? fill.incrementalSourceAmount - (data.priceImprovementAmount ?? 0n)
      : fill.incrementalSourceAmount,
    executionTargetAmount: fill.incrementalTargetAmount,
    ...(data.priceImprovementMode ? { priceImprovementMode: data.priceImprovementMode } : {}),
    ...(data.priceImprovementAmount !== undefined ? { priceImprovementAmount: data.priceImprovementAmount } : {}),
    ...(data.priceImprovementTokenId !== undefined ? { priceImprovementTokenId: data.priceImprovementTokenId } : {}),
    cancelRemainder: Boolean(data.cancelRemainder) || fill.nextRatio >= CROSS_J_MAX_FILL_RATIO,
    ...(data.priceTicks !== undefined ? { priceTicks: data.priceTicks } : {}),
    pairId: data.pairId,
    comment: `cross-j-hashledger-fill:${fill.nextRatio}`,
  };
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
  mutableFrameState = false,
): CrossJurisdictionFillResult => {
  const {
    orderId,
    routeHash,
    fillSeq,
    priceImprovementMode,
    cancelRemainder,
  } = entityTx.data;
  assertCrossJurisdictionPriceImprovementMode(priceImprovementMode, orderId);
  const newState = prepareEntityTxState(entityState, mutableFrameState);
  const outputs: EntityInput[] = [];
  const accountTxs: AccountTxTarget[] = [];
  const { route, role } = requireHubRoute(newState, orderId);

  if (
    routeHash &&
    route.routeHash &&
    routeHash.toLowerCase() !== route.routeHash.toLowerCase()
  ) {
    throw new Error(`CROSS_J_FILL_NOTICE_ROUTE_HASH_MISMATCH: order=${orderId} got=${routeHash} expected=${route.routeHash}`);
  }

  const sequence = assertFillNoticeSequence(route, entityTx.data);
  if (sequence === 'duplicate' && !cancelRemainder) {
    addMessage(newState, `🌉 Cross-j fill notice ${orderId} duplicate seq ${Math.floor(Number(fillSeq))}`);
    return { newState, outputs, accountTxs };
  }

  const allowed = route.status === 'resting' || route.status === 'partially_filled';
  if (!allowed) {
    throw new Error(`CROSS_J_FILL_NOTICE_STATUS_INVALID: order=${orderId} status=${route.status}`);
  }

  const fillAck = buildFillAckData(route, entityTx.data);
  if (!route.targetPull) throw new Error(`CROSS_J_TARGET_PULL_MISSING:${orderId}`);
  const accountPeer = role === 'source'
    ? route.source.entityId
    : route.target.counterpartyEntityId;
  const accountId = findAccountKey(newState, accountPeer);
  if (!accountId) {
    throw new Error(`CROSS_J_FILL_NOTICE_${role.toUpperCase()}_ACCOUNT_MISSING: order=${orderId} peer=${accountPeer}`);
  }

  accountTxs.push({
    accountId,
    tx: role === 'source'
      ? { type: 'cross_swap_fill_ack', data: fillAck }
      : { type: 'cross_pull_progress', data: { pullId: route.targetPull.pullId, fill: fillAck } },
  });

  const firstValidator = entityState.config.validators[0];
  if (firstValidator) outputs.push({ entityId: newState.entityId, signerId: firstValidator, entityTxs: [] });
  addMessage(newState, `🌉 Cross-j ${role} progress ${orderId} queued ${fillAck.cumulativeFillRatio}/${CROSS_J_MAX_FILL_RATIO}`);
  return { newState, outputs, accountTxs };
};
