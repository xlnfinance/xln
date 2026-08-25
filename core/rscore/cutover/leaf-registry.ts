/**
 * Engine-computed Entity account leaves, keyed by owner and account.
 *
 * Deliberately free of imports: the account map itself drops entries here on
 * every write boundary, and a leaf that outlived its bytes would corrupt the
 * Entity root silently. See `leaf-cache.ts` for how the digests are used.
 */
const leaves = new Map<string, string>();

const cacheKey = (ownerEntityId: string, accountId: string): string =>
  `${ownerEntityId.toLowerCase()}|${accountId.toLowerCase()}`;

export const rememberEngineAccountLeaf = (
  ownerEntityId: string,
  accountId: string,
  leaf: string,
): void => {
  leaves.set(cacheKey(ownerEntityId, accountId), leaf.toLowerCase());
};

export const peekEngineAccountLeaf = (
  ownerEntityId: string,
  accountId: string,
): string | undefined => leaves.get(cacheKey(ownerEntityId, accountId));

/** Called on every write boundary: the remembered digest no longer holds. */
export const forgetEngineAccountLeaf = (
  ownerEntityId: string,
  accountId: string,
): void => {
  leaves.delete(cacheKey(ownerEntityId, accountId));
};
