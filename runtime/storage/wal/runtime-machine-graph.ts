/**
 * Runtime checkpoint storage is the exact structural projection of the RAM
 * value, not a machine blob. Containers become typed Patricia paths and only
 * bounded atoms live in leaves; the frame commits one root and leaf count.
 */
import { computeIntegrityDigest } from '../../infra/integrity-checksum';
import {
  toRuntimeMachineRootHash,
} from '../../protocol/hashes';
import {
  PersistentRadixValueMap,
  type PersistentRadixBranchRecord,
  type PersistentRadixNodeRecord,
} from '../../protocol/state/persistent-radix-value-map';
import {
  packRadixMerklePath,
  radixMerklePathSlots,
  unpackRadixMerklePath,
} from '../../protocol/state/radix-merkle';
import { validateStorageSafeValue } from '../../protocol/boundary/boundary-primitives';
import { decodeBuffer, encodeBuffer } from '../codec/codec';
import { iterateKeys } from '../database/level';
import {
  KEY_RUNTIME_MACHINE_BRANCH,
  KEY_RUNTIME_MACHINE_LEAF,
  keyRuntimeMachineBranch,
  keyRuntimeMachineLeaf,
  keyRuntimeMachineTreePrefix,
  parseRuntimeMachineBranchKey,
  parseRuntimeMachineLeafKey,
} from '../keys';
import type {
  RuntimeDbLike,
  RuntimeMachineGraphRoot,
} from '../types';
import { validateDurableRuntimeMachineSnapshot } from './runtime-machine-schema';

export const MAX_RUNTIME_MACHINE_GRAPH_ROW_BYTES = 10_000;
const MAX_RUNTIME_MACHINE_GRAPH_DEPTH = 64;

type PropertySegment = Readonly<{ kind: 'property'; name: string }>;
type ArraySegment = Readonly<{ kind: 'array'; index: number }>;
type MapSegment = Readonly<{ kind: 'map'; index: number; key: unknown }>;
type SetSegment = Readonly<{ kind: 'set'; index: number }>;
export type StorageValueGraphPathSegment = PropertySegment | ArraySegment | MapSegment | SetSegment;
export type StorageValueGraphPath = readonly StorageValueGraphPathSegment[];

export type StorageValueGraphValue =
  | Readonly<{ kind: 'atom'; value: unknown }>
  | Readonly<{ kind: 'container'; container: 'object' | 'array' | 'map' | 'set' }>;

export type StorageValueGraph = PersistentRadixValueMap<
  StorageValueGraphPath,
  StorageValueGraphValue
>;

export type RuntimeMachineGraphRow = Readonly<{ key: Buffer; value: Buffer }>;

const record = (value: unknown, code: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(code);
  }
  return value as Record<string, unknown>;
};

const exactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
  code: string,
): void => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${code}_FIELDS:${actual.join(',')}`);
  }
};

const index = (value: unknown, code: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(code);
  return Number(value);
};

const decodeSegment = (value: unknown, code: string): StorageValueGraphPathSegment => {
  const source = record(value, code);
  const kind = source['kind'];
  if (kind === 'property') {
    exactKeys(source, ['kind', 'name'], code);
    if (typeof source['name'] !== 'string' || source['name'].length === 0) {
      throw new Error(`${code}_NAME`);
    }
    return { kind, name: source['name'] };
  }
  if (kind === 'array') {
    exactKeys(source, ['kind', 'index'], code);
    return { kind, index: index(source['index'], `${code}_INDEX`) };
  }
  if (kind === 'map') {
    exactKeys(source, ['kind', 'index', 'key'], code);
    validateStorageSafeValue(source['key'], `${code}_KEY`);
    return { kind, index: index(source['index'], `${code}_INDEX`), key: source['key'] };
  }
  if (kind === 'set') {
    exactKeys(source, ['kind', 'index'], code);
    return { kind, index: index(source['index'], `${code}_INDEX`) };
  }
  throw new Error(`${code}_KIND`);
};

export const decodeStorageValueGraphPath = (value: unknown, code: string): StorageValueGraphPath => {
  if (!Array.isArray(value) || value.length > MAX_RUNTIME_MACHINE_GRAPH_DEPTH) {
    throw new Error(code);
  }
  return Object.freeze(value.map((segment, offset) =>
    Object.freeze(decodeSegment(segment, `${code}_${offset}`))));
};

export const decodeStorageValueGraphValue = (value: unknown, code: string): StorageValueGraphValue => {
  const source = record(value, code);
  if (source['kind'] === 'atom') {
    exactKeys(source, ['kind', 'value'], code);
    validateStorageSafeValue(source['value'], `${code}_VALUE`);
    return Object.freeze({ kind: 'atom', value: source['value'] });
  }
  if (source['kind'] === 'container') {
    exactKeys(source, ['kind', 'container'], code);
    const container = source['container'];
    if (container !== 'object' && container !== 'array' && container !== 'map' && container !== 'set') {
      throw new Error(`${code}_CONTAINER`);
    }
    return Object.freeze({ kind: 'container', container });
  }
  throw new Error(`${code}_KIND`);
};

const cloneDecoded = <T>(value: T, decoder: (raw: unknown, code: string) => T, code: string): T =>
  decoder(decodeBuffer(encodeBuffer(value, { omitSymbolKeys: true })), code);

export const storageValueGraphPathBytes = (path: StorageValueGraphPath): Uint8Array =>
  encodeBuffer(path, { omitSymbolKeys: true });

export const STORAGE_VALUE_GRAPH_OPTIONS = Object.freeze({
  radix: 16 as const,
  ownKey: (path: StorageValueGraphPath): StorageValueGraphPath =>
    cloneDecoded(path, decodeStorageValueGraphPath, 'STORAGE_VALUE_GRAPH_PATH'),
  keyBytes: storageValueGraphPathBytes,
  valueHash: (value: StorageValueGraphValue): string =>
    computeIntegrityDigest(encodeBuffer(value, { omitSymbolKeys: true })).toLowerCase(),
  ownValue: (value: StorageValueGraphValue): StorageValueGraphValue =>
    cloneDecoded(value, decodeStorageValueGraphValue, 'STORAGE_VALUE_GRAPH_VALUE'),
});

const isPlainObject = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const appendGraphEntries = (
  output: Array<readonly [StorageValueGraphPath, StorageValueGraphValue]>,
  value: unknown,
  path: StorageValueGraphPath,
): void => {
  if (path.length > MAX_RUNTIME_MACHINE_GRAPH_DEPTH) {
    throw new Error('STORAGE_RUNTIME_MACHINE_GRAPH_DEPTH_EXCEEDED');
  }
  if (Array.isArray(value)) {
    output.push([path, { kind: 'container', container: 'array' }]);
    value.forEach((child, childIndex) => appendGraphEntries(
      output,
      child,
      [...path, { kind: 'array', index: childIndex }],
    ));
    return;
  }
  if (value instanceof Map) {
    output.push([path, { kind: 'container', container: 'map' }]);
    let childIndex = 0;
    for (const [key, child] of value) {
      validateStorageSafeValue(key, 'STORAGE_RUNTIME_MACHINE_MAP_KEY');
      appendGraphEntries(output, child, [
        ...path,
        { kind: 'map', index: childIndex, key },
      ]);
      childIndex += 1;
    }
    return;
  }
  if (value instanceof Set) {
    output.push([path, { kind: 'container', container: 'set' }]);
    let childIndex = 0;
    for (const child of value) {
      appendGraphEntries(output, child, [...path, { kind: 'set', index: childIndex }]);
      childIndex += 1;
    }
    return;
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Uint8Array) &&
    !Buffer.isBuffer(value)
  ) {
    if (!isPlainObject(value)) throw new Error('STORAGE_RUNTIME_MACHINE_OBJECT_PROTOTYPE');
    output.push([path, { kind: 'container', container: 'object' }]);
    Object.keys(value).sort().forEach(name => appendGraphEntries(
      output,
      (value as Record<string, unknown>)[name],
      [...path, { kind: 'property', name }],
    ));
    return;
  }
  validateStorageSafeValue(value, 'STORAGE_RUNTIME_MACHINE_ATOM');
  output.push([path, { kind: 'atom', value }]);
};

export const buildStorageValueGraph = (value: unknown): StorageValueGraph => {
  const entries: Array<readonly [StorageValueGraphPath, StorageValueGraphValue]> = [];
  appendGraphEntries(entries, value, []);
  return PersistentRadixValueMap.fromMap(entries, STORAGE_VALUE_GRAPH_OPTIONS);
};

const boundedRow = (key: Buffer, value: unknown): RuntimeMachineGraphRow => {
  const encoded = encodeBuffer(value, { omitSymbolKeys: true });
  if (encoded.byteLength >= MAX_RUNTIME_MACHINE_GRAPH_ROW_BYTES) {
    throw new Error(
      `STORAGE_RUNTIME_MACHINE_GRAPH_ROW_TOO_LARGE:${encoded.byteLength}:` +
      `${key.toString('hex')}`,
    );
  }
  return { key, value: encoded };
};

/** Parent key already owns the common path; repeating it per child can exceed 10 KB. */
export const storageValueGraphBranchValue = (branch: PersistentRadixBranchRecord) => ({
  children: branch.children.map(child => ({
    slot: child.slot,
    kind: child.kind,
    suffix: packRadixMerklePath(16, child.path.slice(branch.path.length)),
    edgeHash: child.edgeHash,
  })),
});

export const prepareRuntimeMachineGraphRows = (
  height: number,
  machine: Readonly<Record<string, unknown>> | undefined,
): Readonly<{
  root?: RuntimeMachineGraphRoot;
  rows: readonly RuntimeMachineGraphRow[];
}> => {
  if (!machine) return { rows: [] };
  const graph = buildStorageValueGraph(machine);
  const rows = [...graph.nodeRecords()].map(record => record.kind === 'branch'
    ? boundedRow(keyRuntimeMachineBranch(height, record.path), storageValueGraphBranchValue(record))
    : boundedRow(keyRuntimeMachineLeaf(height, record.keyBytes), record.value));
  return {
    root: Object.freeze({
      rootHash: toRuntimeMachineRootHash(graph.rootHash()),
      leafCount: graph.size,
    }),
    rows,
  };
};

export const decodeRuntimeMachineGraphRoot = (
  value: unknown,
  code: string,
): RuntimeMachineGraphRoot => {
  const source = record(value, code);
  exactKeys(source, ['rootHash', 'leafCount'], code);
  return Object.freeze({
    rootHash: toRuntimeMachineRootHash(String(source['rootHash'])),
    leafCount: index(source['leafCount'], `${code}_LEAF_COUNT`),
  });
};

const decodeChild = (
  value: unknown,
  parentPath: readonly number[],
  code: string,
) => {
  const child = record(value, code);
  exactKeys(child, ['slot', 'kind', 'suffix', 'edgeHash'], code);
  const slot = index(child['slot'], `${code}_SLOT`);
  if (slot >= 16) throw new Error(`${code}_SLOT`);
  const kind = child['kind'];
  if (kind !== 'branch' && kind !== 'leaf') throw new Error(`${code}_KIND`);
  if (!(child['suffix'] instanceof Uint8Array)) throw new Error(`${code}_SUFFIX`);
  const suffix = unpackRadixMerklePath(16, child['suffix']);
  if (suffix.length === 0 || suffix[0] !== slot) throw new Error(`${code}_SUFFIX_SLOT`);
  const path = [...parentPath, ...suffix];
  if (typeof child['edgeHash'] !== 'string' || !/^0x[0-9a-f]{64}$/.test(child['edgeHash'])) {
    throw new Error(`${code}_EDGE_HASH`);
  }
  return { slot, kind, path, edgeHash: child['edgeHash'] } as const;
};

export const decodeStorageValueGraphBranch = (
  value: unknown,
  path: readonly number[],
): PersistentRadixBranchRecord => {
  const source = record(value, 'STORAGE_RUNTIME_MACHINE_BRANCH');
  exactKeys(source, ['children'], 'STORAGE_RUNTIME_MACHINE_BRANCH');
  if (!Array.isArray(source['children'])) throw new Error('STORAGE_RUNTIME_MACHINE_BRANCH_CHILDREN');
  return {
    kind: 'branch',
    path: [...path],
    children: source['children'].map((child, offset) =>
      decodeChild(child, path, `STORAGE_RUNTIME_MACHINE_BRANCH_CHILD_${offset}`)),
  };
};

const exactBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);

const readGraphRecords = async (
  db: RuntimeDbLike,
  height: number,
): Promise<PersistentRadixNodeRecord<StorageValueGraphPath, StorageValueGraphValue>[]> => {
  const records: PersistentRadixNodeRecord<StorageValueGraphPath, StorageValueGraphValue>[] = [];
  const branchPrefix = keyRuntimeMachineTreePrefix(KEY_RUNTIME_MACHINE_BRANCH, height);
  for await (const key of iterateKeys(db, { prefix: branchPrefix })) {
    const parsed = parseRuntimeMachineBranchKey(key);
    if (parsed.height !== height) throw new Error('STORAGE_RUNTIME_MACHINE_BRANCH_HEIGHT');
    records.push(decodeStorageValueGraphBranch(decodeBuffer(await db.get(key)), parsed.path));
  }
  const leafPrefix = keyRuntimeMachineTreePrefix(KEY_RUNTIME_MACHINE_LEAF, height);
  for await (const key of iterateKeys(db, { prefix: leafPrefix })) {
    const parsed = parseRuntimeMachineLeafKey(key);
    if (parsed.height !== height) throw new Error('STORAGE_RUNTIME_MACHINE_LEAF_HEIGHT');
    const path = decodeStorageValueGraphPath(decodeBuffer(parsed.payload), 'STORAGE_RUNTIME_MACHINE_LEAF_PATH');
    if (!exactBytes(storageValueGraphPathBytes(path), parsed.payload)) {
      throw new Error('STORAGE_RUNTIME_MACHINE_LEAF_PATH_NON_CANONICAL');
    }
    const value = decodeStorageValueGraphValue(
      decodeBuffer(await db.get(key)),
      'STORAGE_RUNTIME_MACHINE_LEAF_VALUE',
    );
    records.push({
      kind: 'leaf',
      path: radixMerklePathSlots(parsed.payload, 16),
      key: path,
      keyBytes: Uint8Array.from(parsed.payload),
      value,
    });
  }
  return records;
};

const pathId = (path: StorageValueGraphPath): string =>
  Buffer.from(storageValueGraphPathBytes(path)).toString('hex');

export const rebuildStorageValueGraph = (graph: StorageValueGraph): unknown => {
  const values = new Map<string, Readonly<{ path: StorageValueGraphPath; value: StorageValueGraphValue }>>();
  const children = new Map<string, StorageValueGraphPath[]>();
  for (const [path, value] of graph) {
    const id = pathId(path);
    if (values.has(id)) throw new Error('STORAGE_RUNTIME_MACHINE_PATH_DUPLICATE');
    values.set(id, { path, value });
    if (path.length > 0) {
      const parentId = pathId(path.slice(0, -1));
      const siblings = children.get(parentId);
      if (siblings) siblings.push(path);
      else children.set(parentId, [path]);
    }
  }
  const build = (path: StorageValueGraphPath): unknown => {
    const entry = values.get(pathId(path));
    if (!entry) throw new Error('STORAGE_RUNTIME_MACHINE_PATH_MISSING');
    const childPaths = children.get(pathId(path)) ?? [];
    if (entry.value.kind === 'atom') {
      if (childPaths.length > 0) throw new Error('STORAGE_RUNTIME_MACHINE_ATOM_HAS_CHILDREN');
      return entry.value.value;
    }
    const ordered = [...childPaths].sort((left, right) => {
      const leftSegment = left[left.length - 1]!;
      const rightSegment = right[right.length - 1]!;
      if (leftSegment.kind === 'property' && rightSegment.kind === 'property') {
        return leftSegment.name < rightSegment.name ? -1 : leftSegment.name > rightSegment.name ? 1 : 0;
      }
      if (leftSegment.kind === 'property' || rightSegment.kind === 'property') {
        throw new Error('STORAGE_VALUE_GRAPH_CHILD_KIND_MIXED');
      }
      return leftSegment.index - rightSegment.index;
    });
    if (entry.value.container === 'object') {
      const output: Record<string, unknown> = {};
      ordered.forEach(child => {
        const segment = child[child.length - 1]!;
        if (segment.kind !== 'property' || segment.name in output) {
          throw new Error('STORAGE_RUNTIME_MACHINE_OBJECT_CHILD_INVALID');
        }
        output[segment.name] = build(child);
      });
      return output;
    }
    if (entry.value.container === 'array') {
      return ordered.map((child, expectedIndex) => {
        const segment = child[child.length - 1]!;
        if (segment.kind !== 'array' || segment.index !== expectedIndex) {
          throw new Error('STORAGE_RUNTIME_MACHINE_ARRAY_CHILD_INVALID');
        }
        return build(child);
      });
    }
    if (entry.value.container === 'map') {
      const output = new Map<unknown, unknown>();
      ordered.forEach((child, expectedIndex) => {
        const segment = child[child.length - 1]!;
        if (segment.kind !== 'map' || segment.index !== expectedIndex || output.has(segment.key)) {
          throw new Error('STORAGE_RUNTIME_MACHINE_MAP_CHILD_INVALID');
        }
        output.set(segment.key, build(child));
      });
      return output;
    }
    const output = new Set<unknown>();
    ordered.forEach((child, expectedIndex) => {
      const segment = child[child.length - 1]!;
      if (segment.kind !== 'set' || segment.index !== expectedIndex) {
        throw new Error('STORAGE_RUNTIME_MACHINE_SET_CHILD_INVALID');
      }
      output.add(build(child));
    });
    return output;
  };
  return build([]);
};

export const readRuntimeMachineGraph = async (
  db: RuntimeDbLike,
  height: number,
  expected: RuntimeMachineGraphRoot,
): Promise<Record<string, unknown>> => {
  const records = await readGraphRecords(db, height);
  const graph = PersistentRadixValueMap.fromNodeRecords(records, STORAGE_VALUE_GRAPH_OPTIONS);
  if (graph.rootHash() !== expected.rootHash || graph.size !== expected.leafCount) {
    throw new Error(
      `STORAGE_RUNTIME_MACHINE_GRAPH_ROOT_MISMATCH:height=${height}:` +
      `expected=${expected.rootHash}/${expected.leafCount}:` +
      `actual=${graph.rootHash()}/${graph.size}`,
    );
  }
  return validateDurableRuntimeMachineSnapshot(
    rebuildStorageValueGraph(graph),
    'STORAGE_RUNTIME_MACHINE_GRAPH',
  );
};
