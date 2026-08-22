import { expect, test, type Locator, type Page, type TestInfo } from '../../../global-setup.mts';
import { ensureE2EBaseline, APP_BASE_URL, waitForNamedHubs } from '../../../utils/e2e-baseline';
import { connectRuntimeToHubWithCredit } from '../../../utils/e2e-connect';
import { createRuntimeIdentity, gotoApp, selectDemoMnemonic } from '../../../utils/e2e-demo-users';
import { openAccountWorkspaceTab } from '../../../utils/e2e-account-workspace';
import { capturePageScreenshot } from '../../../utils/e2e-screenshots';

const LOAD_TEST_TOKEN_IDS = [1, 2, 3] as const;
const VIEWPORTS = [
  { name: 'mobile-iphone15pro', platform: 'mobile', width: 393, height: 852 },
  { name: 'laptop', platform: 'desktop', width: 1440, height: 900 },
  { name: 'wide', platform: 'desktop', width: 2560, height: 1440 },
] as const;

const numericText = async (locator: Locator): Promise<number> => {
  const text = String(await locator.textContent() || '');
  const match = text.replaceAll(',', '').match(/-?\d+(?:\.\d+)?/);
  if (!match) throw new Error(`LOAD_TEST_METRIC_NOT_NUMERIC:${text}`);
  return Number(match[0]);
};

const metricValue = (panel: Locator, label: string): Locator =>
  panel.getByText(label, { exact: true }).locator('..').locator('strong');

async function openLoadTesting(page: Page): Promise<Locator> {
  await openAccountWorkspaceTab(page, 'configure');
  const tab = page.getByTestId('configure-tab-load-testing').first();
  await expect(tab).toBeVisible({ timeout: 20_000 });
  await tab.click();

  const panel = page.getByTestId('account-load-testing-panel').first();
  await expect(panel).toBeVisible({ timeout: 20_000 });
  return panel;
}

async function setOptionalLaneToggle(
  panel: Locator,
  lane: 'pay' | 'swap',
  enabled: boolean,
): Promise<boolean> {
  const toggle = panel.getByTestId(`load-${lane}-enabled`).first();
  if (await toggle.count() === 0) return false;

  const inputType = await toggle.getAttribute('type');
  if (inputType === 'checkbox') {
    if (enabled) await toggle.check();
    else await toggle.uncheck();
    await expect(toggle).toBeChecked({ checked: enabled });
    return true;
  }

  const isEnabled = await toggle.getAttribute('aria-pressed') === 'true';
  if (isEnabled !== enabled) await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', String(enabled));
  return true;
}

async function verifyOptionalLaneModes(panel: Locator): Promise<void> {
  const hasPayToggle = await setOptionalLaneToggle(panel, 'pay', true);
  const hasSwapToggle = await setOptionalLaneToggle(panel, 'swap', true);
  if (!hasPayToggle && !hasSwapToggle) return;

  expect(hasPayToggle, 'controller must expose both lane toggles or neither').toBe(true);
  expect(hasSwapToggle, 'controller must expose both lane toggles or neither').toBe(true);

  await setOptionalLaneToggle(panel, 'pay', true);
  await setOptionalLaneToggle(panel, 'swap', false);
  await setOptionalLaneToggle(panel, 'pay', false);
  await setOptionalLaneToggle(panel, 'swap', true);
  await setOptionalLaneToggle(panel, 'pay', true);
  await setOptionalLaneToggle(panel, 'swap', true);
}

async function captureResponsiveRunningStates(
  page: Page,
  panel: Locator,
  testInfo: TestInfo,
): Promise<void> {
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await expect(panel).toBeVisible();
    const box = await panel.boundingBox();
    if (!box) throw new Error(`${viewport.name} panel has no layout bounds`);
    expect(box.x, `${viewport.name} panel must stay inside the viewport`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `${viewport.name} panel must not overflow horizontally`)
      .toBeLessThanOrEqual(viewport.width + 1);
    expect(await panel.evaluate((root) => root.scrollWidth <= root.clientWidth + 1),
      `${viewport.name} panel contents must not overflow`).toBe(true);

    await capturePageScreenshot(page, testInfo, `${viewport.name}-accounts-load-testing-running.png`, {
      fullPage: true,
      ux: {
        title: `${viewport.name} account load testing`,
        group: 'Accounts',
        description: 'Best-effort Pay and Swap traffic with live progress, outcomes, and STP visibility.',
        platform: viewport.platform,
        tags: ['accounts', 'load-testing', 'best-effort'],
      },
    });
  }
}

test('Accounts Manage load testing is controlled, observable, best-effort, and responsive', {
  tag: '@functional',
}, async ({ page }, testInfo) => {
  test.setTimeout(180_000);

  await ensureE2EBaseline(page, {
    timeoutMs: 120_000,
    requireHubMesh: true,
    requireMarketMaker: true,
    minHubCount: 1,
  });
  const hubs = await waitForNamedHubs(page, ['H1'], { timeoutMs: 60_000 });

  await gotoApp(page, { appBaseUrl: APP_BASE_URL, initTimeoutMs: 60_000, settleMs: 500 });
  const runtime = await createRuntimeIdentity(page, 'load-testing-e2e', selectDemoMnemonic('alice'));
  await connectRuntimeToHubWithCredit(
    page,
    { entityId: runtime.entityId, signerId: runtime.signerId },
    hubs.h1,
    '10000',
    LOAD_TEST_TOKEN_IDS,
  );

  const panel = await openLoadTesting(page);
  const payRate = panel.getByTestId('load-pay-rate');
  const swapRate = panel.getByTestId('load-swap-rate');
  const duration = panel.getByTestId('load-duration');

  await expect(payRate).toHaveValue('1');
  await expect(swapRate).toHaveValue('1');
  await expect(duration).toHaveValue('10');
  await expect(panel).toContainText('$1–5 each');
  await expect(panel).toContainText('$10–15 each');
  await verifyOptionalLaneModes(panel);

  await payRate.fill('100');
  await swapRate.fill('100');
  await expect(payRate).toHaveValue('100');
  await expect(swapRate).toHaveValue('100');

  await panel.getByTestId('load-test-start').click();
  await expect(panel.getByTestId('load-test-stop')).toBeVisible();
  await expect(payRate).toBeDisabled();
  await expect(swapRate).toBeDisabled();
  await expect(duration).toBeDisabled();

  const progress = panel.getByRole('progressbar', { name: 'Load test progress' });
  await expect.poll(async () => Number(await progress.getAttribute('aria-valuenow') || '0'), {
    timeout: 15_000,
    intervals: [250, 500, 1_000],
    message: 'running load test progress must advance',
  }).toBeGreaterThan(0);
  await expect.poll(() => numericText(metricValue(panel, 'Attempted')), {
    timeout: 15_000,
    intervals: [100, 250, 500],
    message: 'load test must attempt commands',
  }).toBeGreaterThan(0);
  await expect.poll(() => numericText(metricValue(panel, 'Skipped')), {
    timeout: 20_000,
    intervals: [100, 250, 500, 1_000],
    message: 'capacity or in-flight pressure must be represented as a best-effort skip',
  }).toBeGreaterThan(0);

  await expect(metricValue(panel, 'Submitted')).toBeVisible();
  await expect(metricValue(panel, 'Failed')).toBeVisible();
  expect(await numericText(metricValue(panel, 'STP')), 'STP metric must render a finite non-negative value')
    .toBeGreaterThanOrEqual(0);

  await captureResponsiveRunningStates(page, panel, testInfo);

  await panel.getByTestId('load-test-stop').click();
  await expect(panel.getByTestId('load-test-start')).toBeVisible();
  await expect(progress).toHaveAttribute('aria-valuenow', /\d+/);
  await expect(payRate).toBeEnabled();
  await expect(swapRate).toBeEnabled();
  await expect(duration).toBeEnabled();
});
