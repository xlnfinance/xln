import { expect, test, type Page } from '@playwright/test';

/** Real settled-order receipt after WAL recovery; navigation never submits a transaction. */
export async function expectCrossActivity(
  page: Page,
  order: {
    entityId: string;
    orderId: string;
    status: string;
  },
) {
  const evidence = [];
  const visible = (id: string) => page.getByTestId(id).locator('visible=true').first();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 860 });
    const receipt = page.getByRole('dialog', { name: 'Receipt', exact: true });
    if (await receipt.isVisible()) await receipt.getByRole('button', { name: 'Close', exact: true }).click();
    await visible('nav-home').click();
    await visible('entity-switcher-trigger').click();
    await page.locator(`[data-testid="entity-switcher-entity"][data-entity-id="${order.entityId}"]`).click();
    await expect(visible('entity-switcher-trigger')).toHaveAttribute('data-entity-id', order.entityId);
    await visible('nav-activity').click();
    await page.getByRole('button', { name: 'Across networks', exact: true }).click();
    await visible('activity-search').fill(order.orderId);
    const row = page.getByTestId('activity-row').first();
    await expect(row).toBeVisible();
    const historicalTitle = await row.textContent();
    await row.getByRole('button').click();
    const current = visible('cross-order-current');
    await expect(current).toHaveAttribute('data-order-id', order.orderId);
    await expect(current).toHaveAttribute('data-entity-id', order.entityId);
    await expect(current).toHaveAttribute('data-status', order.status);
    await expect(current.getByTestId('cross-order-status')).toHaveText('Settled locally');
    await expect(page.getByText('Historical activity entry', { exact: true }).locator('visible=true')).toBeVisible();
    await expect(row).toHaveText(historicalTitle!);
    await test.info().attach(`cross-order-${width}`, { body: await page.screenshot(), contentType: 'image/png' });
    evidence.push({
      width,
      orderId: order.orderId,
      status: await current.getAttribute('data-status'),
      historicalTitle,
    });
  }
  return evidence;
}
