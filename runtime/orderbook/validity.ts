import { canonicalPair, computeSwapPriceTicks, deriveSide, SWAP_LOT_SCALE, type BookState, type OrderbookExtState } from './types';
import { compareCanonicalText, swapKey, type SwapKey } from '../swap-execution';
import type { AccountMachine, EntityState, SwapOffer } from '../types';

const EMPTY = -1;
const MAX_QTY_LOTS = 0xFFFFFFFFn;

export type OrderbookMediumField = 'pairId' | 'side' | 'priceTicks' | 'qtyLots' | 'ownerId';
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

const activeOrderCount = (book: BookState): number => {
  let count = 0;
  for (let i = 0; i < book.orderActive.length; i += 1) {
    if (book.orderActive[i]) count += 1;
  }
  return count;
};

const snapshotBookOrder = (book: BookState, pairId: string, orderId: string, idx: number): ActualBookOrder | null => {
  if (idx < 0 || idx >= book.orderActive.length || !book.orderActive[idx]) return null;
  const ownerIdx = book.orderOwnerIdx[idx]!;
  const ownerId = book.owners[ownerIdx];
  if (!ownerId) return null;
  const priceIdx = book.orderPriceIdx[idx]!;
  if (priceIdx < 0 || priceIdx >= book.levels) return null;
  const side = book.orderSide[idx]!;
  if (side !== 0 && side !== 1) return null;
  const parsed = parseNamespacedOrderId(orderId);
  return {
    swapKey: parsed?.swapKey ?? null,
    pairId,
    orderId,
    ownerId,
    side,
    priceTicks: book.params.pmin + (BigInt(priceIdx) * book.params.tick),
    qtyLots: BigInt(book.orderQtyLots[idx]!),
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
  if (priceTicks <= 0n || priceTicks > MAX_QTY_LOTS) return { invalid: { swapKey: key, reason: 'invalid-price' } };

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
    for (const [orderId, idx] of book.orderIdToIdx.entries()) {
      const snapshot = snapshotBookOrder(book, pairId, orderId, idx);
      if (!snapshot) continue;
      actual.set(snapshot.swapKey ?? `orphan:${pairId}:${orderId}`, snapshot);
    }
  }
  return actual;
};

export function validateBookStructure(book: BookState): BookStructureReport {
  const errors: string[] = [];
  const reachable = new Set<number>();
  const queueSeen = new Set<number>();
  const maxOrders = book.orderActive.length;
  const arrayLengths = [
    book.orderPriceIdx.length,
    book.orderQtyLots.length,
    book.orderOwnerIdx.length,
    book.orderSide.length,
    book.orderPrev.length,
    book.orderNext.length,
  ];

  if (new Set(arrayLengths).size !== 1) {
    errors.push(`order arrays length mismatch: ${arrayLengths.join('/')}`);
  }

  const visitQueue = (head: number, tail: number, side: 0 | 1, levelIdx: number, label: 'bid' | 'ask') => {
    let current = head;
    let prev = EMPTY;
    let last = EMPTY;
    const local = new Set<number>();
    while (current !== EMPTY) {
      if (current < 0 || current >= maxOrders) {
        errors.push(`${label} level ${levelIdx}: order idx ${current} out of bounds`);
        break;
      }
      if (local.has(current)) {
        errors.push(`${label} level ${levelIdx}: cycle at order idx ${current}`);
        break;
      }
      local.add(current);
      queueSeen.add(current);

      if (!book.orderActive[current]) errors.push(`${label} level ${levelIdx}: inactive order idx ${current} in queue`);
      if (book.orderSide[current] !== side) errors.push(`${label} level ${levelIdx}: side mismatch for idx ${current}`);
      if (book.orderPriceIdx[current] !== levelIdx) errors.push(`${label} level ${levelIdx}: price idx mismatch for idx ${current}`);
      if (book.orderPrev[current] !== prev) errors.push(`${label} level ${levelIdx}: prev pointer mismatch for idx ${current}`);

      reachable.add(current);
      last = current;
      prev = current;
      current = book.orderNext[current]!;
    }
    if (head === EMPTY && tail !== EMPTY) errors.push(`${label} level ${levelIdx}: tail without head`);
    if (head !== EMPTY && last !== tail) errors.push(`${label} level ${levelIdx}: tail mismatch expected=${tail} actual=${last}`);
  };

  for (let levelIdx = 0; levelIdx < book.levels; levelIdx += 1) {
    visitQueue(book.levelHeadBid[levelIdx]!, book.levelTailBid[levelIdx]!, 0, levelIdx, 'bid');
    visitQueue(book.levelHeadAsk[levelIdx]!, book.levelTailAsk[levelIdx]!, 1, levelIdx, 'ask');
  }

  for (const [orderId, idx] of book.orderIdToIdx.entries()) {
    if (idx < 0 || idx >= maxOrders) {
      errors.push(`orderIdToIdx out of bounds: ${orderId} -> ${idx}`);
      continue;
    }
    if (!book.orderActive[idx]) errors.push(`orderIdToIdx points to inactive slot: ${orderId} -> ${idx}`);
    if (book.orderIds[idx] !== orderId) errors.push(`orderIds mismatch at idx ${idx}: map=${orderId} slot=${book.orderIds[idx] ?? '<missing>'}`);
  }

  for (let idx = 0; idx < maxOrders; idx += 1) {
    if (!book.orderActive[idx]) continue;
    if (!book.orderIds[idx]) errors.push(`active slot ${idx} missing orderId`);
    if (!book.orderIdToIdx.has(book.orderIds[idx]!)) errors.push(`active slot ${idx} not present in orderIdToIdx`);
    if (book.orderOwnerIdx[idx]! >= book.owners.length) errors.push(`active slot ${idx} ownerIdx out of bounds`);
    if (book.orderPriceIdx[idx]! < 0 || book.orderPriceIdx[idx]! >= book.levels) errors.push(`active slot ${idx} priceIdx out of bounds`);
    if (book.orderSide[idx] !== 0 && book.orderSide[idx] !== 1) errors.push(`active slot ${idx} has invalid side ${book.orderSide[idx]}`);
    if (!queueSeen.has(idx)) errors.push(`active slot ${idx} is not reachable from any level queue`);
  }

  const hasBidLevels = book.levelHeadBid.some((idx) => idx !== EMPTY);
  const hasAskLevels = book.levelHeadAsk.some((idx) => idx !== EMPTY);
  if ((book.bestBidIdx === EMPTY) !== !hasBidLevels) errors.push(`bestBidIdx mismatch: ${book.bestBidIdx}`);
  if ((book.bestAskIdx === EMPTY) !== !hasAskLevels) errors.push(`bestAskIdx mismatch: ${book.bestAskIdx}`);

  return {
    ok: errors.length === 0,
    errors,
    stats: {
      activeOrders: activeOrderCount(book),
      indexedOrders: book.orderIdToIdx.size,
      reachableOrders: reachable.size,
      levels: book.levels,
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
