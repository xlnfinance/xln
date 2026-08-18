import { expect, test } from 'bun:test';
import { ethers } from 'ethers';

import { deriveSignerAddressSync } from '../../../account/crypto';
import { generateLazyEntityId } from '../../../entity/factory';
import { computeIntegrityDigest } from '../../../support/integrity-checksum';
import { createEmptyEnv } from '../../../runtime';
import { signEntityHashes, verifyHankoForHash } from '../../../hanko/signing';

test('single-signer Hanko keeps its canonical bytes after hot-path optimization', async () => {
  const seed = 'hanko-byte-golden-v1';
  const env = createEmptyEnv(seed);
  const signer = deriveSignerAddressSync(seed, '1');
  const entityId = generateLazyEntityId([signer], 1n).toLowerCase();
  const digest = `0x${'ab'.repeat(32)}`;

  const [hanko] = await signEntityHashes(env, entityId, '1', [digest]);
  expect(hanko).toBeDefined();
  expect(computeIntegrityDigest(ethers.getBytes(hanko!))).toBe(
    '0x8f37ae2a19338c4c88423d34899eab801b345806b9ce5d809002d0b11ca40915',
  );
  await expect(verifyHankoForHash(hanko!, digest, entityId)).resolves.toEqual({
    valid: true,
    entityId,
  });
});
