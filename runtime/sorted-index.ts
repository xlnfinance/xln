const SORTED_STRING_KEYS = Symbol.for('xln.sorted-string-map-keys');
const SORTED_STRING_HOOKED = Symbol.for('xln.sorted-string-map-hooks');

type SortedStringKeyCache = {
  size: number;
  keys: string[];
};

type IndexedStringMap = Map<string, unknown> & {
  [SORTED_STRING_KEYS]?: SortedStringKeyCache;
  [SORTED_STRING_HOOKED]?: true;
};

export const compareAscii = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const binarySearch = (keys: readonly string[], key: string): { found: boolean; index: number } => {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const order = compareAscii(keys[mid]!, key);
    if (order < 0) lo = mid + 1;
    else hi = mid;
  }
  return { found: keys[lo] === key, index: lo };
};

const setCache = (map: Map<string, unknown>, cache: SortedStringKeyCache): void => {
  Object.defineProperty(map, SORTED_STRING_KEYS, {
    configurable: true,
    enumerable: false,
    writable: true,
    value: cache,
  });
};

const installSortedStringMapHooks = (map: Map<string, unknown>): void => {
  const indexed = map as IndexedStringMap;
  if (indexed[SORTED_STRING_HOOKED]) return;

  const originalSet = map.set.bind(map);
  const originalDelete = map.delete.bind(map);
  const originalClear = map.clear.bind(map);

  Object.defineProperty(map, 'set', {
    configurable: true,
    enumerable: false,
    writable: true,
    value(key: string, value: unknown): Map<string, unknown> {
      const cache = indexed[SORTED_STRING_KEYS];
      const alreadyPresent = map.has(key);
      const result = originalSet(key, value);
      if (!cache || alreadyPresent) return result;
      const keys = cache.keys.slice();
      const { index } = binarySearch(keys, key);
      keys.splice(index, 0, key);
      setCache(map, { size: map.size, keys });
      return result;
    },
  });

  Object.defineProperty(map, 'delete', {
    configurable: true,
    enumerable: false,
    writable: true,
    value(key: string): boolean {
      const cache = indexed[SORTED_STRING_KEYS];
      const existed = map.has(key);
      const deleted = originalDelete(key);
      if (!cache || !existed || !deleted) return deleted;
      const keys = cache.keys.slice();
      const found = binarySearch(keys, key);
      if (!found.found) {
        invalidateSortedStringMapKeys(map);
        return deleted;
      }
      keys.splice(found.index, 1);
      setCache(map, { size: map.size, keys });
      return deleted;
    },
  });

  Object.defineProperty(map, 'clear', {
    configurable: true,
    enumerable: false,
    writable: true,
    value(): void {
      originalClear();
      setCache(map, { size: 0, keys: [] });
    },
  });

  Object.defineProperty(map, SORTED_STRING_HOOKED, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: true,
  });
};

export const invalidateSortedStringMapKeys = (map: Map<string, unknown>): void => {
  const indexed = map as IndexedStringMap;
  if (indexed[SORTED_STRING_KEYS]) delete indexed[SORTED_STRING_KEYS];
};

export const sortedStringMapKeys = (map: Map<string, unknown>): readonly string[] => {
  installSortedStringMapHooks(map);
  const indexed = map as IndexedStringMap;
  const cached = indexed[SORTED_STRING_KEYS];
  if (cached && cached.size === map.size) return cached.keys;
  const keys = Array.from(map.keys()).sort(compareAscii);
  setCache(map, { size: map.size, keys });
  return keys;
};

export const sortedStringMapStartIndex = (
  keys: readonly string[],
  cursor: string,
  pageIndex: number,
  limit: number,
): number => {
  if (Number.isInteger(pageIndex) && pageIndex >= 0) return Math.min(keys.length, pageIndex * limit);
  if (!cursor) return 0;
  const found = binarySearch(keys, cursor);
  return Math.min(keys.length, found.index + (found.found ? 1 : 0));
};

export const upsertSortedStringMapEntry = <T>(
  map: Map<string, T>,
  key: string,
  value: T,
): void => {
  installSortedStringMapHooks(map as unknown as Map<string, unknown>);
  map.set(key, value);
};
