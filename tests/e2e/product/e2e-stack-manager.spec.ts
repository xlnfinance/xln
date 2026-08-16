import { expect, test, type Page } from '../../global-setup.mts';
import { acceptRemoteRuntimeConsent, resolveRuntimeImportAppUrl } from '../../utils/runtime/e2e-runtime-import';
import { requireIsolatedBaseUrl } from '../../utils/runtime/e2e-isolated-env';

const APP_BASE_URL = requireIsolatedBaseUrl('E2E_BASE_URL');
const INIT_TIMEOUT = 30_000;
const DEPLOY_TIMEOUT = 3 * 60_000;

const requireAnvilRpc = (): string => {
  const rpcUrl = process.env.E2E_ANVIL_RPC?.trim();
  if (!rpcUrl || rpcUrl.endsWith(':1')) throw new Error('STACK_MANAGER_E2E_ANVIL_RPC_REQUIRED');
  return rpcUrl;
};

const isExactAnvilMutationReceipt = (value: unknown): value is Readonly<{
  jsonrpc: '2.0';
  id: 1;
  result: null;
}> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== 3 || keys[0] !== 'id' || keys[1] !== 'jsonrpc' || keys[2] !== 'result') return false;
  return 'jsonrpc' in value && value.jsonrpc === '2.0'
    && 'id' in value && value.id === 1
    && 'result' in value && value.result === null;
};

const fundSigner = async (rpcUrl: string, signerId: string): Promise<void> => {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: `{"jsonrpc":"2.0","id":1,"method":"anvil_setBalance","params":["${signerId}","0x56bc75e2d63100000"]}`,
  });
  const body: unknown = await response.json();
  if (!response.ok || !isExactAnvilMutationReceipt(body)) {
    throw new Error(`STACK_MANAGER_E2E_SIGNER_FUNDING_FAILED:${response.status}`);
  }
};

async function openStackManager(page: Page): Promise<void> {
  const importUrl = await resolveRuntimeImportAppUrl(page, {
    appBaseUrl: APP_BASE_URL,
    apiBaseUrl: APP_BASE_URL,
    access: 'admin',
  });
  await page.goto(importUrl, { waitUntil: 'domcontentloaded' });
  const consent = page.getByTestId('remote-runtime-login-screen');
  if (await consent.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await acceptRemoteRuntimeConsent(page);
  }
  await expect(page.getByTestId('context-current')).toBeVisible({ timeout: INIT_TIMEOUT });

  const settingsTab = page.getByTestId('tab-settings').first();
  await expect(settingsTab).toBeVisible({ timeout: INIT_TIMEOUT });
  await settingsTab.click();
  await page.getByTestId('settings-stack-manager-tab').click();
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
  await page.getByTestId('stack-manager-refresh').click();
  await expect(page.getByText('31337', { exact: true })).toBeVisible({ timeout: INIT_TIMEOUT });
  await page.getByTestId('stack-manager-confirm').check();
  await expect(page.getByTestId('stack-manager-deploy')).toBeEnabled();
  await page.getByTestId('stack-manager-deploy').click();
  await expect(page.getByTestId('stack-manager-result')).toBeVisible({ timeout: DEPLOY_TIMEOUT });
  await expect(page.getByText(/community (published|queued)/i)).toBeVisible();

  for (const viewport of [
    { name: 'iphone', width: 393, height: 852 },
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'wide', width: 1920, height: 1080 },
  ] as const) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await expect(page.getByText('Jurisdiction deployment', { exact: true })).toBeVisible();
    await expect(page.getByTestId('stack-manager-result')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    expect(await page.getByTestId('stack-manager-v1').evaluate((root) =>
      [...root.querySelectorAll('*')].some((element) => element.getBoundingClientRect().right > window.innerWidth + 1),
    )).toBe(false);
    await page.screenshot({
      path: testInfo.outputPath(`stack-manager-${viewport.name}.png`),
      animations: 'disabled',
      fullPage: true,
    });
  }
});
