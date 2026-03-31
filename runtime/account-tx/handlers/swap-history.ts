import type {
  AccountMachine,
  SwapOffer,
  SwapOrderHistoryEntry,
  SwapOrderResolveHistoryEntry,
} from '../../types';

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
    wantTokenId: offer.wantTokenId,
    wantAmount: offer.wantAmount,
    ...(offer.priceTicks !== undefined ? { priceTicks: offer.priceTicks } : {}),
    createdHeight: offer.createdHeight,
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
      wantTokenId: fallbackOffer.wantTokenId,
      wantAmount: fallbackOffer.wantAmount,
      ...(fallbackOffer.priceTicks !== undefined ? { priceTicks: fallbackOffer.priceTicks } : {}),
      createdHeight: fallbackOffer.createdHeight ?? currentHeight,
      cancelRequested: false,
      lastUpdatedHeight: currentHeight,
      resolves: [],
    };
    history.set(offerId, entry);
  }
  entry.lastUpdatedHeight = currentHeight;
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
