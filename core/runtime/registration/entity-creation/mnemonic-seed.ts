import { getBytes, Mnemonic } from 'ethers';

/** Validate a BIP-39 phrase and return its canonical PBKDF2 seed bytes. */
export const deriveMnemonicCustodySeed = (mnemonic: string): Uint8Array => {
  const normalized = mnemonic.trim().normalize('NFKD').split(/\s+/u).join(' ');
  if (!normalized) throw new Error('ENTITY_CUSTODY_MNEMONIC_REQUIRED');
  return getBytes(Mnemonic.fromPhrase(normalized).computeSeed());
};
