import { expect, test } from 'bun:test';

import {
  buildHexKeyedMerkle,
  buildHexKeyedMerkleMaterialized,
} from '../storage/merkle';
import { storageCanonicalHashEnabled } from '../storage/hashes';
import { buildBookDeletionsFromOverlay, storageRefsFromOverlay } from '../storage/overlay-docs';
import {
  KEY_MERKLE_BRANCH,
  KEY_MERKLE_LEAF,
  KEY_MERKLE_ROOT,
  keyMerkleBranch,
  keyMerkleBranchPrefix,
  keyMerkleLeaf,
  keyMerkleRoot,
} from '../storage/keys';

const hexKey = (byte: number): string => `0x${byte.toString(16).padStart(2, '0').repeat(32)}`;
const value = (text: string): Uint8Array => new TextEncoder().encode(text);

test('storage radix merkle is deterministic across leaf insertion order', () => {
  const leaves = [
    { hexKey: hexKey(0x22), value: value('bob') },
    { hexKey: hexKey(0x11), value: value('alice') },
    { hexKey: hexKey(0x33), value: value('carol') },
  ];

  const forward = buildHexKeyedMerkle(leaves, { radix: 16 });
  const reverse = buildHexKeyedMerkle([...leaves].reverse(), { radix: 16 });

  expect(forward.root).toBe(reverse.root);
  expect(forward.leafCount).toBe(3);
  expect(forward.depth).toBe(64);
});

test('storage radix merkle root changes when a leaf value changes', () => {
  const base = buildHexKeyedMerkle([
    { hexKey: hexKey(0x11), value: value('alice') },
    { hexKey: hexKey(0x22), value: value('bob') },
  ]);
  const changed = buildHexKeyedMerkle([
    { hexKey: hexKey(0x11), value: value('alice') },
    { hexKey: hexKey(0x22), value: value('bob-v2') },
  ]);

  expect(base.root).not.toBe(changed.root);
});

test('storage radix merkle deduplicates keys with last-write-wins semantics', () => {
  const deduped = buildHexKeyedMerkle([
    { hexKey: hexKey(0x11), value: value('old') },
    { hexKey: hexKey(0x11), value: value('new') },
  ]);
  const single = buildHexKeyedMerkle([
    { hexKey: hexKey(0x11), value: value('new') },
  ]);

  expect(deduped.root).toBe(single.root);
  expect(deduped.leafCount).toBe(1);
});

test('storage radix merkle keeps one-leaf trees compact', () => {
  const result = buildHexKeyedMerkle([
    { hexKey: hexKey(0x11), value: value('alice') },
  ]);

  expect(result.leafCount).toBe(1);
  expect(result.branchCount).toBe(0);
  expect(result.extensionCount).toBe(0);
  expect(result.maxDepth).toBe(0);
});

test('storage radix merkle compresses shared prefixes and splits only at divergence', () => {
  const result = buildHexKeyedMerkle([
    { hexKey: `0x${'11'.repeat(31)}10`, value: value('left') },
    { hexKey: `0x${'11'.repeat(31)}20`, value: value('right') },
  ]);

  expect(result.depth).toBe(64);
  expect(result.leafCount).toBe(2);
  expect(result.branchCount).toBe(1);
  expect(result.extensionCount).toBe(1);
  expect(result.maxDepth).toBe(63);
});

test('storage radix merkle auto-splits small account trees without fixed-depth chains', () => {
  const result = buildHexKeyedMerkle([
    { hexKey: `0x${'ab'.repeat(30)}0011`, value: value('one') },
    { hexKey: `0x${'ab'.repeat(30)}0022`, value: value('two') },
    { hexKey: `0x${'ab'.repeat(30)}1033`, value: value('three') },
  ]);

  expect(result.leafCount).toBe(3);
  expect(result.branchCount).toBeLessThan(5);
  expect(result.extensionCount).toBeLessThan(5);
  expect(result.root).toMatch(/^0x[0-9a-f]{64}$/);
});

test('storage radix merkle materialized rows match the compact root', () => {
  const leaves = [
    { hexKey: `0x${'ab'.repeat(30)}0011`, value: value('one') },
    { hexKey: `0x${'ab'.repeat(30)}0022`, value: value('two') },
    { hexKey: `0x${'ab'.repeat(30)}1033`, value: value('three') },
  ];
  const compact = buildHexKeyedMerkle(leaves);
  const materialized = buildHexKeyedMerkleMaterialized(leaves);

  expect(materialized.root).toBe(compact.root);
  expect(materialized.leafCount).toBe(3);
  expect(materialized.leaves).toHaveLength(3);
  expect(materialized.branches.length).toBeGreaterThan(0);
  expect(materialized.rootKind).toBe('branch');
  expect(materialized.branches.every((branch) => branch.children.length >= 2)).toBe(true);
});

test('storage radix merkle supports radix 256 with byte-depth paths', () => {
  const result = buildHexKeyedMerkle([
    { hexKey: hexKey(0x01), value: value('one') },
    { hexKey: hexKey(0x02), value: value('two') },
  ], { radix: 256 });

  expect(result.radix).toBe(256);
  expect(result.depth).toBe(32);
  expect(result.leafCount).toBe(2);
  expect(result.root).toMatch(/^0x[0-9a-f]{64}$/);
});

test('storage canonical audit hash is explicit env opt-in in every NODE_ENV', () => {
  const previousNodeEnv = process.env['NODE_ENV'];
  const previousVerifyCanonical = process.env['XLN_STORAGE_VERIFY_CANONICAL'];
  try {
    process.env['XLN_STORAGE_VERIFY_CANONICAL'] = '1';
    process.env['NODE_ENV'] = 'development';
    expect(storageCanonicalHashEnabled()).toBe(true);
    process.env['NODE_ENV'] = 'production';
    expect(storageCanonicalHashEnabled()).toBe(true);
    delete process.env['XLN_STORAGE_VERIFY_CANONICAL'];
    expect(storageCanonicalHashEnabled()).toBe(false);
  } finally {
    if (previousNodeEnv === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = previousNodeEnv;
    if (previousVerifyCanonical === undefined) delete process.env['XLN_STORAGE_VERIFY_CANONICAL'];
    else process.env['XLN_STORAGE_VERIFY_CANONICAL'] = previousVerifyCanonical;
  }
});

test('storage radix merkle rejects mixed key lengths', () => {
  expect(() =>
    buildHexKeyedMerkle([
      { hexKey: '0x11', value: value('short') },
      { hexKey: hexKey(0x22), value: value('full') },
    ]),
  ).toThrow(/RADIX_MERKLE_MIXED_KEY_LENGTHS/);
});

test('storage merkle durable keyspace is scoped by entity namespace and path', () => {
  const entityId = hexKey(0xab);
  const branch = keyMerkleBranch(entityId, 'accounts', Uint8Array.from([0x12, 0x34]));
  const leaf = keyMerkleLeaf(entityId, 'accounts', Uint8Array.from([0x12, 0x34]));
  const root = keyMerkleRoot(entityId, 'accounts');

  expect(root[0]).toBe(KEY_MERKLE_ROOT);
  expect(branch[0]).toBe(KEY_MERKLE_BRANCH);
  expect(leaf[0]).toBe(KEY_MERKLE_LEAF);
  expect(branch.subarray(0, keyMerkleBranchPrefix(entityId, 'accounts').length)).toEqual(keyMerkleBranchPrefix(entityId, 'accounts'));
  expect(Buffer.compare(branch, leaf)).not.toBe(0);
});

test('deleted book overlay produces a deletion ref without a put ref', () => {
  const entityId = hexKey(0xcd);
  const refs = storageRefsFromOverlay([
    { family: 'book', entityId, pairId: '1/2', deleted: true },
  ]);
  const dels = buildBookDeletionsFromOverlay([
    { family: 'book', entityId, pairId: '1/2', deleted: true },
  ]);

  expect(refs.touchedEntities.has(entityId)).toBe(true);
  expect(refs.touchedBookEntities.has(entityId)).toBe(true);
  expect(refs.touchedBooks.size).toBe(0);
  expect(dels).toHaveLength(1);
  expect(dels[0]).toMatchObject({ family: 'book', entityId, pairId: '1/2' });
});
