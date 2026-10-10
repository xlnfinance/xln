import { safeStringify } from '../../../protocol/serialization';
import {
  normalizeTowerBaseUrl,
  type RecoveryTowerConfig,
  type TowerDiscoverPayload,
  type TowerRestorePayload,
  type TowerServerInfo,
} from './types';

/**
 * The HTTP half of tower discovery.
 *
 * `pageUrl` is the browsing context that is asking. A page served over TLS
 * cannot call a plain-http local tower directly, so the request is routed
 * through the stack's own fixed-path proxy; every other caller (server, tests,
 * a native shell) passes no page and gets the direct URL.
 */

const RECOVERY_TOWER_INFO_TTL_MS = 60_000;

const recoveryTowerInfoCache = new Map<string, { fetchedAt: number; info: TowerServerInfo }>();

export const buildTowerRequestUrl = (towerUrl: string, towerPath: string, pageUrl?: string): string => {
  const normalizedBaseUrl = normalizeTowerBaseUrl(towerUrl);
  const normalizedPath = towerPath.startsWith('/') ? towerPath : `/${towerPath}`;
  if (pageUrl) {
    const page = new URL(pageUrl);
    const target = new URL(`${normalizedBaseUrl}/`);
    const needsLocalProxy = page.protocol === 'https:' || page.protocol === 'xln:';
    const isLocalInsecureTower =
      target.protocol === 'http:' && (target.hostname === '127.0.0.1' || target.hostname === 'localhost');
    if (needsLocalProxy && isLocalInsecureTower) {
      const proxyUrl = new URL('/api/watchtower-proxy', page.href);
      proxyUrl.searchParams.set('target', normalizedBaseUrl);
      proxyUrl.searchParams.set('path', normalizedPath);
      return proxyUrl.toString();
    }
  }
  return new URL(normalizedPath, `${normalizedBaseUrl}/`).toString();
};

export async function fetchTowerServerInfo(towerUrl: string, pageUrl?: string): Promise<TowerServerInfo> {
  const normalizedUrl = normalizeTowerBaseUrl(towerUrl);
  const cached = recoveryTowerInfoCache.get(normalizedUrl);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < RECOVERY_TOWER_INFO_TTL_MS) {
    return cached.info;
  }
  const response = await fetch(buildTowerRequestUrl(normalizedUrl, '/api/tower/healthz', pageUrl), {
    method: 'GET',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`TOWER_INFO_HTTP_${response.status}`);
  }
  const payload = (await response.json()) as TowerServerInfo;
  if (!payload.ok) {
    throw new Error(`TOWER_INFO_INVALID:${normalizedUrl}`);
  }
  recoveryTowerInfoCache.set(normalizedUrl, { fetchedAt: now, info: payload });
  return payload;
}

// A rejected fetch (offline, DNS, refused, TLS, CORS) is transport failure,
// never evidence about a backup. Code it here, where it is known, so the
// classifier never reads browser- or source-supplied text. Cancellation keeps
// its own reason.
const fetchTower = async (url: string, init: RequestInit): Promise<Response> => {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new Error(`RECOVERY_TOWER_UNREACHABLE: ${error instanceof Error ? error.message : String(error)}`);
  }
};

/**
 * Ask before restoring. A tower that holds nothing answers this cheaply, so a
 * device with no backup never produces an expected-404 restore error.
 */
export async function towerHasRecoveryBundle(
  tower: RecoveryTowerConfig,
  lookupKey: string,
  pageUrl?: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const response = await fetchTower(buildTowerRequestUrl(tower.url, '/api/recovery/discover', pageUrl), {
    signal: signal ?? null,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: safeStringify({ lookupKey }),
  });
  if (!response.ok) {
    throw new Error(`HTTP_${response.status}`);
  }
  const payload = (await response.json()) as TowerDiscoverPayload;
  if (!payload.ok) {
    if (payload.error === 'TOWER_BUNDLE_NOT_FOUND') return false;
    throw new Error(String(payload.error || 'unknown'));
  }
  return payload.available === true;
}

type TowerRestoreOutcome =
  | { ok: true; payload: TowerRestorePayload }
  | { ok: false; message: string };

export async function fetchTowerRecoveryBundles(
  tower: RecoveryTowerConfig,
  lookupKey: string,
  pageUrl?: string,
  signal?: AbortSignal,
): Promise<TowerRestoreOutcome> {
  const response = await fetchTower(buildTowerRequestUrl(tower.url, '/api/tower/restore', pageUrl), {
    signal: signal ?? null,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: safeStringify({ lookupKey }),
  });
  if (response.status === 404) return { ok: false, message: 'HTTP_404' };
  if (!response.ok) return { ok: false, message: `HTTP_${response.status}` };
  return { ok: true, payload: (await response.json()) as TowerRestorePayload };
}
