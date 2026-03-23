import { test, expect, type Page } from '@playwright/test';
import { Wallet } from 'ethers';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';

import {
  gotoApp as gotoSharedApp,
  createRuntime as createSharedRuntime,
} from './utils/e2e-demo-users';
import { requireIsolatedBaseUrl } from './utils/e2e-isolated-env';

const APP_BASE_URL = requireIsolatedBaseUrl('E2E_BASE_URL');
const INIT_TIMEOUT = 30_000;

function randomMnemonic(): string {
  return Wallet.createRandom().mnemonic!.phrase;
}

async function gotoApp(page: Page): Promise<void> {
  await gotoSharedApp(page, {
    appBaseUrl: APP_BASE_URL,
    initTimeoutMs: INIT_TIMEOUT,
    settleMs: 500,
  });
}

async function dismissOnboardingIfVisible(page: Page): Promise<void> {
  const checkbox = page.locator('text=I understand and accept the risks of using this software').first();
  if (await checkbox.isVisible({ timeout: 1000 }).catch(() => false)) {
    await checkbox.click();
    const continueBtn = page.locator('button:has-text("Continue")').first();
    if (await continueBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await continueBtn.click();
      await page.waitForTimeout(300);
    }
  }
}

async function startExtraJurisdiction(name: string, port: number): Promise<{
  proc: ChildProcessWithoutNullStreams;
  configJson: string;
}> {
  const repoRoot = process.cwd();
  const proc = spawn('bun', [
    'runtime/scripts/dev-anvil-stack.ts',
    '--spawn-anvil',
    '--keep-alive',
    '--json-only',
    '--name', name,
    '--port', String(port),
  ], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  const configJson = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for extra jurisdiction config.\nSTDERR:\n${stderr}`));
    }, 60_000);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const lines = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed.name === 'string' && Array.isArray(parsed.rpcs)) {
            clearTimeout(timeout);
            resolve(JSON.stringify(parsed, null, 2));
            return;
          }
        } catch {
          // keep reading
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Extra jurisdiction helper exited early with code ${code}.\nSTDERR:\n${stderr}`));
    });
  });

  return { proc, configJson };
}

test('settings can add custom jurisdiction from canonical JSON and import it into active runtime', async ({ page }) => {
  const port = 18600 + (process.pid % 500);
  const helperName = `Settings Test ${Date.now()}`;
  const extra = await startExtraJurisdiction(helperName, port);

  try {
    await gotoApp(page);
    await dismissOnboardingIfVisible(page);
    await createSharedRuntime(page, `settings-${Date.now()}`, randomMnemonic());

    await page.getByTestId('tab-settings').click();
    await page.getByRole('button', { name: 'Network' }).click();
    await page.getByTestId('settings-network-add-jmachine-toggle').click();

    await page.getByTestId('add-jmachine-advanced-toggle').click();
    const jsonInput = page.getByTestId('add-jmachine-json');
    await expect(jsonInput).toBeVisible({ timeout: 10_000 });
    await jsonInput.fill(extra.configJson);
    await page.getByTestId('add-jmachine-json-apply').click();
    await page.getByTestId('add-jmachine-create').click();

    await expect(page.getByText('Imported into active runtime')).toBeVisible({ timeout: 45_000 });

    await expect
      .poll(async () => {
        return await page.evaluate((jurisdictionName) => {
          const env = (window as typeof window & {
            isolatedEnv?: {
              jReplicas?: Map<string, { contracts?: { depository?: string } }>;
            };
          }).isolatedEnv;
          const replica = env?.jReplicas?.get?.(jurisdictionName);
          return {
            hasReplica: Boolean(replica),
            depository: String(replica?.contracts?.depository || ''),
          };
        }, helperName);
      }, { timeout: 45_000 })
      .toMatchObject({
        hasReplica: true,
      });
  } finally {
    if (extra.proc.exitCode === null) {
      extra.proc.kill('SIGTERM');
    }
  }
});
