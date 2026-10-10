import { expect, test } from '@playwright/test';
import { enterStack } from './stack';

test(
  'company lesson registers a real Entity, releases both share classes, then another wallet can open',
  { tag: '@functional' },
  async ({ page, context }) => {
    test.setTimeout(60_000);
    const consoleErrors: string[] = [];
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await enterStack(page);
    await page.getByTestId('nav-manage').locator('visible=true').first().click();
    await page.getByTestId('manage-assets').click();
    await page.getByTestId('faucet-gas').click();
    await expect(page.getByTestId('external-wallet')).toContainText(/0\.1(?:0+)? ETH/, { timeout: 15_000 });
    await page.getByTestId('wallet-tutorial').click();
    await page.getByTestId('tour-chapter').selectOption('company');
    await page.getByTestId('entity-formation').locator('summary').click();
    const name = `Tutorial company ${crypto.randomUUID().slice(0, 8)}`;
    await page.getByTestId('formation-name').fill(name);
    await page.getByTestId('formation-submit').click();
    const result = page.getByTestId('formation-result');
    await expect(result).toContainText('Entity created', { timeout: 15_000 });
    const entityId = await result.getAttribute('data-entity-id');
    expect(entityId).toMatch(/^0x0{55}/);
    await page.getByTestId('nav-home').locator('visible=true').first().click();
    await page.getByTestId('entity-switcher-trigger').click();
    await page.getByTestId('entity-switcher-entity').filter({ hasText: name }).click();
    await page.getByTestId('tour-chapter').selectOption('shares');
    await expect(page.getByTestId('board')).toContainText('1 of 1 voting weight');
    await page.getByTestId('release-shares').click();
    await expect(page.getByTestId('shares-control')).toHaveText('100,000,000,000', { timeout: 20_000 });
    await expect(page.getByTestId('shares-dividend')).toHaveText('100,000,000,000');
    await page.setViewportSize({ width: 1280, height: 1100 });
    await page.getByTestId('jurisdiction-banner').scrollIntoViewIfNeeded();
    await page.screenshot({ path: '../output/tutorial-company.png' });
    await page.getByTestId('nav-manage').locator('visible=true').first().click();
    await page.getByTestId('manage-assets').click();
    await expect(page.getByTestId('external-wallet')).toContainText('external NFT and share balances are not shown here');
    await expect(page.getByTestId('external-wallet')).not.toContainText('EXTERNAL_WALLET_SNAPSHOT_RPC_ERROR');
    expect(consoleErrors.filter(message => message.includes('same key'))).toEqual([]);
    // Regression: distinct ERC1155 ids at the same EP must not halt a fresh import.
    const second = await context.browser()!.newContext({ baseURL: new URL(page.url()).origin });
    try {
      await enterStack(await second.newPage());
    } finally {
      await second.close();
    }
  },
);
