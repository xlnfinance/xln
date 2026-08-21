/**
 * ethers.getAddress keccaks every call to derive the checksum. Hot paths only
 * need "is this a valid address, lowercased" for the same handful of strings
 * (depository, runtime ids, contract addresses, Hanko recoveries), so memoize
 * the checksummed answer. Consensus bytes are unchanged: the value is still
 * ethers' EIP-55 checksum, just not recomputed.
 */
import { getAddress } from 'ethers';
import { countOp } from '../../support/performance/op-counters';

const MAX_ENTRIES = 32_768;
const checksumCache = new Map<string, string | null>();

const lookupChecksum = (value: string): string | null => {
  const cached = checksumCache.get(value);
  if (cached !== undefined) {
    countOp('address.cache.hit');
    return cached;
  }
  countOp('address.cache.miss');
  let checksummed: string | null;
  try {
    checksummed = getAddress(value);
  } catch {
    checksummed = null;
  }
  if (checksumCache.size >= MAX_ENTRIES) checksumCache.clear();
  checksumCache.set(value, checksummed);
  return checksummed;
};

/** Lowercased address for a valid input (checksum-validated like ethers), else null. */
export const toLowerAddressOrNull = (value: string): string | null => {
  const checksummed = lookupChecksum(value);
  return checksummed === null ? null : checksummed.toLowerCase();
};

/**
 * Same throw behavior as ethers.getAddress, cache-hit after the first keccak.
 * Callers that need the mixed-case checksum (ABI pack, recovered Hanko) use this.
 */
export const cachedChecksumAddress = (value: string): string => {
  const checksummed = lookupChecksum(value);
  if (checksummed === null) return getAddress(value);
  return checksummed;
};
