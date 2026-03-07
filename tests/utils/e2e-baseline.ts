import { expect, type APIResponse, type Page } from '@playwright/test';

export const APP_BASE_URL = process.env.E2E_BASE_URL ?? process.env.PW_BASE_URL ?? 'https://localhost:8080';
export const API_BASE_URL = process.env.E2E_API_BASE_URL ?? APP_BASE_URL;
export const RESET_BASE_URL = process.env.E2E_RESET_BASE_URL ?? API_BASE_URL;

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
};

export type E2EMarketMakerHealth = {
  enabled?: boolean;
  ok?: boolean;
  entityId?: string | null;
  expectedOffersPerHub?: number;
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
  softPreserveHubs?: boolean;
};

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_POLL_MS = 500;
const DEFAULT_AUTO_RESET_GRACE_MS = 5_000;

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
        hubs: (health.marketMaker?.hubs ?? []).map((hub) => ({
          hubEntityId: hub.hubEntityId,
          offers: hub.offers,
          ready: hub.ready,
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

const waitForBaselineReady = async (
  page: Page,
  options: Required<E2EBaselineOptions>,
  timeoutMs: number,
): Promise<E2EHealthResponse> => {
  const startedAt = Date.now();
  let lastHealth: E2EHealthResponse | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastHealth = await getHealth(page, options.apiBaseUrl);
    if (isBaselineReady(lastHealth, options)) return lastHealth;
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) break;
    await page.waitForTimeout(Math.min(options.pollMs, remainingMs));
  }

  throw new Error(
    `E2E baseline not ready within ${timeoutMs}ms\n${summarizeHealth(lastHealth)}`,
  );
};

export const getHealth = async (
  page: Page,
  apiBaseUrl = API_BASE_URL,
): Promise<E2EHealthResponse | null> => {
  try {
    const response = await page.request.get(`${apiBaseUrl}/api/health`);
    if (!response.ok()) return null;
    return await readJson<E2EHealthResponse>(response);
  } catch {
    return null;
  }
};

export const waitForApiReachable = async (
  page: Page,
  timeoutMs = 120_000,
  apiBaseUrl = API_BASE_URL,
): Promise<void> => {
  const startedAt = Date.now();
  let lastError = '';
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await page.request.get(`${apiBaseUrl}/api/health`);
      if (response.ok()) return;
      const body = await readText(response);
      lastError = `status=${response.status()} body=${body.slice(0, 240)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await page.waitForTimeout(DEFAULT_POLL_MS);
  }
  throw new Error(`API did not become reachable in time: ${lastError}`);
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

  const initialWaitMs = Math.min(resolved.timeoutMs, resolved.autoResetGraceMs);
  try {
    return await waitForBaselineReady(page, resolved, initialWaitMs);
  } catch (initialError) {
    const remainingTimeoutMs = resolved.timeoutMs - initialWaitMs;
    if (remainingTimeoutMs <= 0) throw initialError;

    return await resetProdServer(page, {
      apiBaseUrl: resolved.apiBaseUrl,
      resetBaseUrl: RESET_BASE_URL,
      timeoutMs: remainingTimeoutMs,
      pollMs: resolved.pollMs,
      requireHubMesh: resolved.requireHubMesh,
      requireMarketMaker: resolved.requireMarketMaker,
      minHubCount: resolved.minHubCount,
      autoResetGraceMs: remainingTimeoutMs,
      softPreserveHubs: false,
    });
  }
};

export const resetProdServer = async (
  page: Page,
  options: E2EResetOptions = {},
): Promise<E2EHealthResponse> => {
  const resetBaseUrl = options.resetBaseUrl ?? RESET_BASE_URL;
  const retries = options.retries ?? 30;
  const softPreserveHubs = options.softPreserveHubs ?? false;

  await waitForApiReachable(page, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.apiBaseUrl ?? API_BASE_URL);

  let resetDone = false;
  let lastError = '';

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const resetBody = {
        requireMarketMaker: options.requireMarketMaker ?? false,
      };
      const coldResponse = await page.request.post(`${resetBaseUrl}/api/reset?rpc=1&db=1&sync=1`, {
        data: resetBody,
        headers: { 'Content-Type': 'application/json' },
      });
      if (coldResponse.ok()) {
        resetDone = true;
        break;
      }

      const coldBody = await readText(coldResponse);
      const softResponse = await page.request.post(`${resetBaseUrl}/api/debug/reset`, {
        data: {
          preserveHubs: softPreserveHubs,
          requireMarketMaker: options.requireMarketMaker ?? false,
        },
        headers: { 'Content-Type': 'application/json' },
      });
      if (softResponse.ok()) {
        resetDone = true;
        break;
      }

      const softBody = await readText(softResponse);
      lastError =
        `cold(status=${coldResponse.status()} body=${coldBody.slice(0, 180)}) ` +
        `soft(status=${softResponse.status()} body=${softBody.slice(0, 180)})`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await page.waitForTimeout(500);
  }

  expect(resetDone, `reset failed after retries: ${lastError}`).toBe(true);

  const resolved: Required<E2EBaselineOptions> = {
    apiBaseUrl: options.apiBaseUrl ?? API_BASE_URL,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    pollMs: options.pollMs ?? DEFAULT_POLL_MS,
    requireHubMesh: options.requireHubMesh ?? true,
    requireMarketMaker: options.requireMarketMaker ?? false,
    minHubCount: options.minHubCount ?? 3,
    autoResetGraceMs: options.autoResetGraceMs ?? DEFAULT_AUTO_RESET_GRACE_MS,
  };

  return await waitForBaselineReady(page, resolved, resolved.timeoutMs);
};
