import { Wallet } from 'ethers';
import { expect, test, type Page } from './global-setup.mts';
import { ensureE2EBaseline } from './utils/e2e-baseline';
import { requireApiBaseUrl } from './utils/e2e-base-url';

const API_BASE_URL = requireApiBaseUrl();

type VaultDebug = {
  createRuntime?: (label: string, seed: string, options: Record<string, unknown>) => Promise<{ id?: unknown }>;
};

const createRealRuntime = async (page: Page, label: string): Promise<string> => {
  const seed = Wallet.createRandom().mnemonic?.phrase;
  if (!seed) throw new Error('WALLET_SWAP_E2E_MNEMONIC_MISSING');
  await expect.poll(() => page.evaluate(() => typeof window.__xln?.vault?.createRuntime)).toBe('function');
  return page.evaluate(async ({ phrase, label }) => {
    const vault = window.__xln?.vault as VaultDebug | undefined;
    if (!vault?.createRuntime) throw new Error('WALLET_SWAP_E2E_CREATE_MISSING');
    const runtime = await vault.createRuntime(label, phrase, {
      loginType: 'manual',
      requiresOnboarding: false,
      skipRecoveryRestore: true,
      recovery: { useDefaultTowers: false, towers: [] },
      unlockDurationMs: null,
      fundSigner: false,
    });
    return String(runtime.id || '').toLowerCase();
  }, { phrase: seed, label });
};

const activeEntityId = async (page: Page): Promise<string> => {
  await page.getByRole('button', { name: 'Accounts' }).click();
  await expect(page.getByTestId('wallet-accounts-overview')).toBeVisible({ timeout: 60_000 });
  const entityId = String(await page.locator('.wallet-accounts-head code').textContent() || '').trim().toLowerCase();
  expect(entityId).toMatch(/^0x[0-9a-f]{64}$/);
  return entityId;
};

const hubIds = async (page: Page): Promise<string[]> => {
  const response = await page.request.get(`${API_BASE_URL}/api/debug/entities?limit=5000`);
  expect(response.ok(), 'hub directory must be reachable').toBe(true);
  const body = await response.json() as { entities?: Array<{ entityId?: string; isHub?: boolean; online?: boolean; name?: string }> };
  return (body.entities ?? [])
    .filter(entity => entity.isHub === true && entity.online !== false)
    .toSorted((left, right) => String(left.name || '').localeCompare(String(right.name || '')))
    .map(entity => String(entity.entityId || '').trim().toLowerCase())
    .filter(entityId => /^0x[0-9a-f]{64}$/.test(entityId));
};

const openHubAccount = async (page: Page, hubEntityId: string): Promise<void> => {
  const existing = page.locator('.wallet-account-list button').filter({ hasText: hubEntityId.slice(0, 10) });
  if (await existing.isVisible().catch(() => false)) return;
  await page.getByLabel('Open account with entity ID').fill(hubEntityId);
  await page.getByRole('button', { name: 'Review open account' }).click();
  await page.getByRole('button', { name: 'Submit account intent' }).click();
  await expect(existing).toBeVisible({ timeout: 75_000 });
};

const fundOffchain = async (
  page: Page,
  runtimeId: string,
  entityId: string,
  hubEntityId: string,
): Promise<void> => {
  let failure = 'not-run';
  for (let attempt = 1; attempt <= 8; attempt += 1) {
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
  throw new Error(`WALLET_SWAP_E2E_FAUCET_FAILED:${failure}`);
};

const capture = async (page: Page, testInfo: import('@playwright/test').TestInfo, name: string): Promise<void> => {
  for (const [viewport, width, height] of [['wide', 1920, 1080], ['laptop', 1440, 900], ['iphone', 393, 852]] as const) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth), `${name}:${viewport} must not overflow`).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath(`${name}-${viewport}.png`), fullPage: true, animations: 'disabled' });
  }
};

const attachCommittedDump = async (page: Page, testInfo: import('@playwright/test').TestInfo, name: string): Promise<void> => {
  const dump = await page.evaluate(async () => {
    const frame = await window.__xln?.adapter?.query?.viewFrame?.({ accountsLimit: 100, booksLimit: 20 });
    return JSON.stringify(frame, (_key, value) => {
      if (typeof value === 'bigint') return `BigInt(${value})`;
      if (value instanceof Map) return { __xlnType: 'Map', entries: [...value.entries()] };
      return value;
    }, 2);
  });
  await testInfo.attach(`${name}.json`, { body: String(dump || ''), contentType: 'application/json' });
};

test.describe('React wallet swap and history', () => {
  test.skip(process.env['PW_REACT_WALLET_CANDIDATE'] !== '1', 'requires the release-blocked React wallet candidate');

  test('shows explicit empty swap and disk-history states without inventing a route', { tag: '@functional' }, async ({ page }, testInfo) => {
    test.setTimeout(3 * 60_000);
    await page.goto('/app', { waitUntil: 'domcontentloaded' });
    await createRealRuntime(page, 'wallet-swap-empty-e2e');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('app-runtime-ready')).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Swap' }).click();
    await expect(page.getByTestId('wallet-swap-workspace')).toBeVisible();
    await expect(page.getByText('No canonical hub route exists')).toBeVisible();
    await capture(page, testInfo, 'wallet-swap-empty');
    await page.getByRole('button', { name: 'Activity' }).click();
    await expect(page.getByTestId('wallet-activity-history')).toBeVisible();
    await expect(page.getByText('No matching committed activity')).toBeVisible({ timeout: 30_000 });
    await capture(page, testInfo, 'wallet-history-empty');
  });

  test('plans, confirms, submits, and reads one real swap lifecycle', { tag: '@functional' }, async ({ page }, testInfo) => {
    // Static marker consumed by the isolated runner: requireMarketMaker: true.
    test.setTimeout(6 * 60_000);
    await ensureE2EBaseline(page, { requireMarketMaker: true, requireHubMesh: true, minHubCount: 3 });
    await page.goto('/app', { waitUntil: 'domcontentloaded' });
    const runtimeId = await createRealRuntime(page, 'wallet-swap-live-e2e');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('app-runtime-ready')).toBeVisible({ timeout: 60_000 });
    const entityId = await activeEntityId(page);
    const hubs = await hubIds(page);
    expect(hubs.length).toBeGreaterThanOrEqual(2);
    await openHubAccount(page, hubs[0]!);
    await openHubAccount(page, hubs[1]!);
    await fundOffchain(page, runtimeId, entityId, hubs[0]!);
    await expect.poll(async () => {
      const account = page.locator('.wallet-account-list button').filter({ hasText: hubs[0]!.slice(0, 10) });
      await account.click();
      return Number(await page.getByTestId('wallet-token-outbound').first().textContent());
    }, { timeout: 75_000, intervals: [500, 1_000, 1_500] }).toBeGreaterThan(0);

    await page.getByRole('button', { name: 'Swap' }).click();
    const route = page.getByTestId('wallet-swap-route');
    await expect.poll(() => route.locator('option:enabled').count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    await expect(page.locator('.wallet-orderbook > header em')).toHaveText(/ready|empty/, { timeout: 30_000 });
    const ask = page.locator('.wallet-book-side.is-ask button').first();
    await expect(ask).toBeVisible({ timeout: 30_000 });
    await ask.click();
    await page.getByTestId('wallet-swap-amount').fill('1');
    await expect(page.getByTestId('wallet-swap-quote-loading')).toBeVisible();
    await capture(page, testInfo, 'wallet-swap-quote-loading');
    await expect(page.getByTestId('wallet-swap-quote-result')).toBeVisible({ timeout: 30_000 });
    await capture(page, testInfo, 'wallet-swap-multi-route');
    await page.getByTestId('wallet-swap-review').click();
    await expect(page.getByTestId('wallet-swap-confirmation')).toBeVisible();
    await capture(page, testInfo, 'wallet-swap-confirmation');

    await page.getByTestId('wallet-swap-amount').fill('10000000000');
    await expect(page.getByTestId('wallet-swap-quote-error')).toContainText('SWAP_COMMAND_SOURCE_CAPACITY_INSUFFICIENT', { timeout: 30_000 });
    await capture(page, testInfo, 'wallet-swap-rejected-route');
    await page.getByTestId('wallet-swap-amount').fill('1');
    await expect(page.getByTestId('wallet-swap-quote-result')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('wallet-swap-review').click();
    await page.getByTestId('wallet-swap-submit').evaluate(button => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await expect(page.getByTestId('wallet-swap-submitted')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('wallet-command-receipt')).toHaveAttribute('data-status', /accepted|observed|committed/, { timeout: 60_000 });
    await capture(page, testInfo, 'wallet-swap-committed');
    await expect(page.getByTestId('wallet-swap-orders')).toBeVisible();
    await expect(page.getByTestId('wallet-swap-order-row').first()).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('wallet-swap-order-row').first().locator('.wallet-order-summary').click();
    await capture(page, testInfo, 'wallet-swap-order-detail');
    await attachCommittedDump(page, testInfo, 'wallet-swap-committed-state');

    await page.getByRole('button', { name: 'Activity' }).click();
    await expect(page.getByTestId('wallet-activity-row').first()).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('wallet-activity-history').getByRole('button', { name: 'swap', exact: true }).click();
    await expect(page.getByTestId('wallet-activity-row').first()).toBeVisible();
    await page.getByTestId('wallet-activity-row').first().locator('button').click();
    await expect(page.getByTestId('wallet-activity-detail')).toBeVisible();
    await capture(page, testInfo, 'wallet-history-detail');
  });
});
