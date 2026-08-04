import { expect, test, type Page } from './global-setup.mts';

const screenshot = async (page: Page, testInfo: import('@playwright/test').TestInfo, name: string): Promise<void> => {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true, animations: 'disabled' });
};

test.describe('React ops scenario workspace', () => {
  test.skip(process.env['PW_REACT_OPS_CANDIDATE'] !== '1', 'requires the release-blocked React ops candidate');

  test('runs real scenario frames and suspends hidden 3D work', { tag: '@functional' }, async ({ page }, testInfo) => {
    test.setTimeout(4 * 60_000); await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/scenarios', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('ops-scenarios-page')).toBeVisible();
    await expect(page.getByTestId('scenario-status')).toContainText(/frames/, { timeout: 90_000 });
    await expect(page.getByTestId('scenario-graph')).toHaveAttribute('data-height', /\d+/);
    await expect(page.getByTestId('ops-dock-workspace')).toBeVisible();
    const graph = page.getByTestId('ops-graph-3d'); await expect(graph).toHaveAttribute('data-render-loop', 'active', { timeout: 30_000 });
    await expect(graph.locator('canvas')).toHaveCount(1); await screenshot(page, testInfo, 'ops-graph-active');
    await page.getByText('Inspector', { exact: true }).last().click();
    await expect(graph).toHaveAttribute('data-render-loop', 'stopped'); await expect(graph.locator('canvas')).toHaveCount(0); await screenshot(page, testInfo, 'ops-graph-suspended');
    await page.reload({ waitUntil: 'domcontentloaded' }); await expect(page.getByTestId('ops-dock-workspace')).toBeVisible(); await expect(page.locator('.ops-dock-panel-host')).toHaveCount(3); expect(await page.locator('canvas').count()).toBeLessThanOrEqual(1);
  });

  test('embed rejects malformed same-origin commands and accepts exact seek', { tag: '@functional' }, async ({ page }) => {
    test.setTimeout(3 * 60_000); await page.goto('/embed?scenario=hub-collapse', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('scenario-graph')).toHaveAttribute('data-height', /\d+/, { timeout: 90_000 });
    await page.evaluate(() => window.postMessage({ type: 'xln:embed:command', version: 1, command: 'seek', frame: 'bad' }, window.location.origin));
    await expect(page.getByTestId('embed-message-error')).toContainText('OPS_EMBED_FRAME_INVALID');
    await page.evaluate(() => window.postMessage({ type: 'xln:embed:command', version: 1, command: 'seek', frame: 1 }, window.location.origin));
    await expect(page.getByTestId('embed-message-error')).toHaveCount(0);
    await expect(page.locator('.ops-embed > footer output')).toContainText(/^2\//);
  });
});
