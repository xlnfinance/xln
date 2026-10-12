import { expect, test } from '@playwright/test';
import type { RuntimeAdapterViewFrame } from '../../core/api/public/runtime-module';
import type { RuntimeAdapter } from '../../core/api/runtime-adapter/types';
import { safeStringify } from '../../core/protocol/serialization';
import { Depository__factory } from '../../jurisdictions/typechain-types/factories/Depository.sol/Depository__factory';
import { privateChain } from './dispute-chain';
import { enterStack } from './stack';

test(
  'reserve funding waits for a real block beyond the old server and browser deadlines',
  { tag: '@functional' },
  async ({ page, baseURL }, testInfo) => {
    test.setTimeout(60_000);
    const provider = privateChain(baseURL);
    const wallet = await enterStack(page);
    const address = await page.evaluate(async entityId => {
      const adapter = (window as Window & { __xln?: { adapter: () => RuntimeAdapter | null } }).__xln?.adapter();
      if (!adapter) throw new Error('RESERVE_FUNDING_RUNTIME_MISSING');
      const frame = await adapter.read<RuntimeAdapterViewFrame>('view-frame', { entityId });
      return frame.activeEntity?.core.config.jurisdiction?.depositoryAddress;
    }, wallet.entityId);
    if (!address) throw new Error('RESERVE_FUNDING_DEPOSITORY_MISSING');
    const contract = Depository__factory.connect(address, provider);
    let requests = 0;
    page.on('request', request => {
      if (new URL(request.url()).pathname === '/api/faucet/reserve' && request.method() === 'POST') requests++;
    });
    try {
      await page.getByTestId('nav-manage').locator('visible=true').first().click();
      await page.getByTestId('manage-assets').click();
      await page.getByTestId('faucet-amount').fill('1');
      expect(await contract._reserves(wallet.entityId, 1)).toBe(0n);
      await provider.send('evm_setAutomine', [false]);
      await provider.send('evm_setIntervalMining', [0]);
      const response = page.waitForResponse(
        res => new URL(res.url()).pathname === '/api/faucet/reserve' && res.request().method() === 'POST',
        { timeout: 45_000 },
      );
      const submitted = page.waitForRequest(
        req => new URL(req.url()).pathname === '/api/faucet/reserve' && req.method() === 'POST',
      );
      await page.getByTestId('faucet-reserve').click();
      await submitted;
      // No fabricated receipt or clock advance: the actual transaction cannot
      // be mined for 22 wall seconds (old API wait 10s, old browser wait 20s).
      await new Promise(resolve => setTimeout(resolve, 22_000));
      expect(await contract._reserves(wallet.entityId, 1)).toBe(0n);
      await provider.send('evm_setIntervalMining', [1]);
      const result = await response;
      const receipt: unknown = await result.json();
      expect(result.ok(), safeStringify(receipt)).toBe(true);
      expect(receipt).toMatchObject({ success: true, amount: '1', tokenId: 1 });
      await expect(page.getByTestId('faucet-reserve')).toBeEnabled({ timeout: 10_000 });
      expect(await contract._reserves(wallet.entityId, 1)).toBe(1_000_000n);
      expect(requests).toBe(1);
      await testInfo.attach('delayed-reserve-receipt', {
        body: safeStringify(receipt),
        contentType: 'application/json',
      });
    } finally {
      await provider.send('evm_setIntervalMining', [1]);
      provider.destroy();
    }
  },
);
