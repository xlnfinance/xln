import type { JAdapter, JTokenInfo } from '../../../jurisdiction/adapter/types';
import type { RuntimeReplica } from '../../../runtime/types';
import type { BootstrapProgress, BootstrapProgressHealth } from '../../bootstrap/bootstrap-progress-watchdog';
import type { ShardJurisdictionsFile } from '../../j-select/jurisdictions';
import type { ResolvedMeshJurisdictionConfig } from '../../mesh/mesh-jurisdictions';

export type HubNodeArgs = {
  name: string;
  region: string;
  seed: string;
  signerLabel: string;
  relayUrl: string;
  apiHost: string;
  apiPort: number;
  directWsUrl: string;
  rpcUrl: string;
  rpc2Url: string;
  rpcUrls: Record<number, string>;
  meshHubNames: string[];
  supportPeerIdentitiesJson: string;
  dbPath: string;
  deployTokens: boolean;
};

export type SupportPeerIdentity = {
  name: string;
  entityId: string;
  signerId: string;
  jurisdictionName: string;
  chainId?: number;
  depositoryAddress?: string;
  jurisdictionRef: string;
};

export type HubPairHealth = {
  counterpartyId: string;
  counterpartyName: string;
  hasAccount: boolean;
  currentHeight: number;
  pendingFrameHeight: number | null;
  pendingFrameHash: string | null;
  grantedByMe: string;
  grantedByPeer: string;
  ready: boolean;
};

type StageTiming = {
  startedAt: number | null;
  completedAt: number | null;
  ms: number | null;
};

export type TimingMap = Record<string, StageTiming>;

type BootstrapReserveTokenHealth = {
  tokenId: number;
  symbol: string;
  decimals: number;
  current: string;
  expectedMin: string;
  ready: boolean;
  operational?: boolean;
  targetMet?: boolean;
};

export type BootstrapReserveEntityHealth = {
  entityId: string;
  jurisdictionName?: string;
  primary?: boolean;
  ready: boolean;
  targetMet: boolean;
  tokens: BootstrapReserveTokenHealth[];
};

export type BootstrapReserveHealth = {
  ok: boolean;
  targetMet?: boolean;
  tokens: BootstrapReserveTokenHealth[];
  entities?: BootstrapReserveEntityHealth[];
};

export type HubBootstrapEntry = {
  entityId: string;
  signerId: string;
  name: string;
  jurisdictionName: string;
  chainId?: number;
  depositoryAddress?: string;
  entityProviderAddress?: string;
  primary: boolean;
};

type HubBootstrapIdentity = {
  entityId: string;
  signerId: string;
};

export type HubNodeLiveContext = {
  env: RuntimeReplica;
  bootstrap: HubBootstrapIdentity | null;
  hubBootstraps: HubBootstrapEntry[];
  activeJAdapter: JAdapter | null;
  activeTokenCatalog: JTokenInfo[];
  p2p: ReturnType<(typeof import('../../../runtime'))['startP2P']> | null;
  externalIngressReady: boolean;
  brainVaultReady: boolean;
  shuttingDown: boolean;
  meshLoopProgress: BootstrapProgress;
  meshLoopInFlight: boolean;
};

export type JurisdictionImportDiagnostics = {
  name: string;
  rpc: string;
  chainId: number;
  deployTokens: boolean;
  inputContracts: boolean;
  usedContracts: boolean;
  probeRan: boolean;
  missingCode: string[];
  mode: 'no-contracts' | 'connect-existing' | 'missing-contract-code';
};

export type LocalHealthResponse = {
  ok: boolean;
  name: string;
  height: number;
  entityId: string | null;
  runtimeId: string | null;
  relayUrl: string;
  directWsUrl?: string;
  apiUrl: string;
  runtime: {
    halted: boolean;
    operatorStatus: 'HALTED_REQUIRES_OPERATOR' | null;
    lifecyclePhase: string | null;
    fatalDebugPayload: unknown;
    securityIncidents: ReturnType<(typeof import('../../../runtime/observability/security-incidents'))['readRuntimeSecurityIncidentTelemetry']>;
  };
  quiescence: ReturnType<(typeof import('../../mesh/mesh-common'))['summarizeRuntimeQuiescence']>;
  p2p?: { directPeers: Array<{ runtimeId: string; endpoint: string; open: boolean }> };
  gossip: { visibleHubNames: string[]; visibleHubIds: string[]; ready: boolean };
  mesh: { ready: boolean; pairs: HubPairHealth[] };
  bootstrapProgress: BootstrapProgressHealth;
  bootstrapReserves: BootstrapReserveHealth;
  jurisdiction: JurisdictionImportDiagnostics | null;
  jadapter: {
    ready: boolean;
    mode: string | null;
    contracts: JAdapter['addresses'] | null;
    tokenCatalogCount: number;
  };
  timings: TimingMap;
};

export type JurisdictionConfig = ResolvedMeshJurisdictionConfig;
export type JurisdictionsFile = ShardJurisdictionsFile;
