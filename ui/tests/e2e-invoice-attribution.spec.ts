import { expect, test } from '@playwright/test';
import { enterStack } from './stack';

const target = `0x${'22'.repeat(32)}`;
const invoice = `xln://pay?target=${target}&desc=Lunch&u=alice`;

test(
  'custody invoice attribution clears on recipient edits, selections and parse failure',
  { tag: '@functional' },
  async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await enterStack(page);
    await page.getByTestId('home-pay').click();
    const to = page.getByTestId('pay-to');
    const note = page.getByTestId('pay-note');
    const checkInvoice = async () => {
      await to.fill(invoice);
      await expect(note).toHaveValue('Lunch | uid:alice');
      await expect(note).toBeDisabled();
    };
    const checkManual = async () => {
      await expect(note).toHaveValue('Manual note');
      await expect(note).toBeEnabled();
    };
    await page.getByRole('button', { name: 'Add a note', exact: false }).click();
    await note.fill('Manual note');
    await checkInvoice();
    await to.fill('H');
    await checkManual();
    await page.getByTestId('pay-recipient-options').getByRole('button').first().click();
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
    await page.locator('[data-testid^="pay-recent-"]').first().click();
    await checkManual();
    // With no manual note, abandoning an invoice removes the note completely.
    await note.fill('');
    await checkInvoice();
    await to.fill('Another recipient');
    await expect(note).toHaveCount(0);
    await page.getByRole('button', { name: 'Add a note', exact: false }).click();
    await expect(note).toHaveValue('');
    await expect(note).toBeEnabled();
    await page.screenshot({ path: info.outputPath('invoice-note-cleared.png'), fullPage: true });
    expect(errors).toEqual([]);
  },
);
