export const compareAscii = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

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

/** Ascending ASCII keys; sorted per call — no cache, so in-place map mutation can never serve stale keys. */
export const sortedStringMapKeys = <T>(map: ReadonlyMap<string, T>): readonly string[] =>
  Array.from(map.keys()).sort(compareAscii);

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
