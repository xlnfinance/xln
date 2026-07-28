import { allowBrowserIssue, allowDebugIncident, expect, test } from './global-setup.mts';

import { APP_BASE_URL, API_BASE_URL, ensureE2EBaseline, getHealth, waitForNamedHubs } from './utils/e2e-baseline';

import { openAccountWorkspaceTab } from './utils/e2e-account-workspace';

import { resolveRuntimeImportAppUrl } from './utils/e2e-runtime-import';

import { closeRuntimeContext } from './utils/e2e-runtime-shutdown.mts';

import { deriveSignerAddressSync } from '../runtime/account/crypto';

import { HUB_MESH_CREDIT_AMOUNT } from '../runtime/orchestrator/mesh-common';

import { decodeRuntimeAdapterRequest } from '../runtime/radapter/codec';

import { signRuntimeAdapterServerIdentity } from '../runtime/radapter/server-identity-signer';

import { deriveRuntimeAdapterCapabilityToken } from '../runtime/radapter/auth';

import type { RuntimeAdapterRequest } from '../runtime/radapter/types';

import type { RuntimeState } from '../runtime/types';

import { captureLocatorScreenshot } from './utils/e2e-screenshots';

const REMOTE_RUNTIME_IMPORT_STORAGE_KEY = 'xln-remote-runtime-imports';

const REMOTE_RUNTIME_IMPORT_RESULT_STORAGE_KEY = 'xln-remote-runtime-import-last-result';

const REMOTE_E2E_WAIT_MS = 15_000;

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

const installOneMillionRuntimeAdapterSocket = async (
  page: import('@playwright/test').Page,
  options: {
    authLevel?: 'inspect' | 'admin';
    commandReady?: boolean;
    commandReadyReason?: string | null;
  } = {},
): Promise<{ runtimeId: string; wsUrl: string }> => {
  const runtimeSeed = 'one-million-runtime-adapter-fixture';
  const wsUrl = 'ws://one-million-runtime.invalid/rpc';
  const authLevel = options.authLevel ?? 'inspect';
  const commandReady = options.commandReady ?? true;
  const commandReadyReason = commandReady ? null : (options.commandReadyReason ?? 'phase=halted');
  const identityEnv = {
    runtimeSeed,
    runtimeId: deriveSignerAddressSync(runtimeSeed, '1').toLowerCase(),
  } as RuntimeState;
  await page.exposeFunction('__xlnDecodeOneMillionRuntimeAdapterRequest', (bytes: number[]) => {
    const request = decodeRuntimeAdapterRequest(Uint8Array.from(bytes)) as RuntimeAdapterRequest;
    return {
      id: request.id,
      op: request.op,
      ...('path' in request ? { path: request.path } : {}),
      ...(request.op === 'auth'
        ? {
            authPayload: {
              authLevel,
              commandLaneKind: 'capability' as const,
              currentHeight: 42,
              nextCommandSequence: 1,
              commandReady,
              commandReadyReason,
              ...signRuntimeAdapterServerIdentity(identityEnv, request.challenge),
            },
          }
        : {}),
    };
  });
  await page.addInitScript(() => {
    const targetWsUrl = 'ws://one-million-runtime.invalid/rpc';
    const NativeWebSocket = window.WebSocket;
    const entityId = `0x${'a'.repeat(64)}`;
    const leftEntity = entityId;
    const head = {
      schemaVersion: 1,
      latestHeight: 42,
      latestMaterializedHeight: 42,
      latestSnapshotHeight: 40,
      snapshotPeriodFrames: 256,
      retainSnapshots: 3,
      epochMaxBytes: 1,
      accountMerkleRadix: 16,
      epochReplayBytes: 0,
      retainedHistoryBytes: 4096,
    };
    const counterparties = Array.from({ length: 10 }, (_, index) => `0x${(index + 1).toString(16).padStart(64, '0')}`);
    const accounts = counterparties.map((rightEntity, index) => ({
      leftEntity,
      rightEntity,
      status: 'open',
      currentHeight: 42,
      currentFrame: {
        stateHash: `0x${(index + 1).toString(16).padStart(64, '0')}`,
      },
    }));
    const viewFrame = {
      head,
      height: 42,
      entities: [
        {
          entityId,
          label: '1M Aggregate Hub',
          height: 42,
          isHub: true,
        },
      ],
      activeEntityId: entityId,
      activeEntity: {
        summary: {
          entityId,
          label: '1M Aggregate Hub',
          height: 42,
          isHub: true,
        },
        core: {
          entityId,
          signerId: `0x${'b'.repeat(64)}`,
          height: 42,
          profile: {
            name: '1M Aggregate Hub',
            isHub: true,
          },
        },
        accounts: {
          items: accounts,
          nextCursor: counterparties[counterparties.length - 1],
          firstCursor: counterparties[0],
          lastCursor: counterparties[counterparties.length - 1],
          pageIndex: 0,
          pageCount: 100_000,
          totalItems: 1_000_000,
          limit: 10,
          summary: {
            totalItems: 1_000_000,
            visibleItems: 10,
            limit: 10,
            pageIndex: 0,
            pageCount: 100_000,
            hasMore: true,
            sampleIds: counterparties.slice(0, 8),
            pageStateHashes: counterparties.slice(0, 8),
            visibleTopDeltas: counterparties.slice(0, 3).map((counterpartyId, index) => ({
              counterpartyId,
              tokenId: 1,
              delta: String((index + 1) * 10_000),
            })),
          },
        },
        books: {
          items: [],
          nextCursor: null,
          pageIndex: 0,
          pageCount: 0,
          totalItems: 0,
          limit: 10,
        },
      },
    };
    const encoder = new TextEncoder();
    const stats = {
      sentCount: 0,
      maxPayloadBytes: 0,
      viewFrameBytes: 0,
      maxAccountItems: 0,
      requestOps: {} as Record<string, number>,
      events: [] as string[],
    };
    (window as unknown as { __xlnOneMillionRuntimeAdapterStats: typeof stats }).__xlnOneMillionRuntimeAdapterStats =
      stats;

    class OneMillionRuntimeAdapterSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      static __xlnOneMillionRuntimeAdapterSocket = true;
      readonly url: string;
      binaryType = 'arraybuffer';
      readyState = OneMillionRuntimeAdapterSocket.CONNECTING;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;

      constructor(url: string | URL, protocols?: string | string[]) {
        this.url = url;
        if (String(url) !== targetWsUrl) {
          stats.events.push(`native:${url}`);
          return protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
        }
        stats.events.push(`construct:${url}`);
        setTimeout(() => {
          this.readyState = OneMillionRuntimeAdapterSocket.OPEN;
          stats.events.push('open');
          this.onopen?.();
        }, 0);
      }

      send(raw: unknown): void {
        stats.sentCount += 1;
        stats.events.push(`send:${stats.sentCount}`);
        if (!(raw instanceof ArrayBuffer) && !ArrayBuffer.isView(raw)) {
          throw new Error(`ONE_MILLION_RADAPTER_BINARY_REQUEST_REQUIRED:${typeof raw}`);
        }
        const bytes =
          raw instanceof ArrayBuffer
            ? Array.from(new Uint8Array(raw))
            : Array.from(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
        const decodeRequest = (
          window as unknown as {
            __xlnDecodeOneMillionRuntimeAdapterRequest: (value: number[]) => Promise<{
              id: string;
              op: string;
              path?: string;
              authPayload?: Record<string, unknown>;
            }>;
          }
        ).__xlnDecodeOneMillionRuntimeAdapterRequest;
        void decodeRequest(bytes).then(request => {
          stats.requestOps[request.op] = (stats.requestOps[request.op] ?? 0) + 1;
          const payload =
            request.op === 'auth'
              ? request.authPayload
              : request.path === 'head'
                ? head
                : request.path === 'entities'
                  ? viewFrame.entities
                  : request.path === 'activity'
                    ? { events: [], nextCursor: null }
                    : viewFrame;
          const response = JSON.stringify({ v: 1, inReplyTo: request.id, ok: true, payload });
          const byteLength = encoder.encode(response).byteLength;
          stats.maxPayloadBytes = Math.max(stats.maxPayloadBytes, byteLength);
          if (request.path === 'view-frame') {
            stats.viewFrameBytes = byteLength;
            stats.maxAccountItems = viewFrame.activeEntity.accounts.items.length;
          }
          setTimeout(() => {
            stats.events.push(`reply:${request.id}:${request.op}:${request.path ?? ''}`);
            this.onmessage?.({ data: response });
          }, 0);
        });
      }

      close(): void {
        this.readyState = OneMillionRuntimeAdapterSocket.CLOSED;
        setTimeout(() => this.onclose?.(), 0);
      }
    }

    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      writable: true,
      value: OneMillionRuntimeAdapterSocket,
    });
  });
  return { runtimeId: String(identityEnv.runtimeId), wsUrl };
};

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
  const hubs = await waitForNamedHubs(page, ['h1'], { apiBaseUrl: API_BASE_URL });
  const h1 = String(hubs.h1 || '').toLowerCase();
  expect(h1).toMatch(/^0x[0-9a-f]{64}$/);

  const h1Endpoint = await resolveHubRuntimeEndpoint(page, baseline, 'H1');
  const wsUrl = h1Endpoint.wsUrl;
  const key = (await resolveRuntimeImportCapability(page, h1Endpoint, 'admin')).token;
  const url = `${APP_BASE_URL}/app?runtime=remote&ws=${encodeURIComponent(wsUrl)}&token=${encodeURIComponent(key)}#accounts`;

  await page.goto(url, { waitUntil: 'domcontentloaded' });

  const remotePrompt = page.getByTestId('remote-runtime-login-screen');
  await expect(remotePrompt).not.toBeVisible({ timeout: 10_000 });

  await page.waitForFunction(
    ({ hubId, expectedRuntimeId }) => {
      const view = window as typeof window & {
        __xlnRuntimeView?: {
          runtimeId?: string;
          entities?: Array<{ entityId?: string; isHub?: boolean; label?: string }>;
          frame?: { entities?: Array<{ entityId?: string; isHub?: boolean; label?: string }> | null };
        };
      };
      const runtimeView = (view as any).__xln?.view;
      if (!runtimeView || String(runtimeView.runtimeId || '') !== expectedRuntimeId) return false;
      const entities = runtimeView.entities ?? runtimeView.frame?.entities ?? [];
      return entities.some(entity => String(entity.entityId || '').toLowerCase() === hubId && entity.isHub === true);
    },
    { hubId: h1, expectedRuntimeId: h1Endpoint.runtimeId },
    { timeout: REMOTE_E2E_WAIT_MS },
  );

  const snapshot = await page.evaluate(hubId => {
    const view = window as typeof window & {
      __xln?: {
        view?: {
          runtimeId?: string;
          height?: number;
        };
        adapter?: {
          status?: () => { connected?: boolean; authLevel?: string | null; height?: number };
        };
      };
      __xlnRuntimeView?: {
        runtimeId?: string;
        height?: number;
        entities?: Array<{ entityId?: string; isHub?: boolean; label?: string }>;
        frame?: {
          activeEntity?: {
            summary?: { entityId?: string; isHub?: boolean; label?: string };
            accounts?: { items?: unknown[]; totalItems?: number };
          } | null;
        } | null;
      };
    };
    const runtimeView = (view as any).__xln?.view;
    const debugRoot = view.__xln ?? {};
    const rootAdapterStatus = debugRoot.adapter?.status?.() ?? null;
    const entities = runtimeView?.entities ?? [];
    const active = runtimeView?.frame?.activeEntity ?? null;
    const activeSummary = active?.summary ?? null;
    const hub =
      entities.find(entity => String(entity.entityId || '').toLowerCase() === hubId && entity.isHub === true) ??
      entities.find(entity => String(entity.entityId || '').toLowerCase() === hubId) ??
      activeSummary;
    return {
      runtimeId: String(runtimeView?.runtimeId || ''),
      height: Number(runtimeView?.height || 0),
      replicaCount: entities.length,
      hubName: String(hub?.label || ''),
      hubIsHub: hub?.isHub === true,
      accountCount: Number(active?.accounts?.totalItems ?? active?.accounts?.items?.length ?? 0),
      loginText: document.body.textContent || '',
      debugRootViewMatchesLegacy: debugRoot.view === runtimeView,
      debugRootAdapterConnected: rootAdapterStatus?.connected === true,
      debugRootAdapterAuthLevel: rootAdapterStatus?.authLevel ?? null,
    };
  }, h1);

  expect(snapshot.runtimeId).toBe(h1Endpoint.runtimeId);
  expect(snapshot.height).toBeGreaterThan(0);
  expect(snapshot.replicaCount).toBeGreaterThan(0);
  expect(snapshot.hubIsHub).toBe(true);
  expect(snapshot.hubName.toLowerCase()).toContain('h1');
  expect(snapshot.accountCount).toBeGreaterThan(0);
  expect(snapshot.accountCount).toBeLessThanOrEqual(10);
  expect(/quick login/i.test(snapshot.loginText)).toBe(false);
  expect(snapshot.debugRootViewMatchesLegacy).toBe(true);
  expect(snapshot.debugRootAdapterConnected).toBe(true);
  expect(snapshot.debugRootAdapterAuthLevel).toBe('admin');
  await expect(page.getByTestId('context-current')).not.toContainText(/no runtime selected/i);
  await expect(page.getByTestId('context-current')).toContainText(/\bH1\b/);
  await expect(page.getByTestId('account-list-count')).toContainText(/\b\d+ Accounts\b/);
  await expect(page.locator('[data-testid="account-list-wrapper"]')).toContainText(/0x[0-9a-f]{64}/i);

  await page.getByTestId('context-current').click();
  const runtimeRows = page.getByTestId('context-entity-row');
  await expect(runtimeRows.filter({ hasText: /\bH1\b/ }).first()).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });
  await page.keyboard.press('Escape');
  const accountPreviews = page.getByTestId('account-preview');
  await expect(accountPreviews.filter({ hasText: /\bH2\b/ }).first()).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });
  await expect(accountPreviews.filter({ hasText: /\bH3\b/ }).first()).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });

  await page.getByTestId('account-workspace-tab-history').first().click();
  await expect(page.locator('.settlement-panel')).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });
  await expect(page.locator('.settlement-panel')).toContainText('On-Chain Batch History');
  await expect(page.locator('.settlement-panel')).not.toContainText('Settlement history requires a runtime frame');
});

test(
  'dev DockRoot entity panel resolves seed through remote RuntimeView projection',
  { tag: '@functional' },
  async ({ page }) => {
    const baseline = await ensureE2EBaseline(page, { requireHubMesh: true, minHubCount: 3 });
    const h1Endpoint = await resolveHubRuntimeEndpoint(page, baseline, 'H1');
    const wsUrl = h1Endpoint.wsUrl;
    const key = (await resolveRuntimeImportCapability(page, h1Endpoint, 'admin')).token;

    await page.addInitScript(() => {
      localStorage.setItem('xln-app-mode', 'dev');
      localStorage.setItem('xln-view-mode', 'panels');
      localStorage.removeItem('xln-workspace-layout');
      localStorage.removeItem('xln-dockview-layout');
      localStorage.removeItem('dockview-layout');
    });

    await page.goto(
      `${APP_BASE_URL}/app?runtime=remote&ws=${encodeURIComponent(wsUrl)}&token=${encodeURIComponent(key)}`,
      {
        waitUntil: 'domcontentloaded',
      },
    );

    await page.waitForFunction(
      () => {
        const view = window as typeof window & {
          __dockview_instance?: { addPanel?: unknown };
          __xlnRuntimeAdapter?: { status: () => { connected?: boolean; authLevel?: string | null; height?: number } };
        };
        const status = (view as any).__xln?.adapter?.status?.();
        return (
          !!view.__dockview_instance?.addPanel &&
          status?.connected === true &&
          status.authLevel === 'admin' &&
          Number(status.height || 0) > 0
        );
      },
      undefined,
      { timeout: 90_000 },
    );

    const opened = await page.evaluate(async () => {
      const view = window as typeof window & {
        __dockview_instance?: {
          addPanel: (config: {
            id: string;
            component: string;
            title: string;
            position?: { direction: string; referencePanel?: string };
            params?: Record<string, unknown>;
          }) => unknown;
        };
        __xlnRuntimeAdapter?: RuntimeAdapterDebugSurface;
      };
      const adapter = (view as any).__xln?.adapter;
      const dockview = view.__dockview_instance;
      if (!adapter) throw new Error('XLN_RUNTIME_ADAPTER_DEBUG_SURFACE_MISSING');
      if (!dockview) throw new Error('DOCKVIEW_DEBUG_SURFACE_MISSING');

      type ViewFrame = {
        activeEntityId?: string | null;
        entities?: Array<{ entityId?: string; label?: string }>;
        activeEntity?: {
          summary?: { entityId?: string; label?: string };
          core?: { signerId?: string; profile?: { name?: string } };
        } | null;
      };
      const frame = await adapter.query.viewFrame<ViewFrame>({
        accountsLimit: 1,
        booksLimit: 1,
      });
      const entityId = String(
        frame.activeEntityId || frame.activeEntity?.summary?.entityId || frame.entities?.[0]?.entityId || '',
      ).toLowerCase();
      const label = String(
        frame.activeEntity?.core?.profile?.name ||
          frame.activeEntity?.summary?.label ||
          frame.entities?.[0]?.label ||
          entityId,
      );
      const signerId = String(frame.activeEntity?.core?.signerId || '').toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(entityId)) throw new Error(`ENTITY_ID_INVALID:${entityId}`);
      if (!/^0x[0-9a-f]{40}$/.test(signerId)) throw new Error(`SIGNER_ID_INVALID:${signerId}`);

      dockview.addPanel({
        id: `entity-${entityId}`,
        component: 'entity-panel',
        title: `Projection ${label}`,
        position: { direction: 'within', referencePanel: 'graph3d' },
        params: { closeable: true },
      });
      return {
        entityId,
        label,
        signerId,
        tabId: `entity-${entityId.slice(0, 8)}`,
      };
    });

    await page.waitForSelector('.entity-panel-wrapper [data-testid="entity-workspace"]', {
      timeout: REMOTE_E2E_WAIT_MS,
    });
    await expect(page.locator(`[data-panel-id="${opened.tabId}"]`)).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });
    const panelState = await page.evaluate(() => {
      const workspaces = Array.from(
        document.querySelectorAll('.entity-panel-wrapper [data-testid="entity-workspace"]'),
      );
      const statusErrors = Array.from(document.querySelectorAll('.entity-panel-status.error')).map(
        node => node.textContent || '',
      );
      return {
        workspaceCount: workspaces.length,
        statusErrors,
        bodyText: document.body.textContent || '',
      };
    });

    expect(opened.entityId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(opened.signerId).toMatch(/^0x[0-9a-f]{40}$/);
    expect(panelState.workspaceCount).toBeGreaterThan(0);
    expect(panelState.statusErrors).toEqual([]);
    expect(panelState.bodyText).toContain(opened.entityId);
  },
);

test('dev DockRoot Solvency panel reads remote radapter solvency-summary', { tag: '@functional' }, async ({ page }) => {
  const baseline = await ensureE2EBaseline(page, { requireHubMesh: true, minHubCount: 3 });
  const h1Endpoint = await resolveHubRuntimeEndpoint(page, baseline, 'H1');
  const key = (await resolveRuntimeImportCapability(page, h1Endpoint, 'admin')).token;
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

  await page.goto(
    `${APP_BASE_URL}/app?runtime=remote&ws=${encodeURIComponent(h1Endpoint.wsUrl)}&token=${encodeURIComponent(key)}#accounts`,
    {
      waitUntil: 'domcontentloaded',
    },
  );

  await page.waitForFunction(
    () => {
      const view = window as typeof window & {
        __dockview_instance?: { addPanel?: unknown };
        __xlnRuntimeAdapter?: { status: () => { connected?: boolean; authLevel?: string | null; height?: number } };
      };
      const status = (view as any).__xln?.adapter?.status?.();
      return (
        !!view.__dockview_instance?.addPanel &&
        status?.connected === true &&
        status.authLevel === 'admin' &&
        Number(status.height || 0) > 0
      );
    },
    undefined,
    { timeout: REMOTE_E2E_WAIT_MS },
  );

  await expect(page.getByTestId('network-machine-timeline')).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });

  await page.locator('.dv-tab').filter({ hasText: 'Gossip' }).first().click();
  await expect(page.getByTestId('runtime-gossip-panel')).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });
  await expect(page.getByTestId('runtime-gossip-profiles')).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });

  await page.locator('.dv-tab').filter({ hasText: 'Solvency' }).first().click();
  await expect(page.getByTestId('solvency-panel')).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });

  const probe = await page.evaluate(async () => {
    type SolvencySummary = {
      ok?: boolean;
      height?: number;
      entityCount?: number;
      accountViews?: number;
      assets?: Array<{
        stackId?: string;
        tokenId?: number;
        reserves?: bigint;
        confirmedCollateral?: bigint;
        pendingCollateral?: bigint;
        delta?: bigint;
      }>;
      isValid?: boolean;
      eReplicas?: unknown;
      accounts?: unknown;
    };
    const view = window as typeof window & {
      __xlnRuntimeAdapter?: RuntimeAdapterDebugSurface;
    };
    const adapter = (view as any).__xln?.adapter;
    if (!adapter) throw new Error('XLN_RUNTIME_ADAPTER_DEBUG_SURFACE_MISSING');
    const summary = await adapter.query.solvencySummary<SolvencySummary>();
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
          typeof asset.pendingCollateral === 'bigint' &&
          typeof asset.delta === 'bigint',
      ),
      assetIdentitiesAreScoped: (summary.assets ?? []).every(
        asset => typeof asset.stackId === 'string' && Number.isSafeInteger(asset.tokenId),
      ),
      isValidType: typeof summary.isValid,
    };
  });

  expect(probe.ok).toBe(true);
  expect(probe.height).toBeGreaterThan(0);
  expect(probe.entityCount).toBeGreaterThan(0);
  expect(probe.accountViews).toBeGreaterThan(0);
  expect(probe.hasFullEnv).toBe(false);
  expect(probe.hasFullAccounts).toBe(false);
  expect(probe.assetCount).toBeGreaterThan(0);
  expect(probe.assetAmountsAreBigInt).toBe(true);
  expect(probe.assetIdentitiesAreScoped).toBe(true);
  expect(probe.isValidType).toBe('boolean');

  await expect(page.getByTestId('solvency-status')).toContainText(/ASSET CONSERVATION OK|ASSET IMBALANCE DETECTED/, {
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
  const h1Endpoint = await resolveHubRuntimeEndpoint(page, baseline, 'H1');
  const wsUrl = h1Endpoint.wsUrl;
  const key = (await resolveRuntimeImportCapability(page, h1Endpoint, 'admin')).token;

  await page.goto(`${APP_BASE_URL}/app?runtime=remote&ws=${encodeURIComponent(wsUrl)}#accounts`, {
    waitUntil: 'domcontentloaded',
  });
  const remotePrompt = page.getByTestId('remote-runtime-login-screen');
  await expect(remotePrompt).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });

  const reloadMarker = `xln-no-reload-${Date.now()}`;
  await page.evaluate(marker => {
    (window as typeof window & { __xlnNoReloadMarker?: string }).__xlnNoReloadMarker = marker;
  }, reloadMarker);
  await remotePrompt.locator('input[placeholder="xlnra1..."]').fill(key);
  await page.getByRole('button', { name: 'Connect remote runtime' }).click();

  await page.waitForFunction(
    ({ runtimeId, ws }) => {
      const view = window as typeof window & {
        __xlnRuntimeView?: { runtimeId?: string; height?: number };
        __xlnRuntimeAdapter?: { status: () => { authLevel?: string | null } };
      };
      return (
        String((view as any).__xln?.view?.runtimeId || '') === runtimeId &&
        Number((view as any).__xln?.view?.height || 0) > 0 &&
        (view as any).__xln?.adapter?.status().authLevel === 'admin' &&
        localStorage.getItem('xln-runtime-adapter-ws') === ws
      );
    },
    { runtimeId: h1Endpoint.runtimeId, ws: wsUrl },
    { timeout: REMOTE_E2E_WAIT_MS },
  );

  const state = await page.evaluate(() => ({
    url: window.location.href,
    activeWsUrl: localStorage.getItem('xln-runtime-adapter-ws') || '',
    storedAccess: localStorage.getItem('xln-runtime-adapter-access') || '',
    sessionKey: sessionStorage.getItem('xln-runtime-adapter-key') || '',
    loginVisible: !!document.querySelector('[data-testid="remote-runtime-login-screen"]'),
    reloadMarker: (window as typeof window & { __xlnNoReloadMarker?: string }).__xlnNoReloadMarker || '',
    navigationType: String(performance.getEntriesByType('navigation')[0]?.toJSON?.()?.type || ''),
  }));
  expect(state.reloadMarker).toBe(reloadMarker);
  expect(state.navigationType).not.toBe('reload');
  expect(state.url).not.toContain('runtime=remote');
  expect(state.url).not.toContain('ws=');
  expect(state.activeWsUrl).toBe(wsUrl);
  expect(state.storedAccess).toBe('admin');
  expect(state.sessionKey).toBe(key);
  expect(state.loginVisible).toBe(false);
});

test(
  'local runtime creation while remote is active switches controller to embedded',
  { tag: '@functional' },
  async ({ page }) => {
    const baseline = await ensureE2EBaseline(page, { requireHubMesh: true, minHubCount: 3 });
    const h1Endpoint = await resolveHubRuntimeEndpoint(page, baseline, 'H1');
    const wsUrl = h1Endpoint.wsUrl;
    const key = (await resolveRuntimeImportCapability(page, h1Endpoint, 'admin')).token;

    await page.goto(
      `${APP_BASE_URL}/app?runtime=remote&ws=${encodeURIComponent(wsUrl)}&token=${encodeURIComponent(key)}`,
      {
        waitUntil: 'domcontentloaded',
      },
    );
    await page.waitForFunction(
      ({ runtimeId, ws }) => {
        const view = window as typeof window & {
          __xlnRuntimeView?: { runtimeId?: string; height?: number };
          __xlnRuntimeAdapter?: { status: () => { authLevel?: string | null } };
        };
        return (
          String((view as any).__xln?.view?.runtimeId || '') === runtimeId &&
          Number((view as any).__xln?.view?.height || 0) > 0 &&
          (view as any).__xln?.adapter?.status().authLevel === 'admin' &&
          localStorage.getItem('xln-runtime-adapter-ws') === ws
        );
      },
      { runtimeId: h1Endpoint.runtimeId, ws: wsUrl },
      { timeout: REMOTE_E2E_WAIT_MS },
    );

    const result = await page.evaluate(async () => {
      const view = window as typeof window & {
        __xlnRuntimeAdapter?: {
          status: () => {
            connected?: boolean;
            height?: number;
            authLevel?: string | null;
            runtimeId?: string;
            mode?: string;
            permissions?: string;
          };
        };
      };
      if (typeof (view as any).__xln?.vault?.createRuntime !== 'function') {
        throw new Error('__xln.vault.createRuntime unavailable');
      }
      const runtime = await (view as any).__xln?.vault.createRuntime(
        'remote-to-local',
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        {
          loginType: 'manual',
          requiresOnboarding: false,
          skipRecoveryRestore: true,
          recovery: { useDefaultTowers: false, towers: [] },
        },
      );
      const adapter = (view as any).__xln?.adapter?.status() || null;
      return {
        createdRuntimeId: String(runtime?.id || ''),
        envRuntimeId: String(adapter?.runtimeId || ''),
        height: Number(adapter?.height || 0),
        mode: String(adapter?.mode || ''),
        permissions: String(adapter?.permissions || ''),
        adapter,
        storedMode: localStorage.getItem('xln-runtime-adapter-mode') || '',
        storedWs: localStorage.getItem('xln-runtime-adapter-ws') || '',
        storedAccess: localStorage.getItem('xln-runtime-adapter-access') || '',
        sessionKey: sessionStorage.getItem('xln-runtime-adapter-key') || '',
      };
    });

    expect(result.createdRuntimeId).toMatch(/^0x[a-f0-9]{40}$/i);
    expect(result.envRuntimeId.toLowerCase()).toBe(result.createdRuntimeId.toLowerCase());
    expect(result.envRuntimeId).not.toMatch(/^radapter:/);
    expect(result.height).toBeGreaterThan(0);
    expect(result.mode).toBe('embedded');
    expect(result.permissions).toBe('write');
    expect(result.adapter?.connected).toBe(true);
    expect(result.adapter?.authLevel).toBe('admin');
    expect(result.storedMode).toBe('embedded');
    expect(result.storedWs).toBe('');
    expect(result.storedAccess).toBe('');
    expect(result.sessionKey).toBe('');
  },
);

test('context dropdown groups H1 H2 H3 remote runtimes', { tag: '@functional' }, async ({ page }) => {
  const baseline = await ensureE2EBaseline(page, { requireHubMesh: true, minHubCount: 3 });
  const specs = [{ name: 'H1' }, { name: 'H2' }, { name: 'H3' }];
  const importedAt = Date.now();
  const entries: Array<{
    label: string;
    entityLabel: string;
    access: 'admin';
    wsUrl: string;
    token: string;
    runtimeId: string;
    authLevel: 'admin';
    height: number;
    entityCount: number;
    importedAt: number;
  }> = [];
  for (const spec of specs) {
    const endpoint = await resolveHubRuntimeEndpoint(page, baseline, spec.name);
    const wsUrl = endpoint.wsUrl;
    const capability = await resolveRuntimeImportCapability(page, endpoint, 'admin');
    entries.push({
      label: `${spec.name} dropdown`,
      entityLabel: spec.name,
      access: 'admin',
      wsUrl,
      token: capability.token,
      runtimeId: endpoint.runtimeId,
      authLevel: 'admin',
      height: 0,
      entityCount: 1,
      importedAt,
    });
  }

  await page.addInitScript(
    ({ storageKey, entries }) => {
      const first = entries[0]!;
      localStorage.setItem(storageKey, JSON.stringify(entries));
      localStorage.setItem('xln-runtime-adapter-mode', 'remote');
      localStorage.setItem('xln-runtime-adapter-ws', first.wsUrl);
      localStorage.setItem('xln-runtime-adapter-access', 'admin');
      sessionStorage.setItem('xln-runtime-adapter-key', first.token);
    },
    { storageKey: REMOTE_RUNTIME_IMPORT_STORAGE_KEY, entries },
  );

  await page.goto(`${APP_BASE_URL}/app#accounts`, { waitUntil: 'domcontentloaded' });

  const openContextTree = async (): Promise<void> => {
    await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="context-current"]')), null, {
      timeout: REMOTE_E2E_WAIT_MS,
    });
    await page.evaluate(() => {
      const trigger = document.querySelector('[data-testid="context-current"]') as HTMLElement | null;
      if (!trigger) throw new Error('CONTEXT_CURRENT_MISSING');
      if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
    });
    await page.waitForFunction(
      expectedRuntimeIds => {
        const trigger = document.querySelector('[data-testid="context-current"]');
        const menu = document.querySelector('.dropdown-menu');
        if (trigger?.getAttribute('aria-expanded') !== 'true' || !menu) return false;
        const groups = Array.from(menu.querySelectorAll('[data-testid="context-runtime-group"]'));
        if (groups.length < expectedRuntimeIds.length) return false;
        if (!menu.querySelector('[data-testid="context-runtime-rail"]')) return false;
        if (!menu.querySelector('[data-testid="context-runtime-focus"]')) return false;
        if (menu.querySelector('.runtime-main') || menu.querySelector('.runtime-delete')) return false;
        return expectedRuntimeIds.every(runtimeId => {
          const group = groups.find(candidate => candidate.getAttribute('data-runtime-id') === runtimeId);
          return Boolean(
            group
              ?.querySelector('[data-testid="context-runtime-source"]')
              ?.textContent?.toLowerCase()
              .includes('remote'),
          );
        });
      },
      entries.map(entry => entry.runtimeId),
      { timeout: REMOTE_E2E_WAIT_MS },
    );
  };

  const focusRuntimeRow = async (runtimeId: string, entityLabel: string): Promise<void> => {
    await openContextTree();
    await page.evaluate(targetRuntimeId => {
      const row = document.querySelector(
        `[data-testid="context-runtime-group"][data-runtime-id="${targetRuntimeId}"]`,
      ) as HTMLElement | null;
      if (!row) throw new Error(`REMOTE_RUNTIME_GROUP_MISSING:${targetRuntimeId}`);
      row.click();
    }, runtimeId);
    await page.waitForFunction(
      ({ targetRuntimeId, targetLabel }) => {
        const label = String(targetLabel || '').toLowerCase();
        const focus = document.querySelector('[data-testid="context-runtime-focus"]');
        if (!focus) return false;
        return Array.from(focus.querySelectorAll('[data-testid="context-entity-row"]')).some(
          row =>
            row.getAttribute('data-runtime-id') === targetRuntimeId &&
            String(row.textContent || '')
              .toLowerCase()
              .includes(label),
        );
      },
      { targetRuntimeId: runtimeId, targetLabel: entityLabel },
      { timeout: REMOTE_E2E_WAIT_MS },
    );
  };

  const clickRuntimeRow = async (runtimeId: string, entityLabel: string): Promise<void> => {
    await focusRuntimeRow(runtimeId, entityLabel);
    await page.evaluate(
      ({ targetRuntimeId, targetLabel }) => {
        const label = String(targetLabel || '').toLowerCase();
        const menu = document.querySelector('.dropdown-menu');
        if (!menu) throw new Error('CONTEXT_MENU_MISSING');
        if (menu.querySelector('.runtime-main')) throw new Error('LEGACY_RUNTIME_MAIN_PRESENT');
        if (menu.querySelector('.runtime-delete')) throw new Error('LEGACY_RUNTIME_DELETE_PRESENT');
        const focus = menu.querySelector('[data-testid="context-runtime-focus"]');
        if (!focus) throw new Error('CONTEXT_RUNTIME_FOCUS_MISSING');
        const row = Array.from(focus.querySelectorAll('[data-testid="context-entity-row"]')).find(
          candidate =>
            candidate.getAttribute('data-runtime-id') === targetRuntimeId &&
            String(candidate.textContent || '')
              .toLowerCase()
              .includes(label),
        ) as HTMLElement | undefined;
        if (!row) throw new Error(`REMOTE_RUNTIME_ENTITY_ROW_MISSING:${targetRuntimeId}:${targetLabel}`);
        row.click();
      },
      { targetRuntimeId: runtimeId, targetLabel: entityLabel },
    );
  };

  const waitForRuntime = async (entry: (typeof entries)[number]): Promise<void> => {
    await page.waitForFunction(
      ({ runtimeId, label }) => {
        const view = window as typeof window & {
          __xlnRuntimeView?: {
            runtimeId?: string;
            height?: number;
            entities?: Array<{ label?: string; isHub?: boolean }>;
            frame?: { entities?: Array<{ label?: string; isHub?: boolean }> | null };
          };
          __xlnRuntimeAdapter?: { status: () => { authLevel?: string | null } };
        };
        const runtimeView = (view as any).__xln?.view;
        if (String(runtimeView?.runtimeId || '') !== runtimeId || Number(runtimeView?.height || 0) < 1) return false;
        if ((view as any).__xln?.adapter?.status().authLevel !== 'admin') return false;
        const expected = label.toLowerCase();
        const entities = runtimeView?.entities ?? runtimeView?.frame?.entities ?? [];
        return entities.some(
          entity =>
            entity.isHub === true &&
            String(entity.label || '')
              .toLowerCase()
              .includes(expected),
        );
      },
      { runtimeId: entry.runtimeId, label: entry.entityLabel },
      { timeout: REMOTE_E2E_WAIT_MS },
    );
    const state = await page.evaluate(() => {
      const view = window as typeof window & {
        __xlnRuntimeView?: { runtimeId?: string; height?: number };
        __xlnRuntimeAdapter?: { status: () => { authLevel?: string | null } };
      };
      return {
        runtimeId: String((view as any).__xln?.view?.runtimeId || ''),
        height: Number((view as any).__xln?.view?.height || 0),
        authLevel: String((view as any).__xln?.adapter?.status().authLevel || ''),
        activeWsUrl: localStorage.getItem('xln-runtime-adapter-ws') || '',
        contextRuntimeId:
          document.querySelector('[data-testid="context-current"]')?.getAttribute('data-runtime-id') || '',
      };
    });
    expect(state.runtimeId).toBe(entry.runtimeId);
    expect(state.height).toBeGreaterThan(0);
    expect(state.authLevel).toBe('admin');
    expect(state.activeWsUrl).toBe(entry.wsUrl);
    expect(state.contextRuntimeId).toBe(entry.runtimeId);
  };

  await openContextTree();
  const tree = await page.evaluate(() => {
    const menu = document.querySelector('.dropdown-menu');
    if (!menu) throw new Error('CONTEXT_MENU_MISSING');
    return Array.from(menu.querySelectorAll('[data-testid="context-runtime-group"]')).map(group => ({
      runtimeId: group.getAttribute('data-runtime-id') || '',
      source: group.querySelector('[data-testid="context-runtime-source"]')?.textContent?.trim().toLowerCase() || '',
    }));
  });
  for (const entry of entries) {
    const group = tree.find(candidate => candidate.runtimeId === entry.runtimeId);
    expect(group, `runtime group ${entry.entityLabel}`).toBeTruthy();
    expect(group?.source).toContain('remote');
    await focusRuntimeRow(entry.runtimeId, entry.entityLabel);
    const focus = await page.evaluate(runtimeId => {
      const panel = document.querySelector('[data-testid="context-runtime-focus"]');
      return {
        jurisdictionCount: panel?.querySelectorAll('[data-testid="context-jurisdiction-group"]').length || 0,
        rows: Array.from(panel?.querySelectorAll('[data-testid="context-entity-row"]') || []).map(row => ({
          runtimeId: row.getAttribute('data-runtime-id') || '',
          text: String(row.textContent || '').toLowerCase(),
        })),
        runtimeId,
      };
    }, entry.runtimeId);
    expect(focus.jurisdictionCount).toBeGreaterThan(0);
    expect(
      focus.rows.some(row => row.runtimeId === entry.runtimeId && row.text.includes(entry.entityLabel.toLowerCase())),
    ).toBe(true);
  }

  const switchTarget = entries[1] ?? entries[0]!;
  await clickRuntimeRow(switchTarget.runtimeId, switchTarget.entityLabel);
  await waitForRuntime(switchTarget);
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

    await page.goto(
      `${APP_BASE_URL}/app?runtime=remote&ws=${encodeURIComponent(h1Endpoint.wsUrl)}&token=${encodeURIComponent(adminKey)}#accounts`,
      {
        waitUntil: 'domcontentloaded',
      },
    );

    await page.waitForFunction(
      ({ expectedRuntimeId, hubId }) => {
        const view = window as typeof window & {
          __xlnRuntimeView?: {
            runtimeId?: string;
            height?: number;
            entities?: Array<{ entityId?: string; isHub?: boolean }>;
            frame?: { entities?: Array<{ entityId?: string; isHub?: boolean }> | null };
          };
          __xlnRuntimeAdapter?: {
            status: () => { authLevel?: string | null };
          };
        };
        const runtimeView = (view as any).__xln?.view;
        const status = (view as any).__xln?.adapter?.status();
        if (status?.authLevel !== 'admin') return false;
        if (String(runtimeView?.runtimeId || '') !== expectedRuntimeId || Number(runtimeView?.height || 0) < 1)
          return false;
        const entities = runtimeView?.entities ?? runtimeView?.frame?.entities ?? [];
        return entities.some(entity => String(entity.entityId || '').toLowerCase() === hubId && entity.isHub === true);
      },
      { expectedRuntimeId: h1Endpoint.runtimeId, hubId: h1 },
      { timeout: REMOTE_E2E_WAIT_MS },
    );

    await openAccountWorkspaceTab(page, 'swap');
    await expect(page.getByTestId('swap-any-builder')).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });
    await expect(page.getByTestId('swap-market-section')).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });
    await expect(page.locator('body')).not.toContainText('Swap requires a live runtime frame.');
    await expect(page.locator('body')).not.toContainText('Swap projection is not available yet.');
    expect(consoleProblems.filter(message => /XLN environment not ready|TypeError|pageerror/i.test(message))).toEqual(
      [],
    );
  },
);

test('admin remote runtime opens normal app workspace', { tag: '@functional' }, async ({ page }) => {
  const baseline = await ensureE2EBaseline(page, { requireHubMesh: true, minHubCount: 3 });
  const h1Endpoint = await resolveHubRuntimeEndpoint(page, baseline, 'H1');
  const adminKey = (await resolveRuntimeImportCapability(page, h1Endpoint, 'admin')).token;
  const consoleProblems: string[] = [];
  page.on('console', message => {
    const text = message.text();
    if (/\[vite\]|Ignoring Event: localhost/.test(text)) return;
    if (message.type() === 'error' || message.type() === 'warning') consoleProblems.push(`${message.type()}: ${text}`);
  });
  page.on('pageerror', error => consoleProblems.push(`pageerror: ${error.message}`));

  await page.goto(
    `${APP_BASE_URL}/app?runtime=remote&ws=${encodeURIComponent(h1Endpoint.wsUrl)}&token=${encodeURIComponent(adminKey)}#accounts`,
    { waitUntil: 'domcontentloaded' },
  );

  await page.waitForFunction(
    () => {
      const view = window as typeof window & {
        __xlnRuntimeView?: { height?: number };
        __xlnRuntimeAdapter?: { status: () => { connected?: boolean; authLevel?: string | null } };
      };
      const status = (view as any).__xln?.adapter?.status();
      return (
        status?.connected === true && status.authLevel === 'admin' && Number((view as any).__xln?.view?.height || 0) > 0
      );
    },
    null,
    { timeout: REMOTE_E2E_WAIT_MS },
  );
  await page.waitForSelector('[data-testid="entity-workspace"]', { timeout: REMOTE_E2E_WAIT_MS });

  const result = await page.evaluate(() => {
    const text = document.body.textContent || '';
    const workspace = document.querySelector('[data-testid="entity-workspace"]');
    const view = window as typeof window & {
      __xlnRuntimeAdapter?: { status: () => { authLevel?: string | null } };
    };
    return {
      authLevel: String((view as any).__xln?.adapter?.status().authLevel || ''),
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

  expect(result.authLevel).toBe('admin');
  expect(result.walletLens).toBe(false);
  expect(result.opsLens).toBe(false);
  expect(result.liquidityLens).toBe(false);
  expect(result.auditLens).toBe(false);
  expect(result.settingsDataMounted).toBe(false);
  expect(result.fullAccessWarning).toBe(false);
  await expect(page.locator('[data-testid="entity-workspace-readonly"]')).toHaveCount(0);
  await openAccountWorkspaceTab(page, 'open');
  await expect(page.getByTestId('account-list-wrapper').first()).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });
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

    await page.goto(
      `${APP_BASE_URL}/app?runtime=remote&ws=${encodeURIComponent(h1Endpoint.wsUrl)}&token=${encodeURIComponent(adminKey)}#accounts`,
      { waitUntil: 'domcontentloaded' },
    );

    await page.waitForFunction(
      ({ expectedRuntimeId }) => {
        const view = window as typeof window & {
          __xlnRuntimeView?: { runtimeId?: string; height?: number };
          __xlnRuntimeAdapter?: {
            status: () => {
              connected?: boolean;
              authLevel?: string | null;
              runtimeId?: string;
              permissions?: string;
            };
          };
        };
        const status = (view as any).__xln?.adapter?.status();
        return (
          status?.connected === true &&
          status.authLevel === 'admin' &&
          status.permissions === 'write' &&
          String((view as any).__xln?.view?.runtimeId || status.runtimeId || '') === expectedRuntimeId &&
          Number((view as any).__xln?.view?.height || 0) > 0
        );
      },
      { expectedRuntimeId: h1Endpoint.runtimeId },
      { timeout: REMOTE_E2E_WAIT_MS },
    );

    const result = await page.evaluate(
      async ({ hubId }) => {
        const view = window as typeof window & {
          __xlnRuntimeAdapter?: RuntimeAdapterDebugSurface;
        };
        const adapter = (view as any).__xln?.adapter;
        if (!adapter) throw new Error('XLN_RUNTIME_ADAPTER_DEBUG_SURFACE_MISSING');
        type Head = { latestHeight?: number };
        type ViewFrame = {
          height?: number;
          activeEntity?: {
            accounts?: { items?: unknown[]; totalItems?: number };
          } | null;
        };

        const statusBefore = adapter.status();
        const headBefore = await adapter.query.head<Head>();
        const frameBefore = await adapter.query.viewFrame<ViewFrame>({
          entityId: hubId,
          accountsLimit: 10,
          booksLimit: 1,
        });

        const sendPresent = typeof adapter.send === 'function';

        const statusAfter = adapter.status();
        const headAfter = await adapter.query.head<Head>();
        const frameAfter = await adapter.query.viewFrame<ViewFrame>({
          entityId: hubId,
          accountsLimit: 10,
          booksLimit: 1,
        });
        return {
          authLevelBefore: String(statusBefore.authLevel || ''),
          authLevelAfter: String(statusAfter.authLevel || ''),
          permissionsBefore: String(statusBefore.permissions || ''),
          permissionsAfter: String(statusAfter.permissions || ''),
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
    expect(result.permissionsBefore).toBe('write');
    expect(result.permissionsAfter).toBe('write');
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

    await page.goto(
      `${APP_BASE_URL}/address?runtime=remote&ws=${encodeURIComponent(h1Endpoint.wsUrl)}&token=${encodeURIComponent(adminKey)}`,
      { waitUntil: 'domcontentloaded' },
    );

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
  'admin remote runtime opens settings projection without legacy RuntimeState settings',
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

    await page.goto(
      `${APP_BASE_URL}/app?runtime=remote&ws=${encodeURIComponent(h1Endpoint.wsUrl)}&token=${encodeURIComponent(adminKey)}#settings`,
      { waitUntil: 'domcontentloaded' },
    );

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
        legacySettingsMounted:
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
    expect(result.legacySettingsMounted).toBe(false);
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
    '/health must read runtime projections through RuntimeQueryClient, not legacy debug entity/event APIs',
  ).toEqual([]);
  expect(
    consoleProblems.filter(message =>
      /Failed to fetch health|Runtime adapter is not connected|pageerror/i.test(message),
    ),
  ).toEqual([]);
  await expect(page.locator('#runtime-adapter')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open app' })).toHaveAttribute('href', '/app');

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

  await page.goto(`${APP_BASE_URL}/radapter?ws=${encodeURIComponent(wsUrl)}&token=${encodeURIComponent(adminKey)}`, {
    waitUntil: 'domcontentloaded',
  });
  await expect(page).toHaveURL(/\/app#accounts$/);
  await page.waitForFunction(
    () => {
      const view = window as typeof window & {
        __xlnRuntimeAdapter?: { status: () => { connected?: boolean; authLevel?: string | null } };
      };
      const status = (view as any).__xln?.adapter?.status();
      return status?.connected === true && status.authLevel === 'admin';
    },
    null,
    { timeout: REMOTE_E2E_WAIT_MS },
  );
  const appState = await page.evaluate(() => ({
    url: window.location.href,
    activeWsUrl: localStorage.getItem('xln-runtime-adapter-ws') || '',
    storedAccess: localStorage.getItem('xln-runtime-adapter-access') || '',
    sessionKey: sessionStorage.getItem('xln-runtime-adapter-key') || '',
  }));
  expect(appState.url).not.toContain('runtime=remote');
  expect(appState.url).not.toContain('ws=');
  expect(appState.activeWsUrl).toBe(wsUrl);
  expect(appState.storedAccess).toBe('admin');
  expect(appState.sessionKey).toBe(adminKey);
  await expect(page.getByTestId('entity-workspace')).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });

  await page.goto(`${APP_BASE_URL}/admin`, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/health$/);
  await expect(page.getByRole('heading', { name: 'xln health admin' })).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });
});

test(
  'health runtime adapter renders 1M aggregate snapshot without freezing',
  { tag: '@resilience' },
  async ({ page }) => {
    await installOneMillionRuntimeAdapterSocket(page);

    await page.goto(`${APP_BASE_URL}/health`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'xln health admin' })).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });
    await expect
      .poll(
        async () =>
          await page.evaluate(
            () =>
              (window.WebSocket as unknown as { __xlnOneMillionRuntimeAdapterSocket?: boolean })
                .__xlnOneMillionRuntimeAdapterSocket === true,
          ),
        { timeout: 2_000 },
      )
      .toBe(true);

    const adapterPanel = page.locator('#runtime-adapter');
    await expect(adapterPanel).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });
    await adapterPanel
      .locator('input[placeholder="ws://127.0.0.1:8080/rpc"]')
      .fill('ws://one-million-runtime.invalid/rpc');
    await adapterPanel.locator('input[placeholder="read/admin token"]').fill('inspect-fixture');
    await adapterPanel.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect
      .poll(
        async () =>
          await page.evaluate(
            () =>
              (window as unknown as { __xlnOneMillionRuntimeAdapterStats?: { sentCount: number } })
                .__xlnOneMillionRuntimeAdapterStats?.sentCount ?? 0,
          ),
        { timeout: 2_000 },
      )
      .toBeGreaterThanOrEqual(1);

    await expect
      .poll(
        async () =>
          await page.evaluate(() => {
            const view = window as typeof window & {
              __xlnRuntimeAdapter?: { status: () => { connected?: boolean; authLevel?: string | null } };
            };
            const status = (view as any).__xln?.adapter?.status();
            return status?.connected === true && status.authLevel === 'inspect';
          }),
        { timeout: REMOTE_E2E_WAIT_MS },
      )
      .toBe(true);
    await expect(adapterPanel.getByTestId('radapter-account-total')).toContainText('1,000,000');
    await expect(adapterPanel.getByTestId('radapter-account-visible')).toContainText('10');
    await expect(adapterPanel.getByTestId('radapter-account-page')).toContainText('1/100,000');
    await expect(adapterPanel.getByTestId('radapter-account-has-more')).toContainText('cursor available');
    await expect(adapterPanel.getByTestId('radapter-account-row')).toHaveCount(10);
    await expect(adapterPanel.getByTestId('radapter-state-hash')).toHaveCount(3);
    await expect(adapterPanel.getByTestId('radapter-top-delta')).toHaveCount(3);

    const stats = await page.evaluate(
      () =>
        (
          window as unknown as {
            __xlnOneMillionRuntimeAdapterStats?: {
              sentCount: number;
              viewFrameBytes: number;
              maxPayloadBytes: number;
              maxAccountItems: number;
            };
          }
        ).__xlnOneMillionRuntimeAdapterStats,
    );
    expect(stats?.sentCount).toBeGreaterThanOrEqual(3);
    expect(stats?.viewFrameBytes ?? Number.POSITIVE_INFINITY).toBeLessThan(100_000);
    expect(stats?.maxAccountItems).toBe(10);
  },
);

test(
  'halted remote runtime disables wallet commands and links the root incident',
  { tag: '@resilience' },
  async ({ page }, testInfo) => {
    const fixture = await installOneMillionRuntimeAdapterSocket(page, {
      authLevel: 'admin',
      commandReady: false,
      commandReadyReason: 'phase=halted',
    });
    const token = deriveRuntimeAdapterCapabilityToken('halted-runtime-e2e-capability', 'admin', Date.now() + 60_000, {
      audience: fixture.runtimeId,
    });
    const fingerprint = 'runtime-halted-e2e12345';
    await page.route('**/api/debug/incidents?**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          incidents: [
            {
              fingerprint,
              code: 'RUNTIME_HALTED',
              runtimeId: fixture.runtimeId,
            },
          ],
        }),
      });
    });

    await page.goto(
      `${APP_BASE_URL}/app?runtime=remote&ws=${encodeURIComponent(fixture.wsUrl)}&token=${encodeURIComponent(token)}#accounts`,
      { waitUntil: 'domcontentloaded' },
    );
    await expect(page.getByTestId('entity-workspace')).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });
    const gate = page.getByTestId('runtime-command-gate');
    await expect(gate).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });
    await expect(page.getByTestId('runtime-command-gate-reason')).toHaveText('phase=halted');
    await expect(page.getByTestId('runtime-command-gate-incident')).toHaveText(fingerprint);

    let faucetPosts = 0;
    await page.route('**/api/faucet/**', async route => {
      if (route.request().method() === 'POST') faucetPosts += 1;
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"success":false}' });
    });

    await page.getByTestId('tab-assets').click();
    const assetFaucet = page.getByTestId('external-faucet-USDC');
    await expect(assetFaucet).toBeDisabled();
    await assetFaucet.evaluate((button: HTMLButtonElement) => button.click());

    await openAccountWorkspaceTab(page, 'open');
    await expect(page.getByTestId('open-account-submit')).toBeDisabled();
    await openAccountWorkspaceTab(page, 'send');
    await expect(page.getByText('Payments are only available in LIVE mode.')).toBeVisible();
    await openAccountWorkspaceTab(page, 'swap');
    await expect(page.getByTestId('swap-submit-order')).toBeDisabled();
    await openAccountWorkspaceTab(page, 'lending');
    await expect(page.getByTestId('lending-offer-submit')).toBeDisabled();

    const mutationCounts = await page.evaluate(() => {
      const stats = (
        window as unknown as {
          __xlnOneMillionRuntimeAdapterStats?: { requestOps?: Record<string, number> };
        }
      ).__xlnOneMillionRuntimeAdapterStats;
      return { sends: Number(stats?.requestOps?.['send'] || 0) };
    });
    expect(mutationCounts).toEqual({ sends: 0 });
    expect(faucetPosts).toBe(0);
    const readiness = await page.evaluate(() => {
      const status = (
        window as typeof window & {
          __xln?: { adapter?: { status?: () => Record<string, unknown> } };
        }
      ).__xln?.adapter?.status?.();
      return {
        ready: status?.['commandReady'],
        reason: status?.['commandReadyReason'],
      };
    });
    expect(readiness).toEqual({ ready: false, reason: 'phase=halted' });
    await captureLocatorScreenshot(gate, testInfo, 'runtime-command-gate-halted.png', {
      ux: {
        title: 'Runtime fail-stop command gate',
        group: 'system-health',
        description: 'Canonical halted state disables wallet money actions and links the durable root incident.',
        platform: 'desktop',
        tags: ['runtime', 'incident', 'fail-stop'],
      },
    });
  },
);

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

    await page.goto(
      `${APP_BASE_URL}/app?runtime=remote&ws=${encodeURIComponent(h2Endpoint.wsUrl)}&token=${encodeURIComponent(adminKey)}#accounts`,
      { waitUntil: 'domcontentloaded' },
    );
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
    await expect(submit).toBeDisabled();
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
