import { haltRuntimeFailure } from '../../../../protocol/errors/failure-taxonomy';
import { getCrossJurisdictionCommittedProofRatio, isCrossJurisdictionTerminalStatus, withCanonicalCrossJurisdictionRouteHash } from '../../../../extensions/cross-j';
import { markCrossJurisdictionBookAdmissionClosed } from '../../../../extensions/cross-j/orderbook';
import type { EntityInput, EntityState } from '../../../types';
import type { EntityRuntimeContext } from '../../../runtime-context';
import type { EntityTx } from '../../../../types/entity-tx';
import type { ApplyEntityTxOptions } from '../../apply';
import { normalizeEntityRef } from '../../account-key';
import { prepareEntityTxState } from '../../../state-clone';
import { getEntityAccountForWrite } from '../../../state/persistent-account-map';
import { applyEntityAccountEnvelopeUpdate } from '../../../account-envelope-update';
import { addMessage } from '../../../frame-events';
import { draftPreparedDisputeStartIfReady } from '../dispute';
import { applySourceHubCrossJurisdictionFillProgress } from '../account-cross-j-followups';

export const handleCrossJurisdictionBookOrderRemovedEntityTx = async (
  env: EntityRuntimeContext,
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'crossJurisdictionBookOrderRemoved' }>,
  options?: ApplyEntityTxOptions,
) => {
  const newState = prepareEntityTxState(entityState, options?.mutableFrameState);
  const route = withCanonicalCrossJurisdictionRouteHash(entityTx.data.route);
  if (normalizeEntityRef(newState.entityId) !== normalizeEntityRef(route.source.counterpartyEntityId)) {
    throw haltRuntimeFailure('CROSS_J_BOOK_REMOVAL_ACK_SOURCE_HUB_REQUIRED', `CROSS_J_BOOK_REMOVAL_ACK_SOURCE_HUB_REQUIRED:order=${route.orderId}:entity=${newState.entityId}`);
  }
  const visible = newState.accounts.get(entityTx.data.sourceAccountId);
  const offer = visible?.state.swapOffers?.get(route.orderId);
  const currentRoute = newState.crossJurisdictionSwaps?.get(route.orderId);
  if (!currentRoute) {
    throw haltRuntimeFailure('CROSS_J_BOOK_REMOVAL_ACK_SOURCE_STATE_MISSING', `CROSS_J_BOOK_REMOVAL_ACK_SOURCE_STATE_MISSING:order=${route.orderId}:account=${entityTx.data.sourceAccountId}`);
  }
  if (normalizeEntityRef(currentRoute.routeHash || '') !== normalizeEntityRef(route.routeHash || '')) {
    throw haltRuntimeFailure('CROSS_J_BOOK_REMOVAL_ACK_ROUTE_HASH_MISMATCH', `CROSS_J_BOOK_REMOVAL_ACK_ROUTE_HASH_MISMATCH:order=${route.orderId}`);
  }
  if (isCrossJurisdictionTerminalStatus(currentRoute.status)) {
    return { newState, outputs: [], accountTxs: [] };
  }
  if (!visible || !offer?.crossJurisdiction) {
    throw haltRuntimeFailure('CROSS_J_BOOK_REMOVAL_ACK_SOURCE_STATE_MISSING', `CROSS_J_BOOK_REMOVAL_ACK_SOURCE_STATE_MISSING:order=${route.orderId}:account=${entityTx.data.sourceAccountId}`);
  }
  markCrossJurisdictionBookAdmissionClosed(
    newState,
    route.source.entityId,
    route.orderId,
    entityTx.data.removedAt,
    entityTx.data.reason || 'cancel_request',
  );
  const pendingDisputeRemovals = visible.disputePrepare?.pendingOrderbookRemovalIds;
  if ((visible.status ?? 'active') === 'dispute_preparing' && pendingDisputeRemovals?.includes(route.orderId)) {
    const account = getEntityAccountForWrite(newState.accounts, entityTx.data.sourceAccountId);
    if (!account?.disputePrepare) throw new Error(`CROSS_J_BOOK_REMOVAL_WRITE_ACCOUNT_MISSING:${entityTx.data.sourceAccountId}`);
    applyEntityAccountEnvelopeUpdate(env, entityTx.data.sourceAccountId, account, {
      type: 'confirmDisputeBookRemoval',
      orderId: route.orderId,
    });
    addMessage(newState, `🌉 Cross-j dispute book removal confirmed ${route.orderId}`);
    const drafted = await draftPreparedDisputeStartIfReady(
      newState,
      entityTx.data.sourceAccountId,
      env,
      options?.storageChanges,
      true,
    );
    return { newState: drafted.newState, outputs: drafted.outputs, accountTxs: [] };
  }
  const outputs: EntityInput[] = [];
  const applied = applySourceHubCrossJurisdictionFillProgress(env, newState, {
    orderId: route.orderId,
    ...(currentRoute.routeHash ? { routeHash: currentRoute.routeHash } : {}),
    fillSeq: Math.max(0, Math.floor(Number(currentRoute.fillSeq ?? 0) || 0)),
    cumulativeFillRatio: getCrossJurisdictionCommittedProofRatio(currentRoute),
    cancelRemainder: true,
  }, outputs, options?.storageChanges ?? []);
  addMessage(
    newState,
    applied
      ? `🌉 Cross-j book removal committed ${route.orderId}`
      : `🌉 Cross-j book removal already cleared ${route.orderId}`,
  );
  return { newState, outputs, accountTxs: [] };
};
