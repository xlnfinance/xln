import { describe, expect, test } from 'bun:test';

import { PersistentAccountStateMap } from '../../account/state/persistent-state-map';
import { reuseAccountStateMap } from '../../storage/read/hydration';

type Leaf = Readonly<{ amount: bigint; note?: string; tags: readonly string[] }>;

const leaf = (amount: bigint, tags: readonly string[] = ['a'], note?: string): Leaf =>
  note === undefined ? { amount, tags } : { amount, tags, note };

describe('reuseAccountStateMap', () => {
  const previous = PersistentAccountStateMap.fromEntries<number, Leaf>('deltas', [
    [1, leaf(10n)],
    [2, leaf(20n, ['x', 'y'])],
    [3, leaf(30n, [], 'keep')],
  ]);

  test('unchanged leaves keep their sealed identity; changed ones are re-sealed', () => {
    const decoded = new Map<number, Leaf>([
      [1, leaf(10n)],
      [2, leaf(21n, ['x', 'y'])],
      [3, leaf(30n, [], 'keep')],
      [4, leaf(40n)],
    ]);
    const next = reuseAccountStateMap('deltas', decoded, previous);
    const fresh = PersistentAccountStateMap.fromEntries('deltas', decoded);
    expect(next.rootHash()).toBe(fresh.rootHash());
    expect(next.size).toBe(4);
    expect(next.get(1)).toBe(previous.get(1));
    expect(next.get(3)).toBe(previous.get(3));
    expect(next.get(2)).not.toBe(previous.get(2));
    expect(next.get(2)).toEqual(leaf(21n, ['x', 'y']));
    expect(previous.size).toBe(3);
  });

  test('removed keys are dropped and an identical map is returned as-is', () => {
    const decoded = new Map<number, Leaf>([[1, leaf(10n)], [3, leaf(30n, [], 'keep')]]);
    const next = reuseAccountStateMap('deltas', decoded, previous);
    expect(next.size).toBe(2);
    expect(next.has(2)).toBe(false);
    expect(next.rootHash()).toBe(PersistentAccountStateMap.fromEntries('deltas', decoded).rootHash());
    const same = reuseAccountStateMap('deltas', new Map(previous.entries()), previous);
    expect(same).toBe(previous);
  });

  test('structural differences never alias: missing vs undefined field, bigint vs number', () => {
    const decodedUndefined = new Map<number, Leaf>([[3, { amount: 30n, tags: [], note: undefined }]]);
    const withUndefined = reuseAccountStateMap('deltas', decodedUndefined, previous);
    expect(withUndefined.get(3)).not.toBe(previous.get(3));
    const decodedNumber = new Map<number, unknown>([[1, { amount: 10, tags: ['a'] }]]);
    const withNumber = reuseAccountStateMap('deltas', decodedNumber, previous);
    expect(withNumber.get(1)).not.toBe(previous.get(1));
  });

  test('namespace mismatch or no previous map falls back to a fresh fold', () => {
    const decoded = new Map<number, Leaf>([[1, leaf(10n)]]);
    const fresh = reuseAccountStateMap('deltas', decoded, undefined);
    expect(fresh.rootHash()).toBe(PersistentAccountStateMap.fromEntries('deltas', decoded).rootHash());
    const other = PersistentAccountStateMap.fromEntries<number, Leaf>('locks', [[1, leaf(10n)]]);
    const relinked = reuseAccountStateMap('deltas', decoded, other);
    expect(relinked.namespace).toBe('deltas');
    expect(relinked.get(1)).not.toBe(other.get(1));
  });
});
