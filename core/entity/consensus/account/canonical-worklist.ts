import { compareStableText } from '../../../protocol/serialization';

/**
 * One frame-local Account work authority.
 *
 * `true` means the Account transition owes a peer response even when its
 * mempool is empty. The exact response bytes travel in the frame-local
 * `forcedAccountInputs` map beside this bit; reconstructing them from a stale
 * Entity-side Account mirror would make the Rust cutover non-authoritative.
 */
export type ProposableAccountMap = Map<string, boolean>;

type CanonicalAccountWork = Readonly<{
  accountId: string;
  force: boolean;
}>;

export type CanonicalAccountWorklist = Readonly<{
  add(accountId: string, force?: boolean): boolean;
  take(): CanonicalAccountWork | undefined;
}>;

const normalizeAccountId = (accountId: string): string => accountId.toLowerCase();

/** Normal work must never erase an already mandatory peer response. */
export const markProposableAccount = (
  accounts: ProposableAccountMap,
  accountId: string,
  force = false,
): void => {
  const key = normalizeAccountId(accountId);
  accounts.set(key, Boolean(accounts.get(key)) || force);
};

/**
 * Ordered peer inputs may supersede an earlier obligation in the same Entity
 * frame. In particular, a pure ACK commits our pending proposal and must clear
 * `force` so the final flush cannot create an ACK loop.
 */
export const setProposableAccountForce = (
  accounts: ProposableAccountMap,
  accountId: string,
  force: boolean,
): void => {
  accounts.set(normalizeAccountId(accountId), force);
};

/**
 * Deterministic Account work queue for one Entity frame.
 *
 * Sorting the remaining Set before every proposal made A active Accounts cost
 * O(A^2 log A). The initial frontier is sorted once. Work discovered while an
 * Account is reduced is inserted into the unread suffix, preserving exactly
 * the order produced by repeatedly sorting the remaining Set.
 */
export const createCanonicalAccountWorklist = (
  accounts: ReadonlyMap<string, boolean>,
): CanonicalAccountWorklist => {
  const forced = new Map(
    [...accounts].map(([accountId, force]) => [normalizeAccountId(accountId), force] as const),
  );
  const queue = [...forced.keys()].sort(compareStableText);
  const scheduled = new Set(queue);
  let cursor = 0;

  return Object.freeze({
    add(accountId: string, force = false): boolean {
      const key = normalizeAccountId(accountId);
      if (scheduled.has(key)) {
        if (force) forced.set(key, true);
        return false;
      }
      scheduled.add(key);
      forced.set(key, force);
      let low = cursor;
      let high = queue.length;
      while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if (compareStableText(queue[middle]!, key) <= 0) low = middle + 1;
        else high = middle;
      }
      queue.splice(low, 0, key);
      return true;
    },
    take(): CanonicalAccountWork | undefined {
      const accountId = queue[cursor];
      if (accountId !== undefined) cursor += 1;
      return accountId === undefined
        ? undefined
        : { accountId, force: forced.get(accountId) === true };
    },
  });
};
