import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';

import {
  beginRadixOverlay,
  discardRadixOverlay,
  prepareRadixOverlay,
} from '../../../protocol/state/radix-overlay';
import {
  PersistentRadixValueMap,
  type PersistentRadixValueMapOptions,
} from '../../../protocol/state/persistent-radix-value-map';

type TestKey = Readonly<{ group: number; item: number }>;
type TestValue = Readonly<{ amount: number; label: string }>;

const encodeKey = (key: TestKey): Uint8Array => Uint8Array.of(key.group, key.item);
const encodeValue = (value: TestValue): Uint8Array =>
  new TextEncoder().encode(`${value.amount}:${value.label}`);

const makeOptions = (
  onHash: () => void = () => undefined,
): PersistentRadixValueMapOptions<TestKey, TestValue> => ({
  radix: 16,
  ownKey: entryKey => Object.freeze({ ...entryKey }),
  keyBytes: encodeKey,
  valueHash: value => {
    onHash();
    return ethers.keccak256(encodeValue(value));
  },
  ownValue: value => Object.freeze({ ...value }),
});

const key = (group: number, item: number): TestKey => ({ group, item });
const value = (amount: number, label: string): TestValue => ({ amount, label });

describe('radix overlay', () => {
  test('reads the immutable base without cloning or dirtying it', () => {
    const options = makeOptions();
    const base = PersistentRadixValueMap.fromMap([[key(1, 1), value(10, 'base')]], options);
    const owner = beginRadixOverlay(base);

    expect(owner.view.get(key(1, 1))).toBe(base.get(key(1, 1)));
    expect(owner.view.size).toBe(1);

    const prepared = prepareRadixOverlay(owner);
    expect(prepared.root).toBe(base.rootHash());
    expect(prepared.nodeChanges).toEqual({ puts: [], dels: [] });
  });

  test('reads dirty values first and leaves the committed root untouched', () => {
    const options = makeOptions();
    const first = key(1, 1);
    const second = key(1, 2);
    const base = PersistentRadixValueMap.fromMap([[first, value(10, 'old')]], options);
    const baseRoot = base.rootHash();
    const owner = beginRadixOverlay(base);

    owner.view.edit(key(1, 1), previous => value(previous.amount + 5, 'edited'));
    owner.view.put(second, value(20, 'new'));

    expect(owner.view.get(first)).toEqual(value(15, 'edited'));
    expect(owner.view.get(second)).toEqual(value(20, 'new'));
    expect(owner.view.size).toBe(2);
    expect(base.get(first)).toEqual(value(10, 'old'));
    expect(base.has(second)).toBe(false);
    expect(base.rootHash()).toBe(baseRoot);

    const prepared = prepareRadixOverlay(owner);
    expect(prepared.root).not.toBe(baseRoot);
    expect(prepared.values.get(first)).toEqual(value(15, 'edited'));
    expect(prepared.values.get(second)).toEqual(value(20, 'new'));
    expect(prepared.nodeChanges.puts.length).toBeGreaterThan(0);
  });

  test('deduplicates object keys by canonical encoded bytes', () => {
    const options = makeOptions();
    const base = PersistentRadixValueMap.empty(options);
    const owner = beginRadixOverlay(base);

    owner.view.put(key(2, 7), value(1, 'first'));
    owner.view.put(key(2, 7), value(2, 'replacement'));

    expect(owner.view.size).toBe(1);
    expect([...owner.view.entries()]).toEqual([[key(2, 7), value(2, 'replacement')]]);
    expect(prepareRadixOverlay(owner).values.size).toBe(1);
  });

  test('merges inserts, replacements and tombstones in byte order', () => {
    const options = makeOptions();
    const base = PersistentRadixValueMap.fromMap([
      [key(1, 1), value(1, 'one')],
      [key(1, 3), value(3, 'three')],
      [key(2, 1), value(21, 'other')],
    ], options);
    const owner = beginRadixOverlay(base);

    owner.view.del(key(1, 1));
    owner.view.put(key(1, 2), value(2, 'two'));
    owner.view.put(key(1, 3), value(30, 'replaced'));

    expect([...owner.view.entriesWithPrefix(Uint8Array.of(1))]).toEqual([
      [key(1, 2), value(2, 'two')],
      [key(1, 3), value(30, 'replaced')],
    ]);
    expect([...owner.view.entries()].map(([entryKey]) => entryKey)).toEqual([
      key(1, 2),
      key(1, 3),
      key(2, 1),
    ]);
  });

  test('reset replaces the base root and accepts only later writes', () => {
    const options = makeOptions();
    const base = PersistentRadixValueMap.fromMap([
      [key(1, 1), value(1, 'old-one')],
      [key(1, 2), value(2, 'old-two')],
    ], options);
    const owner = beginRadixOverlay(base);

    owner.view.put(key(9, 9), value(9, 'discarded-before-reset'));
    owner.view.reset();
    owner.view.put(key(2, 1), value(21, 'new'));

    expect(owner.view.size).toBe(1);
    expect(owner.view.get(key(1, 1))).toBeUndefined();
    expect([...owner.view.entries()]).toEqual([[key(2, 1), value(21, 'new')]]);
    const prepared = prepareRadixOverlay(owner);
    expect([...prepared.values.entries()]).toEqual([[key(2, 1), value(21, 'new')]]);
    expect(base.size).toBe(2);
  });

  test('rejects missing edits and mutable alias reuse', () => {
    const options = makeOptions();
    const storedKey = key(1, 1);
    const base = PersistentRadixValueMap.fromMap([[storedKey, value(5, 'sealed')]], options);
    const owner = beginRadixOverlay(base);

    expect(() => owner.view.edit(key(9, 9), previous => previous))
      .toThrow('RADIX_OVERLAY_EDIT_MISSING');
    expect(() => owner.view.edit(storedKey, previous => previous))
      .toThrow('RADIX_OVERLAY_EDIT_ALIAS');
    expect(base.get(storedKey)).toEqual(value(5, 'sealed'));
  });

  test('hashes a changed leaf once while materializing the candidate', () => {
    let hashes = 0;
    const options = makeOptions(() => { hashes += 1; });
    const base = PersistentRadixValueMap.empty(options);
    const owner = beginRadixOverlay(base);

    owner.view.put(key(1, 1), value(1, 'once'));
    expect(hashes).toBe(0);
    const prepared = prepareRadixOverlay(owner);
    expect(hashes).toBe(0);
    expect(prepared.hash).toBeDefined();
    expect(hashes).toBe(1);
  });

  test('owns a coalesced replacement once at fold, not on every put', () => {
    let owns = 0;
    const options: PersistentRadixValueMapOptions<TestKey, TestValue> = {
      ...makeOptions(),
      ownValue: entry => {
        owns += 1;
        return Object.freeze({ ...entry });
      },
    };
    const storedKey = key(1, 1);
    const base = PersistentRadixValueMap.empty(options);
    const owner = beginRadixOverlay(base);
    owner.view.put(storedKey, value(1, 'first'));
    owner.view.put(storedKey, value(2, 'second'));
    owner.view.put(storedKey, value(3, 'third'));
    expect(owns).toBe(0);
    expect(prepareRadixOverlay(owner).values.get(storedKey)).toEqual(value(3, 'third'));
    expect(owns).toBe(1);
  });

  test('N overlay mutations do not hash until .hash, then only dirty values', () => {
    let hashes = 0;
    const options = makeOptions(() => { hashes += 1; });
    const first = key(1, 1);
    const second = key(1, 2);
    const third = key(2, 1);
    const base = PersistentRadixValueMap.fromMap([
      [first, value(1, 'a')],
      [second, value(2, 'b')],
      [third, value(3, 'c')],
    ], options);
    const untouched = base.get(second);
    base.rootHash();
    const afterSeal = hashes;
    const owner = beginRadixOverlay(base);
    owner.view.edit(first, previous => value(previous.amount + 1, 'edited'));
    owner.view.put(key(3, 1), value(9, 'new'));
    owner.view.del(third);
    expect(hashes).toBe(afterSeal);

    const prepared = prepareRadixOverlay(owner);
    expect(hashes).toBe(afterSeal);
    expect(prepared.hash).toBeDefined();
    expect(hashes).toBe(afterSeal + 2);
    expect(prepared.values.hashStats().valueHashes).toBe(2);
    const afterFold = hashes;
    expect(prepared.values.rootHash()).toBe(prepared.hash);
    expect(prepared.root).toBe(prepared.hash);
    expect(hashes).toBe(afterFold);
    expect(base.get(first)).toEqual(value(1, 'a'));
    expect(base.get(second)).toBe(untouched);
    expect(base.rootHash()).not.toBe(prepared.root);
  });

  test('overlay fold root does not depend on mutation order', () => {
    const options = makeOptions();
    const base = PersistentRadixValueMap.fromMap([
      [key(1, 1), value(1, 'keep')],
      [key(1, 2), value(2, 'drop')],
    ], options);
    const left = beginRadixOverlay(base);
    left.view.put(key(2, 1), value(3, 'new'));
    left.view.del(key(1, 2));
    left.view.edit(key(1, 1), previous => value(previous.amount + 4, 'edited'));
    const right = beginRadixOverlay(base);
    right.view.edit(key(1, 1), previous => value(previous.amount + 4, 'edited'));
    right.view.del(key(1, 2));
    right.view.put(key(2, 1), value(3, 'new'));
    expect(prepareRadixOverlay(left).root).toBe(prepareRadixOverlay(right).root);
  });

  test('prepare and discard consume their owner exactly once', () => {
    const options = makeOptions();
    const base = PersistentRadixValueMap.empty(options);
    const preparedOwner = beginRadixOverlay(base);
    prepareRadixOverlay(preparedOwner);
    expect(() => preparedOwner.view.has(key(1, 1))).toThrow('RADIX_OVERLAY_NOT_ACTIVE:prepared');
    expect(() => prepareRadixOverlay(preparedOwner)).toThrow('RADIX_OVERLAY_NOT_ACTIVE:prepared');

    const discardedOwner = beginRadixOverlay(base);
    discardRadixOverlay(discardedOwner);
    expect(() => discardedOwner.view.has(key(1, 1))).toThrow('RADIX_OVERLAY_NOT_ACTIVE:discarded');
    expect(() => discardRadixOverlay(discardedOwner)).toThrow('RADIX_OVERLAY_NOT_ACTIVE:discarded');
  });

  test('snapshots object keys before the caller can mutate them', () => {
    const options = makeOptions();
    const mutableKey = { group: 4, item: 2 };
    const base = PersistentRadixValueMap.empty(options);
    const owner = beginRadixOverlay(base);

    owner.view.put(mutableKey, value(42, 'stable'));
    mutableKey.item = 9;
    const prepared = prepareRadixOverlay(owner);

    expect([...prepared.values.entries()]).toEqual([[key(4, 2), value(42, 'stable')]]);
    expect(prepared.values.has(key(4, 9))).toBe(false);
  });

  test('edits a present undefined leaf by membership, not truthiness', () => {
    const undefinedOptions: PersistentRadixValueMapOptions<TestKey, TestValue | undefined> = {
      ...makeOptions(),
      valueHash: entry => ethers.keccak256(
        entry === undefined ? Uint8Array.of(0) : encodeValue(entry),
      ),
      ownValue: entry => entry === undefined ? undefined : Object.freeze({ ...entry }),
    };
    const storedKey = key(5, 1);
    const base = PersistentRadixValueMap.fromMap([[storedKey, undefined]], undefinedOptions);
    const owner = beginRadixOverlay(base);

    owner.view.edit(storedKey, previous => {
      expect(previous).toBeUndefined();
      return value(1, 'defined');
    });
    expect(prepareRadixOverlay(owner).values.get(storedKey)).toEqual(value(1, 'defined'));
  });

  test('an iterator fails immediately if the owner is consumed between steps', () => {
    const options = makeOptions();
    const base = PersistentRadixValueMap.fromMap([
      [key(1, 1), value(1, 'one')],
      [key(1, 2), value(2, 'two')],
    ], options);
    const owner = beginRadixOverlay(base);
    const iterator = owner.view.entries();

    expect(iterator.next().done).toBe(false);
    prepareRadixOverlay(owner);
    expect(() => iterator.next()).toThrow('RADIX_OVERLAY_NOT_ACTIVE:prepared');
  });
});
