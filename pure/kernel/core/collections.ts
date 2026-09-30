// Immutable collections: every operation returns a new map and leaves its argument alone.

/** A new map with k set to v. It copies m, so a fold that inserts wants mapSetAll. */
export const mapSet = <K, V>(m: ReadonlyMap<K, V>, k: K, v: V): ReadonlyMap<K, V> =>
  new Map([...m, [k, v]]);

/**
 * Every entry set in order, exactly as repeated mapSet would (a later entry wins, an existing key keeps its place),
 * but m is copied once: n inserts cost n, not n² as a fold over mapSet does.
 */
export const mapSetAll = <K, V>(m: ReadonlyMap<K, V>, entries: Iterable<readonly [K, V]>): ReadonlyMap<K, V> =>
  new Map([...m, ...entries]);

export const mapDelete = <K, V>(m: ReadonlyMap<K, V>, k: K): ReadonlyMap<K, V> =>
  new Map([...m].filter(([key]) => key !== k));

/** Adds delta to the count at k; a count that reaches zero leaves the map. */
export const bump = <K>(m: ReadonlyMap<K, bigint>, k: K, delta: bigint): ReadonlyMap<K, bigint> => {
  const next = (m.get(k) ?? 0n) + delta;
  return next === 0n ? mapDelete(m, k) : mapSet(m, k, next);
};

/** Keeps the first item for each key and drops keys already taken; an item without a key always stays. */
export const firstBy = <X, K>(
  xs: Iterable<X>, key: (x: X) => K | undefined, taken: Iterable<K> = [],
): readonly X[] => {
  const items = [...xs];
  const keys = items.map(key);
  const blocked = new Set(taken);
  const firstAt = new Map(keys.map((k, i) => [k, i] as const).toReversed());
  const kept = (i: number): boolean => {
    const k = keys[i];
    return k === undefined || (!blocked.has(k) && firstAt.get(k) === i);
  };
  return items.filter((_, i) => kept(i));
};
