import { execFileSync } from 'node:child_process';

import { expect, test, type Page } from '@playwright/test';

import { APP_BASE_URL, createRuntimeIdentity, gotoApp, selectDemoMnemonic } from './utils/e2e-demo-users';

type BrainvaultCliOutput = {
  mnemonic24: string;
  mnemonic12: string;
};

type StoredRuntime = {
  label?: string;
  seed?: string;
  mnemonic12?: string;
};

const CASES = [
  { name: 'vault alpha', passphrase: 'saffron-rain-42', shards: 6 },
  { name: 'vault beta', passphrase: 'mango-river-77', shards: 7 },
  { name: 'vault gamma', passphrase: 'linen-fox-88', shards: 8 },
];
const APP_HOST = new URL(APP_BASE_URL).hostname;
const REQUIRE_BROWSER_RUNTIME_GLOBALS =
  APP_HOST === 'localhost' || APP_HOST === '127.0.0.1' || APP_HOST === '::1';

function normalizeMnemonic(value: string): string {
  return value.trim().split(/\s+/).join(' ');
}

function runBrainvaultCli(name: string, passphrase: string, shards: number): BrainvaultCliOutput {
  const output = execFileSync(
    'bun',
    ['brainvault/cli.ts', name, passphrase, String(shards), '--w=4'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
    },
  );
  const jsonStart = output.lastIndexOf('\n{');
  const payload = (jsonStart >= 0 ? output.slice(jsonStart + 1) : output.slice(output.indexOf('{'))).trim();
  const parsed = JSON.parse(payload) as BrainvaultCliOutput;
  return {
    mnemonic24: normalizeMnemonic(parsed.mnemonic24),
    mnemonic12: normalizeMnemonic(parsed.mnemonic12),
  };
}

async function waitForBrainvaultCreateForm(page: Page): Promise<void> {
  const brainVaultTab = page.getByRole('button', { name: 'BrainVault', exact: true });
  if (await brainVaultTab.isVisible().catch(() => false)) {
    await brainVaultTab.click();
  }
  await expect(page.getByRole('heading', { name: /Create XLN wallet/i }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#name')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#passphrase')).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByTestId('brainvault-create-details'),
    'BrainVault recovery controls belong to the post-create setup screen, not the initial wallet form',
  ).toHaveCount(0);
  await expect(
    page.getByText('BrainVault recovery'),
    'BrainVault recovery belongs to the next screen after wallet creation',
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /Download sheet/i }),
    'Seed sheet download belongs to the post-create recovery panel',
  ).toHaveCount(0);
}

async function expectPostCreateBrainvaultRecovery(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: /Configure account/i })).toBeVisible({ timeout: 30_000 });
  const recoveryDetails = page.getByTestId('brainvault-onboarding-recovery');
  await expect(recoveryDetails).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('brainvault-onboarding-recovery-toggle')).toContainText(/BrainVault recovery/i);
  await expect(page.getByTestId('brainvault-continue-copy')).toContainText(/account settings below/i);
  await expect(page.getByRole('heading', { name: /Recovery services/i })).toBeVisible();
  await page.getByTestId('brainvault-onboarding-recovery-toggle').click();
  await expect(page.getByRole('button', { name: /Download sheet/i })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole('link', { name: /Read safety notes/i })).toBeVisible({ timeout: 5_000 });
}

async function readRuntimeCount(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const raw = localStorage.getItem('xln-vaults');
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as { runtimes?: Record<string, unknown> };
    return Object.keys(parsed.runtimes ?? {}).length;
  });
}

async function readActiveRuntimeId(page: Page): Promise<string | null> {
  return await page.evaluate(() => {
    const raw = localStorage.getItem('xln-vaults');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { activeRuntimeId?: string };
    return parsed.activeRuntimeId ?? null;
  });
}

async function openAddRuntimePanel(page: Page): Promise<void> {
  const trigger = page.locator('button:has([data-testid="context-current"]), .context-switcher .dropdown-trigger').first();
  const menu = page.locator('.switcher-menu').first();
  await expect(trigger).toBeVisible({ timeout: 15_000 });
  if (!await menu.isVisible().catch(() => false)) {
    await trigger.click({ force: true });
  }
  const addRuntimeItem = page.locator('.switcher-menu .add-runtime-btn').filter({ hasText: /Add Runtime/i }).first();
  await expect(addRuntimeItem).toBeVisible({ timeout: 10_000 });
  await addRuntimeItem.click();
  await waitForBrainvaultCreateForm(page);
}

async function waitForRuntimeWithSeed(page: Page, seed: string): Promise<StoredRuntime> {
  const handle = await page.waitForFunction((expectedSeed: string) => {
    try {
      const raw = localStorage.getItem('xln-vaults');
      if (!raw) return null;
      const parsed = JSON.parse(raw) as {
        activeRuntimeId?: string;
        runtimes?: Record<string, { label?: string; seed?: string; mnemonic12?: string }>;
      };
      const runtime = parsed.activeRuntimeId ? parsed.runtimes?.[parsed.activeRuntimeId] : null;
      if (!runtime?.seed || runtime.seed.trim().split(/\s+/).join(' ') !== expectedSeed) return null;
      return runtime;
    } catch {
      return null;
    }
  }, seed, { timeout: 90_000 });
  return await handle.jsonValue() as StoredRuntime;
}

async function waitForRuntimeWithLabel(page: Page, label: string): Promise<StoredRuntime> {
  const handle = await page.waitForFunction((expectedLabel: string) => {
    try {
      const raw = localStorage.getItem('xln-vaults');
      if (!raw) return null;
      const parsed = JSON.parse(raw) as {
        activeRuntimeId?: string;
        runtimes?: Record<string, { label?: string; seed?: string; mnemonic12?: string }>;
      };
      const runtimes = Object.values(parsed.runtimes ?? {});
      return runtimes.find((runtime) => runtime.label === expectedLabel && runtime.seed) ?? null;
    } catch {
      return null;
    }
  }, label, { timeout: 120_000 });
  return await handle.jsonValue() as StoredRuntime;
}

async function deriveBrainvaultInUi(page: Page, name: string, passphrase: string, shards: number): Promise<BrainvaultCliOutput> {
  await waitForBrainvaultCreateForm(page);

  await page.locator('#name').fill(name);
  await page.locator('#passphrase').fill(passphrase);

  await page.getByRole('button', { name: /Custom/i }).click();
  await page.locator('#shards').fill(String(shards));

  const openVaultButton = page.getByRole('button', { name: /(Create XLN wallet|Open \/ restore wallet|Open (Wallet|Vault))/, exact: false });
  await expect(openVaultButton).toBeEnabled({ timeout: 15_000 });
  await openVaultButton.click();

  const runtime = await waitForRuntimeWithLabel(page, name);
  const mnemonic24 = normalizeMnemonic(runtime.seed || '');
  const mnemonic12 = normalizeMnemonic(runtime.mnemonic12 || '');

  return { mnemonic12, mnemonic24 };
}

test.describe('brainvault parity', () => {
  for (const currentCase of CASES) {
    test(`browser brainvault matches local CLI for ${currentCase.shards} shards`, async ({ page }) => {
      test.slow();

      await gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: 60_000, settleMs: 250 });

      const cli = runBrainvaultCli(currentCase.name, currentCase.passphrase, currentCase.shards);
      const ui = await deriveBrainvaultInUi(page, currentCase.name, currentCase.passphrase, currentCase.shards);

      expect(ui.mnemonic12).toBe(cli.mnemonic12);
      expect(ui.mnemonic24).toBe(cli.mnemonic24);
    });
  }

  test('standalone BrainVault creates the XLN wallet with deterministic seed material', async ({ page }) => {
    test.slow();

    await gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: 60_000, settleMs: 250 });

    const cli = runBrainvaultCli('standalone vault', 'ced-export-42', 1);
    await waitForBrainvaultCreateForm(page);
    await page.locator('#name').fill('standalone vault');
    await page.locator('#passphrase').fill('ced-export-42');
    await page.getByRole('button', { name: /^1\s+Test$/ }).click();

    const openVaultButton = page.getByRole('button', { name: /(Create XLN wallet|Open \/ restore wallet|Open (Wallet|Vault))/, exact: false });
    await expect(openVaultButton).toBeEnabled({ timeout: 15_000 });
    await openVaultButton.click();

    const runtime = await waitForRuntimeWithSeed(page, cli.mnemonic24);
    expect(runtime.label).toBe('standalone vault');
    expect(normalizeMnemonic(runtime.mnemonic12 || '')).toBe(cli.mnemonic12);
    expect(await readRuntimeCount(page)).toBe(1);
    await expectPostCreateBrainvaultRecovery(page);
  });

  test('embedded BrainVault add-runtime flow does not fall back to the active wallet', async ({ page }) => {
    test.slow();

    await gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: 60_000, settleMs: 250 });

    const oldRuntime = await createRuntimeIdentity(page, 'alice', selectDemoMnemonic('alice'), {
      requireOnline: REQUIRE_BROWSER_RUNTIME_GLOBALS,
    });
    expect(await readRuntimeCount(page)).toBe(1);

    await openAddRuntimePanel(page);
    const derived = await deriveBrainvaultInUi(page, 'embedded add runtime', 'ced-add-runtime-42', 1);

    const runtime = await waitForRuntimeWithSeed(page, derived.mnemonic24);
    expect(runtime.label).toBe('embedded add runtime');
    expect(normalizeMnemonic(runtime.mnemonic12 || '')).toBe(derived.mnemonic12);
    expect(await readActiveRuntimeId(page)).not.toBe(oldRuntime.runtimeId);
    expect(await readRuntimeCount(page)).toBe(2);
  });
});
