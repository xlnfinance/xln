import type {
  AccountMachine,
  SwapOffer,
  SwapOrderHistoryEntry,
  SwapOrderResolveHistoryEntry,
} from '../../../types';
import { cloneCrossJurisdictionRoute } from '../../../extensions/cross-j/index';

function ensureSwapOrderHistory(accountMachine: AccountMachine): Map<string, SwapOrderHistoryEntry> {
  if (!(accountMachine.swapOrderHistory instanceof Map)) {
    accountMachine.swapOrderHistory = new Map();
  }
  return accountMachine.swapOrderHistory;
}

function ensureSwapClosedOrders(accountMachine: AccountMachine): Map<string, SwapOrderHistoryEntry> {
  if (!(accountMachine.swapClosedOrders instanceof Map)) {
    accountMachine.swapClosedOrders = new Map();
  }
  return accountMachine.swapClosedOrders;
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

export function recordSwapOfferLifecycle(
  accountMachine: AccountMachine,
  offer: SwapOffer,
): void {
  const history = ensureSwapOrderHistory(accountMachine);
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
  accountMachine: AccountMachine,
  offerId: string,
  currentHeight: number,
): void {
  const entry = ensureSwapOrderHistory(accountMachine).get(offerId);
  if (!entry) return;
  entry.cancelRequested = true;
  entry.lastUpdatedHeight = currentHeight;
}

export function recordSwapResolveLifecycle(
  accountMachine: AccountMachine,
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
  const history = ensureSwapOrderHistory(accountMachine);
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
}

export function recordSwapClosedLifecycle(
  accountMachine: AccountMachine,
  offerId: string,
): void {
  const historyEntry = ensureSwapOrderHistory(accountMachine).get(offerId);
  if (!historyEntry) return;
  const closedOrders = ensureSwapClosedOrders(accountMachine);
  closedOrders.set(offerId, {
    ...historyEntry,
    resolves: Array.isArray(historyEntry.resolves)
      ? historyEntry.resolves.map((resolve) => ({ ...resolve }))
      : [],
  });
}
