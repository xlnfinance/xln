import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HDNodeWallet } from 'ethers';
import { expect, test } from '../../../global-setup.mts';
const LOCAL_PASSWORD = 'e2e-local-wallet-password';

test(
  'canonical gateway initializes React wallet and Account worker from exact current assets',
  { tag: '@functional' },
  async ({ page }, info) => {
    const runtimePath = process.env['E2E_RUNTIME_BUNDLE_PATH'];
    if (!runtimePath) throw new Error('E2E_RUNTIME_BUNDLE_PATH_REQUIRED');
    const workers: string[] = [];
    let relayFrames = 0;
    page.on('worker', worker => workers.push(new URL(worker.url()).pathname));
    page.on('websocket', socket => {
      if (new URL(socket.url()).pathname === '/relay') socket.on('framereceived', () => relayFrames++);
    });
    await page.goto('/app');
    await expect(page).toHaveURL(/\/ui\/$/);
    const assets = [];
    for (const [url, file] of [
      ['/ui/runtime.js', 'runtime.js'],
      ['/account-worker.js', 'account-worker.js'],
    ]) {
      const response = await page.request.get(url);
      expect(response.status()).toBe(200);
      expect(response.headers()['content-type']).toMatch(/javascript/);
      const sha256 = createHash('sha256')
        .update(await response.body())
        .digest('hex');
      expect(sha256).toBe(
        createHash('sha256')
          .update(readFileSync(join(dirname(runtimePath), file)))
          .digest('hex'),
      );
      assets.push({ url, sha256 });
    }
    const phrase = HDNodeWallet.createRandom().mnemonic?.phrase;
    if (!phrase) throw new Error('TEST_WALLET_MNEMONIC_MISSING');
    await expect(page.getByTestId('gate-stack')).toHaveAttribute('data-state', 'online');
    await page.getByRole('button', { name: /Restore a wallet/ }).click();
    await page.locator('textarea').fill(phrase);
    await page.locator('button[type="submit"]').click();
    await expect(page.getByRole('heading', { name: 'Set a local password' })).toBeVisible();
    await page.getByLabel('Password', { exact: true }).fill(LOCAL_PASSWORD);
    await page.getByLabel('Confirm password', { exact: true }).fill(LOCAL_PASSWORD);
    await page.getByRole('button', { name: 'Save and open', exact: true }).click();
    await expect(page.getByTestId('account-row').first()).toBeVisible();
    expect(workers).toContain('/account-worker.js');
    expect(relayFrames).toBeGreaterThan(1);
    await page.goto('/ui/manage');
    await page.reload();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByLabel('Password', { exact: true }).fill(LOCAL_PASSWORD);
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(page.getByTestId('nav-manage').locator('visible=true')).toBeVisible();
    await info.attach('canonical-assets', {
      body: JSON.stringify({ assets, workers, relayFrames }),
      contentType: 'application/json',
    });
  },
);
