import type { BookState } from '../../orderbook/core';
import { encodeBuffer } from '../codec/codec';
import { keyLiveBook } from '../keys';
import { readStorageBookGraph } from '../read/book-graph';
import {
  MAX_STORAGE_RECORD_BYTES,
  projectStorageBookGraphChanges,
  projectStorageBookGraphKeys,
  projectStorageBookGraphRows,
  projectStorageBookHeader,
  type StorageBookGraphRow,
} from '../schema/book-graph-codec';
import type { RuntimeDbLike } from '../types';

export type StorageBookGraphWrite = Readonly<{
  puts: readonly StorageBookGraphRow[];
  dels: readonly Buffer[];
  committedBook: BookState | null;
}>;

const headerRow = (entityId: string, pairId: string, book: BookState): StorageBookGraphRow => {
  const key = keyLiveBook(entityId, pairId);
  const value = encodeBuffer(projectStorageBookHeader(book));
  if (value.byteLength >= MAX_STORAGE_RECORD_BYTES) {
    throw new Error(`STORAGE_RECORD_BYTES_EXCEEDED:${key.toString('hex')}:${value.byteLength}`);
  }
  return { key, value };
};

/**
 * Storage compares consecutive sealed RAM roots. The previous root is loaded
 * only after process restart; ordinary frames retain it by identity and write
 * one leaf plus its Patricia parent path.
 */
export const prepareStorageBookGraphWrite = async (options: {
  db: RuntimeDbLike;
  entityId: string;
  pairId: string;
  next: BookState | null;
  previous?: BookState;
}): Promise<StorageBookGraphWrite> => {
  const previous = options.previous ?? await readStorageBookGraph(
    options.db,
    options.entityId,
    options.pairId,
  ) ?? undefined;
  if (!options.next) {
    return {
      puts: [],
      dels: previous
        ? [keyLiveBook(options.entityId, options.pairId), ...projectStorageBookGraphKeys(options.entityId, options.pairId, previous)]
        : [],
      committedBook: null,
    };
  }
  const graph = previous
    ? projectStorageBookGraphChanges(options.entityId, options.pairId, options.next, previous)
    : { puts: [...projectStorageBookGraphRows(options.entityId, options.pairId, options.next)], dels: [] };
  return {
    puts: [headerRow(options.entityId, options.pairId, options.next), ...graph.puts],
    dels: graph.dels,
    committedBook: options.next,
  };
};
