import type { BookState, Side } from '../../orderbook/core';
import { hydrateBookPricePageTree } from '../../orderbook/pages/page';
import type { PersistentRadixNodeRecord } from '../../protocol/state/persistent-radix-value-map';
import { decodeValidatedBuffer } from '../codec/codec';
import {
  bookTreePrefixes,
  branchRecordFromStorage,
  decodeStorageBookHeader,
  hydrateStorageBook,
  leafRecordFromStorage,
} from '../schema/book-graph-codec';
import {
  keyLiveBook,
  keySnapshotBook,
  keySnapshotGraphPrefix,
  parseSnapshotGraphKey,
} from '../keys';
import { iterateKeys, readValidatedOrNull } from '../database/level';
import type { RuntimeDbLike } from '../types';
import type { BookPricePage, BookPricePageTree } from '../../orderbook/pages/page';
import type { BookPricePageKey } from '../../orderbook/pages/key';

type PageNodeRecord = PersistentRadixNodeRecord<BookPricePageKey, BookPricePage>;

const readSide = async (
  db: RuntimeDbLike,
  entityId: string,
  pairId: string,
  side: Side,
  snapshotHeight?: number,
): Promise<BookPricePageTree> => {
  const prefixes = bookTreePrefixes(entityId, pairId, side);
  const branchPrefix = snapshotHeight === undefined
    ? prefixes.branches
    : keySnapshotGraphPrefix(snapshotHeight, prefixes.branches);
  const leafPrefix = snapshotHeight === undefined
    ? prefixes.leaves
    : keySnapshotGraphPrefix(snapshotHeight, prefixes.leaves);
  const liveKey = (key: Buffer): Buffer => snapshotHeight === undefined
    ? key
    : parseSnapshotGraphKey(key).liveKey;
  const records: PageNodeRecord[] = [];
  for await (const key of iterateKeys(db, { prefix: branchPrefix })) {
    records.push(branchRecordFromStorage(
      liveKey(key),
      decodeValidatedBuffer(await db.get(key), value => value),
    ));
  }
  for await (const key of iterateKeys(db, { prefix: leafPrefix })) {
    records.push(leafRecordFromStorage(
      liveKey(key),
      decodeValidatedBuffer(await db.get(key), value => value),
    ));
  }
  return hydrateBookPricePageTree(records);
};

const readGraph = async (
  db: RuntimeDbLike,
  entityId: string,
  pairId: string,
  headerKey: Buffer,
  snapshotHeight?: number,
): Promise<BookState | null> => {
  const header = await readValidatedOrNull(db, headerKey, decodeStorageBookHeader);
  if (!header) return null;
  const [bidPages, askPages] = await Promise.all([
    readSide(db, entityId, pairId, 0, snapshotHeight),
    readSide(db, entityId, pairId, 1, snapshotHeight),
  ]);
  return hydrateStorageBook(header, bidPages, askPages);
};

/** Cold load follows the same bounded rows stored by the live Patricia graph. */
export const readStorageBookGraph = async (
  db: RuntimeDbLike,
  entityId: string,
  pairId: string,
): Promise<BookState | null> => {
  return readGraph(db, entityId, pairId, keyLiveBook(entityId, pairId));
};

export const readSnapshotBookGraph = (
  db: RuntimeDbLike,
  height: number,
  entityId: string,
  pairId: string,
): Promise<BookState | null> => readGraph(
  db,
  entityId,
  pairId,
  keySnapshotBook(height, entityId, pairId),
  height,
);
