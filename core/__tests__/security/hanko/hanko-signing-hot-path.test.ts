import { expect, test } from 'bun:test';
import { ethers } from 'ethers';

import { deriveSignerAddressSync } from '../../../account/crypto';
import { generateLazyEntityId } from '../../../entity/factory';
import { computeIntegrityDigest } from '../../../support/bytes/integrity-checksum';
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
    '0x1b48ba3e4c9a4b7bf77d9818b7b1a2280562df72b9d14cfb18e230492789762c',
  );
  await expect(verifyHankoForHash(hanko!, digest, entityId)).resolves.toEqual({
    valid: true,
    entityId,
  });
});
