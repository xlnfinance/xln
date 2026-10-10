import { expect, test, type Page } from '@playwright/test';
import { deriveDelta } from '../../core/account/utils';
import type { RuntimeReplica } from '../../core/runtime/types';
import { safeStringify } from '../../core/protocol/serialization';

const APP = process.env['SVELTE_E2E_BASE_URL'] ?? 'http://localhost:8081/app';
const SECRET = 'Disposable recovery journey October 2026!';
const WAIT = { timeout: 15_000 };

async function account(page: Page) {
  const snapshot = await page.evaluate(() => {
    const runtime = (window as Window & { __xln?: { liveRuntimeSnapshot: RuntimeReplica } }).__xln?.liveRuntimeSnapshot;
    const entityId = document.querySelector('[data-testid="context-current"]')?.getAttribute('data-entity-id');
    const entity = runtime && [...runtime.state.eReplicas.values()].find(replica => replica.entityId === entityId);
    const entry = entity && [...entity.state.accounts.entries()][0];
    if (!runtime || !entity || !entry) throw new Error('RECOVERY_ACCOUNT_MISSING');
    const [hubId, value] = entry;
    const delta = value.state.deltas.get(1);
    if (!delta) throw new Error('RECOVERY_USDC_MISSING');
    return { runtimeId: runtime.runtimeId, entityId, hubId, height: runtime.state.height,
      accountHeight: value.currentHeight, root: value.currentFrame.accountStateRoot,
      pending: Boolean(value.pendingFrame), delta, isLeft: value.state.leftEntity === entityId };
  });
  const d = deriveDelta(snapshot.delta, snapshot.isLeft);
  return { ...snapshot, owned: d.outCollateral + d.outPeerCredit - d.inOwnCredit };
}

async function derive(page: Page, name: string) {
  await page.goto(APP);
  await page.locator('#name').fill(name);
  await page.getByLabel('Secret passphrase', { exact: true }).fill(SECRET);
  await page.getByRole('button', { name: 'Derive wallet', exact: true }).click();
}

test('Svelte restores 100 USDC on a new device and spends the recovered funds', { tag: '@resilience' }, async ({ browser }, info) => {
  test.setTimeout(60_000);
  const source = await browser.newContext();
  const target = await browser.newContext();
  const errors: string[] = [];
  try {
    const page = await source.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.addEventListener('unhandledrejection', event => console.error('RECOVERY_UNHANDLED', String(event.reason)));
    });
    const name = `restore-${crypto.randomUUID()}`;
    await derive(page, name);
    await page.locator('summary').filter({ hasText: 'Jurisdictions, initial hub and recovery services' }).click();
    await page.getByRole('button', { name: /^Backup \+ disputer/ }).click();
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await page.getByRole('button', { name: 'Accounts', exact: true }).click();
    await page.getByRole('button', { name: 'Faucet', exact: true }).first().click();
    await expect.poll(async () => (await account(page)).owned, WAIT).toBe(100_000_000n);
    const before = await account(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Recovery', exact: true }).click();
    // Live J observations keep publishing frames: backup must not wait for an idle wallet.
    await expect(page.getByTestId('recovery-coverage-tower_backup')).toHaveAttribute('data-status', 'ready', WAIT);
    await expect.poll(async () => {
      const text = await page.getByTestId('recovery-coverage-tower_backup').innerText();
      return Number(text.match(/h([\d,]+)/)?.[1]?.replaceAll(',', '') ?? 0);
    }, WAIT).toBeGreaterThanOrEqual(before.height);
    await source.close();

    const restored = await target.newPage();
    restored.on('pageerror', error => errors.push(error.message));
    await derive(restored, name);
    await restored.getByRole('button', { name: 'Restore selected backup', exact: true }).click();
    await expect(restored.getByTestId('context-current')).toBeVisible(WAIT);
    const after = await account(restored);
    expect(after.runtimeId).toBe(before.runtimeId);
    expect(after.entityId).toBe(before.entityId);
    expect(after.hubId).toBe(before.hubId);
    expect(after.root).toBe(before.root);
    expect(after.accountHeight).toBe(before.accountHeight);
    expect(after.owned).toBe(before.owned);
    await expect(restored.getByTestId('home-total')).toContainText('100.00');
    await restored.getByRole('button', { name: 'Accounts', exact: true }).click();
    await restored.getByRole('button', { name: 'Pay', exact: true }).click();
    await restored.getByPlaceholder('Name, address, or invoice').fill('H1');
    await expect(restored.getByText('Unsupported invoice format', { exact: true })).toHaveCount(0);
    await restored.getByPlaceholder('Name, address, or invoice').fill(before.hubId);
    await restored.getByTestId('payment-amount-input').fill('1');
    await expect(restored.getByRole('button', { name: 'Pay now', exact: true })).toBeDisabled();
    await restored.getByRole('button', { name: 'Find routes', exact: true }).click();
    await expect(restored.locator('.route-option').first()).toContainText(/Fee\s+[0-9.]+\s+USDC/i);
    await restored.getByTestId('payment-amount-input').fill('2');
    await expect(restored.getByRole('button', { name: 'Pay now', exact: true })).toBeDisabled();
    await restored.getByTestId('payment-amount-input').fill('1');
    await restored.getByRole('button', { name: 'Find routes', exact: true }).click();
    await expect(restored.locator('.route-option').first()).toContainText(/Fee\s+[0-9.]+\s+USDC/i);
    await restored.getByRole('button', { name: 'Pay now', exact: true }).click();
    await expect.poll(async () => (await account(restored)).owned, WAIT).toBeLessThanOrEqual(99_000_000n);
    const paid = await account(restored);
    expect(paid.owned).toBeGreaterThan(98_990_000n);
    expect(paid.root).not.toBe(before.root);
    await expect.poll(async () => (await account(restored)).pending, WAIT).toBe(false);
    await restored.reload();
    await restored.locator('button.wallet').first().click();
    await restored.getByLabel('Password', { exact: true }).fill(SECRET);
    await restored.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(restored.getByTestId('context-current')).toBeVisible(WAIT);
    await expect.poll(async () => (await account(restored)).owned, WAIT).toBe(paid.owned);
    expect(errors).toEqual([]);
    await info.attach('restored-account-and-payment', { body: safeStringify({ before, after, paid }), contentType: 'application/json' });
    await restored.screenshot({ path: info.outputPath('svelte-recovered-payment.png'), fullPage: true });
  } finally { await source.close(); await target.close(); }
});
