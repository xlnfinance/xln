import { expect, test } from '@playwright/test';

test('Svelte default auto-lock reopens the same wallet without creating another identity', { tag: '@resilience' }, async ({ page }) => {
  test.setTimeout(60_000);
  await page.clock.install();
  await page.goto('/app');
  const name = `auto-lock-${crypto.randomUUID()}`;
  const secret = 'Disposable auto-lock E2E 2026!';
  await page.locator('#name').fill(name);
  await page.getByLabel('Secret passphrase', { exact: true }).fill(secret);
  await page.getByRole('button', { name: 'Derive wallet', exact: true }).click();
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  const identity = page.getByTestId('context-current');
  await expect(identity).toBeVisible();
  const runtimeId = await identity.getAttribute('data-runtime-id');
  const entityId = await identity.getAttribute('data-entity-id');
  const lease = await page.evaluate(() => {
    const vault = JSON.parse(localStorage.getItem('xln-vaults') ?? '{}');
    return { until: vault.runtimes[vault.activeRuntimeId].protectedSecrets.unlockUntil, now: Date.now(), count: Object.keys(vault.runtimes).length };
  });
  expect(lease.until - lease.now).toBeGreaterThan(540_000);
  expect(lease.until - lease.now).toBeLessThanOrEqual(600_000);
  await page.clock.fastForward(lease.until - lease.now + 1_000);
  await expect(page.getByRole('heading', { name: 'Unlock your wallet', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Create xln wallet', exact: true })).toHaveCount(0);
  await page.locator('#name').fill(name);
  await page.getByLabel('Secret passphrase', { exact: true }).fill(secret);
  await page.getByRole('button', { name: 'Unlock wallet', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Unlock your wallet', exact: true })).toHaveCount(0);
  await expect(identity).toHaveAttribute('data-runtime-id', runtimeId!);
  await expect(identity).toHaveAttribute('data-entity-id', entityId!);
  expect(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('xln-vaults') ?? '{}').runtimes).length)).toBe(lease.count);
});
