import { buildPersistentBookOrderMap } from '../../orderbook/book-overlay';
import { computeBookCommitmentHash, verifyAndWarmBookCommitment } from '../../orderbook/commitment';
import type { BookOrderState, BookState, Side } from '../../orderbook/core';
import {
  decodeBookPricePage,
  type BookPricePageTree,
} from '../../orderbook/pages/page';
import {
  decodeBookPricePageKey,
  encodeBookPricePageKey,
} from '../../orderbook/pages/key';
import {
  type PersistentRadixBranchRecord,
  type PersistentRadixNodeRecord,
} from '../../protocol/state/persistent-radix-value-map';
import { radixMerklePathSlots } from '../../protocol/state/radix-merkle';
import { encodeBuffer } from '../codec/codec';
import {
  keyLiveBookBranch,
  keyLiveBookLeaf,
  keyLiveBookTreePrefix,
  KEY_LIVE_BOOK_BRANCH,
  KEY_LIVE_BOOK_LEAF,
  parseLiveBookBranchKey,
  parseLiveBookLeafKey,
} from '../keys';

export const MAX_STORAGE_RECORD_BYTES = 10_000;

export type StorageBookHeader = Readonly<{
  params: BookState['params'];
  bidRootHash: string;
  bidLeafCount: number;
  askRootHash: string;
  askLeafCount: number;
  nextSeq: number;
  tradeCount: number;
  tradeQtySum: bigint;
  lastTradePriceTicks: bigint;
  lastAcceptedUsdAskPriceTicks: bigint;
  eventHash: bigint;
  commitmentHash: string;
}>;

export type StorageBookGraphRow = Readonly<{ key: Buffer; value: Buffer }>;
export type StorageBookGraphChanges = Readonly<{
  puts: readonly StorageBookGraphRow[];
  dels: readonly Buffer[];
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const exactKeys = (record: Record<string, unknown>, expected: readonly string[], code: string): void => {
  const actual = Object.keys(record).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new Error(`${code}_FIELDS:${actual.join(',')}`);
  }
};

const integer = (value: unknown, code: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(code);
  return Number(value);
};

const bigintValue = (value: unknown, code: string): bigint => {
  if (typeof value !== 'bigint' || value < 0n) throw new Error(code);
  return value;
};

const hash = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value)) throw new Error(code);
  return value;
};

const checksum = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{32}$/.test(value)) throw new Error(code);
  return value;
};

const boundedRow = (key: Buffer, value: unknown): StorageBookGraphRow => {
  const encoded = encodeBuffer(value);
  if (encoded.byteLength >= MAX_STORAGE_RECORD_BYTES) {
    throw new Error(`STORAGE_RECORD_BYTES_EXCEEDED:${key.toString('hex')}:${encoded.byteLength}`);
  }
  return { key, value: encoded };
};

export const projectStorageBookHeader = (book: BookState): StorageBookHeader => ({
  params: Object.freeze({ ...book.params }),
  bidRootHash: book.bidPages.rootHash(),
  bidLeafCount: book.bidPages.size,
  askRootHash: book.askPages.rootHash(),
  askLeafCount: book.askPages.size,
  nextSeq: book.nextSeq,
  tradeCount: book.tradeCount,
  tradeQtySum: book.tradeQtySum,
  lastTradePriceTicks: book.lastTradePriceTicks,
  lastAcceptedUsdAskPriceTicks: book.lastAcceptedUsdAskPriceTicks,
  eventHash: book.eventHash,
  commitmentHash: computeBookCommitmentHash(book),
});

const branchValue = (record: PersistentRadixBranchRecord) => ({
  children: record.children,
});

function* treeRows(
  entityId: string,
  pairId: string,
  side: Side,
  tree: BookPricePageTree,
): Generator<StorageBookGraphRow> {
  for (const record of tree.nodeRecords()) {
    yield record.kind === 'branch'
      ? boundedRow(keyLiveBookBranch(entityId, pairId, side, record.path), branchValue(record))
      : boundedRow(keyLiveBookLeaf(entityId, pairId, side, record.keyBytes), record.value);
  }
}

/** Cold snapshot stream of the exact RAM graph; ordinary frames persist only dirty paths. */
export function* projectStorageBookGraphRows(
  entityId: string,
  pairId: string,
  book: BookState,
): Generator<StorageBookGraphRow> {
  yield* treeRows(entityId, pairId, 0, book.bidPages);
  yield* treeRows(entityId, pairId, 1, book.askPages);
}

function* treeKeys(
  entityId: string,
  pairId: string,
  side: Side,
  tree: BookPricePageTree,
): Generator<Buffer> {
  for (const record of tree.nodeRecords()) {
    yield record.kind === 'branch'
      ? keyLiveBookBranch(entityId, pairId, side, record.path)
      : keyLiveBookLeaf(entityId, pairId, side, record.keyBytes);
  }
}

export function* projectStorageBookGraphKeys(
  entityId: string,
  pairId: string,
  book: BookState,
): Generator<Buffer> {
  yield* treeKeys(entityId, pairId, 0, book.bidPages);
  yield* treeKeys(entityId, pairId, 1, book.askPages);
}

const appendTreeChanges = (
  output: { puts: StorageBookGraphRow[]; dels: Buffer[] },
  entityId: string,
  pairId: string,
  side: Side,
  next: BookPricePageTree,
  previous: BookPricePageTree,
): void => {
  const changes = next.nodeChangesSince(previous);
  for (const record of changes.puts) {
    output.puts.push(record.kind === 'branch'
      ? boundedRow(keyLiveBookBranch(entityId, pairId, side, record.path), branchValue(record))
      : boundedRow(keyLiveBookLeaf(entityId, pairId, side, record.keyBytes), record.value));
  }
  for (const record of changes.dels) {
    output.dels.push(record.kind === 'branch'
      ? keyLiveBookBranch(entityId, pairId, side, record.path)
      : keyLiveBookLeaf(entityId, pairId, side, record.keyBytes));
  }
};

/** One committed Book transition becomes only changed leaves and parent paths. */
export const projectStorageBookGraphChanges = (
  entityId: string,
  pairId: string,
  next: BookState,
  previous: BookState,
): StorageBookGraphChanges => {
  const output = { puts: [] as StorageBookGraphRow[], dels: [] as Buffer[] };
  appendTreeChanges(output, entityId, pairId, 0, next.bidPages, previous.bidPages);
  appendTreeChanges(output, entityId, pairId, 1, next.askPages, previous.askPages);
  return output;
};

const decodeChild = (value: unknown, code: string) => {
  if (!isRecord(value)) throw new Error(`${code}_INVALID`);
  exactKeys(value, ['slot', 'kind', 'path', 'edgeHash'], `${code}`);
  const slot = integer(value['slot'], `${code}_SLOT`);
  if (slot > 15) throw new Error(`${code}_SLOT`);
  const kind = value['kind'];
  if (kind !== 'branch' && kind !== 'leaf') throw new Error(`${code}_KIND`);
  if (!Array.isArray(value['path'])) throw new Error(`${code}_PATH`);
  const path = value['path'].map((item, index) => {
    const decoded = integer(item, `${code}_PATH_${index}`);
    if (decoded > 15) throw new Error(`${code}_PATH_${index}`);
    return decoded;
  });
  return { slot, kind, path, edgeHash: hash(value['edgeHash'], `${code}_EDGE_HASH`) } as const;
};

export const decodeStorageBookBranch = (
  value: unknown,
  path: readonly number[],
): PersistentRadixBranchRecord => {
  const code = 'STORAGE_BOOK_BRANCH_INVALID';
  if (!isRecord(value)) throw new Error(code);
  exactKeys(value, ['children'], code);
  if (!Array.isArray(value['children'])) throw new Error(`${code}_CHILDREN`);
  const children = value['children'].map((child, index) => decodeChild(child, `${code}_${index}`));
  return { kind: 'branch', path: [...path], children };
};

export const decodeStorageBookHeader = (value: unknown): StorageBookHeader => {
  const code = 'STORAGE_BOOK_HEADER_INVALID';
  if (!isRecord(value)) throw new Error(code);
  exactKeys(value, [
    'params', 'bidRootHash', 'bidLeafCount', 'askRootHash', 'askLeafCount', 'nextSeq',
    'tradeCount', 'tradeQtySum', 'lastTradePriceTicks', 'lastAcceptedUsdAskPriceTicks',
    'eventHash', 'commitmentHash',
  ], code);
  const params = value['params'];
  if (!isRecord(params)) throw new Error(`${code}_PARAMS`);
  exactKeys(params, ['bucketWidthTicks', 'maxOrders', 'stpPolicy'], `${code}_PARAMS`);
  const stpPolicy = params['stpPolicy'];
  if (stpPolicy !== 0 && stpPolicy !== 1) throw new Error(`${code}_STP_POLICY`);
  return {
    params: {
      bucketWidthTicks: bigintValue(params['bucketWidthTicks'], `${code}_BUCKET_WIDTH`),
      maxOrders: integer(params['maxOrders'], `${code}_MAX_ORDERS`),
      stpPolicy,
    },
    bidRootHash: hash(value['bidRootHash'], `${code}_BID_ROOT`),
    bidLeafCount: integer(value['bidLeafCount'], `${code}_BID_COUNT`),
    askRootHash: hash(value['askRootHash'], `${code}_ASK_ROOT`),
    askLeafCount: integer(value['askLeafCount'], `${code}_ASK_COUNT`),
    nextSeq: integer(value['nextSeq'], `${code}_NEXT_SEQ`),
    tradeCount: integer(value['tradeCount'], `${code}_TRADE_COUNT`),
    tradeQtySum: bigintValue(value['tradeQtySum'], `${code}_TRADE_QTY`),
    lastTradePriceTicks: bigintValue(value['lastTradePriceTicks'], `${code}_LAST_TRADE_PRICE`),
    lastAcceptedUsdAskPriceTicks: bigintValue(value['lastAcceptedUsdAskPriceTicks'], `${code}_LAST_USD_ASK`),
    eventHash: bigintValue(value['eventHash'], `${code}_EVENT_HASH`),
    commitmentHash: checksum(value['commitmentHash'], `${code}_COMMITMENT`),
  };
};

const collectLocators = (side: Side, tree: BookPricePageTree): BookOrderState[] => {
  const orders: BookOrderState[] = [];
  for (const [key, page] of tree) for (let slot = page.headSlot; slot < page.nextSlot; slot += 1) {
    const entry = page.slots[slot];
    if (entry) orders.push({ ...entry, side, priceTicks: key.priceTicks, pageSequence: key.pageSequence, pageSlot: slot });
  }
  return orders;
};

export const hydrateStorageBook = (
  header: StorageBookHeader,
  bidPages: BookPricePageTree,
  askPages: BookPricePageTree,
): BookState => {
  if (bidPages.rootHash() !== header.bidRootHash || bidPages.size !== header.bidLeafCount) {
    throw new Error('STORAGE_BOOK_BID_ROOT_MISMATCH');
  }
  if (askPages.rootHash() !== header.askRootHash || askPages.size !== header.askLeafCount) {
    throw new Error('STORAGE_BOOK_ASK_ROOT_MISMATCH');
  }
  const locators = [...collectLocators(0, bidPages), ...collectLocators(1, askPages)];
  const book: BookState = {
    params: header.params,
    orders: buildPersistentBookOrderMap(locators.map(order => [order.orderId, order] as const)),
    bidPages,
    askPages,
    nextSeq: header.nextSeq,
    tradeCount: header.tradeCount,
    tradeQtySum: header.tradeQtySum,
    lastTradePriceTicks: header.lastTradePriceTicks,
    lastAcceptedUsdAskPriceTicks: header.lastAcceptedUsdAskPriceTicks,
    eventHash: header.eventHash,
    commitmentHash: header.commitmentHash,
  };
  verifyAndWarmBookCommitment(book, 'STORAGE_BOOK_COMMITMENT');
  return book;
};

export const bookTreePrefixes = (entityId: string, pairId: string, side: Side) => ({
  branches: keyLiveBookTreePrefix(KEY_LIVE_BOOK_BRANCH, entityId, pairId, side),
  leaves: keyLiveBookTreePrefix(KEY_LIVE_BOOK_LEAF, entityId, pairId, side),
});

export const branchRecordFromStorage = (key: Buffer, value: unknown): PersistentRadixBranchRecord => {
  const parsed = parseLiveBookBranchKey(key);
  return decodeStorageBookBranch(value, parsed.path);
};

export const leafRecordFromStorage = (key: Buffer, value: unknown): PersistentRadixNodeRecord<ReturnType<typeof decodeBookPricePageKey>, ReturnType<typeof decodeBookPricePage>> => {
  const parsed = parseLiveBookLeafKey(key);
  const pageKey = decodeBookPricePageKey(parsed.payload);
  return {
    kind: 'leaf',
    path: radixMerklePathSlots(encodeBookPricePageKey(pageKey), 16),
    key: pageKey,
    keyBytes: Uint8Array.from(parsed.payload),
    value: decodeBookPricePage(value),
  };
};
