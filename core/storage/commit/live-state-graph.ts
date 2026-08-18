/**
 * Plans the physical live-state graph without inventing a second Merkle tree.
 * Account manifests own their typed child roots; Book headers own page roots;
 * Entity documents remain the bounded parent projection committed by the WAL.
 * Human-audit importance: 100/100 — these rows are the recovery checkpoint.
 */
import { encodeBuffer } from '../codec/codec';
import { prepareAccountStorageDelete, prepareAccountStorageLayout } from '../schema/account-layout';
import { liveKeyForDoc, liveKeyForRef } from '../schema/doc-refs';
import type {
  RuntimeDbLike,
  StorageAccountDoc,
  StorageDoc,
  StorageDocRef,
} from '../types';

export type PreparedLiveStateGraph = Readonly<{
  puts: readonly Readonly<{ key: Buffer; value: Buffer }>[];
  dels: readonly Buffer[];
  accountCachePuts: readonly (readonly [string, StorageAccountDoc])[];
  accountCacheDels: readonly string[];
}>;

const accountCacheKey = (entityId: string, counterpartyId: string): string =>
  `${entityId.trim().toLowerCase()}\u0000${counterpartyId.trim().toLowerCase()}`;

/**
 * One materialization writes exactly the direct typed rows selected by the
 * accumulated overlay. Book rows are planned by `prepareStorageBookGraphWrite`
 * because its header and Patricia pages must enter the same outer WAL batch.
 */
export const prepareLiveStateGraph = async (options: {
  db: RuntimeDbLike;
  puts: readonly StorageDoc[];
  dels: readonly StorageDocRef[];
  previousAccounts?: ReadonlyMap<string, StorageAccountDoc>;
}): Promise<PreparedLiveStateGraph> => {
  const effectivePuts = new Map<string, StorageDoc>();
  for (const doc of options.puts) {
    effectivePuts.set(liveKeyForDoc(doc).toString('hex'), doc);
  }
  const effectiveDels = new Map<string, StorageDocRef>();
  for (const ref of options.dels) {
    const key = liveKeyForRef(ref).toString('hex');
    effectivePuts.delete(key);
    effectiveDels.set(key, ref);
  }

  const puts: Array<{ key: Buffer; value: Buffer }> = [];
  const dels: Buffer[] = [];
  const accountCachePuts: Array<readonly [string, StorageAccountDoc]> = [];
  const accountCacheDels: string[] = [];

  for (const doc of effectivePuts.values()) {
    if (doc.family === 'book') continue;
    if (doc.family === 'entity') {
      puts.push({ key: liveKeyForDoc(doc), value: encodeBuffer(doc.value) });
      continue;
    }
    const cacheKey = accountCacheKey(doc.entityId, doc.counterpartyId);
    const layout = await prepareAccountStorageLayout(
      options.db,
      doc.entityId,
      doc.counterpartyId,
      liveKeyForDoc(doc),
      doc.value,
      options.previousAccounts?.get(cacheKey),
    );
    puts.push(...layout.puts);
    dels.push(...layout.dels);
    accountCachePuts.push([cacheKey, doc.value]);
  }

  for (const ref of effectiveDels.values()) {
    if (ref.family === 'book') continue;
    if (ref.family === 'entity') {
      dels.push(liveKeyForRef(ref));
      continue;
    }
    const cacheKey = accountCacheKey(ref.entityId, ref.counterpartyId);
    accountCacheDels.push(cacheKey);
    dels.push(...await prepareAccountStorageDelete(
      options.db,
      ref.entityId,
      ref.counterpartyId,
      liveKeyForRef(ref),
    ));
  }

  return { puts, dels, accountCachePuts, accountCacheDels };
};
