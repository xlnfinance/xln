/**
 * Account storage is the exact physical projection of its RAM Patricia maps.
 * Headers retain only namespace roots/counts; branch/leaf rows stay below the
 * LevelDB record budget and hydrate by relinking, never by flattening a blob.
 */
import {
  ACCOUNT_STATE_MAP_NAMESPACES,
  isPersistentAccountStateMap,
  PersistentAccountStateMap,
  type AccountStateMapKey,
  type AccountStateMapNamespace,
} from '../../account/state/persistent-state-map';
import type { AccountReplica } from '../../types/account';
import type {
  PersistentRadixBranchRecord,
  PersistentRadixNodeRecord,
} from '../../protocol/state/persistent-radix-value-map';
import { radixMerklePathSlots } from '../../protocol/state/radix-merkle';
import { decodeBuffer, encodeBuffer } from '../codec/codec';
import { iterateKeys } from '../database/level';
import {
  KEY_LIVE_ACCOUNT_BRANCH,
  KEY_LIVE_ACCOUNT_LEAF,
  keyLiveAccountBranch,
  keyLiveAccountLeaf,
  keyLiveAccountTreePrefix,
  parseLiveAccountBranchKey,
  parseLiveAccountLeafKey,
} from '../keys';
import type { RuntimeDbLike } from '../types';

export const ACCOUNT_TREE_NAMESPACE_TAG = Object.freeze(Object.fromEntries(
  ACCOUNT_STATE_MAP_NAMESPACES.map((namespace, index) => [namespace, index + 1]),
) as Record<AccountStateMapNamespace, number>);

const ACCOUNT_TREE_NAMESPACE_BY_TAG = new Map<number, AccountStateMapNamespace>(
  Object.entries(ACCOUNT_TREE_NAMESPACE_TAG).map(([namespace, tag]) => [
    tag,
    namespace as AccountStateMapNamespace,
  ]),
);

export type StorageAccountTreeDescriptor = Readonly<{
  namespace: AccountStateMapNamespace;
  rootHash: string;
  leafCount: number;
}>;

type AccountTree = PersistentAccountStateMap<AccountStateMapKey, unknown>;
type AccountTreeRecord = PersistentRadixNodeRecord<AccountStateMapKey, unknown>;
type AccountTreeRow = Readonly<{ key: Buffer; value: Buffer }>;

const accountTree = (value: unknown, namespace: AccountStateMapNamespace): AccountTree => {
  if (!isPersistentAccountStateMap(value) || value.namespace !== namespace) {
    throw new Error(`STORAGE_ACCOUNT_TREE_REQUIRED:${namespace}`);
  }
  return value;
};

const accountTreeFromReplica = (
  account: AccountReplica,
  namespace: AccountStateMapNamespace,
): AccountTree | undefined => {
  switch (namespace) {
    case 'deltas': return accountTree(account.state.deltas, namespace);
    case 'locks': return accountTree(account.state.locks, namespace);
    case 'pulls': return account.state.pulls === undefined ? undefined : accountTree(account.state.pulls, namespace);
    case 'swapOffers': return accountTree(account.state.swapOffers, namespace);
    case 'subcontracts': return account.state.subcontracts === undefined ? undefined : accountTree(account.state.subcontracts, namespace);
    case 'lendingIntents': return account.state.lendingIntents === undefined ? undefined : accountTree(account.state.lendingIntents, namespace);
    case 'requestedRebalance': return accountTree(account.state.requestedRebalance, namespace);
    case 'requestedRebalanceFeeState': return accountTree(account.state.requestedRebalanceFeeState, namespace);
    case 'rebalanceFeePolicies': return account.state.rebalanceFeePolicies === undefined ? undefined : accountTree(account.state.rebalanceFeePolicies, namespace);
    case 'pendingWithdrawals': return accountTree(account.pendingWithdrawals, namespace);
    case 'rebalanceShadowPolicy': return accountTree(account.shadow.rebalance.policy, namespace);
    case 'rebalanceShadowSubmitted': return accountTree(account.shadow.rebalance.submittedAtByToken, namespace);
  }
};

export const projectAccountTreeDescriptors = (
  account: AccountReplica,
): StorageAccountTreeDescriptor[] => ACCOUNT_STATE_MAP_NAMESPACES.flatMap(namespace => {
  const tree = accountTreeFromReplica(account, namespace);
  return tree ? [{ namespace, rootHash: tree.rootHash(), leafCount: tree.size }] : [];
});

const boundedRow = (key: Buffer, value: unknown): AccountTreeRow => {
  const encoded = encodeBuffer(value);
  if (encoded.byteLength >= 10_000) {
    throw new Error(`STORAGE_ACCOUNT_TREE_ROW_TOO_LARGE:${encoded.byteLength}:${key.toString('hex')}`);
  }
  return { key, value: encoded };
};

const branchValue = (record: PersistentRadixBranchRecord) => ({ children: record.children });

const rowForRecord = (
  entityId: string,
  counterpartyId: string,
  namespace: AccountStateMapNamespace,
  record: AccountTreeRecord,
): AccountTreeRow => {
  const tag = ACCOUNT_TREE_NAMESPACE_TAG[namespace];
  return record.kind === 'branch'
    ? boundedRow(keyLiveAccountBranch(entityId, counterpartyId, tag, record.path), branchValue(record))
    : boundedRow(
        keyLiveAccountLeaf(entityId, counterpartyId, tag, record.keyBytes),
        { key: record.key, value: record.value },
      );
};

const keyForRef = (
  entityId: string,
  counterpartyId: string,
  namespace: AccountStateMapNamespace,
  record: Readonly<{ kind: 'branch' | 'leaf'; path: readonly number[]; keyBytes?: Uint8Array }>,
): Buffer => record.kind === 'branch'
  ? keyLiveAccountBranch(entityId, counterpartyId, ACCOUNT_TREE_NAMESPACE_TAG[namespace], record.path)
  : keyLiveAccountLeaf(
      entityId,
      counterpartyId,
      ACCOUNT_TREE_NAMESPACE_TAG[namespace],
      record.keyBytes ?? (() => { throw new Error('STORAGE_ACCOUNT_TREE_LEAF_KEY_MISSING'); })(),
    );

export const projectAccountTreeChanges = (
  entityId: string,
  counterpartyId: string,
  next: AccountReplica,
  previous?: AccountReplica,
): Readonly<{ puts: AccountTreeRow[]; dels: Buffer[] }> => {
  const puts: AccountTreeRow[] = [];
  const dels: Buffer[] = [];
  for (const namespace of ACCOUNT_STATE_MAP_NAMESPACES) {
    const nextTree = accountTreeFromReplica(next, namespace);
    const previousTree = previous ? accountTreeFromReplica(previous, namespace) : undefined;
    if (nextTree && previousTree) {
      const changes = nextTree.nodeChangesSince(previousTree);
      puts.push(...changes.puts.map(record => rowForRecord(entityId, counterpartyId, namespace, record)));
      dels.push(...changes.dels.map(record => keyForRef(entityId, counterpartyId, namespace, record)));
    } else if (nextTree) {
      puts.push(...[...nextTree.nodeRecords()].map(record =>
        rowForRecord(entityId, counterpartyId, namespace, record)));
    } else if (previousTree) {
      dels.push(...[...previousTree.nodeRecords()].map(record =>
        keyForRef(entityId, counterpartyId, namespace, record)));
    }
  }
  return { puts, dels };
};

const record = (value: unknown, code: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
};

const decodeBranch = (value: unknown, path: readonly number[]): PersistentRadixBranchRecord => {
  const branch = record(value, 'STORAGE_ACCOUNT_BRANCH_INVALID');
  if (Object.keys(branch).length !== 1 || !Array.isArray(branch['children'])) {
    throw new Error('STORAGE_ACCOUNT_BRANCH_FIELDS');
  }
  const children = branch['children'].map((value, index) => {
    const child = record(value, `STORAGE_ACCOUNT_BRANCH_CHILD_${index}`);
    if (Object.keys(child).sort().join(',') !== 'edgeHash,kind,path,slot') {
      throw new Error(`STORAGE_ACCOUNT_BRANCH_CHILD_FIELDS:${index}`);
    }
    const slot = child['slot'];
    const kind = child['kind'];
    const childPath = child['path'];
    const edgeHash = child['edgeHash'];
    if (!Number.isSafeInteger(slot) || Number(slot) < 0 || Number(slot) >= 16) {
      throw new Error(`STORAGE_ACCOUNT_BRANCH_CHILD_SLOT:${index}`);
    }
    if (kind !== 'branch' && kind !== 'leaf') {
      throw new Error(`STORAGE_ACCOUNT_BRANCH_CHILD_KIND:${index}`);
    }
    const decodedKind: 'branch' | 'leaf' = kind === 'branch' ? 'branch' : 'leaf';
    if (!Array.isArray(childPath) || childPath.some(
      pathSlot => !Number.isSafeInteger(pathSlot) || Number(pathSlot) < 0 || Number(pathSlot) >= 16,
    )) {
      throw new Error(`STORAGE_ACCOUNT_BRANCH_CHILD_PATH:${index}`);
    }
    if (typeof edgeHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(edgeHash)) {
      throw new Error(`STORAGE_ACCOUNT_BRANCH_CHILD_HASH:${index}`);
    }
    return {
      slot: Number(slot),
      kind: decodedKind,
      path: childPath.map(Number),
      edgeHash,
    };
  });
  return { kind: 'branch', path: [...path], children };
};

const decodeLeaf = (
  value: unknown,
  keyBytes: Uint8Array,
): AccountTreeRecord => {
  const leaf = record(value, 'STORAGE_ACCOUNT_LEAF_INVALID');
  if (Object.keys(leaf).sort().join(',') !== 'key,value') throw new Error('STORAGE_ACCOUNT_LEAF_FIELDS');
  const key = leaf['key'];
  if (typeof key !== 'string' && !Number.isSafeInteger(key)) throw new Error('STORAGE_ACCOUNT_LEAF_KEY');
  return {
    kind: 'leaf',
    path: radixMerklePathSlots(keyBytes, 16),
    key: key as AccountStateMapKey,
    keyBytes: Uint8Array.from(keyBytes),
    value: leaf['value'],
  };
};

const readTreeRecords = async (
  db: RuntimeDbLike,
  entityId: string,
  counterpartyId: string,
  namespace: AccountStateMapNamespace,
): Promise<AccountTreeRecord[]> => {
  const tag = ACCOUNT_TREE_NAMESPACE_TAG[namespace];
  const records: AccountTreeRecord[] = [];
  const branchPrefix = keyLiveAccountTreePrefix(KEY_LIVE_ACCOUNT_BRANCH, entityId, counterpartyId, tag);
  for await (const key of iterateKeys(db, { prefix: branchPrefix })) {
    const parsed = parseLiveAccountBranchKey(key);
    if (ACCOUNT_TREE_NAMESPACE_BY_TAG.get(parsed.namespaceTag) !== namespace) throw new Error('STORAGE_ACCOUNT_BRANCH_NAMESPACE');
    records.push(decodeBranch(decodeBuffer(await db.get(key)), parsed.path));
  }
  const leafPrefix = keyLiveAccountTreePrefix(KEY_LIVE_ACCOUNT_LEAF, entityId, counterpartyId, tag);
  for await (const key of iterateKeys(db, { prefix: leafPrefix })) {
    const parsed = parseLiveAccountLeafKey(key);
    if (ACCOUNT_TREE_NAMESPACE_BY_TAG.get(parsed.namespaceTag) !== namespace) throw new Error('STORAGE_ACCOUNT_LEAF_NAMESPACE');
    records.push(decodeLeaf(decodeBuffer(await db.get(key)), parsed.payload));
  }
  return records;
};

export const hydrateAccountTrees = async (
  db: RuntimeDbLike,
  entityId: string,
  counterpartyId: string,
  descriptors: readonly StorageAccountTreeDescriptor[],
): Promise<Map<AccountStateMapNamespace, AccountTree>> => {
  const trees = new Map<AccountStateMapNamespace, AccountTree>();
  for (const descriptor of descriptors) {
    const records = await readTreeRecords(db, entityId, counterpartyId, descriptor.namespace);
    const tree = PersistentAccountStateMap.fromNodeRecords(descriptor.namespace, records);
    if (tree.rootHash() !== descriptor.rootHash || tree.size !== descriptor.leafCount) {
      throw new Error(`STORAGE_ACCOUNT_TREE_ROOT_MISMATCH:${descriptor.namespace}`);
    }
    trees.set(descriptor.namespace, tree);
  }
  return trees;
};

export const accountTreeStorageKeys = async (
  db: RuntimeDbLike,
  entityId: string,
  counterpartyId: string,
): Promise<Buffer[]> => {
  const keys: Buffer[] = [];
  for (const tag of [KEY_LIVE_ACCOUNT_BRANCH, KEY_LIVE_ACCOUNT_LEAF] as const) {
    const prefix = keyLiveAccountTreePrefix(tag, entityId, counterpartyId);
    for await (const key of iterateKeys(db, { prefix })) keys.push(key);
  }
  return keys;
};
