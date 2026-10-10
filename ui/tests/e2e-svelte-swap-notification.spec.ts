import { expect, test, type Page } from '@playwright/test';
import { deriveDelta } from '../../core/account/utils';
import type { RuntimeReplica } from '../../core/runtime/types';

async function money(page: Page) {
  const snapshot = await page.evaluate(() => {
    const runtime = (window as Window & { __xln?: { liveRuntimeSnapshot: RuntimeReplica } }).__xln?.liveRuntimeSnapshot;
    const entityId = document.querySelector('[data-testid="context-current"]')?.getAttribute('data-entity-id');
    const entity = runtime && [...runtime.state.eReplicas.values()].find(replica => replica.state.entityId === entityId);
    const account = entity && [...entity.state.accounts.values()][0];
    if (!account || !entityId) throw new Error('SWAP_NOTIFICATION_ACCOUNT_MISSING');
    return { deltas: [...account.state.deltas], isLeft: account.state.leftEntity === entityId, offers: account.state.swapOffers.size };
  });
  const balances = new Map(snapshot.deltas.map(([token, delta]) => {
    const d = deriveDelta(delta, snapshot.isLeft);
    return [token, d.outCollateral + d.outPeerCredit - d.inOwnCredit] as const;
  }));
  return { usdc: balances.get(1) ?? 0n, weth: balances.get(2) ?? 0n, offers: snapshot.offers };
}

for (const width of [1280, 390]) test(`Svelte swap completion leaves the form usable at ${width}px`, { tag: '@functional' }, async ({ page }, info) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width, height: 860 });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/app');
  await page.locator('#name').fill(`swap-notice-${crypto.randomUUID()}`);
  await page.getByLabel('Secret passphrase', { exact: true }).fill('Disposable swap notification E2E 2026!');
  await page.getByRole('button', { name: 'Derive wallet', exact: true }).click();
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await page.getByRole('button', { name: 'Accounts', exact: true }).click();
  await page.getByRole('button', { name: 'Faucet', exact: true }).first().click();
  await expect.poll(async () => (await money(page)).usdc.toString()).toBe('100000000');
  await page.getByTestId('account-workspace-tab-swap').click();
  const ask = page.getByTestId('orderbook-ask-row').last();
  await expect(ask).toBeVisible({ timeout: 15_000 });
  await ask.click();
  await expect(page.getByTestId('swap-ticket-from-token')).toHaveValue('1');
  await expect(page.getByTestId('swap-ticket-to-token')).toHaveValue('2');
  const amount = page.getByTestId('swap-ticket-amount');
  await amount.fill('10');
  const submit = page.getByTestId('swap-ticket-submit');
  await expect(submit).toBeDisabled();
  await expect(page.getByTestId('swap-ticket-error')).toContainText('after rounding');
  await amount.fill('20');
  await expect(submit).toBeEnabled();
  await submit.click();
  const notice = page.getByTestId('swap-completion-notice');
  await expect(notice).toContainText('Swap Filled', { timeout: 15_000 });
  const after = await money(page);
  expect(after.usdc).toBeGreaterThanOrEqual(80_000_000n);
  expect(after.usdc).toBeLessThan(100_000_000n);
  expect(after.weth).toBeGreaterThan(0n);
  expect(after.offers).toBe(0);
  await expect(page.locator('dialog[open], [aria-modal="true"]')).toHaveCount(0);
  await amount.fill('7.25');
  await expect(amount).toBeFocused();
  await expect(amount).toHaveValue('7.25');
  await expect(notice).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('swap-notice-keeps-form.png'), fullPage: true, animations: 'disabled' });
  await notice.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(amount).toHaveValue('7.25');
  expect(await money(page)).toEqual(after);
  expect(errors).toEqual([]);
});
