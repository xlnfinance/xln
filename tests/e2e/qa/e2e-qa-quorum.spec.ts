import { expect, test } from '../../global-setup.mts';

test(
  'shows audited model quality and review chains across viewports',
  { tag: '@functional' },
  async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    const qaRequests: string[] = [];
    page.on('request', request => {
      if (new URL(request.url()).pathname.startsWith('/api/qa/')) qaRequests.push(new URL(request.url()).pathname);
    });
    await page.goto('/health');
    const evidence = page.getByTestId('health-qa-link-panel');
    await expect(evidence).toContainText('Production does not host QA controls.');
    await expect(evidence.getByRole('link', { name: 'Recorded checks' })).toHaveAttribute(
      'href',
      'https://github.com/xlnfinance/xln/tree/main/docs/evidence',
    );
    await evidence.getByRole('link', { name: 'Review history' }).click();
    await expect(page).toHaveURL(/\/qa\/quorum$/);

    const dashboard = page.getByTestId('quorum-dashboard');
    await expect(dashboard).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Who actually finds the bottleneck?' })).toBeVisible();
    await expect(page.getByText('Claude Fable 5', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Grok 4.6 High', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('GLM 5.3', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Claude Sonnet 5', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('DeepSeek V4', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Claude Opus 5 High', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Who challenged what' })).toBeVisible();
    await expect(page.getByText('challenged by →').first()).toBeVisible();

    const selected = page.getByTestId('quorum-selected-interaction');
    await expect(selected).toContainText('940');
    await expect(selected).toContainText('Live H1 proposal formation');

    for (const viewport of [
      { name: 'wide', width: 1600, height: 1000 },
      { name: 'laptop', width: 1280, height: 800 },
      { name: 'iphone', width: 393, height: 852 },
    ]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await expect(dashboard).toBeVisible();
      const bounds = await dashboard.boundingBox();
      if (!bounds) throw new Error(`${viewport.name} quorum dashboard has no layout bounds`);
      expect(bounds.x, `${viewport.name} quorum dashboard must stay in viewport`).toBeGreaterThanOrEqual(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
        `${viewport.name} page must not overflow`,
      ).toBeLessThanOrEqual(viewport.width);
      await page.screenshot({
        path: testInfo.outputPath(`${viewport.name}-qa-quorum.png`),
        animations: 'disabled',
        fullPage: true,
      });
    }
    expect(qaRequests, 'Health review navigation must not poll the retired production QA API').toEqual([]);
  },
);
