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

import type { Env } from '../runtime/types';

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
  } as Env;
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
    await page.addInitScript(() => {
      localStorage.setItem('xln-settings', JSON.stringify({ showTimeMachine: true }));
    });
    await page.goto(
      `${APP_BASE_URL}/app?runtime=remote&ws=${encodeURIComponent(wsUrl)}&token=${encodeURIComponent(adminKey)}#accounts`,
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
        };
        const runtimeView = (view as any).__xln?.view;
        if (String(runtimeView?.runtimeId || '') !== expectedRuntimeId || Number(runtimeView?.height || 0) < 1)
          return false;
        const entities = runtimeView?.entities ?? runtimeView?.frame?.entities ?? [];
        return entities.some(entity => String(entity.entityId || '').toLowerCase() === hubId && entity.isHub === true);
      },
      { expectedRuntimeId: h1Endpoint.runtimeId, hubId: h1 },
      { timeout: REMOTE_E2E_WAIT_MS },
    );
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('xln-settings') || '{}').showTimeMachine)).toBe(
      true,
    );

    const accessBeforeReload = await page.evaluate(() => {
      const view = window as typeof window & {
        __xlnRuntimeAdapter?: {
          status: () => { authLevel?: string | null };
        };
      };
      return {
        authLevel: String((view as any).__xln?.adapter?.status().authLevel || ''),
        storedAccess: localStorage.getItem('xln-runtime-adapter-access'),
        registryStoredLocally: Boolean(localStorage.getItem('xln-remote-runtime-imports')),
        registryStoredInSession: Boolean(sessionStorage.getItem('xln-remote-runtime-imports')),
        activeKeyPresent: Boolean(sessionStorage.getItem('xln-runtime-adapter-key')),
        readOnlyWarningCount: Array.from(document.body.querySelectorAll('*')).filter(node =>
          (node.textContent || '').includes('Account opening requires admin runtime access'),
        ).length,
      };
    });
    expect(accessBeforeReload.authLevel).toBe('admin');
    expect(accessBeforeReload.storedAccess).toBe('admin');
    expect(accessBeforeReload.registryStoredLocally).toBe(true);
    expect(accessBeforeReload.registryStoredInSession).toBe(false);
    expect(accessBeforeReload.activeKeyPresent).toBe(true);
    expect(accessBeforeReload.readOnlyWarningCount).toBe(0);

    await page.reload({ waitUntil: 'domcontentloaded' });
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
        if (String(runtimeView?.runtimeId || '') !== expectedRuntimeId || Number(runtimeView?.height || 0) < 1)
          return false;
        if (status?.authLevel !== 'admin') return false;
        const entities = runtimeView?.entities ?? runtimeView?.frame?.entities ?? [];
        return entities.some(entity => String(entity.entityId || '').toLowerCase() === hubId && entity.isHub === true);
      },
      { expectedRuntimeId: h1Endpoint.runtimeId, hubId: h1 },
      { timeout: REMOTE_E2E_WAIT_MS },
    );
    const accessAfterReload = await page.evaluate(() => {
      const view = window as typeof window & {
        __xlnRuntimeAdapter?: {
          status: () => { authLevel?: string | null };
        };
      };
      return {
        authLevel: String((view as any).__xln?.adapter?.status().authLevel || ''),
        storedAccess: localStorage.getItem('xln-runtime-adapter-access'),
        registryStoredLocally: Boolean(localStorage.getItem('xln-remote-runtime-imports')),
        registryStoredInSession: Boolean(sessionStorage.getItem('xln-remote-runtime-imports')),
        activeKeyPresent: Boolean(sessionStorage.getItem('xln-runtime-adapter-key')),
        readOnlyWarningCount: Array.from(document.body.querySelectorAll('*')).filter(node =>
          (node.textContent || '').includes('Account opening requires admin runtime access'),
        ).length,
      };
    });
    expect(accessAfterReload.authLevel).toBe('admin');
    expect(accessAfterReload.storedAccess).toBe('admin');
    expect(accessAfterReload.registryStoredLocally).toBe(true);
    expect(accessAfterReload.registryStoredInSession).toBe(false);
    expect(accessAfterReload.activeKeyPresent).toBe(true);
    expect(accessAfterReload.readOnlyWarningCount).toBe(0);
    await expect(page.getByTestId('hub-discovery-card').first()).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });
    const openAccountAfterReload = await page.evaluate(() => {
      const bodyText = document.body.textContent || '';
      return {
        hubCards: document.querySelectorAll('[data-testid="hub-discovery-card"]').length,
        hubStates: Array.from(document.querySelectorAll('[data-testid="hub-discovery-card"]')).map(
          node => node.getAttribute('data-connection-state') || '',
        ),
        missingEnvError:
          bodyText.includes('Environment not ready') ||
          bodyText.includes('Open Account requires full runtime access') ||
          bodyText.includes('requires full runtime access'),
      };
    });
    expect(openAccountAfterReload.hubCards).toBeGreaterThan(0);
    expect(openAccountAfterReload.hubStates.every(state => ['open', 'opening', 'closed'].includes(state))).toBe(true);
    expect(openAccountAfterReload.missingEnvError).toBe(false);

    await page.evaluate(
      ({ storageKey, wsUrl: activeWsUrl, adminToken, staleToken, runtimeId }) => {
        localStorage.setItem(
          storageKey,
          JSON.stringify([
            {
              label: 'H1 admin registry restore',
              access: 'admin',
              wsUrl: activeWsUrl,
              token: adminToken,
              runtimeId,
              authLevel: 'admin',
              height: 0,
              entityCount: 1,
              importedAt: 1,
            },
          ]),
        );
        sessionStorage.setItem('xln-runtime-adapter-key', staleToken);
      },
      {
        storageKey: REMOTE_RUNTIME_IMPORT_STORAGE_KEY,
        wsUrl,
        adminToken: adminKey,
        staleToken: staleSessionToken,
        runtimeId: h1Endpoint.runtimeId,
      },
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
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
        if (String(runtimeView?.runtimeId || '') !== expectedRuntimeId || Number(runtimeView?.height || 0) < 1)
          return false;
        if (status?.authLevel !== 'admin') return false;
        const entities = runtimeView?.entities ?? runtimeView?.frame?.entities ?? [];
        return entities.some(entity => String(entity.entityId || '').toLowerCase() === hubId && entity.isHub === true);
      },
      { expectedRuntimeId: h1Endpoint.runtimeId, hubId: h1 },
      { timeout: REMOTE_E2E_WAIT_MS },
    );
    const accessAfterRegistryReload = await page.evaluate(() => {
      const view = window as typeof window & {
        __xlnRuntimeAdapter?: {
          status: () => { authLevel?: string | null };
        };
      };
      return {
        authLevel: String((view as any).__xln?.adapter?.status().authLevel || ''),
        storedAccess: localStorage.getItem('xln-runtime-adapter-access'),
        registryStoredLocally: Boolean(localStorage.getItem('xln-remote-runtime-imports')),
        registryStoredInSession: Boolean(sessionStorage.getItem('xln-remote-runtime-imports')),
        activeKeyPresent: Boolean(sessionStorage.getItem('xln-runtime-adapter-key')),
        activeKeyAccess: String(sessionStorage.getItem('xln-runtime-adapter-key') || '').split('.')[1] || '',
        readOnlyWarningCount: Array.from(document.body.querySelectorAll('*')).filter(node =>
          (node.textContent || '').includes('Account opening requires admin runtime access'),
        ).length,
      };
    });
    expect(accessAfterRegistryReload.authLevel).toBe('admin');
    expect(accessAfterRegistryReload.activeKeyAccess).toBe('full');
    expect(accessAfterRegistryReload.storedAccess).toBe('admin');
    expect(accessAfterRegistryReload.registryStoredLocally).toBe(true);
    expect(accessAfterRegistryReload.registryStoredInSession).toBe(false);
    expect(accessAfterRegistryReload.activeKeyPresent).toBe(true);
    expect(accessAfterRegistryReload.readOnlyWarningCount).toBe(0);

    const before = await page.evaluate(async hubId => {
      const view = window as typeof window & {
        __xlnRuntimeAdapter?: RuntimeAdapterDebugSurface;
      };
      const adapter = (view as any).__xln?.adapter;
      if (!adapter) throw new Error('XLN_RUNTIME_ADAPTER_DEBUG_SURFACE_MISSING');
      type ViewFrame = {
        height?: number;
        activeEntity?: {
          core?: { signerId?: string; profile?: { name?: string; isHub?: boolean } };
          accounts?: { items?: unknown[]; totalItems?: number };
        } | null;
      };
      const head = await adapter.query.head<{ latestHeight?: number }>();
      const frame = await adapter.query.viewFrame<ViewFrame>({
        entityId: hubId,
        accountsLimit: 10,
        booksLimit: 1,
      });
      const height = Math.max(Number(head.latestHeight || 0), Number(frame.height || 0));
      const history = await adapter.query.historyFrameBatch<{ frames?: Array<{ height?: number }> }>({
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
      const adapter = (window as any).__xln?.adapter as RuntimeAdapterDebugSurface | undefined;
      if (!adapter) throw new Error('XLN_RUNTIME_ADAPTER_DEBUG_SURFACE_MISSING');
      type ViewFrame = {
        height?: number;
        activeEntity?: {
          core?: { signerId?: string; profile?: { name?: string; isHub?: boolean } };
          accounts?: { items?: unknown[] };
          books?: { items?: unknown[] };
        } | null;
      };
      const frame = await adapter.query.viewFrame<ViewFrame>({
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

    await page.evaluate(() => {
      (window as any).__xln?.commands?.clear?.();
    });
    await openAccountWorkspaceTab(page, 'configure');
    await expect(page.locator('.configure-panel').first()).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });
    await expect(page.locator('.configure-panel').first()).not.toContainText(
      'Account actions require embedded runtime Env',
    );
    await page.getByTestId('configure-tab-extend-credit').first().click();
    const creditPanel = page
      .locator('.configure-panel .action-card')
      .filter({ hasText: /Extend Credit/i })
      .first();
    await expect(creditPanel).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });
    await creditPanel.locator('select.form-select').first().selectOption('1');
    const creditAmount = creditPanel.locator('input[placeholder="Credit amount"]').first();
    await expect(creditAmount).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });
    await creditAmount.fill('1');
    const extendCreditButton = creditPanel.getByRole('button', { name: /Extend Credit/i }).first();
    await expect(extendCreditButton).toBeEnabled({ timeout: REMOTE_E2E_WAIT_MS });
    await extendCreditButton.click();
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const receipt = (window as any).__xln?.commands?.latest as
              | {
                  status?: string;
                  committedAtHeight?: number | null;
                  inputSummary?: { entityInputs?: number; entityTxs?: number };
                  error?: string | null;
                }
              | null
              | undefined;
            return {
              status: String(receipt?.status || ''),
              committedAtHeight: Number(receipt?.committedAtHeight || 0),
              entityInputs: Number(receipt?.inputSummary?.entityInputs || 0),
              entityTxs: Number(receipt?.inputSummary?.entityTxs || 0),
              error: String(receipt?.error || ''),
            };
          }),
        {
          timeout: REMOTE_E2E_WAIT_MS,
          intervals: [250, 500, 1000],
        },
      )
      .toMatchObject({
        status: 'observed',
        entityInputs: 1,
        entityTxs: 1,
        error: '',
      });

    const storageCadence = await page.evaluate(async () => {
      const adapter = (window as any).__xln?.adapter as RuntimeAdapterDebugSurface | undefined;
      if (!adapter) throw new Error('XLN_RUNTIME_ADAPTER_DEBUG_SURFACE_MISSING');
      const head = await adapter.query.head<{
        latestHeight?: number;
        latestSnapshotHeight?: number;
        snapshotPeriodFrames?: number;
        retainedHistoryBytes?: number;
      }>();
      const checkpoints = await adapter.query.checkpoints<Array<{ height?: number }>>();
      return {
        latestHeight: Number(head.latestHeight || 0),
        latestSnapshotHeight: Number(head.latestSnapshotHeight || 0),
        snapshotPeriodFrames: Number(head.snapshotPeriodFrames || 0),
        epochReplayBytes: 0,
        retainedHistoryBytes: Number(head.retainedHistoryBytes || 0),
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
      const adapter = (window as any).__xln?.adapter as RuntimeAdapterDebugSurface | undefined;
      if (!adapter) throw new Error('XLN_RUNTIME_ADAPTER_DEBUG_SURFACE_MISSING');
      const head = await adapter.query.head<{ latestHeight?: number }>();
      return Number(head.latestHeight || 0);
    });
    await page.evaluate(() => {
      (window as any).__xln?.commands?.clear?.();
    });
    await page.getByTestId('tab-settings').click();
    const settingsPanel = page.getByTestId('entity-settings-projection-panel');
    await expect(settingsPanel).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });
    await settingsPanel.getByLabel('Name').fill(nextProfileName);
    await settingsPanel.getByLabel('Bio').fill('admin-e2e-control');
    await settingsPanel.getByRole('button', { name: /Save Profile/i }).click();
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const receipt = (window as any).__xln?.commands?.latest as
              | {
                  status?: string;
                  upstreamReceiptId?: string | null;
                  statusUrl?: string | null;
                  acceptedAtHeight?: number | null;
                  inputSummary?: { entityInputs?: number; entityTxs?: number };
                  error?: string | null;
                }
              | null
              | undefined;
            return {
              status: String(receipt?.status || ''),
              entityInputs: Number(receipt?.inputSummary?.entityInputs || 0),
              entityTxs: Number(receipt?.inputSummary?.entityTxs || 0),
              error: String(receipt?.error || ''),
            };
          }),
        {
          timeout: REMOTE_E2E_WAIT_MS,
          intervals: [250, 500, 1000],
        },
      )
      .toMatchObject({
        status: 'observed',
        entityInputs: 1,
        entityTxs: 1,
        error: '',
      });
    const controlResult = await page.evaluate(async beforeHeight => {
      const view = window as typeof window & {
        __xlnRuntimeCommands?: {
          latest?: {
            receiptId?: string;
            upstreamReceiptId?: string | null;
            statusUrl?: string | null;
            status?: string;
            acceptedAtHeight?: number | null;
            committedAtHeight?: number | null;
            error?: string | null;
          } | null;
        };
      };
      const adapter = (view as any).__xln?.adapter;
      if (!adapter) throw new Error('XLN_RUNTIME_ADAPTER_DEBUG_SURFACE_MISSING');
      const receipt = (view as any).__xln?.commands?.latest ?? null;
      return {
        beforeHeight,
        sendHeight: Number(receipt?.acceptedAtHeight ?? 0),
        receipt,
      };
    }, beforeControlHeight);

    expect(controlResult.beforeHeight).toBeGreaterThanOrEqual(activeH1Before.height);
    expect(controlResult.sendHeight).toBeGreaterThanOrEqual(controlResult.beforeHeight);
    expect(controlResult.receipt?.receiptId).toMatch(/^runtime-command-/);
    expect(controlResult.receipt?.upstreamReceiptId).toBeTruthy();
    expect(controlResult.receipt?.statusUrl).toContain('/api/control/runtime-input/');
    expect(['accepted', 'observed']).toContain(controlResult.receipt?.status);
    // The normal wallet intentionally hides accepted/observed terminal receipts;
    // the durable receipt remains inspectable through the command debug surface.
    await expect(page.getByTestId('runtime-command-receipt')).toBeHidden();

    const after = await waitForAdminControlProbe(
      page,
      { hubId: h1, minHeight: controlResult.beforeHeight, expectedName: nextProfileName },
      90_000,
    );
    await expect
      .poll(async () => page.evaluate(() => String((window as any).__xln?.commands?.latest?.status || '')), {
        timeout: REMOTE_E2E_WAIT_MS,
      })
      .toBe('observed');
    const observedReceipt = await page.evaluate(() => {
      const receipt = (window as any).__xln?.commands?.latest as
        | {
            status?: string;
            committedAtHeight?: number | null;
          }
        | null
        | undefined;
      return {
        status: String(receipt?.status || ''),
        committedAtHeight: Number(receipt?.committedAtHeight || 0),
      };
    });
    expect(observedReceipt.status).toBe('observed');
    expect(observedReceipt.committedAtHeight).toBeGreaterThan(controlResult.beforeHeight);

    expect(after.envHeight).toBeGreaterThan(controlResult.beforeHeight);
    expect(after.envName).toBe(nextProfileName);
    expect(after.accountCount).toBeLessThanOrEqual(10);
    expect(after.historyLength).toBeGreaterThanOrEqual(2);
    expect(after.historyLength).toBeLessThanOrEqual(12);
    expect(after.historyHeights).toContain(controlResult.beforeHeight);
    expect(after.historyHeights).toContain(after.envHeight);

    const activityProbe = await page.evaluate(async entityId => {
      const adapter = (window as any).__xln?.adapter as RuntimeAdapterDebugSurface | undefined;
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
      const page = await adapter.query.activity<ActivityPage>({
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
        const adapter = (window as any).__xln?.adapter as RuntimeAdapterDebugSurface | undefined;
        if (!adapter) throw new Error('XLN_RUNTIME_ADAPTER_DEBUG_SURFACE_MISSING');
        type ViewFrame = {
          height?: number;
          activeEntity?: {
            core?: { profile?: { name?: string } };
            accounts?: { items?: unknown[] };
            books?: { items?: unknown[] };
          } | null;
        };
        const beforeFrame = await adapter.query.viewFrame<ViewFrame>({
          atHeight: beforeHeight,
          entityId,
          accountsLimit: 1,
          booksLimit: 1,
        });
        const afterFrame = await adapter.query.viewFrame<ViewFrame>({
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
        const adapter = (window as any).__xln?.adapter as RuntimeAdapterDebugSurface | undefined;
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
        const batch = await adapter.query.historyFrameBatch<HistoryBatch>({
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

    await settingsPanel.getByRole('button', { name: 'Display', exact: true }).click();
    await expect(settingsPanel.getByTestId('settings-time-machine-toggle')).toBeChecked();
    await expect(page.getByTestId('time-machine-remote-scan')).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });
    await expect(page.getByTestId('time-machine-remote-target')).toBeVisible();
    await expect(page.getByTestId('time-machine-remote-target')).toContainText(/hub/i);
    await page.getByTestId('time-machine-remote-height').fill(String(controlResult.beforeHeight));
    await page.getByTestId('time-machine-remote-scan-button').click();
    await expect(page.getByTestId('time-machine-remote-scan-status')).toContainText(`h${controlResult.beforeHeight}`, {
      timeout: REMOTE_E2E_WAIT_MS,
    });
    await expect(page.getByTestId('time-machine-remote-scan-status')).toContainText(/ms/);
    await expect(page.getByTestId('time-machine-frame-badge')).not.toContainText(/LIVE/);
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const view = (window as any).__xln?.view;
            return {
              atHeight: view?.atHeight ?? null,
              frameHeight: Number(view?.frame?.height || 0),
              profileName: String(view?.frame?.activeEntity?.core?.profile?.name || ''),
              accountsShown: Number(view?.frame?.activeEntity?.accounts?.items?.length || 0),
              warningCount: document.querySelectorAll('.history-warning').length,
            };
          }),
        { timeout: REMOTE_E2E_WAIT_MS },
      )
      .toEqual({
        atHeight: controlResult.beforeHeight,
        frameHeight: controlResult.beforeHeight,
        profileName: activeH1Before.profileName,
        accountsShown: expect.any(Number),
        warningCount: 0,
      });
    await expect(page.getByTestId('time-machine-remote-diff')).toContainText(/Δh/);
    await page.getByTestId('time-machine-remote-deeplink').click();
    await expect.poll(() => new URL(page.url()).hash).toContain(`tmHeight=${controlResult.beforeHeight}`);
    await expect.poll(() => new URL(page.url()).hash).toContain('tmEntity=');
    const timeMachineProbe = await page.evaluate(async height => {
      const view = window as typeof window & {
        __xlnRuntimeAdapter?: RuntimeAdapterDebugSurface;
      };
      const adapter = (view as any).__xln?.adapter;
      if (!adapter) throw new Error('XLN_RUNTIME_ADAPTER_DEBUG_SURFACE_MISSING');
      const [head, batch] = await Promise.all([
        adapter.query.head<{ latestHeight?: number }>(),
        adapter.query.historyFrameBatch<{ frames?: Array<{ height?: number }> }>({
          heights: [height],
          accountsLimit: 1,
          booksLimit: 1,
        }),
      ]);
      const heights = (batch.frames ?? []).map(frame => Number(frame.height || 0));
      return {
        historyLength: heights.length,
        hasRequestedHeight: heights.includes(height),
        maxHistoryHeight: Math.max(Number(head.latestHeight || 0), ...heights),
      };
    }, controlResult.beforeHeight);
    expect(timeMachineProbe.historyLength).toBeGreaterThanOrEqual(1);
    expect(timeMachineProbe.historyLength).toBeLessThanOrEqual(2);
    expect(timeMachineProbe.hasRequestedHeight).toBe(true);
    expect(timeMachineProbe.maxHistoryHeight).toBeGreaterThanOrEqual(after.envHeight);

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
        async () =>
          page.evaluate(() => {
            const view = (window as any).__xln?.view;
            return {
              atHeight: view?.atHeight ?? null,
              frameHeight: Number(view?.frame?.height || 0),
              profileName: String(view?.frame?.activeEntity?.core?.profile?.name || ''),
            };
          }),
        { timeout: REMOTE_E2E_WAIT_MS },
      )
      .toEqual({
        atHeight: null,
        frameHeight: expect.any(Number),
        profileName: nextProfileName,
      });
    const liveProjectionHeight = await page.evaluate(() => Number((window as any).__xln?.view?.frame?.height || 0));
    expect(liveProjectionHeight).toBeGreaterThanOrEqual(after.envHeight);
  },
);

test(
  'runtime dropdown switches app-imported remote runtimes without manager route',
  { tag: '@functional' },
  async ({ page }) => {
    test.setTimeout(480_000);
    const baseline = await ensureE2EBaseline(page, {
      requireHubMesh: true,
      requireMarketMaker: true,
      requireCustody: true,
      minHubCount: 3,
      timeoutMs: 300_000,
      allowAutoReset: false,
    });
    const h1Endpoint = await resolveHubRuntimeEndpoint(page, baseline, 'H1');
    const h2Endpoint = await resolveHubRuntimeEndpoint(page, baseline, 'H2');
    const h1WsUrl = h1Endpoint.wsUrl;
    const h2WsUrl = h2Endpoint.wsUrl;

    const h1Key = (await resolveRuntimeImportCapability(page, h1Endpoint, 'admin')).token;
    await page.goto(
      `${APP_BASE_URL}/app?runtime=remote&ws=${encodeURIComponent(h1WsUrl)}&token=${encodeURIComponent(h1Key)}`,
      {
        waitUntil: 'domcontentloaded',
      },
    );
    await page.waitForFunction(
      expectedRuntimeId => String((window as any).__xln?.view?.runtimeId || '') === expectedRuntimeId,
      h1Endpoint.runtimeId,
      { timeout: REMOTE_E2E_WAIT_MS },
    );

    await page.getByTestId('context-current').click();
    await expect(page.getByTestId('remote-runtime-manager')).toHaveCount(0);
    await expect(page.locator('.remote-manager-link')).toHaveCount(0);
    await page.keyboard.press('Escape');

    const importUrl = await resolveRuntimeImportAppUrl(page, {
      appBaseUrl: APP_BASE_URL,
      apiBaseUrl: API_BASE_URL,
      access: 'admin',
    });
    expect(importUrl).toContain('/app#runtime-import');
    expect(importUrl).not.toContain('/radapter/manage');
    await page.goto(importUrl, { waitUntil: 'domcontentloaded' });
    const importSummary = await readRuntimeImportSummary(page, 120_000);
    expect(importSummary.entries.some(entry => entry.runtimeId === h2Endpoint.runtimeId)).toBe(true);
    expect(importSummary.failedCount ?? 0).toBe(0);

    await page.getByTestId('context-current').click();
    await page.evaluate(targetRuntimeId => {
      const runtime = document.querySelector(
        `[data-testid="context-runtime-group"][data-runtime-id="${targetRuntimeId}"]`,
      ) as HTMLElement | null;
      if (!runtime) throw new Error(`REMOTE_RUNTIME_GROUP_MISSING:${targetRuntimeId}`);
      runtime.click();
    }, h2Endpoint.runtimeId);
    await page.waitForFunction(
      ({ targetRuntimeId }) => {
        const focus = document.querySelector('[data-testid="context-runtime-focus"]');
        return Array.from(focus?.querySelectorAll('[data-testid="context-entity-row"]') ?? []).some(
          row =>
            row.getAttribute('data-runtime-id') === targetRuntimeId && row.getAttribute('data-entity-label') === 'h2',
        );
      },
      { targetRuntimeId: h2Endpoint.runtimeId },
      { timeout: REMOTE_E2E_WAIT_MS },
    );
    await page.evaluate(
      ({ targetRuntimeId }) => {
        const focus = document.querySelector('[data-testid="context-runtime-focus"]');
        if (!focus) throw new Error('CONTEXT_RUNTIME_FOCUS_MISSING');
        const row = Array.from(focus.querySelectorAll('[data-testid="context-entity-row"]')).find(
          candidate =>
            candidate.getAttribute('data-runtime-id') === targetRuntimeId &&
            candidate.getAttribute('data-entity-label') === 'h2',
        ) as HTMLElement | undefined;
        if (!row) throw new Error(`REMOTE_RUNTIME_ENTITY_ROW_MISSING:${targetRuntimeId}:h2`);
        row.click();
      },
      { targetRuntimeId: h2Endpoint.runtimeId },
    );

    await page.waitForFunction(
      expectedWsUrl => localStorage.getItem('xln-runtime-adapter-ws') === expectedWsUrl,
      h2WsUrl,
      { timeout: 90_000 },
    );

    const managerState = await page.evaluate(expectedWsUrl => {
      const importsRaw = localStorage.getItem('xln-remote-runtime-imports') || '[]';
      const imports = JSON.parse(importsRaw) as Array<{
        label?: string;
        wsUrl?: string;
        access?: string;
        entityCount?: number;
      }>;
      return {
        activeWsUrl: localStorage.getItem('xln-runtime-adapter-ws'),
        imports,
        h2Import: imports.find(entry => entry.wsUrl === expectedWsUrl) || null,
        sessionRegistryPresent: Boolean(sessionStorage.getItem('xln-remote-runtime-imports')),
      };
    }, h2WsUrl);

    expect(managerState.activeWsUrl).toBe(h2WsUrl);
    expect(managerState.sessionRegistryPresent).toBe(false);
    expect(managerState.imports.length).toBeGreaterThanOrEqual(5);
    expect(managerState.imports.length).toBeLessThanOrEqual(100);
    expect(managerState.h2Import?.label).toBe('H2');
    expect(managerState.h2Import?.access).toBe('admin');
    expect(managerState.h2Import?.entityCount ?? 0).toBeGreaterThan(0);

    await page.waitForFunction(
      expectedRuntimeId => String((window as any).__xln?.view?.runtimeId || '') === expectedRuntimeId,
      h2Endpoint.runtimeId,
      { timeout: 90_000 },
    );
    await expect(page.getByTestId('entity-workspace')).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });
    await expect(page.locator('[data-testid="entity-lens-audit"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="entity-workspace-readonly"]')).toHaveCount(0);

    const adminProjectionProbe = await page.evaluate(async () => {
      const view = window as typeof window & {
        __xlnRuntimeAdapter?: RuntimeAdapterDebugSurface;
        __xlnRuntimeCommands?: {
          clear?: () => void;
          latest?: {
            status?: string;
            error?: string | null;
            inputSummary?: { entityInputs?: number; entityTxs?: number };
          } | null;
        };
      };
      const adapter = (view as any).__xln?.adapter;
      const submit = (view as any).__xln?.submit;
      if (!adapter) throw new Error('XLN_RUNTIME_ADAPTER_DEBUG_SURFACE_MISSING');
      (view as any).__xln?.commands?.clear?.();

      type ViewFrame = {
        activeEntity?: {
          core?: {
            entityId?: string;
            signerId?: string;
            profile?: { name?: string };
          };
          summary?: {
            entityId?: string;
          };
        } | null;
      };
      const beforeFrame = await adapter.query.viewFrame<ViewFrame>({
        accountsLimit: 1,
        booksLimit: 1,
      });
      const entityId = String(
        beforeFrame.activeEntity?.core?.entityId || beforeFrame.activeEntity?.summary?.entityId || '',
      ).toLowerCase();
      const signerId = String(beforeFrame.activeEntity?.core?.signerId || '').toLowerCase();
      const beforeName = String(beforeFrame.activeEntity?.core?.profile?.name || '');
      const beforeHead = await adapter.query.head<{ latestHeight?: number }>();

      const afterFrame = await adapter.query.viewFrame<ViewFrame>({
        entityId,
        accountsLimit: 1,
        booksLimit: 1,
      });
      const afterHead = await adapter.query.head<{ latestHeight?: number }>();
      const receipt = (view as any).__xln?.commands?.latest ?? null;

      return {
        authLevel: String(adapter.status().authLevel || ''),
        entityId,
        signerId,
        beforeName,
        afterName: String(afterFrame.activeEntity?.core?.profile?.name || ''),
        beforeHeight: Number(beforeHead.latestHeight || 0),
        afterHeight: Number(afterHead.latestHeight || 0),
        submitPresent: Boolean(submit),
        receiptStatus: String(receipt?.status || ''),
        receiptError: String(receipt?.error || ''),
        receiptEntityInputs: Number(receipt?.inputSummary?.entityInputs || 0),
        receiptEntityTxs: Number(receipt?.inputSummary?.entityTxs || 0),
      };
    });
    expect(adminProjectionProbe.authLevel).toBe('admin');
    expect(adminProjectionProbe.entityId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(adminProjectionProbe.signerId).toMatch(/^0x[0-9a-f]{40}$/);
    expect(adminProjectionProbe.submitPresent).toBe(false);
    expect(adminProjectionProbe.receiptStatus).toBe('');
    expect(adminProjectionProbe.receiptError).toBe('');
    expect(adminProjectionProbe.receiptEntityInputs).toBe(0);
    expect(adminProjectionProbe.receiptEntityTxs).toBe(0);
    expect(adminProjectionProbe.afterName).toBe(adminProjectionProbe.beforeName);
    expect(adminProjectionProbe.afterHeight).toBeGreaterThanOrEqual(adminProjectionProbe.beforeHeight);
  },
);

test(
  'pre-wallet live runtime selector connects suggested H1 runtime through the app UX',
  { tag: '@functional' },
  async ({ page }) => {
    test.setTimeout(480_000);
    const baseline = await ensureE2EBaseline(page, {
      requireHubMesh: true,
      requireMarketMaker: true,
      requireCustody: true,
      minHubCount: 3,
      timeoutMs: 300_000,
      allowAutoReset: false,
    });
    const h1Endpoint = await resolveHubRuntimeEndpoint(page, baseline, 'H1');

    await page.goto(`${APP_BASE_URL}/app`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: 'Testnet' }).click();
    await expect(page.getByTestId('live-runtime-section')).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });
    const select = page.getByTestId('live-runtime-select');
    await expect(select).toBeVisible({ timeout: 120_000 });
    await page.waitForFunction(
      expectedLabels => {
        const selectEl = document.querySelector('[data-testid="live-runtime-select"]') as HTMLSelectElement | null;
        const optionTexts = Array.from(selectEl?.options ?? []).map(option => option.textContent || '');
        return expectedLabels.every(label => optionTexts.some(text => new RegExp(`\\b${label}\\b`, 'i').test(text)));
      },
      ['H1', 'H2', 'H3', 'MM', 'Custody'],
      { timeout: 120_000 },
    );

    const liveRuntimeOptions = await page.evaluate(() =>
      Array.from(
        (document.querySelector('[data-testid="live-runtime-select"]') as HTMLSelectElement | null)?.options ?? [],
      ).map(option => ({ value: option.value, text: option.textContent?.replace(/\s+/g, ' ').trim() || '' })),
    );
    expect(liveRuntimeOptions.map(option => option.text).join(' | ')).toContain('H1');
    expect(liveRuntimeOptions.map(option => option.text).join(' | ')).toContain('H2');
    expect(liveRuntimeOptions.map(option => option.text).join(' | ')).toContain('H3');
    expect(liveRuntimeOptions.map(option => option.text).join(' | ')).toContain('MM');
    expect(liveRuntimeOptions.map(option => option.text).join(' | ')).toContain('Custody');
    const h1Option = liveRuntimeOptions.find(option => /\bH1\b/i.test(option.text));
    expect(h1Option?.value).toBe(h1Endpoint.wsUrl);

    await select.selectOption(h1Endpoint.wsUrl);
    await expect(page.getByTestId('live-runtime-connect')).toContainText(/Connect · admin/i);
    await page.getByTestId('live-runtime-connect').click();
    await page.waitForFunction(
      expectedRuntimeId => {
        const runtimeView = (window as typeof window & { __xln?: { view?: { runtimeId?: string; height?: number } } })
          .__xln?.view;
        return (
          String(runtimeView?.runtimeId || '').toLowerCase() === String(expectedRuntimeId).toLowerCase() &&
          Number(runtimeView?.height || 0) > 0
        );
      },
      h1Endpoint.runtimeId,
      { timeout: 120_000 },
    );

    await expect(page.getByTestId('context-current')).toContainText(/\bH1\b/, { timeout: REMOTE_E2E_WAIT_MS });
    await expect(page.getByTestId('entity-workspace')).toBeVisible({ timeout: REMOTE_E2E_WAIT_MS });
    const activeRemote = await page.evaluate(
      expectedWsUrl => ({
        activeWsUrl: localStorage.getItem('xln-runtime-adapter-ws'),
        activeMode: localStorage.getItem('xln-runtime-adapter-mode'),
        authLevel: String((window as any).__xln?.adapter?.status?.().authLevel || ''),
        importCount: JSON.parse(localStorage.getItem('xln-remote-runtime-imports') || '[]').length,
        url: window.location.href,
        expectedWsUrl,
      }),
      h1Endpoint.wsUrl,
    );
    expect(activeRemote.activeMode).toBe('remote');
    expect(activeRemote.authLevel).toBe('admin');
    expect(activeRemote.activeWsUrl).toBe(h1Endpoint.wsUrl);
    expect(activeRemote.importCount).toBeGreaterThanOrEqual(1);
    expect(activeRemote.url).toContain('/app');
    expect(activeRemote.url).not.toContain('/radapter/manage');
  },
);

test(
  'bulk remote runtime import link validates mesh, custody, and market maker runtimes in browser',
  { tag: '@functional' },
  async ({ browser }) => {
    test.setTimeout(480_000);
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    try {
      const baseline = await ensureE2EBaseline(page, {
        apiBaseUrl: API_BASE_URL,
        requireHubMesh: true,
        requireMarketMaker: true,
        requireCustody: true,
        minHubCount: 3,
        timeoutMs: 300_000,
        allowAutoReset: false,
      });
      expect(baseline.custody?.enabled, `custody must be enabled: ${JSON.stringify(baseline.custody ?? {})}`).toBe(
        true,
      );
      expect(baseline.custody?.ok, `custody must be ready: ${JSON.stringify(baseline.custody ?? {})}`).toBe(true);
      expectMarketMakerBooksHealthy(baseline);

      const importResponse = await page.request.get(`${API_BASE_URL}/api/runtime-import?access=admin`, {
        headers: { 'Cache-Control': 'no-store' },
        timeout: 10_000,
      });
      const importPayload = (await importResponse.json().catch(() => ({}))) as { importUrl?: string };
      expect(importResponse.ok(), `runtime import payload=${JSON.stringify(importPayload)}`).toBe(true);
      const importUrl = String(importPayload.importUrl || '');
      const parsedImportUrl = new URL(importUrl);
      expect(parsedImportUrl.pathname).toBe('/app');
      expect(parsedImportUrl.search).toBe('');
      expect(parsedImportUrl.hash).toContain('runtime-import-src=');
      expect(importUrl).toContain('/app#runtime-import-src=');
      expect(importUrl).not.toContain('/radapter/manage#runtime-import');
      expect(importUrl).not.toContain('?runtimeList=');
      expect(importUrl).not.toContain('&token=');
      expect(importUrl).not.toContain('xlnra1.');
      await page.goto(importUrl, { waitUntil: 'domcontentloaded' });
      await expect
        .poll(
          async () =>
            page.evaluate(storageKey => sessionStorage.getItem(storageKey), REMOTE_RUNTIME_IMPORT_RESULT_STORAGE_KEY),
          { timeout: 120_000 },
        )
        .not.toBeNull();
      const initialImportSummary = await page.evaluate(storageKey => {
        const raw = sessionStorage.getItem(storageKey);
        if (!raw) throw new Error('REMOTE_RUNTIME_IMPORT_SUMMARY_MISSING');
        return JSON.parse(raw) as RuntimeImportSummary;
      }, REMOTE_RUNTIME_IMPORT_RESULT_STORAGE_KEY);
      expect(
        initialImportSummary.ok,
        `remote runtime validation failed: ${JSON.stringify(initialImportSummary.failed ?? [])}`,
      ).toBe(true);
      expect(initialImportSummary.entries.length).toBeGreaterThanOrEqual(5);

      const importSummary = await readRuntimeImportSummary(page);
      await expect(page.getByTestId('remote-runtime-bulk-import-screen')).toHaveCount(0);
      await expect(page).toHaveURL(/\/app/);

      expect(importSummary.ok).toBe(true);
      expect(importSummary.entries.length).toBeGreaterThanOrEqual(5);
      expect(importSummary.failedCount ?? 0).toBe(0);
      expect(importSummary.failed ?? []).toEqual([]);
      expect(importSummary.checked?.length ?? 0).toBeGreaterThanOrEqual(importSummary.entries.length);
      expect((importSummary.checked ?? []).every(row => row.ok === true)).toBe(true);
      const labels = new Set(importSummary.entries.map(entry => entry.label.toLowerCase()));
      for (const label of ['h1', 'h2', 'h3', 'mm', 'custody']) {
        expect(Array.from(labels), `import summary labels=${Array.from(labels).join(',')}`).toContain(label);
      }
      for (const entry of importSummary.entries) {
        expect(entry.access, `${entry.label} imported access`).toBe('admin');
        expect(entry.runtimeId, `${entry.label} runtime id`).toMatch(/^[a-z0-9:_-]+$/);
        expect(entry.runtimeId, `${entry.label} runtime id`).not.toMatch(/^radapter:/);
        expect(entry.entityCount, `${entry.label} entity count`).toBeGreaterThan(0);
        expect(entry.wsUrl, `${entry.label} wsUrl`).toMatch(/^wss?:\/\/.+\/rpc$/);
      }

      const firstRuntimeId = importSummary.entries[0]!.runtimeId.toLowerCase();
      await page.waitForFunction(
        expectedRuntimeId => {
          const view = window as typeof window & {
            __xlnRuntimeView?: {
              runtimeId?: string;
              height?: number;
              entities?: unknown[];
              frame?: { entities?: unknown[] | null };
            };
          };
          const runtimeView = (view as any).__xln?.view;
          const entities = runtimeView?.entities ?? runtimeView?.frame?.entities ?? [];
          return (
            String(runtimeView?.runtimeId || '') === expectedRuntimeId &&
            Number(runtimeView?.height || 0) > 0 &&
            entities.length > 0
          );
        },
        firstRuntimeId,
        { timeout: REMOTE_E2E_WAIT_MS },
      );

      const browserHealth = (await page.evaluate(async () => {
        const response = await fetch('/api/health', { cache: 'no-store' });
        if (!response.ok) throw new Error(`HEALTH_FETCH_FAILED:${response.status}`);
        return await response.json();
      })) as Awaited<ReturnType<typeof ensureE2EBaseline>>;

      expectHubMeshHealthy(browserHealth);
      expect(browserHealth.custody?.ok, `custody health: ${JSON.stringify(browserHealth.custody ?? {})}`).toBe(true);
      expectMarketMakerBooksHealthy(browserHealth);

      const importedContextEntries = ['h1', 'h2', 'h3', 'mm', 'custody'].map(label => {
        const entry = importSummary.entries.find(candidate => candidate.label.toLowerCase() === label);
        if (!entry) throw new Error(`REMOTE_RUNTIME_IMPORT_ENTRY_MISSING:${label}`);
        return {
          label,
          runtimeId: entry.runtimeId.toLowerCase(),
        };
      });

      await page.getByTestId('context-current').click();
      for (const entry of importedContextEntries) {
        await page.evaluate(targetRuntimeId => {
          const runtime = document.querySelector(
            `[data-testid="context-runtime-group"][data-runtime-id="${targetRuntimeId}"]`,
          ) as HTMLElement | null;
          if (!runtime) throw new Error(`REMOTE_RUNTIME_GROUP_MISSING:${targetRuntimeId}`);
          runtime.click();
        }, entry.runtimeId);
        await page.waitForFunction(
          ({ targetRuntimeId, targetLabel }) =>
            Array.from(
              document.querySelectorAll('[data-testid="context-runtime-focus"] [data-testid="context-entity-row"]'),
            ).some(
              row =>
                row.getAttribute('data-runtime-id') === targetRuntimeId &&
                row.getAttribute('data-entity-label') === targetLabel,
            ),
          { targetRuntimeId: entry.runtimeId, targetLabel: entry.label },
          { timeout: REMOTE_E2E_WAIT_MS },
        );
        const row = await page.evaluate(
          ({ targetRuntimeId, targetLabel }) => {
            const group = document.querySelector(
              `[data-testid="context-runtime-group"][data-runtime-id="${targetRuntimeId}"]`,
            );
            const focus = document.querySelector('[data-testid="context-runtime-focus"]');
            const candidate = Array.from(focus?.querySelectorAll('[data-testid="context-entity-row"]') ?? []).find(
              element =>
                element.getAttribute('data-runtime-id') === targetRuntimeId &&
                element.getAttribute('data-entity-label') === targetLabel,
            ) as HTMLElement | undefined;
            if (!candidate) return null;
            return {
              groupText: group?.textContent?.replace(/\s+/g, ' ').trim().toLowerCase() || '',
              text: candidate.textContent?.replace(/\s+/g, ' ').trim().toLowerCase() || '',
              visible: candidate.getClientRects().length > 0,
            };
          },
          { targetRuntimeId: entry.runtimeId, targetLabel: entry.label },
        );
        expect(row, `context row for ${entry.label} runtime ${entry.runtimeId}`).not.toBeNull();
        expect(row!.visible, `context row visible for ${entry.label}`).toBe(true);
        expect(row!.text, `context row text for ${entry.label}`).toContain(entry.label);
        expect(row!.groupText, `context group source for ${entry.label}`).toContain('remote');
        if (entry.label === 'mm' || entry.label === 'custody') {
          expect(row!.text, `non-hub runtime ${entry.label} must not point at H3`).not.toContain('h3');
        }
      }
    } finally {
      await closeRuntimeContext(context);
    }
  },
);
