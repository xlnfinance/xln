/**
 * ethers.getAddress keccaks every call to derive the checksum. Hot paths only
 * need "is this a valid address, lowercased" for the same handful of strings
 * (depository, runtime ids, contract addresses), so memoize the answer.
 */
import { getAddress } from 'ethers';

const MAX_ENTRIES = 4096;
const cache = new Map<string, string | null>();

/** Lowercased address for a valid input (checksum-validated like ethers), else null. */
export const toLowerAddressOrNull = (value: string): string | null => {
  const cached = cache.get(value);
  if (cached !== undefined) return cached;
  let normalized: string | null;
  try {
    normalized = getAddress(value).toLowerCase();
  } catch {
    normalized = null;
  }
  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(value, normalized);
  return normalized;
};

export const isAddressCached = (value: unknown): value is string =>
  typeof value === 'string' && toLowerAddressOrNull(value) !== null;
