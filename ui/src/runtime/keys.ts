import { Mnemonic, getBytes } from 'ethers';
import {
  deriveRuntimeSignerAddress,
  deriveRuntimeSignerPrivateKey,
} from '@xln/core/storage/recovery/bundle/seed-identity';
import { deriveJurisdictionSignerIndex } from '@xln/core/jurisdiction/machine/config/signer-derivation';

export function deriveAddress(seed: string, index: number): string {
  return deriveRuntimeSignerAddress(seed, index);
}
export function derivePrivateKey(seed: string, index: number): string {
  return deriveRuntimeSignerPrivateKey(seed, index);
}
export function derivePrivateKeyBytes(seed: string, index: number): Uint8Array {
  return getBytes(derivePrivateKey(seed, index));
}

/** Prove this wallet's current HD path against the actual EOA before granting a key. */
export function walletSignerIndex(seed: string, address: string, jurisdiction: string): number | null {
  if (deriveAddress(seed, 0) === address) return 0;
  if (!jurisdiction) return null;
  const candidate = deriveJurisdictionSignerIndex(jurisdiction);
  return deriveAddress(seed, candidate) === address ? candidate : null;
}

export function isValidMnemonic(phrase: string): boolean {
  try {
    Mnemonic.fromPhrase(phrase.trim());
    return true;
  } catch {
    return false;
  }
}

export function runtimeIdForSeed(seed: string): string {
  return deriveAddress(seed, 0);
}
