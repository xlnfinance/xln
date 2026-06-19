import { safeStringify } from '../serialization-utils';
import { pushDebugEvent, type RelayStore } from '../relay-store';
import { buildKnownProfileBundle } from '../server/gossip-profiles';
import { getDebugEntityEntries } from './public-discovery';
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
  pollAllHubHealth: () => Promise<void>;
  pollMarketMakerHealth: () => Promise<void>;
  proxyAnyHubGet: (request: Request, path: string) => Promise<Response>;
};

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

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
  const targetEntityId = String(deps.url.searchParams.get('entityId') || '').trim().toLowerCase();
  if (!targetEntityId) {
    return new Response(
      safeStringify({ ok: false, error: 'entityId is required' }),
      { status: 400, headers: deps.headers },
    );
  }

  const bundle = buildKnownProfileBundle({
    env: null,
    relayStore: deps.relayStore,
    entityId: targetEntityId,
  });
  return new Response(
    safeStringify({
      ok: true,
      entityId: targetEntityId,
      found: !!bundle.profile,
      profile: bundle.profile,
      peers: bundle.peers,
    }),
    { headers: deps.headers },
  );
};

const handleDebugEvents = (deps: OrchestratorDebugApiDeps): Response => {
  const last = Math.max(1, Math.min(5000, Number(deps.url.searchParams.get('last') || '200')));
  const event = deps.url.searchParams.get('event') || undefined;
  const runtimeId = deps.url.searchParams.get('runtimeId') || undefined;
  const from = deps.url.searchParams.get('from') || undefined;
  const to = deps.url.searchParams.get('to') || undefined;
  const msgType = deps.url.searchParams.get('msgType') || undefined;
  const status = deps.url.searchParams.get('status') || undefined;
  const since = Number(deps.url.searchParams.get('since') || '0');

  let filtered = deps.relayStore.debugEvents;
  if (since > 0) filtered = filtered.filter((entry) => entry.ts >= since);
  if (event) filtered = filtered.filter((entry) => entry.event === event);
  if (runtimeId) {
    filtered = filtered.filter((entry) =>
      entry.runtimeId === runtimeId || entry.from === runtimeId || entry.to === runtimeId,
    );
  }
  if (from) filtered = filtered.filter((entry) => entry.from === from);
  if (to) filtered = filtered.filter((entry) => entry.to === to);
  if (msgType) filtered = filtered.filter((entry) => entry.msgType === msgType);
  if (status) filtered = filtered.filter((entry) => entry.status === status);

  const events = filtered.slice(-last);
  return new Response(safeStringify({
    ok: true,
    total: deps.relayStore.debugEvents.length,
    returned: events.length,
    serverTime: Date.now(),
    filters: {
      last,
      event,
      runtimeId,
      from,
      to,
      msgType,
      status,
      since: Number.isFinite(since) ? since : 0,
    },
    events,
  }), { headers: deps.headers });
};

const handleDebugEventsMark = async (deps: OrchestratorDebugApiDeps): Promise<Response> => {
  const body = await deps.request.json().catch(() => ({} as Record<string, unknown>));
  const label = optionalString(body?.label) ?? '';
  if (!label) {
    return new Response(safeStringify({ ok: false, error: 'label is required' }), {
      status: 400,
      headers: deps.headers,
    });
  }
  const runtimeId = optionalString(body?.runtimeId);
  const entityId = optionalString(body?.entityId);
  const phase = optionalString(body?.phase);
  const details =
    body?.details && typeof body.details === 'object'
      ? body.details
      : undefined;
  pushDebugEvent(deps.relayStore, {
    event: 'e2e_phase',
    runtimeId,
    status: 'marked',
    details: {
      label,
      ...(entityId ? { entityId } : {}),
      ...(phase ? { phase } : {}),
      ...(details ? { details } : {}),
    },
  });
  return new Response(safeStringify({ ok: true, label }), { headers: deps.headers });
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
      const parsed = JSON.parse(text) as ActivityPageLike;
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
      return String(right['id'] || '').localeCompare(String(left['id'] || ''));
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
  if (deps.pathname === '/api/debug/entities') {
    return await handleDebugEntities(deps);
  }
  if (deps.pathname === '/api/gossip/profile') {
    return handleGossipProfile(deps);
  }
  if (deps.pathname === '/api/debug/reserve' && deps.request.method === 'GET') {
    return await deps.proxyAnyHubGet(deps.request, `${deps.pathname}${deps.url.search}`);
  }
  if (deps.pathname === '/api/debug/events') {
    return handleDebugEvents(deps);
  }
  if (deps.pathname === '/api/debug/activity' && deps.request.method === 'GET') {
    return await handleDebugActivity(deps);
  }
  if (deps.pathname === '/api/debug/events/mark' && deps.request.method === 'POST') {
    return await handleDebugEventsMark(deps);
  }
  if (deps.pathname === '/api/debug/relay') {
    return handleDebugRelay(deps);
  }
  return null;
};
