import { describe, expect, test } from 'bun:test';

import { generateLazyEntityIdPreview } from '../../../frontend/src/lib/utils/identity/lazyEntityId';

describe('wallet lazy Entity id preview', () => {
  test('matches the independently pinned canonical single-signer vector', () => {
    expect(generateLazyEntityIdPreview([
      '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf',
    ], 1n)).toBe('0x03daa2cc6a91f488a30e6ab87864bdc666916cfedac9d8772974a6e76ae199ea');
  });

  test('rejects a child Entity in the proposer position as canonical creation does', () => {
    expect(() => generateLazyEntityIdPreview([
      '0x03daa2cc6a91f488a30e6ab87864bdc666916cfedac9d8772974a6e76ae199ea',
    ], 1n)).toThrow('BOARD_PROPOSER_EOA_REQUIRED');
  });
});
