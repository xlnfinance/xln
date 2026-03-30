import {
  canonicalPair,
  computeSwapPriceTicks,
  deriveSide,
  getBookOrders,
  SWAP_LOT_SCALE,
  type BookOrderState,
  type BookState,
  type OrderbookExtState,
} from './types';
import { compareCanonicalText, swapKey, type SwapKey } from '../swap-execution';
import type { AccountMachine, EntityState, SwapOffer } from '../types';

const MAX_QTY_LOTS = 0xFFFFFFFFn;

export type OrderbookMediumField = 'pairId' | 'side' | 'priceTicks' | 'qtyLots' | 'ownerId' | 'pairIndex';
export type QuarantineReason =
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
  account: AccountMachine,
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
  if (baseAmount <= 0n || quoteAmount <= 0n) return { invalid: { swapKey: key, reason: 'zero-amount' } };
  if (baseAmount % SWAP_LOT_SCALE !== 0n) return { invalid: { swapKey: key, reason: 'lot-misaligned' } };

  const qtyLots = baseAmount / SWAP_LOT_SCALE;
  if (qtyLots <= 0n || qtyLots > MAX_QTY_LOTS) return { invalid: { swapKey: key, reason: 'invalid-order' } };

  const priceTicks =
    typeof offer.priceTicks === 'bigint' && offer.priceTicks > 0n
      ? offer.priceTicks
      : computeSwapPriceTicks(
          offer.giveTokenId,
          offer.wantTokenId,
          offer.giveAmount,
          offer.wantAmount,
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

  const validateSideBuckets = (
    side: 0 | 1,
    bucketIds: bigint[],
    buckets: Map<string, { bucketId: bigint; pricesAsc: bigint[]; levels: Map<string, { priceTicks: bigint; orderIds: string[]; totalQtyLots: number }> }>,
    label: 'bid' | 'ask',
  ): number => {
    let levelCount = 0;
    let previousBucket: bigint | null = null;
    for (const bucketId of bucketIds) {
      if (previousBucket !== null) {
        const ordered = side === 0 ? previousBucket > bucketId : previousBucket < bucketId;
        if (!ordered) errors.push(`${label} bucket order broken: ${previousBucket.toString()} -> ${bucketId.toString()}`);
      }
      previousBucket = bucketId;
      const bucket = buckets.get(bucketId.toString());
      if (!bucket) {
        errors.push(`${label} bucket missing from map: ${bucketId.toString()}`);
        continue;
      }
      let previousPrice: bigint | null = null;
      for (const priceTicks of bucket.pricesAsc) {
        if (previousPrice !== null && previousPrice >= priceTicks) {
          errors.push(`${label} bucket ${bucketId.toString()} pricesAsc not strictly ascending`);
        }
        previousPrice = priceTicks;
        const level = bucket.levels.get(priceTicks.toString());
        if (!level) {
          errors.push(`${label} bucket ${bucketId.toString()} missing level ${priceTicks.toString()}`);
          continue;
        }
        if (level.orderIds.length === 0) errors.push(`${label} level ${priceTicks.toString()} empty orderIds`);
        let computedTotal = 0;
        for (const orderId of level.orderIds) {
          reachable.add(orderId);
          const order = book.orders.get(orderId);
          if (!order) {
            errors.push(`${label} level ${priceTicks.toString()} missing order ${orderId}`);
            continue;
          }
          if (order.side !== side) errors.push(`${label} level ${priceTicks.toString()} side mismatch for ${orderId}`);
          if (order.priceTicks !== priceTicks) errors.push(`${label} level ${priceTicks.toString()} price mismatch for ${orderId}`);
          if (order.bucketId !== bucketId) errors.push(`${label} level ${priceTicks.toString()} bucket mismatch for ${orderId}`);
          if (order.qtyLots <= 0) errors.push(`${label} level ${priceTicks.toString()} non-positive qty for ${orderId}`);
          computedTotal += Math.max(0, order.qtyLots);
        }
        if (computedTotal !== level.totalQtyLots) {
          errors.push(`${label} level ${priceTicks.toString()} total mismatch expected=${computedTotal} actual=${level.totalQtyLots}`);
        }
        levelCount += 1;
      }
      for (const [levelKey, level] of bucket.levels.entries()) {
        if (!bucket.pricesAsc.some((price) => price.toString() === levelKey)) {
          errors.push(`${label} bucket ${bucketId.toString()} level ${levelKey} missing from pricesAsc`);
        }
        if (level.totalQtyLots <= 0) errors.push(`${label} level ${levelKey} non-positive total`);
      }
    }
    return levelCount;
  };

  const bidLevels = validateSideBuckets(0, book.bidBucketIdsDesc, book.bidBuckets, 'bid');
  const askLevels = validateSideBuckets(1, book.askBucketIdsAsc, book.askBuckets, 'ask');

  for (const order of orders) {
    if (!reachable.has(order.orderId)) {
      errors.push(`order ${order.orderId} missing from bucket queues`);
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
    for (const [offerId, offer] of account.swapOffers.entries()) {
      const normalized = normalizeOpenOfferForBook(accountId, account, String(offerId), offer);
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
