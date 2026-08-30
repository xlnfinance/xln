/**
 * Canonical Entity checkpoint layout.
 *
 * The root is a small static manifest. Scalar fields live at permanent tagged
 * keys and large values are deterministic chunks. Growing Entity collections
 * are the exact in-memory Patricia nodes, never a recursively rebuilt document
 * tree. One outer Runtime WAL batch atomically installs every row.
 */
import type { EntityState } from '../../../entity/types';
import { computeIntegrityDigest } from '../../../support/bytes/integrity-checksum';
import { decodeBuffer, encodeBuffer } from '../../codec/codec';
import { iterateKeys, readRawOrNull } from '../../database/level';
import {
  STORAGE_SCHEMA_VERSION,
  keyLiveEntityField,
  keyLiveEntityFieldChunk,
  keyLiveEntityFieldPrefix,
} from '../../keys';
import type { RuntimeDbLike, StorageEntityCoreDoc } from '../../types';
import {
  projectEntityScalarDoc,
  type EntityStorageTreeField,
  type StorageEntityScalarDoc,
} from '../../read/projections';
import { validateStorageEntityCoreDocValue } from '../schema-state-docs';
import {
  ENTITY_COLLECTION_NAMESPACES,
  entityTreeStorageKeys,
  hydrateEntityTrees,
  projectEntityTreeChanges,
  projectEntityTreeDescriptors,
  type EntityCollectionNamespace,
  type StorageEntityTreeDescriptor,
} from './graph-codec';
import {
  STORAGE_ENTITY_FIELD_BY_TAG,
  STORAGE_ENTITY_FIELD_TAG,
  type StorageEntityField,
} from './field-tags';

export const MAX_ENTITY_STORAGE_VALUE_BYTES = 10_000;

type EntityGraphManifest = Readonly<{
  schemaVersion: typeof STORAGE_SCHEMA_VERSION;
  fields: readonly StorageEntityFieldDescriptor[];
  trees: readonly StorageEntityTreeDescriptor[];
}>;

type StorageEntityFieldDescriptor = Readonly<{
  tag: number;
  valueHash: string;
  byteLength: number;
  chunkCount: number;
}>;

type EncodedEntityField = Readonly<{
  field: Exclude<StorageEntityField, EntityStorageTreeField>;
  tag: number;
  value: Buffer;
  valueHash: string;
  rows: readonly Readonly<{ key: Buffer; value: Buffer }>[];
}>;

export type EntityStorageLayout = Readonly<{
  rootValue: Buffer;
  puts: readonly Readonly<{ key: Buffer; value: Buffer }>[];
  dels: readonly Buffer[];
}>;

const TREE_FIELDS = new Set<string>(ENTITY_COLLECTION_NAMESPACES);

const encodedEntityFields = (
  entityId: string,
  state: EntityState,
): EncodedEntityField[] => {
  const doc = projectEntityScalarDoc(state);
  return (Object.keys(STORAGE_ENTITY_FIELD_TAG) as StorageEntityField[]).flatMap(field => {
    if (TREE_FIELDS.has(field) || !Object.hasOwn(doc, field)) return [];
    const scalarField = field as keyof StorageEntityScalarDoc;
    const tag = STORAGE_ENTITY_FIELD_TAG[field];
    const value = encodeBuffer(doc[scalarField]);
    const chunks = value.byteLength < MAX_ENTITY_STORAGE_VALUE_BYTES
      ? []
      : Array.from(
          { length: Math.ceil(value.byteLength / (MAX_ENTITY_STORAGE_VALUE_BYTES - 1)) },
          (_, index) => value.subarray(
            index * (MAX_ENTITY_STORAGE_VALUE_BYTES - 1),
            (index + 1) * (MAX_ENTITY_STORAGE_VALUE_BYTES - 1),
          ),
        );
    return [{
      field: field as Exclude<StorageEntityField, EntityStorageTreeField>,
      tag,
      value,
      valueHash: computeIntegrityDigest(value),
      rows: chunks.length === 0
        ? [{ key: keyLiveEntityField(entityId, tag), value }]
        : chunks.map((chunk, index) => ({
            key: keyLiveEntityFieldChunk(entityId, tag, index),
            value: chunk,
          })),
    }];
  }).sort((left, right) => left.tag - right.tag);
};

const fieldDescriptors = (
  fields: readonly EncodedEntityField[],
): StorageEntityFieldDescriptor[] => fields.map(({ tag, value, valueHash, rows }) => ({
  tag,
  valueHash,
  byteLength: value.byteLength,
  chunkCount: rows.length === 1 && rows[0]?.key.byteLength === 34 ? 0 : rows.length,
}));

const manifestValue = (
  fields: readonly StorageEntityFieldDescriptor[],
  trees: readonly StorageEntityTreeDescriptor[],
): Buffer => {
  const value = encodeBuffer({ schemaVersion: STORAGE_SCHEMA_VERSION, fields, trees } satisfies EntityGraphManifest);
  if (value.byteLength >= MAX_ENTITY_STORAGE_VALUE_BYTES) {
    throw new Error(`STORAGE_ENTITY_MANIFEST_TOO_LARGE:${value.byteLength}`);
  }
  return value;
};

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

const decodeFieldDescriptor = (value: unknown, index: number): StorageEntityFieldDescriptor => {
  const field = record(value, `STORAGE_ENTITY_MANIFEST_FIELD_${index}`);
  exactKeys(field, ['tag', 'valueHash', 'byteLength', 'chunkCount'], `STORAGE_ENTITY_MANIFEST_FIELD_${index}`);
  const tag = Number(field['tag']);
  const byteLength = Number(field['byteLength']);
  const chunkCount = Number(field['chunkCount']);
  const fieldName = STORAGE_ENTITY_FIELD_BY_TAG.get(tag);
  if (!Number.isSafeInteger(tag) || fieldName === undefined || TREE_FIELDS.has(fieldName)) {
    throw new Error(`STORAGE_ENTITY_MANIFEST_FIELD_TAG:${String(field['tag'])}`);
  }
  if (!Number.isSafeInteger(byteLength) || byteLength < 1) {
    throw new Error(`STORAGE_ENTITY_MANIFEST_FIELD_BYTES:${String(field['byteLength'])}`);
  }
  const expectedChunks = byteLength < MAX_ENTITY_STORAGE_VALUE_BYTES
    ? 0
    : Math.ceil(byteLength / (MAX_ENTITY_STORAGE_VALUE_BYTES - 1));
  if (!Number.isSafeInteger(chunkCount) || chunkCount !== expectedChunks) {
    throw new Error(`STORAGE_ENTITY_MANIFEST_FIELD_LAYOUT:${byteLength}:${chunkCount}`);
  }
  return {
    tag,
    valueHash: decodeHash(field['valueHash'], 'STORAGE_ENTITY_MANIFEST_FIELD_HASH'),
    byteLength,
    chunkCount,
  };
};

const decodeTreeDescriptor = (value: unknown, index: number): StorageEntityTreeDescriptor => {
  const tree = record(value, `STORAGE_ENTITY_MANIFEST_TREE_${index}`);
  exactKeys(tree, ['namespace', 'rootHash', 'leafCount'], `STORAGE_ENTITY_MANIFEST_TREE_${index}`);
  const namespace = tree['namespace'];
  const leafCount = Number(tree['leafCount']);
  if (typeof namespace !== 'string' || !ENTITY_COLLECTION_NAMESPACES.includes(
    namespace as EntityCollectionNamespace,
  )) throw new Error(`STORAGE_ENTITY_MANIFEST_TREE_NAMESPACE:${String(namespace)}`);
  if (!Number.isSafeInteger(leafCount) || leafCount < 0) {
    throw new Error(`STORAGE_ENTITY_MANIFEST_TREE_COUNT:${String(tree['leafCount'])}`);
  }
  return {
    namespace: namespace as EntityCollectionNamespace,
    rootHash: decodeHash(tree['rootHash'], 'STORAGE_ENTITY_MANIFEST_TREE_ROOT'),
    leafCount,
  };
};

export const decodeEntityGraphManifest = (value: Buffer): EntityGraphManifest => {
  const manifest = record(decodeBuffer(value), 'STORAGE_ENTITY_MANIFEST_INVALID');
  exactKeys(manifest, ['schemaVersion', 'fields', 'trees'], 'STORAGE_ENTITY_MANIFEST');
  if (manifest['schemaVersion'] !== STORAGE_SCHEMA_VERSION) throw new Error('STORAGE_ENTITY_MANIFEST_VERSION');
  if (!Array.isArray(manifest['fields']) || !Array.isArray(manifest['trees'])) {
    throw new Error('STORAGE_ENTITY_MANIFEST_ARRAYS');
  }
  const fields = manifest['fields'].map(decodeFieldDescriptor);
  if (fields.some((field, index) => {
    const previous = fields[index - 1];
    return previous !== undefined && previous.tag >= field.tag;
  })) {
    throw new Error('STORAGE_ENTITY_MANIFEST_FIELD_ORDER');
  }
  const trees = manifest['trees'].map(decodeTreeDescriptor);
  if (new Set(trees.map(tree => tree.namespace)).size !== trees.length) {
    throw new Error('STORAGE_ENTITY_MANIFEST_TREE_DUPLICATE');
  }
  return { schemaVersion: STORAGE_SCHEMA_VERSION, fields, trees };
};

export const prepareEntityStorageLayout = (
  entityId: string,
  rootKey: Buffer,
  state: EntityState,
  previous?: EntityState,
): EntityStorageLayout => {
  const fields = encodedEntityFields(entityId, state);
  const priorFields = previous ? encodedEntityFields(entityId, previous) : [];
  const priorByTag = new Map(priorFields.map(field => [field.tag, field]));
  const nextTags = new Set(fields.map(field => field.tag));
  const changedFields = fields.filter(field => priorByTag.get(field.tag)?.valueHash !== field.valueHash);
  const nextRowKeysByTag = new Map(changedFields.map(field => [
    field.tag,
    new Set(field.rows.map(row => row.key.toString('hex'))),
  ]));
  const trees = projectEntityTreeDescriptors(state);
  const graph = projectEntityTreeChanges(entityId, state, previous);
  const rootValue = manifestValue(fieldDescriptors(fields), trees);
  return {
    rootValue,
    puts: [{ key: rootKey, value: rootValue }, ...changedFields.flatMap(field => field.rows), ...graph.puts],
    dels: [
      ...priorFields.flatMap(field => {
        const nextRowKeys = nextRowKeysByTag.get(field.tag);
        if (nextTags.has(field.tag) && !nextRowKeys) return [];
        return field.rows.filter(row => !nextRowKeys?.has(row.key.toString('hex'))).map(row => row.key);
      }),
      ...graph.dels,
    ],
  };
};

const readEntityField = async (
  db: RuntimeDbLike,
  entityId: string,
  descriptor: StorageEntityFieldDescriptor,
): Promise<Buffer> => {
  const rows = descriptor.chunkCount === 0
    ? [await readRawOrNull(db, keyLiveEntityField(entityId, descriptor.tag))]
    : await Promise.all(Array.from({ length: descriptor.chunkCount }, (_, index) =>
        readRawOrNull(db, keyLiveEntityFieldChunk(entityId, descriptor.tag, index))));
  const missing = rows.findIndex(row => row === null);
  if (missing >= 0) throw new Error(`STORAGE_ENTITY_FIELD_ROW_MISSING:${descriptor.tag}:${missing}`);
  const inline = rows[0];
  if (descriptor.chunkCount === 0 && inline === null) {
    throw new Error(`STORAGE_ENTITY_FIELD_ROW_MISSING:${descriptor.tag}:0`);
  }
  const value = descriptor.chunkCount === 0 ? inline as Buffer : Buffer.concat(rows as Buffer[]);
  if (value.byteLength !== descriptor.byteLength) {
    throw new Error(`STORAGE_ENTITY_FIELD_BYTES_MISMATCH:${descriptor.tag}:${descriptor.byteLength}:${value.byteLength}`);
  }
  if (computeIntegrityDigest(value) !== descriptor.valueHash) {
    throw new Error(`STORAGE_ENTITY_FIELD_HASH_MISMATCH:${descriptor.tag}`);
  }
  return value;
};

export const readEntityStorageLayout = async (
  db: RuntimeDbLike,
  entityId: string,
  rootKey: Buffer,
): Promise<{ doc: StorageEntityCoreDoc; rootValue: Buffer } | null> => {
  const rootValue = await readRawOrNull(db, rootKey);
  if (!rootValue) return null;
  const manifest = decodeEntityGraphManifest(rootValue);
  const raw: Record<string, unknown> = {};
  for (const descriptor of manifest.fields) {
    const field = STORAGE_ENTITY_FIELD_BY_TAG.get(descriptor.tag);
    if (!field || TREE_FIELDS.has(field)) throw new Error(`STORAGE_ENTITY_FIELD_UNKNOWN:${descriptor.tag}`);
    raw[field] = decodeBuffer(await readEntityField(db, entityId, descriptor));
  }
  const trees = await hydrateEntityTrees(db, entityId, manifest.trees);
  for (const [namespace, tree] of trees) {
    if (namespace === 'paybookEntries') {
      const paybook = raw['paybook'];
      if (typeof paybook !== 'object' || paybook === null || Array.isArray(paybook)) {
        throw new Error('STORAGE_ENTITY_PAYBOOK_SCALAR_MISSING');
      }
      raw['paybook'] = { ...paybook, entries: tree };
      continue;
    }
    if (namespace !== 'crontabHooks') {
      raw[namespace] = tree;
      continue;
    }
    const crontab = raw['crontabState'];
    if (typeof crontab !== 'object' || crontab === null || Array.isArray(crontab)) {
      throw new Error('STORAGE_ENTITY_CRONTAB_TASKS_MISSING');
    }
    raw['crontabState'] = { ...crontab, hooks: tree };
  }
  const validated = validateStorageEntityCoreDocValue(raw);
  return { doc: validated, rootValue };
};

export const prepareEntityStorageDelete = async (
  db: RuntimeDbLike,
  entityId: string,
  rootKey: Buffer,
): Promise<Buffer[]> => {
  const root = await readRawOrNull(db, rootKey);
  if (!root) return [];
  decodeEntityGraphManifest(root);
  const keys: Buffer[] = [rootKey];
  for await (const key of iterateKeys(db, { prefix: keyLiveEntityFieldPrefix(entityId) })) keys.push(key);
  keys.push(...await entityTreeStorageKeys(db, entityId));
  return keys;
};
