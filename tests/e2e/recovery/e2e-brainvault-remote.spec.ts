import { expect, test, type Page } from '../../global-setup.mts';

import { APP_BASE_URL, API_BASE_URL, ensureE2EBaseline } from '../../utils/e2e-baseline';
import { acceptRemoteRuntimeConsent } from '../../utils/runtime/e2e-runtime-import';

type RuntimeImportCapability = {
  label: string;
  access: 'admin';
  wsUrl: string;
  token: string;
};

const readH1AdminCapability = async (page: Page): Promise<RuntimeImportCapability> => {
  await expect.poll(async () => {
    const response = await page.request.get(`${API_BASE_URL}/api/runtime-import?access=admin`, {
      headers: { 'Cache-Control': 'no-store' },
      timeout: 5_000,
    });
    if (!response.ok()) return null;
    const payload = await response.json() as { manifest?: { entries?: RuntimeImportCapability[] } };
    return payload.manifest?.entries?.find(entry => entry.label.trim().toLowerCase() === 'h1') ?? null;
  }, { timeout: 60_000 }).not.toBeNull();

  const response = await page.request.get(`${API_BASE_URL}/api/runtime-import?access=admin`, {
    headers: { 'Cache-Control': 'no-store' },
  });
  const payload = await response.json() as { manifest?: { entries?: RuntimeImportCapability[] } };
  const capability = payload.manifest?.entries?.find(entry => entry.label.trim().toLowerCase() === 'h1');
  if (!capability) throw new Error('BRAINVAULT_REMOTE_H1_CAPABILITY_MISSING');
  expect(capability.access).toBe('admin');
  expect(capability.token).toMatch(/^xlnra1\./);
  return capability;
};

const openAddRuntimePanel = async (page: Page): Promise<void> => {
  const trigger = page.locator('button:has([data-testid="context-current"]), .context-switcher .dropdown-trigger').first();
  const menu = page.locator('.switcher-menu').first();
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  if (!await menu.isVisible().catch(() => false)) await trigger.click({ force: true });
  const addRuntime = menu.locator('.add-runtime-btn').filter({ hasText: /Add Runtime/i }).first();
  await expect(addRuntime).toBeVisible({ timeout: 10_000 });
  await addRuntime.click();
  await expect(page.getByRole('heading', { name: /Create XLN wallet/i }).first()).toBeVisible({ timeout: 15_000 });
};

test.setTimeout(5 * 60_000);

test(
  'remote BrainVault keeps the mnemonic on the node and opens account setup without browser export',
  { tag: '@functional' },
  async ({ page }) => {
    await ensureE2EBaseline(page, { requireHubMesh: true, minHubCount: 3 });
    const capability = await readH1AdminCapability(page);
    const hash = new URLSearchParams({
      runtime: 'remote',
      ws: capability.wsUrl,
      token: capability.token,
    });
    const remoteUrl = `${APP_BASE_URL}/app#${hash.toString()}`;
    await page.goto(remoteUrl, { waitUntil: 'domcontentloaded' });
    await acceptRemoteRuntimeConsent(page, 30_000);
    await page.waitForFunction(() => {
      const adapter = (window as typeof window & {
        __xln?: { adapter?: { status?: () => { connected?: boolean; authLevel?: string | null } } };
      }).__xln?.adapter?.status?.();
      return adapter?.connected === true && adapter.authLevel === 'admin';
    }, null, { timeout: 30_000 });

    await openAddRuntimePanel(page);
    await page.getByLabel('Vault name public derivation input').fill('remote-e2e-vault');
    await page.getByLabel('Secret passphrase').fill('Remote-e2e-passphrase-42!');
    await page.getByRole('button', { name: /Advanced/i }).click();
    await page.getByRole('button', { name: /^1\s+Test$/ }).click();
    await page.getByRole('button', { name: /Advanced/i }).click();

    const estimate = page.getByTestId('brainvault-work-estimate');
    await expect(estimate).toContainText(/Browser benchmark|Initial browser estimate/);
    await expect(page.getByText('Browser comparison only. The native node benchmark appears after derivation.')).toBeVisible();

    const derive = page.getByRole('button', { name: 'Derive on node', exact: true });
    await expect(derive).toBeEnabled({ timeout: 10_000 });
    await derive.click();

    const receipt = page.getByTestId('brainvault-node-ready');
    const failure = page.locator('.brainvault-wrapper .matrix-status.error:visible').first();
    await expect(receipt.or(failure).first()).toBeVisible({ timeout: 120_000 });
    if (await failure.isVisible()) {
      throw new Error(`REMOTE_BRAINVAULT_DERIVATION_FAILED:${await failure.innerText()}`);
    }
    await expect(receipt).toBeVisible({ timeout: 120_000 });
    await expect(receipt).toContainText('Native benchmark');
    await expect(receipt.locator('#node-mnemonic-export')).toHaveCount(0);
    const publicReceipt = await receipt.textContent();
    expect(publicReceipt).toContain('never delivered to this browser');
    await expect(receipt.getByRole('button', { name: 'Show mnemonic', exact: true })).toHaveCount(0);
    await receipt.getByRole('button', { name: 'Open node wallet', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Configure account', exact: true })).toBeVisible({ timeout: 30_000 });
  },
);
