import { isAddress } from 'ethers';
import tronUtils from 'tronweb/utils';

/** Normalize only at the wallet boundary; Entity transactions keep their canonical 20-byte address. */
export function normalizeExternalRecipient(value: string, jurisdictionMode?: string): string {
  const address = value.trim();
  if (isAddress(address)) return address.toLowerCase();
  // Base58 is case-sensitive and checksum-bearing. Never lowercase it before validation,
  // and never interpret a Tron recipient on an EVM jurisdiction.
  if (jurisdictionMode === 'tron' && tronUtils.address.isAddress(address)) {
    const hex = tronUtils.address.toHex(address);
    if (/^41[0-9a-f]{40}$/i.test(hex)) return `0x${hex.slice(2)}`.toLowerCase();
  }
  throw new Error('Recipient must be a valid EOA address');
}
