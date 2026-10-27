import { expect, test } from '@playwright/test';

const APP = process.env['SVELTE_E2E_BASE_URL'] ?? 'http://localhost:8081/app';
const target = `0x${'22'.repeat(32)}`;
const invoice = `xln://pay?target=${target}&desc=Lunch&u=alice`;

test(
  'Svelte custody invoice rejects ambiguous attribution and restores the manual note',
  { tag: '@functional' },
  async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(APP);
    await page.locator('#name').fill(`invoice-${crypto.randomUUID()}`);
    await page.getByLabel('Secret passphrase', { exact: true }).fill('Disposable invoice regression October 2026!');
    await page.getByRole('button', { name: 'Derive wallet', exact: true }).click();
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await page.getByRole('button', { name: 'Accounts', exact: true }).click();
    await page.getByRole('button', { name: 'Pay', exact: true }).click();
    const to = page.getByPlaceholder('Name, address, or invoice');
    const note = page.getByLabel('Payment note', { exact: true });
    await page.getByRole('button', { name: 'Add note', exact: false }).click();
    await note.fill('Manual note');
    const checkInvoice = async () => {
      await to.fill(invoice);
      await expect(note).toHaveValue('Lunch | uid:alice');
      await expect(note).toHaveAttribute('readonly', '');
    };
    const checkManual = async () => {
      await expect(note).toHaveValue('Manual note');
      await expect(note).not.toHaveAttribute('readonly');
    };
    await checkInvoice();
    await to.fill('H1');
    await checkManual();
    await page.getByTestId('payment-invoice').locator('.dropdown-item').first().click();
    await checkManual();
    await checkInvoice();
    await to.fill('xln://pay?target=invalid');
    await checkManual();
    await checkInvoice();
    await to.fill(`xln://pay?target=${target}&desc=uid:bob&u=alice`);
    await expect(page.getByText('Invoice description contains custody attribution', { exact: true })).toBeVisible();
    await checkManual();
    await checkInvoice();
    await to.fill('');
    await checkManual();
    await note.fill('');
    await checkInvoice();
    await to.fill('');
    await expect(note).not.toHaveAttribute('readonly');
    await expect(note).toHaveValue('');
    await page.screenshot({ path: info.outputPath('svelte-invoice-note-cleared.png'), fullPage: true });
    expect(errors).toEqual([]);
  },
);
