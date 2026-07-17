import { LIMITS } from '../constants';

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

/**
 * Returns false for an existing normalized key so replacement/idempotent replay
 * does not consume another slot. A genuinely new account must reserve capacity
 * before cloning, dirty-marking, or mutating consensus state.
 */
export const assertEntityAccountInsertionCapacity = (
  accounts: ReadonlyMap<string, unknown>,
  accountId: string,
  context: string,
): boolean => {
  const target = normalizedAccountId(accountId);
  for (const existingId of accounts.keys()) {
    if (normalizedAccountId(existingId) === target) return false;
  }
  if (accounts.size >= LIMITS.MAX_ACCOUNTS_PER_ENTITY) {
    throw new Error(
      `ENTITY_ACCOUNT_LIMIT_EXCEEDED: context=${context} account=${target || 'invalid'} ` +
        `accounts=${accounts.size} limit=${LIMITS.MAX_ACCOUNTS_PER_ENTITY}`,
    );
  }
  return true;
};
