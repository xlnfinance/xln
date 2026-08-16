/**
 * Patricia storage for the bounded Account replica envelope.
 * Arrays and nested records remain their exact RAM values, but LevelDB owns
 * one typed row per container/atom so no frame, mempool, or proof is a blob.
 * Human-audit importance: 100/100 — crash restore depends on this exact graph.
 */
import { PersistentRadixValueMap } from '../../protocol/state/persistent-radix-value-map';
import type {
  PersistentRadixNodeRecord,
  PersistentRadixNodeRef,
} from '../../protocol/state/persistent-radix-value-map';
import { radixMerklePathSlots } from '../../protocol/state/radix-merkle';
import {
  STORAGE_VALUE_GRAPH_OPTIONS,
  buildStorageValueGraph,
  decodeStorageValueGraphBranch,
  decodeStorageValueGraphPath,
  decodeStorageValueGraphValue,
  rebuildStorageValueGraph,
  storageValueGraphBranchValue,
  storageValueGraphPathBytes,
  type StorageValueGraphPath,
  type StorageValueGraphValue,
} from '../wal/runtime-machine-graph';
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

export const ACCOUNT_ENVELOPE_NAMESPACE_TAG = 0xff;
export const MAX_ACCOUNT_ENVELOPE_ROW_BYTES = 10_000;

export type StorageAccountEnvelopeDescriptor = Readonly<{
  rootHash: string;
  leafCount: number;
}>;

type EnvelopeNodeRecord = PersistentRadixNodeRecord<StorageValueGraphPath, StorageValueGraphValue>;
type EnvelopeRow = Readonly<{ key: Buffer; value: Buffer }>;

const exactBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);

const boundedRow = (key: Buffer, value: unknown): EnvelopeRow => {
  const encoded = encodeBuffer(value, { omitSymbolKeys: true });
  if (encoded.byteLength >= MAX_ACCOUNT_ENVELOPE_ROW_BYTES) {
    throw new Error(`STORAGE_ACCOUNT_ENVELOPE_ROW_TOO_LARGE:${encoded.byteLength}:${key.toString('hex')}`);
  }
  return { key, value: encoded };
};

const rowForRecord = (
  entityId: string,
  counterpartyId: string,
  record: EnvelopeNodeRecord,
): EnvelopeRow => record.kind === 'branch'
  ? boundedRow(
      keyLiveAccountBranch(entityId, counterpartyId, ACCOUNT_ENVELOPE_NAMESPACE_TAG, record.path),
      storageValueGraphBranchValue(record),
    )
  : boundedRow(
      keyLiveAccountLeaf(entityId, counterpartyId, ACCOUNT_ENVELOPE_NAMESPACE_TAG, record.keyBytes),
      record.value,
    );

const keyForRef = (
  entityId: string,
  counterpartyId: string,
  record: PersistentRadixNodeRef,
): Buffer => record.kind === 'branch'
  ? keyLiveAccountBranch(entityId, counterpartyId, ACCOUNT_ENVELOPE_NAMESPACE_TAG, record.path)
  : keyLiveAccountLeaf(
      entityId,
      counterpartyId,
      ACCOUNT_ENVELOPE_NAMESPACE_TAG,
      record.keyBytes ?? (() => { throw new Error('STORAGE_ACCOUNT_ENVELOPE_LEAF_KEY_MISSING'); })(),
    );

export const projectAccountEnvelopeGraph = (value: unknown): Readonly<{
  descriptor: StorageAccountEnvelopeDescriptor;
  graph: ReturnType<typeof buildStorageValueGraph>;
}> => {
  const graph = buildStorageValueGraph(value);
  return {
    descriptor: { rootHash: graph.rootHash(), leafCount: graph.size },
    graph,
  };
};

export const projectAccountEnvelopeGraphChanges = (
  entityId: string,
  counterpartyId: string,
  value: unknown,
  previous?: unknown,
): Readonly<{
  descriptor: StorageAccountEnvelopeDescriptor;
  puts: EnvelopeRow[];
  dels: Buffer[];
}> => {
  const next = projectAccountEnvelopeGraph(value);
  const changes = previous === undefined
    ? { puts: [...next.graph.nodeRecords()], dels: [] as PersistentRadixNodeRef[] }
    : next.graph.nodeChangesSince(projectAccountEnvelopeGraph(previous).graph);
  return {
    descriptor: next.descriptor,
    puts: changes.puts.map(record => rowForRecord(entityId, counterpartyId, record)),
    dels: changes.dels.map(record => keyForRef(entityId, counterpartyId, record)),
  };
};

const readEnvelopeRecords = async (
  db: RuntimeDbLike,
  entityId: string,
  counterpartyId: string,
): Promise<EnvelopeNodeRecord[]> => {
  const records: EnvelopeNodeRecord[] = [];
  const branchPrefix = keyLiveAccountTreePrefix(
    KEY_LIVE_ACCOUNT_BRANCH,
    entityId,
    counterpartyId,
    ACCOUNT_ENVELOPE_NAMESPACE_TAG,
  );
  for await (const key of iterateKeys(db, { prefix: branchPrefix })) {
    const parsed = parseLiveAccountBranchKey(key);
    if (parsed.namespaceTag !== ACCOUNT_ENVELOPE_NAMESPACE_TAG) {
      throw new Error('STORAGE_ACCOUNT_ENVELOPE_BRANCH_NAMESPACE');
    }
    records.push(decodeStorageValueGraphBranch(decodeBuffer(await db.get(key)), parsed.path));
  }
  const leafPrefix = keyLiveAccountTreePrefix(
    KEY_LIVE_ACCOUNT_LEAF,
    entityId,
    counterpartyId,
    ACCOUNT_ENVELOPE_NAMESPACE_TAG,
  );
  for await (const key of iterateKeys(db, { prefix: leafPrefix })) {
    const parsed = parseLiveAccountLeafKey(key);
    if (parsed.namespaceTag !== ACCOUNT_ENVELOPE_NAMESPACE_TAG) {
      throw new Error('STORAGE_ACCOUNT_ENVELOPE_LEAF_NAMESPACE');
    }
    const path = decodeStorageValueGraphPath(
      decodeBuffer(parsed.payload),
      'STORAGE_ACCOUNT_ENVELOPE_LEAF_PATH',
    );
    if (!exactBytes(storageValueGraphPathBytes(path), parsed.payload)) {
      throw new Error('STORAGE_ACCOUNT_ENVELOPE_LEAF_PATH_NON_CANONICAL');
    }
    records.push({
      kind: 'leaf',
      path: radixMerklePathSlots(parsed.payload, 16),
      key: path,
      keyBytes: Uint8Array.from(parsed.payload),
      value: decodeStorageValueGraphValue(
        decodeBuffer(await db.get(key)),
        'STORAGE_ACCOUNT_ENVELOPE_LEAF_VALUE',
      ),
    });
  }
  return records;
};

export const readAccountEnvelopeGraph = async (
  db: RuntimeDbLike,
  entityId: string,
  counterpartyId: string,
  expected: StorageAccountEnvelopeDescriptor,
): Promise<unknown> => {
  const graph = PersistentRadixValueMap.fromNodeRecords(
    await readEnvelopeRecords(db, entityId, counterpartyId),
    STORAGE_VALUE_GRAPH_OPTIONS,
  );
  if (graph.rootHash() !== expected.rootHash || graph.size !== expected.leafCount) {
    throw new Error(
      `STORAGE_ACCOUNT_ENVELOPE_ROOT_MISMATCH:` +
      `expected=${expected.rootHash}/${expected.leafCount}:` +
      `actual=${graph.rootHash()}/${graph.size}`,
    );
  }
  return rebuildStorageValueGraph(graph);
};
