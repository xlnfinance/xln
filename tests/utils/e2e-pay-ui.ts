import { expect, type Page } from '@playwright/test';
import { ethers } from 'ethers';

import { getTokenInfo } from '../../runtime/account/utils';

export type UiPaymentIntent = {
  recipientEntityId: string;
  amount: bigint;
  tokenId: number;
  routeEntityIds: string[];
};

type PreparedUiPayment = {
  selectedRouteText: string;
};

export const openPayWorkspace = async (page: Page): Promise<void> => {
  const form = page.getByTestId('wallet-payment-form');
  if (!await form.isVisible().catch(() => false)) {
    const nav = page.getByTestId('wallet-nav-pay');
    await expect(nav).toBeVisible({ timeout: 20_000 });
    await nav.click();
  }
  await expect(form).toBeVisible({ timeout: 20_000 });
};

export const fillUiPaymentIntent = async (
  page: Page,
  recipientEntityId: string,
  amount: bigint,
  tokenId: number,
): Promise<void> => {
  const form = page.getByTestId('wallet-payment-form');
  const recipient = form.locator('#payment-invoice-input');
  await expect(recipient).toBeVisible({ timeout: 10_000 });
  await recipient.fill(recipientEntityId.toLowerCase());
  await form.getByTestId('wallet-payment-token').selectOption(String(tokenId));
  await form.getByTestId('payment-amount-input').fill(
    ethers.formatUnits(amount, getTokenInfo(tokenId).decimals),
  );
};

export const chooseVisibleRoute = async (
  page: Page,
  routeEntityIds: string[],
): Promise<string> => {
  const options = page.locator('.route-option');
  const expected = routeEntityIds.map(value => String(value || '').trim().toLowerCase()).filter(Boolean);
  const count = await options.count();
  expect(count, 'expected at least one canonical payment route').toBeGreaterThan(0);
  if (expected.length === 0 && count !== 1) {
    const paths = await options.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-route-path')));
    throw new Error(`ambiguous route selection without route ids: ${JSON.stringify(paths)}`);
  }
  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const path = String(await option.getAttribute('data-route-path') || '').toLowerCase().split(',').filter(Boolean);
    const exact = expected.length === 0 || path.join(',') === expected.join(',');
    const suffix = expected.length > 0 && path.length >= expected.length
      && expected.every((entityId, offset) => path[path.length - expected.length + offset] === entityId);
    if (!exact && !suffix) continue;
    await option.click();
    return String(await option.textContent() || '');
  }
  const paths = await options.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-route-path')));
  throw new Error(`no canonical payment route matched ${JSON.stringify(expected)} among ${JSON.stringify(paths)}`);
};

export const prepareUiPayment = async (
  page: Page,
  intent: UiPaymentIntent,
): Promise<PreparedUiPayment> => {
  await openPayWorkspace(page);
  for (const mode of ['direct', 'instant', 'async', 'trusted'] as const) {
    await expect(page.getByTestId(`payment-mode-${mode}`)).toBeVisible({ timeout: 10_000 });
  }
  await expect(page.getByTestId('payment-mode-instant')).toHaveAttribute('aria-checked', 'true');
  await fillUiPaymentIntent(page, intent.recipientEntityId, intent.amount, intent.tokenId);
  const findRoutes = page.getByRole('button', { name: /^Find routes$/i });
  await expect(findRoutes).toBeEnabled({ timeout: 10_000 });
  await findRoutes.click();
  await expect(page.locator('.route-option').first()).toBeVisible({ timeout: 15_000 });
  const selectedRouteText = await chooseVisibleRoute(page, intent.routeEntityIds);
  const review = page.getByRole('button', { name: 'Review payment' });
  await expect(review).toBeEnabled({ timeout: 10_000 });
  await review.click();
  await expect(page.getByTestId('wallet-payment-confirmation')).toBeVisible({ timeout: 10_000 });
  return { selectedRouteText };
};

export const expectUiPaymentNoRoute = async (
  page: Page,
  intent: UiPaymentIntent,
  expectedMessage = 'No route has enough real capacity for this amount',
): Promise<string> => {
  await openPayWorkspace(page);
  await fillUiPaymentIntent(page, intent.recipientEntityId, intent.amount, intent.tokenId);
  const findRoutes = page.getByRole('button', { name: /^Find routes$/i });
  await expect(findRoutes).toBeEnabled({ timeout: 10_000 });
  await findRoutes.click();
  const error = page.locator('.form-error').filter({ hasText: expectedMessage });
  await expect(error).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.route-option')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Review payment' })).toBeDisabled();
  return String(await error.textContent() || '');
};

export const submitUiPayment = async (
  page: Page,
  intent: UiPaymentIntent,
): Promise<PreparedUiPayment> => {
  const prepared = await prepareUiPayment(page, intent);
  const submit = page.getByRole('button', { name: 'Submit payment' });
  await expect(submit).toBeEnabled({ timeout: 10_000 });
  await submit.click();
  return prepared;
};
