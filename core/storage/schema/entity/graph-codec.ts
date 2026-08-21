/** Exact LevelDB projection of Entity-owned persistent Patricia collections. */
import type { EntityState } from '../../../entity/types';
import {
  isPersistentEntityCollectionMap,
  PersistentEntityCollectionMap,
} from '../../../entity/state/persistent-collection-map';
import type {
  PersistentRadixBranchRecord,
  PersistentRadixNodeRecord,
} from '../../../protocol/state/persistent-radix-value-map';
import { radixMerklePathSlots } from '../../../protocol/state/radix-merkle';
import { decodeBuffer, encodeBuffer } from '../../codec/codec';
import { iterateKeys } from '../../database/level';
import {
  KEY_LIVE_ENTITY_BRANCH,
  KEY_LIVE_ENTITY_LEAF,
  keyLiveEntityBranch,
  keyLiveEntityLeaf,
  keyLiveEntityTreePrefix,
  parseLiveEntityBranchKey,
  parseLiveEntityLeafKey,
} from '../../keys';
import type { RuntimeDbLike } from '../../types';

export const ENTITY_COLLECTION_NAMESPACES = [
  'htlcRoutes',
  'lockBook',
  'crossJurisdictionSwaps',
  'crossJurisdictionAuthorizations',
  'pendingCrossJurisdictionFillAcks',
  'crossJurisdictionBookAdmissions',
  'crontabHooks',
] as const;

export type EntityCollectionNamespace = (typeof ENTITY_COLLECTION_NAMESPACES)[number];

/** Permanent physical graph keys. Never derive these from array order. */
export const ENTITY_COLLECTION_NAMESPACE_TAG = Object.freeze({
  htlcRoutes: 1,
  lockBook: 2,
  crossJurisdictionSwaps: 3,
  crossJurisdictionAuthorizations: 4,
  pendingCrossJurisdictionFillAcks: 5,
  crossJurisdictionBookAdmissions: 6,
  crontabHooks: 7,
} as const satisfies Record<EntityCollectionNamespace, number>);

const NAMESPACE_BY_TAG = new Map<number, EntityCollectionNamespace>(
  Object.entries(ENTITY_COLLECTION_NAMESPACE_TAG).map(([namespace, tag]) => [
    tag,
    namespace as EntityCollectionNamespace,
  ]),
);

export type StorageEntityTreeDescriptor = Readonly<{
  namespace: EntityCollectionNamespace;
  rootHash: string;
  leafCount: number;
}>;

type EntityTree = PersistentEntityCollectionMap<unknown>;
type EntityTreeRecord = PersistentRadixNodeRecord<string, unknown>;
type EntityTreeRow = Readonly<{ key: Buffer; value: Buffer }>;

const entityTree = (value: unknown, namespace: EntityCollectionNamespace): EntityTree => {
  if (!isPersistentEntityCollectionMap(value)) {
    throw new Error(`STORAGE_ENTITY_TREE_REQUIRED:${namespace}`);
  }
  return value;
};

const entityTreeFromState = (
  state: EntityState,
  namespace: EntityCollectionNamespace,
): EntityTree | undefined => {
  const value = namespace === 'crontabHooks'
    ? state.crontabState?.hooks
    : state[namespace];
  return value === undefined ? undefined : entityTree(value, namespace);
};

export const projectEntityTreeDescriptors = (
  state: EntityState,
): StorageEntityTreeDescriptor[] => ENTITY_COLLECTION_NAMESPACES.flatMap(namespace => {
  const tree = entityTreeFromState(state, namespace);
  return tree ? [{ namespace, rootHash: tree.rootHash(), leafCount: tree.size }] : [];
});

const boundedRow = (key: Buffer, value: unknown): EntityTreeRow => {
  const encoded = encodeBuffer(value);
  if (encoded.byteLength >= 10_000) {
    throw new Error(`STORAGE_ENTITY_TREE_ROW_TOO_LARGE:${encoded.byteLength}:${key.toString('hex')}`);
  }
  return { key, value: encoded };
};

const rowForRecord = (
  entityId: string,
  namespace: EntityCollectionNamespace,
  record: EntityTreeRecord,
): EntityTreeRow => {
  const tag = ENTITY_COLLECTION_NAMESPACE_TAG[namespace];
  return record.kind === 'branch'
    ? boundedRow(keyLiveEntityBranch(entityId, tag, record.path), { children: record.children })
    : boundedRow(
        keyLiveEntityLeaf(entityId, tag, record.keyBytes),
        { key: record.key, value: record.value },
      );
};

const keyForRef = (
  entityId: string,
  namespace: EntityCollectionNamespace,
  record: Readonly<{
    kind: 'branch' | 'leaf';
    path: readonly number[];
    keyBytes?: Uint8Array;
  }>,
): Buffer => record.kind === 'branch'
  ? keyLiveEntityBranch(entityId, ENTITY_COLLECTION_NAMESPACE_TAG[namespace], record.path)
  : keyLiveEntityLeaf(
      entityId,
      ENTITY_COLLECTION_NAMESPACE_TAG[namespace],
      record.keyBytes ?? (() => { throw new Error('STORAGE_ENTITY_TREE_LEAF_KEY_MISSING'); })(),
    );

export const projectEntityTreeChanges = (
  entityId: string,
  next: EntityState,
  previous?: EntityState,
): Readonly<{ puts: EntityTreeRow[]; dels: Buffer[] }> => {
  const puts: EntityTreeRow[] = [];
  const dels: Buffer[] = [];
  for (const namespace of ENTITY_COLLECTION_NAMESPACES) {
    const nextTree = entityTreeFromState(next, namespace);
    const previousTree = previous ? entityTreeFromState(previous, namespace) : undefined;
    if (nextTree && previousTree) {
      const changes = nextTree.nodeChangesSince(previousTree);
      puts.push(...changes.puts.map(record => rowForRecord(entityId, namespace, record)));
      dels.push(...changes.dels.map(record => keyForRef(entityId, namespace, record)));
    } else if (nextTree) {
      puts.push(...[...nextTree.nodeRecords()].map(record => rowForRecord(entityId, namespace, record)));
    } else if (previousTree) {
      dels.push(...[...previousTree.nodeRecords()].map(record => keyForRef(entityId, namespace, record)));
    }
  }
  return { puts, dels };
};

const record = (value: unknown, code: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
};

const decodeBranch = (value: unknown, path: readonly number[]): PersistentRadixBranchRecord => {
  const branch = record(value, 'STORAGE_ENTITY_BRANCH_INVALID');
  if (Object.keys(branch).length !== 1 || !Array.isArray(branch['children'])) {
    throw new Error('STORAGE_ENTITY_BRANCH_FIELDS');
  }
  const children = branch['children'].map((raw, index) => {
    const child = record(raw, `STORAGE_ENTITY_BRANCH_CHILD_${index}`);
    if (Object.keys(child).sort().join(',') !== 'edgeHash,kind,path,slot') {
      throw new Error(`STORAGE_ENTITY_BRANCH_CHILD_FIELDS:${index}`);
    }
    const slot = child['slot'];
    const kind = child['kind'];
    const childPath = child['path'];
    const edgeHash = child['edgeHash'];
    if (!Number.isSafeInteger(slot) || Number(slot) < 0 || Number(slot) >= 16) {
      throw new Error(`STORAGE_ENTITY_BRANCH_CHILD_SLOT:${index}`);
    }
    if (kind !== 'branch' && kind !== 'leaf') throw new Error(`STORAGE_ENTITY_BRANCH_CHILD_KIND:${index}`);
    if (!Array.isArray(childPath) || childPath.some(
      pathSlot => !Number.isSafeInteger(pathSlot) || Number(pathSlot) < 0 || Number(pathSlot) >= 16,
    )) throw new Error(`STORAGE_ENTITY_BRANCH_CHILD_PATH:${index}`);
    if (typeof edgeHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(edgeHash)) {
      throw new Error(`STORAGE_ENTITY_BRANCH_CHILD_HASH:${index}`);
    }
    return {
      slot: Number(slot),
      kind: kind as 'branch' | 'leaf',
      path: childPath.map(Number),
      edgeHash,
    };
  });
  return { kind: 'branch', path: [...path], children };
};

const decodeLeaf = (value: unknown, keyBytes: Uint8Array): EntityTreeRecord => {
  const leaf = record(value, 'STORAGE_ENTITY_LEAF_INVALID');
  if (Object.keys(leaf).sort().join(',') !== 'key,value') throw new Error('STORAGE_ENTITY_LEAF_FIELDS');
  if (typeof leaf['key'] !== 'string') throw new Error('STORAGE_ENTITY_LEAF_KEY');
  return {
    kind: 'leaf',
    path: radixMerklePathSlots(keyBytes, 16),
    key: leaf['key'],
    keyBytes: Uint8Array.from(keyBytes),
    value: leaf['value'],
  };
};

const readTreeRecords = async (
  db: RuntimeDbLike,
  entityId: string,
  namespace: EntityCollectionNamespace,
): Promise<EntityTreeRecord[]> => {
  const tag = ENTITY_COLLECTION_NAMESPACE_TAG[namespace];
  const records: EntityTreeRecord[] = [];
  const branchPrefix = keyLiveEntityTreePrefix(KEY_LIVE_ENTITY_BRANCH, entityId, tag);
  for await (const key of iterateKeys(db, { prefix: branchPrefix })) {
    const parsed = parseLiveEntityBranchKey(key);
    if (NAMESPACE_BY_TAG.get(parsed.namespaceTag) !== namespace) throw new Error('STORAGE_ENTITY_BRANCH_NAMESPACE');
    records.push(decodeBranch(decodeBuffer(await db.get(key)), parsed.path));
  }
  const leafPrefix = keyLiveEntityTreePrefix(KEY_LIVE_ENTITY_LEAF, entityId, tag);
  for await (const key of iterateKeys(db, { prefix: leafPrefix })) {
    const parsed = parseLiveEntityLeafKey(key);
    if (NAMESPACE_BY_TAG.get(parsed.namespaceTag) !== namespace) throw new Error('STORAGE_ENTITY_LEAF_NAMESPACE');
    records.push(decodeLeaf(decodeBuffer(await db.get(key)), parsed.payload));
  }
  return records;
};

export const hydrateEntityTrees = async (
  db: RuntimeDbLike,
  entityId: string,
  descriptors: readonly StorageEntityTreeDescriptor[],
): Promise<Map<EntityCollectionNamespace, EntityTree>> => {
  const trees = new Map<EntityCollectionNamespace, EntityTree>();
  for (const descriptor of descriptors) {
    const tree = PersistentEntityCollectionMap.fromNodeRecords(
      await readTreeRecords(db, entityId, descriptor.namespace),
    );
    if (tree.rootHash() !== descriptor.rootHash || tree.size !== descriptor.leafCount) {
      throw new Error(`STORAGE_ENTITY_TREE_ROOT_MISMATCH:${descriptor.namespace}`);
    }
    trees.set(descriptor.namespace, tree);
  }
  return trees;
};

export const entityTreeStorageKeys = async (
  db: RuntimeDbLike,
  entityId: string,
): Promise<Buffer[]> => {
  const keys: Buffer[] = [];
  for (const tag of [KEY_LIVE_ENTITY_BRANCH, KEY_LIVE_ENTITY_LEAF] as const) {
    for await (const key of iterateKeys(db, { prefix: keyLiveEntityTreePrefix(tag, entityId) })) {
      keys.push(key);
    }
  }
  return keys;
};
