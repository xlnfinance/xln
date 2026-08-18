/**
 * Verifies the disposable live projection directly from its typed graphs.
 * Account manifests and Book headers commit their Patricia child roots; every
 * graph row must belong to one declared owner. No second document Merkle exists.
 * Human-audit importance: 100/100 — corrupt recovery bytes must fail closed.
 */
import { decodeValidatedBuffer } from '../codec/codec';
import { iterateKeys, readRawOrNull } from '../database/level';
import {
  KEY_LIVE_ACCOUNT_BRANCH,
  KEY_LIVE_ACCOUNT_LEAF,
  KEY_LIVE_ENTITY,
  KEY_LIVE_BOOK_BRANCH,
  KEY_LIVE_BOOK_LEAF,
  decodeEntityId,
  keyLiveAccount,
  keyLiveAccountPrefix,
  keyLiveBook,
  keyLiveBookPrefix,
  keyLiveEntity,
  parseLiveAccountBranchKey,
  parseLiveAccountKey,
  parseLiveAccountLeafKey,
  parseLiveBookBranchKey,
  parseLiveBookKey,
  parseLiveBookLeafKey,
} from '../keys';
import { readAccountStorageLayout } from '../schema/account-layout';
import {
  assertStorageAccountDocBinding,
  assertStorageEntityDocBinding,
  validateStorageAccountDocValue,
  validateStorageEntityCoreDocValue,
} from '../schema/authoritative-schema';
import type { RuntimeDbLike } from '../types';
import { readStorageBookGraph } from './book-graph';

const assertExactKey = (actual: Buffer, expected: Buffer, code: string): void => {
  if (!actual.equals(expected)) {
    throw new Error(`${code}:actual=${actual.toString('hex')}:expected=${expected.toString('hex')}`);
  }
};

const accountOwnerKey = (entityId: string, counterpartyId: string): string =>
  keyLiveAccount(entityId, counterpartyId).toString('hex');

const bookOwnerKey = (entityId: string, pairId: string): string =>
  keyLiveBook(entityId, pairId).toString('hex');

/** Verify all roots first, then reject every graph row without a typed root. */
export const verifyLiveStorageIntegrity = async (db: RuntimeDbLike): Promise<void> => {
  for await (const key of iterateKeys(db, { prefix: Buffer.from([KEY_LIVE_ENTITY]) })) {
    if (key.length !== 33) throw new Error(`STORAGE_LIVE_ENTITY_KEY_INVALID:${key.toString('hex')}`);
    const entityId = decodeEntityId(key.subarray(1));
    assertExactKey(key, keyLiveEntity(entityId), 'STORAGE_LIVE_ENTITY_KEY_MISMATCH');
    assertStorageEntityDocBinding(
      decodeValidatedBuffer(await db.get(key), validateStorageEntityCoreDocValue),
      entityId,
      'startup-integrity',
    );
  }

  const accountOwners = new Set<string>();
  for await (const key of iterateKeys(db, { prefix: keyLiveAccountPrefix() })) {
    const parsed = parseLiveAccountKey(key);
    assertExactKey(key, keyLiveAccount(parsed.entityId, parsed.counterpartyId), 'STORAGE_LIVE_ACCOUNT_KEY_MISMATCH');
    const stored = await readAccountStorageLayout(db, parsed.entityId, parsed.counterpartyId, key);
    if (!stored) throw new Error(`STORAGE_LIVE_ACCOUNT_MISSING:${key.toString('hex')}`);
    assertStorageAccountDocBinding(
      validateStorageAccountDocValue(stored.doc),
      parsed.entityId,
      parsed.counterpartyId,
      'startup-integrity',
    );
    accountOwners.add(accountOwnerKey(parsed.entityId, parsed.counterpartyId));
  }

  const bookOwners = new Set<string>();
  for await (const key of iterateKeys(db, { prefix: keyLiveBookPrefix() })) {
    const parsed = parseLiveBookKey(key);
    assertExactKey(key, keyLiveBook(parsed.entityId, parsed.pairId), 'STORAGE_LIVE_BOOK_KEY_MISMATCH');
    if (!await readStorageBookGraph(db, parsed.entityId, parsed.pairId)) {
      throw new Error(`STORAGE_BOOK_GRAPH_MISSING:${parsed.entityId}:${parsed.pairId}`);
    }
    bookOwners.add(bookOwnerKey(parsed.entityId, parsed.pairId));
  }

  for (const tag of [KEY_LIVE_ACCOUNT_BRANCH, KEY_LIVE_ACCOUNT_LEAF] as const) {
    for await (const key of iterateKeys(db, { prefix: Buffer.from([tag]) })) {
      const parsed = tag === KEY_LIVE_ACCOUNT_BRANCH
        ? parseLiveAccountBranchKey(key)
        : parseLiveAccountLeafKey(key);
      const owner = accountOwnerKey(parsed.entityId, parsed.counterpartyId);
      if (!accountOwners.has(owner) || !await readRawOrNull(db, Buffer.from(owner, 'hex'))) {
        throw new Error(`STORAGE_ACCOUNT_GRAPH_OWNER_MISSING:${owner}`);
      }
    }
  }

  for (const tag of [KEY_LIVE_BOOK_BRANCH, KEY_LIVE_BOOK_LEAF] as const) {
    for await (const key of iterateKeys(db, { prefix: Buffer.from([tag]) })) {
      const parsed = tag === KEY_LIVE_BOOK_BRANCH
        ? parseLiveBookBranchKey(key)
        : parseLiveBookLeafKey(key);
      const owner = bookOwnerKey(parsed.entityId, parsed.pairId);
      if (!bookOwners.has(owner) || !await readRawOrNull(db, Buffer.from(owner, 'hex'))) {
        throw new Error(`STORAGE_BOOK_GRAPH_OWNER_MISSING:${owner}`);
      }
    }
  }
};
