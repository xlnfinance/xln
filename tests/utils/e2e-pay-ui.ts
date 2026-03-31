import { expect, type Page } from '@playwright/test';
import { ethers } from 'ethers';
import { openAccountWorkspaceTab } from './e2e-account-workspace';

export type UiPaymentIntent = {
  recipientEntityId: string;
  amount: bigint;
  routeEntityIds: string[];
};

type PreparedUiPayment = {
  selectedRouteText: string;
};

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function openPayWorkspace(page: Page): Promise<void> {
  await openAccountWorkspaceTab(page, 'send');
}

export async function fillUiPaymentIntent(
  page: Page,
  recipientEntityId: string,
  amount: bigint,
): Promise<void> {
  const invoiceInput = page.locator('#payment-invoice-input').first();
  const invoiceVisible = await invoiceInput.isVisible().catch(() => false);
  if (invoiceVisible) {
    await invoiceInput.click();
    await invoiceInput.fill(recipientEntityId);
  } else {
    const recipientHint = String(recipientEntityId || '').trim().slice(0, 10);
    const selectedRecipient = page
      .locator('.payment-panel button')
      .filter({ hasText: new RegExp(escapeRegex(recipientHint), 'i') })
      .first();
    await expect(selectedRecipient).toBeVisible({ timeout: 10_000 });
  }

  const amountInput = page.locator('#payment-amount-input');
  await expect(amountInput).toBeVisible({ timeout: 10_000 });
  await amountInput.click();
  await amountInput.fill(ethers.formatUnits(amount, 18));
}

export async function chooseVisibleRoute(
  page: Page,
  routeEntityIds: string[],
): Promise<string> {
  const routeOptions = page.locator('.route-option');
  const routeCount = await routeOptions.count();
  expect(routeCount, 'expected at least one visible payment route').toBeGreaterThan(0);

  const routeNeedles = routeEntityIds
    .map((hopId) => String(hopId || '').trim().toLowerCase())
    .filter((hopId) => hopId.length > 0)
    .map((hopId) => hopId.slice(0, 10));

  if (routeNeedles.length === 0) {
    if (routeCount !== 1) {
      const routeTexts = await routeOptions.evaluateAll((nodes) =>
        nodes.map((node) => String(node.textContent || '').trim()).filter((text) => text.length > 0),
      );
      throw new Error(`ambiguous route selection without route ids: ${JSON.stringify(routeTexts)}`);
    }
    const onlyRoute = routeOptions.first();
    await onlyRoute.click();
    return (await onlyRoute.textContent().catch(() => '')) || '';
  }

  for (let index = 0; index < routeCount; index += 1) {
    const option = routeOptions.nth(index);
    const text = String((await option.textContent().catch(() => '')) || '').toLowerCase();
    const matches = routeNeedles.every((needle) => text.includes(needle));
    if (!matches) continue;
    await option.click();
    return (await option.textContent().catch(() => '')) || '';
  }

  const routeTexts = await routeOptions.evaluateAll((nodes) =>
    nodes.map((node) => String(node.textContent || '').trim()).filter((text) => text.length > 0),
  );
  throw new Error(
    `no visible route matched ${JSON.stringify(routeNeedles)} among ${JSON.stringify(routeTexts)}`,
  );
}

export async function prepareUiPayment(
  page: Page,
  intent: UiPaymentIntent,
): Promise<PreparedUiPayment> {
  await openPayWorkspace(page);
  await fillUiPaymentIntent(page, intent.recipientEntityId, intent.amount);

  const findRoutesBtn = page.getByRole('button', { name: 'Find route' }).first();
  await expect(findRoutesBtn).toBeEnabled({ timeout: 10_000 });
  await findRoutesBtn.click();

  const routesPanel = page.locator('.route-option').first();
  await expect(routesPanel).toBeVisible({ timeout: 15_000 });
  const selectedRouteText = await chooseVisibleRoute(page, intent.routeEntityIds);

  const sendPaymentBtn = page.getByRole('button', { name: /Pay now/i }).first();
  await expect(sendPaymentBtn).toBeVisible({ timeout: 10_000 });
  return { selectedRouteText };
}

export async function submitUiPayment(
  page: Page,
  intent: UiPaymentIntent,
): Promise<PreparedUiPayment> {
  const prepared = await prepareUiPayment(page, intent);
  const sendPaymentBtn = page.getByRole('button', { name: /Pay now/i }).first();
  await expect(sendPaymentBtn).toBeEnabled({ timeout: 10_000 });
  await sendPaymentBtn.click();
  await page.waitForTimeout(200);
  return prepared;
}
