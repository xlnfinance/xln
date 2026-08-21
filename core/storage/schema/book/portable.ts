import type { BookState } from '../../../orderbook';
import { hydrateBookPricePageTree } from '../../../orderbook/pages/page';
import {
  branchRecordFromStorage,
  decodeStorageBookHeader,
  hydrateStorageBook,
  leafRecordFromStorage,
  MAX_STORAGE_RECORD_BYTES,
  projectStorageBookGraphRows,
  projectStorageBookHeader,
} from '../book-graph-codec';
import { decodeValidatedBuffer } from '../../codec/codec';
import {
  KEY_LIVE_BOOK_BRANCH,
  KEY_LIVE_BOOK_LEAF,
  parseLiveBookBranchKey,
  parseLiveBookLeafKey,
} from '../../keys';
import {
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../schema-primitives';

/**
 * Portable recovery aggregates the exact bounded LevelDB rows; it does not
 * invent a flat Book encoding. Every physical graph value remains <10 KiB,
 * and the order locator is derived from page leaves after hydration.
 */
export const projectPortableBook = (
  entityId: string,
  pairId: string,
  book: BookState,
): Record<string, unknown> => ({
  header: projectStorageBookHeader(book),
  rows: Array.from(projectStorageBookGraphRows(entityId, pairId, book)),
});

const bytes = (value: unknown, code: string): Buffer => {
  if (!(value instanceof Uint8Array)) throw new Error(code);
  return Buffer.from(value);
};

const assertRowOwner = (
  owner: { entityId: string; pairId: string },
  entityId: string,
  pairId: string,
  code: string,
): void => {
  if (owner.entityId.toLowerCase() !== entityId.toLowerCase() || owner.pairId !== pairId) {
    throw new Error(`${code}_OWNER_MISMATCH`);
  }
};

/** Exact inverse of projectPortableBook; every root is recomputed and checked. */
export const decodePortableBook = (
  value: unknown,
  entityId: string,
  pairId: string,
  code: string,
): BookState => {
  const record = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(record, ['header', 'rows'], [], `${code}_FIELDS`);
  if (!Array.isArray(record['rows'])) throw new Error(`${code}_ROWS`);
  const records: [unknown[], unknown[]] = [[], []];
  const keys = new Set<string>();
  for (const [index, rawRow] of record['rows'].entries()) {
    const row = requireBoundaryRecord(rawRow, `${code}_ROW_${index}`);
    requireExactBoundaryKeys(row, ['key', 'value'], [], `${code}_ROW_${index}_FIELDS`);
    const key = bytes(row['key'], `${code}_ROW_${index}_KEY`);
    const encoded = bytes(row['value'], `${code}_ROW_${index}_VALUE`);
    if (encoded.byteLength >= MAX_STORAGE_RECORD_BYTES) {
      throw new Error(`${code}_ROW_${index}_BYTES:${encoded.byteLength}`);
    }
    const keyHex = key.toString('hex');
    if (keys.has(keyHex)) throw new Error(`${code}_ROW_${index}_DUPLICATE`);
    keys.add(keyHex);
    const decoded = decodeValidatedBuffer(encoded, candidate => candidate);
    if (key[0] === KEY_LIVE_BOOK_BRANCH) {
      const owner = parseLiveBookBranchKey(key);
      assertRowOwner(owner, entityId, pairId, `${code}_ROW_${index}`);
      records[owner.side].push(branchRecordFromStorage(key, decoded));
    } else if (key[0] === KEY_LIVE_BOOK_LEAF) {
      const owner = parseLiveBookLeafKey(key);
      assertRowOwner(owner, entityId, pairId, `${code}_ROW_${index}`);
      records[owner.side].push(leafRecordFromStorage(key, decoded));
    } else {
      throw new Error(`${code}_ROW_${index}_TAG`);
    }
  }
  return hydrateStorageBook(
    decodeStorageBookHeader(record['header']),
    hydrateBookPricePageTree(records[0] as Parameters<typeof hydrateBookPricePageTree>[0]),
    hydrateBookPricePageTree(records[1] as Parameters<typeof hydrateBookPricePageTree>[0]),
  );
};
