import { expect, type Page, type TestInfo } from '@playwright/test';
import { capturePageScreenshot } from '../../e2e-screenshots';

const READY = { timeout: 30_000 };
const nav = (page: Page, name: string) => page.getByTestId(`nav-${name}`).locator('visible=true').first().click();
type Capture = (name: string, group: string, description: string) => Promise<void>;

async function openWallet(page: Page, base: string, hubIds: string[]): Promise<void> {
  await page.goto(`${base}/ui/`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-testid="gate-stack"][data-state="online"]')).toBeVisible(READY);
  await page.getByRole('button', { name: 'Open a test wallet', exact: true }).click();
  await expect(page.getByTestId('home-total')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('account-row').first()).toBeVisible(READY);
  const response = page.waitForResponse(
    row => new URL(row.url()).pathname === '/api/faucet/offchain' && row.request().method() === 'POST',
  );
  await page.getByTestId('home-faucet').click();
  const funding = await response;
  expect(funding.ok(), await funding.text()).toBe(true);
  await expect(page.getByTestId('test-money-status')).toHaveText('100 USDC received', READY);
  await expect(page.getByTestId('token-net-USDC')).toHaveText('100.00', READY);
  for (const hubId of hubIds) {
    const row = page.locator(`[data-testid="account-row"][data-counterparty-id="${hubId}"]`);
    if ((await row.count()) === 0) {
      await page.getByTestId('home-open-account').click();
      const sheet = page.getByRole('dialog', { name: 'Open account', exact: true });
      await sheet.getByTestId('open-account-target').fill(hubId);
      await sheet.getByTestId('open-account-credit').fill('10000');
      await expect(sheet.getByTestId('open-account-submit')).toBeEnabled(READY);
      await sheet.getByTestId('open-account-submit').click();
      await expect(sheet).toBeHidden(READY);
    }
    await expect(row).toBeVisible(READY);
  }
  await expect(page.getByTestId('account-row')).toHaveCount(3);
}

async function captureAccount(page: Page, hubId: string, snap: Capture): Promise<void> {
  await nav(page, 'home');
  await snap('accounts', 'Accounts', 'Three hub accounts in the canonical wallet.');
  await page.locator(`[data-testid="account-row"][data-counterparty-id="${hubId}"]`).click();
  await expect(page.getByTestId('account-status')).toHaveText('Open', READY);
  const lane = page.getByTestId('account-lane-USDC');
  await expect(lane).toBeVisible(READY);
  await lane.getByRole('button', { name: 'Ledger detail' }).click();
  await expect(lane.getByText('offdelta', { exact: true })).toBeVisible();
  await expect(lane.getByText('Total capacity', { exact: true })).toBeVisible();
  await snap('accounts-expanded', 'Accounts', 'Signed bilateral balance, directional credit and expanded ledger.');
  await page.getByTestId('account-tab-frames').click();
  await expect(page.getByTestId('account-frame-row').first()).toBeVisible(READY);
  await snap('accounts-frames', 'History', 'Persisted signed Account frames.');
  await page.getByTestId('account-dispute').click();
  await expect(page.getByTestId('dispute-prepare')).toBeVisible(READY);
  await snap('accounts-dispute-controls', 'Disputes', 'Actual dispute preparation controls; no dispute submitted.');
  await page.getByTestId('sheet-close').click();
}

async function expectBook(page: Page, label: string): Promise<void> {
  const book = page.getByTestId('orderbook').locator('visible=true').first();
  await expect(book).toHaveAttribute('data-status', 'live', READY);
  await expect(book.locator('.bk-head')).toContainText(label, READY);
  await expect(book.getByTestId('book-row-ask').first()).toBeVisible(READY);
  await expect(book.getByTestId('book-row-bid').first()).toBeVisible(READY);
}

async function captureSwap(page: Page, snap: Capture): Promise<void> {
  await nav(page, 'home');
  await page.getByTestId('home-swap').click();
  await expect(page.getByTestId('swap-give')).toBeVisible(READY);
  await page.locator('.chips').getByRole('button', { name: 'H1', exact: true }).click();
  await expectBook(page, 'H1');
  await snap('swap-base', 'Swap', 'Same-network ticket with live bid and ask depth from H1.');
  await page.locator('.chips').getByRole('button', { name: 'H2', exact: true }).click();
  await expect(page.locator('.chips button.active')).toHaveText('H2');
  await expectBook(page, 'H2');
  await snap('swap-hub-selected', 'Swap', 'H2 selected; live bid and ask depth observed.');
  const give = page.locator('.field-row', { has: page.getByTestId('swap-give') }).locator('button.pill');
  await give.click();
  await page.getByRole('option', { name: /USDT/ }).click();
  await expect(give).toContainText('USDT');
  await expectBook(page, 'H2');
  await expect(page.getByTestId('orderbook').locator('visible=true').first().locator('.bk-head')).toContainText('USDT');
  await snap('swap-token-selected', 'Swap', 'USDT selected with live market depth.');
  await page.getByTestId('swap-cross-mode').click();
  await expect(page.getByTestId('swap-cross-mode')).toHaveAttribute('aria-pressed', 'true');
  const destination = page.locator('.kv').filter({ hasText: 'Your other account' }).locator('select');
  await expect(destination).toBeVisible();
  await expect(destination).toHaveValue(/^0x[0-9a-f]{64}$/);
  const targetHub = page.locator('.kv').filter({ hasText: 'Hub there' }).locator('select');
  await targetHub.selectOption({ label: 'H2' });
  await expect(targetHub.locator('option:checked')).toHaveText('H2');
  await expect(page.getByTestId('cross-swap-safety')).toBeVisible();
  await snap('swap-route-selected', 'Swap', 'Destination network account and H2 selected; no trade submitted.');
  await page.getByTestId('back').click();
}

async function captureActions(page: Page, snap: Capture): Promise<void> {
  await nav(page, 'home');
  await page.getByTestId('home-pay').click();
  await expect(page.getByTestId('pay-amount')).toBeVisible(READY);
  await snap('accounts-pay', 'Payments', 'Public payment composer.');
  await page.getByTestId('back').click();
  await nav(page, 'home');
  await page.getByTestId('home-receive').click();
  await page.getByTestId('receive-amount').fill('10');
  await expect(page.getByTestId('receive-copy-link')).toBeEnabled();
  await snap('accounts-receive', 'Payments', 'Receive invoice with a concrete amount and payment link.');
  await page.getByTestId('back').click();
  await captureSwap(page, snap);
  await nav(page, 'home');
  await page.getByTestId('home-move').click();
  await expect(page.getByTestId('move-amount')).toBeVisible(READY);
  await expect(page.getByTestId('move-now')).toBeVisible();
  await snap('accounts-move', 'On-chain Batch', 'Move between wallet, reserve and account; no transaction submitted.');
  await page.getByTestId('back').click();
  await nav(page, 'activity');
  await expect(page.getByTestId('activity-row').first()).toBeVisible(READY);
  await snap('accounts-history', 'History', 'Actual funding activity from this wallet.');
}

/** Production-safe rendered UI only: no Svelte wallet, injected state or debug API. */
export async function captureReactWalletScreens(
  page: Page,
  base: string,
  hubIds: string[],
  prefix: string,
  output: TestInfo,
): Promise<void> {
  const platform = prefix.startsWith('mobile') ? 'mobile' : 'desktop';
  const snap: Capture = async (name, group, description) => {
    await capturePageScreenshot(page, output, `${prefix}-${name}.png`, {
      fullPage: false,
      ux: { title: `${prefix} ${name}`, group, description, platform },
    });
  };
  await openWallet(page, base, hubIds);
  await nav(page, 'manage');
  await page.getByTestId('manage-assets').click();
  await expect(page.getByTestId('external-balance-USDC')).not.toHaveText('—', READY);
  await expect(page.getByTestId('external-row-USDC').locator('.s')).toContainText('Depository may pull', READY);
  await expect(page.getByTestId('faucet-account-balance')).toHaveText('100.00 USDC', READY);
  await snap('assets', 'Portfolio', 'On-chain balances and actual funded Account balance.');
  const [firstHub] = hubIds;
  if (!firstHub) throw new Error('VISUAL_HUB_FIXTURE_EMPTY');
  await captureAccount(page, firstHub, snap);
  await captureActions(page, snap);
  await page.getByRole('link', { name: 'Settings', exact: true }).locator('visible=true').first().click();
  await expect(page.getByTestId('design-sample')).toBeVisible(READY);
  await snap('settings', 'Settings', 'Canonical wallet identity and appearance controls.');
}
