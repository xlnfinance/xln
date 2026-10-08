import { expect, test } from 'bun:test';
import { canDeployHubDefaultTokens, requiredHubTokenCount, selectHubTokenCatalog } from '../../../orchestrator/hub/node/token-catalog';

test('native TVM accepts its real registered assets and never deploys dev defaults', () => {
  const catalog = [{ tokenId: 7, symbol: 'XLNUSD', name: 'Real registry', decimals: 6, address: '0x0000000000000000000000000000000000000007', tokenType: 0, externalTokenId: 0n }];
  expect(requiredHubTokenCount(2414086651)).toBe(1);
  expect(canDeployHubDefaultTokens(2414086651)).toBe(false);
  expect(selectHubTokenCatalog(catalog, 2414086651, [1, 2, 3])).toEqual(catalog);
  expect(canDeployHubDefaultTokens(1)).toBe(false);
});

test('explicit dev chains retain the three-token bootstrap requirement', () => {
  for (const chainId of [31337, 31338]) {
    expect(requiredHubTokenCount(chainId)).toBe(3);
    expect(canDeployHubDefaultTokens(chainId)).toBe(true);
  }
});
