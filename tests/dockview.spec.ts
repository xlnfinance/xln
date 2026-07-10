import { expect, test } from './global-setup';
import { APP_BASE_URL, API_BASE_URL, ensureE2EBaseline, waitForNamedHubs } from './utils/e2e-baseline';
import { resolveRuntimeImportAppUrl } from './utils/e2e-runtime-import';

type GraphSnapshot = {
  scope: string;
  canonicity: string;
  sources: string[];
  nodes: Array<{
    entityId: string;
    label: string;
    provenance: string[];
    selected: boolean;
    screen: { x: number; y: number } | null;
  }>;
  accounts: Array<{ accountId: string; provenance: string[] }>;
  timeline: { runtimeId: string; height: number; timestamp: number } | null;
};

type RuntimeImport = { label: string; runtimeId: string };

const graphSnapshot = (page: import('@playwright/test').Page): Promise<GraphSnapshot> => page.evaluate(() => {
  const graph = (window as any).__xln?.graph;
  if (!graph?.snapshot) throw new Error('GRAPH_DEBUG_SURFACE_MISSING');
  return graph.snapshot();
});

const activateDockPanel = async (page: import('@playwright/test').Page, panelId: string): Promise<void> => {
  await page.evaluate((id) => {
    const dockview = (window as any).__dockview_instance;
    const panel = dockview?.panels?.find?.((candidate: { id?: string }) => candidate.id === id);
    if (!panel) throw new Error(`DOCK_PANEL_MISSING:${id}`);
    panel.api.setActive();
  }, panelId);
};

const readFrameCount = async (page: import('@playwright/test').Page): Promise<number> => {
  const text = await page.getByTestId('network-machine-frame-badge').textContent();
  const match = String(text || '').match(/\/(\d+)/);
  return Number(match?.[1] || 0);
};

const selectLastNetworkFrame = async (page: import('@playwright/test').Page): Promise<void> => {
  const scrubber = page.getByTestId('network-machine-scrubber');
  await expect(scrubber).toBeEnabled({ timeout: 90_000 });
  await scrubber.evaluate((element: HTMLInputElement) => {
    element.value = element.max;
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.getByTestId('network-machine-selected-event')).toBeVisible({ timeout: 90_000 });
};

test.describe('dockview', () => {
  test('Dock workspace, NetworkMachine H1-H3 merge, tools, graph gestures and user return path', async ({ page }, testInfo) => {
    test.setTimeout(360_000);
    await page.setViewportSize({ width: 1600, height: 900 });

    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const serverErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('response', (response) => { if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`); });

    await ensureE2EBaseline(page, { requireHubMesh: true, minHubCount: 3, timeoutMs: 180_000 });
    const hubs = await waitForNamedHubs(page, ['H1', 'H2', 'H3'], { timeoutMs: 90_000 });
    const hubIds = [hubs.h1, hubs.h2, hubs.h3].map((value) => String(value || '').toLowerCase());
    expect(hubIds.every((id) => /^0x[0-9a-f]{64}$/.test(id))).toBe(true);

    await page.addInitScript(() => {
      localStorage.setItem('xln-app-mode', 'dev');
      localStorage.setItem('xln-view-mode', 'panels');
      localStorage.setItem('xln-dock-entity-open-mode', 'replace');
      localStorage.setItem('xln-settings', JSON.stringify({ showTimeMachine: true }));
      localStorage.removeItem('xln-workspace-layout');
      localStorage.removeItem('xln-dockview-layout');
      localStorage.removeItem('dockview-layout');
    });

    const importUrl = await resolveRuntimeImportAppUrl(page, {
      appBaseUrl: APP_BASE_URL,
      apiBaseUrl: API_BASE_URL,
      access: 'read',
    });
    await page.goto(importUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const result = sessionStorage.getItem('xln-remote-runtime-import-last-result');
      if (!result) return false;
      const parsed = JSON.parse(result) as { ok?: boolean; count?: number; failedCount?: number };
      return parsed.ok === true && Number(parsed.count || 0) >= 3 && Number(parsed.failedCount || 0) === 0;
    }, null, { timeout: 150_000 });
    await page.waitForFunction(() => (window as any).__dockview_instance?.panels?.some?.((panel: { id?: string }) => panel.id === 'graph3d') === true, null, { timeout: 90_000 });

    const shardRuntimes = await page.evaluate(() => {
      const result = JSON.parse(sessionStorage.getItem('xln-remote-runtime-import-last-result') || '{}') as { entries?: RuntimeImport[] };
      const entries = (result.entries || []).filter((entry) => /^H[123]$/i.test(entry.label));
      if (entries.length !== 3) throw new Error(`H1_H2_H3_IMPORTS_REQUIRED:${entries.map((entry) => entry.label).join(',')}`);
      localStorage.setItem('xln-network-machine-config-v1', JSON.stringify({
        version: 1,
        id: 'dockview-h1-h3',
        title: 'H1-H3 NetworkMachine',
        runtimeIds: entries.map((entry) => entry.runtimeId),
        timelineMode: 'all-frames',
        cues: [],
      }));
      return entries;
    });
    expect(shardRuntimes.map((runtime) => runtime.label).sort()).toEqual(['H1', 'H2', 'H3']);

    await expect(page.locator('.xln-pinned-dock-tab')).toContainText('Main Wallet');
    await expect(page.getByTestId('network-machine-timeline')).toBeVisible();
    await page.getByTestId('network-machine-refresh').click();
    await expect(page.getByTestId('network-machine-frame-badge')).toContainText(/LIVE\/[1-9]\d*/, { timeout: 120_000 });

    const graphBox = await page.locator('.graph3d-wrapper').boundingBox();
    const walletBox = await page.locator('[data-panel-id="wallet-main"]').boundingBox();
    expect(graphBox).not.toBeNull();
    expect(walletBox).not.toBeNull();
    expect(graphBox!.x).toBeLessThan(walletBox!.x);
    expect(graphBox!.width).toBeGreaterThan(600);
    expect(walletBox!.width).toBeGreaterThan(500);

    await selectLastNetworkFrame(page);
    await page.waitForFunction((expectedRuntimeIds) => {
      const snapshot = (window as any).__xln?.graph?.snapshot?.();
      return snapshot?.sources?.length === 3 && expectedRuntimeIds.every((id: string) => snapshot.sources.includes(id));
    }, shardRuntimes.map((runtime) => runtime.runtimeId), { timeout: 120_000 });
    const merged = await graphSnapshot(page);
    expect(merged.scope).toBe('merged');
    expect(merged.sources).toHaveLength(3);
    for (const hubId of hubIds) expect(merged.nodes.some((node) => node.entityId === hubId), `Graph must show ${hubId}`).toBe(true);
    expect(merged.timeline?.runtimeId).toBeTruthy();
    await expect(page.getByTestId('network-machine-runtime-highlight')).toBeVisible();
    await expect(page.getByTestId('graph-runtime-node-summary')).toContainText(/H1/i);
    await expect(page.getByTestId('graph-runtime-node-summary')).toContainText(/H2/i);
    await expect(page.getByTestId('graph-runtime-node-summary')).toContainText(/H3/i);
    await page.screenshot({ path: testInfo.outputPath('dockview-network-machine-wide.png'), fullPage: true });

    const timelineDensity = page.getByLabel('NetworkMachine timeline density');
    const allFrameCount = await readFrameCount(page);
    await timelineDensity.selectOption('graph-changes');
    const graphFrameCount = await readFrameCount(page);
    expect(graphFrameCount).toBeGreaterThan(0);
    expect(graphFrameCount).toBeLessThanOrEqual(allFrameCount);
    await timelineDensity.selectOption('all-frames');
    expect(await readFrameCount(page)).toBe(allFrameCount);

    const canonicity = page.getByLabel('Merged graph reference policy');
    for (const policy of ['timestamp', 'height', 'left', 'right', 'hub']) {
      await canonicity.selectOption(policy);
      await expect.poll(async () => (await graphSnapshot(page)).canonicity).toBe(policy);
    }
    await canonicity.selectOption('timestamp');

    const scope = page.getByLabel('Graph runtime view');
    const h1RuntimeId = shardRuntimes.find((runtime) => runtime.label === 'H1')!.runtimeId;
    await scope.selectOption(h1RuntimeId);
    await expect.poll(async () => (await graphSnapshot(page)).scope, { timeout: 90_000 }).toBe(h1RuntimeId);
    expect((await graphSnapshot(page)).sources).toEqual([h1RuntimeId]);
    await scope.selectOption('merged');
    await expect(page.getByTestId('network-machine-timeline')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('network-machine-refresh').click();
    await expect(page.getByTestId('network-machine-frame-badge')).toContainText(/LIVE\/[1-9]\d*/, { timeout: 120_000 });
    await selectLastNetworkFrame(page);

    await page.getByTitle('Live network').click();
    await expect(page.getByTestId('network-machine-frame-badge')).toContainText(/^LIVE\//);
    const liveGraph = await graphSnapshot(page);
    const graphBounds = await page.locator('.graph3d-wrapper canvas').boundingBox();
    expect(graphBounds).not.toBeNull();
    const firstNode = liveGraph.nodes.find((node) => node.entityId === hubIds[0] && node.screen &&
      node.screen.x > graphBounds!.x && node.screen.x < graphBounds!.x + graphBounds!.width &&
      node.screen.y > graphBounds!.y && node.screen.y < graphBounds!.y + graphBounds!.height);
    expect(firstNode?.screen, 'H1 must have a clickable projected graph position').toBeTruthy();
    const panelsBefore = await page.evaluate(() => (window as any).__dockview_instance.panels.length);
    await page.mouse.click(firstNode!.screen!.x, firstNode!.screen!.y);
    await expect.poll(async () => (await graphSnapshot(page)).nodes.find((node) => node.entityId === firstNode!.entityId)?.selected).toBe(true);
    expect(await page.evaluate(() => (window as any).__dockview_instance.panels.length)).toBe(panelsBefore);
    await page.mouse.dblclick(firstNode!.screen!.x, firstNode!.screen!.y);
    await page.waitForFunction((entityId) => String((window as any).__xln?.view?.activeEntityId || '') === entityId, firstNode!.entityId, { timeout: 90_000 });
    expect(await page.evaluate(() => (window as any).__dockview_instance.panels.length)).toBe(panelsBefore);

    await activateDockPanel(page, 'settings');
    await expect(page.getByTestId('dock-settings-panel')).toBeVisible();
    await page.getByRole('button', { name: /Advanced/ }).click();
    await expect(page.getByTestId('network-machine-timeline-mode')).toHaveValue('all-frames');
    await expect(page.getByRole('button', { name: /LevelDB Inspector/ })).toBeVisible();
    await expect(page.locator('.tab-style-card')).toHaveCount(6);
    await page.getByRole('button', { name: /Layout/ }).click();
    await page.getByTestId('dock-entity-open-mode').selectOption('new-tab');

    await activateDockPanel(page, 'graph3d');
    const secondGraph = await graphSnapshot(page);
    const secondNode = secondGraph.nodes.find((node) => node.entityId === hubIds[1] && node.screen);
    expect(secondNode?.screen).toBeTruthy();
    await page.mouse.dblclick(secondNode!.screen!.x, secondNode!.screen!.y);
    await expect.poll(async () => page.evaluate((id) => (window as any).__dockview_instance.panels.some((panel: { id?: string }) => panel.id === `entity-${id}`), secondNode!.entityId), { timeout: 90_000 }).toBe(true);
    await activateDockPanel(page, 'settings');
    await page.getByRole('button', { name: /Layout/ }).click();
    await page.getByTestId('dock-entity-open-mode').selectOption('replace');

    const toolChecks: Array<[string, string | null]> = [
      ['runtime-manager', 'remote-runtime-manager'],
      ['leveldb-inspector', 'leveldb-inspector'],
      ['runtime-diagnostics', 'runtime-diagnostics-panel'],
      ['entity-audit', 'entity-audit-panel'],
      ['settings', 'dock-settings-panel'],
    ];
    for (const [panelId, testId] of toolChecks) {
      await activateDockPanel(page, panelId);
      if (testId) await expect(page.getByTestId(testId)).toBeVisible({ timeout: 30_000 });
    }
    for (const panelId of ['architect', 'jmachine-inspector', 'jurisdiction', 'runtime-io', 'console', 'gossip', 'solvency']) {
      await activateDockPanel(page, panelId);
      await expect(page.locator(`[data-panel-id="${panelId}"]`)).toBeVisible();
    }
    await page.screenshot({ path: testInfo.outputPath('dockview-tools-laptop.png'), fullPage: true });

    await page.getByTestId('dock-exit-user-mode').click();
    await expect(page.locator('.xln-pinned-dock-tab')).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId('network-machine-mode-toggle')).toContainText('Dock');
    await page.screenshot({ path: testInfo.outputPath('dockview-user-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.getByTestId('network-machine-mode-toggle').click();
    await expect(page.locator('.xln-pinned-dock-tab')).toContainText('Main Wallet', { timeout: 60_000 });
    await expect(page.getByTestId('dock-exit-user-mode')).toBeVisible();

    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(serverErrors).toEqual([]);
  });
});
