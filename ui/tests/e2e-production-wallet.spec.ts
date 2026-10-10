import { expect, test, type Page } from '@playwright/test';
import { HDNodeWallet } from 'ethers';
import { importStackPhraseUi, LOCAL_PASSWORD } from './stack';

const WAIT = { timeout: 15_000 };
const home = (page: Page) => page.getByTestId('nav-home').locator('visible=true').first().click();
const assets = async (page: Page) => {
  await page.getByTestId('nav-manage').locator('visible=true').first().click();
  await page.getByTestId('manage-assets').click();
};
const entityIdentity = async (page: Page): Promise<string> => {
  await home(page);
  await page.getByTestId('home-receive').click();
  const identity = page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Your entity id', exact: true }) }).locator('button.hash');
  await expect(identity).toBeVisible(WAIT);
  const title = await identity.getAttribute('title');
  if (!title || !/^0x[0-9a-f]{64} · tap to copy$/i.test(title)) throw new Error('PUBLIC_WALLET_ENTITY_ID_MISSING');
  return title.split(' ')[0]!;
};

// These assertions use only the rendered wallet and its HTTP faucet responses.
// Token balances are exact at the UI's displayed two-decimal precision.
test('production wallet imports, funds 100, moves reserve, pays 25 and preserves identity on reload', { tag: '@functional' }, async ({ page }, info) => {
  test.setTimeout(60_000);
  const phrase = HDNodeWallet.createRandom().mnemonic?.phrase;
  if (!phrase) throw new Error('TEST_WALLET_MNEMONIC_MISSING');
  const errors: string[] = [];
  const faucets: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path.startsWith('/api/faucet/')) faucets.push(path);
  });
  await page.goto('/');
  await importStackPhraseUi(page, phrase);
  await expect(page.getByTestId('account-row').first()).toBeVisible(WAIT);
  const entityId = await entityIdentity(page);
  await home(page);
  await page.getByTestId('account-row').first().click();
  const hub = new URL(page.url()).pathname.split('/accounts/')[1];
  if (!hub || !/^0x[0-9a-f]{64}$/.test(hub)) throw new Error('PUBLIC_WALLET_HUB_ID_MISSING');

  await test.step('fund actual reserve and move it to the bilateral Account', async () => {
    await assets(page);
    await expect(page.getByTestId('faucet-account-balance')).toHaveText('0.00 USDC', WAIT);
    await expect(page.getByTestId('faucet-reserve-balance')).toHaveText('0.00 USDC', WAIT);
    for (const [kind, amount] of [['gas', '0.1'], ['reserve', '100']] as const) {
      await page.getByTestId('faucet-amount').fill(amount);
      const response = page.waitForResponse(row => new URL(row.url()).pathname === `/api/faucet/${kind}` && row.request().method() === 'POST');
      await page.getByTestId(`faucet-${kind}`).click();
      const result = await response;
      expect(result.ok(), await result.text()).toBe(true);
      await expect(page.getByTestId(`faucet-${kind}`)).toBeEnabled(WAIT);
    }
    await expect(page.getByTestId('faucet-reserve-balance')).toHaveText('100.00 USDC', WAIT);
    await home(page);
    await page.getByTestId('home-move').click();
    await page.getByTestId('move-from-reserve').click();
    await page.getByTestId('move-to-account').click();
    await page.getByTestId('move-target-hub').selectOption(hub);
    await page.getByTestId('move-amount').fill('100');
    await expect(page.getByTestId('move-now')).toBeEnabled(WAIT);
    await page.getByTestId('move-now').click();
    await expect(page.getByTestId('home-total')).toBeVisible(WAIT);
    await assets(page);
    await expect(page.getByTestId('faucet-reserve-balance')).toHaveText('0.00 USDC', WAIT);
    await expect(page.getByTestId('faucet-account-balance')).toHaveText('100.00 USDC', WAIT);
  });

  await home(page);
  await page.getByTestId('home-pay').click();
  await page.getByTestId('pay-to').fill('H2');
  await page.getByTestId('pay-amount').fill('25');
  await expect(page.getByTestId('pay-submit')).toBeEnabled(WAIT);
  const quote = page.getByTestId('pay-quote');
  await expect(quote).toHaveAttribute('data-recipient-amount', '25000000');
  const senderAmount = BigInt((await quote.getAttribute('data-sender-amount'))!);
  const fee = BigInt((await quote.getAttribute('data-fee-amount'))!);
  expect(senderAmount).toBe(25_000_000n + fee);
  expect(fee).toBeGreaterThanOrEqual(0n);
  expect(fee).toBeLessThan(1_000_000n);
  const cents = (100_000_000n - senderAmount + 5_000n) / 10_000n;
  const expectedBalance = `${cents / 100n}.${String(cents % 100n).padStart(2, '0')} USDC`;
  await page.getByTestId('pay-submit').click();
  await page.getByTestId('receipt-open').click();
  await expect(page.getByTestId('receipt-kicker')).toHaveText('Paid', WAIT);
  await expect(page.getByTestId('receipt-amount')).toHaveText('25.00 USDC');
  await expect(page.getByTestId('receipt-title')).toContainText('H2');
  const proof = page.getByTestId('payment-receipt').locator('.kv').filter({ hasText: 'Hashlock' }).locator('button.hash');
  await expect(proof).toHaveAttribute('title', /^0x[0-9a-f]{64} · tap to copy$/i);
  const proofTitle = await proof.getAttribute('title');
  await page.getByTestId('receipt-done').click();
  await assets(page);
  await expect(page.getByTestId('faucet-account-balance')).toHaveText(expectedBalance, WAIT);
  await expect(page.getByTestId('faucet-reserve-balance')).toHaveText('0.00 USDC', WAIT);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Password', { exact: true }).fill(LOCAL_PASSWORD);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  expect(await entityIdentity(page)).toBe(entityId);
  await assets(page);
  await expect(page.getByTestId('faucet-account-balance')).toHaveText(expectedBalance, WAIT);
  await expect(page.getByTestId('faucet-reserve-balance')).toHaveText('0.00 USDC', WAIT);
  expect(faucets).toEqual(['/api/faucet/gas', '/api/faucet/reserve']);
  expect(errors).toEqual([]);
  await info.attach('public-wallet-evidence', {
    body: `entity=${entityId}\nhub=${hub}\npaid=25.00 USDC\nfeeUnits=${fee}\naccount=${expectedBalance}\nreserve=0.00 USDC\nproof=${proofTitle}\nreload=identity-and-balances-preserved`,
    contentType: 'text/plain',
  });
});
