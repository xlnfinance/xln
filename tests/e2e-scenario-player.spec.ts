import { expect, test } from './global-setup.mts';
import { timedStep } from './utils/e2e-timing.mts';

const VIEWPORTS = [
  { label: 'iphone', width: 390, height: 844 },
  { label: 'laptop', width: 1440, height: 900 },
  { label: 'wide', width: 2560, height: 1440 },
] as const;

test.describe('visual scenario player', () => {
  test('opens hub-collapse player, scrubs time, switches scenarios, and previews in wallet', { tag: '@functional' }, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const runtimeErrors: string[] = [];
    const previewRpcRequests: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/rpc') previewRpcRequests.push(request.method());
    });
    page.on('pageerror', (error) => runtimeErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') runtimeErrors.push(message.text());
    });

    await timedStep('scenario_player.open', async () => page.goto('/scenarios'));

    const player = page.getByTestId('scenario-player');
    await expect(player).toBeVisible({ timeout: 30_000 });
    await expect(player).toHaveAttribute('data-scenario-id', 'hub-collapse');
    await timedStep('scenario_player.hub_collapse_ready', async () => {
      await expect(page.getByTestId('scenario-status')).toContainText(/frames/i, { timeout: 30_000 });
    });
    await expect(page.getByTestId('scenario-collapse-badge')).toBeVisible({ timeout: 10_000 });

    await expect
      .poll(async () => page.getByTestId('scenario-node').count(), {
        timeout: 10_000,
        message: 'scenario graph should render real entities',
      })
      .toBeGreaterThan(1);

    const frameRange = page.getByTestId('scenario-frame-range');
    await frameRange.evaluate((node) => {
      const range = node as HTMLInputElement;
      range.value = '0';
      range.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const initialFrame = Number(await frameRange.inputValue());
    await page.getByTestId('scenario-play').click();
    await expect
      .poll(async () => Number(await frameRange.inputValue()), {
        timeout: 5_000,
        message: 'playback should advance the time-machine frame',
      })
      .toBeGreaterThan(initialFrame);
    if (await page.getByTestId('scenario-pause').isVisible().catch(() => false)) {
      await page.getByTestId('scenario-pause').click();
    }

    const frameAfterPlay = Number(await frameRange.inputValue());
    await page.getByTestId('scenario-next').click();
    await expect
      .poll(async () => Number(await frameRange.inputValue()), { timeout: 5_000 })
      .toBeGreaterThan(frameAfterPlay);

    await timedStep('scenario_player.settle_ready', async () => {
      await page.getByTestId('scenario-select').selectOption('settle');
      await expect(player).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
    });
    await expect(player).toHaveAttribute('data-scenario-id', 'settle');
    await expect
      .poll(async () => page.getByTestId('scenario-node').count(), {
        timeout: 10_000,
        message: 'settle scenario should render real entities',
      })
      .toBeGreaterThan(1);

    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      await expect(player).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`${viewport.label}-settle-scenario.png`), fullPage: true });
    }

    await page.getByTestId('preview-in-wallet').click();
    await expect(page).toHaveURL(/\/app\?[^#]*scenarioPreview=1/, { timeout: 10_000 });
    await expect(page.getByTestId('scenario-preview-wallet-banner')).toBeVisible({ timeout: 10_000 });
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      await expect(page.getByTestId('scenario-preview-wallet-banner')).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`${viewport.label}-wallet-preview.png`), fullPage: true });
    }
    console.log(`[E2E-METRIC] scenario_player.rpc_requests count=${previewRpcRequests.length}`);
    expect(previewRpcRequests, 'scenario preview must use BrowserVM, never the external RPC proxy').toEqual([]);
    expect(runtimeErrors).toEqual([]);
  });
});
