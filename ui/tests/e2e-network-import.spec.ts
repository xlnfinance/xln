/**
 * Settings → Networks on the running embedded Runtime, through the public form.
 * The dev stack's chains are both watched from startup, so the case it can prove
 * is a duplicate import of the real second chain (addresses from the stack's own
 * /api/jurisdictions): refused with its reason, nothing imported, wallet alive.
 */
import { expect, test, type Page } from '@playwright/test';
import type { RuntimeReplica } from '../../core/api/public/runtime-module';
import { enterStack } from './stack';

type DebugWindow = Window & { __xln?: { env(): RuntimeReplica | null } };
type PublishedJurisdiction = {
  name: string;
  chainId: number;
  blockTimeMs: number;
  entityProviderDeploymentBlock: number;
  contracts: { depository: string; entityProvider: string; account: string; deltaTransformer: string };
};

const SECOND_CHAIN_RPC = 'http://localhost:8546';
const SECOND_CHAIN_ID = 31_338;

const readNetworks = (page: Page) =>
  page.evaluate(() => {
    const env = (window as DebugWindow).__xln?.env();
    if (!env) throw new Error('Wallet runtime diagnostics unavailable');
    return [...env.state.jReplicas.entries()].map(([name, replica]) => ({
      name,
      chainId: Number(replica.chainId),
      depository: String(replica.contracts?.depository ?? '').toLowerCase(),
      rpcs: [...(replica.rpcs ?? [])],
    }));
  });

test(
  'Settings refuses a network that is already connected and the wallet keeps running',
  { tag: '@functional' },
  async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const catalog = (await (await page.request.get('/api/jurisdictions')).json()) as {
      jurisdictions: Record<string, PublishedJurisdiction>;
    };
    const published = Object.values(catalog.jurisdictions).find(entry => entry.chainId === SECOND_CHAIN_ID);
    if (!published) throw new Error('Stack publishes no second chain');
    await enterStack(page);
    const before = await readNetworks(page);
    // Every stack wallet already watches the second chain; importing it again is the duplicate case.
    const existing = before.find(
      network =>
        network.chainId === SECOND_CHAIN_ID && network.depository === published.contracts.depository.toLowerCase(),
    );
    if (!existing) throw new Error('Wallet does not watch the second chain at startup');

    await page.getByTestId('nav-settings').locator('visible=true').first().click();
    const networks = page.getByTestId('settings-networks');
    await networks.locator('summary').first().click();
    await networks.getByText('Add a network', { exact: true }).click();
    const fields: Record<string, string> = {
      name: `custom-${Date.now().toString(36)}`,
      rpc: SECOND_CHAIN_RPC,
      chainId: String(published.chainId),
      ticker: 'TRX',
      blockTimeMs: String(published.blockTimeMs),
      deploymentBlock: String(published.entityProviderDeploymentBlock),
    };
    for (const [key, value] of Object.entries(fields)) await page.getByTestId(`network-${key}`).fill(value);
    for (const [key, value] of Object.entries(published.contracts))
      await page.getByTestId(`network-contract-${key}`).fill(value);
    await page.getByTestId('network-connect').click();
    // Refused before the runtime sees it: same chain + Depository is the same watcher identity.
    await expect(page.getByTestId('network-notice')).toHaveText(
      `This network is already connected as ${existing.name}`,
      {
        timeout: 20_000,
      },
    );
    expect(await readNetworks(page)).toEqual(before);
    // The wallet keeps running: Home still opens and can pay.
    await page.getByTestId('nav-home').locator('visible=true').first().click();
    await expect(page.getByTestId('home-pay')).toBeEnabled();
    await expect(page.getByText(/Wallet stopped/)).toHaveCount(0);
    expect(errors).toEqual([]);
  },
);
