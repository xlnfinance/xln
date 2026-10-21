import { Wallet } from 'ethers';

import { expect, test, type Page } from '../../global-setup.mts';
import { gotoApp } from '../../utils/e2e-demo-users';
import { requireIsolatedBaseUrl } from '../../utils/runtime/e2e-isolated-env';
import { createWalletIdentity } from '../../../ui/tests/wallet-ui';
import type { RuntimeReplica } from '../../../core/api/public/runtime-module';

const APP_BASE_URL = requireIsolatedBaseUrl('E2E_BASE_URL');
const INIT_TIMEOUT = 30_000;

async function openOwnership(page: Page): Promise<void> {
  await page.getByTestId('nav-manage').locator('visible=true').first().click();
  await page.getByTestId('manage-ownership').click();
  await expect(page.getByTestId('board')).toBeVisible({ timeout: INIT_TIMEOUT });
}

async function createOwner(page: Page): Promise<void> {
  await gotoApp(page, {
    appBaseUrl: APP_BASE_URL,
    initTimeoutMs: INIT_TIMEOUT,
    settleMs: 500,
  });
  const mnemonic = Wallet.createRandom().mnemonic;
  if (!mnemonic) throw new Error('ENTITY_OWNERSHIP_E2E_MNEMONIC_UNAVAILABLE');
  await createWalletIdentity(page, `ownership-${Date.now()}`, mnemonic.phrase);
  await openOwnership(page);
}

test(
  'Entity ownership keeps share issuance optional and separate from hub listing',
  { tag: '@functional' },
  async ({ page }, testInfo) => {
    test.setTimeout(5 * 60 * 1000);
    await createOwner(page);

    // The current wallet starts with a self-issued Entity. Registration and share
    // issuance remain separate, explicit actions; neither creates a hub listing.
    await expect(page.getByTestId('board')).toContainText(
      'Register it on the EntityProvider to issue shares or change owners.',
    );
    await expect(page.getByTestId('shares')).toHaveCount(0);
    await expect(page.getByTestId('release-shares')).toHaveCount(0);
    await expect(page.getByText(/open an Account with the chosen hub/i)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /join hub|create market|list shares/i })).toHaveCount(0);
    await expect(page.getByTestId('takeover')).toBeVisible();
    await expect(page.getByText('Take control of another entity', { exact: true })).toBeVisible();
    await expect(page.getByTestId('takeover')).toContainText(
      'Nothing to take over: no other entity in this runtime lists your signer on its board.',
    );
    await expect(page.getByTestId('takeover-propose')).toHaveCount(0);
    await expect(page.getByTestId('takeover-activate')).toHaveCount(0);

    // Use the existing real gas faucet and registration UI to observe both
    // unissued share classes. No share-release or market command is submitted.
    await page.getByTestId('nav-manage').locator('visible=true').first().click();
    await page.getByTestId('manage-assets').click();
    await page.getByTestId('faucet-gas').click();
    await expect(page.getByTestId('external-wallet')).toContainText(/(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*) ETH/, {
      timeout: 15_000,
    });
    await openOwnership(page);
    const formation = page.getByTestId('entity-formation');
    await formation.locator('summary').click();
    const name = `Ownership ${Date.now()}`;
    await page.getByTestId('formation-name').fill(name);
    await expect(page.getByTestId('formation-kind')).toHaveValue('numbered');
    await page.getByTestId('formation-submit').click();
    const result = page.getByTestId('formation-result');
    await expect(result).toContainText('Entity created', { timeout: INIT_TIMEOUT });
    const entityId = await result.getAttribute('data-entity-id');
    expect(entityId).toMatch(/^0x[0-9a-f]{64}$/);
    if (!entityId) throw new Error('REGISTERED_ENTITY_ID_MISSING');
    await page.getByTestId('nav-home').locator('visible=true').first().click();
    await page.getByTestId('entity-switcher-trigger').click();
    await page.locator(`[data-testid="entity-switcher-entity"][data-entity-id="${entityId}"]`).click();
    await openOwnership(page);
    await expect(page.getByTestId('board')).toContainText('Registered on the EntityProvider');
    await expect(page.getByTestId('shares-control')).toHaveText('not issued', { timeout: INIT_TIMEOUT });
    await expect(page.getByTestId('shares-dividend')).toHaveText('not issued');
    await expect(page.getByTestId('shares')).toContainText(
      "Mints the full CONTROL and DIVIDEND supply into this entity's Depository reserve.",
    );
    await expect(page.getByTestId('release-shares')).toBeEnabled();
    await expect(page.getByTestId('shares')).toContainText('confirmed nonce 0');
    await expect(page.getByRole('button', { name: /join hub|create market|list shares/i })).toHaveCount(0);
    const accountCount = await page.evaluate(id => {
      const env = (window as Window & { __xln?: { env(): RuntimeReplica | null } }).__xln?.env();
      const replicas = [...(env?.state.eReplicas.values() ?? [])].filter(replica => replica.entityId === id);
      if (replicas.length !== 1) throw new Error(`REGISTERED_ENTITY_REPLICA_COUNT:${replicas.length}`);
      return replicas[0]!.state.accounts.size;
    }, entityId);
    expect(accountCount, 'registration must not open or list on a hub Account').toBe(0);
    await expect(page.getByTestId('takeover-propose')).toBeDisabled();
    await expect(page.getByTestId('takeover-activate')).toBeDisabled();

    for (const viewport of [
      { name: 'iphone', width: 393, height: 852 },
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'wide', width: 1920, height: 1080 },
    ] as const) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await expect(page.getByTestId('board')).toBeVisible();
      await expect(page.getByTestId('shares')).toBeVisible();
      await expect(page.getByTestId('shares-control')).toHaveText('not issued');
      await expect(page.getByTestId('shares-dividend')).toHaveText('not issued');
      await page.screenshot({
        path: testInfo.outputPath(`entity-ownership-${viewport.name}.png`),
        animations: 'disabled',
        fullPage: true,
      });
    }
  },
);
