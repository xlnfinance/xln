import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { expect, test, type Page } from './global-setup';

import {
  APP_BASE_URL,
  createRuntimeIdentity,
  deriveSignerAddressFromMnemonic,
  gotoApp,
  selectDemoMnemonic,
} from './utils/e2e-demo-users';

type BrainvaultCliOutput = {
  mnemonic24: string;
  mnemonic12: string;
};

type StoredRuntime = {
  id?: string;
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
  await expect(page.getByTestId('brainvault-onboarding-recovery-toggle')).toContainText(/Seed safety/i);
  await expect(page.getByRole('heading', { name: /Encrypted backup and last-resort dispute protection/i })).toBeVisible();
  const downloadButton = page.getByRole('button', { name: /Download sheet/i });
  if (!await downloadButton.isVisible().catch(() => false)) {
    await page.getByTestId('brainvault-onboarding-recovery-toggle').click();
  }
  await expect(downloadButton).toBeVisible({ timeout: 5_000 });
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

async function waitForRuntimeMetadata(page: Page, expectedRuntimeId: string): Promise<StoredRuntime> {
  const handle = await page.waitForFunction((runtimeId: string) => {
    try {
      const raw = localStorage.getItem('xln-vaults');
      if (!raw) return null;
      const parsed = JSON.parse(raw) as {
        activeRuntimeId?: string;
        runtimes?: Record<string, StoredRuntime>;
      };
      const runtime = parsed.activeRuntimeId ? parsed.runtimes?.[parsed.activeRuntimeId] : null;
      if (!runtime || String(runtime.id || '').toLowerCase() !== runtimeId.toLowerCase()) return null;
      return runtime;
    } catch {
      return null;
    }
  }, expectedRuntimeId, { timeout: 90_000 });
  return await handle.jsonValue() as StoredRuntime;
}

const phraseAfter = (sheet: string, heading: string): string => {
  const lines = sheet.split(/\r?\n/);
  const index = lines.findIndex(line => line.trim() === heading);
  if (index < 0) throw new Error(`BRAINVAULT_SHEET_HEADING_MISSING:${heading}`);
  return normalizeMnemonic(lines[index + 1] || '');
};

async function readBrainvaultRecoverySheet(page: Page): Promise<BrainvaultCliOutput & { runtimeId: string }> {
  const recoveryDetails = page.getByTestId('brainvault-onboarding-recovery');
  await expect(recoveryDetails).toBeVisible({ timeout: 30_000 });
  const downloadButton = page.getByRole('button', { name: /Download sheet/i });
  if (!await downloadButton.isVisible().catch(() => false)) {
    await page.getByTestId('brainvault-onboarding-recovery-toggle').click();
  }
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    downloadButton.click(),
  ]);
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error('BRAINVAULT_SHEET_DOWNLOAD_PATH_MISSING');
  const sheet = readFileSync(downloadPath, 'utf8');
  const runtimeIdLine = sheet.split(/\r?\n/).find(line => line.startsWith('Runtime ID:')) || '';
  return {
    mnemonic24: phraseAfter(sheet, '24-word recovery phrase:'),
    mnemonic12: phraseAfter(sheet, '12-word compatibility phrase:'),
    runtimeId: runtimeIdLine.slice('Runtime ID:'.length).trim().toLowerCase(),
  };
}

async function createFreshWalletWhenNoBackupExists(page: Page): Promise<void> {
  const configureHeading = page.getByRole('heading', { name: /Configure account/i });
  await expect(configureHeading).toBeVisible({ timeout: 120_000 });
  const recoveryStatus = page.getByTestId('runtime-recovery-check-status');
  await expect(recoveryStatus).toBeVisible({ timeout: 30_000 });
  await expect(recoveryStatus).toContainText(/Checked \d+ watchtowers?,\s+found 0 backups? for this seed/i);
  await expect(recoveryStatus.getByRole('button', { name: /I have a runtime backup file/i })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Restore wallet/i })).toHaveCount(0);
}

async function deriveBrainvaultInUi(page: Page, name: string, passphrase: string, shards: number): Promise<BrainvaultCliOutput> {
  await waitForBrainvaultCreateForm(page);

  await page.locator('#name').fill(name);
  await page.locator('#passphrase').fill(passphrase);

  // Security work factor presets (incl. Custom) are collapsed under the "Advanced" toggle now.
  await page.getByRole('button', { name: /Security work factor/i }).click();
  await page.getByRole('button', { name: /Custom/i }).click();
  await page.locator('#shards').fill(String(shards));

  const openVaultButton = page.getByRole('button', { name: /Derive wallet/i });
  await expect(openVaultButton).toBeEnabled({ timeout: 15_000 });
  await openVaultButton.click();
  await createFreshWalletWhenNoBackupExists(page);

  const recovery = await readBrainvaultRecoverySheet(page);
  const expectedRuntimeId = deriveSignerAddressFromMnemonic(recovery.mnemonic24);
  const runtime = await waitForRuntimeMetadata(page, expectedRuntimeId);
  expect(runtime.label).toBe(name);
  expect(runtime.seed).toBeUndefined();
  expect(runtime.mnemonic12).toBeUndefined();
  expect(recovery.runtimeId).toBe(expectedRuntimeId);
  return recovery;
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
    // Security work factor presets are collapsed under the "Advanced" toggle now.
    await page.getByRole('button', { name: /Security work factor/i }).click();
    await page.getByRole('button', { name: /^1\s+Test$/ }).click();

    const openVaultButton = page.getByRole('button', { name: /Derive wallet/i });
    await expect(openVaultButton).toBeEnabled({ timeout: 15_000 });
    await openVaultButton.click();
    await createFreshWalletWhenNoBackupExists(page);

    const expectedRuntimeId = deriveSignerAddressFromMnemonic(cli.mnemonic24);
    const runtime = await waitForRuntimeMetadata(page, expectedRuntimeId);
    const recovery = await readBrainvaultRecoverySheet(page);
    expect(runtime.label).toBe('standalone vault');
    expect(runtime.seed).toBeUndefined();
    expect(runtime.mnemonic12).toBeUndefined();
    expect(recovery.mnemonic24).toBe(cli.mnemonic24);
    expect(recovery.mnemonic12).toBe(cli.mnemonic12);
    expect(recovery.runtimeId).toBe(expectedRuntimeId);
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

    const runtime = await waitForRuntimeMetadata(page, deriveSignerAddressFromMnemonic(derived.mnemonic24));
    expect(runtime.label).toBe('embedded add runtime');
    expect(runtime.seed).toBeUndefined();
    expect(runtime.mnemonic12).toBeUndefined();
    expect(await readActiveRuntimeId(page)).not.toBe(oldRuntime.runtimeId);
    expect(await readRuntimeCount(page)).toBe(2);
  });
});
