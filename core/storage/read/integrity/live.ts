/**
 * Verifies the disposable live projection directly from its typed graphs.
 * Account manifests and Book headers commit their Patricia child roots; every
 * graph row must belong to one declared owner. No second document Merkle exists.
 * Key checks: typed graph ownership, branch roots, leaves, and static references.
 * Human-audit importance: 100/100 — corrupt recovery bytes must fail closed.
 */
import { iterateKeys, readRawOrNull } from '../../database/level';
import {
  KEY_LIVE_ACCOUNT_BRANCH,
  KEY_LIVE_ACCOUNT_FIELD,
  KEY_LIVE_ACCOUNT_LEAF,
  KEY_LIVE_ENTITY,
  KEY_LIVE_ENTITY_BRANCH,
  KEY_LIVE_ENTITY_FIELD,
  KEY_LIVE_ENTITY_LEAF,
  KEY_LIVE_BOOK_BRANCH,
  KEY_LIVE_BOOK_LEAF,
  decodeEntityId,
  keyLiveAccount,
  keyLiveAccountField,
  keyLiveAccountFieldChunk,
  keyLiveAccountPrefix,
  keyLiveBook,
  keyLiveBookPrefix,
  keyLiveEntity,
  keyLiveEntityField,
  keyLiveEntityFieldChunk,
  parseLiveAccountBranchKey,
  parseLiveAccountFieldKey,
  parseLiveAccountKey,
  parseLiveAccountLeafKey,
  parseLiveBookBranchKey,
  parseLiveBookKey,
  parseLiveBookLeafKey,
  parseLiveEntityBranchKey,
  parseLiveEntityFieldKey,
  parseLiveEntityLeafKey,
} from '../../keys';
import { decodeAccountGraphManifest, readAccountStorageLayout } from '../../schema/account-layout';
import { decodeEntityGraphManifest, readEntityStorageLayout } from '../../schema/entity/layout';
import { ACCOUNT_TREE_NAMESPACE_TAG } from '../../schema/account-graph-codec';
import { ENTITY_COLLECTION_NAMESPACE_TAG } from '../../schema/entity/graph-codec';
import {
  assertStorageAccountDocBinding,
  assertStorageEntityDocBinding,
  validateStorageAccountDocValue,
} from '../../schema/authoritative-schema';
import type { RuntimeDbLike } from '../../types';
import { readStorageBookGraph } from '../book-graph';

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
  const entityOwners = new Map<string, Readonly<{
    fieldTags: ReadonlySet<number>;
    namespaceTags: ReadonlySet<number>;
  }>>();
  for await (const key of iterateKeys(db, { prefix: Buffer.from([KEY_LIVE_ENTITY]) })) {
    if (key.length !== 33) throw new Error(`STORAGE_LIVE_ENTITY_KEY_INVALID:${key.toString('hex')}`);
    const entityId = decodeEntityId(key.subarray(1));
    assertExactKey(key, keyLiveEntity(entityId), 'STORAGE_LIVE_ENTITY_KEY_MISMATCH');
    const stored = await readEntityStorageLayout(db, entityId, key);
    if (!stored) throw new Error(`STORAGE_LIVE_ENTITY_MISSING:${key.toString('hex')}`);
    assertStorageEntityDocBinding(
      stored.doc,
      entityId,
      'startup-integrity',
    );
    const manifest = decodeEntityGraphManifest(stored.rootValue);
    entityOwners.set(key.toString('hex'), {
      fieldTags: new Set(manifest.fields.map(field => field.tag)),
      namespaceTags: new Set(
        manifest.trees.map(tree => ENTITY_COLLECTION_NAMESPACE_TAG[tree.namespace]),
      ),
    });
  }

  const accountOwners = new Map<string, Readonly<{
    fieldTags: ReadonlySet<number>;
    namespaceTags: ReadonlySet<number>;
  }>>();
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
    const manifest = decodeAccountGraphManifest(stored.logicalValue);
    accountOwners.set(accountOwnerKey(parsed.entityId, parsed.counterpartyId), {
      fieldTags: new Set(manifest.fields.map(field => field.tag)),
      namespaceTags: new Set(
        manifest.trees.map(tree => ACCOUNT_TREE_NAMESPACE_TAG[tree.namespace]),
      ),
    });
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
      if (!accountOwners.get(owner)?.namespaceTags.has(parsed.namespaceTag) ||
          !await readRawOrNull(db, Buffer.from(owner, 'hex'))) {
        throw new Error(`STORAGE_ACCOUNT_GRAPH_OWNER_MISSING:${owner}`);
      }
    }
  }

  for (const tag of [KEY_LIVE_ENTITY_BRANCH, KEY_LIVE_ENTITY_LEAF] as const) {
    for await (const key of iterateKeys(db, { prefix: Buffer.from([tag]) })) {
      const parsed = tag === KEY_LIVE_ENTITY_BRANCH
        ? parseLiveEntityBranchKey(key)
        : parseLiveEntityLeafKey(key);
      const owner = keyLiveEntity(parsed.entityId).toString('hex');
      if (!entityOwners.get(owner)?.namespaceTags.has(parsed.namespaceTag) ||
          !await readRawOrNull(db, Buffer.from(owner, 'hex'))) {
        throw new Error(`STORAGE_ENTITY_GRAPH_OWNER_MISSING:${owner}`);
      }
    }
  }

  for await (const key of iterateKeys(db, { prefix: Buffer.from([KEY_LIVE_ENTITY_FIELD]) })) {
    const parsed = parseLiveEntityFieldKey(key);
    assertExactKey(
      key,
      parsed.chunkIndex === undefined
        ? keyLiveEntityField(parsed.entityId, parsed.fieldTag)
        : keyLiveEntityFieldChunk(parsed.entityId, parsed.fieldTag, parsed.chunkIndex),
      'STORAGE_LIVE_ENTITY_FIELD_KEY_MISMATCH',
    );
    const owner = keyLiveEntity(parsed.entityId).toString('hex');
    if (!entityOwners.get(owner)?.fieldTags.has(parsed.fieldTag) ||
        !await readRawOrNull(db, Buffer.from(owner, 'hex'))) {
      throw new Error(`STORAGE_ENTITY_FIELD_OWNER_MISSING:${owner}`);
    }
  }

  for await (const key of iterateKeys(db, { prefix: Buffer.from([KEY_LIVE_ACCOUNT_FIELD]) })) {
    const parsed = parseLiveAccountFieldKey(key);
    assertExactKey(
      key,
      parsed.chunkIndex === undefined
        ? keyLiveAccountField(parsed.entityId, parsed.counterpartyId, parsed.fieldTag)
        : keyLiveAccountFieldChunk(
            parsed.entityId,
            parsed.counterpartyId,
            parsed.fieldTag,
            parsed.chunkIndex,
          ),
      'STORAGE_LIVE_ACCOUNT_FIELD_KEY_MISMATCH',
    );
    const owner = accountOwnerKey(parsed.entityId, parsed.counterpartyId);
    if (!accountOwners.get(owner)?.fieldTags.has(parsed.fieldTag) ||
        !await readRawOrNull(db, Buffer.from(owner, 'hex'))) {
      throw new Error(`STORAGE_ACCOUNT_FIELD_OWNER_MISSING:${owner}`);
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
