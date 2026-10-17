import { expect, test, type Page } from '../../global-setup.mts';
import { safeStringify } from '../../../core/protocol/serialization';
import { createWalletIdentity, LOCAL_PASSWORD } from '../../../ui/tests/wallet-ui';
import { clickFaucet, openMove, readRoutes } from '../../../ui/tests/move-wallet';
import { ensureE2EBaseline, API_BASE_URL, APP_BASE_URL } from '../../utils/e2e-baseline';
import { gotoApp, selectDemoMnemonic } from '../../utils/e2e-demo-users';

const WAIT = { timeout: 15_000, intervals: [100, 250, 500] };
const openAssets = async (page: Page): Promise<void> => {
  await page.getByTestId('nav-manage').locator('visible=true').first().click();
  await page.getByTestId('manage-assets').click();
  await expect(page.getByTestId('external-balance-USDC')).toBeVisible();
};

test(
  'move external to external sends directly from signer wallet',
  { tag: '@functional' },
  async ({ page, browser }, testInfo) => {
    test.setTimeout(55_000);
    await ensureE2EBaseline(page, {
      apiBaseUrl: API_BASE_URL,
      requireHubMesh: true,
      requireMarketMaker: false,
      minHubCount: 3,
    });
    const bobContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const bobPage = await bobContext.newPage();
    try {
      await Promise.all([gotoApp(page, { appBaseUrl: APP_BASE_URL }), gotoApp(bobPage, { appBaseUrl: APP_BASE_URL })]);
      const [alice, bob] = await Promise.all([
        createWalletIdentity(page, 'alice', selectDemoMnemonic('alice')),
        createWalletIdentity(bobPage, 'bob', selectDemoMnemonic('bob')),
      ]);
      await Promise.all([openAssets(page), openAssets(bobPage)]);
      await expect(page.getByTestId('external-balance-USDC')).toHaveText('0.00');
      await expect(bobPage.getByTestId('external-balance-USDC')).toHaveText('0.00');
      const initial = await readRoutes(page, bob.signerId);
      expect(initial.external).toBe('0');
      expect(initial.foreign).toBe('0');
      expect(initial.signerId).toBe(alice.signerId);
      await clickFaucet(page, 'gas', expect);
      await page.getByTestId('faucet-amount').fill('20');
      await clickFaucet(page, 'erc20', expect);
      await expect(page.getByTestId('external-balance-USDC')).toHaveText('20.00', WAIT);
      const before = await readRoutes(page, bob.signerId);
      expect(before.external).toBe('20000000');
      expect(before.foreign).toBe('0');
      expect(before.reserve).toBe('0');
      expect(before.allowance).toBe('0');
      expect(before.batch).toEqual({ draftOperations: 0, sent: false });

      await openMove(page, 'external', 'external');
      await page.getByTestId('move-amount').fill('1');
      await page.getByTestId('move-external-recipient').fill(alice.signerId);
      await expect(page.getByTestId('move-send-external')).toBeDisabled();
      await page.getByTestId('move-external-recipient').fill(bob.signerId);
      await expect(page.getByTestId('move-send-external')).toBeEnabled();
      await page.getByTestId('move-send-external').click();
      await expect(page.getByTestId('move-amount')).toHaveValue('', WAIT);
      await expect
        .poll(async () => {
          const state = await readRoutes(page, bob.signerId);
          return {
            external: state.external,
            foreign: state.foreign,
            reserve: state.reserve,
            allowance: state.allowance,
            batch: state.batch,
          };
        }, WAIT)
        .toEqual({
          external: '19000000',
          foreign: '1000000',
          reserve: '0',
          allowance: '0',
          batch: { draftOperations: 0, sent: false },
        });
      // Bob stays on Assets: receipt must become visible without a manual refresh or re-import.
      await expect(bobPage.getByTestId('external-balance-USDC')).toHaveText('1.00', WAIT);
      await openAssets(page);
      await expect(page.getByTestId('external-balance-USDC')).toHaveText('19.00', WAIT);
      const after = await readRoutes(page, bob.signerId);
      expect(BigInt(after.external) + BigInt(after.foreign ?? '')).toBe(20_000_000n);
      expect((await readRoutes(bobPage, alice.signerId)).external).toBe(after.foreign);

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.getByLabel('Password', { exact: true }).fill(LOCAL_PASSWORD);
      await page.getByRole('button', { name: 'Unlock', exact: true }).click();
      await expect(page.getByTestId('nav-home').locator('visible=true').first()).toBeVisible();
      await openAssets(page);
      await expect(page.getByTestId('external-balance-USDC')).toHaveText('19.00', WAIT);
      const restored = await readRoutes(page, bob.signerId);
      expect(restored.external).toBe(after.external);
      expect(restored.foreign).toBe(after.foreign);
      expect(restored.reserve).toBe(after.reserve);
      expect(restored.batch).toEqual(after.batch);
      await testInfo.attach('direct-erc20-transfer', {
        contentType: 'application/json',
        body: safeStringify({ before, after, restored }),
      });
    } finally {
      await bobContext.close();
    }
  },
);
