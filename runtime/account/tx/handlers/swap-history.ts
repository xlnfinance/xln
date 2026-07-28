import type {
  AccountState,
  SwapOffer,
  SwapOrderHistoryEntry,
  SwapOrderResolveHistoryEntry,
} from '../../../types';
import {
  cloneCrossJurisdictionRoute,
  cloneCrossJurisdictionSwapHistoryRoute,
} from '../../../extensions/cross-j/index';
import { LIMITS } from '../../../constants';

function ensureSwapOrderHistory(account: AccountState): Map<string, SwapOrderHistoryEntry> {
  if (!(account.swapOrderHistory instanceof Map)) {
    account.swapOrderHistory = new Map();
  }
  return account.swapOrderHistory;
}

function ensureSwapClosedOrders(account: AccountState): Map<string, SwapOrderHistoryEntry> {
  if (!(account.swapClosedOrders instanceof Map)) {
    account.swapClosedOrders = new Map();
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

function pruneTerminalSwapHistory(account: AccountState): void {
  const terminalHistory = Array.from(ensureSwapOrderHistory(account).entries())
    .filter(([offerId]) => !account.swapOffers.has(offerId))
    .sort(byOldestLifecycle);
  const excessHistory = terminalHistory.length - LIMITS.MAX_ACCOUNT_TERMINAL_SWAP_HISTORY;
  for (const [offerId] of terminalHistory.slice(0, Math.max(0, excessHistory))) {
    account.swapOrderHistory!.delete(offerId);
  }

  const closedOrders = ensureSwapClosedOrders(account);
  const excessClosed = closedOrders.size - LIMITS.MAX_ACCOUNT_TERMINAL_SWAP_HISTORY;
  if (excessClosed <= 0) return;
  for (const [offerId] of Array.from(closedOrders.entries()).sort(byOldestLifecycle).slice(0, excessClosed)) {
    closedOrders.delete(offerId);
  }
}

export function recordSwapOfferLifecycle(
  account: AccountState,
  offer: SwapOffer,
): void {
  if (
    offer.offerId.length === 0 ||
    offer.offerId.length > LIMITS.MAX_ACCOUNT_SWAP_HISTORY_TEXT ||
    offer.offerId.includes(':')
  ) {
    throw new Error(`ACCOUNT_SWAP_HISTORY_OFFER_ID_INVALID:${offer.offerId.length}`);
  }
  const history = ensureSwapOrderHistory(account);
  if (history.has(offer.offerId)) return;
  history.set(offer.offerId, {
    offerId: offer.offerId,
    giveTokenId: offer.giveTokenId,
    giveAmount: offer.giveAmount,
    originalGiveAmount: offer.giveAmount,
    wantTokenId: offer.wantTokenId,
    wantAmount: offer.wantAmount,
    originalWantAmount: offer.wantAmount,
    ...(offer.priceTicks !== undefined ? { priceTicks: offer.priceTicks } : {}),
    createdHeight: offer.createdHeight,
    ...(offer.crossJurisdiction ? { crossJurisdiction: cloneCrossJurisdictionRoute(offer.crossJurisdiction) } : {}),
    cancelRequested: false,
    lastUpdatedHeight: offer.createdHeight,
    resolves: [],
  });
}

export function recordSwapCancelRequested(
  account: AccountState,
  offerId: string,
  currentHeight: number,
): void {
  const entry = ensureSwapOrderHistory(account).get(offerId);
  if (!entry) return;
  entry.cancelRequested = true;
  entry.lastUpdatedHeight = currentHeight;
}

export function recordSwapResolveLifecycle(
  account: AccountState,
  offerId: string,
  currentHeight: number,
  resolve: SwapOrderResolveHistoryEntry,
  fallbackOffer?: {
    giveTokenId: number;
    giveAmount: bigint;
    wantTokenId: number;
    wantAmount: bigint;
    priceTicks?: bigint;
    createdHeight?: number;
  },
): void {
  if ((resolve.comment?.length ?? 0) > LIMITS.MAX_ACCOUNT_SWAP_HISTORY_TEXT) {
    throw new Error(`ACCOUNT_SWAP_HISTORY_COMMENT_TOO_LONG:${resolve.comment!.length}`);
  }
  const history = ensureSwapOrderHistory(account);
  let entry = history.get(offerId);
  if (!entry) {
    if (!fallbackOffer) return;
    entry = {
      offerId,
      giveTokenId: fallbackOffer.giveTokenId,
      giveAmount: fallbackOffer.giveAmount,
      originalGiveAmount: fallbackOffer.giveAmount,
      wantTokenId: fallbackOffer.wantTokenId,
      wantAmount: fallbackOffer.wantAmount,
      originalWantAmount: fallbackOffer.wantAmount,
      ...(fallbackOffer.priceTicks !== undefined ? { priceTicks: fallbackOffer.priceTicks } : {}),
      createdHeight: fallbackOffer.createdHeight ?? currentHeight,
      cancelRequested: false,
      lastUpdatedHeight: currentHeight,
      resolves: [],
    };
    history.set(offerId, entry);
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
  account: AccountState,
  offerId: string,
): void {
  const historyEntry = ensureSwapOrderHistory(account).get(offerId);
  if (!historyEntry) return;
  const closedOrders = ensureSwapClosedOrders(account);
  // Open lifecycle and terminal history are separate state owners. Reusing
  // the mutable cross-j route here creates an alias across two Account maps;
  // that alias has caused Bun's composite structuredClone to fail after a
  // cross-j close. Use the canonical deep carrier clone for every nested leg.
  closedOrders.set(offerId, cloneCrossJurisdictionSwapHistoryRoute(historyEntry));
  pruneTerminalSwapHistory(account);
}
