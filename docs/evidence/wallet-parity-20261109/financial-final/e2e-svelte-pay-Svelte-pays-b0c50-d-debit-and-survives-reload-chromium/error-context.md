# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: e2e-svelte-pay.spec.ts >> Svelte pays another wallet with exact quoted debit and survives reload
- Location: ui/tests/e2e-svelte-pay.spec.ts:4:0

# Error details

```
Error: expect(locator).toBeEnabled() failed

Locator:  getByRole('button', { name: 'Pay now', exact: true })
Expected: enabled
Received: disabled
Timeout:  5000ms

Call log:
  - Expect "toBeEnabled" getByRole('button', { name: 'Pay now', exact: true }) with timeout 5000ms
  - waiting for getByRole('button', { name: 'Pay now', exact: true })
    14 × locator resolved to <button disabled aria-label="Pay now" class="btn-pay svelte-1xhmrpo">…</button>
       - unexpected value "disabled"

```

```yaml
- button "Pay now" [disabled]
```

# Test source

```ts
  1  | import { expect, test } from '@playwright/test';
  2  | import { accountMoney, openSvelteWallet } from './svelte-wallet';
  3  | 
  4  | test('Svelte pays another wallet with exact quoted debit and survives reload', { tag: '@functional' }, async ({ page, browser, baseURL }) => {
  5  |   const recipientContext = await browser.newContext({ baseURL });
  6  |   const recipient = await recipientContext.newPage();
  7  |   const errors: string[] = [];
  8  |   for (const wallet of [page, recipient]) wallet.on('pageerror', error => errors.push(error.message));
  9  |   try {
  10 |     await openSvelteWallet(page);
  11 |     await openSvelteWallet(recipient);
  12 |     await page.getByRole('button', { name: 'Faucet', exact: true }).first().click();
  13 |     await expect.poll(async () => (await accountMoney(page)).owned).toBe(100_000_000n);
  14 |     const target = await accountMoney(recipient);
  15 |     await page.getByRole('button', { name: 'Pay', exact: true }).click();
  16 |     await page.getByPlaceholder('Name, address, or invoice').fill(target.ownerId);
  17 |     await page.getByTestId('payment-amount-input').fill('2');
  18 |     const pay = page.getByRole('button', { name: 'Pay now', exact: true });
> 19 |     await expect(pay).toBeEnabled();
     |                      ^ Error: expect(locator).toBeEnabled() failed
  20 |     const quote = page.locator('[data-testid="payment-route"][data-selected="true"]');
  21 |     const debitText = await quote.getAttribute('data-sender-amount');
  22 |     if (!debitText) throw new Error('SVELTE_PAYMENT_QUOTE_MISSING');
  23 |     const debit = BigInt(debitText);
  24 |     expect(debit).toBeGreaterThanOrEqual(2_000_000n);
  25 |     await pay.click();
  26 |     await expect.poll(async () => (await accountMoney(recipient)).owned).toBe(target.owned + 2_000_000n);
  27 |     await expect.poll(async () => (await accountMoney(page)).owned).toBe(100_000_000n - debit);
  28 |     await page.reload();
  29 |     await expect(page.getByTestId('context-current')).toBeVisible();
  30 |     await expect.poll(async () => (await accountMoney(page)).owned).toBe(100_000_000n - debit);
  31 |     expect(errors).toEqual([]);
  32 |   } finally { await recipientContext.close(); }
  33 | });
  34 | 
```