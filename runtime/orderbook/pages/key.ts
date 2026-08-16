export type BookPricePageKey = Readonly<{
  priceTicks: bigint;
  pageSequence: number;
}>;

export const MAX_BOOK_PRICE_KEY_BYTES = 255;
export const MAX_BOOK_PRICE_PAGE_SEQUENCE = 0xffff;

const minimalUnsignedBytes = (value: bigint): Uint8Array => {
  if (value <= 0n) throw new Error(`BOOK_PAGE_PRICE_INVALID:${value.toString()}`);
  const hex = value.toString(16);
  const normalized = hex.length % 2 === 0 ? hex : `0${hex}`;
  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  if (bytes.length > MAX_BOOK_PRICE_KEY_BYTES) {
    throw new Error(`BOOK_PAGE_PRICE_BYTES_EXCEEDED:${bytes.length}`);
  }
  return bytes;
};

const decodeUnsignedBytes = (bytes: Uint8Array): bigint => {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
};

/** Price-only prefix used for an exact Patricia subtree lookup. */
export const encodeBookPricePrefix = (priceTicks: bigint): Uint8Array => {
  const price = minimalUnsignedBytes(priceTicks);
  const encoded = new Uint8Array(1 + price.length);
  encoded[0] = price.length;
  encoded.set(price, 1);
  return encoded;
};

/** Numeric-order-preserving raw price prefix plus the owner-approved uint16 page. */
export const encodeBookPricePageKey = (key: BookPricePageKey): Uint8Array => {
  if (
    !Number.isSafeInteger(key.pageSequence) ||
    key.pageSequence < 0 ||
    key.pageSequence > MAX_BOOK_PRICE_PAGE_SEQUENCE
  ) throw new Error(`BOOK_PAGE_SEQUENCE_INVALID:${String(key.pageSequence)}`);
  const prefix = encodeBookPricePrefix(key.priceTicks);
  const encoded = new Uint8Array(prefix.length + 2);
  encoded.set(prefix, 0);
  encoded[encoded.length - 2] = key.pageSequence >>> 8;
  encoded[encoded.length - 1] = key.pageSequence & 0xff;
  return encoded;
};

/** Exact disk/network boundary decoder; non-minimal prices are rejected. */
export const decodeBookPricePageKey = (bytes: Uint8Array): BookPricePageKey => {
  const priceLength = bytes[0];
  if (priceLength === undefined || priceLength === 0) {
    throw new Error('BOOK_PAGE_KEY_PRICE_LENGTH_INVALID');
  }
  if (bytes.length !== 1 + priceLength + 2) {
    throw new Error(`BOOK_PAGE_KEY_LENGTH_INVALID:${bytes.length}`);
  }
  const priceBytes = bytes.subarray(1, 1 + priceLength);
  if (priceBytes[0] === 0) throw new Error('BOOK_PAGE_KEY_PRICE_NON_MINIMAL');
  const pageOffset = bytes.length - 2;
  return {
    priceTicks: decodeUnsignedBytes(priceBytes),
    pageSequence: (bytes[pageOffset]! << 8) | bytes[pageOffset + 1]!,
  };
};
