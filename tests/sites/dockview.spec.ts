import type { Page } from '@playwright/test';
import { expect, test } from '../global-setup.mts';
import { APP_BASE_URL, API_BASE_URL, ensureE2EBaseline, waitForNamedHubs } from '../utils/e2e-baseline';
import { resolveRuntimeImportAppUrl } from '../utils/runtime/e2e-runtime-import';

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

type GraphCanvas = HTMLCanvasElement & { readonly xlnGraphSnapshot?: GraphSnapshot };

type RuntimeImport = { label: string; runtimeId: string };

const graphSnapshot = (page: import('@playwright/test').Page): Promise<GraphSnapshot> =>
  page.locator('.graph3d-wrapper canvas').evaluate(canvas => {
    const snapshot = (canvas as GraphCanvas).xlnGraphSnapshot;
    if (!snapshot) throw new Error('GRAPH_RENDER_SNAPSHOT_MISSING');
    return snapshot;
  });

const visibleGraphEntityPoint = async (page: Page, entityId: string): Promise<{ x: number; y: number }> => {
  const canvas = page.locator('.graph3d-wrapper canvas');
  await expect(canvas).toBeVisible();
  for (let zoom = 0; zoom <= 4; zoom += 1) {
    const point = (await graphSnapshot(page)).nodes.find(node => node.entityId === entityId)?.screen;
    expect(point, `Graph projection must contain ${entityId}`).toBeTruthy();
    if (
      point &&
      (await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.matches('.graph3d-wrapper canvas') === true,
        point,
      ))
    )
      return point;
    if (zoom === 4) break;
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    // A finite 3D projection can be outside the canvas. Use the real camera
    // gesture before clicking, otherwise the point can hit a different panel.
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.wheel(0, 500);
    await page.evaluate(
      () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
  }
  throw new Error(`GRAPH_ENTITY_NOT_VISIBLE_AFTER_ZOOM:${entityId}`);
};

const activateDockPanel = async (page: import('@playwright/test').Page, panelId: string): Promise<void> => {
  await page.evaluate(id => {
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

const waitForNetworkTimeline = async (page: Page): Promise<void> => {
  // Refresh clears its previous error synchronously; a new typed protocol failure is terminal.
  const timelineReady = await page.waitForFunction(
    () => {
      const alert = document.querySelector<HTMLElement>('.network-error');
      const error = alert?.checkVisibility() ? alert.textContent?.trim() : '';
      if (error && /^E_(BAD_PATH|BAD_QUERY|INTERNAL|UNAUTHORIZED):/.test(error)) return error;
      return /LIVE\/[1-9]\d*/.test(
        document.querySelector('[data-testid="network-machine-frame-badge"]')?.textContent || '',
      )
        ? 'ready'
        : false;
    },
    null,
    { timeout: 120_000 },
  );
  expect(await timelineReady.jsonValue()).toBe('ready');
};

test.describe('dockview', () => {
  test(
    'Dock workspace, NetworkMachine H1-H3 merge, tools, graph gestures and user return path',
    { tag: '@functional' },
    async ({ page }, testInfo) => {
      test.setTimeout(360_000);
      await page.setViewportSize({ width: 1600, height: 900 });

      const pageErrors: string[] = [];
      const consoleErrors: string[] = [];
      const serverErrors: string[] = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      page.on('console', message => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('response', response => {
        if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`);
      });

      await ensureE2EBaseline(page, { requireHubMesh: true, minHubCount: 3, timeoutMs: 180_000 });
      const hubs = await waitForNamedHubs(page, ['H1', 'H2', 'H3'], { timeoutMs: 90_000 });
      const hubIds = [hubs.h1, hubs.h2, hubs.h3].map(value => String(value || '').toLowerCase());
      expect(hubIds.every(id => /^0x[0-9a-f]{64}$/.test(id))).toBe(true);

      await page.addInitScript(() => {
        localStorage.setItem('xln-app-mode', 'dev');
        localStorage.setItem('xln-view-mode', 'panels');
        localStorage.setItem('xln-settings', JSON.stringify({ showTimeMachine: true }));
        localStorage.removeItem('xln-observer-layout');
      });

      const importUrl = await resolveRuntimeImportAppUrl(page, {
        appBaseUrl: APP_BASE_URL,
        apiBaseUrl: API_BASE_URL,
        access: 'admin',
      });
      const observerUrl = new URL(importUrl);
      observerUrl.searchParams.set('observer', '1');
      await page.goto(observerUrl.toString(), { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        () => {
          const result = sessionStorage.getItem('xln-remote-runtime-import-last-result');
          if (!result) return false;
          const parsed = JSON.parse(result) as { ok?: boolean; count?: number; failedCount?: number };
          return parsed.ok === true && Number(parsed.count || 0) >= 3 && Number(parsed.failedCount || 0) === 0;
        },
        null,
        { timeout: 150_000 },
      );
      await page.waitForFunction(
        () =>
          (window as any).__dockview_instance?.panels?.some?.((panel: { id?: string }) => panel.id === 'graph3d') ===
          true,
        null,
        { timeout: 90_000 },
      );

      const shardRuntimes = await page.evaluate(() => {
        const result = JSON.parse(sessionStorage.getItem('xln-remote-runtime-import-last-result') || '{}') as {
          entries?: RuntimeImport[];
        };
        const entries = (result.entries || []).filter(entry => /^H[123]$/i.test(entry.label));
        if (entries.length !== 3)
          throw new Error(`H1_H2_H3_IMPORTS_REQUIRED:${entries.map(entry => entry.label).join(',')}`);
        localStorage.setItem(
          'xln-network-machine-config-v1',
          JSON.stringify({
            version: 1,
            id: 'dockview-h1-h3',
            title: 'H1-H3 NetworkMachine',
            runtimeIds: entries.map(entry => entry.runtimeId),
            timelineMode: 'all-frames',
            cues: [],
          }),
        );
        return entries;
      });
      expect(shardRuntimes.map(runtime => runtime.label).sort()).toEqual(['H1', 'H2', 'H3']);

      const initialPanelIds = await page.evaluate(() =>
        (window as any).__dockview_instance.panels.map((panel: { id: string }) => panel.id),
      );
      expect(initialPanelIds).toEqual(expect.arrayContaining(['graph3d', 'architect', 'jurisdiction']));
      expect(initialPanelIds).not.toContain('wallet-main');
      await expect(page.getByTestId('network-machine-timeline')).toBeVisible();
      await page.getByTestId('network-machine-refresh').click();
      await waitForNetworkTimeline(page);
      await expect(page.getByTestId('network-machine-frame-badge')).toContainText(/LIVE\/[1-9]\d*/, {
        timeout: 120_000,
      });

      const graphBox = await page.locator('.graph3d-wrapper').boundingBox();
      expect(graphBox).not.toBeNull();
      expect(graphBox!.width).toBeGreaterThan(500);

      await selectLastNetworkFrame(page);
      await page.waitForFunction(
        expectedRuntimeIds => {
          const snapshot = document.querySelector<GraphCanvas>('.graph3d-wrapper canvas')?.xlnGraphSnapshot;
          return (
            snapshot?.sources?.length === 3 && expectedRuntimeIds.every((id: string) => snapshot.sources.includes(id))
          );
        },
        shardRuntimes.map(runtime => runtime.runtimeId),
        { timeout: 120_000 },
      );
      const merged = await graphSnapshot(page);
      expect(merged.scope).toBe('merged');
      expect(merged.sources).toHaveLength(3);
      const detached = await page.locator('.graph3d-wrapper canvas').evaluate(canvas => {
        const surface = canvas as GraphCanvas;
        const first = surface.xlnGraphSnapshot;
        if (!first || !first.nodes[0]) throw new Error('GRAPH_RENDER_SNAPSHOT_EMPTY');
        const counts = [first.sources.length, first.nodes[0].provenance.length];
        first.sources.length = 0;
        first.nodes[0].provenance.length = 0;
        const fresh = surface.xlnGraphSnapshot;
        if (!fresh || !fresh.nodes[0]) throw new Error('GRAPH_RENDER_SNAPSHOT_LOST');
        return {
          counts,
          fresh: [fresh.sources.length, fresh.nodes[0].provenance.length],
          writable: Boolean(Object.getOwnPropertyDescriptor(canvas, 'xlnGraphSnapshot')?.set),
        };
      });
      expect(detached.fresh).toEqual(detached.counts);
      expect(detached.writable).toBe(false);
      for (const hubId of hubIds)
        expect(
          merged.nodes.some(node => node.entityId === hubId),
          `Graph must show ${hubId}`,
        ).toBe(true);
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
      const h1RuntimeId = shardRuntimes.find(runtime => runtime.label === 'H1')!.runtimeId;
      await scope.selectOption(h1RuntimeId);
      await expect.poll(async () => (await graphSnapshot(page)).scope, { timeout: 90_000 }).toBe(h1RuntimeId);
      expect((await graphSnapshot(page)).sources).toEqual([h1RuntimeId]);
      await scope.selectOption('merged');
      await expect(page.getByTestId('network-machine-timeline')).toBeVisible({ timeout: 30_000 });
      await page.getByTestId('network-machine-refresh').click();
      await waitForNetworkTimeline(page);
      await expect(page.getByTestId('network-machine-frame-badge')).toContainText(/LIVE\/[1-9]\d*/, {
        timeout: 120_000,
      });
      await selectLastNetworkFrame(page);

      await page.getByTitle('Live network').click();
      await expect(page.getByTestId('network-machine-frame-badge')).toContainText(/^LIVE\//);
      const liveGraph = await graphSnapshot(page);
      const graphBounds = await page.locator('.graph3d-wrapper canvas').boundingBox();
      expect(graphBounds).not.toBeNull();
      const firstNode = liveGraph.nodes.find(
        node =>
          node.entityId === hubIds[0] &&
          node.screen &&
          node.screen.x > graphBounds!.x &&
          node.screen.x < graphBounds!.x + graphBounds!.width &&
          node.screen.y > graphBounds!.y &&
          node.screen.y < graphBounds!.y + graphBounds!.height,
      );
      expect(firstNode?.screen, 'H1 must have a clickable projected graph position').toBeTruthy();
      const panelsBefore = await page.evaluate(() => (window as any).__dockview_instance.panels.length);
      await page.mouse.click(firstNode!.screen!.x, firstNode!.screen!.y);
      await expect
        .poll(
          async () => (await graphSnapshot(page)).nodes.find(node => node.entityId === firstNode!.entityId)?.selected,
        )
        .toBe(true);
      expect(await page.evaluate(() => (window as any).__dockview_instance.panels.length)).toBe(panelsBefore);
      await page.mouse.dblclick(firstNode!.screen!.x, firstNode!.screen!.y);
      const firstPanelId = `entity-${firstNode!.entityId}`;
      await page.waitForFunction(
        ({ id, count }) => {
          const dock = (window as any).__dockview_instance;
          return (
            dock.panels.filter((panel: { id: string }) => panel.id === id).length === 1 &&
            dock.activePanel?.id === id &&
            dock.panels.length === count
          );
        },
        { id: firstPanelId, count: panelsBefore + 1 },
      );
      await expect(page.locator('[data-testid="entity-workspace"]:visible')).toBeVisible();
      await expect(page.getByTestId('entity-workspace-projection-error')).toHaveCount(0);

      await activateDockPanel(page, 'settings');
      await expect(page.getByTestId('dock-settings-panel')).toBeVisible();
      await expect(page.getByRole('button', { name: '🗄️ Storage', exact: true })).toHaveClass(/active/);
      await expect(page.getByTestId('runtime-storage-limits')).toBeVisible();
      await expect(page.getByTestId('storage-wal-gib')).toHaveAttribute('placeholder', 'Unlimited');
      await page.getByTestId('storage-wal-gib').fill('0');
      await page.getByTestId('storage-limits-save').click();
      await expect(page.getByTestId('storage-limits-error')).toContainText('positive GiB');
      await page.getByTestId('storage-wal-gib').fill('');
      await expect(page.getByTestId('leveldb-inspector')).toBeVisible();
      await page.getByRole('button', { name: 'Performance', exact: true }).click();
      await expect(page.getByTestId('runtime-performance-budgets')).toBeVisible();
      await expect(page.getByTestId('perf-reducer-ms')).toHaveAttribute('placeholder', 'Observe');
      await page.getByRole('button', { name: /Advanced/ }).click();
      await expect(page.getByTestId('network-machine-timeline-mode')).toHaveValue('all-frames');
      await expect(page.locator('.tab-style-card')).toHaveCount(6);
      await page.getByRole('button', { name: '📐 Layout', exact: true }).click();

      await activateDockPanel(page, 'graph3d');
      const secondPoint = await visibleGraphEntityPoint(page, hubIds[1]!);
      await page.mouse.dblclick(secondPoint.x, secondPoint.y);
      await expect
        .poll(
          async () =>
            page.evaluate(
              id =>
                (window as any).__dockview_instance.panels.some(
                  (panel: { id?: string }) => panel.id === `entity-${id}`,
                ),
              hubIds[1]!,
            ),
          { timeout: 90_000 },
        )
        .toBe(true);
      expect(await page.evaluate(() => (window as any).__dockview_instance.panels.length)).toBe(panelsBefore + 2);
      await activateDockPanel(page, 'graph3d');
      const repeatedPoint = await visibleGraphEntityPoint(page, firstNode!.entityId);
      await page.mouse.dblclick(repeatedPoint.x, repeatedPoint.y);
      await expect
        .poll(() => page.evaluate(() => (window as any).__dockview_instance.activePanel?.id))
        .toBe(firstPanelId);
      expect(await page.evaluate(() => (window as any).__dockview_instance.panels.length)).toBe(panelsBefore + 2);

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
      for (const panelId of [
        'architect',
        'jmachine-inspector',
        'jurisdiction',
        'runtime-io',
        'console',
        'gossip',
        'solvency',
      ]) {
        await activateDockPanel(page, panelId);
        await expect
          .poll(() =>
            page.evaluate(id => {
              const active = (window as any).__dockview_instance?.activePanel;
              return String(active?.id || active?.api?.id || '') === id;
            }, panelId),
          )
          .toBe(true);
      }
      await page.screenshot({ path: testInfo.outputPath('dockview-tools-laptop.png'), fullPage: true });

      await page.setViewportSize({ width: 390, height: 844 });
      // Reopening the same fragment URL is a same-document navigation. Verify
      // the returning user's actual document reload and persisted workspace.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('.graph3d-wrapper')).toBeVisible({ timeout: 30_000 });
      await expect.poll(async () => (await graphSnapshot(page)).nodes.length).toBeGreaterThan(0);
      const mobileGraphBox = await page.locator('.graph3d-wrapper').boundingBox();
      expect(mobileGraphBox?.width).toBeGreaterThan(360);
      expect(mobileGraphBox?.height).toBeGreaterThan(700);
      await page.screenshot({ path: testInfo.outputPath('dockview-graph-mobile.png'), fullPage: true });
      await page.getByTestId('dock-exit-user-mode').click();
      await expect(page).toHaveURL(/\/ui\/$/);
      await expect(page.locator('[data-testid="gate-stack"][data-state="online"]')).toBeVisible();
      await expect(page.getByRole('button', { name: /Restore a wallet/ })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('dockview-wallet-entry-mobile.png'), fullPage: true });

      expect(pageErrors).toEqual([]);
      expect(consoleErrors).toEqual([]);
      expect(serverErrors).toEqual([]);
    },
  );
});
