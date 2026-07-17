import { describe, expect, test } from 'bun:test';

import { generateLazyEntityIdPreview } from '../../frontend/src/lib/utils/lazyEntityId';

describe('wallet lazy Entity id preview', () => {
  test('matches the independently pinned canonical single-signer vector', () => {
    expect(generateLazyEntityIdPreview([
      '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf',
    ], 1n)).toBe('0x03daa2cc6a91f488a30e6ab87864bdc666916cfedac9d8772974a6e76ae199ea');
  });

  test('preserves a bytes32 child Entity member without truncating it to an EOA', () => {
    expect(generateLazyEntityIdPreview([
      '0x03daa2cc6a91f488a30e6ab87864bdc666916cfedac9d8772974a6e76ae199ea',
    ], 1n)).toBe('0x502411deebd5451d1b9ba9a78af509975364590b775d32f1a741e0d139c7e5e9');
  });
});
