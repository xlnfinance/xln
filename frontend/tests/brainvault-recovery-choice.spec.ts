import { expect, test } from '@playwright/test';

const TEST_URL = '/app?locktest=1&scenarioPreview=1';
const TEST_MNEMONIC = 'test test test test test test test test test test test junk';
const VIEWPORTS = [
  { label: 'iphone', width: 390, height: 844 },
  { label: 'laptop', width: 1440, height: 900 },
  { label: 'wide', width: 2560, height: 1440 },
] as const;

test.describe('Recovery choice guidance', () => {
  for (const viewport of VIEWPORTS) {
    test(`shows concise tradeoffs at ${viewport.label} size`, { tag: '@functional' }, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.goto(TEST_URL);

      await expect(page.getByTestId('brainvault-tradeoffs')).toBeVisible();
      await expect(page.getByText('No secret paper, photo, or cloud backup to protect', { exact: true })).toBeVisible();
      await expect(page.getByTestId('wallet-recovery-warning')).toContainText('Support cannot recover either secret.');
      await expect(page.getByTestId('wallet-recovery-warning')).toContainText('multisig child entities inside your primary entity');
      await expect(page.getByText(/estimated bits/i)).toHaveCount(0);
      await page.waitForTimeout(800);
      await page.screenshot({ path: testInfo.outputPath(`${viewport.label}-brainvault.png`), fullPage: true });

      await page.getByRole('tab', { name: 'Mnemonic', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Create or restore from seed', exact: true })).toBeVisible();
      await expect(page.getByTestId('mnemonic-tradeoffs')).toBeVisible();
      await expect(page.getByText('Correct implementations generate high-entropy seeds locally', { exact: true })).toBeVisible();
      const rngIncident = page.getByRole('link', { name: 'Coldcard RNG incident', exact: true });
      await expect(rngIncident).toBeVisible();
      await expect(rngIncident).toHaveAttribute('href', 'https://www.cryptotimes.io/2026/07/31/bitcoins-invisible-risk-coldcard-mk3-firmware-bug-leaves-btc-wallet-seeds-exposed-38m-drained/');
      await page.waitForTimeout(250);
      await page.screenshot({ path: testInfo.outputPath(`${viewport.label}-mnemonic.png`), fullPage: true });
    });
  }

  test('requires the work factor to be rehearsed explicitly', { tag: '@functional' }, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize(VIEWPORTS[0]);
    await page.goto(TEST_URL);

    await page.getByLabel('Vault name public derivation input').fill('rehearsal@example.org');
    await page.getByLabel('Secret passphrase').fill('correct horse battery staple');
    await page.getByRole('button', { name: /Security work factor/ }).click();
    await page.getByRole('button', { name: '1 Test', exact: true }).click();
    await page.getByTestId('recovery-rehearsal-option').getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Derive in browser', exact: true }).click();

    await expect(page.getByTestId('recovery-rehearsal-active')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByLabel('Vault name public derivation input')).toHaveValue('');
    await expect(page.getByLabel('Secret passphrase')).toHaveValue('');
    await expect(page.getByRole('button', { name: /Choose the same factor again/ })).toBeVisible();

    await page.getByLabel('Vault name public derivation input').fill('rehearsal@example.org');
    await page.getByLabel('Secret passphrase').fill('correct horse battery staple');
    await expect(page.getByRole('button', { name: 'Verify recovery', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: /Choose the same factor again/ }).click();
    await page.waitForTimeout(250);
    await page.screenshot({ path: testInfo.outputPath('rehearsal-factor-required.png'), fullPage: true });

    await page.getByRole('button', { name: '1 Test', exact: true }).click();
    await expect(page.getByRole('button', { name: '1 Test', exact: true })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Verify recovery', exact: true })).toBeEnabled();
    await page.waitForTimeout(250);
    await page.screenshot({ path: testInfo.outputPath('rehearsal-ready.png'), fullPage: true });
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
    await page.getByRole('button', { name: /Security work factor/ }).click();
    await page.getByRole('button', { name: '1 Test', exact: true }).click();
    await page.getByRole('button', { name: 'Derive in browser', exact: true }).click();
    await expect(page.getByText(/BRAINVAULT_WORKER_SPEC_MISMATCH:stale-v0/)).toBeVisible();
  });

  test('cancelled worker initialization cannot terminate a restarted derivation', { tag: '@functional' }, async ({ page }) => {
    await page.addInitScript(() => {
      const nativeSetTimeout = window.setTimeout.bind(window);
      window.setTimeout = ((handler: TimerHandler, timeout = 0, ...args: unknown[]) =>
        nativeSetTimeout(handler, timeout === 30_000 ? 1_000 : timeout, ...args)) as typeof window.setTimeout;
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
    await page.getByRole('button', { name: /Security work factor/ }).click();
    await page.getByRole('button', { name: '1 Test', exact: true }).click();

    await page.getByRole('button', { name: 'Derive in browser', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Derive in browser', exact: true }).click();

    await page.waitForTimeout(1_300);
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
