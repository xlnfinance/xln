import { expect, test } from '@playwright/test';
import { deriveRuntimeRecoveryLookupKey } from '../../core/storage/recovery/bundle/crypto';
import { enterStack, fundFromHub, readWalletCheckpoint } from './stack';

/** The stand runs its own watchtower; a deployed stack names its own. */
const TOWER_URL = process.env['UI_E2E_TOWER_URL'] || 'http://127.0.0.1:9100';

/** The tower's own answer, asked from outside the browser: it must hold a bundle under our blind lookup key. */
async function towerHolds(lookupKey: string): Promise<{ available: boolean; height: number; storedBytes: number }> {
  const response = await fetch(`${TOWER_URL}/api/recovery/discover`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ lookupKey }),
  });
  const payload = (await response.json()) as {
    ok?: boolean;
    available?: boolean;
    latestReceipt?: { height?: number; storedBytes?: number };
  };
  if (!response.ok || payload.ok !== true) throw new Error(`TOWER_DISCOVER_FAILED:${response.status}`);
  return {
    available: payload.available === true,
    height: Number(payload.latestReceipt?.height ?? 0),
    storedBytes: Number(payload.latestReceipt?.storedBytes ?? 0),
  };
}

test(
  'shows signed Account protection and tower receipts, then opens Desk and Pay through the palette',
  { tag: '@functional' },
  async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    const wallet = await enterStack(page);
    const fundingResponse = page.waitForResponse(
      response => new URL(response.url()).pathname === '/api/faucet/offchain' && response.request().method() === 'POST',
    );
    await Promise.all([
      fundFromHub(page, '100'),
      fundingResponse.then(async response => expect(response.ok(), await response.text()).toBe(true)),
    ]);
    await expect(page.getByTestId('token-net-USDC')).toHaveText('100.00');
    await expect(page.getByTestId('home-risk')).toContainText('$100.00');
    await expect
      .poll(
        async () =>
          (await readWalletCheckpoint(page)).accounts.every(account => !account.pending && account.mempool === 0),
        { timeout: 15_000 },
      )
      .toBe(true);
    const before = await readWalletCheckpoint(page);
    expect(before.accounts.length).toBeGreaterThan(0);

    await page.getByTestId('home-sovereignty').click();
    await expect(page.getByTestId('sovereignty-hero')).toBeVisible();
    await expect(page.getByTestId('sovereignty-risk')).toContainText('$100.00');
    await expect(page.getByTestId('sovereignty-ledger')).toContainText('Accounts co-signed');
    // File export, exact restore and unilateral exit are covered by e2e-file-restore.
    await page.screenshot({ path: testInfo.outputPath('sovereignty-funded.png'), fullPage: true });

    // The watchtower the tour promises: nobody is watching until the person names a tower,
    // and "protecting you" is the tower's own answer, not a saved preference.
    const lookupKey = deriveRuntimeRecoveryLookupKey(wallet.runtimeId, wallet.phrase);
    expect(await towerHolds(lookupKey), 'a fresh wallet is not backed up anywhere').toMatchObject({ available: false });
    await expect(page.getByTestId('sovereignty-watchtower')).toHaveAttribute('data-covered', 'no');
    await expect(page.getByTestId('watchtower-state')).toHaveText('not backed up');
    await expect(page.getByTestId('watchtower-coverage-lastresort')).toContainText(
      'No appointments verified in this session',
    );
    await page.getByTestId('watchtower-url').fill(TOWER_URL);
    await page.getByTestId('watchtower-add').click();
    await expect(page.getByTestId('sovereignty-watchtower')).toHaveAttribute('data-covered', 'yes', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('watchtower-row')).toHaveCount(1);
    await expect(page.getByTestId('watchtower-row')).toContainText('holding your frame #');
    const stored = await towerHolds(lookupKey);
    expect(stored.available, 'the tower now holds this wallet under its blind lookup key').toBe(true);
    expect(stored.height).toBeGreaterThanOrEqual(before.frame.height);
    expect(stored.storedBytes).toBeGreaterThan(0);
    await expect(page.getByTestId('watchtower-coverage-backup')).toContainText(
      `#${stored.height.toLocaleString('en-US')}`,
    );
    await expect(page.getByTestId('watchtower-coverage-accounts')).toContainText(String(before.accounts.length));
    console.log(`WATCHTOWER_BACKUP tower=${TOWER_URL} height=${stored.height} storedBytes=${stored.storedBytes}`);
    const appointmentResponse = page.waitForResponse(
      response =>
        response.request().method() === 'PUT' &&
        response.url().includes('watchtower-proxy') &&
        response.request().postDataJSON()?.towerMode === 'delayed_last_resort',
    );
    await page.getByTestId('protection-appoint').click();
    const accepted = await appointmentResponse;
    expect(accepted.ok()).toBe(true);
    const { receipt } = await accepted.json();
    expect(receipt.towerMode).toBe('delayed_last_resort');
    expect(receipt.appointmentSequence).toBeGreaterThan(0);
    expect(receipt.expiresAt).toBeGreaterThan(Date.now());
    await expect(page.getByTestId('protection-state')).toContainText('account appointment receipts received');
    await page.getByTestId('watchtower-coverage-lastresort').locator('summary').first().click();
    await expect(page.getByTestId('watchtower-coverage-lastresort')).toContainText('Proof hash');
    await testInfo.attach('tower-protection-receipt', {
      body: JSON.stringify(receipt),
      contentType: 'application/json',
    });

    await page.getByTestId('watchtower-remove').click();
    await expect(page.getByTestId('watchtower-row')).toHaveCount(0);
    await expect(page.getByTestId('watchtower-state')).toHaveText('not backed up');
    await expect(page.getByTestId('watchtower-mode-local')).toHaveClass(/active/);

    await page.getByRole('link', { name: 'Settings' }).first().click();
    await page.getByTestId('density-desk').click();
    await page.getByRole('link', { name: 'Home' }).first().click();
    await expect(page.getByTestId('desk')).toBeVisible();
    await expect(page.getByTestId('desk-table').locator('tbody tr')).not.toHaveCount(0);
    await expect(page.getByTestId('desk-net')).toContainText('$100.00');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    await expect(page.getByTestId('palette')).toBeVisible();
    await page.getByTestId('palette-input').fill('pay');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/pay/);
    await page.getByRole('link', { name: 'Settings' }).first().click();
    await page.getByTestId('density-comfort').click();
    expect(pageErrors).toEqual([]);
  },
);
