import { expect, test } from '@playwright/test';

declare global {
  interface Window {
    __xlnWorkerInitTimeouts?: number;
  }
}

const TEST_URL = '/app?locktest=1&scenarioPreview=1';
const TEST_MNEMONIC = 'test test test test test test test test test test test junk';
const VIEWPORTS = [
  { label: 'iphone', width: 390, height: 844 },
  { label: 'laptop', width: 1440, height: 900 },
  { label: 'wide', width: 2560, height: 1440 },
] as const;

test.describe('Wallet recovery guidance', () => {
  for (const viewport of VIEWPORTS) {
    test(`shows concise tradeoffs at ${viewport.label} size`, { tag: '@functional' }, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.goto(TEST_URL);

      await expect(page.getByRole('heading', { name: 'Create xln wallet', exact: true })).toBeVisible();
      await expect(page.getByText('Your name and private secret recreate the same wallet. No backup phrase is required.')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Derive wallet', exact: true })).toBeVisible();
      await expect(page.getByTestId('recovery-rehearsal-option')).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`${viewport.label}-brainvault.png`), fullPage: true });

      await page.getByRole('tab', { name: 'Mnemonic', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Create or restore from seed', exact: true })).toBeVisible();
      await expect(page.getByTestId('mnemonic-tradeoffs')).toBeVisible();
      await expect(page.getByText('Correct implementations generate high-entropy seeds locally', { exact: true })).toBeVisible();
      const rngIncident = page.getByRole('link', { name: 'Coldcard RNG incident', exact: true });
      await expect(rngIncident).toBeVisible();
      await expect(rngIncident).toHaveAttribute('href', 'https://www.cryptotimes.io/2026/07/31/bitcoins-invisible-risk-coldcard-mk3-firmware-bug-leaves-btc-wallet-seeds-exposed-38m-drained/');
      await expect(page.getByRole('button', { name: 'Continue with seed', exact: true })).toBeDisabled();
      await page.screenshot({ path: testInfo.outputPath(`${viewport.label}-mnemonic.png`), fullPage: true });
    });
  }

  test('opens Brain Vault without a recovery rehearsal', { tag: '@functional' }, async ({ page }) => {
    await page.setViewportSize(VIEWPORTS[0]);
    await page.goto(TEST_URL);

    await expect(page.getByRole('heading', { name: 'Create xln wallet', exact: true })).toBeVisible();
    await expect(page.getByTestId('recovery-rehearsal-option')).toHaveCount(0);
    await expect(page.getByTestId('recovery-rehearsal-active')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Derive wallet', exact: true })).toBeDisabled();
  });

  test('wallet tabs follow the keyboard tab pattern', { tag: '@functional' }, async ({ page }) => {
    await page.goto(TEST_URL);
    const brainVaultTab = page.getByRole('tab', { name: 'Brain Vault', exact: true });
    const mnemonicTab = page.getByRole('tab', { name: 'Mnemonic', exact: true });
    await brainVaultTab.focus();
    await page.keyboard.press('ArrowRight');
    await expect(mnemonicTab).toBeFocused();
    await expect(mnemonicTab).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(brainVaultTab).toBeFocused();
  });

  test('wallet mode navigation drops secret inputs', { tag: '@functional' }, async ({ page }) => {
    await page.goto(TEST_URL);
    await page.getByLabel('Secret passphrase').fill('secret123456');
    await page.getByRole('tab', { name: 'Mnemonic', exact: true }).click();
    await page.getByLabel('Seed phrase').fill(TEST_MNEMONIC);
    await page.getByRole('tab', { name: 'Brain Vault', exact: true }).click();
    await expect(page.getByLabel('Secret passphrase')).toHaveValue('');
    await page.getByRole('tab', { name: 'Mnemonic', exact: true }).click();
    await expect(page.getByLabel('Seed phrase')).toHaveValue('');
  });

  test('rejects a stale cached worker before deriving', { tag: '@functional' }, async ({ page }) => {
    await page.route(/\/brainvault-worker\.js\?spec=/, async (route) => {
      await route.fulfill({
        contentType: 'application/javascript',
        body: `self.onmessage = ({ data }) => {
          if (data.type === 'init') self.postMessage({ type: 'ready', id: data.id, data: { specId: 'stale-v0' } });
        };`,
      });
    });
    await page.goto(TEST_URL);
    await page.getByLabel('Vault name public derivation input').fill('cache-check');
    await page.getByLabel('Secret passphrase').fill('secret123456');
    await page.getByRole('button', { name: /^Advanced\b/ }).click();
    await page.getByRole('button', { name: '1 Test', exact: true }).click();
    await page.getByRole('button', { name: 'Derive wallet', exact: true }).click();
    await expect(page.getByText(/BRAINVAULT_WORKER_SPEC_MISMATCH:stale-v0/)).toBeVisible();
  });

  test('cancelled worker initialization cannot terminate a restarted derivation', { tag: '@functional' }, async ({ page }) => {
    await page.addInitScript(() => {
      const nativeSetTimeout = window.setTimeout.bind(window);
      let workerInitTimeouts = 0;
      Object.defineProperty(window, '__xlnWorkerInitTimeouts', {
        configurable: false,
        get: () => workerInitTimeouts,
      });
      window.setTimeout = ((handler: TimerHandler, timeout = 0, ...args: unknown[]) =>
        nativeSetTimeout(() => {
          if (timeout === 30_000) workerInitTimeouts += 1;
          if (typeof handler === 'function') handler(...args);
          else new Function(handler)();
        }, timeout === 30_000 ? 1_000 : timeout)) as typeof window.setTimeout;
    });

    let workerRequests = 0;
    await page.route(/\/brainvault-worker\.js\?spec=/, async (route) => {
      workerRequests += 1;
      const specId = new URL(route.request().url()).searchParams.get('spec') ?? '';
      await route.fulfill({
        contentType: 'application/javascript',
        body: workerRequests === 1
          ? 'self.onmessage = () => {};'
          : `self.onmessage = ({ data }) => {
              if (data.type === 'init') {
                self.postMessage({ type: 'ready', id: data.id, data: { specId: ${JSON.stringify(specId)} } });
              }
            };`,
      });
    });

    await page.goto(TEST_URL);
    await page.getByLabel('Vault name public derivation input').fill('restart-race');
    await page.getByLabel('Secret passphrase').fill('secret123456');
    await page.getByRole('button', { name: /^Advanced\b/ }).click();
    await page.getByRole('button', { name: '1 Test', exact: true }).click();

    await page.getByRole('button', { name: 'Derive wallet', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByLabel('Secret passphrase')).toHaveValue('');
    await page.getByLabel('Secret passphrase').fill('secret123456');
    await page.getByRole('button', { name: 'Derive wallet', exact: true }).click();

    await expect.poll(() => workerRequests, { timeout: 5_000 }).toBe(2);
    await expect.poll(() => page.evaluate(() => window.__xlnWorkerInitTimeouts ?? 0), {
      timeout: 5_000,
      message: 'the cancelled worker initialization timeout must fire before the restarted derivation is accepted',
    }).toBe(1);
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
    await expect(page.getByText(/Worker init timeout/)).toHaveCount(0);
    expect(workerRequests).toBe(2);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  });

  test('wallet persistence becomes an explicit point of no return', { tag: '@functional' }, async ({ page }) => {
    let releaseJurisdictions!: () => void;
    const jurisdictionGate = new Promise<void>((resolve) => {
      releaseJurisdictions = resolve;
    });
    await page.route(/\/api\/jurisdictions/, async (route) => {
      await jurisdictionGate;
      await route.fulfill({ status: 503, body: 'test release' });
    });

    await page.goto(TEST_URL);
    await page.getByRole('tab', { name: 'Mnemonic', exact: true }).click();
    await page.getByLabel('Seed phrase').fill(TEST_MNEMONIC);
    await page.getByRole('button', { name: 'Continue with seed', exact: true }).click();

    await expect(page.getByText('Opening wallet', { exact: true })).toBeVisible({ timeout: 30_000 });
    const finalizingButton = page.getByRole('button', { name: 'Finalizing wallet', exact: true });
    await expect(finalizingButton).toBeVisible();
    await expect(finalizingButton).toBeDisabled();
    releaseJurisdictions();
  });
});
