import { expect, test } from '@playwright/test';
import { exerciseAssetFaucets } from './assets-faucet';
import { enterStack } from './stack';
import { privateChain } from './dispute-chain';

test(
  'Assets faucets fund four real balances once and require explicit incoming credit consent',
  { tag: '@functional' },
  async ({ page, baseURL }, testInfo) => {
    test.setTimeout(50_000);
    const provider = privateChain(baseURL);
    try {
      await enterStack(page);
      await exerciseAssetFaucets(page, provider, testInfo, 'USDC', expect, '101');
    } finally {
      provider.destroy();
    }
  },
);
