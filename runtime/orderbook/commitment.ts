import type {
  BookOrderState,
  BookState,
  PriceBucketState,
  PriceLevelState,
  Side,
} from './core';
import {
  computeIntegrityChecksum,
  integrityChecksumFromHex,
} from '../infra/integrity-checksum';

const UTF8 = new TextEncoder();

const u32 = (value: number): Uint8Array => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`ORDERBOOK_COMMITMENT_U32_INVALID:${String(value)}`);
  }
  return Uint8Array.of(value >>> 24, value >>> 16, value >>> 8, value);
};

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
};

const text = (value: string): Uint8Array => UTF8.encode(value);
const bigint = (value: bigint): Uint8Array => text(value.toString());
const number = (value: number): Uint8Array => {
  if (!Number.isSafeInteger(value)) throw new Error(`ORDERBOOK_COMMITMENT_NUMBER_INVALID:${String(value)}`);
  return text(String(value));
};

const hashParts = (domain: string, parts: readonly Uint8Array[]): string => {
  const framed = [text(domain), ...parts].map((part) => concat([u32(part.byteLength), part]));
  return computeIntegrityChecksum(concat(framed));
};

const computeOrderHash = (order: BookOrderState): string => {
  if (order.commitmentHash) return order.commitmentHash;
  order.commitmentHash = hashParts('xln.orderbook.order', [
    text(order.orderId),
    text(order.ownerId),
    number(order.side),
    bigint(order.priceTicks),
    bigint(order.qtyLots),
    number(order.seq),
    bigint(order.bucketId),
  ]);
  return order.commitmentHash;
};

const computeLevelHash = (book: BookState, level: PriceLevelState): string => {
  if (level.commitmentHash) return level.commitmentHash;
  const orders = level.orderIds.map((orderId) => {
    const order = book.orders.get(orderId);
    if (!order) throw new Error(`ORDERBOOK_COMMITMENT_ORDER_MISSING:${orderId}`);
    return integrityChecksumFromHex(computeOrderHash(order));
  });
  level.commitmentHash = hashParts('xln.orderbook.level', [
    bigint(level.priceTicks),
    bigint(level.totalQtyLots),
    u32(level.orderIds.length),
    ...orders,
  ]);
  return level.commitmentHash;
};

const computeBucketHash = (book: BookState, bucket: PriceBucketState): string => {
  if (bucket.commitmentHash) return bucket.commitmentHash;
  const levels = bucket.pricesAsc.map((priceTicks) => {
    const level = bucket.levels.get(priceTicks.toString());
    if (!level) throw new Error(`ORDERBOOK_COMMITMENT_LEVEL_MISSING:${priceTicks.toString()}`);
    return integrityChecksumFromHex(computeLevelHash(book, level));
  });
  bucket.commitmentHash = hashParts('xln.orderbook.bucket', [
    bigint(bucket.bucketId),
    u32(bucket.pricesAsc.length),
    ...levels,
  ]);
  return bucket.commitmentHash;
};

const computeSideHash = (book: BookState, side: Side): string => {
  const bucketIds = side === 0 ? book.bidBucketIdsDesc : book.askBucketIdsAsc;
  const buckets = side === 0 ? book.bidBuckets : book.askBuckets;
  const hashes = bucketIds.map((bucketId) => {
    const bucket = buckets.get(bucketId.toString());
    if (!bucket) throw new Error(`ORDERBOOK_COMMITMENT_BUCKET_MISSING:${bucketId.toString()}`);
    return integrityChecksumFromHex(computeBucketHash(book, bucket));
  });
  return hashParts('xln.orderbook.side', [number(side), u32(bucketIds.length), ...hashes]);
};

export const computeBookCommitmentHash = (book: BookState): string => {
  if (book.commitmentHash) return book.commitmentHash;
  book.commitmentHash = hashParts('xln.orderbook.book', [
    bigint(book.params.bucketWidthTicks),
    number(book.params.maxOrders),
    number(book.params.stpPolicy),
    integrityChecksumFromHex(computeSideHash(book, 0)),
    integrityChecksumFromHex(computeSideHash(book, 1)),
    number(book.nextSeq),
    number(book.tradeCount),
    bigint(book.tradeQtySum),
    bigint(book.eventHash),
  ]);
  return book.commitmentHash;
};

export const invalidateBookCommitment = (book: BookState): void => {
  delete book.commitmentHash;
};

export const invalidateBookLevelCommitment = (
  book: BookState,
  side: Side,
  bucketId: bigint,
  priceTicks: bigint,
): void => {
  const bucket = (side === 0 ? book.bidBuckets : book.askBuckets).get(bucketId.toString());
  const level = bucket?.levels.get(priceTicks.toString());
  if (level) delete level.commitmentHash;
  if (bucket) delete bucket.commitmentHash;
  delete book.commitmentHash;
};

export const invalidateBookOrderCommitment = (book: BookState, orderId: string): void => {
  const order = book.orders.get(orderId);
  if (!order) {
    delete book.commitmentHash;
    return;
  }
  delete order.commitmentHash;
  invalidateBookLevelCommitment(book, order.side, order.bucketId, order.priceTicks);
};

export const clearBookCommitmentCache = (book: BookState): void => {
  delete book.commitmentHash;
  for (const order of book.orders.values()) delete order.commitmentHash;
  for (const bucket of [...book.bidBuckets.values(), ...book.askBuckets.values()]) {
    delete bucket.commitmentHash;
    for (const level of bucket.levels.values()) delete level.commitmentHash;
  }
};

export const verifyAndWarmBookCommitment = (book: BookState, code = 'ORDERBOOK_COMMITMENT'): string => {
  const claimedRoot = book.commitmentHash;
  clearBookCommitmentCache(book);
  const rebuiltRoot = computeBookCommitmentHash(book);
  if (claimedRoot !== undefined && claimedRoot !== rebuiltRoot) {
    throw new Error(`${code}_MISMATCH:claimed=${claimedRoot}:rebuilt=${rebuiltRoot}`);
  }
  return rebuiltRoot;
};
