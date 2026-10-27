import { concat, getBytes, Mnemonic, toUtf8Bytes } from 'ethers';
import { sha512 } from '@noble/hashes/sha2.js';

/** Persist only an encryption-domain secret; the BIP-39 signing root stays private. */
export const deriveMnemonicCustodySeed = (mnemonic: string): Uint8Array => {
  const normalized = mnemonic.trim().normalize('NFKD').split(/\s+/u).join(' ');
  if (!normalized) throw new Error('ENTITY_CUSTODY_MNEMONIC_REQUIRED');
  return sha512(
    getBytes(concat([toUtf8Bytes('xln:entity-encryption-seed'), Mnemonic.fromPhrase(normalized).computeSeed()])),
  );
};
