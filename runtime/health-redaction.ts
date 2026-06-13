type PublicHealthRecord = Record<string, unknown>;

const EMPTY_RECORD: PublicHealthRecord = {};

const isRecord = (value: unknown): value is PublicHealthRecord =>
  typeof value === 'object' && value !== null;

const recordOrEmpty = (value: unknown): PublicHealthRecord => (isRecord(value) ? value : EMPTY_RECORD);

const valueOf = (record: PublicHealthRecord, key: string): unknown => record[key];

const recordOf = (record: PublicHealthRecord, key: string): PublicHealthRecord =>
  recordOrEmpty(valueOf(record, key));

const optionalRecordOf = (record: PublicHealthRecord, key: string): PublicHealthRecord | null => {
  const value = valueOf(record, key);
  return isRecord(value) ? value : null;
};

const arrayOf = (record: PublicHealthRecord, key: string): unknown[] | undefined => {
  const value = valueOf(record, key);
  return Array.isArray(value) ? value : undefined;
};

const recordArrayOf = (record: PublicHealthRecord, key: string): PublicHealthRecord[] => {
  const value = valueOf(record, key);
  return Array.isArray(value) ? value.filter(isRecord) : [];
};

const readyCount = (record: PublicHealthRecord, key: string): number =>
  recordArrayOf(record, key).filter(item => valueOf(item, 'ready') === true).length;

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

export const publicRuntimeHealthBody = (payload: unknown): string => JSON.stringify(publicRuntimeHealth(payload));

export const publicRuntimeHealth = (payload: unknown): Record<string, unknown> => {
  const root = recordOrEmpty(payload);
  const relay = recordOf(root, 'relay');
  const hubMesh = recordOf(root, 'hubMesh');
  const marketMaker = recordOf(root, 'marketMaker');
  const custody = recordOf(root, 'custody');
  const bootstrapReserves = recordOf(root, 'bootstrapReserves');
  const disk = recordOf(root, 'disk');
  const storage = recordOf(root, 'storage');
  const boot = optionalRecordOf(root, 'boot');

  return {
    timestamp: valueOf(root, 'timestamp'),
    uptime: valueOf(root, 'uptime'),
    coreOk: valueOf(root, 'coreOk'),
    systemOk: valueOf(root, 'systemOk'),
    degraded: arrayOf(root, 'degraded'),
    system: valueOf(root, 'system'),
    boot: boot
      ? {
        phase: valueOf(boot, 'phase'),
        startedAt: valueOf(boot, 'startedAt'),
        completedAt: valueOf(boot, 'completedAt'),
        error: valueOf(boot, 'error') ? 'redacted' : null,
      }
      : undefined,
    relay: {
      activeClientCount: Number(valueOf(relay, 'activeClientCount') || valueOf(relay, 'clientCount') || 0),
      profileCount: Number(valueOf(relay, 'profileCount') || 0),
      marketSubscriptions: valueOf(relay, 'marketSubscriptions'),
    },
    hubMesh: publicHubMeshHealth(hubMesh),
    marketMaker: publicMarketMakerHealth(marketMaker),
    custody: {
      enabled: valueOf(custody, 'enabled') === true,
      ok: valueOf(custody, 'ok') === true,
    },
    bootstrapReserves: publicBootstrapReserveHealth(bootstrapReserves),
    disk: publicDiskHealth(disk),
    storage: publicStorageHealth(storage),
    hubs: recordArrayOf(root, 'hubs').map(hub => ({
      entityId: valueOf(hub, 'entityId'),
      name: valueOf(hub, 'name'),
      status: valueOf(hub, 'status'),
      online: valueOf(hub, 'online') === true,
      selfRelayPresence: valueOf(hub, 'selfRelayPresence') === true,
    })),
  };
};

export const publicAggregatedHealth = (health: unknown): Record<string, unknown> => {
  const root = recordOrEmpty(health);
  const relay = recordOf(root, 'relay');
  const hubMesh = recordOf(root, 'hubMesh');
  const marketMaker = recordOf(root, 'marketMaker');
  const custody = recordOf(root, 'custody');
  const bootstrapReserves = recordOf(root, 'bootstrapReserves');
  const disk = recordOf(root, 'disk');
  const storage = recordOf(root, 'storage');
  const processHealth = optionalRecordOf(root, 'process');
  const reset = optionalRecordOf(root, 'reset');

  return {
    timestamp: valueOf(root, 'timestamp'),
    coreOk: valueOf(root, 'coreOk'),
    systemOk: valueOf(root, 'systemOk'),
    degraded: arrayOf(root, 'degraded') ?? [],
    reset: reset
      ? {
        inProgress: valueOf(reset, 'inProgress') === true,
        startedAt: valueOf(reset, 'startedAt'),
        completedAt: valueOf(reset, 'completedAt'),
        failedAt: valueOf(reset, 'failedAt'),
        resolvedAt: valueOf(reset, 'resolvedAt'),
        hasError: Boolean(valueOf(reset, 'lastError')),
      }
      : undefined,
    system: valueOf(root, 'system'),
    relay: {
      clientCount: Number(valueOf(relay, 'clientCount') || 0),
      marketSubscriptions: valueOf(relay, 'marketSubscriptions'),
    },
    process: processHealth
      ? {
        pid: valueOf(processHealth, 'pid'),
        uptimeSec: valueOf(processHealth, 'uptimeSec'),
        rssBytes: valueOf(processHealth, 'rssBytes'),
        heapUsedBytes: valueOf(processHealth, 'heapUsedBytes'),
        loadavg: valueOf(processHealth, 'loadavg'),
        cpuCount: valueOf(processHealth, 'cpuCount'),
        childCount: arrayOf(processHealth, 'children')?.length,
      }
      : undefined,
    disk: publicDiskHealth(disk),
    storage: publicStorageHealth(storage),
    hubMesh: publicHubMeshHealth(hubMesh),
    marketMaker: publicMarketMakerHealth(marketMaker),
    custody: {
      enabled: valueOf(custody, 'enabled') === true,
      ok: valueOf(custody, 'ok') === true,
    },
    bootstrapReserves: publicBootstrapReserveHealth(bootstrapReserves),
    hubs: recordArrayOf(root, 'hubs').map(hub => ({
      name: valueOf(hub, 'name'),
      online: valueOf(hub, 'online') === true,
      selfRelayPresence: valueOf(hub, 'selfRelayPresence') === true,
    })),
    timings: valueOf(root, 'timings'),
  };
};

export const publicLocalHubHealth = (health: unknown): Record<string, unknown> => {
  const root = recordOrEmpty(health);
  const gossip = recordOf(root, 'gossip');
  const mesh = recordOf(root, 'mesh');
  const bootstrapReserves = recordOf(root, 'bootstrapReserves');
  const jurisdiction = optionalRecordOf(root, 'jurisdiction');
  const jadapter = recordOf(root, 'jadapter');
  const jadapterContracts = recordOf(jadapter, 'contracts');

  return {
    ok: valueOf(root, 'ok'),
    name: valueOf(root, 'name'),
    gossip: {
      ready: valueOf(gossip, 'ready') === true,
      visibleHubCount: arrayOf(gossip, 'visibleHubNames')?.length ?? 0,
    },
    mesh: {
      ready: valueOf(mesh, 'ready') === true,
      pairCount: arrayOf(mesh, 'pairs')?.length ?? 0,
      readyPairCount: readyCount(mesh, 'pairs'),
    },
    bootstrapReserves: {
      ok: valueOf(bootstrapReserves, 'ok') === true,
      targetMet: valueOf(bootstrapReserves, 'targetMet') === true,
      tokenCount: arrayOf(bootstrapReserves, 'tokens')?.length ?? 0,
      readyTokenCount: readyCount(bootstrapReserves, 'tokens'),
    },
    jurisdiction: jurisdiction
      ? {
        mode: valueOf(jurisdiction, 'mode'),
        usedContracts: valueOf(jurisdiction, 'usedContracts'),
        probeRan: valueOf(jurisdiction, 'probeRan'),
        missingCodeCount: arrayOf(jurisdiction, 'missingCode')?.length ?? 0,
      }
      : null,
    jadapter: {
      ready: valueOf(jadapter, 'ready') === true,
      mode: valueOf(jadapter, 'mode') ?? null,
      tokenCatalogCount: valueOf(jadapter, 'tokenCatalogCount') ?? 0,
      contractsReady: Boolean(valueOf(jadapterContracts, 'depository') && valueOf(jadapterContracts, 'entityProvider')),
    },
    timings: valueOf(root, 'timings'),
  };
};

const publicHubMeshHealth = (hubMesh: PublicHealthRecord): Record<string, unknown> => {
  const direct = recordOf(hubMesh, 'direct');
  return {
    ok: valueOf(hubMesh, 'ok'),
    hubCount: arrayOf(hubMesh, 'hubIds')?.length,
    pairCount: arrayOf(hubMesh, 'pairs')?.length,
    directOpenLinkCount: valueOf(direct, 'openLinkCount'),
  };
};

const publicMarketMakerHealth = (marketMaker: PublicHealthRecord): Record<string, unknown> => ({
  enabled: valueOf(marketMaker, 'enabled') === true,
  ok: valueOf(marketMaker, 'ok') === true,
  startupPhase: valueOf(marketMaker, 'startupPhase'),
  expectedOffersPerHub: valueOf(marketMaker, 'expectedOffersPerHub'),
  hubCount: arrayOf(marketMaker, 'hubs')?.length,
  cross: (() => {
    const cross = valueOf(marketMaker, 'cross');
    if (!cross || typeof cross !== 'object') return undefined;
    return {
      ok: valueOf(cross as PublicHealthRecord, 'ok') === true,
      expectedRoutes: valueOf(cross as PublicHealthRecord, 'expectedRoutes'),
      routeCount: arrayOf(cross as PublicHealthRecord, 'routes')?.length,
    };
  })(),
});

const publicBootstrapReserveHealth = (bootstrapReserves: PublicHealthRecord): Record<string, unknown> => ({
  ok: valueOf(bootstrapReserves, 'ok') === true,
  targetMet: valueOf(bootstrapReserves, 'targetMet') === true,
  requiredTokenCount: valueOf(bootstrapReserves, 'requiredTokenCount'),
  entityCount: valueOf(bootstrapReserves, 'entityCount'),
});

const publicDiskHealth = (disk: PublicHealthRecord): Record<string, unknown> => ({
  ok: valueOf(disk, 'ok'),
  freeGiB: valueOf(disk, 'freeGiB'),
  usedPct: valueOf(disk, 'usedPct'),
});

const publicStorageHealth = (storage: PublicHealthRecord): Record<string, unknown> => ({
  ok: valueOf(storage, 'ok'),
  reason: valueOf(storage, 'reason'),
});
