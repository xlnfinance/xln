import { Wallet } from 'ethers';
import { expect, test, type Page } from './global-setup.mts';
import { requireApiBaseUrl } from './utils/e2e-base-url';

const API_BASE_URL = requireApiBaseUrl();

type BrowserIssue = Readonly<{ type: string; text: string }>;
type VaultDebug = {
  createRuntime?: (label: string, seed: string, options: Record<string, unknown>) => Promise<{ id?: unknown }>;
};

const trackBrowserIssues = (page: Page): BrowserIssue[] => {
  const issues: BrowserIssue[] = [];
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') {
      issues.push({ type: `console:${message.type()}`, text: message.text() });
    }
  });
  page.on('pageerror', error => issues.push({ type: 'pageerror', text: error.message }));
  page.on('requestfailed', request => issues.push({ type: 'requestfailed', text: `${request.url()} ${request.failure()?.errorText ?? ''}` }));
  page.on('response', response => {
    if (response.status() >= 400) issues.push({ type: `http:${response.status()}`, text: response.url() });
  });
  return issues;
};

const createRealRuntime = async (page: Page): Promise<string> => {
  const seed = Wallet.createRandom().mnemonic?.phrase;
  if (!seed) throw new Error('WALLET_ACCOUNTS_E2E_MNEMONIC_MISSING');
  await expect.poll(() => page.evaluate(() => typeof window.__xln?.vault?.createRuntime)).toBe('function');
  return page.evaluate(async phrase => {
    const vault = window.__xln?.vault as VaultDebug | undefined;
    if (!vault?.createRuntime) throw new Error('WALLET_ACCOUNTS_E2E_CREATE_MISSING');
    const runtime = await vault.createRuntime('wallet-accounts-e2e', phrase, {
      loginType: 'manual',
      requiresOnboarding: false,
      skipRecoveryRestore: true,
      recovery: { useDefaultTowers: false, towers: [] },
      unlockDurationMs: null,
      fundSigner: false,
    });
    return String(runtime.id || '').toLowerCase();
  }, seed);
};

const discoverHub = async (page: Page): Promise<string> => {
  const response = await page.request.get(`${API_BASE_URL}/api/debug/entities?limit=5000`);
  expect(response.ok(), 'hub directory must be reachable').toBe(true);
  const body = await response.json() as { entities?: Array<{ entityId?: string; isHub?: boolean; online?: boolean; name?: string }> };
  const hubs = (body.entities ?? []).filter(entity => entity.isHub === true && entity.online !== false)
    .toSorted((left, right) => String(left.name || '').localeCompare(String(right.name || '')));
  const hubId = String(hubs[0]?.entityId || '').trim().toLowerCase();
  expect(hubId, 'one online hub must be available').toMatch(/^0x[0-9a-f]{64}$/);
  return hubId;
};

const readActiveEntityId = async (page: Page): Promise<string> => {
  const value = await page.locator('.wallet-accounts-head code').textContent();
  const entityId = String(value || '').trim().toLowerCase();
  expect(entityId).toMatch(/^0x[0-9a-f]{64}$/);
  return entityId;
};

const fundOffchain = async (page: Page, runtimeId: string, entityId: string, hubEntityId: string): Promise<void> => {
  let failure = 'not-run';
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const response = await page.request.post(`${API_BASE_URL}/api/faucet/offchain`, { data: {
      userEntityId: entityId,
      userRuntimeId: runtimeId,
      hubEntityId,
      tokenId: 1,
      amount: '100',
    } });
    const body = await response.json().catch(() => ({})) as { success?: boolean; error?: string; code?: string };
    if (response.ok() && body.success === true) return;
    failure = `${response.status()}:${body.code || ''}:${body.error || ''}`;
    await page.waitForTimeout(1_500);
  }
  throw new Error(`WALLET_ACCOUNTS_E2E_FAUCET_FAILED:${failure}`);
};

const capture = async (page: Page, testInfo: import('@playwright/test').TestInfo, name: string): Promise<void> => {
  for (const [viewport, width, height] of [['wide', 1920, 1080], ['laptop', 1440, 900], ['iphone', 393, 852]] as const) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath(`${name}-${viewport}.png`), fullPage: true, animations: 'disabled' });
  }
};

test.describe('React wallet accounts and payments', () => {

  test('loads the real active Entity projection and wallet-owned deep routes', { tag: '@functional' }, async ({ page }, testInfo) => {
    test.setTimeout(3 * 60_000);
    const issues = trackBrowserIssues(page);
    await page.goto('/app', { waitUntil: 'domcontentloaded' });
    await createRealRuntime(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('app-runtime-ready')).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Accounts' }).click();
    await expect(page.getByTestId('wallet-accounts-overview')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('wallet-test-assets')).toContainText('HTTP acceptance is not committed balance evidence.');
    await capture(page, testInfo, 'wallet-accounts');
    const entityId = await readActiveEntityId(page);
    await page.getByRole('button', { name: 'Pay' }).click();
    await expect(page.getByTestId('wallet-payment-form')).toBeVisible();
    await capture(page, testInfo, 'wallet-pay-empty');
    await page.getByRole('button', { name: 'Move' }).click();
    await expect(page.getByTestId('wallet-move-credit-form')).toBeVisible();
    await expect(page.getByTestId('wallet-external-move-form')).toBeVisible();
    await capture(page, testInfo, 'wallet-move-empty');
    await page.getByRole('button', { name: 'Lending' }).click();
    await expect(page.getByTestId('wallet-lending-panel')).toBeVisible();
    await capture(page, testInfo, 'wallet-lending-empty');
    await page.getByRole('button', { name: 'Settlement' }).click();
    await expect(page.getByTestId('wallet-settlement')).toBeVisible();
    await capture(page, testInfo, 'wallet-settlement-empty');
    await page.getByRole('button', { name: 'Receive' }).click();
    await expect(page.getByTestId('wallet-receive-form')).toBeVisible();
    await capture(page, testInfo, 'wallet-receive');

    await page.goto('/address', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('wallet-address-directory')).toBeVisible({ timeout: 60_000 });
    await page.goto(`/address/${entityId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('wallet-address-detail')).toBeVisible({ timeout: 60_000 });
    await page.goto('/address/not-an-entity', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Entity ID is malformed' })).toBeVisible({ timeout: 60_000 });
    await page.goto(`/address/0x${'ff'.repeat(32)}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Entity not found' })).toBeVisible({ timeout: 60_000 });
    await page.goto('/testnet', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('wallet-testnet-page')).toBeVisible();
    await capture(page, testInfo, 'wallet-testnet');
    expect(issues).toEqual([]);
  });

  test('opens, funds, and pays through the real hub mesh', { tag: '@functional' }, async ({ page }, testInfo) => {
    test.skip(process.env['PW_WALLET_MESH'] !== '1', 'requires a green isolated hub mesh');
    test.setTimeout(4 * 60_000);
    const issues = trackBrowserIssues(page);
    await page.goto('/app', { waitUntil: 'domcontentloaded' });
    const runtimeId = await createRealRuntime(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('app-runtime-ready')).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Accounts' }).click();
    const entityId = await readActiveEntityId(page);
    const hubId = await discoverHub(page);
    await page.getByLabel('Open account with entity ID').fill(hubId);
    await page.getByRole('button', { name: 'Review open account' }).click();
    await page.getByRole('button', { name: 'Submit account intent' }).click();
    const accountButton = page.locator('.wallet-account-list button').filter({ hasText: hubId.slice(0, 10) });
    await expect(accountButton).toBeVisible({ timeout: 60_000 });
    await accountButton.click();
    await expect(page.getByTestId('wallet-account-configure')).toBeVisible();
    await page.getByRole('button', { name: 'Review add asset' }).click();
    await expect(page.getByText('0 raw · initialize delta only')).toBeVisible();
    await page.getByRole('button', { name: 'Submit add asset' }).click();
    await expect(page.getByTestId('wallet-account-token')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('wallet-account-dispute')).toBeVisible();
    await fundOffchain(page, runtimeId, entityId, hubId);
    await expect.poll(async () => Number(await page.getByTestId('wallet-token-outbound').textContent()), {
      timeout: 60_000,
      intervals: [500, 1_000, 1_500],
    }).toBeGreaterThan(0);
    await capture(page, testInfo, 'wallet-account-detail-funded');
    await page.getByRole('button', { name: 'Pay' }).click();
    await page.locator('#payment-amount-input').fill('1');
    await page.getByRole('button', { name: 'Review payment' }).click();
    await expect(page.getByTestId('wallet-payment-confirmation')).toBeVisible();
    await capture(page, testInfo, 'wallet-pay-confirmation');
    await page.getByRole('button', { name: 'Submit payment' }).click();
    await expect(page.getByTestId('wallet-command-receipt')).toHaveAttribute('data-status', /accepted|observed|committed/, { timeout: 60_000 });
    await capture(page, testInfo, 'wallet-pay-committed');
    await page.getByRole('button', { name: 'Move' }).click();
    const moveForm = page.getByTestId('wallet-move-credit-form');
    await moveForm.getByLabel('Operation').selectOption('fund-account');
    await moveForm.getByLabel('Amount').fill('1');
    await moveForm.getByRole('button', { name: 'Review exact operation' }).click();
    await expect(page.getByTestId('wallet-move-confirmation')).toBeVisible();
    await capture(page, testInfo, 'wallet-move-confirmation');
    expect(issues).toEqual([]);
  });
});
