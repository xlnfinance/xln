import { expect, request, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import { requireAppBaseUrl, requireApiBaseUrl, requireResetBaseUrl } from './e2e-base-url';

export const APP_BASE_URL = requireAppBaseUrl();
export const API_BASE_URL = requireApiBaseUrl();
export const RESET_BASE_URL = process.env.E2E_RESET_BASE_URL ? requireResetBaseUrl() : '';

export type E2EResetHealth = {
  inProgress?: boolean;
  lastError?: string | null;
  startedAt?: number | null;
  completedAt?: number | null;
};

export type E2EHubMeshPairHealth = {
  left?: string;
  right?: string;
  ok?: boolean;
};

export type E2EHubMeshHealth = {
  ok?: boolean;
  hubIds?: string[];
  pairs?: E2EHubMeshPairHealth[];
};

export type E2EMarketMakerHubHealth = {
  hubEntityId: string;
  offers: number;
  ready: boolean;
  pairs?: Array<{
    pairId: string;
    offers: number;
    ready: boolean;
  }>;
};

export type E2EMarketMakerHealth = {
  enabled?: boolean;
  ok?: boolean;
  entityId?: string | null;
  expectedOffersPerHub?: number;
  expectedOffersPerPair?: number;
  hubs?: E2EMarketMakerHubHealth[];
};

export type E2EBootstrapReserveTokenHealth = {
  tokenId: number;
  symbol: string;
  decimals: number;
  current: string;
  expectedMin: string;
  ready: boolean;
};

export type E2EBootstrapReserveEntityHealth = {
  entityId: string;
  role: 'hub' | 'market-maker';
  ready: boolean;
  tokens: E2EBootstrapReserveTokenHealth[];
};

export type E2EBootstrapReserveHealth = {
  ok: boolean;
  requiredTokenCount: number;
  entityCount: number;
  entities: E2EBootstrapReserveEntityHealth[];
};

export type E2EHubHealth = {
  entityId: string;
  name?: string;
  online?: boolean;
  runtimeId?: string;
  activeClients?: string[];
};

export type E2EHealthResponse = {
  timestamp?: number;
  reset?: E2EResetHealth;
  hubMesh?: E2EHubMeshHealth;
  marketMaker?: E2EMarketMakerHealth;
  bootstrapReserves?: E2EBootstrapReserveHealth;
  hubs?: E2EHubHealth[];
};

export type E2EBaselineOptions = {
  apiBaseUrl?: string;
  timeoutMs?: number;
  pollMs?: number;
  requireHubMesh?: boolean;
  requireMarketMaker?: boolean;
  minHubCount?: number;
  autoResetGraceMs?: number;
};

export type E2EResetOptions = E2EBaselineOptions & {
  resetBaseUrl?: string;
  retries?: number;
};

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_POLL_MS = 500;
const DEFAULT_AUTO_RESET_GRACE_MS = 5_000;
const DEFAULT_ISOLATED_READY_TIMEOUT_MS = 15_000;
const ISOLATED_STACK = process.env.E2E_ISOLATED_STACK === '1' || process.env.E2E_ISOLATED_BASELINE_READY === '1';

const parsePositiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value || '');
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const ISOLATED_READY_TIMEOUT_MS = parsePositiveInteger(
  process.env.E2E_ISOLATED_READY_TIMEOUT_MS,
  DEFAULT_ISOLATED_READY_TIMEOUT_MS,
);

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const readIsolatedBaselineHealthSnapshot = (): E2EHealthResponse | null => {
  const raw = String(process.env.E2E_BASELINE_HEALTH_JSON || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as E2EHealthResponse;
  } catch {
    return null;
  }
};

const withApiContext = async <T>(run: (api: APIRequestContext) => Promise<T>): Promise<T> => {
  const api = await request.newContext({ ignoreHTTPSErrors: true });
  try {
    return await run(api);
  } finally {
    await api.dispose();
  }
};

const readJson = async <T>(response: APIResponse): Promise<T | null> => {
  try {
    return await response.json() as T;
  } catch {
    return null;
  }
};

const readText = async (response: APIResponse): Promise<string> => {
  try {
    return await response.text();
  } catch {
    return '';
  }
};

const getHealthWithApi = async (
  _api: APIRequestContext,
  apiBaseUrl = API_BASE_URL,
  requestTimeoutMs = 5_000,
): Promise<E2EHealthResponse | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(`${apiBaseUrl}/api/health`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json() as E2EHealthResponse;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

const summarizeHealth = (health: E2EHealthResponse | null): string => {
  if (!health) return 'no-health-payload';
  return JSON.stringify(
    {
      timestamp: health.timestamp ?? null,
      reset: health.reset ?? null,
      hubMesh: {
        ok: health.hubMesh?.ok ?? false,
        hubIds: health.hubMesh?.hubIds ?? [],
        pairs: (health.hubMesh?.pairs ?? []).map((pair) => ({
          left: pair.left ?? null,
          right: pair.right ?? null,
          ok: pair.ok ?? false,
        })),
      },
      marketMaker: {
        enabled: health.marketMaker?.enabled ?? false,
        ok: health.marketMaker?.ok ?? false,
        entityId: health.marketMaker?.entityId ?? null,
        expectedOffersPerHub: health.marketMaker?.expectedOffersPerHub ?? 0,
        expectedOffersPerPair: health.marketMaker?.expectedOffersPerPair ?? 0,
        hubs: (health.marketMaker?.hubs ?? []).map((hub) => ({
          hubEntityId: hub.hubEntityId,
          offers: hub.offers,
          ready: hub.ready,
          pairs: (hub.pairs ?? []).map((pair) => ({
            pairId: pair.pairId,
            offers: pair.offers,
            ready: pair.ready,
          })),
        })),
      },
      bootstrapReserves: {
        ok: health.bootstrapReserves?.ok ?? false,
        requiredTokenCount: health.bootstrapReserves?.requiredTokenCount ?? 0,
        entityCount: health.bootstrapReserves?.entityCount ?? 0,
        entities: (health.bootstrapReserves?.entities ?? []).map((entity) => ({
          entityId: entity.entityId,
          role: entity.role,
          ready: entity.ready,
          tokens: entity.tokens.map((token) => ({
            tokenId: token.tokenId,
            symbol: token.symbol,
            current: token.current,
            expectedMin: token.expectedMin,
            ready: token.ready,
          })),
        })),
      },
      hubs: (health.hubs ?? []).map((hub) => ({
        entityId: hub.entityId,
        name: hub.name ?? null,
        online: hub.online ?? false,
      })),
    },
    null,
    2,
  );
};

const isBaselineReady = (health: E2EHealthResponse | null, options: Required<E2EBaselineOptions>): boolean => {
  if (!health) return false;
  if (typeof health.timestamp !== 'number') return false;
  if (health.reset?.inProgress === true) return false;
  if (options.requireHubMesh) {
    if (health.hubMesh?.ok !== true) return false;
    const hubIds = health.hubMesh?.hubIds ?? [];
    if (hubIds.length < options.minHubCount) return false;
  }
  if (options.requireMarketMaker && health.marketMaker?.ok !== true) return false;
  if (!health.bootstrapReserves?.ok) return false;
  return true;
};

const namedHubsFromHealth = (health: E2EHealthResponse | null): Map<string, string> => {
  const hubs = Array.isArray(health?.hubs) ? health.hubs : [];
  const byName = new Map<string, string>();
  for (const hub of hubs) {
    const name = String(hub.name ?? '').trim().toLowerCase();
    const entityId = String(hub.entityId ?? '').trim().toLowerCase();
    if (!name || !entityId) continue;
    byName.set(name, entityId);
  }
  return byName;
};

const waitForBaselineReadyWithApi = async (
  page: Page,
  api: APIRequestContext,
  options: Required<E2EBaselineOptions>,
  timeoutMs: number,
): Promise<E2EHealthResponse> => {
  const startedAt = Date.now();
  let lastHealth: E2EHealthResponse | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastHealth = await getHealthWithApi(api, options.apiBaseUrl);
    if (lastHealth && isBaselineReady(lastHealth, options)) return lastHealth;
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) break;
    await page.waitForTimeout(Math.min(options.pollMs, remainingMs));
  }

  throw new Error(
    `E2E baseline not ready within ${timeoutMs}ms\n${summarizeHealth(lastHealth)}`,
  );
};

const assertIsolatedBaselineReadyWithApi = async (
  api: APIRequestContext,
  options: Required<E2EBaselineOptions>,
): Promise<E2EHealthResponse> => {
  if (process.env.E2E_ISOLATED_BASELINE_READY === '1') {
    const snapshot = readIsolatedBaselineHealthSnapshot();
    if (snapshot && isBaselineReady(snapshot, options)) return snapshot;
    throw new Error(`E2E isolated baseline snapshot was missing or not ready\n${summarizeHealth(snapshot)}`);
  }

  const timeoutMs = Math.min(options.timeoutMs, ISOLATED_READY_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  let lastHealth: E2EHealthResponse | null = null;

  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    lastHealth = await getHealthWithApi(api, options.apiBaseUrl, Math.min(2_000, remainingMs));
    if (lastHealth && isBaselineReady(lastHealth, options)) return lastHealth;

    const nextDelayMs = Math.min(options.pollMs, Math.max(0, deadline - Date.now()));
    if (nextDelayMs <= 0) break;
    await delay(nextDelayMs);
  }

  throw new Error(`E2E isolated baseline was not live-ready within ${timeoutMs}ms\n${summarizeHealth(lastHealth)}`);
};

export const getHealth = async (
  page: Page,
  apiBaseUrl = API_BASE_URL,
): Promise<E2EHealthResponse | null> => {
  return await withApiContext((api) => getHealthWithApi(api, apiBaseUrl));
};

export const waitForNamedHubs = async (
  page: Page,
  requiredNames: string[],
  options: {
    apiBaseUrl?: string;
    timeoutMs?: number;
    pollMs?: number;
  } = {},
): Promise<Record<string, string>> => {
  const apiBaseUrl = options.apiBaseUrl ?? API_BASE_URL;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const startedAt = Date.now();
  let lastHealth: E2EHealthResponse | null = null;
  const wanted = requiredNames.map((name) => name.trim().toLowerCase()).filter(Boolean);

  if (process.env.E2E_ISOLATED_BASELINE_READY === '1') {
    lastHealth = readIsolatedBaselineHealthSnapshot();
    const byName = namedHubsFromHealth(lastHealth);
    const missing = wanted.filter(name => !byName.has(name));
    if (missing.length === 0) return Object.fromEntries(wanted.map(name => [name, byName.get(name)!]));
    throw new Error(
      `Named hubs missing from isolated baseline snapshot: ${missing.join(', ')}\n${summarizeHealth(lastHealth)}`,
    );
  }

  while (Date.now() - startedAt < timeoutMs) {
    lastHealth = await getHealth(page, apiBaseUrl);
    const byName = namedHubsFromHealth(lastHealth);

    const resolved: Record<string, string> = {};
    let ready = true;
    for (const name of wanted) {
      const entityId = byName.get(name);
      if (!entityId) {
        ready = false;
        break;
      }
      resolved[name] = entityId;
    }
    if (ready) return resolved;
    await page.waitForTimeout(pollMs);
  }

  throw new Error(
    `Named hubs not ready within ${timeoutMs}ms: ${requiredNames.join(', ')}\n${summarizeHealth(lastHealth)}`,
  );
};

export const waitForApiReachable = async (
  page: Page,
  timeoutMs = 120_000,
  apiBaseUrl = API_BASE_URL,
): Promise<void> => {
  await withApiContext(async (api) => {
    const startedAt = Date.now();
    let lastError = '';
    while (Date.now() - startedAt < timeoutMs) {
      try {
        const response = await api.get(`${apiBaseUrl}/api/health`);
        if (response.ok()) return;
        const body = await readText(response);
        lastError = `status=${response.status()} body=${body.slice(0, 240)}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await page.waitForTimeout(DEFAULT_POLL_MS);
    }
    throw new Error(`API did not become reachable in time: ${lastError}`);
  });
};

export const ensureE2EBaseline = async (
  page: Page,
  options: E2EBaselineOptions = {},
): Promise<E2EHealthResponse> => {
  const resolved: Required<E2EBaselineOptions> = {
    apiBaseUrl: options.apiBaseUrl ?? API_BASE_URL,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    pollMs: options.pollMs ?? DEFAULT_POLL_MS,
    requireHubMesh: options.requireHubMesh ?? true,
    requireMarketMaker: options.requireMarketMaker ?? false,
    minHubCount: options.minHubCount ?? 3,
    autoResetGraceMs: options.autoResetGraceMs ?? DEFAULT_AUTO_RESET_GRACE_MS,
  };

  // The isolated runner owns reset/readiness. Tests must not hide readiness
  // problems behind another long wait once Playwright has started.
  if (ISOLATED_STACK) {
    return await withApiContext((api) => assertIsolatedBaselineReadyWithApi(api, resolved));
  }

  const initialWaitMs = Math.min(resolved.timeoutMs, resolved.autoResetGraceMs);
  try {
    return await withApiContext((api) => waitForBaselineReadyWithApi(page, api, resolved, initialWaitMs));
  } catch (initialError) {
    const remainingTimeoutMs = resolved.timeoutMs - initialWaitMs;
    if (remainingTimeoutMs <= 0) throw initialError;

    return await resetProdServer(page, {
      apiBaseUrl: resolved.apiBaseUrl,
      resetBaseUrl: RESET_BASE_URL || requireResetBaseUrl(),
      timeoutMs: remainingTimeoutMs,
      pollMs: resolved.pollMs,
      requireHubMesh: resolved.requireHubMesh,
      requireMarketMaker: resolved.requireMarketMaker,
      minHubCount: resolved.minHubCount,
      autoResetGraceMs: remainingTimeoutMs,
    });
  }
};

export const resetProdServer = async (
  page: Page,
  options: E2EResetOptions = {},
): Promise<E2EHealthResponse> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const apiBaseUrl = options.apiBaseUrl ?? API_BASE_URL;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  const resolved: Required<E2EBaselineOptions> = {
    apiBaseUrl: options.apiBaseUrl ?? API_BASE_URL,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    pollMs: options.pollMs ?? DEFAULT_POLL_MS,
    requireHubMesh: options.requireHubMesh ?? true,
    requireMarketMaker: options.requireMarketMaker ?? false,
    minHubCount: options.minHubCount ?? 3,
    autoResetGraceMs: options.autoResetGraceMs ?? DEFAULT_AUTO_RESET_GRACE_MS,
  };

  if (ISOLATED_STACK) {
    return await withApiContext((api) => assertIsolatedBaselineReadyWithApi(api, resolved));
  }

  const resetBaseUrl = options.resetBaseUrl ?? (RESET_BASE_URL || requireResetBaseUrl());
  const retries = options.retries ?? Math.max(30, Math.ceil(timeoutMs / Math.max(250, pollMs)));
  const deadline = Date.now() + timeoutMs;

  return await withApiContext(async (api) => {
    const startedAt = Date.now();
    let lastError = '';
    while (Date.now() - startedAt < timeoutMs) {
      try {
        const response = await api.get(`${apiBaseUrl}/api/health`);
        if (response.ok()) {
          lastError = '';
          break;
        }
        const body = await readText(response);
        lastError = `status=${response.status()} body=${body.slice(0, 240)}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await page.waitForTimeout(DEFAULT_POLL_MS);
    }
    if (lastError) {
      throw new Error(`API did not become reachable in time: ${lastError}`);
    }

    let resetDone = false;
    let lastResetError = '';

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const resetBody = {
          requireMarketMaker: options.requireMarketMaker ?? false,
        };
        const coldResponse = await api.post(`${resetBaseUrl}/api/reset`, {
          data: resetBody,
          headers: { 'Content-Type': 'application/json' },
        });
        if (coldResponse.ok()) {
          resetDone = true;
          break;
        }

        const coldBody = await readText(coldResponse);
        lastResetError = `reset(status=${coldResponse.status()} body=${coldBody.slice(0, 180)})`;
      } catch (error) {
        lastResetError = error instanceof Error ? error.message : String(error);
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await page.waitForTimeout(Math.min(500, remainingMs));
      try {
        const response = await api.get(`${apiBaseUrl}/api/health`);
        if (!response.ok()) {
          const body = await readText(response);
          lastResetError = `status=${response.status()} body=${body.slice(0, 240)}`;
        }
      } catch (error) {
        lastResetError = error instanceof Error ? error.message : String(error);
      }
    }

    expect(resetDone, `reset failed after retries: ${lastResetError}`).toBe(true);

    return await waitForBaselineReadyWithApi(page, api, resolved, resolved.timeoutMs);
  });
};
