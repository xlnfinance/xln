/**
 * Canonical Account storage node. The root commits permanent field rows plus
 * the roots of the real in-memory Patricia maps. Never recursively graphify
 * the envelope: that creates a second tree and makes checkpoints O(Account).
 * Static field keys let a checkpoint overwrite exactly the changed values.
 */
import { computeIntegrityDigest } from '../../support/bytes/integrity-checksum';
import { decodeBuffer, encodeBuffer } from '../codec/codec';
import { readRawOrNull , iterateKeys } from '../database/level';
import type { RuntimeDbLike, StorageAccountDoc } from '../types';
import type { AccountReplica, AccountState } from '../../types/account';
import {
  STORAGE_ACCOUNT_FIELD_BY_TAG,
  STORAGE_ACCOUNT_FIELD_TAG,
  type StorageAccountField,
} from './account-field-tags';
import {
  ACCOUNT_STATE_MAP_NAMESPACES,
  type AccountStateMapNamespace,
} from '../../account/state/persistent-state-map';
import {
  accountTreeStorageKeys,
  hydrateAccountTrees,
  projectAccountTreeChanges,
  projectAccountTreeDescriptors,
  type StorageAccountTreeDescriptor,
} from './account-graph-codec';
import { validateStorageAccountDocValue } from './schema-state-docs';
import {
  keyLiveAccountField,
  keyLiveAccountFieldChunk,
  keyLiveAccountFieldPrefix,
} from '../keys';

;

export const MAX_INLINE_STORAGE_VALUE_BYTES = 10_000;

type AccountGraphManifest = Readonly<{
  version: 4;
  fields: readonly StorageAccountFieldDescriptor[];
  trees: readonly StorageAccountTreeDescriptor[];
}>;

type StorageAccountFieldDescriptor = Readonly<{
  tag: number;
  valueHash: string;
  byteLength: number;
  chunkCount: number;
}>;

type EncodedAccountField = Readonly<{
  field: StorageAccountField;
  tag: number;
  value: Buffer;
  valueHash: string;
  rows: Array<Readonly<{ key: Buffer; value: Buffer }>>;
}>;

export type AccountStorageLayout = Readonly<{
  representation: 'graph';
  logicalValue: Buffer;
  logicalHash: string;
  rootValue: Buffer;
  puts: Array<Readonly<{ key: Buffer; value: Buffer }>>;
  dels: Buffer[];
}>;

const TREE_FIELDS = new Set<StorageAccountField>([
  'state.deltas', 'state.locks', 'state.swapOffers', 'state.pulls',
  'state.subcontracts', 'state.lendingIntents', 'state.requestedRebalance',
  'state.requestedRebalanceFeeState', 'state.rebalanceFeePolicies',
  'pendingWithdrawals',
]);

const isStateField = (field: StorageAccountField): field is `state.${keyof AccountState & string}` =>
  field.startsWith('state.');

const stateFieldName = (field: `state.${keyof AccountState & string}`): keyof AccountState =>
  field.slice('state.'.length) as keyof AccountState;

const hasAccountField = (doc: StorageAccountDoc, field: StorageAccountField): boolean =>
  isStateField(field)
    ? Object.hasOwn(doc.state, stateFieldName(field))
    : Object.hasOwn(doc, field);

const scalarShadow = (doc: StorageAccountDoc): unknown => {
  const { policy: _policy, submittedAtByToken: _submitted, ...rebalance } = doc.shadow.rebalance;
  return { ...doc.shadow, rebalance };
};

const accountFieldValue = (doc: StorageAccountDoc, field: StorageAccountField): unknown => {
  if (field === 'shadow') return scalarShadow(doc);
  return isStateField(field)
    ? doc.state[stateFieldName(field)]
    : doc[field as keyof AccountReplica];
};

const assertKnownFields = (doc: StorageAccountDoc): void => {
  for (const field of Object.getOwnPropertyNames(doc)) {
    if (field !== 'state' && !(field in STORAGE_ACCOUNT_FIELD_TAG)) {
      throw new Error(`STORAGE_ACCOUNT_FIELD_UNKNOWN:${field}`);
    }
  }
  for (const field of Object.getOwnPropertyNames(doc.state)) {
    if (!(`state.${field}` in STORAGE_ACCOUNT_FIELD_TAG)) {
      throw new Error(`STORAGE_ACCOUNT_STATE_FIELD_UNKNOWN:${field}`);
    }
  }
};

const encodedAccountFields = (
  entityId: string,
  counterpartyId: string,
  doc: StorageAccountDoc,
): EncodedAccountField[] => {
  assertKnownFields(doc);
  return (Object.keys(STORAGE_ACCOUNT_FIELD_TAG) as StorageAccountField[]).flatMap(field => {
    if (TREE_FIELDS.has(field) || !hasAccountField(doc, field)) return [];
    const tag = STORAGE_ACCOUNT_FIELD_TAG[field];
    const value = encodeBuffer(accountFieldValue(doc, field));
    const chunks = value.byteLength < MAX_INLINE_STORAGE_VALUE_BYTES
      ? []
      : Array.from(
          { length: Math.ceil(value.byteLength / (MAX_INLINE_STORAGE_VALUE_BYTES - 1)) },
          (_, index) => value.subarray(
            index * (MAX_INLINE_STORAGE_VALUE_BYTES - 1),
            (index + 1) * (MAX_INLINE_STORAGE_VALUE_BYTES - 1),
          ),
        );
    return [{
      field,
      tag,
      value,
      valueHash: computeIntegrityDigest(value),
      rows: chunks.length === 0
        ? [{ key: keyLiveAccountField(entityId, counterpartyId, tag), value }]
        : chunks.map((chunk, index) => ({
            key: keyLiveAccountFieldChunk(entityId, counterpartyId, tag, index),
            value: chunk,
          })),
    }];
  }).sort((left, right) => left.tag - right.tag);
};

const manifestValue = (
  fields: readonly StorageAccountFieldDescriptor[],
  trees: readonly StorageAccountTreeDescriptor[],
): Buffer => {
  const value = encodeBuffer({
    version: 4,
    fields,
    trees,
  } satisfies AccountGraphManifest);
  if (value.byteLength >= MAX_INLINE_STORAGE_VALUE_BYTES) {
    throw new Error(`STORAGE_ACCOUNT_MANIFEST_TOO_LARGE:${value.byteLength}`);
  }
  return value;
};

const fieldDescriptors = (
  fields: readonly EncodedAccountField[],
): StorageAccountFieldDescriptor[] => fields.map(({ tag, value, valueHash, rows }) => ({
  tag,
  valueHash,
  byteLength: value.byteLength,
  chunkCount: rows.length === 1 && rows[0]?.key.byteLength === 66 ? 0 : rows.length,
}));

const record = (value: unknown, code: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
};

const exactKeys = (value: Record<string, unknown>, expected: readonly string[], code: string): void => {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new Error(`${code}_FIELDS:${actual.join(',')}`);
  }
};

const decodeHash = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value)) throw new Error(code);
  return value;
};

const decodeTreeDescriptor = (value: unknown, index: number): StorageAccountTreeDescriptor => {
  const tree = record(value, `STORAGE_ACCOUNT_MANIFEST_TREE_${index}`);
  exactKeys(tree, ['namespace', 'rootHash', 'leafCount'], `STORAGE_ACCOUNT_MANIFEST_TREE_${index}`);
  const namespace = tree['namespace'];
  if (typeof namespace !== 'string' || !ACCOUNT_STATE_MAP_NAMESPACES.includes(namespace as AccountStateMapNamespace)) {
    throw new Error(`STORAGE_ACCOUNT_MANIFEST_TREE_NAMESPACE:${String(namespace)}`);
  }
  const leafCount = tree['leafCount'];
  if (!Number.isSafeInteger(leafCount) || Number(leafCount) < 0) {
    throw new Error('STORAGE_ACCOUNT_MANIFEST_TREE_COUNT');
  }
  return {
    namespace: namespace as AccountStateMapNamespace,
    rootHash: decodeHash(tree['rootHash'], 'STORAGE_ACCOUNT_MANIFEST_TREE_ROOT'),
    leafCount: Number(leafCount),
  };
};

const decodeFieldDescriptor = (value: unknown, index: number): StorageAccountFieldDescriptor => {
  const field = record(value, `STORAGE_ACCOUNT_MANIFEST_FIELD_${index}`);
  exactKeys(
    field,
    ['tag', 'valueHash', 'byteLength', 'chunkCount'],
    `STORAGE_ACCOUNT_MANIFEST_FIELD_${index}`,
  );
  const tag = field['tag'];
  if (!Number.isSafeInteger(tag) || Number(tag) < 1 || Number(tag) > 0xff) {
    throw new Error(`STORAGE_ACCOUNT_MANIFEST_FIELD_TAG:${String(tag)}`);
  }
  if (!STORAGE_ACCOUNT_FIELD_BY_TAG.has(Number(tag))) {
    throw new Error(`STORAGE_ACCOUNT_MANIFEST_FIELD_UNKNOWN:${String(tag)}`);
  }
  const byteLength = field['byteLength'];
  const chunkCount = field['chunkCount'];
  if (!Number.isSafeInteger(byteLength) || Number(byteLength) < 1) {
    throw new Error(`STORAGE_ACCOUNT_MANIFEST_FIELD_BYTES:${String(byteLength)}`);
  }
  if (!Number.isSafeInteger(chunkCount) || Number(chunkCount) < 0) {
    throw new Error(`STORAGE_ACCOUNT_MANIFEST_FIELD_CHUNKS:${String(chunkCount)}`);
  }
  if (
    (Number(chunkCount) === 0 && Number(byteLength) >= MAX_INLINE_STORAGE_VALUE_BYTES) ||
    (Number(chunkCount) > 0 && Number(byteLength) < MAX_INLINE_STORAGE_VALUE_BYTES) ||
    Number(chunkCount) !== (
      Number(byteLength) < MAX_INLINE_STORAGE_VALUE_BYTES
        ? 0
        : Math.ceil(Number(byteLength) / (MAX_INLINE_STORAGE_VALUE_BYTES - 1))
    )
  ) {
    throw new Error(`STORAGE_ACCOUNT_MANIFEST_FIELD_LAYOUT:${String(byteLength)}:${String(chunkCount)}`);
  }
  return {
    tag: Number(tag),
    valueHash: decodeHash(field['valueHash'], 'STORAGE_ACCOUNT_MANIFEST_FIELD_HASH'),
    byteLength: Number(byteLength),
    chunkCount: Number(chunkCount),
  };
};

/** Strict boundary decoder shared by recovery and snapshot graph verification. */
export const decodeAccountGraphManifest = (value: Buffer): AccountGraphManifest => {
  const manifest = record(decodeBuffer(value), 'STORAGE_ACCOUNT_MANIFEST_INVALID');
  exactKeys(manifest, ['version', 'fields', 'trees'], 'STORAGE_ACCOUNT_MANIFEST');
  if (manifest['version'] !== 4 || !Array.isArray(manifest['fields']) || !Array.isArray(manifest['trees'])) {
    throw new Error('STORAGE_ACCOUNT_MANIFEST_VERSION');
  }
  const fields = manifest['fields'].map((raw, index) => decodeFieldDescriptor(raw, index));
  if (fields.some((field, index) => index > 0 && fields[index - 1]!.tag >= field.tag)) {
    throw new Error('STORAGE_ACCOUNT_MANIFEST_FIELD_ORDER');
  }
  const trees = manifest['trees'].map((raw, index) => decodeTreeDescriptor(raw, index));
  if (new Set(trees.map(tree => tree.namespace)).size !== trees.length) throw new Error('STORAGE_ACCOUNT_MANIFEST_TREE_DUPLICATE');
  return {
    version: 4,
    fields,
    trees,
  };
};

export const prepareAccountStorageLayout = async (
  _db: RuntimeDbLike,
  entityId: string,
  counterpartyId: string,
  rootKey: Buffer,
  doc: StorageAccountDoc,
  previous?: StorageAccountDoc,
): Promise<AccountStorageLayout> => {
  const fields = encodedAccountFields(entityId, counterpartyId, doc);
  const priorFields = previous ? encodedAccountFields(entityId, counterpartyId, previous) : [];
  const priorByTag = new Map(priorFields.map(field => [field.tag, field]));
  const nextTags = new Set(fields.map(field => field.tag));
  const trees = projectAccountTreeDescriptors(doc);
  const rootValue = manifestValue(fieldDescriptors(fields), trees);
  const graph = projectAccountTreeChanges(entityId, counterpartyId, doc, previous);
  const changedFields = fields.filter(field => priorByTag.get(field.tag)?.valueHash !== field.valueHash);
  const nextRowKeysByTag = new Map(changedFields.map(field => [
    field.tag,
    new Set(field.rows.map(row => row.key.toString('hex'))),
  ]));
  return {
    representation: 'graph',
    logicalValue: rootValue,
    logicalHash: computeIntegrityDigest(rootValue),
    rootValue,
    puts: [
      { key: rootKey, value: rootValue },
      ...changedFields.flatMap(field => field.rows),
      ...graph.puts,
    ],
    dels: [
      ...priorFields.flatMap(field => {
        const nextRowKeys = nextRowKeysByTag.get(field.tag);
        if (nextTags.has(field.tag) && !nextRowKeys) return [];
        return field.rows
          .filter(row => !nextRowKeys?.has(row.key.toString('hex')))
          .map(row => row.key);
      }),
      ...graph.dels,
    ],
  };
};

const readAccountField = async (
  db: RuntimeDbLike,
  entityId: string,
  counterpartyId: string,
  descriptor: StorageAccountFieldDescriptor,
): Promise<Buffer> => {
  if (descriptor.chunkCount === 0) {
    const value = await readRawOrNull(
      db,
      keyLiveAccountField(entityId, counterpartyId, descriptor.tag),
    );
    if (!value) throw new Error(`STORAGE_ACCOUNT_FIELD_ROW_MISSING:${descriptor.tag}`);
    if (value.byteLength !== descriptor.byteLength) {
      throw new Error(
        `STORAGE_ACCOUNT_FIELD_BYTES_MISMATCH:${descriptor.tag}:` +
        `${descriptor.byteLength}:${value.byteLength}`,
      );
    }
    return value;
  }
  const chunks = await Promise.all(Array.from(
    { length: descriptor.chunkCount },
    (_, index) => readRawOrNull(
      db,
      keyLiveAccountFieldChunk(entityId, counterpartyId, descriptor.tag, index),
    ),
  ));
  const missing = chunks.findIndex(chunk => chunk === null);
  if (missing >= 0) throw new Error(`STORAGE_ACCOUNT_FIELD_CHUNK_MISSING:${descriptor.tag}:${missing}`);
  const value = Buffer.concat(chunks as Buffer[]);
  if (value.byteLength !== descriptor.byteLength) {
    throw new Error(
      `STORAGE_ACCOUNT_FIELD_BYTES_MISMATCH:${descriptor.tag}:` +
      `${descriptor.byteLength}:${value.byteLength}`,
    );
  }
  return value;
};

export const prepareAccountStorageDelete = async (
  db: RuntimeDbLike,
  entityId: string,
  counterpartyId: string,
  rootKey: Buffer,
): Promise<Buffer[]> => {
  const root = await readRawOrNull(db, rootKey);
  if (!root) return [];
  decodeAccountGraphManifest(root);
  return [
    rootKey,
    ...await (async (): Promise<Buffer[]> => {
      const keys: Buffer[] = [];
      for await (const key of iterateKeys(db, { prefix: keyLiveAccountFieldPrefix(entityId, counterpartyId) })) {
        keys.push(key);
      }
      return keys;
    })(),
    ...await accountTreeStorageKeys(db, entityId, counterpartyId),
  ];
};

const installTree = (
  state: Record<string, unknown>,
  replica: Record<string, unknown>,
  namespace: AccountStateMapNamespace,
  tree: unknown,
): void => {
  if (namespace === 'pendingWithdrawals') {
    replica['pendingWithdrawals'] = tree;
    return;
  }
  if (namespace === 'rebalanceShadowPolicy' || namespace === 'rebalanceShadowSubmitted') {
    const shadow = record(replica['shadow'], 'STORAGE_ACCOUNT_SHADOW_INVALID');
    const rebalance = record(shadow['rebalance'], 'STORAGE_ACCOUNT_SHADOW_REBALANCE_INVALID');
    replica['shadow'] = {
      ...shadow,
      rebalance: {
        ...rebalance,
        [namespace === 'rebalanceShadowPolicy' ? 'policy' : 'submittedAtByToken']: tree,
      },
    };
    return;
  }
  state[namespace] = tree;
};

export const readAccountStorageLayout = async (
  db: RuntimeDbLike,
  entityId: string,
  counterpartyId: string,
  rootKey: Buffer,
): Promise<{ doc: StorageAccountDoc; logicalValue: Buffer; representation: 'graph' } | null> => {
  const root = await readRawOrNull(db, rootKey);
  if (!root) return null;
  const manifest = decodeAccountGraphManifest(root);
  const replica: Record<string, unknown> = {};
  const state: Record<string, unknown> = {};
  for (const descriptor of manifest.fields) {
    const field = STORAGE_ACCOUNT_FIELD_BY_TAG.get(descriptor.tag);
    if (!field) throw new Error(`STORAGE_ACCOUNT_MANIFEST_FIELD_UNKNOWN:${descriptor.tag}`);
    const value = await readAccountField(db, entityId, counterpartyId, descriptor);
    const actualHash = computeIntegrityDigest(value);
    if (actualHash !== descriptor.valueHash) {
      throw new Error(`STORAGE_ACCOUNT_FIELD_HASH_MISMATCH:${field}:${descriptor.valueHash}:${actualHash}`);
    }
    const decoded = decodeBuffer(value);
    if (isStateField(field)) state[stateFieldName(field)] = decoded;
    else replica[field] = decoded;
  }
  replica['state'] = state;
  const trees = await hydrateAccountTrees(db, entityId, counterpartyId, manifest.trees);
  for (const [namespace, tree] of trees) installTree(state, replica, namespace, tree);
  const doc = validateStorageAccountDocValue({ ...replica, state });
  return { doc, logicalValue: root, representation: 'graph' };
};
