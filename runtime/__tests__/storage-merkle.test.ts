import { expect, test } from 'bun:test';

import {
  buildHexKeyedMerkle,
  buildHexKeyedMerkleProof,
  verifyRadixMerkleProof,
} from '../storage/merkle';

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

test('storage radix merkle builds verifiable inclusion proofs', () => {
  const leaves = [
    { hexKey: hexKey(0x11), value: value('alice') },
    { hexKey: hexKey(0x22), value: value('bob') },
    { hexKey: hexKey(0x33), value: value('carol') },
  ];
  const root = buildHexKeyedMerkle(leaves, { radix: 16 });
  const proof = buildHexKeyedMerkleProof(leaves, hexKey(0x22), { radix: 16 });

  expect(proof?.root).toBe(root.root);
  expect(proof?.steps.length).toBeGreaterThan(0);
  expect(proof ? verifyRadixMerkleProof(proof) : false).toBe(true);
});

test('storage radix merkle rejects tampered inclusion proofs', () => {
  const leaves = [
    { hexKey: hexKey(0x11), value: value('alice') },
    { hexKey: hexKey(0x22), value: value('bob') },
    { hexKey: hexKey(0x33), value: value('carol') },
  ];
  const proof = buildHexKeyedMerkleProof(leaves, hexKey(0x22), { radix: 16 });
  expect(proof).not.toBe(null);
  const tampered = {
    ...proof!,
    value: `0x${Buffer.from(value('mallory')).toString('hex')}`,
  };

  expect(verifyRadixMerkleProof(tampered)).toBe(false);
});

test('storage radix merkle returns no proof for absent leaves', () => {
  const leaves = [
    { hexKey: hexKey(0x11), value: value('alice') },
    { hexKey: hexKey(0x22), value: value('bob') },
  ];

  expect(buildHexKeyedMerkleProof(leaves, hexKey(0x33))).toBe(null);
});

test('storage radix merkle rejects mixed key lengths', () => {
  expect(() =>
    buildHexKeyedMerkle([
      { hexKey: '0x11', value: value('short') },
      { hexKey: hexKey(0x22), value: value('full') },
    ]),
  ).toThrow(/RADIX_MERKLE_MIXED_KEY_LENGTHS/);
});
