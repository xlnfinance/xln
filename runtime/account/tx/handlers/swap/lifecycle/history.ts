import type { AccountReplica, SwapOffer, SwapOrderHistoryEntry, SwapOrderResolveHistoryEntry } from '../../../../../types/account';
import {
  cloneCrossJurisdictionRoute,
  cloneCrossJurisdictionSwapHistoryRoute,
} from '../../../../../extensions/cross-j/index';
import { LIMITS } from '../../../../../config/constants';

function requireSwapOrderHistory(account: AccountReplica): Map<string, SwapOrderHistoryEntry> {
  if (!(account.swapOrderHistory instanceof Map)) {
    throw new Error('ACCOUNT_SWAP_HISTORY_MAP_REQUIRED');
  }
  return account.swapOrderHistory;
}

function requireSwapClosedOrders(account: AccountReplica): Map<string, SwapOrderHistoryEntry> {
  if (!(account.swapClosedOrders instanceof Map)) {
    throw new Error('ACCOUNT_SWAP_CLOSED_MAP_REQUIRED');
  }
  return account.swapClosedOrders;
}

const sameOptionalBigint = (left: bigint | undefined, right: bigint | undefined): boolean =>
  (left ?? null) === (right ?? null);

const sameResolveHistoryEntry = (
  left: SwapOrderResolveHistoryEntry,
  right: SwapOrderResolveHistoryEntry,
): boolean =>
  left.fillRatio === right.fillRatio &&
  sameOptionalBigint(left.fillNumerator, right.fillNumerator) &&
  sameOptionalBigint(left.fillDenominator, right.fillDenominator) &&
  left.cancelRemainder === right.cancelRemainder &&
  left.height === right.height &&
  sameOptionalBigint(left.executionGiveAmount, right.executionGiveAmount) &&
  sameOptionalBigint(left.executionWantAmount, right.executionWantAmount) &&
  left.feeTokenId === right.feeTokenId &&
  sameOptionalBigint(left.feeAmount, right.feeAmount) &&
  (left.comment ?? '') === (right.comment ?? '');

const byOldestLifecycle = (
  left: readonly [string, SwapOrderHistoryEntry],
  right: readonly [string, SwapOrderHistoryEntry],
): number => {
  if (left[1].lastUpdatedHeight !== right[1].lastUpdatedHeight) {
    return left[1].lastUpdatedHeight < right[1].lastUpdatedHeight ? -1 : 1;
  }
  return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
};

function pruneTerminalSwapHistory(account: AccountReplica): void {
  const terminalHistory = Array.from(requireSwapOrderHistory(account).entries())
    .filter(([offerId]) => !account.state.swapOffers.has(offerId))
    .sort(byOldestLifecycle);
  const excessHistory = terminalHistory.length - LIMITS.MAX_ACCOUNT_TERMINAL_SWAP_HISTORY;
  for (const [offerId] of terminalHistory.slice(0, Math.max(0, excessHistory))) {
    account.swapOrderHistory.delete(offerId);
  }

  const closedOrders = requireSwapClosedOrders(account);
  const excessClosed = closedOrders.size - LIMITS.MAX_ACCOUNT_TERMINAL_SWAP_HISTORY;
  if (excessClosed <= 0) return;
  for (const [offerId] of Array.from(closedOrders.entries()).sort(byOldestLifecycle).slice(0, excessClosed)) {
    closedOrders.delete(offerId);
  }
}

export function recordSwapOfferLifecycle(
  account: AccountReplica,
  offer: SwapOffer,
): void {
  if (
    offer.offerId.length === 0 ||
    offer.offerId.length > LIMITS.MAX_ACCOUNT_SWAP_HISTORY_TEXT ||
    offer.offerId.includes(':')
  ) {
    throw new Error(`ACCOUNT_SWAP_HISTORY_OFFER_ID_INVALID:${offer.offerId.length}`);
  }
  const history = requireSwapOrderHistory(account);
  if (history.has(offer.offerId)) return;
  history.set(offer.offerId, {
    offerId: offer.offerId,
    giveTokenId: offer.giveTokenId,
    giveAmount: offer.giveAmount,
    originalGiveAmount: offer.giveAmount,
    wantTokenId: offer.wantTokenId,
    wantAmount: offer.wantAmount,
    originalWantAmount: offer.wantAmount,
    priceTicks: offer.priceTicks,
    createdHeight: offer.createdHeight,
    ...(offer.crossJurisdiction ? { crossJurisdiction: cloneCrossJurisdictionRoute(offer.crossJurisdiction) } : {}),
    cancelRequested: false,
    lastUpdatedHeight: offer.createdHeight,
    resolves: [],
  });
}

export function recordSwapCancelRequested(
  account: AccountReplica,
  offerId: string,
  currentHeight: number,
): void {
  const entry = requireSwapOrderHistory(account).get(offerId);
  if (!entry) throw new Error(`ACCOUNT_SWAP_HISTORY_MISSING:${offerId}`);
  entry.cancelRequested = true;
  entry.lastUpdatedHeight = currentHeight;
}

export function recordSwapResolveLifecycle(
  account: AccountReplica,
  offerId: string,
  currentHeight: number,
  resolve: SwapOrderResolveHistoryEntry,
): void {
  if ((resolve.comment?.length ?? 0) > LIMITS.MAX_ACCOUNT_SWAP_HISTORY_TEXT) {
    throw new Error(`ACCOUNT_SWAP_HISTORY_COMMENT_TOO_LONG:${resolve.comment!.length}`);
  }
  const history = requireSwapOrderHistory(account);
  const entry = history.get(offerId);
  if (!entry) {
    throw new Error(`ACCOUNT_SWAP_HISTORY_MISSING:${offerId}`);
  }
  entry.originalGiveAmount ??= entry.giveAmount;
  entry.originalWantAmount ??= entry.wantAmount;
  entry.lastUpdatedHeight = currentHeight;
  if (entry.resolves.some((existing) => sameResolveHistoryEntry(existing, resolve))) return;
  entry.resolves.push(resolve);
  const excess = entry.resolves.length - LIMITS.MAX_ACCOUNT_SWAP_RESOLVES_PER_ORDER;
  if (excess > 0) entry.resolves.splice(0, excess);
}

export function recordSwapClosedLifecycle(
  account: AccountReplica,
  offerId: string,
): void {
  const historyEntry = requireSwapOrderHistory(account).get(offerId);
  if (!historyEntry) throw new Error(`ACCOUNT_SWAP_HISTORY_MISSING:${offerId}`);
  const closedOrders = requireSwapClosedOrders(account);
  // Open lifecycle and terminal history are separate state owners. Reusing
  // the mutable cross-j route here creates an alias across two Account maps;
  // that alias has caused Bun's composite structuredClone to fail after a
  // cross-j close. Use the canonical deep carrier clone for every nested leg.
  closedOrders.set(offerId, cloneCrossJurisdictionSwapHistoryRoute(historyEntry));
  pruneTerminalSwapHistory(account);
}
