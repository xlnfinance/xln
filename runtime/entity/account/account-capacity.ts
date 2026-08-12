import { LIMITS } from '../../config/constants';

const normalizedAccountId = (value: unknown): string => String(value ?? '').trim().toLowerCase();

export const assertEntityAccountCountWithinLimit = (
  accounts: ReadonlyMap<string, unknown>,
  context: string,
): void => {
  if (accounts.size <= LIMITS.MAX_ACCOUNTS_PER_ENTITY) return;
  throw new Error(
    `ENTITY_ACCOUNT_LIMIT_EXCEEDED: context=${context} ` +
      `accounts=${accounts.size} limit=${LIMITS.MAX_ACCOUNTS_PER_ENTITY}`,
  );
};

/** One capacity formula; local commands throw it, authenticated peer input rejects it. */
export const getEntityAccountInsertionCapacityError = (
  accounts: ReadonlyMap<string, unknown>,
  accountId: string,
  context: string,
): string | undefined => {
  const target = normalizedAccountId(accountId);
  if (accounts.has(target) || accounts.size < LIMITS.MAX_ACCOUNTS_PER_ENTITY) return undefined;
  return (
    `ENTITY_ACCOUNT_LIMIT_EXCEEDED: context=${context} account=${target || 'invalid'} ` +
    `accounts=${accounts.size} limit=${LIMITS.MAX_ACCOUNTS_PER_ENTITY}`
  );
};

/**
 * Returns false for an existing canonical key so replacement/idempotent replay
 * does not consume another slot. A genuinely new account must reserve capacity
 * before cloning, dirty-marking, or mutating consensus state.
 */
export const assertEntityAccountInsertionCapacity = (
  accounts: ReadonlyMap<string, unknown>,
  accountId: string,
  context: string,
): boolean => {
  const target = normalizedAccountId(accountId);
  if (accounts.has(target)) return false;
  const error = getEntityAccountInsertionCapacityError(accounts, accountId, context);
  if (error) throw new Error(error);
  return true;
};
