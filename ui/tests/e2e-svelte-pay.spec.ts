import { expect, test } from '@playwright/test';
import { accountMoney, openSvelteWallet } from './svelte-wallet';

test('Svelte pays another wallet with exact quoted debit and survives reload', { tag: '@functional' }, async ({ page, browser, baseURL }) => {
  const recipientContext = await browser.newContext({ baseURL });
  const recipient = await recipientContext.newPage();
  const errors: string[] = [];
  for (const wallet of [page, recipient]) wallet.on('pageerror', error => errors.push(error.message));
  try {
    await openSvelteWallet(page);
    await openSvelteWallet(recipient);
    await page.getByRole('button', { name: 'Faucet', exact: true }).first().click();
    await expect.poll(async () => (await accountMoney(page)).owned).toBe(100_000_000n);
    const target = await accountMoney(recipient);
    await page.getByRole('button', { name: 'Pay', exact: true }).click();
    await page.getByPlaceholder('Name, address, or invoice').fill(target.ownerId);
    await page.getByTestId('payment-amount-input').fill('2');
    await page.getByRole('button', { name: 'Find routes', exact: true }).click();
    const pay = page.getByRole('button', { name: 'Pay now', exact: true });
    await expect(pay).toBeEnabled();
    const quote = page.locator('[data-testid="payment-route"][data-selected="true"]');
    const debitText = await quote.getAttribute('data-sender-amount');
    if (!debitText) throw new Error('SVELTE_PAYMENT_QUOTE_MISSING');
    const debit = BigInt(debitText);
    expect(debit).toBeGreaterThanOrEqual(2_000_000n);
    await pay.click();
    await expect.poll(async () => (await accountMoney(recipient)).owned).toBe(target.owned + 2_000_000n);
    await expect.poll(async () => (await accountMoney(page)).owned).toBe(100_000_000n - debit);
    await page.reload();
    await expect(page.getByTestId('context-current')).toBeVisible();
    await expect.poll(async () => (await accountMoney(page)).owned).toBe(100_000_000n - debit);
    expect(errors).toEqual([]);
  } finally { await recipientContext.close(); }
});
