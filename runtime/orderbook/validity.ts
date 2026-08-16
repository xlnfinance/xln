import {
  canonicalPair,
  computeSwapPriceTicksForDimensions,
  deriveSide,
  getSwapLotScaleForDecimals,
  getBookOrders,
  MAX_ORDERBOOK_QTY_LOTS,
  type BookOrderState,
  type BookState,
  type OrderbookExtState,
} from './types';
import { compareCanonicalText, swapKey, type SwapKey } from './swap-execution';
import type { AccountState, SwapOffer } from '../types/account';
import type { EntityState } from '../entity/types';

type OrderbookMediumField = 'pairId' | 'side' | 'priceTicks' | 'qtyLots' | 'ownerId' | 'pairIndex';
type QuarantineReason =
  | 'invalid-direction'
  | 'zero-amount'
  | 'lot-misaligned'
  | 'invalid-order'
  | 'invalid-price';

type ExpectedBookOrder = {
  swapKey: SwapKey;
  pairId: string;
  orderId: string;
  accountId: string;
  offerId: string;
  ownerId: string;
  side: 0 | 1;
  priceTicks: bigint;
  qtyLots: bigint;
};

type ActualBookOrder = {
  swapKey: SwapKey | null;
  pairId: string;
  orderId: string;
  ownerId: string;
  side: 0 | 1;
  priceTicks: bigint;
  qtyLots: bigint;
};

export type BookStructureReport = {
  ok: boolean;
  errors: string[];
  stats: {
    activeOrders: number;
    indexedOrders: number;
    reachableOrders: number;
    levels: number;
  };
};

export type BookMediumReport = {
  ok: boolean;
  invalidOffers: Array<{ swapKey: string; reason: QuarantineReason }>;
  missingInBook: string[];
  orphanedInBook: string[];
  mismatched: Array<{
    swapKey: string;
    field: OrderbookMediumField;
    expected: string;
    actual: string;
  }>;
  stats: {
    openOffers: number;
    activeBookOrders: number;
    checkedPairs: number;
  };
};

export type EntityOrderbookValidityReport = {
  ok: boolean;
  structure: Record<string, BookStructureReport>;
  medium: BookMediumReport;
};

const toOrderId = (accountId: string, offerId: string): string => `${accountId}:${offerId}`;

const parseNamespacedOrderId = (orderId: string): { accountId: string; offerId: string; swapKey: SwapKey } | null => {
  const lastColon = orderId.lastIndexOf(':');
  if (lastColon <= 0 || lastColon >= orderId.length - 1) return null;
  const accountId = orderId.slice(0, lastColon);
  const offerId = orderId.slice(lastColon + 1);
  return { accountId, offerId, swapKey: swapKey(accountId, offerId) };
};

const activeOrderCount = (book: BookState): number => book.orders.size;

const snapshotBookOrder = (pairId: string, order: BookOrderState): ActualBookOrder => {
  const parsed = parseNamespacedOrderId(order.orderId);
  return {
    swapKey: parsed?.swapKey ?? null,
    pairId,
    orderId: order.orderId,
    ownerId: order.ownerId,
    side: order.side,
    priceTicks: order.priceTicks,
    qtyLots: BigInt(order.qtyLots),
  };
};

const normalizeOpenOfferForBook = (
  accountId: string,
  account: AccountState,
  offerId: string,
  offer: SwapOffer,
): ExpectedBookOrder | { invalid: { swapKey: string; reason: QuarantineReason } } => {
  const { pairId, base, quote } = canonicalPair(offer.giveTokenId, offer.wantTokenId);
  const side = deriveSide(offer.giveTokenId, offer.wantTokenId);
  const isSellBase = offer.giveTokenId === base && offer.wantTokenId === quote;
  const isBuyBase = offer.giveTokenId === quote && offer.wantTokenId === base;
  const key = swapKey(accountId, offerId);

  if (!isSellBase && !isBuyBase) return { invalid: { swapKey: key, reason: 'invalid-direction' } };

  const baseAmount = side === 1 ? offer.giveAmount : offer.wantAmount;
  const quoteAmount = side === 1 ? offer.wantAmount : offer.giveAmount;
  const baseTokenDecimals = side === 1 ? offer.giveTokenDecimals : offer.wantTokenDecimals;
  const lotScale = getSwapLotScaleForDecimals(baseTokenDecimals);
  if (baseAmount <= 0n || quoteAmount <= 0n) return { invalid: { swapKey: key, reason: 'zero-amount' } };
  if (baseAmount % lotScale !== 0n) return { invalid: { swapKey: key, reason: 'lot-misaligned' } };

  const qtyLots = baseAmount / lotScale;
  if (qtyLots <= 0n || qtyLots > MAX_ORDERBOOK_QTY_LOTS) return { invalid: { swapKey: key, reason: 'invalid-order' } };

  const priceTicks =
    typeof offer.priceTicks === 'bigint' && offer.priceTicks > 0n
      ? offer.priceTicks
      : computeSwapPriceTicksForDimensions(
          offer.giveTokenId,
          offer.wantTokenId,
          offer.giveAmount,
          offer.wantAmount,
          offer,
        );
  if (priceTicks <= 0n) return { invalid: { swapKey: key, reason: 'invalid-price' } };

  const ownerId = offer.makerIsLeft ? account.leftEntity : account.rightEntity;

  return {
    swapKey: key,
    pairId,
    orderId: toOrderId(accountId, offerId),
    accountId,
    offerId,
    ownerId,
    side,
    priceTicks,
    qtyLots,
  };
};

const collectActualBookOrders = (ext: OrderbookExtState): Map<string, ActualBookOrder> => {
  const actual = new Map<string, ActualBookOrder>();
  for (const [pairId, book] of ext.books.entries()) {
    for (const order of getBookOrders(book)) {
      const snapshot = snapshotBookOrder(pairId, order);
      actual.set(snapshot.swapKey ?? `orphan:${pairId}:${order.orderId}`, snapshot);
    }
  }
  return actual;
};

const collectExpectedPairIndex = (ext: OrderbookExtState): Map<string, string[]> => {
  const expected = new Map<string, string[]>();
  for (const [pairId, book] of ext.books.entries()) {
    for (const orderId of book.orders.keys()) {
      const existing = expected.get(orderId);
      if (existing) {
        if (!existing.includes(pairId)) existing.push(pairId);
      } else {
        expected.set(orderId, [pairId]);
      }
    }
  }
  for (const pairIds of expected.values()) pairIds.sort(compareCanonicalText);
  return expected;
};

export function validateBookStructure(book: BookState): BookStructureReport {
  const errors: string[] = [];
  const reachable = new Set<string>();
  const orders = getBookOrders(book);
  const validateSidePages = (side: 0 | 1, label: 'bid' | 'ask'): number => {
    const pages = side === 0 ? book.bidPages : book.askPages;
    const prices = new Set<string>();
    for (const [key, page] of pages.entries()) {
      prices.add(key.priceTicks.toString());
      let computedTotal = 0n;
      let computedLive = 0;
      let previousSequence = -1;
      for (let slot = page.headSlot; slot < page.nextSlot; slot += 1) {
        const entry = page.slots[slot];
        if (!entry) continue;
        computedLive += 1;
        computedTotal += entry.qtyLots;
        if (entry.seq <= previousSequence) errors.push(`${label} page FIFO broken at ${entry.orderId}`);
        previousSequence = entry.seq;
        if (reachable.has(entry.orderId)) errors.push(`duplicate page order ${entry.orderId}`);
        reachable.add(entry.orderId);
        const indexed = book.orders.get(entry.orderId);
        if (!indexed) {
          errors.push(`${label} page missing locator ${entry.orderId}`);
          continue;
        }
        if (
          indexed.side !== side || indexed.priceTicks !== key.priceTicks ||
          indexed.pageSequence !== key.pageSequence || indexed.pageSlot !== slot ||
          indexed.ownerId !== entry.ownerId || indexed.qtyLots !== entry.qtyLots || indexed.seq !== entry.seq
        ) errors.push(`${label} page locator mismatch ${entry.orderId}`);
      }
      if (computedLive !== page.liveCount) errors.push(`${label} page live count mismatch`);
      if (computedTotal !== page.totalQtyLots) errors.push(`${label} page total mismatch`);
    }
    return prices.size;
  };

  const bidLevels = validateSidePages(0, 'bid');
  const askLevels = validateSidePages(1, 'ask');

  for (const order of orders) {
    if (!reachable.has(order.orderId)) {
      errors.push(`order ${order.orderId} missing from price pages`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    stats: {
      activeOrders: activeOrderCount(book),
      indexedOrders: book.orders.size,
      reachableOrders: reachable.size,
      levels: bidLevels + askLevels,
    },
  };
}

export function validateBookAgainstOffers(state: EntityState): BookMediumReport {
  const ext = state.orderbookExt;
  if (!ext) {
    return {
      ok: true,
      invalidOffers: [],
      missingInBook: [],
      orphanedInBook: [],
      mismatched: [],
      stats: {
        openOffers: 0,
        activeBookOrders: 0,
        checkedPairs: 0,
      },
    };
  }

  const invalidOffers: BookMediumReport['invalidOffers'] = [];
  const expected = new Map<string, ExpectedBookOrder>();
  for (const [accountId, account] of state.accounts.entries()) {
    for (const [offerId, offer] of account.state.swapOffers.entries()) {
      const normalized = normalizeOpenOfferForBook(accountId, account.state, String(offerId), offer);
      if ('invalid' in normalized) {
        invalidOffers.push(normalized.invalid);
        continue;
      }
      expected.set(normalized.swapKey, normalized);
    }
  }

  const actual = collectActualBookOrders(ext);
  const missingInBook: string[] = [];
  const orphanedInBook: string[] = [];
  const mismatched: BookMediumReport['mismatched'] = [];

  for (const [key, expectedOrder] of expected.entries()) {
    const actualOrder = actual.get(key);
    if (!actualOrder) {
      missingInBook.push(key);
      continue;
    }
    const fields: Array<[OrderbookMediumField, string, string]> = [
      ['pairId', expectedOrder.pairId, actualOrder.pairId],
      ['side', String(expectedOrder.side), String(actualOrder.side)],
      ['priceTicks', expectedOrder.priceTicks.toString(), actualOrder.priceTicks.toString()],
      ['qtyLots', expectedOrder.qtyLots.toString(), actualOrder.qtyLots.toString()],
      ['ownerId', expectedOrder.ownerId, actualOrder.ownerId],
    ];
    for (const [field, expectedValue, actualValue] of fields) {
      if (expectedValue === actualValue) continue;
      mismatched.push({
        swapKey: key,
        field,
        expected: expectedValue,
        actual: actualValue,
      });
    }
  }

  for (const [key, actualOrder] of actual.entries()) {
    if (actualOrder.swapKey === null || !expected.has(key)) orphanedInBook.push(key);
  }

  const expectedPairIndex = collectExpectedPairIndex(ext);
  const actualPairIndex = ext.orderPairs instanceof Map ? ext.orderPairs : new Map<string, string[]>();
  const indexedOrderIds = new Set<string>([
    ...expectedPairIndex.keys(),
    ...actualPairIndex.keys(),
  ]);
  for (const orderId of indexedOrderIds) {
    const expectedPairs = [...expectedPairIndex.get(orderId) ?? []].sort(compareCanonicalText);
    const actualPairs = [...actualPairIndex.get(orderId) ?? []].sort(compareCanonicalText);
    const expectedJoined = expectedPairs.join(',');
    const actualJoined = actualPairs.join(',');
    if (expectedJoined === actualJoined) continue;
    mismatched.push({
      swapKey: orderId,
      field: 'pairIndex',
      expected: expectedJoined,
      actual: actualJoined,
    });
  }

  return {
    ok: invalidOffers.length === 0 && missingInBook.length === 0 && orphanedInBook.length === 0 && mismatched.length === 0,
    invalidOffers: invalidOffers.sort((a, b) => compareCanonicalText(a.swapKey, b.swapKey)),
    missingInBook: missingInBook.sort(compareCanonicalText),
    orphanedInBook: orphanedInBook.sort(compareCanonicalText),
    mismatched: mismatched.sort((left, right) => {
      const keyCmp = compareCanonicalText(left.swapKey, right.swapKey);
      if (keyCmp !== 0) return keyCmp;
      return compareCanonicalText(left.field, right.field);
    }),
    stats: {
      openOffers: expected.size,
      activeBookOrders: actual.size,
      checkedPairs: ext.books.size,
    },
  };
}

export function validateEntityOrderbooks(state: EntityState): EntityOrderbookValidityReport {
  const structure: Record<string, BookStructureReport> = {};
  for (const [pairId, book] of state.orderbookExt?.books?.entries?.() ?? []) {
    structure[pairId] = validateBookStructure(book);
  }
  const medium = validateBookAgainstOffers(state);
  const ok = medium.ok && Object.values(structure).every((report) => report.ok);
  return { ok, structure, medium };
}
