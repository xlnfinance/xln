import { expect, spyOn, test } from 'bun:test';
import { HDNodeWallet } from 'ethers';

import {
  clearSignerKeys,
  deriveSignerAddressSync,
  getCachedSignerPrivateKey,
  prewarmNumericSigners,
  prewarmSignerKeyCache,
} from '../../account/crypto';

// Unlock warms the wallet's own signers (Runtime id plus one HD path per
// jurisdiction) once; main() then reuses signer 1. Each BIP-39 root costs one
// PBKDF2-SHA512 pass, so a second warm of the same signers derives nothing.
test('numeric signers warm from one BIP-39 root and are reused by the Runtime prewarm', () => {
  const seed = HDNodeWallet.createRandom().mnemonic!.phrase;
  const fromPhrase = spyOn(HDNodeWallet, 'fromPhrase');
  try {
    const signerIds = ['1', '1048577'];
    const addresses = prewarmNumericSigners(seed, signerIds);
    expect(fromPhrase).toHaveBeenCalledTimes(1);
    expect(addresses).toEqual(signerIds.map(signerId => deriveSignerAddressSync(seed, signerId).toLowerCase()));
    for (const address of addresses) {
      expect(getCachedSignerPrivateKey(seed, address)).toBeInstanceOf(Uint8Array);
    }
    fromPhrase.mockClear();
    expect(prewarmSignerKeyCache(seed, 1)).toEqual([addresses[0]]);
    expect(fromPhrase).not.toHaveBeenCalled();
    expect(() => prewarmNumericSigners(seed, ['0x1234'])).toThrow('SIGNER_CACHE_PREWARM_ID_NOT_NUMERIC');
  } finally {
    fromPhrase.mockRestore();
    clearSignerKeys(seed);
  }
});
