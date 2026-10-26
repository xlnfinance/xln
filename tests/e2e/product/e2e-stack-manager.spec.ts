import { ethers } from 'ethers';
import { expect, test, type Page } from '../../global-setup.mts';
import { resolveRuntimeImportAppUrl } from '../../utils/runtime/e2e-runtime-import';
import { requireIsolatedBaseUrl } from '../../utils/runtime/e2e-isolated-env';
import {
  deriveAnvilDevPrivateKey,
  STACK_MANAGER_E2E_FUNDER_INDEX,
} from '../../../core/orchestrator/support/anvil-dev-accounts';

const APP_BASE_URL = requireIsolatedBaseUrl('E2E_BASE_URL');
const INIT_TIMEOUT = 30_000;
const DEPLOY_TIMEOUT = 3 * 60_000;

const requireAnvilRpc = (): string => {
  const rpcUrl = process.env.E2E_ANVIL_RPC?.trim();
  if (!rpcUrl || rpcUrl.endsWith(':1')) throw new Error('STACK_MANAGER_E2E_ANVIL_RPC_REQUIRED');
  return rpcUrl;
};

// Gas arrives by a mined transfer from the Anvil account reserved for this
// spec: anvil_setBalance would rewrite state under the sealed header that the
// mesh's J watchers verify with eth_getProof, and fail-stop them.
const STACK_MANAGER_FUNDER_KEY = deriveAnvilDevPrivateKey(STACK_MANAGER_E2E_FUNDER_INDEX);

const fundSigner = async (rpcUrl: string, signerId: string): Promise<void> => {
  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true, cacheTimeout: -1 });
  try {
    const funder = new ethers.Wallet(STACK_MANAGER_FUNDER_KEY, provider);
    const receipt = await (await funder.sendTransaction({ to: signerId, value: ethers.parseEther('100') })).wait();
    if (receipt?.status !== 1) throw new Error(`STACK_MANAGER_E2E_SIGNER_FUNDING_FAILED:${receipt?.hash ?? 'none'}`);
  } finally {
    provider.destroy();
  }
};

async function openStackManager(page: Page): Promise<void> {
  const importUrl = await resolveRuntimeImportAppUrl(page, {
    appBaseUrl: APP_BASE_URL,
    apiBaseUrl: APP_BASE_URL,
    access: 'admin',
  });
  await page.goto(importUrl, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Load runtime list', exact: true }).click();
  await page.getByRole('button', { name: 'Validate & attach', exact: true }).click();
  const h1 = page.getByTestId('validated-runtime').filter({ has: page.getByText('H1', { exact: true }) });
  await expect(h1).toBeVisible({ timeout: INIT_TIMEOUT });
  const entityId = await h1.getAttribute('data-entity-id');
  if (!entityId) throw new Error('STACK_MANAGER_H1_ENTITY_MISSING');
  await h1.click();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(entityId.slice(0, 18)) }).click();
  await expect(page.getByTestId('home-entity-id')).toHaveText(entityId);
  expect(await page.evaluate(() => Object.values(localStorage).some(value => value.includes('xlnra1.')))).toBe(false);
  await page.getByTestId('nav-settings').locator('visible=true').first().click();
  await page.getByTestId('settings-stack-manager').locator('summary').first().click();
  await expect(page.getByTestId('stack-manager-v1')).toBeVisible({ timeout: INIT_TIMEOUT });
}

test('Stack Manager deploys and verifies V1 on the isolated Anvil', { tag: '@functional' }, async ({ page }, testInfo) => {
  test.setTimeout(5 * 60 * 1000);
  await openStackManager(page);

  const rpcUrl = requireAnvilRpc();
  const signer = page.getByTestId('stack-manager-signer');
  await expect(signer).toBeEnabled({ timeout: INIT_TIMEOUT });
  const signerId = await signer.inputValue();
  expect(signerId).toMatch(/^0x[0-9a-f]{40}$/);
  await fundSigner(rpcUrl, signerId);

    await page.getByTestId('stack-manager-rpc').fill(rpcUrl);
    await page.getByTestId('stack-manager-name').fill('E2E Community Stack');
    await page.getByText('Advanced deployment parameters', { exact: true }).click();
    await page.getByTestId('stack-manager-key').fill(`e2e-${Date.now()}`);
    await page.getByTestId('stack-manager-stablecoin').selectOption('test');
    await page.getByTestId('stack-manager-publication').selectOption('community');
    await page.getByTestId('stack-manager-confirmations').fill('1');
    await expect(page.getByTestId('stack-manager-deploy')).toBeDisabled();
    await page.getByTestId('stack-manager-refresh').click();
    await expect(page.getByText('31337', { exact: true })).toBeVisible({ timeout: INIT_TIMEOUT });
    await expect(page.getByTestId('stack-manager-deploy')).toBeDisabled();
    await page.getByTestId('stack-manager-confirm').check();
    await expect(page.getByTestId('stack-manager-deploy')).toBeEnabled();
    let deploymentRequests = 0;
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/control/stack-manager/deploy')
        deploymentRequests += 1;
    });
    await page.getByTestId('stack-manager-deploy').click();
    await expect(page.getByTestId('stack-manager-result')).toBeVisible({ timeout: DEPLOY_TIMEOUT });
    await expect(page.getByText(/community (published|queued)/i)).toBeVisible();
    expect(deploymentRequests).toBe(1);

    for (const viewport of [
      { name: 'iphone', width: 393, height: 852 },
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'wide', width: 1920, height: 1080 },
    ] as const) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await expect(page.getByText('Jurisdiction deployment', { exact: true })).toBeVisible();
      await expect(page.getByTestId('stack-manager-result')).toBeVisible();
      const layout = await page.evaluate(() => ({
        viewport: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        overflow: [...document.querySelectorAll('*')]
          .flatMap(element => {
            const rect = element.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0 || rect.right <= window.innerWidth + 1) return [];
            const css = getComputedStyle(element);
            return [
              {
                tag: element.tagName,
                testId: element.getAttribute('data-testid'),
                className: element.getAttribute('class'),
                parentClass: element.parentElement?.getAttribute('class'),
                left: rect.left,
                right: rect.right,
                width: rect.width,
                display: css.display,
                minWidth: css.minWidth,
                whiteSpace: css.whiteSpace,
                overflowX: css.overflowX,
              },
            ];
          })
          .slice(0, 50),
      }));
      if (layout.scrollWidth > viewport.width) {
        await testInfo.attach(`layout-${viewport.name}`, {
          body: JSON.stringify(layout, null, 2),
          contentType: 'application/json',
        });
        console.log('[STACK-MANAGER] overflow', JSON.stringify(layout));
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
      expect(
        await page
          .getByTestId('stack-manager-v1')
          .evaluate(root =>
            [...root.querySelectorAll('*')].some(
              element => element.getBoundingClientRect().right > window.innerWidth + 1,
            ),
          ),
      ).toBe(false);
      await page.screenshot({
        path: testInfo.outputPath(`stack-manager-${viewport.name}.png`),
        animations: 'disabled',
        fullPage: true,
      });
    }
  },
);
