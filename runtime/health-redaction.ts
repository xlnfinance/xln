const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const normalizeHostName = (host: string | null): string => {
  const raw = String(host || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('[')) return raw.slice(1, raw.indexOf(']') > 0 ? raw.indexOf(']') : undefined);
  return raw.split(':')[0] || '';
};

const isLoopbackHostName = (host: string): boolean =>
  host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';

export const isLocalOperatorRequest = (request: Request): boolean => {
  const host = normalizeHostName(request.headers.get('host') || new URL(request.url).host);
  if (!isLoopbackHostName(host)) return false;
  const forwardedFor = String(request.headers.get('x-forwarded-for') || '').trim();
  if (!forwardedFor) return true;
  return forwardedFor
    .split(',')
    .map(value => normalizeHostName(value))
    .filter(Boolean)
    .every(isLoopbackHostName);
};

export const publicRuntimeHealthBody = (payload: any): string => JSON.stringify(publicRuntimeHealth(payload));

export const publicRuntimeHealth = (payload: any): Record<string, unknown> => {
  const relay: any = isRecord(payload.relay) ? payload.relay : {};
  const hubMesh: any = isRecord(payload.hubMesh) ? payload.hubMesh : {};
  const marketMaker: any = isRecord(payload.marketMaker) ? payload.marketMaker : {};
  const custody: any = isRecord(payload.custody) ? payload.custody : {};
  const bootstrapReserves: any = isRecord(payload.bootstrapReserves) ? payload.bootstrapReserves : {};
  const disk: any = isRecord(payload.disk) ? payload.disk : {};
  const storage: any = isRecord(payload.storage) ? payload.storage : {};
  const boot: any = isRecord(payload.boot) ? payload.boot : null;

  return {
    timestamp: payload.timestamp,
    uptime: payload.uptime,
    coreOk: payload.coreOk,
    systemOk: payload.systemOk,
    degraded: Array.isArray(payload.degraded) ? payload.degraded : undefined,
    system: payload.system,
    boot: boot
      ? {
        phase: boot.phase,
        startedAt: boot.startedAt,
        completedAt: boot.completedAt,
        error: boot.error ? 'redacted' : null,
      }
      : undefined,
    relay: {
      activeClientCount: Number(relay.activeClientCount || relay.clientCount || 0),
      profileCount: Number(relay.profileCount || 0),
      marketSubscriptions: relay.marketSubscriptions,
    },
    hubMesh: publicHubMeshHealth(hubMesh),
    marketMaker: publicMarketMakerHealth(marketMaker),
    custody: {
      enabled: custody.enabled === true,
      ok: custody.ok === true,
    },
    bootstrapReserves: publicBootstrapReserveHealth(bootstrapReserves),
    disk: publicDiskHealth(disk),
    storage: publicStorageHealth(storage),
    hubs: Array.isArray(payload.hubs)
      ? payload.hubs.map((hub: any) => ({
        entityId: hub.entityId,
        name: hub.name,
        status: hub.status,
        online: hub.online === true,
        selfRelayPresence: hub.selfRelayPresence === true,
      }))
      : [],
  };
};

export const publicAggregatedHealth = (health: any): Record<string, unknown> => {
  const relay: any = isRecord(health.relay) ? health.relay : {};
  const hubMesh: any = isRecord(health.hubMesh) ? health.hubMesh : {};
  const marketMaker: any = isRecord(health.marketMaker) ? health.marketMaker : {};
  const custody: any = isRecord(health.custody) ? health.custody : {};
  const bootstrapReserves: any = isRecord(health.bootstrapReserves) ? health.bootstrapReserves : {};
  const disk: any = isRecord(health.disk) ? health.disk : {};
  const storage: any = isRecord(health.storage) ? health.storage : {};
  const processHealth: any = isRecord(health.process) ? health.process : null;
  const reset: any = isRecord(health.reset) ? health.reset : null;

  return {
    timestamp: health.timestamp,
    coreOk: health.coreOk,
    systemOk: health.systemOk,
    degraded: Array.isArray(health.degraded) ? health.degraded : [],
    reset: reset
      ? {
        inProgress: reset.inProgress === true,
        startedAt: reset.startedAt,
        completedAt: reset.completedAt,
        failedAt: reset.failedAt,
        resolvedAt: reset.resolvedAt,
        hasError: Boolean(reset.lastError),
      }
      : undefined,
    system: health.system,
    relay: {
      clientCount: Number(relay.clientCount || 0),
      marketSubscriptions: relay.marketSubscriptions,
    },
    process: processHealth
      ? {
        pid: processHealth.pid,
        uptimeSec: processHealth.uptimeSec,
        rssBytes: processHealth.rssBytes,
        heapUsedBytes: processHealth.heapUsedBytes,
        loadavg: processHealth.loadavg,
        cpuCount: processHealth.cpuCount,
        childCount: Array.isArray(processHealth.children) ? processHealth.children.length : undefined,
      }
      : undefined,
    disk: publicDiskHealth(disk),
    storage: publicStorageHealth(storage),
    hubMesh: publicHubMeshHealth(hubMesh),
    marketMaker: publicMarketMakerHealth(marketMaker),
    custody: {
      enabled: custody.enabled === true,
      ok: custody.ok === true,
    },
    bootstrapReserves: publicBootstrapReserveHealth(bootstrapReserves),
    hubs: Array.isArray(health.hubs)
      ? health.hubs.map((hub: any) => ({
        name: hub.name,
        online: hub.online === true,
        selfRelayPresence: hub.selfRelayPresence === true,
      }))
      : [],
    timings: health.timings,
  };
};

export const publicLocalHubHealth = (health: any): Record<string, unknown> => ({
  ok: health.ok,
  name: health.name,
  gossip: {
    ready: health.gossip?.ready === true,
    visibleHubCount: Array.isArray(health.gossip?.visibleHubNames) ? health.gossip.visibleHubNames.length : 0,
  },
  mesh: {
    ready: health.mesh?.ready === true,
    pairCount: Array.isArray(health.mesh?.pairs) ? health.mesh.pairs.length : 0,
    readyPairCount: Array.isArray(health.mesh?.pairs)
      ? health.mesh.pairs.filter((pair: any) => pair?.ready === true).length
      : 0,
  },
  bootstrapReserves: {
    ok: health.bootstrapReserves?.ok === true,
    targetMet: health.bootstrapReserves?.targetMet === true,
    tokenCount: Array.isArray(health.bootstrapReserves?.tokens) ? health.bootstrapReserves.tokens.length : 0,
    readyTokenCount: Array.isArray(health.bootstrapReserves?.tokens)
      ? health.bootstrapReserves.tokens.filter((token: any) => token?.ready === true).length
      : 0,
  },
  jurisdiction: health.jurisdiction
    ? {
      mode: health.jurisdiction.mode,
      usedContracts: health.jurisdiction.usedContracts,
      probeRan: health.jurisdiction.probeRan,
      missingCodeCount: Array.isArray(health.jurisdiction.missingCode) ? health.jurisdiction.missingCode.length : 0,
    }
    : null,
  jadapter: {
    ready: health.jadapter?.ready === true,
    mode: health.jadapter?.mode ?? null,
    tokenCatalogCount: health.jadapter?.tokenCatalogCount ?? 0,
    contractsReady: isRecord(health.jadapter?.contracts)
      ? Boolean((health.jadapter.contracts as any).depository && (health.jadapter.contracts as any).entityProvider)
      : false,
  },
  timings: health.timings,
});

const publicHubMeshHealth = (hubMesh: any): Record<string, unknown> => ({
  ok: hubMesh.ok,
  hubCount: Array.isArray(hubMesh.hubIds) ? hubMesh.hubIds.length : undefined,
  pairCount: Array.isArray(hubMesh.pairs) ? hubMesh.pairs.length : undefined,
  directOpenLinkCount: isRecord(hubMesh.direct) ? (hubMesh.direct as any).openLinkCount : undefined,
});

const publicMarketMakerHealth = (marketMaker: any): Record<string, unknown> => ({
  enabled: marketMaker.enabled === true,
  ok: marketMaker.ok === true,
  startupPhase: marketMaker.startupPhase,
  expectedOffersPerHub: marketMaker.expectedOffersPerHub,
  hubCount: Array.isArray(marketMaker.hubs) ? marketMaker.hubs.length : undefined,
});

const publicBootstrapReserveHealth = (bootstrapReserves: any): Record<string, unknown> => ({
  ok: bootstrapReserves.ok === true,
  targetMet: bootstrapReserves.targetMet === true,
  requiredTokenCount: bootstrapReserves.requiredTokenCount,
  entityCount: bootstrapReserves.entityCount,
});

const publicDiskHealth = (disk: any): Record<string, unknown> => ({
  ok: disk.ok,
  freeGiB: disk.freeGiB,
  usedPct: disk.usedPct,
});

const publicStorageHealth = (storage: any): Record<string, unknown> => ({
  ok: storage.ok,
  reason: storage.reason,
});
