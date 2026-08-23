/**
 * Run `fn` over `items` with at most `concurrency` in flight. Items are taken
 * in order; a rejected item rejects the whole call (no retry, no swallow).
 */
export const forEachLimited = async <T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> => {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error(`FOR_EACH_LIMITED_CONCURRENCY_INVALID:${String(concurrency)}`);
  }
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await fn(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
};
