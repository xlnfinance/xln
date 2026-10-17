import { expect, type Page } from '@playwright/test';
import { ethers } from 'ethers';
import { getTokenInfo } from '../../../core/account/utils';

export type UiPaymentIntent = {
  recipientEntityId: string;
  amount: bigint;
  tokenId: number;
  routeEntityIds: string[];
};

type PreparedUiPayment = {
  selectedRouteText: string;
};

export async function openPayWorkspace(page: Page): Promise<void> {
  await page.getByTestId('nav-home').locator('visible=true').first().click();
  await page.getByTestId('home-pay').click();
  await expect(page.getByTestId('pay-to')).toBeVisible();
}

export async function fillUiPaymentIntent(
  page: Page,
  recipientEntityId: string,
  amount: bigint,
  tokenId: number,
): Promise<void> {
  await page.getByTestId('pay-to').fill(recipientEntityId);
  const amountInput = page.getByTestId('pay-amount');
  await amountInput.locator('..').getByRole('button').click();
  await page.getByRole('option', { name: new RegExp(`^${getTokenInfo(tokenId).symbol}\\b`) }).click();
  await amountInput.fill(ethers.formatUnits(amount, getTokenInfo(tokenId).decimals));
}

export async function chooseVisibleRoute(page: Page, routeEntityIds: string[]): Promise<string> {
  const quote = page.getByTestId('pay-quote');
  await expect(quote).toBeVisible();
  const expected = await page.evaluate(ids => {
    const debug = (
      window as Window & {
        __xln?: { store: { getState(): { activeEntityId: string | null } } };
      }
    ).__xln;
    const self = debug?.store.getState().activeEntityId;
    if (!self) throw new Error('CURRENT_WALLET_ENTITY_MISSING');
    const path = ids.map(id => id.toLowerCase());
    return (path[0] === self.toLowerCase() ? path : [self.toLowerCase(), ...path]).join(',');
  }, routeEntityIds);
  const routes = quote.locator('.route-card');
  if (routeEntityIds.length === 0) {
    // An omitted route must not silently choose among several quotes.
    await expect(routes).toHaveCount(0);
  } else if ((await quote.getAttribute('data-route-path')) !== expected) {
    await quote.locator('summary').click();
    const route = quote.locator(`.route-card[data-route-path="${expected}"]`);
    await expect(route).toBeVisible();
    await route.click();
  }
  if (routeEntityIds.length > 0) await expect(quote).toHaveAttribute('data-route-path', expected);
  return (await quote.locator('.hops').first().textContent()) ?? '';
}

export async function prepareUiPayment(page: Page, intent: UiPaymentIntent): Promise<PreparedUiPayment> {
  await openPayWorkspace(page);
  await fillUiPaymentIntent(page, intent.recipientEntityId, intent.amount, intent.tokenId);
  const selectedRouteText = await chooseVisibleRoute(page, intent.routeEntityIds);
  const quote = page.getByTestId('pay-quote');
  await expect(quote).toHaveAttribute('data-recipient-amount', intent.amount.toString());
  await quote.getByRole('button', { name: 'Change', exact: true }).click();
  const modes = quote.getByRole('radiogroup', { name: 'Delivery' });
  await expect(modes.getByRole('radio', { name: /^Instant/ })).toHaveAttribute('aria-checked', 'true');
  for (const name of [/^Async/, /^Direct/, /^Trusted/]) {
    await expect(modes.getByRole('radio', { name })).toHaveAttribute('aria-checked', 'false');
  }
  await expect(page.getByTestId('pay-submit')).toBeVisible();
  return { selectedRouteText };
}

export async function expectUiPaymentNoRoute(
  page: Page,
  intent: UiPaymentIntent,
  expectedMessage = 'No route has enough real capacity for this amount',
): Promise<string> {
  await openPayWorkspace(page);
  await fillUiPaymentIntent(page, intent.recipientEntityId, intent.amount, intent.tokenId);

  const error = page.getByText(expectedMessage, { exact: true });
  await expect(error).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('pay-quote')).toHaveCount(0);
  await expect(page.getByTestId('pay-submit')).toBeDisabled();
  return (await error.textContent().catch(() => '')) || '';
}

export async function submitUiPayment(
  page: Page,
  intent: UiPaymentIntent,
): Promise<PreparedUiPayment> {
  const prepared = await prepareUiPayment(page, intent);
  const sendPaymentBtn = page.getByTestId('pay-submit');
  await expect(sendPaymentBtn).toBeEnabled({ timeout: 10_000 });
  await sendPaymentBtn.click();
  await page.waitForTimeout(200);
  return prepared;
}
