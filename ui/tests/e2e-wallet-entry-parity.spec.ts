import { expect, test } from '@playwright/test';
import { readWalletIdentity } from './wallet-ui';

for (const wallet of ['svelte', 'react'] as const) {
  test(`${wallet} opens its own wallet and preserves identity after reload`, { tag: '@functional' }, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const path = wallet === 'svelte' ? '/app' : '/ui/';
    await page.goto(new URL(path, process.env['SVELTE_E2E_BASE_URL'] ?? 'http://localhost:8081').href);
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await page.getByRole('button', { name: wallet === 'svelte' ? 'Open test wallet' : 'Open a test wallet', exact: true }).click();
    const identity = page.getByTestId(wallet === 'svelte' ? 'context-current' : 'nav-home').locator('visible=true').first();
    await expect(identity).toBeVisible({ timeout: 60_000 });
    await expect(page).toHaveURL(wallet === 'svelte' ? /\/app(?:#.*)?$/ : /\/ui\/$/);
    const readIdentity = async () => wallet === 'react'
      ? await readWalletIdentity(page)
      : { runtimeId: await identity.getAttribute('data-runtime-id'), entityId: await identity.getAttribute('data-entity-id') };
    const before = await readIdentity();
    expect(before.runtimeId).toMatch(/^0x[0-9a-f]{40}$/i);
    expect(before.entityId).toMatch(/^0x[0-9a-f]{64}$/i);
    await page.reload();
    if (wallet === 'react') await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(identity).toBeVisible({ timeout: 60_000 });
    expect(await readIdentity()).toEqual(before);
    expect(errors).toEqual([]);
    await page.screenshot({ path: info.outputPath(`${wallet}-wallet.png`), fullPage: true });
  });
}
