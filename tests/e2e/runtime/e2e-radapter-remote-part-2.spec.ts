import type { RuntimeAdapter } from '../../../core/api/public/runtime-module';
import { decodeRuntimeAdapterMessage, decodeRuntimeAdapterBrowserMessage } from '../../../core/api/runtime-adapter/codec';
import type { RuntimeAdapterRequest } from '../../../core/api/runtime-adapter/types';
import { allowBrowserIssue, allowDebugIncident, expect, test } from '../../global-setup.mts';

import { APP_BASE_URL, API_BASE_URL, ensureE2EBaseline, getHealth, waitForNamedHubs } from '../../utils/e2e-baseline';

import { openAccountWorkspaceTab } from '../../utils/e2e-account-workspace';

import { acceptRemoteRuntimeConsent, resolveRuntimeImportAppUrl } from '../../utils/runtime/e2e-runtime-import';

import { closeRuntimeContext } from '../../utils/runtime/e2e-runtime-shutdown.mts';

import { HUB_MESH_CREDIT_AMOUNT } from '../../../core/orchestrator/mesh/mesh-common';

import { deriveRuntimeAdapterCapabilityToken } from '../../../core/api/runtime-adapter/security/auth';

import { captureLocatorScreenshot } from '../../utils/e2e-screenshots';

const REMOTE_RUNTIME_IMPORT_STORAGE_KEY = 'xln-remote-runtime-imports';

const REMOTE_RUNTIME_IMPORT_RESULT_STORAGE_KEY = 'xln-remote-runtime-import-last-result';

const REMOTE_E2E_WAIT_MS = 30_000;

/** Dual-j hubs publish `H1 Arrakis` / `H1 Tron`; import rows still match the runtime label. */
const runtimeEntityLabelMatches = (label: string, runtimeLabel: string): boolean => {
  const entityLabel = String(label || '').trim().toLowerCase();
  const expected = String(runtimeLabel || '').trim().toLowerCase();
  if (!entityLabel || !expected) return false;
  return entityLabel === expected
    || entityLabel.startsWith(`${expected} `)
    || entityLabel.startsWith(`${expected}(`);
};

const remoteRuntimeUrl = (path: string, wsUrl: string, token: string): string => {
  const hash = new URLSearchParams({ runtime: 'remote', ws: wsUrl, token });
  return `${APP_BASE_URL}${path}#${hash.toString()}`;
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

type ReactRuntimeWindow = Window & {
  __xln?: {
    adapter: () => RuntimeAdapter | null;
  };
};

type ObservedWireCommand = {
  request: Extract<RuntimeAdapterRequest, { op: 'send' }>;
  height: number;
  status: 'pending' | 'observed';
};

const observeRemoteCommands = (page: import('@playwright/test').Page, wsUrl: string) => {
  const commands: ObservedWireCommand[] = [];
  const reads: Array<{ request: Extract<RuntimeAdapterRequest, { op: 'read' }>; payload: unknown }> = [];
  page.on('websocket', socket => {
    if (socket.url() !== wsUrl) return;
    const requests = new Map<string, Extract<RuntimeAdapterRequest, { op: 'send' | 'read' }>>();
    socket.on('framesent', ({ payload }) => {
      const message = decodeRuntimeAdapterMessage(payload);
      if ('id' in message && (message.op === 'send' || message.op === 'read')) requests.set(message.id, message);
    });
    socket.on('framereceived', ({ payload }) => {
      const message =
        typeof payload === 'string'
          ? decodeRuntimeAdapterBrowserMessage(payload)
          : decodeRuntimeAdapterMessage(payload);
      if (!('inReplyTo' in message)) return;
      const request = requests.get(message.inReplyTo);
      if (!request) return;
      if (request.op === 'read') {
        if (message.ok) reads.push({ request, payload: message.payload });
        return;
      }
      if (!message.ok) throw new Error(`ADMIN_COMMAND_REJECTED:${message.error.code}:${message.error.message}`);
      const result = message.payload;
      if (
        !result ||
        typeof result !== 'object' ||
        !('height' in result) ||
        typeof result.height !== 'number' ||
        !('status' in result) ||
        (result.status !== 'pending' && result.status !== 'observed') ||
        !('commandSequence' in result) ||
        result.commandSequence !== request.commandSequence
      )
        throw new Error('ADMIN_COMMAND_WIRE_RESULT_INVALID');
      commands.push({ request, height: result.height, status: result.status });
    });
  });
  return { commands, reads };
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
      const adapter = (window as ReactRuntimeWindow).__xln?.adapter();
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
      const head = await adapter.read<Head>('head');
      const latestHeight = Number(head.latestHeight || 0);
      const frame =
        latestHeight > minHeight
          ? await adapter.read<ViewFrame>('view-frame', {
              atHeight: latestHeight,
              entityId: hubId,
              accountsLimit: 1,
              booksLimit: 1,
            })
          : null;
      const history =
        latestHeight > minHeight
          ? await adapter.read<HistoryBatch>('history-frame-batch', {
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
        projectedName === expectedName &&
        historyHeights.includes(minHeight) &&
        historyHeights.includes(latestHeight);
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
      // Committed-state contention is explicitly retryable; corrupt history is not.
      // Keep polling absent history and a pending height/name, but expose hard failures now.
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (!('retryable' in error) || error.retryable !== true) &&
        ['E_INTERNAL', 'E_BAD_PATH', 'E_BAD_QUERY', 'E_UNAUTHORIZED'].includes(String(error.code))
      ) {
        throw error;
      }
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

test(
  'admin remote runtime control advances live state and exposes past frames',
  { tag: '@functional' },
  async ({ page }) => {
    const baseline = await ensureE2EBaseline(page, { requireHubMesh: true, minHubCount: 3 });
    const hubs = await waitForNamedHubs(page, ['h1'], { apiBaseUrl: API_BASE_URL });
    const h1 = String(hubs.h1 || '').toLowerCase();
    expect(h1).toMatch(/^0x[0-9a-f]{64}$/);

    const h1Endpoint = await resolveHubRuntimeEndpoint(page, baseline, 'H1');
    const h2Endpoint = await resolveHubRuntimeEndpoint(page, baseline, 'H2');
    const wsUrl = h1Endpoint.wsUrl;

    const adminKey = (await resolveRuntimeImportCapability(page, h1Endpoint, 'admin')).token;
    const staleSessionToken = (await resolveRuntimeImportCapability(page, h2Endpoint, 'admin')).token;
    const { commands, reads } = observeRemoteCommands(page, wsUrl);
    const observed = (kind: string) =>
      commands.findLast(
        row =>
          row.status === 'observed' &&
          row.request.input.entityInputs?.some(input => input.entityTxs?.some(tx => tx.type === kind)),
      );
    await page.goto(remoteRuntimeUrl('/app', wsUrl, adminKey), { waitUntil: 'domcontentloaded' });
    await expect(page.getByLabel('Runtime endpoint', { exact: true })).toHaveValue(wsUrl);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(h1.slice(0, 18)) }).click();
    await expect(page.getByTestId('home-entity-id')).toHaveText(h1);
    const access = () =>
      page.evaluate(() => {
        const adapter = (window as ReactRuntimeWindow).__xln?.adapter();
        if (!adapter) throw new Error('ADMIN_REACT_ADAPTER_MISSING');
        return { runtimeId: adapter.runtimeId, authLevel: adapter.authLevel, status: adapter.status };
      });
    expect(await access()).toEqual({ runtimeId: h1Endpoint.runtimeId, authLevel: 'admin', status: 'connected' });

    // Another app's import rows and another Runtime's session capability cannot silently
    // authorize this wallet. Reopening requires explicit current endpoint/key consent.
    await page.evaluate(
      ({ wsUrl, adminKey, staleSessionToken, runtimeId }) => {
        localStorage.setItem(
          'xln-remote-runtime-imports',
          JSON.stringify([{ wsUrl, token: adminKey, runtimeId, access: 'admin' }]),
        );
        sessionStorage.setItem('xln-runtime-adapter-key', staleSessionToken);
      },
      { wsUrl, adminKey, staleSessionToken, runtimeId: h1Endpoint.runtimeId },
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByLabel('Runtime endpoint', { exact: true })).toHaveValue(wsUrl);
    await expect(page.getByLabel('Access key · optional', { exact: true })).toHaveValue('');
    expect(await page.evaluate(() => (window as ReactRuntimeWindow).__xln?.adapter())).toBeNull();
    await page.getByLabel('Access key · optional', { exact: true }).fill(adminKey);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(h1.slice(0, 18)) }).click();
    await expect(page.getByTestId('home-entity-id')).toHaveText(h1);
    expect(await access()).toEqual({ runtimeId: h1Endpoint.runtimeId, authLevel: 'admin', status: 'connected' });

    const before = await page.evaluate(async hubId => {
      const adapter = (window as ReactRuntimeWindow).__xln?.adapter();
      if (!adapter) throw new Error('XLN_RUNTIME_ADAPTER_DEBUG_SURFACE_MISSING');
      type ViewFrame = {
        height?: number;
        activeEntity?: {
          core?: { signerId?: string; profile?: { name?: string; isHub?: boolean } };
          accounts?: { items?: unknown[]; totalItems?: number };
        } | null;
      };
      const head = await adapter.read<{ latestHeight?: number }>('head');
      const frame = await adapter.read<ViewFrame>('view-frame', {
        entityId: hubId,
        accountsLimit: 10,
        booksLimit: 1,
      });
      const height = Math.max(Number(head.latestHeight || 0), Number(frame.height || 0));
      const history = await adapter.read<{ frames?: Array<{ height?: number }> }>('history-frame-batch', {
        heights: [height],
        entityId: hubId,
        accountsLimit: 1,
        booksLimit: 1,
      });
      const historyHeights = (history.frames ?? []).map(item => Number(item.height || 0));
      return {
        height,
        historyLength: historyHeights.length,
        historyHeights,
        signerId: String(frame.activeEntity?.core?.signerId || ''),
        profileName: String(frame.activeEntity?.core?.profile?.name || ''),
        isHub: frame.activeEntity?.core?.profile?.isHub === true,
        accountCount: Number(
          frame.activeEntity?.accounts?.totalItems ?? frame.activeEntity?.accounts?.items?.length ?? 0,
        ),
      };
    }, h1);

    expect(before.height).toBeGreaterThan(0);
    expect(before.historyLength).toBeGreaterThan(0);
    expect(before.historyLength).toBeLessThanOrEqual(12);
    expect(before.historyHeights).toContain(before.height);
    expect(before.isHub).toBe(true);
    expect(before.accountCount).toBeLessThanOrEqual(10);

    const activeH1Before = await page.evaluate(async entityId => {
      const adapter = (window as ReactRuntimeWindow).__xln?.adapter();
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
    expect(activeH1Before.accountCount).toBeGreaterThan(0);
    expect(activeH1Before.accountCount).toBeLessThanOrEqual(10);
    expect(activeH1Before.bookCount).toBeLessThanOrEqual(10);

    await page.getByTestId('account-row').filter({ hasText: /H2/i }).first().click();
    await page.getByTestId('account-extend-credit').click();
    const creditPanel = page.getByRole('dialog', { name: 'Extend credit' });
    await creditPanel.getByPlaceholder('0.00').fill('1');
    await creditPanel.getByRole('button', { name: 'Extend credit', exact: true }).click();
    await expect.poll(() => observed('extendCredit'), { timeout: REMOTE_E2E_WAIT_MS }).toBeDefined();
    const creditCommand = observed('extendCredit');
    if (!creditCommand) throw new Error('CREDIT_COMMAND_NOT_OBSERVED');
    expect(creditCommand.request.input.entityInputs).toHaveLength(1);
    expect(creditCommand.request.input.entityInputs?.[0]?.entityTxs).toHaveLength(1);
    expect(creditCommand.height).toBeGreaterThan(activeH1Before.height);

    const storageCadence = await page.evaluate(async () => {
      const adapter = (window as ReactRuntimeWindow).__xln?.adapter();
      if (!adapter) throw new Error('XLN_RUNTIME_ADAPTER_DEBUG_SURFACE_MISSING');
      const head = await adapter.read<{
        latestHeight?: number;
        latestSnapshotHeight?: number;
        snapshotPeriodFrames?: number;
        retainedWalBytes?: number;
      }>('head');
      const checkpoints = await adapter.read<Array<{ height?: number }>>('checkpoints');
      return {
        latestHeight: Number(head.latestHeight || 0),
        latestSnapshotHeight: Number(head.latestSnapshotHeight || 0),
        snapshotPeriodFrames: Number(head.snapshotPeriodFrames || 0),
        retainedWalBytes: Number(head.retainedWalBytes || 0),
        checkpointHeights: checkpoints.map(entry => Number(entry.height || 0)),
      };
    });

    expect(storageCadence.latestHeight).toBeGreaterThanOrEqual(activeH1Before.height);
    expect(storageCadence.snapshotPeriodFrames).toBeGreaterThan(0);
    expect(storageCadence.latestSnapshotHeight).toBeGreaterThan(0);
    expect(storageCadence.checkpointHeights).toContain(storageCadence.latestSnapshotHeight);

    const baseName = `H1 Admin E2E ${activeH1Before.height + 1}`;
    const nextProfileName = activeH1Before.profileName === baseName ? `${baseName}b` : baseName;
    const beforeControlHeight = await page.evaluate(async () => {
      const adapter = (window as ReactRuntimeWindow).__xln?.adapter();
      if (!adapter) throw new Error('XLN_RUNTIME_ADAPTER_DEBUG_SURFACE_MISSING');
      const head = await adapter.read<{ latestHeight?: number }>('head');
      return Number(head.latestHeight || 0);
    });
    await page.locator('[data-testid="nav-settings"]:visible').click();
    await page.getByTestId('profile-name').fill(nextProfileName);
    await page.getByTestId('profile-bio').fill('admin-e2e-control');
    await page.getByTestId('profile-publish').click();
    await expect.poll(() => observed('profile-update'), { timeout: REMOTE_E2E_WAIT_MS }).toBeDefined();
    const profileCommand = observed('profile-update');
    if (!profileCommand) throw new Error('PROFILE_COMMAND_NOT_OBSERVED');
    expect(profileCommand.request.commandId).toMatch(/^[A-Za-z0-9._:-]{16,128}$/);
    expect(profileCommand.request.commandSequence).toBeGreaterThan(creditCommand.request.commandSequence);
    expect(profileCommand.request.input.entityInputs).toHaveLength(1);
    expect(profileCommand.request.input.entityInputs?.[0]?.entityTxs).toHaveLength(1);
    expect(profileCommand.height).toBeGreaterThan(beforeControlHeight);
    const controlResult = { beforeHeight: beforeControlHeight };
    const after = await waitForAdminControlProbe(
      page,
      { hubId: h1, minHeight: beforeControlHeight, expectedName: nextProfileName },
      REMOTE_E2E_WAIT_MS,
    );
    expect(after.envHeight).toBeGreaterThanOrEqual(profileCommand.height);
    await expect(page.getByTestId('runtime-command-receipt')).toBeHidden();

    expect(after.envHeight).toBeGreaterThan(controlResult.beforeHeight);
    expect(after.envName).toBe(nextProfileName);
    expect(after.accountCount).toBeLessThanOrEqual(10);
    expect(after.historyLength).toBeGreaterThanOrEqual(2);
    expect(after.historyLength).toBeLessThanOrEqual(12);
    expect(after.historyHeights).toContain(controlResult.beforeHeight);
    expect(after.historyHeights).toContain(after.envHeight);

    const activityProbe = await page.evaluate(async entityId => {
      const adapter = (window as ReactRuntimeWindow).__xln?.adapter();
      if (!adapter) throw new Error('XLN_RUNTIME_ADAPTER_DEBUG_SURFACE_MISSING');
      type ActivityPage = {
        latestHeight?: number;
        scannedFrames?: number;
        events?: Array<{
          height?: number;
          entityId?: string;
          title?: string;
          rawType?: string;
          source?: string;
        }>;
      };
      const page = await adapter.read<ActivityPage>('activity', {
        entityId,
        limit: 20,
        scanLimit: 200,
        q: 'profile-update',
      });
      return {
        latestHeight: Number(page.latestHeight || 0),
        scannedFrames: Number(page.scannedFrames || 0),
        events: (page.events ?? []).map(event => ({
          height: Number(event.height || 0),
          entityId: String(event.entityId || '').toLowerCase(),
          title: String(event.title || ''),
          rawType: String(event.rawType || ''),
          source: String(event.source || ''),
        })),
      };
    }, h1);

    expect(activityProbe.latestHeight).toBeGreaterThanOrEqual(after.envHeight);
    expect(activityProbe.scannedFrames).toBeGreaterThan(0);
    expect(
      activityProbe.events.some(
        event =>
          event.entityId === h1 &&
          event.rawType === 'profile-update' &&
          event.source === 'runtime_input' &&
          event.height > controlResult.beforeHeight,
      ),
      `activity projection must expose remote profile-update event: ${JSON.stringify(activityProbe)}`,
    ).toBe(true);

    const frameProbe = await page.evaluate(
      async ({ entityId, beforeHeight, afterHeight }) => {
        const adapter = (window as ReactRuntimeWindow).__xln?.adapter();
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
      },
      {
        entityId: h1,
        beforeHeight: controlResult.beforeHeight,
        afterHeight: after.envHeight,
      },
    );

    expect(frameProbe.beforeHeight).toBe(controlResult.beforeHeight);
    expect(frameProbe.afterHeight).toBe(after.envHeight);
    expect(frameProbe.beforeName).toBe(activeH1Before.profileName);
    expect(frameProbe.beforeName).not.toBe(nextProfileName);
    expect(frameProbe.afterName).toBe(nextProfileName);
    expect(frameProbe.beforeAccounts).toBeLessThanOrEqual(1);
    expect(frameProbe.afterAccounts).toBeLessThanOrEqual(1);
    expect(frameProbe.beforeBooks).toBeLessThanOrEqual(1);
    expect(frameProbe.afterBooks).toBeLessThanOrEqual(1);

    const batchProbe = await page.evaluate(
      async ({ entityId, beforeHeight, afterHeight }) => {
        const adapter = (window as ReactRuntimeWindow).__xln?.adapter();
        if (!adapter) throw new Error('XLN_RUNTIME_ADAPTER_DEBUG_SURFACE_MISSING');
        type HistoryBatch = {
          requestedHeights?: number[];
          frames?: Array<{
            height?: number;
            activeEntity?: {
              accounts?: { items?: unknown[] };
              books?: { items?: unknown[] };
            } | null;
          }>;
          unavailable?: Array<{ height?: number; code?: string; message?: string }>;
        };
        const batch = await adapter.read<HistoryBatch>('history-frame-batch', {
          heights: [beforeHeight, afterHeight],
          entityId,
          accountsLimit: 1,
          booksLimit: 1,
        });
        return {
          requestedHeights: batch.requestedHeights ?? [],
          frameHeights: (batch.frames ?? []).map(frame => Number(frame.height || 0)),
          accountCounts: (batch.frames ?? []).map(frame => Number(frame.activeEntity?.accounts?.items?.length || 0)),
          bookCounts: (batch.frames ?? []).map(frame => Number(frame.activeEntity?.books?.items?.length || 0)),
          unavailable: batch.unavailable ?? [],
        };
      },
      {
        entityId: h1,
        beforeHeight: controlResult.beforeHeight,
        afterHeight: after.envHeight,
      },
    );

    expect(batchProbe.requestedHeights).toEqual([controlResult.beforeHeight, after.envHeight]);
    expect(batchProbe.frameHeights).toEqual([controlResult.beforeHeight, after.envHeight]);
    expect(batchProbe.accountCounts.every(count => count <= 1)).toBe(true);
    expect(batchProbe.bookCounts.every(count => count <= 1)).toBe(true);
    expect(batchProbe.unavailable).toEqual([]);

    await page.evaluate(() => {
      localStorage.removeItem('xln-remote-runtime-imports');
      sessionStorage.removeItem('xln-runtime-adapter-key');
    });
    reads.length = 0;
    await page.goto(remoteRuntimeUrl('/app?observer=1', wsUrl, adminKey), { waitUntil: 'domcontentloaded' });
    await acceptRemoteRuntimeConsent(page);
    await page.getByRole('combobox', { name: 'Graph runtime view', exact: true }).selectOption(h1Endpoint.runtimeId);
    await expect(page.getByTestId('time-machine-remote-scan')).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });
    await expect(page.getByTestId('time-machine-remote-target')).toBeVisible();
    await expect(page.getByTestId('time-machine-remote-target')).toContainText(/hub/i);
    await page.getByTestId('time-machine-remote-target').selectOption(h1);
    await page.getByTestId('time-machine-remote-height').fill(String(controlResult.beforeHeight));
    await page.getByTestId('time-machine-remote-scan-button').click();
    await expect(page.getByTestId('time-machine-remote-scan-status')).toContainText(`h${controlResult.beforeHeight}`, {
      timeout: REMOTE_E2E_WAIT_MS,
    });
    await expect(page.getByTestId('time-machine-remote-scan-status')).toContainText(/ms/);
    await expect(page.getByTestId('time-machine-frame-badge')).not.toContainText(/LIVE/);
    const scannedFrame = () =>
      reads.findLast(
        row =>
          row.request.path === 'history-frame-batch' &&
          row.request.query?.entityId === h1 &&
          Array.isArray(row.request.query.heights) &&
          row.request.query.heights.includes(controlResult.beforeHeight),
      );
    await expect.poll(scannedFrame, { timeout: REMOTE_E2E_WAIT_MS }).toMatchObject({
      request: { query: { heights: [controlResult.beforeHeight], entityId: h1 } },
      payload: {
        frames: [
          expect.objectContaining({
            height: controlResult.beforeHeight,
            activeEntity: expect.objectContaining({
              core: expect.objectContaining({ profile: expect.objectContaining({ name: activeH1Before.profileName }) }),
            }),
          }),
        ],
        unavailable: [],
      },
    });
    await expect(page.locator('.history-warning')).toHaveCount(0);
    await expect(page.getByTestId('time-machine-remote-diff')).toContainText(/Δh/);
    await page.getByTestId('time-machine-remote-deeplink').click();
    await expect.poll(() => new URL(page.url()).hash).toContain(`tmHeight=${controlResult.beforeHeight}`);
    await expect.poll(() => new URL(page.url()).hash).toContain('tmEntity=');
    const deepLinkUrl = page.url();
    await page.goto(deepLinkUrl, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('time-machine-remote-scan')).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });
    await expect(page.getByTestId('time-machine-remote-scan-status')).toContainText(`h${controlResult.beforeHeight}`, {
      timeout: REMOTE_E2E_WAIT_MS,
    });
    await expect(page.getByTestId('time-machine-frame-badge')).not.toContainText(/LIVE/);
    await page.getByTitle('Go to live (End)').click();
    await expect(page.getByTestId('time-machine-frame-badge')).toContainText(/LIVE/, { timeout: REMOTE_E2E_WAIT_MS });
    await expect
      .poll(
        () =>
          reads.findLast(
            row =>
              row.request.path === 'view-frame' &&
              row.request.query?.entityId === h1 &&
              row.request.query.atHeight === undefined,
          ),
        { timeout: REMOTE_E2E_WAIT_MS },
      )
      .toMatchObject({
        payload: {
          height: expect.any(Number),
          activeEntity: { core: { profile: { name: nextProfileName } } },
        },
      });
    await expect(page.getByTestId('graph-runtime-node-summary')).toContainText(nextProfileName);
  },
);


test(
  'runtime dropdown switches app-imported remote runtimes without manager route',
  { tag: '@functional' },
  async ({ page }) => {
    const baseline = await ensureE2EBaseline(page, {
      requireHubMesh: true,
      requireMarketMaker: true,
      requireCustody: true,
      minHubCount: 3,
      allowAutoReset: false,
    });
    const hubs = await waitForNamedHubs(page, ['h1', 'h2'], { apiBaseUrl: API_BASE_URL });
    const h1 = String(hubs.h1 || '').toLowerCase();
    const h2 = String(hubs.h2 || '').toLowerCase();
    const h1Endpoint = await resolveHubRuntimeEndpoint(page, baseline, 'H1');
    const h2Endpoint = await resolveHubRuntimeEndpoint(page, baseline, 'H2');
    const h1Key = (await resolveRuntimeImportCapability(page, h1Endpoint, 'admin')).token;
    await page.goto(remoteRuntimeUrl('/app', h1Endpoint.wsUrl, h1Key), { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(h1.slice(0, 18)) }).click();
    await expect(page.getByTestId('home-entity-id')).toHaveText(h1);
    await expect(page.getByTestId('remote-runtime-manager')).toHaveCount(0);
    await expect(page.locator('.remote-manager-link')).toHaveCount(0);

    const importUrl = await resolveRuntimeImportAppUrl(page, {
      appBaseUrl: APP_BASE_URL,
      apiBaseUrl: API_BASE_URL,
      access: 'admin',
    });
    expect(importUrl).toContain('/app#runtime-import-src=');
    expect(importUrl).not.toContain('/radapter/manage');
    const sockets: string[] = [];
    let submittedInputs = 0;
    page.on('websocket', socket => {
      sockets.push(socket.url());
      socket.on('framesent', ({ payload }) => {
        const message = decodeRuntimeAdapterMessage(payload);
        if ('op' in message && message.op === 'send') submittedInputs += 1;
      });
    });
    await page.goto(importUrl, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('button', { name: 'Load runtime list', exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/ui\/$/);
    expect(sockets).toEqual([]);
    await page.getByRole('button', { name: 'Load runtime list', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Validate & attach', exact: true })).toBeVisible();
    expect(sockets).toEqual([]);
    await expect(page.getByText(h2Endpoint.wsUrl, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Validate & attach', exact: true }).click();
    const summary = await readRuntimeImportSummary(page);
    expect(summary.ok).toBe(true);
    expect(summary.failedCount).toBe(0);
    expect(summary.failed).toEqual([]);
    expect(summary.entries.length).toBeGreaterThanOrEqual(5);
    expect(summary.entries.length).toBeLessThanOrEqual(100);
    expect(summary.checked?.every(row => row.ok)).toBe(true);
    const importedH2 = summary.entries.find(entry => entry.runtimeId === h2Endpoint.runtimeId);
    expect(importedH2?.label).toBe('H2');
    expect(importedH2?.access).toBe('admin');
    expect(importedH2?.entityCount).toBeGreaterThan(0);
    const saved = await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem('xln-ui-vaults') || '[]') as Array<{
          id: string;
          name: string;
          kind: string;
          remote?: { wsUrl?: string };
        }>,
    );
    expect(saved.length).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(saved)).not.toContain('xlnra1.');
    expect(saved.find(entry => entry.remote?.wsUrl === h2Endpoint.wsUrl)?.name).toBe('H2');
    expect(await page.evaluate(() => (window as ReactRuntimeWindow).__xln?.adapter())).toBeNull();

    await page.locator(`[data-testid="validated-runtime"][data-runtime-id="${h2Endpoint.runtimeId}"]`).click();
    await expect(page.getByLabel('Runtime endpoint', { exact: true })).toHaveValue(h2Endpoint.wsUrl);
    await expect(page.getByLabel('Access key · optional', { exact: true })).not.toHaveValue('');
    expect(await page.evaluate(() => (window as ReactRuntimeWindow).__xln?.adapter())).toBeNull();
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(h2.slice(0, 18)) }).click();
    await expect(page.getByTestId('home-entity-id')).toHaveText(h2);
    const projection = await page.evaluate(async entityId => {
      const adapter = (window as ReactRuntimeWindow).__xln?.adapter();
      if (!adapter) throw new Error('IMPORTED_RUNTIME_INSPECTION_MISSING');
      type Frame = {
        activeEntity?: {
          core?: { entityId?: string; signerId?: string; profile?: { name?: string } };
          summary?: { entityId?: string };
        };
      };
      const before = await adapter.read<Frame>('view-frame', { entityId, accountsLimit: 1, booksLimit: 1 });
      const headBefore = await adapter.read<{ latestHeight: number }>('head');
      const after = await adapter.read<Frame>('view-frame', { entityId, accountsLimit: 1, booksLimit: 1 });
      const headAfter = await adapter.read<{ latestHeight: number }>('head');
      return {
        runtimeId: adapter.runtimeId,
        authLevel: adapter.authLevel,
        commandReady: adapter.commandReady,
        entityId: before.activeEntity?.core?.entityId || before.activeEntity?.summary?.entityId,
        signerId: before.activeEntity?.core?.signerId,
        beforeName: before.activeEntity?.core?.profile?.name,
        afterName: after.activeEntity?.core?.profile?.name,
        beforeHeight: headBefore.latestHeight,
        afterHeight: headAfter.latestHeight,
        sendPresent: 'send' in adapter,
        submitPresent: 'submit' in ((window as ReactRuntimeWindow).__xln || {}),
      };
    }, h2);
    expect(projection.runtimeId).toBe(h2Endpoint.runtimeId);
    expect(projection.authLevel).toBe('admin');
    expect(projection.commandReady).toBe(true);
    expect(projection.entityId).toBe(h2);
    expect(projection.signerId).toMatch(/^0x[0-9a-f]{40}$/);
    expect(projection.sendPresent).toBe(false);
    expect(projection.submitPresent).toBe(false);
    expect(projection.beforeName).toBeTruthy();
    expect(projection.afterName).toBe(projection.beforeName);
    expect(projection.beforeHeight).toBeGreaterThan(0);
    expect(projection.afterHeight).toBeGreaterThanOrEqual(projection.beforeHeight);
    expect(submittedInputs).toBe(0);
  },
);

test(
  'bulk remote runtime import link validates mesh, custody, and market maker runtimes in browser',
  { tag: '@functional' },
  async ({ browser }) => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    try {
      const baseline = await ensureE2EBaseline(page, {
        apiBaseUrl: API_BASE_URL,
        requireHubMesh: true,
        requireMarketMaker: true,
        requireCustody: true,
        minHubCount: 3,
        allowAutoReset: false,
      });
      expect(baseline.custody?.enabled).toBe(true);
      expect(baseline.custody?.ok).toBe(true);
      expectMarketMakerBooksHealthy(baseline);
      const response = await page.request.get(`${API_BASE_URL}/api/runtime-import?access=admin`, {
        headers: { 'Cache-Control': 'no-store' },
        timeout: 10_000,
      });
      expect(response.ok()).toBe(true);
      const payload = (await response.json()) as { importUrl: string };
      const importUrl = new URL(payload.importUrl);
      expect(importUrl.pathname).toBe('/app');
      expect(importUrl.search).toBe('');
      expect(importUrl.hash).toContain('runtime-import-src=');
      expect(importUrl.href).not.toContain('/radapter/manage');
      expect(importUrl.href).not.toContain('?runtimeList=');
      expect(importUrl.href).not.toContain('&token=');
      expect(importUrl.href).not.toContain('xlnra1.');
      await page.goto(importUrl.href, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Load runtime list', exact: true }).click();
      await page.getByRole('button', { name: 'Validate & attach', exact: true }).click();
      const summary = await readRuntimeImportSummary(page);
      expect(summary.ok).toBe(true);
      expect(summary.entries.length).toBeGreaterThanOrEqual(5);
      expect(summary.failedCount).toBe(0);
      expect(summary.failed).toEqual([]);
      expect(summary.checked?.length).toBeGreaterThanOrEqual(summary.entries.length);
      expect(summary.checked?.every(row => row.ok)).toBe(true);
      await expect(page).toHaveURL(/\/ui\/$/);
      const expected = ['h1', 'h2', 'h3', 'mm', 'custody'];
      const primaryIds = new Map<string, string>();
      for (const label of expected) {
        const entry = summary.entries.find(row => row.label.toLowerCase() === label);
        if (!entry) throw new Error(`REMOTE_RUNTIME_IMPORT_ENTRY_MISSING:${label}`);
        expect(entry.access).toBe('admin');
        expect(entry.runtimeId).toMatch(/^0x[0-9a-f]{40}$/);
        expect(entry.runtimeId).not.toMatch(/^radapter:/);
        expect(entry.entityCount).toBeGreaterThan(0);
        expect(entry.height).toBeGreaterThan(0);
        expect(entry.wsUrl).toMatch(/^wss?:\/\/.+\/rpc$/);
        const card = page.locator(`[data-testid="validated-runtime"][data-runtime-id="${entry.runtimeId}"]`);
        await expect(card).toBeVisible();
        const entityId = await card.getAttribute('data-entity-id');
        const entityLabel = await card.getAttribute('data-entity-label');
        expect(entityId).toMatch(/^0x[0-9a-f]{64}$/);
        expect(runtimeEntityLabelMatches(entityLabel, label)).toBe(true);
        await expect(card).toContainText(entry.label);
        await expect(card).toContainText(entry.wsUrl);
        if (!entityId) throw new Error(`REMOTE_PRIMARY_ENTITY_MISSING:${label}`);
        primaryIds.set(label, entityId);
        if (label === 'mm' || label === 'custody') {
          expect(entityLabel?.toLowerCase()).not.toContain('h3');
          expect(entityId).not.toBe(primaryIds.get('h3'));
        }
      }
      await captureLocatorScreenshot(page.locator('.gate'), test.info(), 'runtime-import-desktop');
      const viewport = page.viewportSize();
      if (!viewport) throw new Error('BROWSER_VIEWPORT_REQUIRED');
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      await captureLocatorScreenshot(page.locator('.gate'), test.info(), 'runtime-import-mobile');
      await page.setViewportSize(viewport);
      const first = summary.entries[0];
      if (!first) throw new Error('REMOTE_IMPORT_ENTRIES_EMPTY');
      const entityId = primaryIds.get(first.label.toLowerCase());
      if (!entityId) throw new Error('REMOTE_PRIMARY_ENTITY_MISSING');
      await page.locator(`[data-testid="validated-runtime"][data-runtime-id="${first.runtimeId}"]`).click();
      await page.getByRole('button', { name: 'Connect', exact: true }).click();
      await page.getByRole('button', { name: new RegExp(entityId.slice(0, 18)) }).click();
      await expect(page.getByTestId('home-entity-id')).toHaveText(entityId);
      const live = await page.evaluate(async () => {
        const adapter = (window as ReactRuntimeWindow).__xln?.adapter();
        if (!adapter) throw new Error('REMOTE_IMPORT_INSPECTION_MISSING');
        return {
          runtimeId: adapter.runtimeId,
          height: adapter.currentHeight,
          entities: await adapter.read<unknown[]>('entities'),
        };
      });
      expect(live.runtimeId).toBe(first.runtimeId);
      expect(live.height).toBeGreaterThan(0);
      expect(live.entities.length).toBeGreaterThan(0);
      const health = (await page.evaluate(async () => {
        const response = await fetch('/api/health', { cache: 'no-store' });
        if (!response.ok) throw new Error(`HEALTH_FETCH_FAILED:${response.status}`);
        return response.json();
      })) as E2EHealthSnapshot;
      expectHubMeshHealthy(health);
      expect(health.custody?.ok).toBe(true);
      expectMarketMakerBooksHealthy(health);
    } finally {
      await closeRuntimeContext(context);
    }
  },
);
