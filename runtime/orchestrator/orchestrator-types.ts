import type { ChildProcess } from 'node:child_process';
import type { ServerWebSocket } from 'bun';
import type { ManagedChild, ManagedIdentity } from './custody-bootstrap';
import type { StorageHealth } from './storage-monitor';

export type Args = {
  host: string;
  port: number;
  relayUrl: string;
  publicWsBaseUrl: string;
  nodeApiPortBase: number;
  nodePublicPortBase: number;
  rpcUrl: string;
  rpc2Url: string;
  rpcUrls: Record<number, string>;
  dbRoot: string;
  mmEnabled: boolean;
  resetAllowed: boolean;
  resetToken: string;
  deferInitialReset: boolean;
  custodyEnabled: boolean;
  custodyPort: number;
  custodyDaemonPort: number;
  custodyDbRoot: string;
  walletUrl: string;
};

export type OrchestratorWebSocket = ServerWebSocket<{ type: 'relay'; clientIp: string }>;

export type StageTiming = {
  startedAt: number | null;
  completedAt: number | null;
  ms: number | null;
};

export type TimingMap = Record<string, StageTiming>;

export type ResetState = {
  inProgress: boolean;
  lastError: string | null;
  startedAt: number | null;
  completedAt: number | null;
  failedAt: number | null;
  resolvedAt: number | null;
};

export type HubProcessSpec = {
  name: 'H1' | 'H2' | 'H3';
  region: string;
  seed: string;
  authSeed: string;
  signerLabel: string;
  apiPort: number;
  publicPort: number;
  dbPath: string;
  deployTokens: boolean;
};

export type HubChild = HubProcessSpec & {
  proc: ChildProcess | null;
  startedAt: number | null;
  exitedAt: number | null;
  exitCode: number | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
  restartCount: number;
  lastHealth: HubHealthPayload | null;
  lastInfo: HubInfoPayload | null;
  recentStdout: string[];
  recentStderr: string[];
};

export type HubHealthPayload = {
  ok?: boolean;
  name?: string;
  entityId?: string | null;
  runtimeId?: string | null;
  relayUrl?: string;
  apiUrl?: string;
  directWsUrl?: string;
  p2p?: {
    directPeers?: Array<{ runtimeId: string; endpoint: string; open: boolean }>;
  };
  gossip?: {
    visibleHubNames?: string[];
    visibleHubIds?: string[];
    ready?: boolean;
  };
  mesh?: {
    ready?: boolean;
    pairs?: Array<{
      counterpartyId: string;
      counterpartyName: string;
      hasAccount: boolean;
      grantedByMe: string;
      grantedByPeer: string;
      ready: boolean;
    }>;
  };
  bootstrapReserves?: {
    ok: boolean;
    targetMet?: boolean;
    tokens: Array<{
      tokenId: number;
      symbol: string;
      decimals: number;
      current: string;
      expectedMin: string;
      ready: boolean;
      operational?: boolean;
      targetMet?: boolean;
    }>;
    entities?: Array<{
      entityId: string;
      jurisdictionName?: string;
      primary?: boolean;
      ready: boolean;
      targetMet: boolean;
      tokens: Array<{
        tokenId: number;
        symbol: string;
        decimals: number;
        current: string;
        expectedMin: string;
        ready: boolean;
        operational?: boolean;
        targetMet?: boolean;
      }>;
    }>;
  };
  marketMaker?: {
    enabled: boolean;
    ok: boolean;
    entityId: string | null;
    startupPhase: string | null;
    expectedOffersPerHub: number;
    expectedOffersPerPair?: number;
    hubs: Array<{
      hubEntityId: string;
      offers: number;
      ready: boolean;
      pairs?: Array<{
        pairId: string;
        offers: number;
        ready: boolean;
      }>;
    }>;
  };
  timings?: TimingMap;
};

export type HubInfoPayload = {
  name?: string;
  entityId?: string;
  hubEntities?: Array<{
    entityId?: string;
    signerId?: string;
    name?: string;
    jurisdictionName?: string;
    chainId?: number;
    depositoryAddress?: string;
    entityProviderAddress?: string;
    primary?: boolean;
  }>;
  runtimeId?: string;
  apiUrl?: string;
  relayUrl?: string;
  directWsUrl?: string;
  startupPhase?: string;
};

export type MarketMakerCrossRouteHealthPayload = {
  sourceJurisdiction: string;
  targetJurisdiction: string;
  sourceHubEntityId: string;
  targetHubEntityId: string;
  offers: number;
  ready: boolean;
  depthReady?: boolean;
  pairs?: Array<{
    pairId: string;
    offers: number;
    ready: boolean;
    depthReady?: boolean;
    expectedOffers?: number;
    sourceTokenIds?: number[];
    targetTokenIds?: number[];
  }>;
};

export type MarketMakerCrossHealthPayload = {
  applicable: boolean;
  ok: boolean;
  expectedRoutes: number;
  expectedOffersPerRoute: number;
  expectedOffersPerPair: number;
  routes: MarketMakerCrossRouteHealthPayload[];
};

export type MarketMakerHealthPayload = {
  ok?: boolean;
  name?: string;
  entityId?: string | null;
  runtimeId?: string | null;
  relayUrl?: string;
  apiUrl?: string;
  directWsUrl?: string;
  startupPhase?: string;
  p2p?: {
    directPeers?: Array<{ runtimeId: string; endpoint: string; open: boolean }>;
  };
  gossip?: {
    visibleHubNames?: string[];
    visibleHubIds?: string[];
    ready?: boolean;
  };
  marketMaker?: {
    enabled: boolean;
    ok: boolean;
    entityId: string | null;
    expectedOffersPerHub: number;
    expectedOffersPerPair?: number;
    cross?: MarketMakerCrossHealthPayload;
    hubs: Array<{
      hubEntityId: string;
      offers: number;
      ready: boolean;
      depthReady?: boolean;
      pairs?: Array<{
        pairId: string;
        offers: number;
        ready: boolean;
        depthReady?: boolean;
        expectedOffers?: number;
      }>;
    }>;
  };
};

export type MarketMakerInfoPayload = HubInfoPayload;

export type ManagedRuntimeRole = 'hub' | 'market-maker';

export type AggregatedHealth = {
  timestamp: number;
  coreOk: boolean;
  systemOk: boolean;
  degraded: string[];
  reset: ResetState;
  system: {
    runtime: boolean;
    relay: boolean;
  };
  relay: {
    clientCount: number;
    managedRuntimeIds: string[];
    externalClientIds: string[];
    marketSubscriptions: {
      total: number;
      byIp: Record<string, number>;
      maxTotal: number;
      maxPerIp: number;
      maxCellsPerSubscription: number;
    };
  };
  process: {
    pid: number;
    ownerId: string;
    uptimeSec: number;
    rssBytes: number;
    heapUsedBytes: number;
    loadavg: number[];
    cpuCount: number;
    memory: {
      freeBytes: number;
      totalBytes: number;
      freePct: number;
    };
    children: Array<{
      role: ManagedRuntimeRole;
      name: string;
      pid: number | null;
      leasePid: number | null;
      leaseOwnerId: string | null;
      online: boolean;
      exitCode: number | null;
      exitSignal?: NodeJS.Signals | null;
      startedAt: number | null;
      exitedAt: number | null;
      restartCount: number;
      apiPort: number;
      dbPath: string;
      lastErrorLine: string | null;
      recentStdout: string[];
      recentStderr: string[];
    }>;
  };
  disk: {
    ok: boolean;
    minFreeBytes: number;
    freeBytes: number;
    usedBytes: number;
    totalBytes: number;
    freeGiB: number;
    usedGiB: number;
    totalGiB: number;
    usedPct: number;
  };
  storage: StorageHealth;
  hubMesh: {
    ok: boolean;
    hubIds: string[];
    pairs: Array<{ left: string; right: string; ok: boolean }>;
    direct: {
      openLinkCount: number;
      links: Array<{ fromRuntimeId: string; toRuntimeId: string; endpoint: string }>;
    };
  };
  marketMaker: {
    enabled: boolean;
    ok: boolean;
    entityId: string | null;
    startupPhase: string | null;
    expectedOffersPerHub: number;
    expectedOffersPerPair?: number;
    cross: MarketMakerCrossHealthPayload;
    hubs: Array<{
      hubEntityId: string;
      offers: number;
      ready: boolean;
      depthReady?: boolean;
      pairs: Array<{
        pairId: string;
        offers: number;
        ready: boolean;
        depthReady?: boolean;
        expectedOffers?: number;
        sourceTokenIds?: number[];
        targetTokenIds?: number[];
      }>;
    }>;
  };
  custody: {
    enabled: boolean;
    ok: boolean;
    entityId: string | null;
    daemonPort: number | null;
    servicePort: number | null;
  };
  bootstrapReserves: {
    ok: boolean;
    targetMet: boolean;
    requiredTokenCount: number;
    entityCount: number;
    entities: Array<{
      entityId: string;
      role: 'hub' | 'market-maker';
      ready: boolean;
      targetMet: boolean;
      tokens: Array<{
        tokenId: number;
        symbol: string;
        decimals: number;
        current: string;
        expectedMin: string;
        ready: boolean;
        operational?: boolean;
        targetMet?: boolean;
      }>;
    }>;
  };
  hubs: Array<{
    entityId: string;
    name: string;
    online: boolean;
    runtimeId: string;
    selfRelayPresence: boolean;
    pid: number | null;
    apiPort: number;
    apiUrl: string;
    dbPath: string;
    startedAt: number | null;
    exitedAt: number | null;
    exitCode: number | null;
    restartCount: number;
    lastErrorLine: string | null;
  }>;
  timings: TimingMap;
};

export type MarketMakerChild = {
  name: 'MM';
  seed: string;
  authSeed: string;
  signerLabel: string;
  apiPort: number;
  publicPort: number;
  dbPath: string;
  proc: ChildProcess | null;
  startedAt: number | null;
  exitedAt: number | null;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
  restartCount: number;
  lastHealth: MarketMakerHealthPayload | null;
  lastInfo: MarketMakerInfoPayload | null;
  lastStartupPhase: string | null;
  recentStdout: string[];
  recentStderr: string[];
};

export type CustodySupportState = {
  daemonChild: ManagedChild;
  custodyChild: ManagedChild;
  identity: ManagedIdentity;
  hubIds: string[];
};

export type ManagedRuntimeSpec = {
  role: ManagedRuntimeRole;
  name: string;
  script: 'runtime/orchestrator/hub-node.ts' | 'runtime/orchestrator/mm-node.ts';
  apiPort: number;
  dbPath: string;
};

export type ManagedRuntimeLease = ManagedRuntimeSpec & {
  ownerId: string;
  orchestratorPid: number;
  pid: number;
  cwd: string;
  startedAt: number;
  updatedAt: number;
};
