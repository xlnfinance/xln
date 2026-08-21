import { compareStableText, safeStringify } from '../protocol/serialization';
import { requireBoundaryRecord } from '../protocol/boundary-validation';
import { maybeHandleRelayDebugRequest } from '../network/relay/debug-http';
import type { RelayStore } from '../network/relay/store';
import { handleKnownProfileRequest } from '../api/server/network/gossip-profiles';
import { getDebugEntityEntries } from './hub/public-discovery';
import type { HubChild, MarketMakerChild } from './orchestrator-types';

type OrchestratorDebugApiDeps = {
  request: Request;
  pathname: string;
  url: URL;
  headers: HeadersInit;
  hubApiHost: string;
  relayStore: RelayStore;
  hubChildren: HubChild[];
  marketMakerChild: MarketMakerChild;
  operatorAuthorized: boolean;
  pollAllHubHealth: () => Promise<void>;
  pollMarketMakerHealth: () => Promise<void>;
  proxyAnyHubGet: (request: Request, path: string) => Promise<Response>;
};

const handleDebugEntities = async (deps: OrchestratorDebugApiDeps): Promise<Response> => {
  await deps.pollAllHubHealth();
  await deps.pollMarketMakerHealth();
  const entities = getDebugEntityEntries({
    requestUrl: deps.url,
    relayStore: deps.relayStore,
    hubChildren: deps.hubChildren,
  }).map((entity) => {
    const hubChild = deps.hubChildren.find((child) => {
      const childEntityId = String(child.lastInfo?.entityId || child.lastHealth?.entityId || '').toLowerCase();
      return childEntityId === entity.entityId.toLowerCase();
    });
    return {
      ...entity,
      apiPort: hubChild?.apiPort ?? null,
      exitCode: hubChild?.exitCode ?? null,
      dbPath: hubChild?.dbPath ?? null,
    };
  });

  if (deps.marketMakerChild.lastInfo?.entityId || deps.marketMakerChild.lastHealth?.entityId) {
    const entityId = String(deps.marketMakerChild.lastInfo?.entityId || deps.marketMakerChild.lastHealth?.entityId || '').toLowerCase();
    const existing = entities.find(entry => String(entry.entityId || '').toLowerCase() === entityId);
    if (!existing) {
      entities.unshift({
        entityId,
        runtimeId: String(deps.marketMakerChild.lastInfo?.runtimeId || deps.marketMakerChild.lastHealth?.runtimeId || ''),
        name: deps.marketMakerChild.name,
        isHub: false,
        online: deps.marketMakerChild.proc?.exitCode === null && Boolean(deps.marketMakerChild.lastHealth),
        lastUpdated: Date.now(),
        accounts: [],
        publicAccounts: [],
        metadata: { isMarketMaker: true },
        apiPort: deps.marketMakerChild.apiPort,
        exitCode: deps.marketMakerChild.exitCode,
        dbPath: deps.marketMakerChild.dbPath,
      });
    }
  }

  return new Response(safeStringify({ entities }), { headers: deps.headers });
};

const handleGossipProfile = (deps: OrchestratorDebugApiDeps): Response => {
  return handleKnownProfileRequest({
    request: deps.request,
    env: null,
    relayStore: deps.relayStore,
    headers: deps.headers,
  });
};

const handleDebugRelay = (deps: OrchestratorDebugApiDeps): Response =>
  new Response(safeStringify({
    clients: Array.from(deps.relayStore.clients.keys()),
    profiles: Array.from(deps.relayStore.gossipProfiles.values()).map(entry => ({
      entityId: entry.profile.entityId,
      runtimeId: entry.profile.runtimeId,
      name: entry.profile.name ?? null,
      isHub: entry.profile.metadata?.isHub === true,
      lastUpdated: entry.profile.lastUpdated ?? 0,
    })),
    activeHubEntityIds: deps.relayStore.activeHubEntityIds,
    debugEvents: deps.relayStore.debugEvents.slice(-200),
  }), { headers: deps.headers });

type ActivityPageLike = {
  ok?: boolean;
  runtimeId?: string;
  latestHeight?: number;
  scannedFrames?: number;
  returned?: number;
  nextBeforeHeight?: number | null;
  events?: Array<Record<string, unknown>>;
};

const decodeActivityPage = (value: unknown): ActivityPageLike => {
  const page = requireBoundaryRecord(value, 'DEBUG_ACTIVITY_RESPONSE_INVALID');
  const events = page['events'];
  if (events !== undefined && (!Array.isArray(events) || events.some(event => {
    try {
      requireBoundaryRecord(event, 'DEBUG_ACTIVITY_EVENT_INVALID');
      return false;
    } catch {
      return true;
    }
  }))) {
    throw new Error('DEBUG_ACTIVITY_EVENTS_INVALID');
  }
  const integer = (key: 'latestHeight' | 'scannedFrames' | 'returned'): number | undefined => {
    const raw = page[key];
    if (raw === undefined) return undefined;
    if (!Number.isSafeInteger(raw) || Number(raw) < 0) throw new Error(`DEBUG_ACTIVITY_${key.toUpperCase()}_INVALID`);
    return Number(raw);
  };
  const nextBeforeHeight = page['nextBeforeHeight'];
  if (nextBeforeHeight !== undefined && nextBeforeHeight !== null &&
      (!Number.isSafeInteger(nextBeforeHeight) || Number(nextBeforeHeight) < 0)) {
    throw new Error('DEBUG_ACTIVITY_NEXT_BEFORE_HEIGHT_INVALID');
  }
  if (page['ok'] !== undefined && typeof page['ok'] !== 'boolean') throw new Error('DEBUG_ACTIVITY_OK_INVALID');
  if (page['runtimeId'] !== undefined && typeof page['runtimeId'] !== 'string') throw new Error('DEBUG_ACTIVITY_RUNTIME_ID_INVALID');
  const latestHeight = integer('latestHeight');
  const scannedFrames = integer('scannedFrames');
  const returned = integer('returned');
  const decodedNextBeforeHeight: number | null | undefined = nextBeforeHeight === undefined || nextBeforeHeight === null
    ? nextBeforeHeight
    : Number(nextBeforeHeight);
  return {
    ...(page['ok'] === undefined ? {} : { ok: page['ok'] }),
    ...(page['runtimeId'] === undefined ? {} : { runtimeId: page['runtimeId'] }),
    ...(latestHeight === undefined ? {} : { latestHeight }),
    ...(scannedFrames === undefined ? {} : { scannedFrames }),
    ...(returned === undefined ? {} : { returned }),
    ...(decodedNextBeforeHeight === undefined ? {} : { nextBeforeHeight: decodedNextBeforeHeight }),
    ...(events === undefined ? {} : { events: events.map(event => requireBoundaryRecord(event, 'DEBUG_ACTIVITY_EVENT_INVALID')) }),
  };
};

const handleDebugActivity = async (deps: OrchestratorDebugApiDeps): Promise<Response> => {
  await deps.pollAllHubHealth();
  const limit = Math.max(1, Math.min(500, Number(deps.url.searchParams.get('limit') || '100')));
  const hubPages: ActivityPageLike[] = [];
  const failures: Array<{ hub: string; apiPort: number; error: string }> = [];

  const liveChildren = deps.hubChildren.filter((child) => child.proc?.exitCode === null && child.lastHealth);
  await Promise.all(liveChildren.map(async (child) => {
    const upstreamUrl = `http://${deps.hubApiHost}:${child.apiPort}${deps.pathname}${deps.url.search}`;
    try {
      const response = await fetch(upstreamUrl, { method: 'GET' });
      const text = await response.text();
      if (!response.ok) {
        failures.push({ hub: child.name, apiPort: child.apiPort, error: `HTTP ${response.status}: ${text.slice(0, 240)}` });
        return;
      }
      const parsed = decodeActivityPage(JSON.parse(text));
      hubPages.push(parsed);
    } catch (error) {
      failures.push({
        hub: child.name,
        apiPort: child.apiPort,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }));

  const events = hubPages
    .flatMap((page) => Array.isArray(page.events) ? page.events : [])
    .sort((left, right) => {
      const byTime = Number(right['timestamp'] || 0) - Number(left['timestamp'] || 0);
      if (byTime !== 0) return byTime;
      const byHeight = Number(right['height'] || 0) - Number(left['height'] || 0);
      if (byHeight !== 0) return byHeight;
      return compareStableText(String(right['id'] || ''), String(left['id'] || ''));
    })
    .slice(0, limit);
  const nextBeforeHeights = hubPages
    .map((page) => Number(page.nextBeforeHeight))
    .filter((height) => Number.isFinite(height) && height > 0);

  return new Response(safeStringify({
    ok: failures.length === 0,
    partial: failures.length > 0,
    latestHeight: Math.max(0, ...hubPages.map((page) => Number(page.latestHeight || 0))),
    scannedFrames: hubPages.reduce((sum, page) => sum + Math.max(0, Number(page.scannedFrames || 0)), 0),
    returned: events.length,
    limit,
    nextBeforeHeight: nextBeforeHeights.length > 0 ? Math.max(...nextBeforeHeights) : null,
    hubs: hubPages.length,
    failures,
    events,
  }), { headers: deps.headers });
};

export const maybeHandleOrchestratorDebugApi = async (
  deps: OrchestratorDebugApiDeps,
): Promise<Response | null> => {
  const relayDebugResponse = await maybeHandleRelayDebugRequest({
    request: deps.request,
    pathname: deps.pathname,
    url: deps.url,
    headers: deps.headers,
    store: deps.relayStore,
    operatorAuthorized: deps.operatorAuthorized,
  });
  if (relayDebugResponse) return relayDebugResponse;
  if (deps.pathname === '/api/debug/entities') {
    return await handleDebugEntities(deps);
  }
  if (deps.pathname === '/api/gossip/profile') {
    return handleGossipProfile(deps);
  }
  if (deps.pathname === '/api/debug/reserve' && deps.request.method === 'GET') {
    return await deps.proxyAnyHubGet(deps.request, `${deps.pathname}${deps.url.search}`);
  }
  if (deps.pathname === '/api/debug/activity' && deps.request.method === 'GET') {
    return await handleDebugActivity(deps);
  }
  if (deps.pathname === '/api/debug/relay') {
    return handleDebugRelay(deps);
  }
  return null;
};
