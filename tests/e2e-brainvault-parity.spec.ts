import { execFileSync } from 'node:child_process';

import { expect, test, type Page } from '@playwright/test';

import { APP_BASE_URL, gotoApp } from './utils/e2e-demo-users';

type BrainvaultCliOutput = {
  mnemonic24: string;
  mnemonic12: string;
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

async function deriveBrainvaultInUi(page: Page, name: string, passphrase: string, shards: number): Promise<BrainvaultCliOutput> {
  await expect(page.getByRole('button', { name: 'BrainVault', exact: true })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'BrainVault', exact: true }).click();

  await page.locator('#name').fill(name);
  await page.locator('#passphrase').fill(passphrase);

  await page.getByRole('button', { name: /Custom/i }).click();
  await page.locator('#shards').fill(String(shards));

  const openVaultButton = page.getByRole('button', { name: 'Open Vault', exact: true });
  await expect(openVaultButton).toBeEnabled({ timeout: 15_000 });
  await openVaultButton.click();

  const handle = await page.waitForFunction((expectedLabel: string) => {
    try {
      const raw = localStorage.getItem('xln-vaults');
      if (!raw) return null;
      const parsed = JSON.parse(raw) as {
        activeRuntimeId?: string;
        runtimes?: Record<string, { label?: string; seed?: string; mnemonic12?: string }>;
      };
      const activeId = parsed.activeRuntimeId;
      const runtime = activeId ? parsed.runtimes?.[activeId] : null;
      if (!runtime?.seed || !runtime?.mnemonic12 || runtime.label !== expectedLabel) return null;
      return {
        mnemonic24: runtime.seed,
        mnemonic12: runtime.mnemonic12,
      };
    } catch {
      return null;
    }
  }, name, { timeout: 120_000 });

  const stored = await handle.jsonValue() as BrainvaultCliOutput;
  return {
    mnemonic12: normalizeMnemonic(stored.mnemonic12),
    mnemonic24: normalizeMnemonic(stored.mnemonic24),
  };
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
});
