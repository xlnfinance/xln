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
 * Ordered Account inputs may supersede an earlier obligation in the same Entity
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
 * The Map's insertion order is the accepted Account-input order. New work is
 * appended at first touch. Parallel implementations must return each result
 * to this same RAM position; Account ids never choose publication order.
 */
export const createCanonicalAccountWorklist = (
  accounts: ReadonlyMap<string, boolean>,
): CanonicalAccountWorklist => {
  const forced = new Map(
    [...accounts].map(([accountId, force]) => [normalizeAccountId(accountId), force] as const),
  );
  const queue = [...forced.keys()];
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
      queue.push(key);
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
