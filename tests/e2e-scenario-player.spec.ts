import { expect, test } from '@playwright/test';

test.describe('visual scenario player', () => {
  test('opens hub-collapse player, scrubs time, switches scenarios, and previews in wallet', async ({ page }) => {
    test.setTimeout(120_000);
    const runtimeErrors: string[] = [];
    page.on('pageerror', (error) => runtimeErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') runtimeErrors.push(message.text());
    });

    await page.goto('/scenarios');

    const player = page.getByTestId('scenario-player');
    await expect(player).toBeVisible({ timeout: 30_000 });
    await expect(player).toHaveAttribute('data-scenario-id', 'hub-collapse');
    await expect(page.getByTestId('scenario-status')).toContainText(/frames/i, { timeout: 90_000 });
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

    await page.getByTestId('scenario-select').selectOption('settle');
    await expect(player).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });
    await expect(player).toHaveAttribute('data-scenario-id', 'settle');
    await expect
      .poll(async () => page.getByTestId('scenario-node').count(), {
        timeout: 10_000,
        message: 'settle scenario should render real entities',
      })
      .toBeGreaterThan(1);

    await page.getByTestId('preview-in-wallet').click();
    await expect(page).toHaveURL(/\/app\?[^#]*scenarioPreview=1/, { timeout: 10_000 });
    await expect(page.getByTestId('scenario-preview-wallet-banner')).toBeVisible({ timeout: 10_000 });
    expect(runtimeErrors).toEqual([]);
  });
});
