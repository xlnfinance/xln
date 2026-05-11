import { execFileSync } from 'node:child_process';

import { expect, test, type Page } from '@playwright/test';

import { APP_BASE_URL, gotoApp } from './utils/e2e-demo-users';

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

async function readMnemonicWords(page: Page, testId: string): Promise<string> {
  const box = page.getByTestId(testId);
  await expect(box).toBeVisible({ timeout: 120_000 });
  const words = await box.locator('.word').allTextContents();
  return normalizeMnemonic(words.map((word) => word.replace(/^\d+\.\s*/, '').trim()).join(' '));
}

async function readRuntimeCount(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const raw = localStorage.getItem('xln-vaults');
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as { runtimes?: Record<string, unknown> };
    return Object.keys(parsed.runtimes ?? {}).length;
  });
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

async function deriveBrainvaultInUi(page: Page, name: string, passphrase: string, shards: number): Promise<BrainvaultCliOutput> {
  await expect(page.getByRole('button', { name: 'BrainVault', exact: true })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'BrainVault', exact: true }).click();

  await page.locator('#name').fill(name);
  await page.locator('#passphrase').fill(passphrase);

  await page.getByRole('button', { name: /Custom/i }).click();
  await page.locator('#shards').fill(String(shards));

  const openVaultButton = page.getByRole('button', { name: /Open (Wallet|Vault)/, exact: false });
  await expect(openVaultButton).toBeEnabled({ timeout: 15_000 });
  await openVaultButton.click();

  const [mnemonic12, mnemonic24] = await Promise.all([
    readMnemonicWords(page, 'brainvault-mnemonic-12'),
    readMnemonicWords(page, 'brainvault-mnemonic-24'),
  ]);

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

  test('standalone BrainVault exports seed and addresses before XLN wallet opt-in', async ({ page }) => {
    test.slow();

    await gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: 60_000, settleMs: 250 });

    await expect(page.getByRole('button', { name: 'BrainVault', exact: true })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'BrainVault', exact: true }).click();
    await page.locator('#name').fill('standalone vault');
    await page.locator('#passphrase').fill('ced-export-42');
    await page.getByRole('button', { name: /^1\s+Test$/ }).click();

    const openVaultButton = page.getByRole('button', { name: /Open (Wallet|Vault)/, exact: false });
    await expect(openVaultButton).toBeEnabled({ timeout: 15_000 });
    await openVaultButton.click();

    const [mnemonic12, mnemonic24] = await Promise.all([
      readMnemonicWords(page, 'brainvault-mnemonic-12'),
      readMnemonicWords(page, 'brainvault-mnemonic-24'),
    ]);

    await expect(page.getByTestId('brainvault-eoa-address-0')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('brainvault-eoa-address-1')).toBeVisible();
    await expect(page.getByTestId('brainvault-eoa-address-2')).toBeVisible();
    expect(await readRuntimeCount(page)).toBe(0);

    const createWalletButton = page.getByRole('button', { name: 'Create XLN wallet' });
    await expect(createWalletButton).toBeEnabled({ timeout: 15_000 });
    await createWalletButton.click();

    const runtime = await waitForRuntimeWithSeed(page, mnemonic24);
    expect(runtime.label).toBe('standalone vault');
    expect(normalizeMnemonic(runtime.mnemonic12 || '')).toBe(mnemonic12);
    expect(await readRuntimeCount(page)).toBe(1);
  });
});
