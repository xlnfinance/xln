import type { EntityInput, EntityState, Env } from '../../../../types';
import {
  applyCommand,
  getBookOrder,
  getOrderbookPairsForOrder,
  type BookState,
  type OrderbookExtState,
} from '../../../../orderbook';
import { createStructuredLogger, shortId, shortOrder } from '../../../../infra/logger';
import {
  buildCrossJurisdictionCancelAck,
  markCrossJurisdictionBookCancelPending,
  markCrossJurisdictionBookRemovalCommitted,
  type CrossJurisdictionFillInstruction,
} from '../../../../extensions/cross-j/orderbook';
import { crossJurisdictionBookOwnerRef } from '../../../../orderbook/cross-j-orderbook';
import {
  buildCrossJurisdictionEntityOutput,
  crossJurisdictionRouteSignerHint,
} from '../../cross-j-outputs';
import {
  hasQueuedCrossSwapAckForEntityState,
  queueUniqueSwapResolveForEntityState,
  type MempoolOp,
} from './orderbook-queue';
import type {
  MatchResult,
  SwapCancelRequestEvent,
} from './orderbook-offers';

const orderbookLog = createStructuredLogger('orderbook');

export interface RoutedOrderbookCancels {
  localBookCancels: SwapCancelRequestEvent[];
  mempoolOps: MempoolOp[];
  outputs: EntityInput[];
}

const normalizeEntityRef = (value: string): string => String(value || '').trim().toLowerCase();

/**
 * A cross-j cancel commits on the source Account, while the canonical book can
 * belong to the source hub's sibling Entity. Route that book mutation through
 * the trusted local Runtime cascade and keep the settlement ACK on the source
 * Account. The Runtime drains the local removal before exposing the Account
 * proposal as an external side effect.
 */
export function routeRemoteCrossJurisdictionBookCancels(
  env: Env,
  sourceHubState: EntityState,
  cancels: SwapCancelRequestEvent[],
): RoutedOrderbookCancels {
  const localBookCancels: SwapCancelRequestEvent[] = [];
  const mempoolOps: MempoolOp[] = [];
  const outputs: EntityInput[] = [];
  const currentEntityId = normalizeEntityRef(sourceHubState.entityId);

  for (const cancel of cancels) {
    const route = sourceHubState.accounts
      .get(cancel.accountId)
      ?.swapOffers
      ?.get(cancel.offerId)
      ?.crossJurisdiction;
    if (!route) {
      localBookCancels.push(cancel);
      continue;
    }

    const sourceHubEntityId = normalizeEntityRef(route.source.counterpartyEntityId);
    if (currentEntityId !== sourceHubEntityId) {
      throw new Error(
        `CROSS_J_CANCEL_SOURCE_HUB_REQUIRED:offer=${cancel.offerId}:` +
          `entity=${currentEntityId}:sourceHub=${sourceHubEntityId}`,
      );
    }

    const bookOwnerEntityId = crossJurisdictionBookOwnerRef(route);
    if (!bookOwnerEntityId) {
      throw new Error(`CROSS_J_CANCEL_BOOK_OWNER_MISSING:offer=${cancel.offerId}`);
    }
    if (bookOwnerEntityId === currentEntityId) {
      localBookCancels.push(cancel);
      continue;
    }

    const bookOwnerSignerId = crossJurisdictionRouteSignerHint(route, bookOwnerEntityId);
    if (!bookOwnerSignerId) {
      throw new Error(
        `CROSS_J_CANCEL_BOOK_OWNER_SIGNER_MISSING:offer=${cancel.offerId}:owner=${bookOwnerEntityId}`,
      );
    }
    markCrossJurisdictionBookCancelPending(
      sourceHubState,
      route,
      cancel.accountId,
      Number(sourceHubState.timestamp || env.timestamp || 0),
    );
    outputs.push(buildCrossJurisdictionEntityOutput(env, bookOwnerEntityId, [{
      type: 'removeCrossJurisdictionBookOrder',
      data: {
        orderId: cancel.offerId,
        sourceEntityId: route.source.entityId,
        sourceAccountId: cancel.accountId,
        route,
        reason: 'cancel_request',
      },
    }], bookOwnerSignerId));
  }

  return { localBookCancels, mempoolOps, outputs };
}

export function collectCommittedCrossJurisdictionCancelAcks(
  sourceHubState: EntityState,
): MempoolOp[] {
  const mempoolOps: MempoolOp[] = [];
  const currentEntityId = normalizeEntityRef(sourceHubState.entityId);
  const admissions = Array.from(sourceHubState.crossJurisdictionBookAdmissions?.entries() ?? [])
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  for (const [, admission] of admissions) {
    const pending = admission.pendingCancel;
    if (!pending?.bookRemovalCommittedAt) continue;
    const route = sourceHubState.crossJurisdictionSwaps?.get(admission.orderId);
    if (!route) {
      throw new Error(`CROSS_J_CANCEL_ACK_ROUTE_MISSING:order=${admission.orderId}`);
    }
    if (normalizeEntityRef(route.source.counterpartyEntityId) !== currentEntityId) continue;
    const account = sourceHubState.accounts.get(pending.sourceAccountId);
    if (!account?.swapOffers?.has(admission.orderId)) {
      throw new Error(
        `CROSS_J_CANCEL_ACK_SOURCE_OFFER_MISSING:account=${pending.sourceAccountId}:order=${admission.orderId}`,
      );
    }
    if (hasQueuedCrossSwapAckForEntityState(sourceHubState, pending.sourceAccountId, admission.orderId)) {
      continue;
    }
    mempoolOps.push({
      accountId: pending.sourceAccountId,
      tx: buildCrossJurisdictionCancelAck(admission.orderId, route),
    });
  }
  return mempoolOps;
}

/**
 * Apply hub-decided orderbook cancels and enqueue the account-level settlement.
 * This mutates only the orderbook extension and returns account mempool ops for
 * the entity orchestrator to commit through the normal account frame path.
 */
export function processOrderbookCancels(
  hubState: EntityState,
  cancels: SwapCancelRequestEvent[],
): MatchResult {
  const mempoolOps: MempoolOp[] = [];
  const crossJurisdictionFills: CrossJurisdictionFillInstruction[] = [];
  const bookUpdates: { pairId: string; book: BookState }[] = [];
  const debugProjectionRejects: MatchResult['debugProjectionRejects'] = [];
  const queuedSwapResolutions = new Set<string>();
  const ext = hubState.orderbookExt as OrderbookExtState | undefined;
  if (!ext) return { mempoolOps, crossJurisdictionFills, bookUpdates, debugProjectionRejects };

  for (const { offerId, accountId } of cancels) {
    const accountMachine = hubState.accounts.get(accountId);
    const hasOffer = Boolean(accountMachine?.swapOffers?.has(offerId));
    if (!hasOffer) continue;

    const namespacedOrderId = `${accountId}:${offerId}`;
    let orderbookCancelled = false;
    const matchingBooks: Array<{ bookKey: string; book: BookState; ownerId: string }> = [];

    for (const bookKey of getOrderbookPairsForOrder(ext, namespacedOrderId)) {
      const book = ext.books.get(bookKey);
      if (!book) continue;
      const existingOrder = getBookOrder(book, namespacedOrderId);
      if (!existingOrder) continue;
      matchingBooks.push({ bookKey, book, ownerId: existingOrder.ownerId });
    }

    if (matchingBooks.length > 1) {
      throw new Error(
        `ORDERBOOK_DUPLICATE_BOOK_ORDER: order=${namespacedOrderId} matches=${matchingBooks.length}`,
      );
    }

    for (const { bookKey, book, ownerId } of matchingBooks) {
      const result = applyCommand(book, {
        kind: 1,
        ownerId,
        orderId: namespacedOrderId,
      });

      bookUpdates.push({ pairId: bookKey, book: result.state });
      orderbookLog.debug('order.cancelled', { offer: shortOrder(offerId, 8), account: shortId(accountId, 8), pair: bookKey });
      orderbookCancelled = true;
    }

    const offer = accountMachine?.swapOffers?.get(offerId);
    if (offer?.crossJurisdiction) {
      markCrossJurisdictionBookRemovalCommitted(
        hubState,
        offer.crossJurisdiction,
        accountId,
        Number(hubState.timestamp || 0),
        'cancel_request',
      );
      if (hasQueuedCrossSwapAckForEntityState(hubState, accountId, offerId)) {
        orderbookLog.debug('crossj.cancel_ack_waiting_for_fill', {
          offer: shortOrder(offerId, 8),
          account: shortId(accountId, 8),
        });
        continue;
      }
      mempoolOps.push({ accountId, tx: buildCrossJurisdictionCancelAck(offerId, offer.crossJurisdiction) });
      orderbookLog.debug('crossj.cancel_ack_queued', { offer: shortOrder(offerId, 8), account: shortId(accountId, 8) });
      continue;
    }

    if (queueUniqueSwapResolveForEntityState(mempoolOps, hubState, queuedSwapResolutions, accountId, {
      offerId,
      fillRatio: 0,
      cancelRemainder: true,
      comment: 'cancel_request',
    })) {
      if (!orderbookCancelled) {
        orderbookLog.debug('resolve.queued_cancel_missing_book_order', { offer: shortOrder(offerId, 8), account: shortId(accountId, 8) });
      } else {
        orderbookLog.debug('resolve.queued_cancel', { offer: shortOrder(offerId, 8), account: shortId(accountId, 8) });
      }
    }
  }

  return { mempoolOps, crossJurisdictionFills, bookUpdates, debugProjectionRejects };
}
