const SORTED_STRING_KEYS = Symbol.for('xln.sorted-string-map-keys');

type SortedStringKeyCache = {
  size: number;
  keys: string[];
};

type IndexedStringMap = Map<string, unknown> & {
  [SORTED_STRING_KEYS]?: SortedStringKeyCache;
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

export const invalidateSortedStringMapKeys = (map: Map<string, unknown>): void => {
  const indexed = map as IndexedStringMap;
  if (indexed[SORTED_STRING_KEYS]) delete indexed[SORTED_STRING_KEYS];
};

export const sortedStringMapKeys = (map: Map<string, unknown>): readonly string[] => {
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
  const indexed = map as unknown as IndexedStringMap;
  const cached = indexed[SORTED_STRING_KEYS];
  const alreadyPresent = map.has(key);
  map.set(key, value);
  if (!cached) return;
  if (alreadyPresent) return;
  const keys = cached.keys.slice();
  const { index } = binarySearch(keys, key);
  keys.splice(index, 0, key);
  setCache(map as unknown as Map<string, unknown>, { size: map.size, keys });
};
