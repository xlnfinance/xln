import { haltRuntimeFailure } from "../../../../../protocol/errors/failure-taxonomy";

import type { EntityInput, EntityState } from '../../../../types';
import type { EntityRuntimeContext } from '../../../../runtime-context';
import {
  applyCommand,
  commitBookOverlay,
  forkBookState,
  getBookOrder,
  getOrderbookPairsForOrder,
  type BookState,
  type OrderbookExtState,
} from '../../../../../orderbook';
import { createStructuredLogger, shortId, shortOrder } from '../../../../../support/logger';
import {
  buildCrossJurisdictionCancelInstruction,
  crossJurisdictionBookAdmissionKeyFor,
  markCrossJurisdictionBookAdmissionResolving,
  type CrossJurisdictionFillInstruction,
} from '../../../../../extensions/cross-j/orderbook';
import { crossJurisdictionBookOwnerRef } from '../../../../../orderbook/cross-j/orderbook';
import {
  buildCrossJurisdictionEntityOutput,
  crossJurisdictionRouteSignerHint,
} from '../../../j-events-htlc/cross-j-outputs';
import {
  queueUniqueSwapResolveForEntityState,
  type AccountTxTarget,
} from './queue';
import type {
  MatchResult,
  SwapCancelRequestEvent,
} from './offers';
import { swapKey } from '../../../../../orderbook/swap-execution';

const orderbookLog = createStructuredLogger('orderbook');

export interface RoutedOrderbookCancels {
  localBookCancels: SwapCancelRequestEvent[];
  outputs: EntityInput[];
}

const normalizeEntityRef = (value: string): string => String(value || '').trim().toLowerCase();

/**
 * A cross-j cancel commits on the source Account, while the canonical book can
 * belong to the source hub's sibling Entity. Route that book mutation through
 * the trusted local Runtime cascade; the removal acknowledgement then requests
 * the clear on the source Hub.
 */
export function routeRemoteCrossJurisdictionBookCancels(
  env: EntityRuntimeContext,
  sourceHubState: EntityState,
  cancels: SwapCancelRequestEvent[],
): RoutedOrderbookCancels {
  const localBookCancels: SwapCancelRequestEvent[] = [];
  const outputs: EntityInput[] = [];
  const currentEntityId = normalizeEntityRef(sourceHubState.entityId);

  for (const cancel of cancels) {
    const route = sourceHubState.accounts
      .get(cancel.accountId)
      ?.state.swapOffers
      ?.get(cancel.offerId)
      ?.crossJurisdiction;
    if (!route) {
      localBookCancels.push(cancel);
      continue;
    }

    const sourceHubEntityId = normalizeEntityRef(route.source.counterpartyEntityId);
    if (currentEntityId !== sourceHubEntityId) {
      throw haltRuntimeFailure("CROSS_J_CANCEL_SOURCE_HUB_REQUIRED", `CROSS_J_CANCEL_SOURCE_HUB_REQUIRED:offer=${cancel.offerId}:` +
          `entity=${currentEntityId}:sourceHub=${sourceHubEntityId}`);
    }

    const bookOwnerEntityId = crossJurisdictionBookOwnerRef(route);
    if (!bookOwnerEntityId) {
      throw haltRuntimeFailure("CROSS_J_CANCEL_BOOK_OWNER_MISSING", `CROSS_J_CANCEL_BOOK_OWNER_MISSING:offer=${cancel.offerId}`);
    }
    if (bookOwnerEntityId === currentEntityId) {
      localBookCancels.push(cancel);
      continue;
    }

    const bookOwnerSignerId = crossJurisdictionRouteSignerHint(route, bookOwnerEntityId);
    if (!bookOwnerSignerId) {
      throw haltRuntimeFailure("CROSS_J_CANCEL_BOOK_OWNER_SIGNER_MISSING", `CROSS_J_CANCEL_BOOK_OWNER_SIGNER_MISSING:offer=${cancel.offerId}:owner=${bookOwnerEntityId}`);
    }
    markCrossJurisdictionBookAdmissionResolving(
      sourceHubState,
      route,
      Number(sourceHubState.timestamp || env.state.timestamp || 0),
    );
    outputs.push(buildCrossJurisdictionEntityOutput(bookOwnerEntityId, bookOwnerSignerId, [{
      type: 'removeCrossJurisdictionBookOrder',
      data: {
        orderId: cancel.offerId,
        sourceEntityId: route.source.entityId,
        sourceAccountId: cancel.accountId,
        route,
        reason: 'cancel_request',
      },
    }]));
  }

  return { localBookCancels, outputs };
}

/**
 * Apply hub-decided orderbook cancels and enqueue the account-level settlement.
 * This mutates only the orderbook extension and returns account mempool ops for
 * the entity orchestrator to commit through the normal account frame path.
 * A cross-j cancel is Hub-internal progress: the source Hub requests the clear
 * at the committed fill and the pull close settles the remainder.
 */
export function processOrderbookCancels(
  hubState: EntityState,
  cancels: SwapCancelRequestEvent[],
): MatchResult {
  const accountTxs: AccountTxTarget[] = [];
  const crossJurisdictionFills: CrossJurisdictionFillInstruction[] = [];
  const workingBooks = new Map<string, BookState>();
  const debugProjectionRejects: MatchResult['debugProjectionRejects'] = [];
  const queuedSwapResolutions = new Set<string>();
  const ext = hubState.orderbookExt as OrderbookExtState | undefined;
  if (!ext) throw haltRuntimeFailure("ORDERBOOK_EXTENSION_REQUIRED_FOR_CANCEL", 'ORDERBOOK_EXTENSION_REQUIRED_FOR_CANCEL');

  for (const { offerId, accountId } of cancels) {
    const account = hubState.accounts.get(accountId);
    const hasOffer = Boolean(account?.state.swapOffers?.has(offerId));
    if (!hasOffer) continue;

    const namespacedOrderId = swapKey(accountId, offerId);
    let orderbookCancelled = false;
    const matchingBooks: Array<{ bookKey: string; book: BookState; ownerId: string }> = [];

    for (const bookKey of getOrderbookPairsForOrder(ext, namespacedOrderId)) {
      const source = workingBooks.get(bookKey) ?? ext.books.get(bookKey);
      if (!source) continue;
      const book = workingBooks.get(bookKey) ?? forkBookState(source);
      const existingOrder = getBookOrder(book, namespacedOrderId);
      if (!existingOrder) continue;
      matchingBooks.push({ bookKey, book, ownerId: existingOrder.ownerId });
    }

    if (matchingBooks.length > 1) {
      throw haltRuntimeFailure("ORDERBOOK_DUPLICATE_BOOK_ORDER", `ORDERBOOK_DUPLICATE_BOOK_ORDER: order=${namespacedOrderId} matches=${matchingBooks.length}`);
    }

    for (const { bookKey, book, ownerId } of matchingBooks) {
      const result = applyCommand(book, {
        kind: 1,
        ownerId,
        orderId: namespacedOrderId,
      });
      if (commitBookOverlay(result.state) !== book) {
        throw haltRuntimeFailure(
          'ORDERBOOK_CANCEL_CHILD_MERGE_FAILED',
          `ORDERBOOK_CANCEL_CHILD_MERGE_FAILED:pair=${bookKey}:order=${namespacedOrderId}`,
        );
      }
      workingBooks.set(bookKey, book);
      orderbookLog.debug('order.cancelled', { offer: shortOrder(offerId, 8), account: shortId(accountId, 8), pair: bookKey });
      orderbookCancelled = true;
    }

    const offer = account?.state.swapOffers?.get(offerId);
    if (offer?.crossJurisdiction) {
      const admission = hubState.crossJurisdictionBookAdmissions?.get(
        crossJurisdictionBookAdmissionKeyFor(accountId, offerId),
      );
      crossJurisdictionFills.push(buildCrossJurisdictionCancelInstruction(
        accountId,
        offerId,
        namespacedOrderId,
        admission?.route ?? offer.crossJurisdiction,
      ));
      orderbookLog.debug('crossj.cancel_queued', { offer: shortOrder(offerId, 8), account: shortId(accountId, 8) });
      continue;
    }

    if (queueUniqueSwapResolveForEntityState(accountTxs, hubState, queuedSwapResolutions, accountId, {
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

  const bookUpdates = [...workingBooks].map(([pairId, book]) => ({ pairId, book }));
  return { accountTxs, crossJurisdictionFills, bookUpdates, debugProjectionRejects };
}
