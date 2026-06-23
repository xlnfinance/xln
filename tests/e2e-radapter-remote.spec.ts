import { expect, test } from './global-setup';
import { createHmac } from 'crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  APP_BASE_URL,
  API_BASE_URL,
  ensureE2EBaseline,
  waitForNamedHubs,
} from './utils/e2e-baseline';

const REMOTE_RUNTIME_IMPORT_RESULT_STORAGE_KEY = 'xln-remote-runtime-import-last-result';
const HUB_MESH_CREDIT_AMOUNT = '1000000000000000000000000';

type RuntimeImportManifestFile = {
  importUrl?: string;
  manifest?: {
    entries?: Array<{
      label?: string;
      access?: string;
      wsUrl?: string;
      token?: string;
    }>;
  };
};

type RuntimeImportSummary = {
  ok: boolean;
  count: number;
  entries: Array<{
    label: string;
    access: string;
    wsUrl: string;
    runtimeId: string;
    height: number;
    entityCount: number;
  }>;
};

type AdminControlProbe = {
  ok: boolean;
  latestHeight: number;
  frameHeight: number;
  envHeight: number;
  frameName: string;
  envName: string;
  accountCount: number;
  historyLength: number;
  historyHeights: number[];
  reason?: string;
  error?: string;
};

const capabilityToken = (seed: string, role: 'read' | 'full', expiresAtMs: number, rawAudience: string): string => {
  const level = role === 'read' ? 'inspect' : 'admin';
  const audience = String(rawAudience || 'xln-runtime').toLowerCase();
  const keyId = 'e2e';
  const tokenId = `e2e-${expiresAtMs}`;
  const signature = createHmac('sha256', seed)
    .update(`xln-radapter-v1:cap:${level}:${expiresAtMs}:${audience}:${keyId}:${tokenId}`)
    .digest('hex');
  return [
    'xlnra1',
    role,
    String(expiresAtMs),
    Buffer.from(audience, 'utf8').toString('base64url'),
    Buffer.from(keyId, 'utf8').toString('base64url'),
    Buffer.from(tokenId, 'utf8').toString('base64url'),
    signature,
  ].join('.');
};

const readAdminControlProbe = async (
  page: import('@playwright/test').Page,
  args: { hubId: string; minHeight: number; expectedName: string },
): Promise<AdminControlProbe> => {
  return await page.evaluate(async ({ hubId, minHeight, expectedName }) => {
    try {
      const view = window as typeof window & {
        isolatedEnv?: {
          height?: number;
          history?: Array<{ height?: number }>;
          eReplicas?: Map<string, { entityId?: string; state?: { profile?: { name?: string }; accounts?: Map<string, unknown> } }>;
        };
        __xlnRuntimeAdapter?: {
          read: <T = unknown>(path: string, query?: Record<string, unknown>) => Promise<T>;
        };
      };
      const adapter = view.__xlnRuntimeAdapter;
      if (!adapter) return {
        ok: false,
        latestHeight: 0,
        frameHeight: 0,
        envHeight: 0,
        frameName: '',
        envName: '',
        accountCount: 0,
        historyLength: 0,
        historyHeights: [],
        reason: 'adapter-missing',
      };
      type Head = { latestHeight?: number };
      type ViewFrame = {
        height?: number;
        activeEntity?: { core?: { profile?: { name?: string } } } | null;
      };
      const head = await adapter.read<Head>('head');
      const latestHeight = Number(head.latestHeight || 0);
      const frame = latestHeight > minHeight
        ? await adapter.read<ViewFrame>('view-frame', {
            atHeight: latestHeight,
            entityId: hubId,
            accountsLimit: 1,
            booksLimit: 1,
          })
        : null;
      const env = view.isolatedEnv;
      const replicas = Array.from(env?.eReplicas?.values?.() ?? []);
      const replica = replicas.find((entry) => String(entry.entityId || '').toLowerCase() === hubId);
      const history = env?.history ?? [];
      const frameName = String(frame?.activeEntity?.core?.profile?.name || '');
      const envName = String(replica?.state?.profile?.name || '');
      const envHeight = Number(env?.height || 0);
      const frameHeight = Number(frame?.height || 0);
      const ok = latestHeight > minHeight &&
        frameName === expectedName &&
        envHeight >= latestHeight &&
        envName === expectedName;
      return {
        ok,
        latestHeight,
        frameHeight,
        envHeight,
        frameName,
        envName,
        accountCount: Number(replica?.state?.accounts?.size || 0),
        historyLength: history.length,
        historyHeights: history.map((item) => Number(item.height || 0)),
        ...(ok ? {} : { reason: 'not-ready' }),
      };
    } catch (error) {
      return {
        ok: false,
        latestHeight: 0,
        frameHeight: 0,
        envHeight: 0,
        frameName: '',
        envName: '',
        accountCount: 0,
        historyLength: 0,
        historyHeights: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, args);
};

const waitForAdminControlProbe = async (
  page: import('@playwright/test').Page,
  args: { hubId: string; minHeight: number; expectedName: string },
  timeoutMs = 90_000,
): Promise<AdminControlProbe> => {
  const startedAt = Date.now();
  let lastProbe: AdminControlProbe | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastProbe = await readAdminControlProbe(page, args);
    if (lastProbe.ok) return lastProbe;
    await page.waitForTimeout(50);
  }
  throw new Error(`REMOTE_ADMIN_CONTROL_STATE_TIMEOUT:${JSON.stringify(lastProbe)}`);
};

const hubRpcUrl = (hubOffset: number): string => {
  const api = new URL(API_BASE_URL);
  const port = Number(api.port);
  if (!Number.isFinite(port) || port <= 0) throw new Error(`E2E_API_BASE_URL must include a port: ${API_BASE_URL}`);
  return `ws://localhost:${port + hubOffset}/rpc`;
};

const runtimeImportManifestPath = (): string =>
  process.env.E2E_RUNTIME_IMPORT_MANIFEST_PATH
    ? resolve(process.env.E2E_RUNTIME_IMPORT_MANIFEST_PATH)
    : resolve(process.cwd(), 'db/dev/mesh/runtime-import-manifest.json');

const readRuntimeImportUrl = async (page: import('@playwright/test').Page, timeoutMs = 60_000): Promise<string> => {
  const manifestPath = runtimeImportManifestPath();
  const startedAt = Date.now();
  let lastError = '';
  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (existsSync(manifestPath)) {
        const payload = JSON.parse(readFileSync(manifestPath, 'utf8')) as RuntimeImportManifestFile;
        const importUrl = String(payload.importUrl || '').trim();
        const entries = payload.manifest?.entries ?? [];
        if (importUrl && entries.length >= 5) return importUrl;
        lastError = `manifest incomplete count=${entries.length} importUrl=${importUrl ? 'yes' : 'no'}`;
      } else {
        lastError = `manifest missing: ${manifestPath}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`Runtime import manifest not ready: ${lastError}`);
};

const readRuntimeImportSummary = async (
  page: import('@playwright/test').Page,
  timeoutMs = 30_000,
): Promise<RuntimeImportSummary> => {
  const startedAt = Date.now();
  let lastError = '';
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const summary = await page.evaluate((storageKey) => {
        const raw = sessionStorage.getItem(storageKey);
        if (!raw) throw new Error('REMOTE_RUNTIME_IMPORT_SUMMARY_MISSING');
        return JSON.parse(raw) as RuntimeImportSummary;
      }, REMOTE_RUNTIME_IMPORT_RESULT_STORAGE_KEY);
      if (summary.ok === true) return summary;
      lastError = `summary not ok: ${JSON.stringify(summary)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await page.waitForLoadState('domcontentloaded', { timeout: 1_000 }).catch(() => undefined);
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`REMOTE_RUNTIME_IMPORT_SUMMARY_TIMEOUT:${lastError}`);
};

const expectMarketMakerBooksHealthy = (health: Awaited<ReturnType<typeof ensureE2EBaseline>>): void => {
  const marketMaker = health.marketMaker;
  expect(marketMaker?.enabled, `market maker must be enabled: ${JSON.stringify(marketMaker ?? {})}`).toBe(true);
  expect(marketMaker?.ok, `market maker must be ready: ${JSON.stringify(marketMaker ?? {})}`).toBe(true);
  expect(marketMaker?.hubs?.length ?? 0, 'MM must publish books for all hubs').toBeGreaterThanOrEqual(3);
  for (const hub of marketMaker?.hubs ?? []) {
    expect(hub.ready, `MM hub ${hub.hubEntityId} ready`).toBe(true);
    expect(hub.offers, `MM hub ${hub.hubEntityId} offers`).toBeGreaterThan(0);
    for (const pair of hub.pairs ?? []) {
      expect(pair.ready, `MM pair ${pair.pairId} ready`).toBe(true);
      expect(pair.offers, `MM pair ${pair.pairId} offers`).toBeGreaterThan(0);
    }
  }
  expect(marketMaker?.cross?.ok, `cross MM books must be ready: ${JSON.stringify(marketMaker?.cross ?? {})}`).toBe(true);
};

test.setTimeout(240_000);

test('remote /app opens an existing hub runtime through radapter', async ({ page }) => {
  await ensureE2EBaseline(page, { requireHubMesh: true, minHubCount: 3 });
  const hubs = await waitForNamedHubs(page, ['h1'], { apiBaseUrl: API_BASE_URL });
  const h1 = String(hubs.h1 || '').toLowerCase();
  expect(h1).toMatch(/^0x[0-9a-f]{64}$/);

  const wsUrl = hubRpcUrl(10);
  const hubInfoResponse = await page.request.get(`http://127.0.0.1:${Number(new URL(API_BASE_URL).port) + 10}/api/info`);
  expect(hubInfoResponse.ok()).toBe(true);
  const hubInfo = await hubInfoResponse.json().catch(() => ({}));
  const audience = String(hubInfo.runtimeId || '').toLowerCase();
  expect(audience.length).toBeGreaterThan(0);
  const key = capabilityToken('xln-e2e-h1', 'full', Date.now() + 60 * 60 * 1_000, audience);
  const url = `${APP_BASE_URL}/app?runtime=remote&ws=${encodeURIComponent(wsUrl)}&token=${encodeURIComponent(key)}#accounts`;

  await page.goto(url, { waitUntil: 'domcontentloaded' });

  const remotePrompt = page.getByTestId('remote-runtime-login-screen');
  await expect(remotePrompt).not.toBeVisible({ timeout: 10_000 });

  await page.waitForFunction(
    ({ hubId, expectedRuntimePrefix }) => {
      const view = window as typeof window & {
        isolatedEnv?: {
          runtimeId?: string;
          eReplicas?: Map<string, {
            entityId?: string;
            state?: {
              profile?: { isHub?: boolean; name?: string };
              accounts?: Map<string, unknown>;
            };
          }>;
        };
      };
      const env = view.isolatedEnv;
      if (!env || !String(env.runtimeId || '').startsWith(expectedRuntimePrefix)) return false;
      const replicas = Array.from(env.eReplicas?.values?.() ?? []);
      return replicas.some((replica) =>
        String(replica.entityId || '').toLowerCase() === hubId &&
        replica.state?.profile?.isHub === true,
      );
    },
    { hubId: h1, expectedRuntimePrefix: `radapter:${wsUrl}` },
    { timeout: 60_000 },
  );

  const snapshot = await page.evaluate((hubId) => {
    const view = window as typeof window & {
      isolatedEnv?: {
        runtimeId?: string;
        height?: number;
        eReplicas?: Map<string, {
          entityId?: string;
          state?: {
            profile?: { isHub?: boolean; name?: string };
            accounts?: Map<string, unknown>;
          };
        }>;
      };
    };
    const env = view.isolatedEnv;
    const replicas = Array.from(env?.eReplicas?.values?.() ?? []);
    const hub =
      replicas.find((replica) =>
        String(replica.entityId || '').toLowerCase() === hubId &&
        replica.state?.profile?.isHub === true,
      ) ??
      replicas.find((replica) => String(replica.entityId || '').toLowerCase() === hubId);
    return {
      runtimeId: String(env?.runtimeId || ''),
      height: Number(env?.height || 0),
      replicaCount: replicas.length,
      hubName: String(hub?.state?.profile?.name || ''),
      hubIsHub: hub?.state?.profile?.isHub === true,
      accountCount: Number(hub?.state?.accounts?.size || 0),
      loginText: document.body.textContent || '',
    };
  }, h1);

  expect(snapshot.runtimeId).toBe(`radapter:${wsUrl}`);
  expect(snapshot.height).toBeGreaterThan(0);
  expect(snapshot.replicaCount).toBeGreaterThan(0);
  expect(snapshot.hubIsHub).toBe(true);
  expect(snapshot.hubName.toLowerCase()).toContain('h1');
  expect(snapshot.accountCount).toBeLessThanOrEqual(10);
  expect(/quick login/i.test(snapshot.loginText)).toBe(false);
  await expect(page.getByTestId('context-current')).not.toContainText(/no runtime selected/i);
  await expect(page.getByRole('button', { name: /^H1$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^H2$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^H3$/ })).toBeVisible();
});

test('health admin keeps QA evidence link-only and runtime adapter local', async ({ page }) => {
  await ensureE2EBaseline(page, { requireHubMesh: true, minHubCount: 3 });
  const apiPort = Number(new URL(API_BASE_URL).port);
  const wsUrl = hubRpcUrl(10);
  const hubInfoResponse = await page.request.get(`http://127.0.0.1:${apiPort + 10}/api/info`);
  expect(hubInfoResponse.ok()).toBe(true);
  const hubInfo = await hubInfoResponse.json().catch(() => ({}));
  const audience = String(hubInfo.runtimeId || '').toLowerCase();
  expect(audience.length).toBeGreaterThan(0);
  const readKey = capabilityToken('xln-e2e-h1', 'read', Date.now() + 60 * 60 * 1_000, audience);
  const qaApiRequests: string[] = [];
  await page.route('**/api/qa/**', async (route) => {
    qaApiRequests.push(route.request().url());
    await route.abort('blockedbyclient');
  });

  await page.goto(`${API_BASE_URL}/health`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toContainText('xln health admin', { timeout: 30_000 });
  await expect(page.locator('#bootstrap')).toBeVisible({ timeout: 30_000 });
  const cockpitPanel = page.locator('#qa-cockpit');
  await expect(cockpitPanel).toBeVisible();
  await expect(cockpitPanel).toContainText('QA Evidence');
  await expect(cockpitPanel.getByRole('link', { name: 'Open QA cockpit' })).toHaveAttribute('href', '/qa');
  await expect(cockpitPanel.getByRole('link', { name: 'UX gallery' })).toHaveAttribute('href', '/qa');
  await expect(page.locator('#qa-runs')).toHaveCount(0);
  await expect(page.locator('iframe[title="QA Cockpit"]')).toHaveCount(0);
  expect(qaApiRequests, '/health must not read /api/qa; QA cockpit owns that surface').toEqual([]);
  await expect(page.locator('#runtime-adapter')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open inspector' })).toHaveAttribute('href', '/radapter');

  const adapterPanel = page.locator('#runtime-adapter');
  await adapterPanel.locator('input[placeholder="ws://127.0.0.1:8080/rpc"]').fill(wsUrl);
  await adapterPanel.locator('input[placeholder="read/admin token"]').fill(readKey);
  await adapterPanel.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(adapterPanel).toContainText('connected', { timeout: 30_000 });
  await expect(adapterPanel).toContainText('inspect', { timeout: 30_000 });
  await page.waitForFunction(() => {
    const panel = document.querySelector('#runtime-adapter');
    const text = panel?.textContent || '';
    return /Entities\s+[1-9]/.test(text) && /Latest\s+[1-9]/.test(text);
  }, null, { timeout: 30_000 });

  await page.goto(`${API_BASE_URL}/radapter?ws=${encodeURIComponent(wsUrl)}&token=${encodeURIComponent(readKey)}`, {
    waitUntil: 'domcontentloaded',
  });
  await expect(page.getByRole('heading', { name: 'Runtime Adapter Inspector' })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#runtime-adapter')).toContainText('connected', { timeout: 30_000 });
  await expect(page.locator('#runtime-adapter')).toContainText('inspect', { timeout: 30_000 });
  await page.waitForFunction(() => {
    const panel = document.querySelector('#runtime-adapter');
    const text = panel?.textContent || '';
    return /Entities\s+[1-9]/.test(text) && /Latest\s+[1-9]/.test(text);
  }, null, { timeout: 30_000 });

  await page.goto(`${API_BASE_URL}/admin`, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/health$/);
  await expect(page.getByRole('heading', { name: 'xln health admin' })).toBeVisible({ timeout: 30_000 });
});

test('admin remote runtime control advances live state and exposes past frames', async ({ page }) => {
  await ensureE2EBaseline(page, { requireHubMesh: true, minHubCount: 3 });
  const hubs = await waitForNamedHubs(page, ['h1'], { apiBaseUrl: API_BASE_URL });
  const h1 = String(hubs.h1 || '').toLowerCase();
  expect(h1).toMatch(/^0x[0-9a-f]{64}$/);

  const apiPort = Number(new URL(API_BASE_URL).port);
  const wsUrl = hubRpcUrl(10);
  const hubInfoResponse = await page.request.get(`http://127.0.0.1:${apiPort + 10}/api/info`);
  expect(hubInfoResponse.ok()).toBe(true);
  const hubInfo = await hubInfoResponse.json().catch(() => ({}));
  const audience = String(hubInfo.runtimeId || '').toLowerCase();
  expect(audience.length).toBeGreaterThan(0);

  const adminKey = capabilityToken('xln-e2e-h1', 'full', Date.now() + 60 * 60 * 1_000, audience);
  await page.goto(`${APP_BASE_URL}/app?runtime=remote&ws=${encodeURIComponent(wsUrl)}&token=${encodeURIComponent(adminKey)}#accounts`, {
    waitUntil: 'domcontentloaded',
  });

  await page.waitForFunction(
    ({ expectedRuntimeId, hubId }) => {
      const view = window as typeof window & {
        isolatedEnv?: {
          runtimeId?: string;
          height?: number;
          eReplicas?: Map<string, { entityId?: string; state?: { profile?: { isHub?: boolean } } }>;
        };
      };
      const env = view.isolatedEnv;
      if (String(env?.runtimeId || '') !== expectedRuntimeId || Number(env?.height || 0) < 1) return false;
      const replicas = Array.from(env?.eReplicas?.values?.() ?? []);
      return replicas.some((replica) =>
        String(replica.entityId || '').toLowerCase() === hubId &&
        replica.state?.profile?.isHub === true,
      );
    },
    { expectedRuntimeId: `radapter:${wsUrl}`, hubId: h1 },
    { timeout: 60_000 },
  );

  const before = await page.evaluate((hubId) => {
    const view = window as typeof window & {
      isolatedEnv?: {
        height?: number;
        history?: Array<{ height?: number }>;
        eReplicas?: Map<string, {
          entityId?: string;
          signerId?: string;
          state?: {
            profile?: { name?: string; isHub?: boolean };
            accounts?: Map<string, unknown>;
          };
        }>;
      };
    };
    const env = view.isolatedEnv;
    const replicas = Array.from(env?.eReplicas?.values?.() ?? []);
    const replica = replicas.find((entry) => String(entry.entityId || '').toLowerCase() === hubId);
    return {
      height: Number(env?.height || 0),
      historyLength: Number(env?.history?.length || 0),
      historyHeights: (env?.history ?? []).map((frame) => Number(frame.height || 0)),
      signerId: String(replica?.signerId || ''),
      profileName: String(replica?.state?.profile?.name || ''),
      isHub: replica?.state?.profile?.isHub === true,
      accountCount: Number(replica?.state?.accounts?.size || 0),
    };
  }, h1);

  expect(before.height).toBeGreaterThan(0);
  expect(before.historyLength).toBeGreaterThan(0);
  expect(before.historyLength).toBeLessThanOrEqual(12);
  expect(before.historyHeights).toContain(before.height);
  expect(before.isHub).toBe(true);
  expect(before.accountCount).toBeLessThanOrEqual(10);

  const activeH1Before = await page.evaluate(async (entityId) => {
    const adapter = (window as typeof window & {
      __xlnRuntimeAdapter?: {
        read: <T = unknown>(path: string, query?: Record<string, unknown>) => Promise<T>;
      };
    }).__xlnRuntimeAdapter;
    if (!adapter) throw new Error('XLN_RUNTIME_ADAPTER_DEBUG_SURFACE_MISSING');
    type ViewFrame = {
      height?: number;
      activeEntity?: {
        core?: { signerId?: string; profile?: { name?: string; isHub?: boolean } };
        accounts?: { items?: unknown[] };
        books?: { items?: unknown[] };
      } | null;
    };
    const frame = await adapter.read<ViewFrame>('view-frame', {
      entityId,
      accountsLimit: 10,
      booksLimit: 10,
    });
    return {
      height: Number(frame.height || 0),
      signerId: String(frame.activeEntity?.core?.signerId || ''),
      profileName: String(frame.activeEntity?.core?.profile?.name || ''),
      isHub: frame.activeEntity?.core?.profile?.isHub === true,
      accountCount: Number(frame.activeEntity?.accounts?.items?.length || 0),
      bookCount: Number(frame.activeEntity?.books?.items?.length || 0),
    };
  }, h1);

  expect(activeH1Before.height).toBeGreaterThan(0);
  expect(activeH1Before.signerId.length).toBeGreaterThan(0);
  expect(activeH1Before.isHub).toBe(true);
  expect(activeH1Before.accountCount).toBeLessThanOrEqual(10);
  expect(activeH1Before.bookCount).toBeLessThanOrEqual(10);

  const baseName = `H1 Admin E2E ${activeH1Before.height + 1}`;
  const nextProfileName = activeH1Before.profileName === baseName ? `${baseName}b` : baseName;
  const controlResult = await page.evaluate(async ({ entityId, signerId, name, timestamp }) => {
    const adapter = (window as typeof window & {
      __xlnRuntimeAdapter?: {
        read: <T = unknown>(path: string, query?: Record<string, unknown>) => Promise<T>;
        send: (input: unknown) => Promise<{ height: number }>;
      };
    }).__xlnRuntimeAdapter;
    if (!adapter) throw new Error('XLN_RUNTIME_ADAPTER_DEBUG_SURFACE_MISSING');
    const head = await adapter.read<{ latestHeight?: number }>('head');
    const sent = await adapter.send({
      runtimeTxs: [],
      entityInputs: [{
        entityId,
        signerId,
        timestamp,
        entityTxs: [{
          type: 'profile-update',
          data: {
            profile: {
              entityId,
              name,
              avatar: '',
              bio: 'admin-e2e-control',
              website: '',
            },
          },
        }],
      }],
      timestamp,
    });
    return {
      beforeHeight: Number(head.latestHeight || 0),
      sendHeight: Number(sent.height || 0),
    };
  }, {
    entityId: h1,
    signerId: activeH1Before.signerId,
    name: nextProfileName,
    timestamp: 1_700_000_000_000 + activeH1Before.height,
  });

  expect(controlResult.beforeHeight).toBeGreaterThanOrEqual(activeH1Before.height);
  expect(controlResult.sendHeight).toBeGreaterThanOrEqual(controlResult.beforeHeight);

  const after = await waitForAdminControlProbe(
    page,
    { hubId: h1, minHeight: controlResult.beforeHeight, expectedName: nextProfileName },
    90_000,
  );

  expect(after.envHeight).toBeGreaterThan(controlResult.beforeHeight);
  expect(after.envName).toBe(nextProfileName);
  expect(after.accountCount).toBeLessThanOrEqual(10);
  expect(after.historyLength).toBeGreaterThanOrEqual(2);
  expect(after.historyLength).toBeLessThanOrEqual(12);
  expect(after.historyHeights).toContain(controlResult.beforeHeight);
  expect(after.historyHeights).toContain(after.envHeight);

  const frameProbe = await page.evaluate(async ({ entityId, beforeHeight, afterHeight }) => {
    const adapter = (window as typeof window & {
      __xlnRuntimeAdapter?: {
        read: <T = unknown>(path: string, query?: Record<string, unknown>) => Promise<T>;
      };
    }).__xlnRuntimeAdapter;
    if (!adapter) throw new Error('XLN_RUNTIME_ADAPTER_DEBUG_SURFACE_MISSING');
    type ViewFrame = {
      height?: number;
      activeEntity?: {
        core?: { profile?: { name?: string } };
        accounts?: { items?: unknown[] };
        books?: { items?: unknown[] };
      } | null;
    };
    const beforeFrame = await adapter.read<ViewFrame>('view-frame', {
      atHeight: beforeHeight,
      entityId,
      accountsLimit: 1,
      booksLimit: 1,
    });
    const afterFrame = await adapter.read<ViewFrame>('view-frame', {
      atHeight: afterHeight,
      entityId,
      accountsLimit: 1,
      booksLimit: 1,
    });
    return {
      beforeHeight: Number(beforeFrame.height || 0),
      afterHeight: Number(afterFrame.height || 0),
      beforeName: String(beforeFrame.activeEntity?.core?.profile?.name || ''),
      afterName: String(afterFrame.activeEntity?.core?.profile?.name || ''),
      beforeAccounts: Number(beforeFrame.activeEntity?.accounts?.items?.length || 0),
      afterAccounts: Number(afterFrame.activeEntity?.accounts?.items?.length || 0),
      beforeBooks: Number(beforeFrame.activeEntity?.books?.items?.length || 0),
      afterBooks: Number(afterFrame.activeEntity?.books?.items?.length || 0),
    };
  }, {
    entityId: h1,
    beforeHeight: controlResult.beforeHeight,
    afterHeight: after.envHeight,
  });

  expect(frameProbe.beforeHeight).toBe(controlResult.beforeHeight);
  expect(frameProbe.afterHeight).toBe(after.envHeight);
  expect(frameProbe.beforeName).toBe(activeH1Before.profileName);
  expect(frameProbe.beforeName).not.toBe(nextProfileName);
  expect(frameProbe.afterName).toBe(nextProfileName);
  expect(frameProbe.beforeAccounts).toBeLessThanOrEqual(1);
  expect(frameProbe.afterAccounts).toBeLessThanOrEqual(1);
  expect(frameProbe.beforeBooks).toBeLessThanOrEqual(1);
  expect(frameProbe.afterBooks).toBeLessThanOrEqual(1);
});

test('runtime dropdown manager attaches a remote radapter by token', async ({ page }) => {
  await ensureE2EBaseline(page, { requireHubMesh: true, minHubCount: 3 });
  const apiPort = Number(new URL(API_BASE_URL).port);
  const h1WsUrl = hubRpcUrl(10);
  const h2WsUrl = hubRpcUrl(11);
  const h1InfoResponse = await page.request.get(`http://127.0.0.1:${apiPort + 10}/api/info`);
  const h2InfoResponse = await page.request.get(`http://127.0.0.1:${apiPort + 11}/api/info`);
  expect(h1InfoResponse.ok()).toBe(true);
  expect(h2InfoResponse.ok()).toBe(true);
  const h1Info = await h1InfoResponse.json().catch(() => ({}));
  const h2Info = await h2InfoResponse.json().catch(() => ({}));
  const h1Audience = String(h1Info.runtimeId || '').toLowerCase();
  const h2Audience = String(h2Info.runtimeId || '').toLowerCase();
  expect(h1Audience.length).toBeGreaterThan(0);
  expect(h2Audience.length).toBeGreaterThan(0);

  const h1Key = capabilityToken('xln-e2e-h1', 'read', Date.now() + 60 * 60 * 1_000, h1Audience);
  const h2Key = capabilityToken('xln-e2e-h2', 'read', Date.now() + 60 * 60 * 1_000, h2Audience);
  await page.goto(`${APP_BASE_URL}/app?runtime=remote&ws=${encodeURIComponent(h1WsUrl)}&token=${encodeURIComponent(h1Key)}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(
    (expectedRuntimeId) => String((window as typeof window & { isolatedEnv?: { runtimeId?: string } }).isolatedEnv?.runtimeId || '') === expectedRuntimeId,
    `radapter:${h1WsUrl}`,
    { timeout: 60_000 },
  );

  await page.getByTestId('context-current').click();
  await expect(page.getByTestId('remote-runtime-manager')).toHaveCount(0);
  await page.goto(`${APP_BASE_URL}/radapter/manage`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('remote-runtime-manager')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('remote-runtime-label').fill('H2 dropdown');
  await page.getByTestId('remote-runtime-ws').fill(h2WsUrl);
  await page.getByTestId('remote-runtime-token').fill(h2Key);
  const reloadAfterAttach = page.waitForEvent('framenavigated', { timeout: 90_000 }).catch(() => null);
  await page.getByTestId('remote-runtime-attach').click();
  await reloadAfterAttach;
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByTestId('remote-runtime-manager')).toBeVisible({ timeout: 10_000 });

  await page.waitForFunction(
    (expectedWsUrl) => localStorage.getItem('xln-runtime-adapter-ws') === expectedWsUrl,
    h2WsUrl,
    { timeout: 90_000 },
  );

  const managerState = await page.evaluate((expectedWsUrl) => {
    const importsRaw = sessionStorage.getItem('xln-remote-runtime-imports') || '[]';
    const imports = JSON.parse(importsRaw) as Array<{ label?: string; wsUrl?: string; access?: string; entityCount?: number }>;
    return {
      activeWsUrl: localStorage.getItem('xln-runtime-adapter-ws'),
      imports,
      h2Import: imports.find(entry => entry.wsUrl === expectedWsUrl) || null,
    };
  }, h2WsUrl);

  expect(managerState.activeWsUrl).toBe(h2WsUrl);
  expect(managerState.imports.length).toBeGreaterThanOrEqual(1);
  expect(managerState.imports.length).toBeLessThanOrEqual(100);
  expect(managerState.h2Import?.label).toBe('H2 dropdown');
  expect(managerState.h2Import?.access).toBe('read');
  expect(managerState.h2Import?.entityCount ?? 0).toBeGreaterThan(0);

  await page.goto(`${APP_BASE_URL}/app`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    (expectedRuntimeId) => String((window as typeof window & { isolatedEnv?: { runtimeId?: string } }).isolatedEnv?.runtimeId || '') === expectedRuntimeId,
    `radapter:${h2WsUrl}`,
    { timeout: 90_000 },
  );
});

test('bulk remote runtime import link validates mesh, custody, and market maker runtimes in browser', async ({ browser }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    const baseline = await ensureE2EBaseline(page, {
      apiBaseUrl: API_BASE_URL,
      requireHubMesh: true,
      requireMarketMaker: true,
      requireCustody: true,
      minHubCount: 3,
      timeoutMs: 240_000,
    });
    expect(baseline.custody?.enabled, `custody must be enabled: ${JSON.stringify(baseline.custody ?? {})}`).toBe(true);
    expect(baseline.custody?.ok, `custody must be ready: ${JSON.stringify(baseline.custody ?? {})}`).toBe(true);
    expectMarketMakerBooksHealthy(baseline);

    const importUrl = await readRuntimeImportUrl(page);
    expect(importUrl).toContain('runtimeList=');
    expect(importUrl).not.toContain('runtime-import=');
    await page.goto(importUrl, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('remote-runtime-bulk-import-screen')).toHaveCount(0);
    await expect(page.getByTestId('remote-runtime-import-textarea')).toHaveCount(0);
    await expect(page.getByTestId('remote-runtime-import-confirm')).toHaveCount(0);
    await page.waitForFunction((storageKey) => {
      const raw = sessionStorage.getItem(storageKey);
      if (!raw) return false;
      try {
        const parsed = JSON.parse(raw) as { ok?: boolean; count?: number };
        return parsed.ok === true && Number(parsed.count || 0) >= 5;
      } catch {
        return false;
      }
    }, REMOTE_RUNTIME_IMPORT_RESULT_STORAGE_KEY, { timeout: 120_000 });

    const importSummary = await readRuntimeImportSummary(page);
    await expect(page.getByTestId('remote-runtime-bulk-import-screen')).toHaveCount(0);
    await expect(page.getByTestId('remote-runtime-import-textarea')).toHaveCount(0);

    expect(importSummary.ok).toBe(true);
    expect(importSummary.entries.length).toBeGreaterThanOrEqual(5);
    const labels = new Set(importSummary.entries.map(entry => entry.label.toLowerCase()));
    for (const label of ['h1', 'h2', 'h3', 'mm', 'custody']) {
      expect(Array.from(labels), `import summary labels=${Array.from(labels).join(',')}`).toContain(label);
    }
    for (const entry of importSummary.entries) {
      expect(entry.access, `${entry.label} imported access`).toBe('read');
      expect(entry.runtimeId, `${entry.label} runtime id`).toMatch(/^radapter:wss?:\/\//);
      expect(entry.entityCount, `${entry.label} entity count`).toBeGreaterThan(0);
      expect(entry.wsUrl, `${entry.label} wsUrl`).toMatch(/^wss?:\/\/.+\/rpc$/);
    }

    const firstWsUrl = importSummary.entries[0]!.wsUrl;
    await page.waitForFunction((expectedRuntimeId) => {
      const view = window as typeof window & {
        isolatedEnv?: { runtimeId?: string; height?: number; eReplicas?: Map<string, unknown> };
      };
      const env = view.isolatedEnv;
      return String(env?.runtimeId || '') === expectedRuntimeId &&
        Number(env?.height || 0) > 0 &&
        Number(env?.eReplicas?.size || 0) > 0;
    }, `radapter:${firstWsUrl}`, { timeout: 60_000 });

    const browserHealth = await page.evaluate(async () => {
      const response = await fetch('/api/health', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HEALTH_FETCH_FAILED:${response.status}`);
      return await response.json();
    }) as Awaited<ReturnType<typeof ensureE2EBaseline>>;

    expect(browserHealth.hubMesh?.ok, `hub mesh health: ${JSON.stringify(browserHealth.hubMesh ?? {})}`).toBe(true);
    expect(browserHealth.hubMesh?.pairs?.length ?? 0).toBeGreaterThanOrEqual(3);
    for (const pair of browserHealth.hubMesh?.pairs ?? []) {
      expect(pair.ok, `hub mesh pair ${pair.left}->${pair.right} must have mutual credit`).toBe(true);
      expect(pair.expectedCreditAmount, `hub mesh pair ${pair.left}->${pair.right} credit amount`).toBe(HUB_MESH_CREDIT_AMOUNT);
    }
    expect(browserHealth.custody?.ok, `custody health: ${JSON.stringify(browserHealth.custody ?? {})}`).toBe(true);
    expectMarketMakerBooksHealthy(browserHealth);

    await expect(page.getByRole('button', { name: /^H1$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^H2$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^H3$/ })).toBeVisible();
  } finally {
    await context.close();
  }
});
