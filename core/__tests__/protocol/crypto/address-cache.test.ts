import { getAddress } from 'ethers';
import { expect, test } from 'bun:test';

import { cachedChecksumAddress, toLowerAddressOrNull } from '../../../protocol/crypto/address-cache';

const RAW = '0xbf8d488076a9924c82086a0da5a80a8b4d9f1b5b';

test('cached checksum matches ethers and lowercases without a second keccak path', () => {
  const checksummed = cachedChecksumAddress(RAW);
  expect(checksummed).toBe(getAddress(RAW));
  expect(toLowerAddressOrNull(RAW)).toBe(checksummed.toLowerCase());
  expect(cachedChecksumAddress(RAW)).toBe(checksummed);
  expect(toLowerAddressOrNull('not-an-address')).toBeNull();
});
