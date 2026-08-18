import { describe, expect, test } from 'bun:test';

import {
  beginAccountCollectionOverlay,
  discardAccountCollectionOverlay,
  prepareAccountCollectionOverlay,
} from '../../../account/state/account-overlay-map';
import { createDefaultDelta } from '../../../account/state/delta';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import type { Delta } from '../../../types/account';

const deltas = (...rows: readonly Delta[]): PersistentAccountStateMap<number, Delta> =>
  PersistentAccountStateMap.fromEntries('deltas', rows.map(row => [row.tokenId, row]));

describe('Account collection overlay', () => {
  test('edit returns a replacement and leaves the committed leaf untouched', () => {
    const base = deltas(createDefaultDelta(1), createDefaultDelta(2));
    const before = base.get(1);
    const owner = beginAccountCollectionOverlay(base);

    expect(owner.view.get(1)).toBe(before);
    owner.view.edit(1, previous => ({ ...previous, offdelta: previous.offdelta + 7n }));

    expect(base.get(1)).toBe(before);
    expect(base.get(1)?.offdelta).toBe(0n);
    expect(owner.view.get(1)?.offdelta).toBe(7n);
    expect(owner.view.get(1)).not.toBe(before);
    expect(owner.view.get(2)).toBe(base.get(2));
  });

  test('put and delete roots equal direct persistent operations', () => {
    const added = { ...createDefaultDelta(3), offdelta: 9n };
    const base = deltas(createDefaultDelta(1), createDefaultDelta(2));
    const baseRoot = base.rootHash();

    const putOwner = beginAccountCollectionOverlay(base);
    putOwner.view.put(3, added);
    const inserted = prepareAccountCollectionOverlay(putOwner);
    const directInsert = base.updated(3, added);

    const deleteOwner = beginAccountCollectionOverlay(base);
    deleteOwner.view.del(1);
    const deleted = prepareAccountCollectionOverlay(deleteOwner);
    const directDelete = base.removed(1);

    expect(base.rootHash()).toBe(baseRoot);
    expect(base.rootHash()).toBe(base.coldRootHash());
    expect(inserted.values.rootHash()).toBe(directInsert.rootHash());
    expect(inserted.values.rootHash()).toBe(inserted.values.coldRootHash());
    expect(deleted.values.rootHash()).toBe(directDelete.rootHash());
    expect(deleted.values.rootHash()).toBe(deleted.values.coldRootHash());
    expect(inserted.nodeChanges.puts.length).toBeGreaterThan(0);
    expect(inserted.nodeChanges.puts.length).toBeLessThan(70);
    expect(deleted.nodeChanges.dels.length).toBeGreaterThan(0);
    expect(deleted.nodeChanges.dels.length).toBeLessThan(70);
  });

  test('machine owner is consumed after prepare or discard', () => {
    const base = deltas(createDefaultDelta(1));
    const prepared = beginAccountCollectionOverlay(base);
    expect(prepareAccountCollectionOverlay(prepared).values.get(1)?.tokenId).toBe(1);
    expect(() => prepared.view.get(1)).toThrow('RADIX_OVERLAY_NOT_ACTIVE:prepared');
    expect(() => prepareAccountCollectionOverlay(prepared))
      .toThrow('RADIX_OVERLAY_NOT_ACTIVE:prepared');
    discardAccountCollectionOverlay(prepared);
    expect(() => prepared.view.get(1)).toThrow('RADIX_OVERLAY_NOT_ACTIVE:discarded');

    const discarded = beginAccountCollectionOverlay(base);
    discardAccountCollectionOverlay(discarded);
    expect(() => discarded.view.has(1)).toThrow('RADIX_OVERLAY_NOT_ACTIVE:discarded');
    expect(() => discardAccountCollectionOverlay(discarded))
      .toThrow('RADIX_OVERLAY_NOT_ACTIVE:discarded');
  });

  test('prepare rejects a leaf larger than 10 KiB', () => {
    const base = PersistentAccountStateMap.empty<string, { blob: string }>('locks');
    const owner = beginAccountCollectionOverlay(base);
    owner.view.put('big', { blob: 'x'.repeat(12 * 1024) });

    expect(() => prepareAccountCollectionOverlay(owner)).toThrow('ACCOUNT_STATE_LEAF_TOO_LARGE');
    expect(base.size).toBe(0);
  });

  test('committed leaves cannot change behind their Patricia hash', () => {
    const base = PersistentAccountStateMap.fromEntries(
      'locks',
      [['sealed', { amount: 7n, nested: { flag: true } }]],
    );
    const beforeRoot = base.rootHash();
    const leaf = base.get('sealed');
    if (!leaf) throw new Error('TEST_SEALED_LEAF_MISSING');

    expect(Reflect.set(leaf, 'extra', 1)).toBe(false);
    expect(Reflect.deleteProperty(leaf, 'amount')).toBe(false);
    expect(Reflect.defineProperty(leaf.nested, 'flag', { value: false })).toBe(false);
    expect(Object.isFrozen(leaf)).toBe(true);
    expect(Object.isFrozen(leaf.nested)).toBe(true);
    expect(base.rootHash()).toBe(beforeRoot);
    expect(base.coldRootHash()).toBe(beforeRoot);
  });
});
