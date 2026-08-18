import { compareStableText } from '../../../protocol/serialization';

export type CanonicalAccountWorklist = Readonly<{
  add(accountId: string): boolean;
  take(): string | undefined;
}>;

/**
 * Deterministic Account work queue for one Entity frame.
 *
 * Sorting the remaining Set before every proposal made A active Accounts cost
 * O(A^2 log A). The initial frontier is sorted once. Work discovered while an
 * Account is reduced is inserted into the unread suffix, preserving exactly
 * the order produced by repeatedly sorting the remaining Set.
 */
export const createCanonicalAccountWorklist = (
  accountIds: Iterable<string>,
): CanonicalAccountWorklist => {
  const queue = [...new Set(accountIds)].sort(compareStableText);
  const scheduled = new Set(queue);
  let cursor = 0;

  return Object.freeze({
    add(accountId: string): boolean {
      if (scheduled.has(accountId)) return false;
      scheduled.add(accountId);
      let low = cursor;
      let high = queue.length;
      while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if (compareStableText(queue[middle]!, accountId) <= 0) low = middle + 1;
        else high = middle;
      }
      queue.splice(low, 0, accountId);
      return true;
    },
    take(): string | undefined {
      const accountId = queue[cursor];
      if (accountId !== undefined) cursor += 1;
      return accountId;
    },
  });
};
