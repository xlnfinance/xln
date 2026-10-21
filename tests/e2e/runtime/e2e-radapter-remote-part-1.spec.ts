import type { RuntimeAdapterInspection } from '../../../ui/src/runtime/adapter';
import type {
  RuntimeAdapter,
  RuntimeAdapterViewFrame,
  RuntimeAdapterEntitySummary,
  RuntimeAdapterActivityPage,
} from '../../../core/api/public/runtime-module';
import {
  decodeRuntimeAdapterMessage,
  decodeRuntimeAdapterBrowserMessage,
} from '../../../core/api/runtime-adapter/codec';
import type { RuntimeAdapterSolvencySummary, RuntimeAdapterReadQuery } from '../../../core/api/runtime-adapter/types';
import { createWalletIdentity, readWalletIdentity } from '../../../ui/tests/wallet-ui';
import { allowBrowserIssue, allowDebugIncident, expect, test } from '../../global-setup.mts';

import { APP_BASE_URL, API_BASE_URL, ensureE2EBaseline, getHealth, waitForNamedHubs } from '../../utils/e2e-baseline';

import { openAccountWorkspaceTab } from '../../utils/e2e-account-workspace';

import { acceptRemoteRuntimeConsent, resolveRuntimeImportAppUrl } from '../../utils/runtime/e2e-runtime-import';

import {
  verifyExternalWalletSnapshotEvidence,
  verifySiblingWalletDomains,
} from '../../utils/runtime/e2e-external-wallet-evidence';

import { closeRuntimeContext } from '../../utils/runtime/e2e-runtime-shutdown.mts';

import { HUB_MESH_CREDIT_AMOUNT } from '../../../core/orchestrator/mesh/mesh-common';

import { captureLocatorScreenshot } from '../../utils/e2e-screenshots';

const REMOTE_RUNTIME_IMPORT_STORAGE_KEY = 'xln-remote-runtime-imports';

const REMOTE_RUNTIME_IMPORT_RESULT_STORAGE_KEY = 'xln-remote-runtime-import-last-result';

const REMOTE_E2E_WAIT_MS = 15_000;

const remoteRuntimeUrl = (path: string, wsUrl: string, token?: string): string => {
  const hash = new URLSearchParams({ runtime: 'remote', ws: wsUrl });
  if (token) hash.set('token', token);
  return `${APP_BASE_URL}${path}#${hash.toString()}`;
};

// Observe the actual browser transport; production intentionally has no Svelte adapter debug API.
const observeRemoteProjection = (page: import('@playwright/test').Page, wsUrl: string) => {
  const responses = new Map<string, unknown>();
  const errors: string[] = [];
  const reads: Array<{ path: string; query?: RuntimeAdapterReadQuery; payload: unknown }> = [];
  page.on('websocket', socket => {
    if (socket.url() !== wsUrl) return;
    const requests = new Map<string, { path: string; query?: RuntimeAdapterReadQuery }>();
    socket.on('framesent', ({ payload }) => {
      const message = decodeRuntimeAdapterMessage(payload);
      if ('id' in message && (message.op === 'auth' || message.op === 'read'))
        requests.set(
          message.id,
          message.op === 'auth' ? { path: 'auth' } : { path: message.path, query: message.query },
        );
    });
    socket.on('framereceived', ({ payload }) => {
      const message =
        typeof payload === 'string'
          ? decodeRuntimeAdapterBrowserMessage(payload)
          : decodeRuntimeAdapterMessage(payload);
      if (!('inReplyTo' in message)) return;
      const request = requests.get(message.inReplyTo);
      if (!request) return;
      const { path } = request;
      requests.delete(message.inReplyTo);
      if (!message.ok) errors.push(`${path}:${message.error.code}`);
      else {
        responses.set(path, message.payload);
        if (path !== 'auth') reads.push({ ...request, payload: message.payload });
      }
    });
  });
  return { responses, reads, errors };
};

const openReactRemoteWorkspace = async (
  page: import('@playwright/test').Page,
  endpoint: { wsUrl: string; runtimeId: string },
  key: string,
  entityId: string,
) => {
  const wire = observeRemoteProjection(page, endpoint.wsUrl);
  await page.goto(remoteRuntimeUrl('/app', endpoint.wsUrl, key), { waitUntil: 'domcontentloaded' });
  await expect(page.getByLabel('Runtime endpoint', { exact: true })).toHaveValue(endpoint.wsUrl);
  expect(wire.responses.has('auth')).toBe(false);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(entityId.slice(0, 18)) }).click({ timeout: REMOTE_E2E_WAIT_MS });
  await expect(page.getByTestId('home-entity-id')).toHaveText(entityId, { timeout: REMOTE_E2E_WAIT_MS });
  await expect
    .poll(() => wire.responses.get('auth'), { timeout: REMOTE_E2E_WAIT_MS })
    .toMatchObject({ authLevel: 'admin', runtimeId: endpoint.runtimeId });
  expect((wire.responses.get('auth') as { currentHeight: number }).currentHeight).toBeGreaterThan(0);
  const entities = wire.responses.get('entities') as RuntimeAdapterEntitySummary[];
  expect(entities.find(entity => entity.entityId === entityId)?.isHub).toBe(true);
  await expect
    .poll(
      () => (wire.responses.get('view-frame') as RuntimeAdapterViewFrame | undefined)?.activeEntity?.summary.entityId,
      { timeout: REMOTE_E2E_WAIT_MS },
    )
    .toBe(entityId);
  expect(wire.errors).toEqual([]);
  return wire;
};

type RuntimeImportSummary = {
  ok: boolean;
  count: number;
  failedCount?: number;
  entries: Array<{
    label: string;
    access: string;
    wsUrl: string;
    runtimeId: string;
    height: number;
    entityCount: number;
  }>;
  failed?: Array<{
    index: number;
    label: string;
    access: string;
    wsUrl: string;
    reason: string;
  }>;
  checked?: Array<{
    index: number;
    ok: boolean;
    label: string;
    access: string;
    wsUrl: string;
    runtimeId?: string;
    height?: number;
    entityCount?: number;
    reason?: string;
  }>;
};

type RuntimeImportCapability = {
  label: string;
  access: 'admin';
  wsUrl: string;
  token: string;
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

type RuntimeAdapterDebugSurface = {
  query: {
    head: <T = unknown>() => Promise<T>;
    frame: <T = unknown>(height: number) => Promise<T>;
    entities: <T = unknown>(query?: Record<string, unknown>) => Promise<T>;
    viewFrame: <T = unknown>(query?: Record<string, unknown>) => Promise<T>;
    historyFrameBatch: <T = unknown>(query: Record<string, unknown>) => Promise<T>;
    timelineIndex: <T = unknown>(query?: Record<string, unknown>) => Promise<T>;
    activity: <T = unknown>(query: Record<string, unknown>) => Promise<T>;
    solvencySummary: <T = unknown>(query?: Record<string, unknown>) => Promise<T>;
    checkpoints: <T = unknown>() => Promise<T>;
    receiptStatus: <T = unknown>(receiptId: string) => Promise<T>;
  };
  status: () => {
    connected?: boolean;
    authLevel?: string | null;
    height?: number;
    permissions?: string;
  };
};

type E2EHealthSnapshot = Awaited<ReturnType<typeof ensureE2EBaseline>>;

const readAdminControlProbe = async (
  page: import('@playwright/test').Page,
  args: { hubId: string; minHeight: number; expectedName: string },
): Promise<AdminControlProbe> => {
  return await page.evaluate(async ({ hubId, minHeight, expectedName }) => {
    try {
      const view = window as typeof window & {
        __xlnRuntimeAdapter?: RuntimeAdapterDebugSurface;
      };
      const adapter = (view as any).__xln?.adapter;
      if (!adapter)
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
          reason: 'adapter-missing',
        };
      type Head = { latestHeight?: number };
      type ViewFrame = {
        height?: number;
        activeEntity?: {
          core?: { profile?: { name?: string } };
          accounts?: { items?: unknown[]; totalItems?: number };
        } | null;
      };
      type HistoryBatch = {
        frames?: Array<{ height?: number }>;
      };
      const head = await adapter.query.head<Head>();
      const latestHeight = Number(head.latestHeight || 0);
      const frame =
        latestHeight > minHeight
          ? await adapter.query.viewFrame<ViewFrame>({
              atHeight: latestHeight,
              entityId: hubId,
              accountsLimit: 1,
              booksLimit: 1,
            })
          : null;
      const history =
        latestHeight > minHeight
          ? await adapter.query.historyFrameBatch<HistoryBatch>({
              heights: [minHeight, latestHeight],
              entityId: hubId,
              accountsLimit: 1,
              booksLimit: 1,
            })
          : null;
      const historyHeights = (history?.frames ?? []).map(item => Number(item.height || 0));
      const frameName = String(frame?.activeEntity?.core?.profile?.name || '');
      const projectedName = frameName;
      const frameHeight = Number(frame?.height || 0);
      const ok =
        latestHeight > minHeight &&
        frameName === expectedName &&
        frameHeight >= latestHeight &&
        projectedName === expectedName;
      return {
        ok,
        latestHeight,
        frameHeight,
        envHeight: frameHeight,
        frameName,
        envName: projectedName,
        accountCount: Number(
          frame?.activeEntity?.accounts?.totalItems ?? frame?.activeEntity?.accounts?.items?.length ?? 0,
        ),
        historyLength: historyHeights.length,
        historyHeights,
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

type HubRuntimeEndpoint = {
  name: string;
  apiBaseUrl: string;
  wsUrl: string;
  runtimeId: string;
};

const hubApiBaseUrlFromHealth = (health: E2EHealthSnapshot, hubName: string): string => {
  const hub = (health.hubs ?? []).find(
    candidate =>
      String(candidate.name || '')
        .trim()
        .toLowerCase() === hubName.trim().toLowerCase(),
  );
  if (!hub) throw new Error(`E2E_HUB_HEALTH_MISSING:${hubName}`);
  const apiUrl = String(hub.apiUrl || '').trim();
  if (apiUrl) return apiUrl;
  const apiPort = Number(hub.apiPort || 0);
  if (Number.isFinite(apiPort) && apiPort > 0) return `http://127.0.0.1:${apiPort}`;
  throw new Error(`E2E_HUB_API_ENDPOINT_MISSING:${hubName}`);
};

const runtimeRpcWsUrlFromApiBaseUrl = (apiBaseUrl: string): string => {
  const url = new URL(apiBaseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/rpc';
  url.search = '';
  url.hash = '';
  return url.toString();
};

const normalizeRuntimeWsUrl = (value: string): string => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const url = new URL(raw);
  url.protocol = url.protocol === 'https:' ? 'wss:' : url.protocol === 'http:' ? 'ws:' : url.protocol;
  url.hash = '';
  return url.toString().toLowerCase();
};

const resolveHubRuntimeEndpoint = async (
  page: import('@playwright/test').Page,
  health: E2EHealthSnapshot,
  hubName: string,
  timeoutMs = 60_000,
): Promise<HubRuntimeEndpoint> => {
  const apiBaseUrl = hubApiBaseUrlFromHealth(health, hubName);
  const startedAt = Date.now();
  let lastError = '';
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await page.request.get(`${apiBaseUrl}/api/info`, {
        headers: { 'Cache-Control': 'no-store' },
        timeout: 5_000,
      });
      if (!response.ok()) {
        lastError = `HTTP ${response.status()}`;
      } else {
        const info = (await response.json().catch(() => ({}))) as { runtimeId?: string; apiUrl?: string };
        const runtimeId = String(info.runtimeId || '')
          .trim()
          .toLowerCase();
        if (!runtimeId) throw new Error(`E2E_HUB_RUNTIME_ID_MISSING:${hubName}`);
        const resolvedApiBaseUrl = String(info.apiUrl || apiBaseUrl).trim();
        return {
          name: hubName,
          apiBaseUrl: resolvedApiBaseUrl,
          wsUrl: runtimeRpcWsUrlFromApiBaseUrl(resolvedApiBaseUrl),
          runtimeId,
        };
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`E2E_HUB_INFO_UNREACHABLE:${hubName}:${apiBaseUrl}:${lastError}`);
};

const readRuntimeImportCapabilities = async (
  page: import('@playwright/test').Page,
  access: 'admin',
  timeoutMs = 60_000,
): Promise<RuntimeImportCapability[]> => {
  const startedAt = Date.now();
  let lastError = '';
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await page.request.get(`${API_BASE_URL}/api/runtime-import?access=${access}`, {
        headers: { 'Cache-Control': 'no-store' },
        timeout: 5_000,
      });
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        ready?: boolean;
        manifest?: { entries?: RuntimeImportCapability[] };
        entries?: RuntimeImportCapability[];
      };
      const entries = Array.isArray(payload.manifest?.entries)
        ? payload.manifest.entries
        : Array.isArray(payload.entries)
          ? payload.entries
          : [];
      if (response.ok() && payload.ready !== false && entries.length > 0) {
        return entries;
      }
      lastError = `status=${response.status()} ready=${String(payload.ready)} entries=${entries.length}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`E2E_RUNTIME_IMPORT_CAPABILITIES_UNAVAILABLE:${access}:${lastError}`);
};

const resolveRuntimeImportCapability = async (
  page: import('@playwright/test').Page,
  endpoint: HubRuntimeEndpoint,
  access: 'admin',
): Promise<RuntimeImportCapability> => {
  const entries = await readRuntimeImportCapabilities(page, access);
  const expectedWsUrl = normalizeRuntimeWsUrl(endpoint.wsUrl);
  const entry =
    entries.find(candidate => normalizeRuntimeWsUrl(String(candidate.wsUrl || '')) === expectedWsUrl) ??
    entries.find(
      candidate =>
        String(candidate.label || '')
          .trim()
          .toLowerCase() === endpoint.name.toLowerCase(),
    );
  if (!entry) {
    throw new Error(`E2E_RUNTIME_IMPORT_CAPABILITY_MISSING:${endpoint.name}:${access}:${endpoint.wsUrl}`);
  }
  expect(entry.access, `${endpoint.name} runtime import access`).toBe(access);
  expect(entry.token, `${endpoint.name} runtime import token`).toMatch(/^xlnra1\./);
  return entry;
};

const readRuntimeImportSummary = async (
  page: import('@playwright/test').Page,
  timeoutMs = 30_000,
): Promise<RuntimeImportSummary> => {
  const startedAt = Date.now();
  let lastError = '';
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const summary = await page.evaluate(storageKey => {
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

const observedHubMeshHubCount = (health: E2EHealthSnapshot): number =>
  Math.max(
    health.hubMesh?.hubIds?.length ?? 0,
    health.hubMesh?.hubCount ?? 0,
    (health.hubs ?? []).filter(hub => hub.online === true).length,
  );

const observedHubMeshPairCount = (health: E2EHealthSnapshot): number =>
  Math.max(health.hubMesh?.pairs?.length ?? 0, health.hubMesh?.pairCount ?? 0);

const expectHubMeshHealthy = (health: E2EHealthSnapshot): void => {
  expect(health.hubMesh?.ok, `hub mesh health: ${JSON.stringify(health.hubMesh ?? {})}`).toBe(true);
  expect(observedHubMeshHubCount(health), 'hub mesh must expose at least 3 online hubs').toBeGreaterThanOrEqual(3);
  expect(observedHubMeshPairCount(health), 'hub mesh must expose at least 3 funded pairs').toBeGreaterThanOrEqual(3);

  const pairs = health.hubMesh?.pairs ?? [];
  for (const pair of pairs) {
    expect(pair.ok, `hub mesh pair ${pair.left}->${pair.right} must have mutual credit`).toBe(true);
    expect(pair.expectedCreditAmount, `hub mesh pair ${pair.left}->${pair.right} credit amount`).toBe(
      HUB_MESH_CREDIT_AMOUNT.toString(),
    );
  }
};

const expectMarketMakerBooksHealthy = (health: E2EHealthSnapshot): void => {
  const marketMaker = health.marketMaker;
  expect(marketMaker?.enabled, `market maker must be enabled: ${JSON.stringify(marketMaker ?? {})}`).toBe(true);
  expect(marketMaker?.ok, `market maker must be ready: ${JSON.stringify(marketMaker ?? {})}`).toBe(true);
  expect(marketMaker?.startupPhase, `market maker startup phase: ${JSON.stringify(marketMaker ?? {})}`).toBe(
    'offers-ready',
  );

  const detailedHubs = marketMaker?.hubs ?? [];
  const hubCount = Math.max(detailedHubs.length, marketMaker?.hubCount ?? 0);
  expect(hubCount, 'MM must publish books for all hubs').toBeGreaterThanOrEqual(3);
  for (const hub of detailedHubs) {
    expect(hub.ready, `MM hub ${hub.hubEntityId} ready`).toBe(true);
    expect(hub.offers, `MM hub ${hub.hubEntityId} offers`).toBeGreaterThan(0);
    for (const pair of hub.pairs ?? []) {
      expect(pair.ready, `MM pair ${pair.pairId} ready`).toBe(true);
      expect(pair.offers, `MM pair ${pair.pairId} offers`).toBeGreaterThan(0);
    }
  }

  const cross = marketMaker?.cross;
  expect(cross?.ok, `cross MM books must be ready: ${JSON.stringify(cross ?? {})}`).toBe(true);
  const detailedRoutes = cross?.routes ?? [];
  if (detailedRoutes.length > 0) {
    expect(detailedRoutes.length, 'cross MM must publish all expected routes').toBeGreaterThanOrEqual(
      cross?.expectedRoutes ?? 0,
    );
    for (const route of detailedRoutes) {
      expect(route.ready, `cross route ${route.sourceHubEntityId}->${route.targetHubEntityId} ready`).toBe(true);
      expect(route.offers, `cross route ${route.sourceHubEntityId}->${route.targetHubEntityId} offers`).toBeGreaterThan(
        0,
      );
      for (const pair of route.pairs ?? []) {
        expect(pair.ready, `cross route pair ${pair.pairId} ready`).toBe(true);
        expect(pair.offers, `cross route pair ${pair.pairId} offers`).toBeGreaterThan(0);
      }
    }
  } else if (typeof cross?.routeCount === 'number') {
    expect(cross.routeCount, 'cross MM public route count').toBeGreaterThanOrEqual(cross.expectedRoutes ?? 0);
  } else {
    expect(health.systemOk, `redacted MM health without route count: ${JSON.stringify(health)}`).toBe(true);
  }
};

test.setTimeout(240_000);

test('remote /app opens an existing hub runtime through radapter', { tag: '@functional' }, async ({ page }) => {
  const baseline = await ensureE2EBaseline(page, { requireHubMesh: true, minHubCount: 3 });
  const hubs = await waitForNamedHubs(page, ['h1', 'h2', 'h3'], { apiBaseUrl: API_BASE_URL });
  const h1 = String(hubs.h1).toLowerCase();
  const endpoint = await resolveHubRuntimeEndpoint(page, baseline, 'H1');
  const key = (await resolveRuntimeImportCapability(page, endpoint, 'admin')).token;
  await page.goto(remoteRuntimeUrl('/app', endpoint.wsUrl, key), { waitUntil: 'domcontentloaded' });
  await expect(page.getByLabel('Runtime endpoint', { exact: true })).toHaveValue(endpoint.wsUrl);
  await expect(page.getByLabel('Access key · optional', { exact: true })).toHaveValue(key);
  expect(new URL(page.url()).hash).toBe('');
  // A capability in a URL is not consent. No connection or persistent credential precedes the click.
  expect(
    await page.evaluate(token => {
      const debug = (window as Window & { __xln?: { adapter: () => RuntimeAdapter | null } }).__xln;
      return {
        connected: Boolean(debug?.adapter()),
        leaked: [...Object.values(localStorage), ...Object.values(sessionStorage)].some(value => value.includes(token)),
      };
    }, key),
  ).toEqual({ connected: false, leaked: false });

  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(h1.slice(0, 18)) }).click();
  await expect(page.locator('[data-testid="nav-home"]:visible')).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });
  const snapshot = await page.evaluate(async hubId => {
    const debug = (
      window as Window & {
        __xln?: {
          adapter: () => RuntimeAdapter | null;
          env: () => unknown;
          store: { getState: () => { activeEntityId: string | null } };
        };
      }
    ).__xln;
    const adapter = debug?.adapter();
    if (!debug || !adapter) throw new Error('CURRENT_REMOTE_ADAPTER_MISSING');
    const frame = await adapter.read<RuntimeAdapterViewFrame>('view-frame', { entityId: hubId, accountsLimit: 10 });
    const summaries = await adapter.read<RuntimeAdapterEntitySummary[]>('entities');
    const hub = summaries.find(entity => entity.entityId === hubId);
    const active = frame.activeEntity;
    if (!hub || !active) throw new Error('REMOTE_HUB_PROJECTION_MISSING');
    return {
      runtimeId: adapter.runtimeId,
      status: adapter.status,
      auth: adapter.authLevel,
      mode: adapter.mode,
      height: frame.height,
      entityCount: summaries.length,
      hubName: hub.label,
      hubIsHub: hub.isHub,
      accountCount: active.accounts.totalItems,
      accountIds: active.accounts.items.map(account =>
        account.state.leftEntity.toLowerCase() === hubId
          ? account.state.rightEntity.toLowerCase()
          : account.state.leftEntity.toLowerCase(),
      ),
      activeId: debug.store.getState().activeEntityId,
      embeddedEnv: debug.env(),
    };
  }, h1);
  expect(snapshot.runtimeId).toBe(endpoint.runtimeId);
  expect(snapshot.status).toBe('connected');
  expect(snapshot.mode).toBe('remote');
  expect(snapshot.auth).toBe('admin');
  expect(snapshot.embeddedEnv).toBeNull();
  expect(snapshot.height).toBeGreaterThan(0);
  expect(snapshot.entityCount).toBeGreaterThan(0);
  expect(snapshot.hubIsHub).toBe(true);
  expect(snapshot.hubName.toLowerCase()).toContain('h1');
  expect(snapshot.accountCount).toBeGreaterThan(0);
  expect(snapshot.accountCount).toBeLessThanOrEqual(10);
  expect(snapshot.activeId).toBe(h1);
  expect(snapshot.accountIds).toEqual(expect.arrayContaining([hubs.h2, hubs.h3]));
  await expect(page.getByTestId('home-entity-id')).toHaveText(h1);
  for (const hubId of [hubs.h2, hubs.h3])
    await expect(page.locator(`[data-testid="account-row"][data-counterparty-id="${hubId}"]`)).toBeVisible();

  // The remote wallet reads its real on-chain identity at the owning Runtime's API.
  const walletEvidence = page.waitForResponse(
    response =>
      new URL(response.url()).pathname === '/api/external-wallet/snapshot' && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: /Assets and deposits/ }).click();
  const walletResponse = await walletEvidence;
  const walletInput = await verifyExternalWalletSnapshotEvidence(page, walletResponse);
  await verifySiblingWalletDomains(page, walletResponse.url(), walletInput, endpoint.runtimeId);
  await page.locator('[data-testid="nav-activity"]:visible').click();
  await expect(page.getByTestId('activity-search')).toBeVisible();
  const history = await page.evaluate(async entityId => {
    const adapter = (window as Window & { __xln?: { adapter: () => RuntimeAdapter | null } }).__xln?.adapter();
    if (!adapter) throw new Error('CURRENT_REMOTE_ADAPTER_MISSING');
    return adapter.read<RuntimeAdapterActivityPage>('activity', { entityId, limit: 50 });
  }, h1);
  expect(history.events.length).toBeGreaterThan(0);
  await expect(page.getByTestId('activity-row').first()).toBeVisible();
  await expect(page.locator('main')).not.toContainText('Settlement history requires a runtime frame');
});

test(
  'dev DockRoot entity panel resolves seed through remote RuntimeView projection',
  { tag: '@functional' },
  async ({ page }) => {
    const baseline = await ensureE2EBaseline(page, { requireHubMesh: true, minHubCount: 3 });
    const h1Endpoint = await resolveHubRuntimeEndpoint(page, baseline, 'H1');
    const key = (await resolveRuntimeImportCapability(page, h1Endpoint, 'admin')).token;
    const wire = observeRemoteProjection(page, h1Endpoint.wsUrl);
    await page.addInitScript(() => {
      localStorage.setItem('xln-app-mode', 'dev');
      localStorage.setItem('xln-view-mode', 'panels');
      localStorage.removeItem('xln-observer-layout');
    });
    await page.goto(remoteRuntimeUrl('/app?observer=1', h1Endpoint.wsUrl, key), { waitUntil: 'domcontentloaded' });
    await acceptRemoteRuntimeConsent(page);
    await expect.poll(() => wire.responses.get('auth'), { timeout: 90_000 }).toMatchObject({ authLevel: 'admin' });
    const auth = wire.responses.get('auth') as { currentHeight: number; runtimeId: string };
    expect(auth.currentHeight).toBeGreaterThan(0);
    expect(auth.runtimeId).toBe(h1Endpoint.runtimeId);
    await expect.poll(() => wire.responses.get('view-frame'), { timeout: 90_000 }).toHaveProperty('activeEntity');
    const frame = wire.responses.get('view-frame') as RuntimeAdapterViewFrame;
    if (!frame.activeEntity) throw new Error('REMOTE_ENTITY_PROJECTION_MISSING');
    const opened = {
      entityId: frame.activeEntity.summary.entityId.toLowerCase(),
      label: frame.activeEntity.summary.label,
      signerId: frame.activeEntity.core.signerId.toLowerCase(),
    };
    expect(opened.entityId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(opened.signerId).toMatch(/^0x[0-9a-f]{40}$/);
    await page.waitForFunction(() => !!(window as any).__dockview_instance?.addPanel, undefined, { timeout: 90_000 });
    await page.evaluate(({ entityId, label }) => {
      (window as any).__dockview_instance.addPanel({
        id: `entity-${entityId}`,
        component: 'entity-panel',
        title: `Projection ${label}`,
        position: { direction: 'within', referencePanel: 'graph3d' },
        params: { closeable: true },
      });
    }, opened);
    await expect
      .poll(
        () => {
          const read = wire.reads.findLast(
            read => read.path === 'view-frame' && read.query?.entityId === opened.entityId,
          );
          return (read?.payload as RuntimeAdapterViewFrame | undefined)?.activeEntity?.summary.entityId;
        },
        { timeout: REMOTE_E2E_WAIT_MS },
      )
      .toBe(opened.entityId);
    await page.waitForSelector('.entity-panel-wrapper [data-testid="entity-workspace"]', {
      timeout: REMOTE_E2E_WAIT_MS,
    });
    await expect(page.locator(`[data-panel-id="entity-${opened.entityId.slice(0, 8)}"]`)).toBeVisible({
      timeout: REMOTE_E2E_WAIT_MS,
    });
    expect(await page.locator('.entity-panel-wrapper [data-testid="entity-workspace"]').count()).toBeGreaterThan(0);
    await expect(page.locator('.entity-panel-status.error')).toHaveCount(0);
    await expect(page.locator('body')).toContainText(opened.entityId);
    expect(wire.errors).toEqual([]);
  },
);

test('dev DockRoot Solvency panel reads remote radapter solvency-summary', { tag: '@functional' }, async ({ page }) => {
  const baseline = await ensureE2EBaseline(page, { requireHubMesh: true, minHubCount: 3 });
  const h1Endpoint = await resolveHubRuntimeEndpoint(page, baseline, 'H1');
  const key = (await resolveRuntimeImportCapability(page, h1Endpoint, 'admin')).token;
  const wire = observeRemoteProjection(page, h1Endpoint.wsUrl);
  const consoleProblems: string[] = [];
  page.on('console', message => {
    const text = message.text();
    if (/\[vite\]|Ignoring Event: localhost/.test(text)) return;
    if (message.type() === 'error' || message.type() === 'warning') consoleProblems.push(`${message.type()}: ${text}`);
  });
  page.on('pageerror', error => consoleProblems.push(`pageerror: ${error.message}`));

  await page.addInitScript(() => {
    localStorage.setItem('xln-app-mode', 'dev');
    localStorage.setItem('xln-view-mode', 'panels');
    localStorage.removeItem('xln-workspace-layout');
    localStorage.removeItem('xln-dockview-layout');
    localStorage.removeItem('dockview-layout');
  });

  await page.goto(remoteRuntimeUrl('/app?observer=1', h1Endpoint.wsUrl, key), {
    waitUntil: 'domcontentloaded',
  });
  await acceptRemoteRuntimeConsent(page);

  await expect
    .poll(() => wire.responses.get('auth'), { timeout: REMOTE_E2E_WAIT_MS })
    .toMatchObject({ authLevel: 'admin' });
  const auth = wire.responses.get('auth') as { currentHeight: number; runtimeId: string };
  expect(auth.currentHeight).toBeGreaterThan(0);
  expect(auth.runtimeId).toBe(h1Endpoint.runtimeId);

  await expect(page.getByTestId('network-machine-timeline')).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });

  await page.locator('.dv-tab').filter({ hasText: 'Gossip' }).first().click();
  await expect(page.getByTestId('runtime-gossip-panel')).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });
  await expect(page.getByTestId('runtime-gossip-profiles')).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });

  await page.locator('.dv-tab').filter({ hasText: 'Solvency' }).first().click();
  await expect(page.getByTestId('solvency-panel')).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });

  await expect.poll(() => wire.responses.has('solvency-summary'), { timeout: REMOTE_E2E_WAIT_MS }).toBe(true);
  const summary = wire.responses.get('solvency-summary') as RuntimeAdapterSolvencySummary;
  const probe = (() => {
    return {
      ok: summary.ok === true,
      height: Number(summary.height || 0),
      entityCount: Number(summary.entityCount || 0),
      accountViews: Number(summary.accountViews || 0),
      hasFullEnv: 'eReplicas' in summary,
      hasFullAccounts: 'accounts' in summary,
      assetCount: summary.assets?.length ?? 0,
      assetAmountsAreBigInt: (summary.assets ?? []).every(
        asset =>
          typeof asset.reserves === 'bigint' &&
          typeof asset.confirmedCollateral === 'bigint' &&
          typeof asset.internalValue === 'bigint' &&
          asset.internalValue === asset.reserves! + asset.confirmedCollateral!,
      ),
      assetDeltasUnchecked: (summary.assets ?? []).every(asset => asset.delta === null),
      assetIdentitiesAreScoped: (summary.assets ?? []).every(
        asset => typeof asset.stackId === 'string' && Number.isSafeInteger(asset.tokenId),
      ),
      isValidType: typeof summary.isValid,
    };
  })();
  expect(wire.errors).toEqual([]);

  expect(probe.ok).toBe(true);
  expect(probe.height).toBeGreaterThan(0);
  expect(probe.entityCount).toBeGreaterThan(0);
  expect(probe.accountViews).toBeGreaterThan(0);
  expect(probe.hasFullEnv).toBe(false);
  expect(probe.hasFullAccounts).toBe(false);
  expect(probe.assetCount).toBeGreaterThan(0);
  expect(probe.assetAmountsAreBigInt).toBe(true);
  expect(probe.assetDeltasUnchecked).toBe(true);
  expect(probe.assetIdentitiesAreScoped).toBe(true);
  expect(probe.isValidType).toBe('object');

  await expect(page.getByTestId('solvency-status')).toContainText('ASSET CONSERVATION NOT VERIFIED', {
    timeout: REMOTE_E2E_WAIT_MS,
  });
  await expect(page.getByTestId('solvency-reserves').first()).toContainText(/\d/);
  await expect(page.getByTestId('solvency-collateral').first()).toContainText(/\d/);

  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toContain('Solvency projection failed');
  expect(bodyText).not.toContain('No solvency data');
  expect(
    consoleProblems.filter(message =>
      /TypeError|unsupported adapter path|solvency projection failed|pageerror/i.test(message),
    ),
  ).toEqual([]);
});

test('remote /app pasted capability connects without reloading the page', { tag: '@functional' }, async ({ page }) => {
  const baseline = await ensureE2EBaseline(page, { requireHubMesh: true, minHubCount: 3 });
  const hubs = await waitForNamedHubs(page, ['h1'], { apiBaseUrl: API_BASE_URL });
  const h1 = String(hubs.h1).toLowerCase();
  const endpoint = await resolveHubRuntimeEndpoint(page, baseline, 'H1');
  const key = (await resolveRuntimeImportCapability(page, endpoint, 'admin')).token;
  const wire = observeRemoteProjection(page, endpoint.wsUrl);
  await page.goto(remoteRuntimeUrl('/app', endpoint.wsUrl), { waitUntil: 'domcontentloaded' });
  await expect(page.getByLabel('Runtime endpoint', { exact: true })).toHaveValue(endpoint.wsUrl, {
    timeout: REMOTE_E2E_WAIT_MS,
  });
  const reloadMarker = `xln-no-reload-${Date.now()}`;
  await page.evaluate(marker => {
    (window as any).__xlnNoReloadMarker = marker;
  }, reloadMarker);
  await page.getByLabel('Access key · optional', { exact: true }).fill(key);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(h1.slice(0, 18)) }).click({ timeout: REMOTE_E2E_WAIT_MS });
  await expect(page.getByTestId('home-entity-id')).toHaveText(h1, { timeout: REMOTE_E2E_WAIT_MS });
  await expect
    .poll(() => wire.responses.get('auth'), { timeout: REMOTE_E2E_WAIT_MS })
    .toMatchObject({
      authLevel: 'admin',
      runtimeId: endpoint.runtimeId,
    });
  expect((wire.responses.get('auth') as { currentHeight: number }).currentHeight).toBeGreaterThan(0);
  const state = await page.evaluate(
    ({ key, wsUrl }) => {
      const vaults = JSON.parse(localStorage.getItem('xln-ui-vaults') || '[]') as Array<{
        id: string;
        kind: string;
        remote?: { wsUrl: string };
      }>;
      return {
        url: window.location.href,
        activeRemote: vaults.some(
          vault =>
            vault.id === localStorage.getItem('xln-ui-active-vault') &&
            vault.kind === 'remote' &&
            vault.remote?.wsUrl === wsUrl,
        ),
        // React holds the capability in the authenticated session, never browser persistence.
        persistedCapability: [localStorage, sessionStorage].some(storage =>
          Object.values(storage).some(value => value.includes(key)),
        ),
        reloadMarker: (window as any).__xlnNoReloadMarker || '',
        navigationType: String(performance.getEntriesByType('navigation')[0]?.toJSON?.()?.type || ''),
      };
    },
    { key, wsUrl: endpoint.wsUrl },
  );
  expect(state.reloadMarker).toBe(reloadMarker);
  expect(state.navigationType).not.toBe('reload');
  expect(state.url).not.toContain('runtime=remote');
  expect(state.url).not.toContain('ws=');
  expect(state.activeRemote).toBe(true);
  expect(state.persistedCapability).toBe(false);
  await expect(page.getByLabel('Access key · optional', { exact: true })).toHaveCount(0);
  expect(wire.errors).toEqual([]);
});

test(
  'local runtime creation while remote is active switches controller to embedded',
  { tag: '@functional' },
  async ({ page }) => {
    const baseline = await ensureE2EBaseline(page, { requireHubMesh: true, minHubCount: 3 });
    const hubs = await waitForNamedHubs(page, ['h1'], { apiBaseUrl: API_BASE_URL });
    const h1 = String(hubs.h1).toLowerCase();
    const endpoint = await resolveHubRuntimeEndpoint(page, baseline, 'H1');
    const key = (await resolveRuntimeImportCapability(page, endpoint, 'admin')).token;
    await page.goto(remoteRuntimeUrl('/app', endpoint.wsUrl, key), { waitUntil: 'domcontentloaded' });
    await expect(page.getByLabel('Runtime endpoint', { exact: true })).toHaveValue(endpoint.wsUrl);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(h1.slice(0, 18)) }).click({ timeout: REMOTE_E2E_WAIT_MS });
    await expect(page.getByTestId('home-entity-id')).toHaveText(h1, { timeout: REMOTE_E2E_WAIT_MS });
    const before = await page.evaluate(() => {
      const adapter = (window as Window & { __xln?: { adapter(): RuntimeAdapterInspection | null } }).__xln?.adapter();
      return {
        runtimeId: adapter?.runtimeId,
        mode: adapter?.mode,
        authLevel: adapter?.authLevel,
        timeOrigin: performance.timeOrigin,
      };
    });
    expect(before).toMatchObject({ runtimeId: endpoint.runtimeId, mode: 'remote', authLevel: 'admin' });
    await page.locator('[data-testid="nav-settings"]:visible').click();
    await page.getByRole('button', { name: 'Lock', exact: true }).click();
    await expect(page.getByRole('button', { name: /Restore a wallet/ })).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });
    expect(await page.evaluate(() => (window as any).__xln.adapter())).toBeNull();
    const created = await createWalletIdentity(
      page,
      'remote-to-local',
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    );
    const restored = await readWalletIdentity(page);
    expect(restored).toEqual(created);
    expect(created.runtimeId).toMatch(/^0x[a-f0-9]{40}$/i);
    expect(created.runtimeId).not.toBe(endpoint.runtimeId);
    const state = await page.evaluate(key => {
      const adapter = (window as Window & { __xln?: { adapter(): RuntimeAdapterInspection | null } }).__xln?.adapter();
      if (!adapter) throw new Error('LOCAL_ADAPTER_MISSING');
      return {
        runtimeId: adapter.runtimeId,
        mode: adapter.mode,
        status: adapter.status,
        authLevel: adapter.authLevel,
        commandLaneKind: adapter.commandLaneKind,
        commandReady: adapter.commandReady,
        height: adapter.currentHeight,
        activeVaultId: localStorage.getItem('xln-ui-active-vault'),
        timeOrigin: performance.timeOrigin,
        persistedCapability: [localStorage, sessionStorage].some(storage =>
          Object.values(storage).some(value => value.includes(key)),
        ),
        capabilityInUrl: window.location.href.includes(key),
      };
    }, key);
    expect(state).toMatchObject({
      runtimeId: created.runtimeId,
      activeVaultId: created.runtimeId,
      mode: 'embedded',
      status: 'connected',
      authLevel: 'admin',
      commandLaneKind: 'owner',
      commandReady: true,
      timeOrigin: before.timeOrigin,
      persistedCapability: false,
      capabilityInUrl: false,
    });
    expect(state.height).toBeGreaterThan(0);
    await page.locator('[data-testid="nav-home"]:visible').click();
    await expect(page.getByTestId('home-entity-id')).toHaveText(created.entityId);
  },
);

test('context dropdown groups H1 H2 H3 remote runtimes', { tag: '@functional' }, async ({ page }) => {
  const baseline = await ensureE2EBaseline(page, { requireHubMesh: true, minHubCount: 3 });
  const hubs = await waitForNamedHubs(page, ['h1', 'h2', 'h3'], { apiBaseUrl: API_BASE_URL });
  const entries: Array<{ name: string; entityId: string; runtimeId: string; wsUrl: string; token: string }> = [];
  const lock = async (): Promise<void> => {
    await page.locator('[data-testid="nav-settings"]:visible').click();
    await page.getByRole('button', { name: 'Lock', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
  };
  const state = () =>
    page.evaluate(() => {
      const adapter = (window as Window & { __xln?: { adapter: () => RuntimeAdapter | null } }).__xln?.adapter();
      if (!adapter) throw new Error('CONTEXT_REMOTE_ADAPTER_MISSING');
      return {
        runtimeId: adapter.runtimeId,
        authLevel: adapter.authLevel,
        height: adapter.currentHeight,
        mode: adapter.mode,
      };
    });

  // Exercise current connections, not injected rows from the retired wallet registry.
  for (const name of ['H1', 'H2', 'H3']) {
    const endpoint = await resolveHubRuntimeEndpoint(page, baseline, name);
    const capability = await resolveRuntimeImportCapability(page, endpoint, 'admin');
    const entityId = hubs[name.toLowerCase()];
    if (!entityId) throw new Error(`CONTEXT_HUB_ENTITY_MISSING:${name}`);
    entries.push({ name, entityId, runtimeId: endpoint.runtimeId, wsUrl: endpoint.wsUrl, token: capability.token });
    await page.goto(remoteRuntimeUrl('/app', endpoint.wsUrl, capability.token), { waitUntil: 'domcontentloaded' });
    await expect(page.getByLabel('Runtime endpoint', { exact: true })).toHaveValue(endpoint.wsUrl);
    expect(
      await page.evaluate(() =>
        (window as Window & { __xln?: { adapter: () => RuntimeAdapter | null } }).__xln?.adapter(),
      ),
    ).toBeNull();
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByText('That runtime serves more than one entity. Pick the one to open.')).toBeVisible();
    const entities = await page.evaluate(async () => {
      const adapter = (window as Window & { __xln?: { adapter: () => RuntimeAdapter | null } }).__xln?.adapter();
      if (!adapter) throw new Error('CONTEXT_REMOTE_ADAPTER_MISSING');
      return adapter.read<RuntimeAdapterEntitySummary[]>('entities');
    });
    expect(entities.length).toBeGreaterThan(0);
    const target = entities.find(entity => entity.entityId.toLowerCase() === entityId.toLowerCase());
    if (!target?.jurisdiction) throw new Error(`CONTEXT_JURISDICTION_MISSING:${name}`);
    expect(target.isHub).toBe(true);
    expect(target.runtimeId).toBe(endpoint.runtimeId);
    expect(target.jurisdiction.chainId).toBeGreaterThan(0);
    if (typeof target.jurisdiction.address !== 'string') throw new Error('CONTEXT_RPC_URL_MISSING');
    expect(['http:', 'https:']).toContain(new URL(target.jurisdiction.address).protocol);
    expect(target.jurisdiction.depositoryAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    for (const entity of entities) {
      await expect(page.getByRole('button', { name: new RegExp(entity.entityId.slice(0, 18)) })).toBeVisible();
    }
    await page.getByRole('button', { name: new RegExp(entityId.slice(0, 18)) }).click();
    await expect(page.getByTestId('home-entity-id')).toHaveText(entityId.toLowerCase());
    const current = await state();
    expect(current).toMatchObject({ runtimeId: endpoint.runtimeId, authLevel: 'admin', mode: 'remote' });
    expect(current.height).toBeGreaterThan(0);
    await expect(page.getByRole('complementary', { name: 'Active jurisdiction' })).toContainText(
      `Chain ${target.jurisdiction.chainId}`,
    );
    await lock();
  }

  // Saved choices contain endpoint/Entity identity only. A different Runtime's
  // capability must never be silently carried into the selected saved wallet.
  const saved = await page.evaluate(() => localStorage.getItem('xln-ui-vaults'));
  expect(saved).not.toBeNull();
  for (const entry of entries) {
    expect(saved).toContain(`remote:${entry.wsUrl}:${entry.entityId}`);
    expect(saved).not.toContain(entry.token);
  }
  await page.getByText('Choose another wallet (2)', { exact: true }).click();
  for (const entry of entries.slice(0, 2)) {
    await expect(
      page.getByRole('button', { name: new RegExp(`${entry.name}.*${entry.entityId.slice(-8)}`) }),
    ).toBeVisible();
  }
  const h2 = entries.find(entry => entry.name === 'H2');
  if (!h2) throw new Error('CONTEXT_H2_MISSING');
  await page.getByRole('button', { name: new RegExp(`H2.*${h2.entityId.slice(-8)}`) }).click();
  await expect(page.getByLabel('Runtime endpoint', { exact: true })).toHaveValue(h2.wsUrl);
  await expect(page.getByLabel('Access key · optional', { exact: true })).toHaveValue('');
  expect(
    await page.evaluate(() =>
      (window as Window & { __xln?: { adapter: () => RuntimeAdapter | null } }).__xln?.adapter(),
    ),
  ).toBeNull();
  await page.getByLabel('Access key · optional', { exact: true }).fill(h2.token);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByText('That runtime serves more than one entity. Pick the one to open.')).toBeVisible();
  await page.getByRole('button', { name: new RegExp(h2.entityId.slice(0, 18)) }).click();
  await page.locator('[data-testid="nav-home"]:visible').click();
  await expect(page.getByTestId('home-entity-id')).toHaveText(h2.entityId.toLowerCase());
  expect(await state()).toMatchObject({ runtimeId: h2.runtimeId, authLevel: 'admin', mode: 'remote' });
});

test(
  'admin remote runtime opens swap workspace from RuntimeView projection',
  { tag: '@functional' },
  async ({ page }) => {
    const baseline = await ensureE2EBaseline(page, { requireHubMesh: true, minHubCount: 3 });
    const hubs = await waitForNamedHubs(page, ['h1'], { apiBaseUrl: API_BASE_URL });
    const h1 = String(hubs.h1 || '').toLowerCase();
    expect(h1).toMatch(/^0x[0-9a-f]{64}$/);
    const h1Endpoint = await resolveHubRuntimeEndpoint(page, baseline, 'H1');
    const adminKey = (await resolveRuntimeImportCapability(page, h1Endpoint, 'admin')).token;
    const consoleProblems: string[] = [];
    page.on('console', message => {
      const text = message.text();
      if (/\[vite\]|Ignoring Event: localhost/.test(text)) return;
      if (message.type() === 'error' || message.type() === 'warning')
        consoleProblems.push(`${message.type()}: ${text}`);
    });
    page.on('pageerror', error => consoleProblems.push(`pageerror: ${error.message}`));

    const wire = await openReactRemoteWorkspace(page, h1Endpoint, adminKey, h1);

    await page.getByTestId('home-swap').click();
    await expect(page.getByTestId('swap-screen')).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });
    await expect(page.getByTestId('swap-give')).toBeVisible();
    await expect(page.getByTestId('swap-want')).toBeVisible();
    await expect(page.getByTestId('swap-submit')).toBeVisible();
    const book = page.locator('[data-testid="orderbook"]:visible');
    await expect(book).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });
    await expect(book).toHaveAttribute('data-source', 'relay');
    await expect(book).toHaveAttribute('data-status', 'live', { timeout: REMOTE_E2E_WAIT_MS });
    expect(wire.errors).toEqual([]);
    await expect(page.locator('body')).not.toContainText('Swap requires a live runtime frame.');
    await expect(page.locator('body')).not.toContainText('Swap projection is not available yet.');
    expect(consoleProblems.filter(message => /XLN environment not ready|TypeError|pageerror/i.test(message))).toEqual(
      [],
    );
  },
);

test('admin remote runtime opens normal app workspace', { tag: '@functional' }, async ({ page }) => {
  const baseline = await ensureE2EBaseline(page, { requireHubMesh: true, minHubCount: 3 });
  const hubs = await waitForNamedHubs(page, ['h1'], { apiBaseUrl: API_BASE_URL });
  const h1 = String(hubs.h1).toLowerCase();
  const h1Endpoint = await resolveHubRuntimeEndpoint(page, baseline, 'H1');
  const adminKey = (await resolveRuntimeImportCapability(page, h1Endpoint, 'admin')).token;
  const consoleProblems: string[] = [];
  page.on('console', message => {
    const text = message.text();
    if (/\[vite\]|Ignoring Event: localhost/.test(text)) return;
    if (message.type() === 'error' || message.type() === 'warning') consoleProblems.push(`${message.type()}: ${text}`);
  });
  page.on('pageerror', error => consoleProblems.push(`pageerror: ${error.message}`));

  const wire = await openReactRemoteWorkspace(page, h1Endpoint, adminKey, h1);
  await expect(page.locator('[data-testid="nav-home"]:visible')).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });

  const result = await page.evaluate(() => {
    const text = document.body.textContent || '';
    return {
      walletLens: Boolean(document.querySelector('[data-testid="entity-lens-wallet"]')),
      opsLens: Boolean(document.querySelector('[data-testid="entity-lens-ops"]')),
      liquidityLens: Boolean(document.querySelector('[data-testid="entity-lens-liquidity"]')),
      auditLens: Boolean(document.querySelector('[data-testid="entity-lens-audit"]')),
      settingsDataMounted:
        text.includes('IndexedDB') ||
        text.includes('Checkpoint') ||
        Boolean(document.querySelector('[data-testid="entity-settings-panel"]')),
      fullAccessWarning: text.includes('Account opening requires admin runtime access'),
    };
  });

  expect(result.walletLens).toBe(false);
  expect(result.opsLens).toBe(false);
  expect(result.liquidityLens).toBe(false);
  expect(result.auditLens).toBe(false);
  expect(result.settingsDataMounted).toBe(false);
  expect(result.fullAccessWarning).toBe(false);
  await expect(page.locator('[data-testid="entity-workspace-readonly"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="account-row"][data-counterparty-id]').first()).toBeVisible({
    timeout: REMOTE_E2E_WAIT_MS,
  });
  await page.getByTestId('home-open-account').click();
  await expect(page.getByRole('dialog', { name: 'Open account' })).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });
  expect(wire.errors).toEqual([]);
  expect(
    consoleProblems.filter(message =>
      /TypeError|unsupported adapter path|admin runtime access|pageerror/i.test(message),
    ),
  ).toEqual([]);
});

test(
  'admin remote runtime keeps raw RuntimeInput send private and account projection readable',
  { tag: '@resilience' },
  async ({ page }) => {
    const baseline = await ensureE2EBaseline(page, { requireHubMesh: true, minHubCount: 3 });
    const hubs = await waitForNamedHubs(page, ['h1'], { apiBaseUrl: API_BASE_URL });
    const h1 = String(hubs.h1 || '').toLowerCase();
    expect(h1).toMatch(/^0x[0-9a-f]{64}$/);

    const h1Endpoint = await resolveHubRuntimeEndpoint(page, baseline, 'H1');
    const adminKey = (await resolveRuntimeImportCapability(page, h1Endpoint, 'admin')).token;
    const consoleProblems: string[] = [];
    page.on('console', message => {
      const text = message.text();
      if (/\[vite\]|Ignoring Event: localhost/.test(text)) return;
      if (message.type() === 'error' || message.type() === 'warning')
        consoleProblems.push(`${message.type()}: ${text}`);
    });
    page.on('pageerror', error => consoleProblems.push(`pageerror: ${error.message}`));

    await page.goto(remoteRuntimeUrl('/app', h1Endpoint.wsUrl, adminKey), { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(h1.slice(0, 18)) }).click();
    await expect(page.getByTestId('home-entity-id')).toHaveText(h1);
    const result = await page.evaluate(
      async ({ hubId }) => {
        const adapter = (
          window as Window & { __xln?: { adapter: () => RuntimeAdapterInspection | null } }
        ).__xln?.adapter();
        if (!adapter) throw new Error('CURRENT_RUNTIME_INSPECTION_MISSING');
        type Head = { latestHeight?: number };
        type ViewFrame = {
          height?: number;
          activeEntity?: {
            accounts?: { items?: unknown[]; totalItems?: number };
          } | null;
        };

        const statusBefore = {
          authLevel: adapter.authLevel,
          runtimeId: adapter.runtimeId,
          height: adapter.currentHeight,
          commandReady: adapter.commandReady,
        };
        const headBefore = await adapter.read<Head>('head');
        const frameBefore = await adapter.read<ViewFrame>('view-frame', {
          entityId: hubId,
          accountsLimit: 10,
          booksLimit: 1,
        });

        const sendPresent = 'send' in adapter;

        const after = (
          window as Window & { __xln?: { adapter: () => RuntimeAdapterInspection | null } }
        ).__xln?.adapter();
        if (!after) throw new Error('CURRENT_RUNTIME_INSPECTION_LOST');
        const statusAfter = {
          authLevel: after.authLevel,
          runtimeId: after.runtimeId,
          height: after.currentHeight,
          commandReady: after.commandReady,
        };
        const headAfter = await after.read<Head>('head');
        const frameAfter = await after.read<ViewFrame>('view-frame', {
          entityId: hubId,
          accountsLimit: 10,
          booksLimit: 1,
        });
        return {
          authLevelBefore: String(statusBefore.authLevel || ''),
          authLevelAfter: String(statusAfter.authLevel || ''),
          commandReadyBefore: statusBefore.commandReady,
          runtimeId: statusBefore.runtimeId,
          commandReadyAfter: statusAfter.commandReady,
          sendPresent,
          beforeHeight: Number(headBefore.latestHeight || statusBefore.height || 0),
          afterHeight: Number(headAfter.latestHeight || statusAfter.height || 0),
          beforeFrameHeight: Number(frameBefore.height || 0),
          afterFrameHeight: Number(frameAfter.height || 0),
          visibleAccounts: Number(frameAfter.activeEntity?.accounts?.items?.length || 0),
          totalAccounts: Number(
            frameAfter.activeEntity?.accounts?.totalItems ?? frameAfter.activeEntity?.accounts?.items?.length ?? 0,
          ),
          readOnlyWarningCount: Array.from(document.body.querySelectorAll('*')).filter(node =>
            (node.textContent || '').includes('Account opening requires admin runtime access'),
          ).length,
        };
      },
      { hubId: h1 },
    );

    expect(result.authLevelBefore).toBe('admin');
    expect(result.authLevelAfter).toBe('admin');
    expect(result.commandReadyBefore).toBe(true);
    expect(result.runtimeId).toBe(h1Endpoint.runtimeId);
    expect(result.commandReadyAfter).toBe(true);
    expect(result.sendPresent).toBe(false);
    expect(result.beforeHeight).toBeGreaterThan(0);
    expect(result.afterHeight).toBeGreaterThanOrEqual(result.beforeHeight);
    expect(result.beforeFrameHeight).toBeGreaterThan(0);
    expect(result.afterFrameHeight).toBeGreaterThan(0);
    expect(result.visibleAccounts).toBeGreaterThan(0);
    expect(result.totalAccounts).toBeGreaterThan(0);
    expect(result.readOnlyWarningCount).toBe(0);
    expect(consoleProblems.filter(message => /TypeError|unsupported adapter path|pageerror/i.test(message))).toEqual(
      [],
    );
  },
);

test(
  'address explorer bootstraps remote runtime projection outside app shell',
  { tag: '@functional' },
  async ({ page }) => {
    const baseline = await ensureE2EBaseline(page, { requireHubMesh: true, minHubCount: 3 });
    const h1Endpoint = await resolveHubRuntimeEndpoint(page, baseline, 'H1');
    const adminKey = (await resolveRuntimeImportCapability(page, h1Endpoint, 'admin')).token;
    const consoleProblems: string[] = [];
    page.on('console', message => {
      const text = message.text();
      if (/\[vite\]|Ignoring Event: localhost/.test(text)) return;
      if (message.type() === 'error' || message.type() === 'warning')
        consoleProblems.push(`${message.type()}: ${text}`);
    });
    page.on('pageerror', error => consoleProblems.push(`pageerror: ${error.message}`));

    const directAddressUrl = remoteRuntimeUrl('/address', h1Endpoint.wsUrl, adminKey);
    await page.goto(directAddressUrl, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.empty.error')).toContainText('REMOTE_RUNTIME_CONSENT_REQUIRED', {
      timeout: REMOTE_E2E_WAIT_MS,
    });
    const addressBeforeConsent = await page.evaluate(() => ({
      adapterConnected: (window as any).__xln?.adapter?.status?.().connected === true,
      remoteMode: localStorage.getItem('xln-runtime-adapter-mode'),
      sessionKey: sessionStorage.getItem('xln-runtime-adapter-key'),
      acceptedKeys: Object.keys(sessionStorage).filter(key => key.startsWith('xln-remote-runtime-accepted:')),
    }));
    expect(addressBeforeConsent).toEqual({
      adapterConnected: false,
      remoteMode: null,
      sessionKey: null,
      acceptedKeys: [],
    });

    await page.goto(remoteRuntimeUrl('/health', h1Endpoint.wsUrl, adminKey), {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.locator('.panel.error')).toContainText('REMOTE_RUNTIME_CONSENT_REQUIRED', {
      timeout: REMOTE_E2E_WAIT_MS,
    });
    expect(await page.evaluate(() => sessionStorage.getItem('xln-runtime-adapter-key'))).toBeNull();

    await page.goto(remoteRuntimeUrl('/app', h1Endpoint.wsUrl, adminKey), {
      waitUntil: 'domcontentloaded',
    });
    await acceptRemoteRuntimeConsent(page);
    await page.goto(`${APP_BASE_URL}/address`, { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(
      () => {
        const view = window as typeof window & {
          __xlnRuntimeAdapter?: { status: () => { connected?: boolean; authLevel?: string | null; height?: number } };
        };
        const status = (view as any).__xln?.adapter?.status();
        return status?.connected === true && status.authLevel === 'admin' && Number(status.height || 0) > 0;
      },
      null,
      { timeout: REMOTE_E2E_WAIT_MS },
    );
    await page.waitForSelector('.row .address', { timeout: REMOTE_E2E_WAIT_MS });
    await page.waitForFunction(() => !location.href.includes('xlnra1.') && !location.search.includes('token='), null, {
      timeout: 10_000,
    });

    const directory = await page.evaluate(() => {
      const view = window as typeof window & {
        __xlnRuntimeAdapter?: { status: () => { connected?: boolean; authLevel?: string | null; height?: number } };
      };
      return {
        href: location.href,
        rows: document.querySelectorAll('.row').length,
        firstAddress: document.querySelector('.row .address')?.textContent?.trim() || '',
        adapter: (view as any).__xln?.adapter?.status() || null,
        storageMode: localStorage.getItem('xln-runtime-adapter-mode') || '',
        storageWs: localStorage.getItem('xln-runtime-adapter-ws') || '',
        sessionKeyPresent: Boolean(sessionStorage.getItem('xln-runtime-adapter-key')),
        errorText: document.querySelector('.error')?.textContent?.trim() || '',
      };
    });

    expect(directory.href).toBe(`${APP_BASE_URL}/address`);
    expect(directory.rows).toBeGreaterThan(0);
    expect(directory.firstAddress).toMatch(/^0x[0-9a-f]{64}$/);
    expect(directory.adapter?.connected).toBe(true);
    expect(directory.adapter?.authLevel).toBe('admin');
    expect(directory.storageMode).toBe('remote');
    expect(directory.storageWs).toBe(h1Endpoint.wsUrl);
    expect(directory.sessionKeyPresent).toBe(true);
    expect(directory.errorText).toBe('');

    await page.goto(`${APP_BASE_URL}/address/${encodeURIComponent(directory.firstAddress)}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('.identity-band .address', { timeout: REMOTE_E2E_WAIT_MS });
    const detail = await page.evaluate(() => ({
      address: document.querySelector('.identity-band .address')?.textContent?.trim() || '',
      historyTab: document.querySelector('[data-testid="entity-history-tab"]')?.textContent?.trim() || '',
      errorText: document.querySelector('.panel.error')?.textContent?.trim() || '',
    }));

    expect(detail.address).toBe(directory.firstAddress);
    expect(detail.historyTab).toBe('History');
    expect(detail.errorText).toBe('');
    expect(
      consoleProblems.filter(message =>
        /projection read failed|Runtime adapter is not connected|Cannot call replaceState|Insufficient resources|TypeError|pageerror/i.test(
          message,
        ),
      ),
    ).toEqual([]);
  },
);

test(
  'admin remote runtime opens settings projection without retired RuntimeReplica settings',
  { tag: '@functional' },
  async ({ page }) => {
    const baseline = await ensureE2EBaseline(page, { requireHubMesh: true, minHubCount: 3 });
    const h1Endpoint = await resolveHubRuntimeEndpoint(page, baseline, 'H1');
    const adminKey = (await resolveRuntimeImportCapability(page, h1Endpoint, 'admin')).token;
    const consoleProblems: string[] = [];
    page.on('console', message => {
      if (message.type() === 'error') consoleProblems.push(message.text());
    });
    page.on('pageerror', error => consoleProblems.push(`pageerror:${error.message}`));

    await page.goto(remoteRuntimeUrl('/app', h1Endpoint.wsUrl, adminKey), { waitUntil: 'domcontentloaded' });
    await acceptRemoteRuntimeConsent(page);

    await page.waitForFunction(
      () => {
        const view = window as typeof window & {
          __xlnRuntimeView?: { height?: number };
          __xlnRuntimeAdapter?: { status: () => { connected?: boolean; authLevel?: string | null } };
        };
        const status = (view as any).__xln?.adapter?.status();
        return (
          status?.connected === true &&
          status.authLevel === 'admin' &&
          Number((view as any).__xln?.view?.height || 0) > 0
        );
      },
      null,
      { timeout: REMOTE_E2E_WAIT_MS },
    );

    await page.getByTestId('tab-settings').click();
    await page.waitForSelector('[data-testid="entity-settings-projection-panel"]', { timeout: REMOTE_E2E_WAIT_MS });

    const result = await page.evaluate(() => {
      const text = document.body.textContent || '';
      const panel = document.querySelector('[data-testid="entity-settings-projection-panel"]');
      const saveButton = panel?.querySelector('button[type="submit"]');
      return {
        projectionPanel: Boolean(panel),
        saveDisabled: saveButton?.hasAttribute('disabled') ?? true,
        localSettingsMounted:
          Boolean(document.querySelector('.entity-settings')) ||
          text.includes('IndexedDB') ||
          text.includes('Recovery Services') ||
          text.includes('Add Jurisdiction') ||
          text.includes('Push Wake'),
        fullAccessWarning: text.includes('Account opening requires admin runtime access'),
      };
    });

    expect(result.projectionPanel).toBe(true);
    expect(result.saveDisabled).toBe(false);
    expect(result.localSettingsMounted).toBe(false);
    expect(result.fullAccessWarning).toBe(false);
    expect(
      consoleProblems.filter(message =>
        /TypeError|unsupported adapter path|admin runtime access|pageerror/i.test(message),
      ),
    ).toEqual([]);
  },
);

test('health admin keeps QA evidence link-only and runtime adapter local', { tag: '@resilience' }, async ({ page }) => {
  const baseline = await ensureE2EBaseline(page, { requireHubMesh: true, minHubCount: 3 });
  const h1Endpoint = await resolveHubRuntimeEndpoint(page, baseline, 'H1');
  const wsUrl = h1Endpoint.wsUrl;
  const adminKey = (await resolveRuntimeImportCapability(page, h1Endpoint, 'admin')).token;
  const qaApiRequests: string[] = [];
  const debugProjectionRequests: string[] = [];
  const consoleProblems: string[] = [];
  page.on('console', message => {
    if (message.type() === 'error') consoleProblems.push(message.text());
  });
  page.on('pageerror', error => consoleProblems.push(`pageerror:${error.message}`));
  await page.route('**/api/qa/**', async route => {
    qaApiRequests.push(route.request().url());
    await route.abort('blockedbyclient');
  });
  await page.route('**/api/debug/events**', async route => {
    debugProjectionRequests.push(route.request().url());
    await route.abort('blockedbyclient');
  });
  await page.route('**/api/debug/entities**', async route => {
    debugProjectionRequests.push(route.request().url());
    await route.abort('blockedbyclient');
  });

  await page.goto(`${APP_BASE_URL}/health`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toContainText('xln health admin', { timeout: REMOTE_E2E_WAIT_MS });
  await expect(page.locator('body')).toContainText('Runtime Events', { timeout: REMOTE_E2E_WAIT_MS });
  await expect(page.locator('body')).toContainText('Runtime Projection Entities', { timeout: REMOTE_E2E_WAIT_MS });
  await expect(page.locator('body')).not.toContainText('Debug Events');
  await expect(page.locator('body')).not.toContainText('Registered Gossip Entities');
  await expect(page.getByTestId('health-verdict-banner')).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });
  await expect(page.getByTestId('health-verdict-status')).toContainText(/READY|DEGRADED|FAIL/);
  await expect(page.getByTestId('health-verdict-reason')).not.toHaveText('');
  await expect(page.getByTestId('health-verdict-source-height')).toContainText(/source #[1-9]/, {
    timeout: REMOTE_E2E_WAIT_MS,
  });
  await expect(page.getByTestId('health-verdict-code-hash')).toContainText(/code [0-9a-f]{8}/);
  await expect(page.getByTestId('health-verdict-owner')).toContainText(/owner health/);
  await expect(page.locator('#bootstrap')).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });
  await expect(page.getByTestId('bootstrap-timeline')).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });
  await expect(page.getByTestId('bootstrap-timeline-ready-hash')).not.toHaveText(/n\/a/i, {
    timeout: REMOTE_E2E_WAIT_MS,
  });
  await expect(page.getByTestId('bootstrap-timeline-health-poll')).toContainText(/ms/);
  await expect(page.getByTestId('bootstrap-timeline-backlog')).not.toHaveText('');
  await expect(page.getByTestId('bootstrap-timeline-last-event')).not.toHaveText(/n\/a/i, {
    timeout: REMOTE_E2E_WAIT_MS,
  });
  await expect(page.getByTestId('bootstrap-timeline-stage-preflight')).toContainText(/done|active|blocked|pending/i);
  await expect(page.getByTestId('bootstrap-timeline-stage-hub-mesh')).toContainText(/done/i);
  await expect(page.getByTestId('bootstrap-timeline-stage-health-poll')).toContainText(/actual/i);
  const cockpitPanel = page.locator('#qa-cockpit');
  await expect(cockpitPanel).toBeVisible();
  await expect(cockpitPanel).toContainText('QA Evidence');
  await expect(cockpitPanel.getByRole('link', { name: 'Open QA cockpit' })).toHaveAttribute('href', '/qa');
  await expect(cockpitPanel.getByRole('link', { name: 'UX gallery' })).toHaveAttribute('href', '/qa');
  await expect(page.locator('#qa-runs')).toHaveCount(0);
  await expect(page.locator('iframe[title="QA Cockpit"]')).toHaveCount(0);
  expect(qaApiRequests, '/health must not read /api/qa; QA cockpit owns that surface').toEqual([]);
  expect(
    debugProjectionRequests,
    '/health must read runtime projections through RuntimeQueryClient, not retired debug entity/event APIs',
  ).toEqual([]);
  expect(
    consoleProblems.filter(message =>
      /Failed to fetch health|Runtime adapter is not connected|pageerror/i.test(message),
    ),
  ).toEqual([]);
  await expect(page.locator('#runtime-adapter')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open app' })).toHaveAttribute('href', '/ui/');

  const adapterPanel = page.locator('#runtime-adapter');
  await adapterPanel.locator('input[placeholder="ws://127.0.0.1:8080/rpc"]').fill(wsUrl);
  await adapterPanel.locator('input[placeholder="read/admin token"]').fill(adminKey);
  await adapterPanel.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(adapterPanel).toContainText('connected', { timeout: REMOTE_E2E_WAIT_MS });
  await expect(adapterPanel).toContainText('admin', { timeout: REMOTE_E2E_WAIT_MS });
  await page.waitForFunction(
    () => {
      const panel = document.querySelector('#runtime-adapter');
      const text = panel?.textContent || '';
      return /Entities\s+[1-9]/.test(text) && /Latest\s+[1-9]/.test(text);
    },
    null,
    { timeout: REMOTE_E2E_WAIT_MS },
  );

  // Editing the form does not change the already authenticated navigation target.
  await adapterPanel.locator('input[placeholder="ws://127.0.0.1:8080/rpc"]').fill('wss://untrusted.invalid/rpc');
  await adapterPanel.locator('input[placeholder="read/admin token"]').fill('unused-edited-key');
  const openWallet = page.getByRole('link', { name: 'Open app', exact: true });
  const walletHref = await openWallet.getAttribute('href');
  if (!walletHref) throw new Error('HEALTH_REMOTE_WALLET_LINK_MISSING');
  const link = new URL(walletHref, page.url());
  expect(link.pathname).toBe('/ui/');
  expect(link.search).toBe('');
  expect(new URLSearchParams(link.hash.slice(1)).get('ws')).toBe(wsUrl);
  expect(new URLSearchParams(link.hash.slice(1)).get('token')).toBe(adminKey);
  const hubs = await waitForNamedHubs(page, ['h1'], { apiBaseUrl: API_BASE_URL });
  const h1 = String(hubs.h1).toLowerCase();
  await openWallet.click();
  await expect(page.getByLabel('Runtime endpoint', { exact: true })).toHaveValue(wsUrl);
  await expect(page.getByLabel('Access key · optional', { exact: true })).toHaveValue(adminKey);
  expect(new URL(page.url()).hash).toBe('');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(h1.slice(0, 18)) }).click();
  await expect(page.locator('[data-testid="nav-home"]:visible')).toBeVisible();
  await expect(page.getByTestId('home-entity-id')).toHaveText(h1);
  const appState = await page.evaluate(() => {
    const adapter = (window as Window & { __xln?: { adapter: () => RuntimeAdapter | null } }).__xln?.adapter();
    if (!adapter) throw new Error('HEALTH_REMOTE_WALLET_ADAPTER_MISSING');
    return {
      url: window.location.href,
      runtimeId: adapter.runtimeId,
      status: adapter.status,
      authLevel: adapter.authLevel,
      activeWsUrl: localStorage.getItem('xln-runtime-adapter-ws'),
      storedAccess: localStorage.getItem('xln-runtime-adapter-access'),
      sessionKey: sessionStorage.getItem('xln-runtime-adapter-key'),
      persistentKey: localStorage.getItem('xln-runtime-adapter-key'),
    };
  });
  expect(appState.runtimeId).toBe(h1Endpoint.runtimeId);
  expect(appState.status).toBe('connected');
  expect(appState.authLevel).toBe('admin');
  expect(appState.url).not.toContain('runtime=remote');
  expect(appState.url).not.toContain('ws=');
  expect(appState.activeWsUrl).toBe(wsUrl);
  expect(appState.storedAccess).toBe('admin');
  expect(appState.sessionKey).toBe(adminKey);
  expect(appState.persistentKey).toBeNull();

  await page.goto(`${APP_BASE_URL}/radapter?ws=${encodeURIComponent(wsUrl)}&token=forbidden`, {
    waitUntil: 'domcontentloaded',
  });
  // Static deployments reject query capabilities in the client; no secret is adopted.
  await expect(page.getByRole('heading', { name: '400' })).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });
  await expect(page.getByText('REMOTE_RUNTIME_QUERY_BOOTSTRAP_FORBIDDEN')).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('xln-runtime-adapter-key'))).toBe(adminKey);
  await page.goto(`${APP_BASE_URL}/radapter`, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/ui\/$/);
  // The current wallet does not infer permission to reconnect from another app's registry.
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as Window & { __xln?: { adapter: () => RuntimeAdapter | null } }).__xln?.adapter(),
    ),
  ).toBeNull();

  await page.goto(`${APP_BASE_URL}/admin`, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/health$/);
  await expect(page.getByRole('heading', { name: 'xln health admin' })).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });
});

test(
  'real H2 replacement gates browser money commands until verified restore',
  { tag: '@resilience' },
  async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    allowBrowserIssue({
      type: 'console',
      severity: 'error',
      message:
        /WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/rpc' failed: Error in connection establishment: net::ERR_CONNECTION_REFUSED/,
    });
    allowBrowserIssue({
      type: 'console',
      severity: 'error',
      message: /\[radapter-client\] socket closed: code=1006 reason="" url=ws:\/\/127\.0\.0\.1:\d+\/rpc/,
    });
    allowBrowserIssue({
      type: 'http',
      severity: 'error',
      status: 503,
      url: '/api/external-wallet/snapshot',
    });
    allowBrowserIssue({
      type: 'console',
      severity: 'error',
      message: 'Failed to load resource: the server responded with a status of 503',
      url: '/app#accounts',
    });
    allowDebugIncident({
      source: 'orchestrator',
      code: 'CHILD_UNEXPECTED_EXIT',
      message: 'child.unexpected_exit',
    });
    allowDebugIncident({
      source: 'orchestrator',
      code: 'H2_UNEXPECTED_EXIT',
      message: 'H2_UNEXPECTED_EXIT code=null signal=SIGKILL',
    });

    const baseline = await ensureE2EBaseline(page, { requireHubMesh: true, minHubCount: 3 });
    const hubs = await waitForNamedHubs(page, ['h1', 'h2'], { apiBaseUrl: API_BASE_URL });
    const h1 = String(hubs.h1 || '').toLowerCase();
    const h2Endpoint = await resolveHubRuntimeEndpoint(page, baseline, 'H2');
    const adminKey = (await resolveRuntimeImportCapability(page, h2Endpoint, 'admin')).token;

    await page.goto(remoteRuntimeUrl('/app', h2Endpoint.wsUrl, adminKey), { waitUntil: 'domcontentloaded' });
    await acceptRemoteRuntimeConsent(page);
    await expect(page.getByTestId('entity-workspace')).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });
    await expect
      .poll(
        async () =>
          await page.evaluate(() => {
            const status = (window as any).__xln?.adapter?.status?.();
            return {
              connected: status?.connected === true,
              authLevel: String(status?.authLevel || ''),
              commandReady: status?.commandReady === true,
              runtimeId: String((window as any).__xln?.view?.runtimeId || '').toLowerCase(),
            };
          }),
        {
          timeout: 30_000,
          intervals: [100, 250, 500],
        },
      )
      .toEqual({
        connected: true,
        authLevel: 'admin',
        commandReady: true,
        runtimeId: h2Endpoint.runtimeId,
      });

    await openAccountWorkspaceTab(page, 'open');
    const recipient = page.locator('input[placeholder="Select or paste entity ID"]:visible').first();
    await expect(recipient).toBeVisible();
    await recipient.fill(h1);
    const submit = page.getByTestId('open-account-submit');
    await expect(submit).toBeEnabled();

    const beforeStatus = await page.evaluate(() => {
      const status = (window as any).__xln?.adapter?.status?.();
      return {
        height: Number(status?.height || 0),
        runtimeId: String((window as any).__xln?.view?.runtimeId || '').toLowerCase(),
      };
    });
    const beforePersisted = await page.evaluate(async () => {
      const adapter = (window as any).__xln?.adapter;
      const head = await adapter.query.head();
      const latestHeight = Number(head?.latestHeight || 0);
      const frame = await adapter.query.frame(latestHeight);
      return {
        latestHeight,
        frameHash: String(frame?.frameHash || ''),
        postStateHash: String(frame?.postStateHash || ''),
        stateHash: String(frame?.stateHash || ''),
        canonicalStateHash: String(frame?.canonicalStateHash || ''),
        commitment: String(frame?.postStateHash || ''),
      };
    });
    expect(beforePersisted.latestHeight).toBeGreaterThan(0);
    expect(beforePersisted.commitment).toMatch(/^0x[0-9a-f]{64}$/);
    const beforeHealth = await getHealth(page, API_BASE_URL);
    const h2Process = beforeHealth?.process?.children?.find(child => child.role === 'hub' && child.name === 'H2');
    expect(
      h2Process?.online,
      `H2 process missing before replacement: ${JSON.stringify(beforeHealth?.process ?? {})}`,
    ).toBe(true);
    expect(h2Process?.pid, 'H2 PID must be visible to the isolated local operator test').toBeGreaterThan(0);
    const oldPid = Number(h2Process!.pid);
    const oldRestartCount = Number(h2Process!.restartCount ?? 0);

    await page.evaluate(() => {
      const global = window as typeof window & {
        __xln?: { adapter?: { status?: () => Record<string, unknown> } };
        __xlnH2TransitionProbe?: {
          samples: Array<Record<string, unknown>>;
          timer: ReturnType<typeof setInterval>;
        };
      };
      const samples: Array<Record<string, unknown>> = [];
      const sample = (): void => {
        const status = global.__xln?.adapter?.status?.();
        const next = {
          at: performance.now(),
          connected: status?.['connected'] === true,
          authLevel: String(status?.['authLevel'] || ''),
          commandReady: status?.['commandReady'] === true,
          reason: String(status?.['commandReadyReason'] || ''),
          gate: document.querySelector('[data-testid="runtime-command-gate"]') !== null,
          unavailable: document.querySelector('[data-testid="entity-workspace-action-unavailable"]') !== null,
          submitDisabled:
            (document.querySelector('[data-testid="open-account-submit"]') as HTMLButtonElement | null)?.disabled ??
            null,
        };
        const previous = samples.at(-1);
        if (!previous || JSON.stringify({ ...previous, at: 0 }) !== JSON.stringify({ ...next, at: 0 })) {
          samples.push(next);
        }
      };
      sample();
      global.__xlnH2TransitionProbe = { samples, timer: setInterval(sample, 10) };
    });

    process.kill(oldPid, 'SIGKILL');

    await expect
      .poll(
        async () =>
          await page.evaluate(
            () =>
              (window as any).__xlnH2TransitionProbe?.samples?.some((sample: any) => sample.commandReady === false) ===
              true,
          ),
        {
          timeout: 15_000,
          intervals: [25, 50, 100],
        },
      )
      .toBe(true);
    const transitionProbe = await page.evaluate(() => {
      const probe = (window as any).__xlnH2TransitionProbe;
      if (probe?.timer) clearInterval(probe.timer);
      return probe?.samples ?? [];
    });
    await testInfo.attach('h2-runtime-transition.json', {
      body: Buffer.from(JSON.stringify(transitionProbe, null, 2)),
      contentType: 'application/json',
    });

    const gate = page.getByTestId('runtime-command-gate');
    await expect(gate).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => (await submit.count()) === 0 || (await submit.isDisabled())).toBe(true);
    await expect(page.getByTestId('runtime-command-gate-reason')).toHaveText(
      /adapter-(?:error|connecting|disconnected)|phase=(?:quiescing|restoring|halted)/,
    );
    await expect(page.getByTestId('runtime-command-gate-incident')).toHaveText(/^h2_unexpected_exit-/, {
      timeout: 15_000,
    });
    await captureLocatorScreenshot(gate, testInfo, 'runtime-command-gate-real-h2-replacement.png', {
      ux: {
        title: 'Real H2 replacement command gate',
        group: 'system-health',
        description:
          'A live admin wallet disables money commands and links the durable H2 root incident during managed replacement.',
        platform: 'desktop',
        tags: ['runtime', 'incident', 'restart', 'fail-stop'],
      },
    });

    await expect
      .poll(
        async () => {
          const health = await getHealth(page, API_BASE_URL);
          const child = health?.process?.children?.find(
            candidate => candidate.role === 'hub' && candidate.name === 'H2',
          );
          return {
            replaced: Number(child?.pid ?? 0) > 0 && Number(child?.pid) !== oldPid,
            restarted: Number(child?.restartCount ?? 0) > oldRestartCount,
            online: child?.online === true,
            systemOk: health?.systemOk === true,
          };
        },
        {
          timeout: 90_000,
          intervals: [250, 500, 1_000],
          message: 'orchestrator must replace H2 and restore authoritative health',
        },
      )
      .toEqual({
        replaced: true,
        restarted: true,
        online: true,
        systemOk: true,
      });

    await expect
      .poll(
        async () =>
          await page.evaluate(() => {
            const status = (window as any).__xln?.adapter?.status?.();
            return {
              connected: status?.connected === true,
              authLevel: String(status?.authLevel || ''),
              commandReady: status?.commandReady === true,
              runtimeId: String((window as any).__xln?.view?.runtimeId || '').toLowerCase(),
            };
          }),
        {
          timeout: 60_000,
          intervals: [250, 500, 1_000],
          message: 'browser adapter must reconnect to the same verified H2 runtime',
        },
      )
      .toEqual({
        connected: true,
        authLevel: 'admin',
        commandReady: true,
        runtimeId: beforeStatus.runtimeId,
      });
    await expect(gate).toBeHidden();
    await expect(recipient).toBeVisible();
    await recipient.fill(h1);
    await expect(submit).toBeEnabled();
    const restoredHeight = await page.evaluate(() => Number((window as any).__xln?.adapter?.status?.().height || 0));
    expect(restoredHeight).toBeGreaterThanOrEqual(beforeStatus.height);
    const restoredPersisted = await page.evaluate(async committedHeight => {
      const adapter = (window as any).__xln?.adapter;
      const head = await adapter.query.head();
      const frame = await adapter.query.frame(committedHeight);
      return {
        latestHeight: Number(head?.latestHeight || 0),
        frameHash: String(frame?.frameHash || ''),
        postStateHash: String(frame?.postStateHash || ''),
        stateHash: String(frame?.stateHash || ''),
        canonicalStateHash: String(frame?.canonicalStateHash || ''),
        commitment: String(frame?.postStateHash || ''),
      };
    }, beforePersisted.latestHeight);
    expect(restoredPersisted.latestHeight).toBeGreaterThanOrEqual(beforePersisted.latestHeight);
    expect(restoredPersisted).toMatchObject({
      frameHash: beforePersisted.frameHash,
      postStateHash: beforePersisted.postStateHash,
      stateHash: beforePersisted.stateHash,
      canonicalStateHash: beforePersisted.canonicalStateHash,
      commitment: beforePersisted.commitment,
    });
    await testInfo.attach('h2-committed-state-recovery.json', {
      body: Buffer.from(JSON.stringify({ before: beforePersisted, restored: restoredPersisted }, null, 2)),
      contentType: 'application/json',
    });
  },
);
