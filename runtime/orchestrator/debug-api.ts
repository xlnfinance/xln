import { safeStringify } from '../serialization-utils';
import { pushDebugEvent, type RelayStore } from '../relay-store';
import { getDebugEntityEntries } from './public-discovery';
import type { HubChild, MarketMakerChild } from './orchestrator-types';

type OrchestratorDebugApiDeps = {
  request: Request;
  pathname: string;
  url: URL;
  headers: HeadersInit;
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

export const maybeHandleOrchestratorDebugApi = async (
  deps: OrchestratorDebugApiDeps,
): Promise<Response | null> => {
  if (deps.pathname === '/api/debug/entities') {
    return await handleDebugEntities(deps);
  }
  if (deps.pathname === '/api/debug/reserve' && deps.request.method === 'GET') {
    return await deps.proxyAnyHubGet(deps.request, `${deps.pathname}${deps.url.search}`);
  }
  if (deps.pathname === '/api/debug/events') {
    return handleDebugEvents(deps);
  }
  if (deps.pathname === '/api/debug/events/mark' && deps.request.method === 'POST') {
    return await handleDebugEventsMark(deps);
  }
  if (deps.pathname === '/api/debug/relay') {
    return handleDebugRelay(deps);
  }
  return null;
};
