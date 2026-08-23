import { haltRuntimeFailure } from "../protocol/errors/failure-taxonomy";

import type { BookState } from './core';
import {
  computeIntegrityChecksum,
} from '../support/bytes/integrity-checksum';

const UTF8 = new TextEncoder();

const u32 = (value: number): Uint8Array => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw haltRuntimeFailure("ORDERBOOK_COMMITMENT_U32_INVALID", `ORDERBOOK_COMMITMENT_U32_INVALID:${String(value)}`);
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
  if (!Number.isSafeInteger(value)) throw haltRuntimeFailure("ORDERBOOK_COMMITMENT_NUMBER_INVALID", `ORDERBOOK_COMMITMENT_NUMBER_INVALID:${String(value)}`);
  return text(String(value));
};

const hashParts = (domain: string, parts: readonly Uint8Array[]): string => {
  const framed = [text(domain), ...parts].map((part) => concat([u32(part.byteLength), part]));
  return computeIntegrityChecksum(concat(framed));
};

export const computeBookCommitmentHash = (book: BookState): string => {
  if (book.commitmentHash) return book.commitmentHash;
  // Price pages are the sole canonical liquidity. The order-id locator is a
  // RAM projection and must never be hashed or persisted a second time.
  book.commitmentHash = hashParts('xln.orderbook.book', [
    bigint(book.params.bucketWidthTicks),
    number(book.params.maxOrders),
    number(book.params.stpPolicy),
    text(book.bidPages.rootHash()),
    text(book.askPages.rootHash()),
    number(book.nextSeq),
    number(book.tradeCount),
    bigint(book.tradeQtySum),
    bigint(book.lastTradePriceTicks),
    // The cross-j USD admission guard consumes this authority-only field, so
    // it is consensus state and must be covered by the incremental book root.
    bigint(book.lastAcceptedUsdAskPriceTicks),
    bigint(book.eventHash),
  ]);
  return book.commitmentHash;
};

export const invalidateBookCommitment = (book: BookState): void => {
  delete book.commitmentHash;
};

export const clearBookCommitmentCache = (book: BookState): void => {
  delete book.commitmentHash;
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
