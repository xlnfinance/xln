import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';

import { PersistentRadixValueMap } from '../../../protocol/state/persistent-radix-value-map';
import type { PersistentRadixValueMapOptions } from '../../../protocol/state/persistent-radix-value-map';
import {
  buildRadixMerkle,
  buildRadixMerkleMaterialized,
  buildHexKeyedMerkle,
  encodeRawRadixTextKey,
  RADIX_MERKLE_RADICES,
  radixMerklePathSlots,
} from '../../../protocol/state/radix-merkle';

const options = {
  radix: 16 as const,
  ownKey: (key: string): string => key,
  keyBytes: (key: string): Uint8Array => new TextEncoder().encode(key),
  valueHash: (value: string): string => ethers.keccak256(new TextEncoder().encode(value)),
  ownValue: (value: string): string => value,
};

const fromEntries = <K, V>(
  entries: Iterable<readonly [K, V]>,
  treeOptions: PersistentRadixValueMapOptions<K, V>,
): PersistentRadixValueMap<K, V> => {
  let tree = PersistentRadixValueMap.empty(treeOptions);
  for (const [key, value] of entries) tree = tree.updated(key, value);
  return tree;
};

const fromMap = <K, V>(
  entries: Iterable<readonly [K, V]>,
  treeOptions: PersistentRadixValueMapOptions<K, V>,
): PersistentRadixValueMap<K, V> => PersistentRadixValueMap.fromMap(entries, treeOptions);

describe('PersistentRadixValueMap', () => {
  test('compact root projection is byte-identical to the persisted graph projection', () => {
    const cases = [
      [],
      [{ key: Uint8Array.of(0x10), value: Uint8Array.of(1) }],
      [
        { key: Uint8Array.of(0x10, 0x01), value: Uint8Array.of(1, 2) },
        { key: Uint8Array.of(0x10, 0x02), value: Uint8Array.of(3, 4) },
        { key: Uint8Array.of(0xf0, 0xff), value: Uint8Array.of(5, 6) },
      ],
    ];
    for (const radix of RADIX_MERKLE_RADICES) {
      for (const hashAlgorithm of ['integrity', 'keccak256'] as const) {
        for (const leaves of cases) {
          const compact = buildRadixMerkle(leaves, { radix, hashAlgorithm });
          const persisted = buildRadixMerkleMaterialized(leaves, { radix, hashAlgorithm });
          expect(compact).toEqual({
            radix: persisted.radix,
            depth: persisted.depth,
            leafCount: persisted.leafCount,
            branchCount: persisted.branchCount,
            extensionCount: persisted.extensionCount,
            maxDepth: persisted.maxDepth,
            root: persisted.root,
          });
        }
      }
    }
  });

  test('fast hex decoding preserves bytes and rejects every non-canonical shape', () => {
    const lower = buildHexKeyedMerkle([{ hexKey: '0xabcd', value: Uint8Array.of(1) }]);
    const upper = buildHexKeyedMerkle([{ hexKey: '0xABCD', value: Uint8Array.of(1) }]);
    expect(upper.root).toBe(lower.root);
    for (const hexKey of ['', '0x', '0x0', '0xgg']) {
      expect(() => buildHexKeyedMerkle([{ hexKey, value: Uint8Array.of(1) }]))
        .toThrow('RADIX_MERKLE_HASH_HEX_INVALID');
    }
  });

  test('uses raw key bits for every supported power-of-two fanout', () => {
    for (const radix of RADIX_MERKLE_RADICES) {
      const slots = radixMerklePathSlots(Uint8Array.of(0b1011_0010), radix);
      expect(slots).toHaveLength(8 / Math.log2(radix));
      expect(slots.every(slot => slot >= 0 && slot < radix)).toBe(true);
    }
    expect(radixMerklePathSlots(Uint8Array.of(0xab), 2)).toEqual([1, 0, 1, 0, 1, 0, 1, 1]);
    expect(radixMerklePathSlots(Uint8Array.of(0xab), 4)).toEqual([2, 2, 2, 3]);
    expect(radixMerklePathSlots(Uint8Array.of(0xab), 16)).toEqual([10, 11]);
    expect(radixMerklePathSlots(Uint8Array.of(0xab), 256)).toEqual([171]);
  });

  test('incremental and cold roots agree for every supported fanout', () => {
    for (const radix of RADIX_MERKLE_RADICES) {
      const radixOptions = { ...options, radix };
      const base = fromEntries([['a', '1'], ['b', '2']], radixOptions);
      const incremental = base.updated('a', '3').updated('c', '4').removed('b');
      const cold = fromMap([['a', '3'], ['c', '4']], radixOptions);
      expect(incremental.rootHash()).toBe(cold.rootHash());
      expect(base.get('a')).toBe('1');
    }
  });

  test('incremental root equals a cold build of the same values', () => {
    const base = fromEntries([['a', '1'], ['b', '2']], options);
    const incremental = base.updated('a', '3').updated('c', '4').removed('b');
    const cold = fromMap([['a', '3'], ['c', '4']], options);

    expect(incremental.rootHash()).toBe(cold.rootHash());
    expect([...incremental]).toEqual([...cold]);
    expect(base.get('a')).toBe('1');
    expect(base.get('b')).toBe('2');
  });

  test('retains the pre-native-hex consensus roots', () => {
    const empty = PersistentRadixValueMap.empty({ ...options, keyBytes: encodeRawRadixTextKey });
    expect(empty.rootHash()).toBe(`0x${'00'.repeat(32)}`);
    expect(empty.updated('a', '1').rootHash())
      .toBe('0xb48af8cde1f2867eccab9618e09337af84fd76d00078978905c2fd50455344d3');
    expect(empty.updated('a', '1').updated('ab', '2').rootHash())
      .toBe('0xfd9bf6a56fc2c2a79995fb4d1ab5e4a5a56bdc5cd17acbdbdedd928811a9882a');
  });

  test('radix-256 update is deterministic and preserves untouched immutable values', () => {
    const ref = { value: 1 };
    const hash = (value: { value: number }): string =>
      ethers.keccak256(Uint8Array.of(value.value));
    const radix256 = {
      radix: 256 as const,
      ownKey: options.ownKey,
      keyBytes: options.keyBytes,
      valueHash: hash,
      ownValue: (value: { value: number }): { value: number } => Object.freeze({ ...value }),
    };
    const base = fromEntries([['a', ref], ['b', { value: 2 }]], radix256);
    const next = base.updated('b', { value: 3 });
    const cold = fromMap([['a', ref], ['b', { value: 3 }]], radix256);

    expect(next.rootHash()).toBe(cold.rootHash());
    expect(next.get('a')).not.toBe(ref);
    expect(next.get('a')).toEqual(ref);
    expect(base.get('b')?.value).toBe(2);
  });

  test('caller mutation cannot change retained key bytes, value, or root', () => {
    const suppliedKeyBytes = Uint8Array.of(1, 2, 3);
    const suppliedValue = { value: 7 };
    const immutable = {
      radix: 16 as const,
      ownKey: (key: string): string => key,
      keyBytes: (_key: string): Uint8Array => suppliedKeyBytes,
      valueHash: (value: { value: number }): string =>
        ethers.keccak256(Uint8Array.of(value.value)),
      ownValue: (value: { value: number }): { value: number } => Object.freeze({ ...value }),
    };
    const map = fromEntries([['external', suppliedValue]], immutable);
    const root = map.rootHash();
    suppliedKeyBytes[0] = 255;
    suppliedValue.value = 9;

    expect(map.rootHash()).toBe(root);
    expect([...map.values()]).toEqual([{ value: 7 }]);
  });

  test('caller mutation cannot change a retained object key or DB leaf record', () => {
    type ObjectKey = Readonly<{ group: number; item: number }>;
    const objectOptions = {
      radix: 16 as const,
      ownKey: (key: ObjectKey): ObjectKey => Object.freeze({ ...key }),
      keyBytes: (key: ObjectKey): Uint8Array => Uint8Array.of(key.group, key.item),
      valueHash: options.valueHash,
      ownValue: options.ownValue,
    };
    const supplied = { group: 1, item: 2 };
    const map = PersistentRadixValueMap.empty<ObjectKey, string>(objectOptions)
      .updated(supplied, 'stable');
    const root = map.rootHash();
    supplied.item = 9;

    expect(map.rootHash()).toBe(root);
    expect([...map.keys()]).toEqual([{ group: 1, item: 2 }]);
    const leaf = [...map.nodeRecords()].find(record => record.kind === 'leaf');
    expect(leaf?.kind === 'leaf' ? leaf.key : undefined).toEqual({ group: 1, item: 2 });
  });

  test('uses raw prefix-free text key bytes without hashing the key', () => {
    const raw = encodeRawRadixTextKey('order-42');
    expect(new TextDecoder().decode(raw.subarray(2))).toBe('order-42');
    expect(raw.subarray(2)).toEqual(new TextEncoder().encode('order-42'));

    expect(raw).not.toEqual(ethers.getBytes(ethers.keccak256(new TextEncoder().encode('order-42'))));
  });

  test('fromMap matches incremental roots without sorting input keys', () => {
    const incremental = fromEntries([['c', '3'], ['a', '1'], ['b', '2']], options);
    const reversed = fromMap([['b', '2'], ['c', '3'], ['a', '1']], options);
    expect(reversed.rootHash()).toBe(incremental.rootHash());
    expect([...reversed].sort(([left], [right]) => left < right ? -1 : 1))
      .toEqual([...incremental].sort(([left], [right]) => left < right ? -1 : 1));
  });

  test('rejects ambiguous raw prefix keys and accepts length-prefixed text keys', () => {
    expect(() => fromEntries([['a', '1'], ['ab', '2']], options))
      .toThrow('PERSISTENT_RADIX_KEY_PREFIX_COLLISION');
    const prefixFree = {
      ...options,
      keyBytes: encodeRawRadixTextKey,
    };
    const map = fromEntries([['a', '1'], ['ab', '2']], prefixFree);
    expect(map.get('a')).toBe('1');
    expect(map.get('ab')).toBe('2');
  });

  test('projects the same Patricia graph to DB nodes and diffs only dirty paths', () => {
    const base = fromMap(
      Array.from({ length: 1_024 }, (_, index) => [`key-${index.toString().padStart(4, '0')}`, String(index)] as const),
      { ...options, keyBytes: encodeRawRadixTextKey },
    );
    const next = base.updated('key-0512', 'changed');
    const fullNodeCount = [...base.nodeRecords()].length;
    const changes = next.nodeChangesSince(base);

    expect(fullNodeCount).toBeGreaterThan(1_024);
    expect(changes.puts.some(record => record.kind === 'leaf' && record.key === 'key-0512')).toBe(true);
    expect(changes.puts.length).toBeLessThan(32);
    expect(changes.dels.length).toBeLessThan(32);
    const putKeys = new Set(changes.puts.map(record => `${record.kind}:${record.path.join('.')}`));
    expect(changes.dels.every(record => !putKeys.has(`${record.kind}:${record.path.join('.')}`)))
      .toBe(true);
    for (const branch of changes.puts.filter(record => record.kind === 'branch')) {
      expect(branch.children.map(child => child.slot))
        .toEqual([...branch.children.map(child => child.slot)].sort((left, right) => left - right));
    }
    expect(next.rootHash()).not.toBe(base.rootHash());
    expect(base.get('key-0512')).toBe('512');
    const putOrder = changes.puts.map(record => `${record.kind}:${record.path.join('.')}`);
    const delOrder = changes.dels.map(record => `${record.kind}:${record.path.join('.')}`);
    expect(putOrder).toEqual([...putOrder].sort((left, right) => left < right ? -1 : 1));
    expect(delOrder).toEqual([...delOrder].sort((left, right) => left < right ? -1 : 1));
  });

  test('diffs independently rebuilt cold projections by commitment, not object identity', () => {
    const treeOptions = { ...options, keyBytes: encodeRawRadixTextKey };
    const entries = Array.from(
      { length: 200 },
      (_, index) => [`key-${index.toString().padStart(3, '0')}`, String(index)] as const,
    );
    const previous = fromMap(entries, treeOptions);
    const identical = fromMap(entries, treeOptions);
    expect(identical.nodeChangesSince(previous)).toEqual({ puts: [], dels: [] });

    const changedEntries = entries.map(entry => entry[0] === 'key-100'
      ? [entry[0], 'changed'] as const
      : entry);
    const changed = fromMap(changedEntries, treeOptions).nodeChangesSince(previous);
    expect(changed.puts.some(record => record.kind === 'leaf' && record.key === 'key-100')).toBe(true);
    expect(changed.puts.length).toBeLessThan(32);
    expect(changed.dels.length).toBeLessThan(32);
  });

  test('has tests leaf membership when the stored value is undefined', () => {
    const withUndefined = {
      ...options,
      keyBytes: encodeRawRadixTextKey,
      valueHash: (value: string | undefined): string =>
        ethers.keccak256(new TextEncoder().encode(value === undefined ? '' : value)),
      ownValue: (value: string | undefined): string | undefined => value,
    };
    const map = PersistentRadixValueMap.empty<string, string | undefined>(withUndefined)
      .updated('ghost', undefined);
    expect(map.get('ghost')).toBeUndefined();
    expect(map.has('ghost')).toBe(true);
    expect(map.has('missing')).toBe(false);
    expect(map.size).toBe(1);
  });

  test('replacement and delete diffs stay physically disjoint and path-ordered', () => {
    const treeOptions = { ...options, keyBytes: encodeRawRadixTextKey };
    const base = fromMap([['a', '1'], ['b', '2'], ['c', '3']], treeOptions);
    const next = base.updated('b', '9').removed('c').updated('d', '4');
    const changes = next.nodeChangesSince(base);
    const putKeys = changes.puts.map(record => `${record.kind}:${record.path.join('.')}`);
    const delKeys = changes.dels.map(record => `${record.kind}:${record.path.join('.')}`);
    expect(new Set(putKeys).size).toBe(putKeys.length);
    expect(delKeys.every(key => !putKeys.includes(key))).toBe(true);
    expect(putKeys).toEqual([...putKeys].sort((left, right) => left < right ? -1 : 1));
    expect(delKeys).toEqual([...delKeys].sort((left, right) => left < right ? -1 : 1));
    const again = base.updated('b', '9').removed('c').updated('d', '4');
    expect(again.nodeChangesSince(base)).toEqual(changes);
  });

  test('hydrates the exact persisted graph and rejects corrupt or orphan nodes', () => {
    const treeOptions = { ...options, keyBytes: encodeRawRadixTextKey };
    const source = fromMap([['a', '1'], ['b', '2'], ['c', '3']], treeOptions);
    const records = [...source.nodeRecords()];
    const hydrated = PersistentRadixValueMap.fromNodeRecords(records, treeOptions);
    expect(hydrated.rootHash()).toBe(source.rootHash());
    expect([...hydrated]).toEqual([...source]);

    const root = records.find(record => record.kind === 'branch' && record.path.length === 0);
    if (!root || root.kind !== 'branch') throw new Error('TEST_ROOT_MISSING');
    const firstChild = root.children[0];
    if (!firstChild) throw new Error('TEST_ROOT_CHILD_MISSING');
    const corrupt = records.map(record => record === root
      ? {
          ...record,
          children: record.children.map(child => child === firstChild
            ? { ...child, edgeHash: `0x${'ff'.repeat(32)}` }
            : child),
        }
      : record);
    expect(() => PersistentRadixValueMap.fromNodeRecords(corrupt, treeOptions))
      .toThrow('PERSISTENT_RADIX_EDGE_HASH_MISMATCH');

    const orphan = [...records, { ...records.at(-1)!, path: [15, 15, 15] }];
    expect(() => PersistentRadixValueMap.fromNodeRecords(orphan, treeOptions))
      .toThrow('PERSISTENT_RADIX_NODE_ORPHAN');
  });

  test('second rootHash does no extra value hashing', () => {
    let hashes = 0;
    const counting = {
      ...options,
      valueHash: (value: string): string => {
        hashes += 1;
        return options.valueHash(value);
      },
    };
    const map = fromMap([['a', '1'], ['b', '2']], counting);
    map.rootHash();
    const afterFirst = hashes;
    expect(afterFirst).toBeGreaterThan(0);
    map.rootHash();
    expect(hashes).toBe(afterFirst);
    expect(map.hashStats().valueHashes).toBe(afterFirst);
  });

  test('commitment:false locators cannot serialize or root', () => {
    let hashed = 0;
    const locator = {
      ...options,
      commitment: false as const,
      valueHash: (value: string): string => {
        hashed += 1;
        return options.valueHash(value);
      },
    };
    const map = PersistentRadixValueMap.empty(locator).updated('ab', '1').updated('cd', '2');
    expect(map.get('ab')).toBe('1');
    expect(hashed).toBe(0);
    expect(() => map.rootHash()).toThrow('PERSISTENT_RADIX_COMMITMENT_DISABLED');
    expect(() => [...map.nodeRecords()]).toThrow('PERSISTENT_RADIX_NODE_STORAGE_REQUIRES_COMMITMENT');
    expect(() => PersistentRadixValueMap.fromNodeRecords([], locator))
      .toThrow('PERSISTENT_RADIX_NODE_STORAGE_REQUIRES_COMMITMENT');
  });

  test('foldMutations matches sequential updated roots without hashing until rootHash', () => {
    let hashes = 0;
    const counting = {
      ...options,
      keyBytes: encodeRawRadixTextKey,
      valueHash: (value: string): string => {
        hashes += 1;
        return options.valueHash(value);
      },
    };
    const base = fromMap([['a', '1'], ['b', '2']], counting);
    base.rootHash();
    const afterBase = hashes;
    const sequential = base.updated('a', '9').removed('b').updated('c', '3');
    expect(hashes).toBe(afterBase);
    const folded = base.foldMutations([
      { kind: 'put', key: 'a', value: '9' },
      { kind: 'delete', key: 'b' },
      { kind: 'put', key: 'c', value: '3' },
    ]);
    expect(hashes).toBe(afterBase);
    expect(folded.rootHash()).toBe(sequential.rootHash());
    expect([...folded]).toEqual([...sequential]);
  });

  test('foldMutations preserves leaf count when deleting and replacing a compressed slot', () => {
    const base = fromMap([['a', '1']], options);
    const replaced = base.foldMutations([
      { kind: 'delete', key: 'a' },
      { kind: 'put', key: 'b', value: '2' },
    ]);
    const emptied = base.foldMutations([
      { kind: 'delete', key: 'a' },
      { kind: 'delete', key: 'b' },
    ]);

    expect(replaced.size).toBe(1);
    expect([...replaced]).toEqual([['b', '2']]);
    expect(replaced.rootHash()).toBe(base.removed('a').updated('b', '2').rootHash());
    expect(emptied.size).toBe(0);
    expect([...emptied]).toEqual([]);
    expect(emptied.rootHash()).toBe(PersistentRadixValueMap.empty(options).rootHash());
  });

  test('foldMutations updates 160 existing Account-shaped keys in one overlay', () => {
    const accountOptions = {
      ...options,
      keyBytes: (key: string): Uint8Array => ethers.getBytes(key),
    };
    const keys = Array.from(
      { length: 160 },
      (_, index) => ethers.keccak256(new TextEncoder().encode(`account-${index}`)),
    );
    const base = fromMap(keys.map((key, index) => [key, `before-${index}`]), accountOptions);
    const beforeRoot = base.rootHash();
    const mutations = keys.map((key, index) => ({
      kind: 'put' as const,
      key,
      value: `after-${index}`,
    }));
    const folded = base.foldMutations(mutations);
    let sequential = base;
    for (const mutation of mutations) sequential = sequential.updated(mutation.key, mutation.value);

    expect(folded.size).toBe(160);
    expect(folded.rootHash()).toBe(sequential.rootHash());
    expect([...folded]).toEqual([...sequential]);
    expect(base.rootHash()).toBe(beforeRoot);
  });

  test('foldMutations inserts multiple siblings across a compressed branch', () => {
    const hexOptions = {
      ...options,
      keyBytes: (key: string): Uint8Array => ethers.getBytes(key),
    };
    const base = fromMap([
      ['0x0000', 'base-0'],
      ['0x0001', 'base-1'],
    ], hexOptions);
    const folded = base.foldMutations([
      { kind: 'put', key: '0x0100', value: 'new-1' },
      { kind: 'put', key: '0x0200', value: 'new-2' },
    ]);
    const sequential = base
      .updated('0x0100', 'new-1')
      .updated('0x0200', 'new-2');
    const cold = fromMap([
      ['0x0000', 'base-0'],
      ['0x0001', 'base-1'],
      ['0x0100', 'new-1'],
      ['0x0200', 'new-2'],
    ], hexOptions);

    expect(folded.hashStats().valueHashes).toBe(0);
    expect([...folded]).toEqual([...sequential]);
    expect(folded.rootHash()).toBe(sequential.rootHash());
    expect(folded.rootHash()).toBe(cold.rootHash());
    expect([...base]).toEqual([
      ['0x0000', 'base-0'],
      ['0x0001', 'base-1'],
    ]);
  });

  test('foldMutations owns canonical keys and mutable values at its public boundary', () => {
    type Value = { amount: number };
    const owned = {
      radix: 16 as const,
      ownKey: (key: string): string => key.toLowerCase(),
      keyBytes: (key: string): Uint8Array => new TextEncoder().encode(key),
      valueHash: (value: Value): string => ethers.keccak256(Uint8Array.of(value.amount)),
      ownValue: (value: Value): Value => Object.freeze({ ...value }),
    };
    const supplied = { amount: 7 };
    const folded = PersistentRadixValueMap.empty(owned).foldMutations([
      { kind: 'put', key: 'A', value: supplied },
    ]);
    const root = folded.rootHash();
    supplied.amount = 9;

    expect(folded.get('a')).toEqual({ amount: 7 });
    expect([...folded.keys()]).toEqual(['a']);
    expect(Object.isFrozen(folded.get('a'))).toBe(true);
    expect(folded.rootHash()).toBe(root);
  });
});
