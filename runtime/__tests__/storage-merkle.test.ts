import { expect, test } from 'bun:test';

import { buildHexKeyedMerkle } from '../storage/merkle';

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

test('storage radix merkle rejects mixed key lengths', () => {
  expect(() =>
    buildHexKeyedMerkle([
      { hexKey: '0x11', value: value('short') },
      { hexKey: hexKey(0x22), value: value('full') },
    ]),
  ).toThrow(/RADIX_MERKLE_MIXED_KEY_LENGTHS/);
});
