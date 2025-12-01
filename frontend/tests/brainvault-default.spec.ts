import { expect, test } from '@playwright/test';

test.describe('BrainVault default flow', () => {
  test('derives a vault end-to-end (real worker, 1 factor)', async ({ page }) => {
    // Allow extra time for hash-wasm download + Argon2 computation
    test.setTimeout(5 * 60 * 1000);

    await page.goto('/vault');

    await page.getByLabel('Name').fill('vault-test@example.com');
    await page.getByLabel('Password').fill('A_VeryHARDpassword123!');

    // Use the lowest factor to keep local derivation quick while still exercising the real path
    const factorSlider = page.getByLabel('Security Factor');
    await factorSlider.evaluate(el => {
      (el as HTMLInputElement).value = '1';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const deriveButton = page.getByRole('button', { name: /open vault/i });
    await expect(deriveButton).toBeEnabled({ timeout: 10_000 });
    await deriveButton.click();

    await expect(page.getByRole('heading', { name: 'Vault Opened' })).toBeVisible({ timeout: 240_000 });
    await expect(page.getByText('Ethereum Address')).toBeVisible();
    await expect(page.locator('.result-box.address code')).not.toHaveText('');
    await expect(page.locator('.result-box.address code')).toHaveText('0x0cd2Dc69a7dB56dd96F56f6bc9d528E98AE9F4DB');

    await expect(page.getByText('24-Word Mnemonic (for')).toBeVisible();
    await expect(page.getByRole('button', { name: /Derive Another Vault/i })).toBeVisible();

    // Show mnemonic
    await page.getByRole('button', { name: 'Show Mnemonic' }).click();
    await expect(page.getByRole('button', { name: 'Hide Mnemonic' })).toBeVisible();
    await expect(page.getByRole('button', { name: '📋 Copy all 24 words' })).toBeVisible();

    await expect(page.locator('.result-box.mnemonic.compact code')).toHaveText(
      'mango auction vicious sibling festival photo dirt side unlock fork only cement',
    );
  });

  test('derives a vault end-to-end (real worker, 2 factors)', async ({ page }) => {
    // Allow extra time for hash-wasm download + Argon2 computation
    test.setTimeout(5 * 60 * 1000);

    await page.goto('/vault');

    await page.getByLabel('Name').fill('vault-tes2t@example.com');
    await page.getByLabel('Password').fill('NotHardEnough!11');

    const factorSlider = page.getByLabel('Security Factor');
    await factorSlider.evaluate(el => {
      (el as HTMLInputElement).value = '2';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const deriveButton = page.getByRole('button', { name: /open vault/i });
    await expect(deriveButton).toBeEnabled({ timeout: 10_000 });
    await deriveButton.click();

    await expect(page.getByRole('heading', { name: 'Vault Opened' })).toBeVisible({ timeout: 240_000 });
    await expect(page.getByText('Ethereum Address')).toBeVisible();
    await expect(page.locator('.result-box.address code')).not.toHaveText('');
    await expect(page.locator('.result-box.address code')).toHaveText('0xD509BC4Fb97FF592c08914b73216e715ECCddF1A');

    await expect(page.getByText('24-Word Mnemonic (for')).toBeVisible();
    await expect(page.getByRole('button', { name: /Derive Another Vault/i })).toBeVisible();

    // Show mnemonic
    await page.getByRole('button', { name: 'Show Mnemonic' }).click();
    await expect(page.getByRole('button', { name: 'Hide Mnemonic' })).toBeVisible();
    await expect(page.getByRole('button', { name: '📋 Copy all 24 words' })).toBeVisible();

    await expect(page.locator('.result-box.mnemonic.compact code')).toHaveText(
      'timber blade occur maze occur depth step arch survey emerge senior skirt',
    );
  });
});
