/**
 * Audits every retained Patricia row, including rows unreachable from a root.
 * Snapshots are operator recovery authority, so orphan or unknown graph bytes
 * must fail verification instead of hiding outside normal graph traversal.
 * Human-audit importance: 98/100 — prevents incomplete/corrupt recovery roots.
 */
import {
  KEY_LIVE_ACCOUNT_BRANCH,
  KEY_LIVE_ACCOUNT_FIELD,
  KEY_LIVE_ACCOUNT_LEAF,
  KEY_LIVE_BOOK_BRANCH,
  KEY_LIVE_BOOK_LEAF,
  KEY_LIVE_ENTITY_BRANCH,
  KEY_LIVE_ENTITY_FIELD,
  KEY_LIVE_ENTITY_LEAF,
  keySnapshotAccount,
  keySnapshotAccountPrefix,
  keySnapshotBook,
  keySnapshotBookPrefix,
  keySnapshotGraphPrefix,
  keySnapshotEntity,
  keySnapshotEntityPrefix,
  parseLiveAccountBranchKey,
  parseLiveAccountFieldKey,
  parseLiveAccountLeafKey,
  parseLiveBookBranchKey,
  parseLiveBookLeafKey,
  parseLiveBookKey,
  parseLiveEntityBranchKey,
  parseLiveEntityFieldKey,
  parseLiveEntityLeafKey,
  parseSnapshotAccountKey,
  parseSnapshotGraphKey,
  parseSnapshotEntityKey,
} from '../../keys';
import { decodeValidatedBuffer } from '../../codec/codec';
import { iterateKeys } from '../../database/level';
import { ACCOUNT_TREE_NAMESPACE_TAG } from '../../schema/account-graph-codec';
import { decodeAccountGraphManifest } from '../../schema/account-layout';
import { decodeStorageBookHeader } from '../../schema/book-graph-codec';
import { ENTITY_COLLECTION_NAMESPACE_TAG } from '../../schema/entity/graph-codec';
import { decodeEntityGraphManifest } from '../../schema/entity/layout';
import type { RuntimeDbLike } from '../../types';

const ownerKey = (key: Buffer): string => key.toString('hex');

type SnapshotGraphOwner = Readonly<
  | { kind: 'account'; namespaceTags: ReadonlySet<number>; fieldTags: ReadonlySet<number> }
  | { kind: 'entity'; namespaceTags: ReadonlySet<number>; fieldTags: ReadonlySet<number> }
  | { kind: 'book' }
>;

const collectSnapshotOwners = async (
  db: RuntimeDbLike,
  height: number,
): Promise<ReadonlyMap<string, SnapshotGraphOwner>> => {
  const owners = new Map<string, SnapshotGraphOwner>();
  for await (const key of iterateKeys(db, { prefix: keySnapshotEntityPrefix(height) })) {
    const parsed = parseSnapshotEntityKey(key);
    if (parsed.height !== height) throw new Error('STORAGE_SNAPSHOT_ENTITY_HEIGHT_MISMATCH');
    const manifest = decodeEntityGraphManifest(await db.get(key));
    owners.set(ownerKey(key), {
      kind: 'entity',
      namespaceTags: new Set(
        manifest.trees.map(tree => ENTITY_COLLECTION_NAMESPACE_TAG[tree.namespace]),
      ),
      fieldTags: new Set(manifest.fields.map(field => field.tag)),
    });
  }
  for await (const key of iterateKeys(db, { prefix: keySnapshotAccountPrefix(height) })) {
    const parsed = parseSnapshotAccountKey(key);
    if (parsed.height !== height) throw new Error('STORAGE_SNAPSHOT_ACCOUNT_HEIGHT_MISMATCH');
    const manifest = decodeAccountGraphManifest(await db.get(key));
    owners.set(ownerKey(key), {
      kind: 'account',
      namespaceTags: new Set(
        manifest.trees.map(tree => ACCOUNT_TREE_NAMESPACE_TAG[tree.namespace]),
      ),
      fieldTags: new Set(manifest.fields.map(field => field.tag)),
    });
  }
  for await (const key of iterateKeys(db, { prefix: keySnapshotBookPrefix(height) })) {
    parseLiveBookKey(key, 9);
    decodeValidatedBuffer(await db.get(key), decodeStorageBookHeader);
    owners.set(ownerKey(key), { kind: 'book' });
  }
  return owners;
};

const graphOwner = (
  height: number,
  liveKey: Buffer,
): Readonly<{ key: Buffer; namespaceTag?: number; fieldTag?: number }> => {
  switch (liveKey[0]) {
    case KEY_LIVE_ENTITY_FIELD: {
      const owner = parseLiveEntityFieldKey(liveKey);
      return { key: keySnapshotEntity(height, owner.entityId), fieldTag: owner.fieldTag };
    }
    case KEY_LIVE_ENTITY_BRANCH: {
      const owner = parseLiveEntityBranchKey(liveKey);
      return { key: keySnapshotEntity(height, owner.entityId), namespaceTag: owner.namespaceTag };
    }
    case KEY_LIVE_ENTITY_LEAF: {
      const owner = parseLiveEntityLeafKey(liveKey);
      return { key: keySnapshotEntity(height, owner.entityId), namespaceTag: owner.namespaceTag };
    }
    case KEY_LIVE_ACCOUNT_FIELD: {
      const owner = parseLiveAccountFieldKey(liveKey);
      return {
        key: keySnapshotAccount(height, owner.entityId, owner.counterpartyId),
        fieldTag: owner.fieldTag,
      };
    }
    case KEY_LIVE_ACCOUNT_BRANCH: {
      const owner = parseLiveAccountBranchKey(liveKey);
      return {
        key: keySnapshotAccount(height, owner.entityId, owner.counterpartyId),
        namespaceTag: owner.namespaceTag,
      };
    }
    case KEY_LIVE_ACCOUNT_LEAF: {
      const owner = parseLiveAccountLeafKey(liveKey);
      return {
        key: keySnapshotAccount(height, owner.entityId, owner.counterpartyId),
        namespaceTag: owner.namespaceTag,
      };
    }
    case KEY_LIVE_BOOK_BRANCH: {
      const owner = parseLiveBookBranchKey(liveKey);
      return { key: keySnapshotBook(height, owner.entityId, owner.pairId) };
    }
    case KEY_LIVE_BOOK_LEAF: {
      const owner = parseLiveBookLeafKey(liveKey);
      return { key: keySnapshotBook(height, owner.entityId, owner.pairId) };
    }
    default:
      throw new Error(`STORAGE_SNAPSHOT_GRAPH_TAG_INVALID:${String(liveKey[0])}`);
  }
};

/** Returns the exact graph-row count after validating every row and owner. */
export const inspectSnapshotGraphRows = async (
  db: RuntimeDbLike,
  height: number,
): Promise<number> => {
  const owners = await collectSnapshotOwners(db, height);
  let count = 0;
  for await (const key of iterateKeys(db, { prefix: keySnapshotGraphPrefix(height) })) {
    const parsed = parseSnapshotGraphKey(key);
    if (parsed.height !== height) throw new Error('STORAGE_SNAPSHOT_GRAPH_HEIGHT_MISMATCH');
    const ownership = graphOwner(height, parsed.liveKey);
    const owner = owners.get(ownerKey(ownership.key));
    if (!owner) {
      throw new Error(`STORAGE_SNAPSHOT_GRAPH_OWNER_MISSING:${ownership.key.toString('hex')}`);
    }
    if (ownership.fieldTag !== undefined) {
      if (owner.kind === 'book' || !owner.fieldTags.has(ownership.fieldTag)) {
        throw new Error(
          `STORAGE_SNAPSHOT_GRAPH_ACCOUNT_FIELD_UNDECLARED:` +
          `owner=${ownership.key.toString('hex')}:field=${ownership.fieldTag}`,
        );
      }
    } else if (ownership.namespaceTag !== undefined) {
      if (owner.kind === 'book') {
        throw new Error(`STORAGE_SNAPSHOT_GRAPH_OWNER_KIND_INVALID:${ownership.key.toString('hex')}`);
      }
      if (!owner.namespaceTags.has(ownership.namespaceTag)) {
        throw new Error(
          `STORAGE_SNAPSHOT_GRAPH_ACCOUNT_NAMESPACE_UNDECLARED:` +
          `owner=${ownership.key.toString('hex')}:namespace=${ownership.namespaceTag}`,
        );
      }
    } else if (owner.kind !== 'book') {
      throw new Error(`STORAGE_SNAPSHOT_GRAPH_OWNER_KIND_INVALID:${ownership.key.toString('hex')}`);
    }
    count += 1;
  }
  return count;
};
