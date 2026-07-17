import { describe, expect, test } from 'bun:test';

import { loadJurisdictionTokenRegistry } from '../../frontend/src/lib/view/panels/jurisdiction-token-registry';

describe('Jurisdiction token registry loader', () => {
  test('awaits the asynchronous registry result', async () => {
    const tokens = [{ tokenId: 7, symbol: 'ASSET' }];
    await expect(loadJurisdictionTokenRegistry({
      getTokenRegistry: async () => tokens,
    })).resolves.toEqual(tokens);
  });

  test('preserves a contextual error instead of returning an empty catalog', async () => {
    await expect(loadJurisdictionTokenRegistry({
      getTokenRegistry: async () => {
        throw new Error('ECONNREFUSED');
      },
    })).rejects.toThrow('JURISDICTION_TOKEN_REGISTRY_FAILED:ECONNREFUSED');
  });
});
