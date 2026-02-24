import { expect, test } from '@playwright/test';

test.describe('BrainVault default flow', () => {
  test('derives a vault end-to-end (real worker, 1 factor)', async ({ page }) => {
    // Allow extra time for hash-wasm download + Argon2 computation
    test.setTimeout(5 * 60 * 1000);

    await page.goto('/vault');

    await page.getByLabel('Name').fill('vault-test@example.com');
    await page.getByLabel('Password').fill('A_VeryHARDpassword123!');

    // UI now uses factor preset buttons (no slider input)
    await page.getByRole('button', { name: /^1\b/ }).click();

    const deriveButton = page.getByRole('button', { name: /open vault/i });
    await expect(deriveButton).toBeEnabled({ timeout: 10_000 });
    await deriveButton.click();

    await expect(page.getByRole('heading', { name: 'Welcome to xln' })).toBeVisible({ timeout: 240_000 });
    await expect(page.getByRole('button', { name: /continue →/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^🧭 0x/i })).toBeVisible();
  });

  test('derives a vault end-to-end (real worker, 2 factors)', async ({ page }) => {
    // Allow extra time for hash-wasm download + Argon2 computation
    test.setTimeout(5 * 60 * 1000);

    await page.goto('/vault');

    await page.getByLabel('Name').fill('vault-tes2t@example.com');
    await page.getByLabel('Password').fill('NotHardEnough!11');

    await page.getByRole('button', { name: /^2\b/ }).click();

    const deriveButton = page.getByRole('button', { name: /open vault/i });
    await expect(deriveButton).toBeEnabled({ timeout: 10_000 });
    await deriveButton.click();

    await expect(page.getByRole('heading', { name: 'Welcome to xln' })).toBeVisible({ timeout: 240_000 });
    await expect(page.getByRole('button', { name: /continue →/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^🧭 0x/i })).toBeVisible();
  });
});
