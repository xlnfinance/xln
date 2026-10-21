import { test, expect } from '../../global-setup.mts';
import { Wallet } from 'ethers';
import type { RuntimeReplica } from '../../../core/runtime/types';
import { requireIsolatedBaseUrl } from '../../utils/runtime/e2e-isolated-env';
import { createWalletIdentity, LOCAL_PASSWORD, readWalletIdentity } from '../../../ui/tests/wallet-ui';
import { timedStep } from '../../utils/e2e-timing.mts';

const APP_BASE_URL = requireIsolatedBaseUrl('E2E_BASE_URL');
const INIT_TIMEOUT = 30_000;

function randomMnemonic(): string {
  return Wallet.createRandom().mnemonic!.phrase;
}

test(
  'settings theme select updates document theme and persists selected option',
  { tag: '@functional' },
  async ({ page }) => {
    await page.goto(`${APP_BASE_URL}/app`, { waitUntil: 'domcontentloaded' });
    const identity = await createWalletIdentity(page, `theme-${Date.now()}`, randomMnemonic());
    await page.getByTestId('nav-settings').locator('visible=true').first().click();
    for (const theme of ['light', 'dark'] as const) {
      const selected = page.getByRole('button', { name: theme === 'light' ? 'Light' : 'Dark', exact: true });
      await expect(selected).toBeVisible({ timeout: 20_000 });
      await selected.click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme, { timeout: 10_000 });
      await expect(selected).toHaveClass(/active/);
      await timedStep(`theme.${theme}.reload_unlock`, async () => {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme, { timeout: 10_000 });
        await page.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: 10_000 });
        await page.getByLabel('Password', { exact: true }).fill(LOCAL_PASSWORD, { timeout: 10_000 });
        await page.getByRole('button', { name: 'Unlock', exact: true }).click({ timeout: 10_000 });
        await expect(page.getByTestId('nav-home').locator('visible=true').first()).toBeVisible({
          timeout: INIT_TIMEOUT,
        });
      });
      expect(await readWalletIdentity(page)).toEqual(identity);
      await page.getByTestId('nav-settings').locator('visible=true').first().click();
      await expect(selected).toHaveClass(/active/);
    }
  },
);

test(
  'settings toggles the xln guide without leaving the workspace',
  { tag: '@functional' },
  async ({ page }, testInfo) => {
    await page.goto(`${APP_BASE_URL}/app`, { waitUntil: 'domcontentloaded' });
    const identity = await createWalletIdentity(page, `guide-${Date.now()}`, randomMnemonic());
    await page.getByTestId('nav-settings').locator('visible=true').first().click();
    const toggle = page.getByTestId('settings-xln-mascot-toggle');
    await expect(toggle).toBeVisible({ timeout: 20_000 });
    await expect(toggle).not.toBeChecked();
    await expect(page.getByTestId('xln-mascot-root')).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath('laptop-settings-guide-default-hidden.png'),
      animations: 'disabled',
    });

    await toggle.check();
    await expect(toggle).toBeChecked();
    await expect(page.getByTestId('xln-mascot-root')).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('laptop-settings-guide-enabled.png'),
      animations: 'disabled',
    });

    const mascot = page.getByTestId('xln-mascot-root');
    const handle = page.getByTestId('xln-mascot-toggle');
    const box = await handle.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(24, 420, { steps: 12 });
    await page.mouse.up();
    await expect(mascot).toHaveAttribute('data-dock-side', 'left');
    await expect(page.getByTestId('xln-mascot-chat')).toHaveCount(0);
    await handle.click();
    const chat = page.getByTestId('xln-mascot-chat');
    await expect(chat).toContainText(/Local AI · public docs|Local AI offline/, { timeout: 10_000 });
    await expect(page.getByTestId('xln-mascot-input')).toBeFocused();
    await page.getByTestId('xln-mascot-input').press('Escape');
    await expect(chat).toHaveCount(0);
    await expect(handle).toBeFocused();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: 10_000 });
    await page.getByLabel('Password', { exact: true }).fill(LOCAL_PASSWORD, { timeout: 10_000 });
    await page.getByRole('button', { name: 'Unlock', exact: true }).click({ timeout: 10_000 });
    await expect(page.getByTestId('nav-home').locator('visible=true').first()).toBeVisible({ timeout: INIT_TIMEOUT });
    expect(await readWalletIdentity(page)).toEqual(identity);
    await page.getByTestId('nav-settings').locator('visible=true').first().click();
    await expect(mascot).toHaveAttribute('data-dock-side', 'left');
    await expect(page.getByTestId('settings-xln-mascot-toggle')).toBeChecked({ timeout: 20_000 });
    await expect(page.getByTestId('xln-mascot-root')).toBeVisible();
    await page.setViewportSize({ width: 393, height: 852 });
    await expect(page.getByTestId('settings-xln-mascot-toggle')).toBeVisible();
    await page.getByTestId('settings-xln-mascot-toggle').scrollIntoViewIfNeeded();
    const mobileToggleBox = await page.getByTestId('settings-xln-mascot-toggle').boundingBox();
    const mobileMascotBox = await page.getByTestId('xln-mascot-root').boundingBox();
    expect(mobileToggleBox).not.toBeNull();
    expect(mobileMascotBox).not.toBeNull();
    expect(
      mobileToggleBox!.x + mobileToggleBox!.width <= mobileMascotBox!.x ||
        mobileToggleBox!.x >= mobileMascotBox!.x + mobileMascotBox!.width ||
        mobileToggleBox!.y + mobileToggleBox!.height <= mobileMascotBox!.y ||
        mobileToggleBox!.y >= mobileMascotBox!.y + mobileMascotBox!.height,
      'the mobile mascot must not cover its own visibility toggle',
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath('iphone-settings-guide-visible.png'),
      animations: 'disabled',
    });
  },
);

test(
  'settings separates Runtime, Entity, Account, and J consensus heights',
  { tag: '@functional' },
  async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.goto(`${APP_BASE_URL}/app`, { waitUntil: 'domcontentloaded' });
    const identity = await createWalletIdentity(page, `consensus-${Date.now()}`, randomMnemonic());
    await page.getByTestId('nav-settings').locator('visible=true').first().click();
    await page.getByTestId('settings-consensus-tab').click();
    const consensus = page.getByTestId('settings-consensus-panel');
    await expect(consensus).toBeVisible({ timeout: 20_000 });
    await expect(consensus).toContainText('Runtime height');
    await expect(consensus).toContainText('Entity height');
    await expect(consensus).toContainText('J finalized / scanned');
    await expect(consensus).toContainText('Account machines');
    await expect(page.locator('.command-pill')).toHaveCount(0);
    await expect(page.getByTestId('settings-consensus-board')).toBeVisible();
    await expect(page.getByTestId('settings-consensus-accounts')).toBeVisible();
    await expect(page.getByTestId('settings-consensus-proposals')).toBeVisible();
    await expect(page.getByTestId('settings-consensus-hooks')).toBeVisible();
    await expect
      .poll(
        async () =>
          page.evaluate(({ entityId, signerId }) => {
            const debug = (window as Window & { __xln?: { env: () => RuntimeReplica | null } }).__xln;
            const env = debug?.env();
            if (!env || env.infrastructure?.stateMutationInFlight) return false;
            const replica = env.state.eReplicas.get(`${entityId}:${signerId}`);
            if (!replica) return false;
            const values = [
              ...document.querySelectorAll('[data-testid="settings-consensus-panel"] .consensus-summary strong'),
            ].map(element => element.textContent);
            return (
              JSON.stringify(values) ===
              JSON.stringify([
                `R${env.state.height}`,
                `E${replica.state.height}`,
                `J${replica.state.lastFinalizedJHeight} / J${replica.jHistory?.scannedThroughHeight ?? 0}`,
                String(replica.state.accounts.size),
              ])
            );
          }, identity),
        { timeout: 20_000, message: 'R/E/A/J display must match the selected committed local runtime' },
      )
      .toBe(true);

    await page.getByRole('button', { name: 'General', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Dark', exact: true })).toBeVisible();
    await page.getByTestId('settings-consensus-tab').click();
    await expect(consensus).toBeVisible();

    for (const viewport of [
      { name: 'wide', width: 1600, height: 1000 },
      { name: 'laptop', width: 1280, height: 800 },
      { name: 'iphone', width: 393, height: 852 },
    ]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await expect(consensus).toBeVisible();
      const bounds = await consensus.boundingBox();
      expect(bounds, `${viewport.name} consensus panel must have layout bounds`).not.toBeNull();
      expect(bounds!.x, `${viewport.name} consensus panel must stay in the viewport`).toBeGreaterThanOrEqual(0);
      expect(
        bounds!.x + bounds!.width,
        `${viewport.name} consensus panel must not overflow horizontally`,
      ).toBeLessThanOrEqual(viewport.width + 1);
      await page.screenshot({
        path: testInfo.outputPath(`${viewport.name}-settings-consensus.png`),
        animations: 'disabled',
        fullPage: true,
      });
    }
  },
);
