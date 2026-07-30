#!/usr/bin/env bun

import { ethers, getIndexedAccountPath, HDNodeWallet, Mnemonic } from 'ethers';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createExternalWalletApi } from '../api/external-wallet-api';
import { hasCliFlag, readCliOption } from '../config/cli';
import { readBooleanEnv } from '../config/environment';
import { normalizeRuntimeId } from '../networking/runtime-id';
import { bootstrapHub } from '../../scripts/bootstrap-hub';
import { defaultTokensForJurisdiction } from '../jurisdiction/default-tokens';
import { deployMissingDefaultTokens } from '../jurisdiction/dev-token-deployment';
import type { JAdapter, JTokenInfo } from '../jadapter/types';
import {
  normalizeJurisdictionKey,
  selectWritableJurisdictionKey,
  type WritableJurisdictionEntry,
} from '../jurisdiction/jurisdiction-key';
import { resolveJurisdictionsJsonPath } from '../jurisdiction/jurisdictions-path';
import { DEFAULT_SPREAD_DISTRIBUTION } from '../orderbook';
import {
  buildMarketSnapshotForReplica,
  normalizeMarketEntityId,
  normalizeMarketPairId,
  RPC_MARKET_DEFAULT_DEPTH,
  RPC_MARKET_MAX_DEPTH,
} from '../relay/market-snapshot';
import { toPublicRpcUrl } from '../networking/loopback-url';
import { startParentLivenessWatch } from '../infra/parent-watch';
import { createHttpDrainTracker, stopServerGracefully } from './graceful-server';
import { quiesceNodeRuntime } from './node-runtime-quiesce';
import { applyJEventsToEnv } from '../jadapter/watcher';
import { drainJWatcherBacklog } from '../jadapter/backlog-drain';
import { createRelayStore } from '../relay/store';
import { safeStringify } from '../protocol/serialization';
import { createStructuredLogger } from '../infra/logger';
import { getPerfMs } from '../infra/time';
import { handleMeshBootstrapLoopError } from './mesh-bootstrap-fail-fast';
import { reportManagedChildFatal } from './managed-child-fatal-ipc';
import {
  advanceBootstrapProgress,
  beginBootstrapProgress,
  buildBootstrapProgressHealth,
  type BootstrapProgress,
  type BootstrapProgressHealth,
} from './bootstrap-progress-watchdog';
import { restoredRuntimeRouteRelocated } from './restored-gossip-route';
import { readInheritedChildSecrets, resolveChildSecret } from '../infra/child-secrets';
import { findMissingRpcContractCode } from './contract-readiness';
import { readJurisdictionsFile } from './jurisdictions-file';
import { getTokenIdsForJurisdiction } from '../account/utils';
import { isLocalOperatorRequest, publicLocalHubHealth, resolveSocketPeerAddress } from '../server/health-redaction';
import { requiresLocalNodeOperator } from '../server/node-http-access';
import {
  deriveRuntimeAdapterCapabilityToken,
  registerRuntimeAdapterAuthSeed,
  resolveRuntimeAdapterAuthAudience,
  resolveRuntimeAdapterAuthSeed,
} from '../radapter/auth';
import {
  getJReplicaByJurisdictionRef,
  getJurisdictionIdentityRef,
  isJurisdictionStackRef,
} from '../jurisdiction/jurisdiction-runtime';
import {
  attachRuntimeAdapterTicker,
  forgetRuntimeAdapterClient,
} from '../radapter/server';
import { redactTokenBearingUrlForLog } from './runtime-import-log';
import { handleLendingStateRequest } from '../server/lending';
import { handleRuntimeActivityRequest } from '../server/activity-api';
import { handleReserveFaucet } from '../server/reserve-faucet';
import { handleOffchainFaucet } from '../server/offchain-faucet';
import { createRuntimeIngressReceiptStore } from '../runtime/ingress-receipts';
import { handleRuntimeInputStatus } from '../server/runtime-input-control';
import {
  getActiveJAdapter,
  getP2PState,
  clearGossip,
  closeInfraDb,
  closeRuntimeDb,
  main,
  processRuntime,
  enqueueRuntimeInput,
  startP2P,
  startJurisdictionWatchers,
  startRuntimeLoop,
  getEntityJAdapter,
  registerRuntimeFrameCommitCallback,
  validateRuntimeInputAdmission,
} from '../runtime.ts';
import { registerEnvChangeCallback } from '../runtime/loop-environment';
import type { EntityInput } from '../entity/types';
import type { RuntimeReplica } from '../runtime/types';
import type { JReplica } from '../types/jurisdiction-runtime';
import {
  BOOTSTRAP_POLL_MS,
  DEFAULT_ACCOUNT_TOKEN_IDS,
  getAccountState,
  getBootstrapCreditAmount,
  getBootstrapTokenAmount,
  getCreditGrantedByEntity,
  getEntityOutCapacity,
  getEntityReplicaById,
  HUB_DEFAULT_MIN_TRADE_SIZE,
  HUB_DEFAULT_SUPPORTED_PAIRS,
  HUB_MESH_TOKEN_ID,
  HUB_REQUIRED_TOKEN_COUNT,
  hasAccount,
  hasPendingRuntimeWork,
  hasQueuedOpenAccount,
  hasPairMutualCredits,
  isCanonicalAccountOpener,
  serializeAccountDelta,
  settleRuntimeFor,
  sleep,
  summarizeRuntimeQuiescence,
  waitUntil,
} from './mesh-common';
import {
  requireJurisdictionBlockTimeMs,
  resetMeshJurisdictionsCache,
  resolveMeshJurisdictionConfig,
  resolveMeshJurisdictionRpcBindings,
  resolveSecondaryJurisdictions,
  type ResolvedMeshJurisdictionConfig,
} from './mesh-jurisdictions';
import {
  createHubDirectRuntimeRoute,
  createHubRadapterMessageHandler,
  runtimeInputStatusUrl,
  type DirectEntityInputDebug,
  type DirectInputDebugState,
  type HubServerSocket,
} from './hub-runtime-transport';

type Args = {
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

type SupportPeerIdentity = {
  name: string;
  entityId: string;
  signerId: string;
  jurisdictionName: string;
  chainId?: number;
  depositoryAddress?: string;
  jurisdictionRef: string;
};

type HubPairHealth = {
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

type VisibleHubProfile = {
  name: string;
  hubName?: string;
  entityId: string;
  runtimeId: string;
  jurisdictionName: string;
  chainId?: number;
  depositoryAddress?: string;
  jurisdictionRef: string;
};

type VisibleSupportPeer = SupportPeerIdentity & {
  runtimeId: string;
};

type StageTiming = {
  startedAt: number | null;
  completedAt: number | null;
  ms: number | null;
};

type TimingMap = Record<string, StageTiming>;

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

type BootstrapReserveEntityHealth = {
  entityId: string;
  jurisdictionName?: string;
  primary?: boolean;
  ready: boolean;
  targetMet: boolean;
  tokens: BootstrapReserveTokenHealth[];
};

type BootstrapReserveHealth = {
  ok: boolean;
  targetMet?: boolean;
  tokens: BootstrapReserveTokenHealth[];
  entities?: BootstrapReserveEntityHealth[];
};

type HubBootstrapEntry = {
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

type HubNodeLiveContext = {
  env: RuntimeReplica;
  bootstrap: HubBootstrapIdentity | null;
  hubBootstraps: HubBootstrapEntry[];
  activeJAdapter: JAdapter | null;
  activeTokenCatalog: JTokenInfo[];
  p2p: ReturnType<typeof startP2P> | null;
  externalIngressReady: boolean;
  shuttingDown: boolean;
  meshLoopProgress: BootstrapProgress;
  meshLoopInFlight: boolean;
};

type LocalHealthResponse = {
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
    lifecyclePhase: string | null;
    fatalDebugPayload: unknown;
  };
  quiescence: ReturnType<typeof summarizeRuntimeQuiescence>;
  p2p?: {
    directPeers: Array<{ runtimeId: string; endpoint: string; open: boolean }>;
  };
  gossip: {
    visibleHubNames: string[];
    visibleHubIds: string[];
    ready: boolean;
  };
  mesh: {
    ready: boolean;
    pairs: HubPairHealth[];
  };
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

type JurisdictionConfig = ResolvedMeshJurisdictionConfig;

type JurisdictionsFile = {
  version?: string;
  deployVersion?: string;
  networkVersion?: string;
  lastUpdated?: string;
  jurisdictions?: Record<string, WritableJurisdictionEntry & {
    name?: string;
    chainId?: number;
    rpc?: string;
    blockTimeMs?: number;
    explorer?: string;
    currency?: string;
    status?: string;
    contracts?: {
      depository?: string;
      entityProvider?: string;
      account?: string;
      deltaTransformer?: string;
    };
  }>;
  defaults?: Record<string, unknown>;
};

const normalizeJurisdictionDisplayName = (value: unknown): string =>
  String(value || '').trim();

const normalizeJurisdictionName = (value: unknown): string =>
  normalizeJurisdictionDisplayName(value).trim().toLowerCase();

const resolveJReplicaForJurisdictionName = (
  env: RuntimeReplica,
  jurisdictionName: string,
): { name: string; replica: JReplica } | null => {
  return resolveJReplicaForJurisdictionIdentity(env, { name: jurisdictionName });
};

const sameJurisdictionRef = (left: unknown, right: unknown): boolean => {
  const leftRef = getJurisdictionIdentityRef(left);
  const rightRef = getJurisdictionIdentityRef(right);
  return Boolean(leftRef && rightRef && leftRef === rightRef);
};

const resolveJReplicaForJurisdictionIdentity = (
  env: RuntimeReplica,
  jurisdiction: unknown,
): { name: string; replica: JReplica } | null => {
  const explicitRef = isJurisdictionStackRef(jurisdiction) ? String(jurisdiction).trim().toLowerCase() : '';
  const targetRef = explicitRef || getJurisdictionIdentityRef(jurisdiction);
  const targetName = normalizeJurisdictionName(typeof jurisdiction === 'string'
    ? jurisdiction
    : (jurisdiction as { name?: unknown; jurisdictionName?: unknown } | null | undefined)?.name ||
      (jurisdiction as { jurisdictionName?: unknown } | null | undefined)?.jurisdictionName);
  if (!targetRef && !targetName) return null;
  for (const [name, replica] of env.state.jReplicas?.entries?.() || []) {
    const candidate = { ...replica, name: replica?.name || name };
    if (targetRef) {
      if (getJurisdictionIdentityRef(candidate) === targetRef) return { name, replica };
      continue;
    }
    if (targetName && normalizeJurisdictionName(candidate.name || name) === targetName) {
      return { name, replica };
    }
  }
  return null;
};

const hasLiveJAdapterForJurisdiction = (env: RuntimeReplica, jurisdictionName: string): boolean =>
  Boolean(resolveJReplicaForJurisdictionName(env, jurisdictionName)?.replica?.jadapter);

type JurisdictionImportDiagnostics = {
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

const argsRaw = process.argv.slice(2);

const getArg = (name: string, fallback = ''): string =>
  readCliOption(argsRaw, name, fallback);

const hasFlag = (name: string): boolean => hasCliFlag(argsRaw, name);

const readRpcUrls = (): Record<number, string> => {
  const urls: Record<number, string> = {};
  for (let index = 1; index <= 8; index += 1) {
    const flag = index === 1 ? '--rpc-url' : `--rpc${index}-url`;
    const envName = index === 1 ? 'ANVIL_RPC' : `ANVIL_RPC${index}`;
    const fallback = index === 1
      ? process.env['ANVIL_RPC'] || ''
      : process.env[envName] || process.env[`RPC${index}`] || process.env[`XLN_RPC${index}_URL`] || '';
    urls[index] = getArg(flag, index === 2 ? (process.env['ANVIL_RPC2'] || process.env['RPC_TRON'] || fallback) : fallback);
  }
  return urls;
};

const parseArgs = (): Args => {
  const apiPort = Number(getArg('--api-port', '0'));
  if (!Number.isFinite(apiPort) || apiPort <= 0) {
    throw new Error(`Invalid --api-port: ${String(apiPort)}`);
  }
  const rpcUrls = readRpcUrls();

  const childSecrets = readInheritedChildSecrets();
  const radapterAuthSeed = resolveChildSecret(
    childSecrets,
    'radapterAuthSeed',
    process.env['XLN_RADAPTER_AUTH_SEED'] || '',
  );
  if (radapterAuthSeed) {
    registerRuntimeAdapterAuthSeed(radapterAuthSeed);
    delete process.env['XLN_RADAPTER_AUTH_SEED'];
  }
  const seed = resolveChildSecret(
    childSecrets,
    'runtimeSeed',
    getArg('--seed', process.env['XLN_RUNTIME_SEED'] || ''),
  );
  if (!seed) throw new Error('Hub seed is required via inherited secret FD, --seed, or XLN_RUNTIME_SEED');
  return {
    name: getArg('--name', 'H1'),
    region: getArg('--region', 'global'),
    seed,
    signerLabel: getArg('--signer-label', 'hub-1'),
    relayUrl: getArg('--relay-url', 'ws://127.0.0.1:20002/relay'),
    apiHost: getArg('--api-host', '127.0.0.1'),
    apiPort,
    directWsUrl: getArg('--direct-ws-url', ''),
    rpcUrl: rpcUrls[1] || '',
    rpc2Url: rpcUrls[2] || '',
    rpcUrls,
    meshHubNames: getArg('--mesh-hub-names', 'H1,H2,H3')
      .split(',')
      .map(part => part.trim())
      .filter(Boolean),
    supportPeerIdentitiesJson: getArg('--support-peer-identities-json', '[]'),
    dbPath: getArg('--db-path', ''),
    deployTokens: hasFlag('--deploy-tokens'),
  };
};

const DEFAULT_ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';
const FAUCET_SIGNER_LABEL = 'faucet-1';
const FAUCET_WALLET_ETH_TARGET = ethers.parseEther('10');
const FAUCET_TOKEN_TARGET_UNITS = 1_000_000n;
const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

const resolveHubSignerIndex = (name: string): number => {
  const normalized = String(name || '').trim().toUpperCase();
  if (normalized === 'H1') return 0;
  if (normalized === 'H2') return 1;
  if (normalized === 'H3') return 2;
  return 0;
};

const deriveAnvilDevPrivateKey = (index: number): string => {
  const mnemonic = Mnemonic.fromPhrase(process.env['ANVIL_MNEMONIC'] || DEFAULT_ANVIL_MNEMONIC);
  const wallet = HDNodeWallet.fromMnemonic(mnemonic, getIndexedAccountPath(index));
  return wallet.privateKey;
};

const parseSupportPeerIdentities = (raw: string): SupportPeerIdentity[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('SUPPORT_PEER_IDENTITIES_JSON_INVALID:malformed JSON', { cause: error });
  }
  if (!Array.isArray(parsed)) throw new Error('SUPPORT_PEER_IDENTITIES_JSON_INVALID:expected array');

  return parsed.map((rawEntry, index) => {
    if (!rawEntry || typeof rawEntry !== 'object') {
      throw new Error(`SUPPORT_PEER_IDENTITIES_JSON_INVALID:index=${index}:expected object`);
    }
    const entry = rawEntry as Record<string, unknown>;
    const rawChainId = Number(entry['chainId']);
    const chainId = Number.isInteger(rawChainId) && rawChainId > 0 ? rawChainId : null;
    const depositoryAddress = String(entry['depositoryAddress'] || '').trim();
    const jurisdictionRef = getJurisdictionIdentityRef({ chainId, depositoryAddress });
    const identity: SupportPeerIdentity = {
      name: String(entry['name'] || '').trim(),
      entityId: String(entry['entityId'] || '').trim().toLowerCase(),
      signerId: String(entry['signerId'] || '').trim().toLowerCase(),
      jurisdictionName: normalizeJurisdictionDisplayName(entry['jurisdictionName'] || ''),
      ...(chainId !== null ? { chainId } : {}),
      ...(depositoryAddress ? { depositoryAddress } : {}),
      jurisdictionRef,
    };
    if (
      !identity.name ||
      !/^0x[0-9a-f]{64}$/.test(identity.entityId) ||
      !/^0x[0-9a-f]{40}$/.test(identity.signerId) ||
      !identity.jurisdictionName ||
      !identity.jurisdictionRef
    ) {
      throw new Error(`SUPPORT_PEER_IDENTITIES_JSON_INVALID:index=${index}:invalid identity binding`);
    }
    return identity;
  });
};

const resolvedArgs = parseArgs();
const supportPeerIdentities = parseSupportPeerIdentities(resolvedArgs.supportPeerIdentitiesJson);
const apiUrl = `http://${resolvedArgs.apiHost}:${resolvedArgs.apiPort}`;
const normalizePositiveTokenIds = (tokenIds: readonly number[]): number[] =>
  Array.from(new Set(tokenIds.filter(tokenId => Number.isFinite(tokenId) && tokenId > 0).map(tokenId => Math.floor(tokenId))))
    .sort((a, b) => a - b);

const tokenIdsForHubJurisdiction = (
  hub: Pick<HubBootstrapEntry, 'jurisdictionName' | 'chainId'>,
): number[] => {
  const jurisdictionTokenIds = normalizePositiveTokenIds(getTokenIdsForJurisdiction({
    name: hub.jurisdictionName,
    chainId: hub.chainId ?? null,
  }));
  return jurisdictionTokenIds.length >= HUB_REQUIRED_TOKEN_COUNT
    ? jurisdictionTokenIds
    : [...DEFAULT_ACCOUNT_TOKEN_IDS];
};

const tokenCatalogForHubJurisdiction = (
  tokenCatalog: JTokenInfo[],
  hub: Pick<HubBootstrapEntry, 'jurisdictionName' | 'chainId'>,
): JTokenInfo[] => {
  const desiredTokenIds = new Set(tokenIdsForHubJurisdiction(hub));
  const selected = tokenCatalog.filter((token) => desiredTokenIds.has(Number(token.tokenId)));
  return selected.length >= HUB_REQUIRED_TOKEN_COUNT ? selected : tokenCatalog.slice(0, HUB_REQUIRED_TOKEN_COUNT);
};

const resolveLocalApiUrl = (value: string): string => {
  const raw = String(value || '').trim();
  if (!raw.startsWith('/')) return raw;
  const match = raw.match(/^\/(?:api\/)?rpc([2-8])?(?:\?.*)?$/);
  if (match) {
    const index = match[1] ? Number(match[1]) : 1;
    const rpc = String(resolvedArgs.rpcUrls[index] || '').trim();
    if (rpc) return rpc;
  }
  return new URL(raw, apiUrl).toString();
};
const directWsUrl = String(resolvedArgs.directWsUrl || '').trim();
if (!directWsUrl) {
  throw new Error(`[MESH-HUB] Missing required --direct-ws-url for ${resolvedArgs.name}`);
}
const AUTO_PROVISION_EXTERNAL_FAUCET = process.env['XLN_AUTO_PROVISION_EXTERNAL_FAUCET'] !== '0';
const MESH_BOOTSTRAP_STALL_TIMEOUT_MS = Math.max(
  5_000,
  Math.floor(Number(process.env['XLN_MESH_BOOTSTRAP_STALL_TIMEOUT_MS'] || '30000')),
);
const nodeLog = createStructuredLogger('mesh.hub', { hub: resolvedArgs.name });
let jurisdictionImportDiagnostics: JurisdictionImportDiagnostics | null = null;
const HUB_RUNTIME_TICK_DELAY_MS = Math.max(
  0,
  Number(process.env['HUB_RUNTIME_TICK_DELAY_MS'] || process.env['XLN_RUNTIME_TICK_DELAY_MS'] || '0'),
);
const HUB_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME = Math.max(
  0,
  Number(process.env['HUB_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME'] || process.env['XLN_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME'] || '0'),
);
const HUB_MAX_ENTITY_TXS_PER_RUNTIME_FRAME = Math.max(
  0,
  Number(process.env['HUB_MAX_ENTITY_TXS_PER_RUNTIME_FRAME'] || process.env['XLN_MAX_ENTITY_TXS_PER_RUNTIME_FRAME'] || '0'),
);

const LOG_HUB_ADMIN_URL = readBooleanEnv('XLN_HUB_ADMIN_URL_LOG', false);

const buildLocalHubSignerLabels = (): string[] => {
  const primary = resolveMeshJurisdictionConfig(resolvedArgs.rpcUrl);
  const labels = [resolvedArgs.signerLabel];
  for (const [index, secondary] of resolveSecondaryJurisdictions(primary.rpc).entries()) {
    const secondaryName = String(secondary.name || `Secondary ${index + 1}`).trim();
    if (secondaryName) labels.push(`${resolvedArgs.signerLabel}:${secondaryName}`);
  }
  return labels;
};

const configureHubRuntimeLogging = (env: RuntimeReplica): void => {
  if (readBooleanEnv('XLN_HUB_VERBOSE_RUNTIME_LOGS', false)) return;
  env.quietRuntimeLogs = true;
};

const resolveOperatorAppUrl = (): string => {
  const explicit = String(process.env['XLN_OPERATOR_APP_URL'] || process.env['XLN_APP_URL'] || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '').endsWith('/app')
    ? explicit.replace(/\/+$/, '')
    : `${explicit.replace(/\/+$/, '')}/app`;
  const parsed = new URL(directWsUrl);
  if (parsed.hostname === 'xln.finance' || parsed.hostname.endsWith('.xln.finance')) {
    return `https://${parsed.hostname}/app`;
  }
  return 'http://localhost:8080/app';
};

const buildRuntimeAdminUrl = (env: RuntimeReplica): string | null => {
  const seed = resolveRuntimeAdapterAuthSeed(env);
  if (!seed) return null;
  const runtimeAdapterUrl = new URL(directWsUrl);
  runtimeAdapterUrl.port = String(resolvedArgs.apiPort);
  runtimeAdapterUrl.pathname = '/rpc';
  runtimeAdapterUrl.search = '';
  runtimeAdapterUrl.hash = '';
  const token = deriveRuntimeAdapterCapabilityToken(seed, 'full', Date.now() + 60 * 60 * 1_000, {
    audience: resolveRuntimeAdapterAuthAudience(env),
    keyId: String(resolvedArgs.name || 'hub').toLowerCase(),
    tokenId: `admin-${String(env.runtimeId || resolvedArgs.name || 'hub').toLowerCase()}-${Date.now()}`,
  });
  const url = new URL(resolveOperatorAppUrl());
  url.searchParams.set('runtime', 'remote');
  url.searchParams.set('ws', runtimeAdapterUrl.toString());
  url.searchParams.set('token', token);
  return url.toString();
};

const timings: TimingMap = {
  runtime_boot: { startedAt: null, completedAt: null, ms: null },
  import_j: { startedAt: null, completedAt: null, ms: null },
  hub_bootstrap: { startedAt: null, completedAt: null, ms: null },
  orderbook_init: { startedAt: null, completedAt: null, ms: null },
  reserve_funding: { startedAt: null, completedAt: null, ms: null },
  p2p_connect: { startedAt: null, completedAt: null, ms: null },
  gossip_ready: { startedAt: null, completedAt: null, ms: null },
  mesh_accounts: { startedAt: null, completedAt: null, ms: null },
  mesh_credit: { startedAt: null, completedAt: null, ms: null },
  mesh_ready_total: { startedAt: null, completedAt: null, ms: null },
};

const startTiming = (stage: keyof typeof timings): number => {
  const now = Date.now();
  const timing = timings[stage];
  if (!timing) throw new Error(`UNKNOWN_TIMING_STAGE: ${String(stage)}`);
  if (timing.startedAt === null) timing.startedAt = now;
  return now;
};

const finishTiming = (stage: keyof typeof timings, startedAt: number): void => {
  const ms = Date.now() - startedAt;
  const timing = timings[stage];
  if (!timing) throw new Error(`UNKNOWN_TIMING_STAGE: ${String(stage)}`);
  timing.completedAt = Date.now();
  timing.ms = ms;
  nodeLog.info('timing', { stage, ms });
};

const startedAtFor = (stage: keyof typeof timings): number | null => {
  const timing = timings[stage];
  if (!timing) throw new Error(`UNKNOWN_TIMING_STAGE: ${String(stage)}`);
  return timing.startedAt;
};

const resolveJurisdictionConfig = (rpcUrlOverride: string): JurisdictionConfig =>
  resolveMeshJurisdictionConfig(rpcUrlOverride);

const prepareJurisdictionForImport = async (jurisdiction: JurisdictionConfig): Promise<JurisdictionConfig> => {
  jurisdictionImportDiagnostics = {
    name: jurisdiction.name,
    rpc: jurisdiction.rpc,
    chainId: jurisdiction.chainId,
    deployTokens: resolvedArgs.deployTokens,
    inputContracts: Boolean(jurisdiction.contracts),
    usedContracts: Boolean(jurisdiction.contracts),
    probeRan: false,
    missingCode: [],
    mode: jurisdiction.contracts ? 'connect-existing' : 'no-contracts',
  };
  if (!resolvedArgs.deployTokens || !jurisdiction.contracts) return jurisdiction;

  const missingCode = await findMissingRpcContractCode(jurisdiction.rpc, jurisdiction.contracts);
  jurisdictionImportDiagnostics.probeRan = true;
  jurisdictionImportDiagnostics.missingCode = missingCode;
  if (missingCode.length === 0) return jurisdiction;

  // RPC import is connect-only: the control plane must provision a real stack
  // and publish its exact addresses before this runtime starts.
  jurisdictionImportDiagnostics.mode = 'missing-contract-code';
  nodeLog.error('jurisdiction_contracts.code_missing', {
    jurisdictionName: jurisdiction.name,
    chainId: jurisdiction.chainId,
    missingCode,
  });
  throw new Error(`JURISDICTION_RPC_CONTRACT_CODE_MISSING:${missingCode.join(',')}`);
};

const resolveJurisdictionPaths = (): string[] => {
  return [resolveJurisdictionsJsonPath()];
};

const readCurrentJurisdictionsFile = (): JurisdictionsFile | null => {
  for (const filePath of resolveJurisdictionPaths()) {
    try {
      const parsed = readJurisdictionsFile<JurisdictionsFile>(filePath);
      if (parsed) return parsed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      nodeLog.error('jurisdictions_file.invalid', { path: filePath, error: message });
      throw error;
    }
  }
  return null;
};

const readCurrentJurisdictionsVersion = (): string => {
  const parsed = readCurrentJurisdictionsFile();
  return String(parsed?.version || '').trim() || '1';
};

const readCurrentNetworkVersion = (): string => {
  const parsed = readCurrentJurisdictionsFile();
  const explicit = String(parsed?.deployVersion || parsed?.networkVersion || '').trim();
  if (explicit) return explicit;
  const lastUpdated = Date.parse(String(parsed?.lastUpdated || ''));
  if (Number.isFinite(lastUpdated)) return String(lastUpdated);
  return readCurrentJurisdictionsVersion();
};

const writeJurisdictionAddresses = async (jadapter: JAdapter, rpcUrl: string): Promise<void> => {
  if (
    !jadapter.addresses?.account ||
    !jadapter.addresses?.depository ||
    !jadapter.addresses?.entityProvider ||
    !jadapter.addresses?.deltaTransformer
  ) {
    throw new Error('JURISDICTION_WRITE_ADDRESSES_MISSING');
  }
  const publicRpcUrl = toPublicRpcUrl(rpcUrl);
  const updatedAt = new Date().toISOString();
  const networkVersion = String(Date.parse(updatedAt));
  for (const filePath of resolveJurisdictionPaths()) {
    const parent = dirname(filePath);
    mkdirSync(parent, { recursive: true });
    const current: JurisdictionsFile = existsSync(filePath)
      ? JSON.parse(readFileSync(filePath, 'utf8'))
      : {};
    const jurisdictions = current.jurisdictions ?? {};
    const targetKey = selectWritableJurisdictionKey(jurisdictions, undefined, [rpcUrl, publicRpcUrl]);
    const previous = jurisdictions[targetKey] ?? {};
    const displayName = normalizeJurisdictionDisplayName(previous.name) || targetKey;
    jurisdictions[targetKey] = {
      ...previous,
      name: displayName,
      primary: previous.primary ?? true,
      chainId: Number(jadapter.chainId || 31337),
      rpc: publicRpcUrl,
      explorer: previous.explorer ?? '',
      currency: previous.currency ?? 'USD',
      status: previous.status ?? 'active',
      contracts: {
        ...(previous.contracts ?? {}),
        account: jadapter.addresses.account,
        depository: jadapter.addresses.depository,
        entityProvider: jadapter.addresses.entityProvider,
        deltaTransformer: jadapter.addresses.deltaTransformer,
      },
    };
    const nextPayload: JurisdictionsFile = {
      version: String(current.version || '').trim() || readCurrentJurisdictionsVersion(),
      deployVersion: networkVersion,
      networkVersion,
      lastUpdated: updatedAt,
      jurisdictions,
      defaults: current.defaults ?? {
        timeout: 30000,
        retryAttempts: 3,
        gasLimit: 1000000,
      },
    };
    writeFileSync(filePath, JSON.stringify(nextPayload, null, 2) + '\n', 'utf8');
  }
  resetMeshJurisdictionsCache();
};

const syncEnvJurisdictionReplica = (env: RuntimeReplica, jadapter: JAdapter, rpcUrl: string): void => {
  const activeName = env.activeJurisdiction || Array.from(env.state.jReplicas?.keys?.() || [])[0];
  if (!activeName) return;
  const replica = env.state.jReplicas?.get(activeName);
  if (!replica) return;
  replica.depositoryAddress = jadapter.addresses.depository;
  replica.entityProviderAddress = jadapter.addresses.entityProvider;
  replica.contracts = {
    ...(replica.contracts ?? {}),
    account: jadapter.addresses.account,
    depository: jadapter.addresses.depository,
    entityProvider: jadapter.addresses.entityProvider,
    deltaTransformer: jadapter.addresses.deltaTransformer,
  };
  replica.rpcs = [rpcUrl];
  replica.chainId = Number(jadapter.chainId || 31337);
  replica.jadapter = jadapter;
};

const buildRuntimeJurisdictionsPayload = (env: RuntimeReplica): string | null => {
  const activeName = env.activeJurisdiction || Array.from(env.state.jReplicas?.keys?.() || [])[0];
  if (!activeName) return null;
  const replica = env.state.jReplicas?.get(activeName) as
    | {
        name?: string;
        chainId?: number;
        rpcs?: string[];
        depositoryAddress?: string;
        entityProviderAddress?: string;
        contracts?: {
          account?: string;
          depository?: string;
          entityProvider?: string;
          deltaTransformer?: string;
        };
        jadapter?: {
          addresses?: {
            account?: string;
            depository?: string;
            entityProvider?: string;
            deltaTransformer?: string;
          };
        };
      }
    | undefined;
  if (!replica) return null;

  const addresses = replica.jadapter?.addresses ?? {};
  const account = String(addresses.account || replica.contracts?.account || '').trim();
  const depository =
    String(addresses.depository || replica.depositoryAddress || replica.contracts?.depository || '').trim();
  const entityProvider =
    String(addresses.entityProvider || replica.entityProviderAddress || replica.contracts?.entityProvider || '').trim();
  const deltaTransformer = String(addresses.deltaTransformer || replica.contracts?.deltaTransformer || '').trim();
  if (!account || !depository || !entityProvider || !deltaTransformer) return null;

  const version = readCurrentJurisdictionsVersion();
  const networkVersion = readCurrentNetworkVersion();
  const displayName =
    normalizeJurisdictionDisplayName(replica.name || activeName) ||
    normalizeJurisdictionDisplayName(activeName) ||
    'primary';
  const jurisdictionKey = normalizeJurisdictionKey(activeName || displayName);
  return JSON.stringify({
    version,
    deployVersion: networkVersion,
    networkVersion,
    lastUpdated: new Date().toISOString(),
    jurisdictions: {
      [jurisdictionKey]: {
        name: displayName,
        primary: true,
        status: 'active',
        chainId: Number(replica.chainId || 31337),
        rpc: toPublicRpcUrl(String(replica.rpcs?.[0] || resolvedArgs.rpcUrl || '/rpc')),
        contracts: {
          account,
          depository,
          entityProvider,
          deltaTransformer,
        },
      },
    },
  });
};

const ensureRpcStackReady = async (env: RuntimeReplica, jadapter: JAdapter): Promise<void> => {
  if (jadapter.mode === 'browservm') return;
  const hasAddresses = Boolean(
    jadapter.addresses?.account &&
    jadapter.addresses?.depository &&
    jadapter.addresses?.entityProvider &&
    jadapter.addresses?.deltaTransformer,
  );
  if (hasAddresses) {
    if (jurisdictionImportDiagnostics) {
      jurisdictionImportDiagnostics.usedContracts = true;
      if (jurisdictionImportDiagnostics.mode === 'no-contracts') {
        jurisdictionImportDiagnostics.mode = 'connect-existing';
      }
    }
    syncEnvJurisdictionReplica(env, jadapter, resolvedArgs.rpcUrl);
    if (resolvedArgs.deployTokens) {
      await writeJurisdictionAddresses(jadapter, resolvedArgs.rpcUrl);
    }
    return;
  }
  throw new Error('RPC_STACK_ADDRESSES_MISSING');
};

const ensureTokenCatalog = async (jadapter: JAdapter, allowDeploy: boolean, jurisdictionName = ''): Promise<JTokenInfo[]> => {
  const current = await jadapter.getTokenRegistry();
  const desiredTokens = defaultTokensForJurisdiction({
    name: jurisdictionName,
    chainId: Number((jadapter as { chainId?: number }).chainId),
  });
  const existingSymbols = new Set(
    current
      .map(token => String(token.symbol || '').trim().toUpperCase())
      .filter(Boolean),
  );
  const hasDesiredTokens = desiredTokens.every(token => existingSymbols.has(token.symbol.trim().toUpperCase()));
  if (current.length >= HUB_REQUIRED_TOKEN_COUNT && hasDesiredTokens) return current;
  if (allowDeploy) {
    await deployMissingDefaultTokens(jadapter, jurisdictionName);
    return await waitForTokenCatalog(jadapter);
  }
  throw new Error(`TOKEN_CATALOG_INCOMPLETE required=${HUB_REQUIRED_TOKEN_COUNT} actual=${current.length}`);
};

const waitForTokenCatalog = async (jadapter: JAdapter, rounds = 80): Promise<JTokenInfo[]> => {
  let lastReadError: unknown = null;
  for (let i = 0; i < rounds; i += 1) {
    try {
      const tokens = await jadapter.getTokenRegistry();
      if (tokens.length >= HUB_REQUIRED_TOKEN_COUNT) return tokens;
      lastReadError = null;
    } catch (error) {
      lastReadError = error;
    }
    await sleep(250);
  }
  if (lastReadError) {
    const message = lastReadError instanceof Error ? lastReadError.message : String(lastReadError);
    throw new Error(`TOKEN_CATALOG_READ_FAILED:${message}`, { cause: lastReadError });
  }
  throw new Error(`TOKEN_CATALOG_INCOMPLETE required=${HUB_REQUIRED_TOKEN_COUNT}`);
};

const ensureOrderbook = async (env: RuntimeReplica, entityId: string, signerId: string): Promise<void> => {
  const replica = getEntityReplicaById(env, entityId);
  if (replica?.state?.orderbookExt) return;

  const startedAt = startTiming('orderbook_init');
  enqueueRuntimeInput(env, {
    runtimeTxs: [],
    entityInputs: [
      {
        entityId,
        signerId,
        entityTxs: [
          {
            type: 'initOrderbookExt',
            data: {
              name: resolvedArgs.name,
              spreadDistribution: DEFAULT_SPREAD_DISTRIBUTION,
              referenceTokenId: 1,
              minTradeSize: HUB_DEFAULT_MIN_TRADE_SIZE,
              supportedPairs: [...HUB_DEFAULT_SUPPORTED_PAIRS],
            },
          },
        ],
      },
    ],
  });
  await settleRuntimeFor(env, 45);
  finishTiming('orderbook_init', startedAt);
};

type ImportedJurisdictionContracts = {
  chainId?: number;
  depositoryAddress?: string;
  entityProviderAddress?: string;
};

const getImportedJurisdictionContracts = (
  env: RuntimeReplica,
  jurisdictionName: string,
  fallback?: JurisdictionConfig['contracts'],
): ImportedJurisdictionContracts => {
  const replica = env.state.jReplicas?.get(jurisdictionName);
  const depositoryAddress = String(
    replica?.jadapter?.addresses?.depository ||
      replica?.depositoryAddress ||
      replica?.contracts?.depository ||
      fallback?.depository ||
      '',
  ).trim();
  const entityProviderAddress = String(
    replica?.jadapter?.addresses?.entityProvider ||
      replica?.entityProviderAddress ||
      replica?.contracts?.entityProvider ||
      fallback?.entityProvider ||
      '',
  ).trim();
  const chainId = Number(replica?.chainId ?? replica?.jadapter?.chainId);
  return {
    ...(Number.isFinite(chainId) && chainId > 0
      ? { chainId: Math.floor(chainId) }
      : {}),
    ...(depositoryAddress ? { depositoryAddress } : {}),
    ...(entityProviderAddress ? { entityProviderAddress } : {}),
  };
};

const importJurisdiction = async (
  env: RuntimeReplica,
  jurisdiction: JurisdictionConfig,
): Promise<void> => {
  enqueueRuntimeInput(env, {
    runtimeTxs: [{
      type: 'importJ',
      data: {
        name: jurisdiction.name,
        chainId: jurisdiction.chainId,
        ticker: 'XLN',
        rpcs: [jurisdiction.rpc],
        entityProviderDeploymentBlock:
          jurisdiction.entityProviderDeploymentBlock,
        blockTimeMs: requireJurisdictionBlockTimeMs(jurisdiction),
        ...(jurisdiction.contracts
          ? { contracts: jurisdiction.contracts }
          : {}),
      },
    }],
    entityInputs: [],
  });
  await processRuntime(env);
  await processRuntime(env);
};

type HubBootstrapPosition = NonNullable<
  NonNullable<Parameters<typeof bootstrapHub>[1]>['position']
>;

const bootstrapHubEntity = async (
  env: RuntimeReplica,
  input: {
    signerId: string;
    rpcUrl: string;
    failureCode: string;
    jurisdictionName?: string;
    position?: HubBootstrapPosition;
  },
): Promise<NonNullable<Awaited<ReturnType<typeof bootstrapHub>>>> => {
  const result = await bootstrapHub(env, {
    name: resolvedArgs.name,
    region: resolvedArgs.region,
    signerId: input.signerId,
    seed: resolvedArgs.seed,
    routingFeePPM: 1,
    baseFee: 0n,
    swapTakerFeeBps: 1,
    disputeAutoFinalizeMode:
      resolvedArgs.name.toLowerCase() === 'h2' ? 'ignore' : 'auto',
    rebalanceLiquidityFeeBps: 1n,
    rebalanceTimeoutMs: 10 * 60 * 1000,
    relayUrl: resolvedArgs.relayUrl,
    rpcUrl: input.rpcUrl,
    httpUrl: apiUrl,
    port: resolvedArgs.apiPort,
    ...(input.jurisdictionName
      ? { jurisdictionName: input.jurisdictionName }
      : {}),
    ...(input.position ? { position: input.position } : {}),
  });
  if (!result?.entityId) throw new Error(input.failureCode);
  return result;
};

const bootstrapHubJurisdictions = async (
  env: RuntimeReplica,
  primary: JurisdictionConfig,
): Promise<{
  primaryBootstrap: NonNullable<Awaited<ReturnType<typeof bootstrapHub>>>;
  entries: HubBootstrapEntry[];
}> => {
  const primaryBootstrap = await bootstrapHubEntity(env, {
    signerId: resolvedArgs.signerLabel,
    rpcUrl: primary.rpc,
    failureCode: 'HUB_BOOTSTRAP_FAILED',
  });
  const primaryContracts = getImportedJurisdictionContracts(
    env,
    primary.name,
    primary.contracts,
  );
  const entries: HubBootstrapEntry[] = [{
    entityId: primaryBootstrap.entityId,
    signerId: primaryBootstrap.signerId,
    name: resolvedArgs.name,
    jurisdictionName: primary.name,
    chainId: primaryContracts.chainId ?? primary.chainId,
    ...(primaryContracts.depositoryAddress
      ? { depositoryAddress: primaryContracts.depositoryAddress }
      : {}),
    ...(primaryContracts.entityProviderAddress
      ? { entityProviderAddress: primaryContracts.entityProviderAddress }
      : {}),
    primary: true,
  }];
  await ensureOrderbook(
    env,
    primaryBootstrap.entityId,
    primaryBootstrap.signerId,
  );

  for (const [index, configured] of resolveSecondaryJurisdictions(
    primary.rpc,
  ).entries()) {
    const name = String(
      configured.name || `Secondary ${index + 1}`,
    ).trim();
    if (!name) continue;
    const jurisdiction = {
      ...configured,
      name,
      rpc: resolveLocalApiUrl(configured.rpc),
    };
    if (!hasLiveJAdapterForJurisdiction(env, name)) {
      nodeLog.debug('sibling_jurisdiction.importing', {
        jurisdiction: name,
        rpc: configured.rpc,
      });
      await importJurisdiction(env, jurisdiction);
    } else {
      nodeLog.debug('sibling_jurisdiction.reusing', { jurisdiction: name });
    }
    const previous = env.activeJurisdiction;
    env.activeJurisdiction = name;
    const sibling = await bootstrapHubEntity(env, {
      signerId: `${resolvedArgs.signerLabel}:${name}`,
      rpcUrl: jurisdiction.rpc,
      jurisdictionName: name,
      failureCode: `HUB_SIBLING_BOOTSTRAP_FAILED:${name}`,
      position: {
        x: 160 + index * 80,
        y: 0,
        z: 120,
        jurisdiction: name,
      },
    });
    env.activeJurisdiction = previous || primary.name;
    const contracts = getImportedJurisdictionContracts(
      env,
      name,
      jurisdiction.contracts,
    );
    entries.push({
      entityId: sibling.entityId,
      signerId: sibling.signerId,
      name: resolvedArgs.name,
      jurisdictionName: name,
      chainId: contracts.chainId ?? jurisdiction.chainId,
      ...(contracts.depositoryAddress
        ? { depositoryAddress: contracts.depositoryAddress }
        : {}),
      ...(contracts.entityProviderAddress
        ? { entityProviderAddress: contracts.entityProviderAddress }
        : {}),
      primary: false,
    });
    await ensureOrderbook(env, sibling.entityId, sibling.signerId);
    nodeLog.debug('sibling_jurisdiction.ready', {
      jurisdiction: name,
      entityId: sibling.entityId,
    });
  }
  env.activeJurisdiction = primary.name;
  return { primaryBootstrap, entries };
};

const tokenCatalogsByEntityId = new Map<string, JTokenInfo[]>();

const normalizeEntityId = (entityId: string): string => String(entityId || '').trim().toLowerCase();

const requireJAdapterForEntity = (env: RuntimeReplica, entityId: string, purpose: string): JAdapter => {
  const adapter = getEntityJAdapter(env, entityId);
  if (!adapter) {
    throw new Error(`${purpose}_JADAPTER_MISSING: entity=${entityId}`);
  }
  return adapter;
};

const requireJAdapterForDebugReserve = (
  env: RuntimeReplica,
  entityId: string,
  jurisdictionRef: string,
): JAdapter => {
  const explicitJurisdiction = String(jurisdictionRef || '').trim();
  if (explicitJurisdiction) {
    if (!isJurisdictionStackRef(explicitJurisdiction)) {
      throw new Error(`DEBUG_RESERVE_JURISDICTION_REF_INVALID: entity=${entityId} jurisdiction=${explicitJurisdiction}`);
    }
    const jReplica = getJReplicaByJurisdictionRef(env, explicitJurisdiction);
    const adapter = jReplica?.jadapter;
    if (!adapter) {
      throw new Error(`DEBUG_RESERVE_JURISDICTION_UNAVAILABLE: entity=${entityId} jurisdiction=${explicitJurisdiction}`);
    }
    return adapter;
  }
  let entityAdapter: JAdapter | null = null;
  try {
    entityAdapter = getEntityJAdapter(env, entityId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith('ENTITY_JURISDICTION_MISSING')) throw error;
  }
  if (entityAdapter) return entityAdapter;
  const activeAdapter = getActiveJAdapter(env);
  if (!activeAdapter) {
    throw new Error(`DEBUG_RESERVE_JADAPTER_MISSING: entity=${entityId}`);
  }
  return activeAdapter;
};

const getReserveHealth = (env: RuntimeReplica, entityId: string, tokenCatalog: JTokenInfo[]): LocalHealthResponse['bootstrapReserves'] => {
  const replica = getEntityReplicaById(env, entityId);
  const tokens = tokenCatalogForHubJurisdiction(tokenCatalog, {
    jurisdictionName: getEntityJurisdictionName(env, entityId),
  }).map(token => {
    const tokenId = Number(token.tokenId);
    const decimals = Number(token.decimals);
    const current = replica?.state?.reserves?.get(tokenId) ?? 0n;
    const expectedMin = getBootstrapTokenAmount(tokenId, decimals);
    return {
      tokenId,
      symbol: String(token.symbol || `token-${tokenId}`),
      decimals,
      current: current.toString(),
      expectedMin: expectedMin.toString(),
      ready: current > 0n,
      operational: current > 0n,
      targetMet: current >= expectedMin,
    };
  });
  return {
    ok: tokens.length >= HUB_REQUIRED_TOKEN_COUNT && tokens.every(token => token.operational === true),
    targetMet: tokens.length >= HUB_REQUIRED_TOKEN_COUNT && tokens.every(token => token.targetMet === true),
    tokens,
  };
};

const refreshReserveStateFromWatcher = async (
  env: RuntimeReplica,
  entityId: string,
  tokenCatalog: JTokenInfo[],
): Promise<LocalHealthResponse['bootstrapReserves']> => {
  const jadapter = requireJAdapterForEntity(env, entityId, 'RESERVE_SYNC');
  const replica = getEntityReplicaById(env, entityId);
  if (!replica?.state) {
    throw new Error(`HUB_REPLICA_MISSING_FOR_RESERVE_SYNC: ${entityId}`);
  }
  if (jadapter.isWatching()) {
    await jadapter.pollNow?.();
    await settleRuntimeFor(env, 10);
  }
  return getReserveHealth(env, entityId, tokenCatalog);
};

const ensureBootstrapReserves = async (
  env: RuntimeReplica,
  entityId: string,
  tokenCatalog: JTokenInfo[],
  reportProgress: (step: string) => void,
): Promise<LocalHealthResponse['bootstrapReserves']> => {
  const startedAt = startTiming('reserve_funding');
  const jadapter = requireJAdapterForEntity(env, entityId, 'RESERVE_FUNDING');

  const bootstrapTokens = tokenCatalogForHubJurisdiction(tokenCatalog, {
    jurisdictionName: getEntityJurisdictionName(env, entityId),
  });
  reportProgress('watcher-refresh:start');
  await refreshReserveStateFromWatcher(env, entityId, tokenCatalog);
  reportProgress('watcher-refresh:done');
  if (!resolvedArgs.deployTokens) {
    const reserveHealth = getReserveHealth(env, entityId, tokenCatalog);
    finishTiming('reserve_funding', startedAt);
    return reserveHealth;
  }
  const replica = getEntityReplicaById(env, entityId);

  const mints: Array<{ entityId: string; tokenId: number; amount: bigint }> = [];
  const reserveMismatches: string[] = [];
  for (const token of bootstrapTokens) {
    const tokenId = Number(token.tokenId);
    const decimals = Number(token.decimals);
    const target = getBootstrapTokenAmount(tokenId, decimals);
    const localCurrent = replica?.state?.reserves?.get(tokenId) ?? 0n;
    reportProgress(`chain-reserve:${tokenId}:start`);
    const chainCurrent = await jadapter.getReserves(entityId, tokenId);
    reportProgress(`chain-reserve:${tokenId}:done`);
    if (chainCurrent !== localCurrent) {
      reserveMismatches.push(`token=${tokenId} local=${localCurrent.toString()} chain=${chainCurrent.toString()}`);
      continue;
    }
    if (localCurrent >= target) continue;
    mints.push({
      entityId,
      tokenId,
      amount: target - localCurrent,
    });
  }
  if (reserveMismatches.length > 0) {
    throw new Error(
      `HUB_RESERVE_STATE_MISMATCH: entity=${entityId} ${reserveMismatches.join('; ')}; ` +
      'runtime reserve state must be replayed from canonical J-events before bootstrap funding',
    );
  }

  if (mints.length > 0) {
    reportProgress('fund-batch:start');
    const events = await jadapter.debugFundReservesBatch(mints);
    reportProgress('fund-batch:done');
    await applyJEventsToEnv(env, events, `${resolvedArgs.name}-reserve-fund`, jadapter);
    reportProgress('fund-events:applied');
    await settleRuntimeFor(env, 30);
    reportProgress('fund-runtime:settled');
  }
  reportProgress('final-watcher-refresh:start');
  const reserveHealth = await refreshReserveStateFromWatcher(env, entityId, tokenCatalog);
  reportProgress('complete');

  finishTiming('reserve_funding', startedAt);
  return reserveHealth;
};

const ensurePeerBootstrapReserves = async (
  env: RuntimeReplica,
  peerProfiles: VisibleHubProfile[],
  tokenCatalog: JTokenInfo[],
  reportProgress: (step: string) => void,
): Promise<void> => {
  if (!resolvedArgs.deployTokens || peerProfiles.length === 0) return;
  const profilesByJurisdiction = new Map<string, { jurisdiction: VisibleHubProfile; profiles: VisibleHubProfile[] }>();
  for (const profile of peerProfiles) {
    const jurisdictionKey = String(profile.jurisdictionRef || '').trim();
    if (!jurisdictionKey) {
      throw new Error(`PEER_RESERVE_JURISDICTION_MISSING: entity=${profile.entityId}`);
    }
    const group = profilesByJurisdiction.get(jurisdictionKey) ?? { jurisdiction: profile, profiles: [] };
    group.profiles.push(profile);
    profilesByJurisdiction.set(jurisdictionKey, group);
  }

  const activeReplicaName = String(env.activeJurisdiction || '');
  const activeReplica = activeReplicaName ? env.state.jReplicas?.get(activeReplicaName) : undefined;
  const activeJurisdiction = activeReplica
    ? { ...activeReplica, name: activeReplica.name || activeReplicaName }
    : activeReplicaName;
  for (const [jurisdictionKey, group] of profilesByJurisdiction) {
    const { jurisdiction, profiles } = group;
    const jurisdictionName = String(jurisdiction.jurisdictionName || jurisdictionKey).trim();
    const resolvedReplica = resolveJReplicaForJurisdictionIdentity(env, jurisdiction.jurisdictionRef);
    const replicaName = resolvedReplica?.replica?.name || resolvedReplica?.name || jurisdictionName;
    const jadapter = resolvedReplica?.replica?.jadapter;
    if (!jadapter) {
      throw new Error(
        `PEER_RESERVE_JADAPTER_MISSING: jurisdiction=${jurisdictionKey} ` +
        `known=${Array.from(env.state.jReplicas?.keys?.() || []).join(',')}`,
      );
    }
    const catalog = sameJurisdictionRef(jurisdiction, activeJurisdiction)
      ? tokenCatalog
      : await ensureTokenCatalog(jadapter, true, replicaName);
    reportProgress(`catalog:${replicaName}:ready`);
    const bootstrapTokens = tokenCatalogForHubJurisdiction(catalog, { jurisdictionName });
    const mints: Array<{ entityId: string; tokenId: number; amount: bigint }> = [];
    for (const peer of profiles) {
      for (const token of bootstrapTokens) {
        const tokenId = Number(token.tokenId);
        const decimals = Number(token.decimals);
        const target = getBootstrapTokenAmount(tokenId, decimals);
        reportProgress(`chain-reserve:${replicaName}:${tokenId}:start`);
        const current = await jadapter.getReserves(peer.entityId, tokenId);
        reportProgress(`chain-reserve:${replicaName}:${tokenId}:done`);
        if (current >= target) continue;
        mints.push({
          entityId: peer.entityId,
          tokenId,
          amount: target - current,
        });
      }
    }
    if (mints.length === 0) continue;
    reportProgress(`fund-batch:${replicaName}:start`);
    const events = await jadapter.debugFundReservesBatch(mints);
    reportProgress(`fund-batch:${replicaName}:done`);
    await applyJEventsToEnv(env, events, `${resolvedArgs.name}-peer-reserve-fund-${replicaName}`, jadapter);
    reportProgress(`fund-events:${replicaName}:applied`);
    await settleRuntimeFor(env, 20);
    reportProgress(`runtime:${replicaName}:settled`);
  }
};

const getEntityJurisdictionName = (env: RuntimeReplica, entityId: string | null): string => {
  if (!entityId) return '';
  const replica = getEntityReplicaById(env, entityId);
  return normalizeJurisdictionDisplayName(replica?.state?.config?.jurisdiction?.name || '');
};

const getEntityJurisdiction = (env: RuntimeReplica, entityId: string | null): unknown | null => {
  if (!entityId) return null;
  const replica = getEntityReplicaById(env, entityId);
  return replica?.state?.config?.jurisdiction ?? null;
};

const resolveEntityTokenCatalog = async (
  env: RuntimeReplica,
  entityId: string,
): Promise<JTokenInfo[]> => {
  const normalizedEntityId = normalizeEntityId(entityId);
  const cached = tokenCatalogsByEntityId.get(normalizedEntityId);
  if (cached && cached.length >= HUB_REQUIRED_TOKEN_COUNT) return cached;

  const jadapter = requireJAdapterForEntity(env, entityId, 'TOKEN_CATALOG');
  const jurisdictionName = getEntityJurisdictionName(env, entityId);
  const catalog = resolvedArgs.deployTokens
    ? await ensureTokenCatalog(jadapter, true, jurisdictionName)
    : await waitForTokenCatalog(jadapter);
  if (catalog.length < HUB_REQUIRED_TOKEN_COUNT) {
    throw new Error(
      `TOKEN_CATALOG_INCOMPLETE_FOR_ENTITY: entity=${entityId} jurisdiction=${jurisdictionName || 'unknown'} ` +
        `count=${catalog.length} required=${HUB_REQUIRED_TOKEN_COUNT}`,
    );
  }
  tokenCatalogsByEntityId.set(normalizedEntityId, catalog);
  return catalog;
};

const buildAggregateReserveHealth = (
  primaryHealth: BootstrapReserveHealth | null,
  entities: BootstrapReserveEntityHealth[],
): BootstrapReserveHealth => ({
  ok: entities.length > 0 && entities.every(entity => entity.ready),
  targetMet: entities.length > 0 && entities.every(entity => entity.targetMet),
  tokens: primaryHealth?.tokens ?? entities[0]?.tokens ?? [],
  entities,
});

const buildHubBootstrapReserveHealth = (
  env: RuntimeReplica,
  primaryEntityId: string | null,
  fallbackCatalog: JTokenInfo[],
  hubEntities: HubBootstrapEntry[] = [],
): BootstrapReserveHealth => {
  const entries = hubEntities.length > 0
    ? hubEntities
    : primaryEntityId
      ? [{
          entityId: primaryEntityId,
          signerId: '',
          name: resolvedArgs.name,
          jurisdictionName: getEntityJurisdictionName(env, primaryEntityId),
          primary: true,
        }]
      : [];
  const entities = entries.map((entry) => {
    const catalog = tokenCatalogsByEntityId.get(normalizeEntityId(entry.entityId)) ?? fallbackCatalog;
    const health = getReserveHealth(env, entry.entityId, catalog);
    return {
      entityId: entry.entityId,
      jurisdictionName: entry.jurisdictionName,
      primary: entry.primary,
      ready: health.ok === true,
      targetMet: health.targetMet === true,
      tokens: health.tokens,
    };
  });
  const primary = entries.findIndex(entry => entry.primary);
  const primaryHealth = primary >= 0 && entities[primary]
    ? { ok: entities[primary]!.ready, targetMet: entities[primary]!.targetMet, tokens: entities[primary]!.tokens }
    : null;
  return buildAggregateReserveHealth(primaryHealth, entities);
};

const ensureHubBootstrapReserves = async (
  env: RuntimeReplica,
  hubEntities: HubBootstrapEntry[],
  reportProgress: (step: string) => void,
): Promise<BootstrapReserveHealth> => {
  const entities: BootstrapReserveEntityHealth[] = [];
  let primaryHealth: BootstrapReserveHealth | null = null;

  for (const entry of hubEntities) {
    reportProgress(`${entry.name}:catalog:start`);
    const catalog = await resolveEntityTokenCatalog(env, entry.entityId);
    reportProgress(`${entry.name}:catalog:done`);
    const health = await ensureBootstrapReserves(
      env,
      entry.entityId,
      catalog,
      (step) => reportProgress(`${entry.name}:${step}`),
    );
    const entityHealth: BootstrapReserveEntityHealth = {
      entityId: entry.entityId,
      jurisdictionName: entry.jurisdictionName,
      primary: entry.primary,
      ready: health.ok === true,
      targetMet: health.targetMet === true,
      tokens: health.tokens,
    };
    entities.push(entityHealth);
    if (entry.primary) primaryHealth = health;
  }

  return buildAggregateReserveHealth(primaryHealth, entities);
};

const readVisibleHubProfiles = (env: RuntimeReplica, jurisdiction: unknown): VisibleHubProfile[] => {
  const profiles = env.gossip?.getProfiles?.() || [];
  return profiles
    .filter(profile => profile.metadata?.isHub === true)
    .filter(profile => {
      const targetRef = getJurisdictionIdentityRef(jurisdiction);
      if (!targetRef) return true;
      return getJurisdictionIdentityRef(profile.metadata?.jurisdiction) === targetRef;
    })
    .map(profile => {
      const chainId = Number(profile.metadata?.jurisdiction?.chainId || 0);
      const depositoryAddress = String(profile.metadata?.jurisdiction?.depositoryAddress || '').trim();
      const jurisdictionRef = getJurisdictionIdentityRef(profile.metadata?.jurisdiction);
      return {
        name: String(profile.name || '').trim(),
        hubName: typeof profile.metadata?.hubName === 'string' ? profile.metadata.hubName.trim() : '',
        entityId: String(profile.entityId || '').toLowerCase(),
        runtimeId: normalizeRuntimeId(profile.runtimeId || ''),
        jurisdictionName: normalizeJurisdictionDisplayName(profile.metadata?.jurisdiction?.name || ''),
        ...(Number.isFinite(chainId) && chainId > 0 ? { chainId: Math.floor(chainId) } : {}),
        ...(depositoryAddress ? { depositoryAddress } : {}),
        jurisdictionRef,
      };
    })
    .filter(profile =>
      profile.name.length > 0 &&
      profile.entityId.length > 0 &&
      profile.runtimeId.length > 0 &&
      profile.jurisdictionName.length > 0 &&
      profile.jurisdictionRef.length > 0,
    );
};

const openDirectRuntimeIds = (env: RuntimeReplica): Set<string> => new Set(
  (getP2PState(env).directPeers || [])
    .filter(peer => peer.open === true)
    .map(peer => normalizeRuntimeId(peer.runtimeId || ''))
    .filter(runtimeId => runtimeId.length > 0),
);

const directRuntimePeersReady = (env: RuntimeReplica, peers: Array<{ runtimeId: string }>): boolean => {
  if (peers.length === 0) return true;
  const openRuntimeIds = openDirectRuntimeIds(env);
  return peers.every(peer => openRuntimeIds.has(peer.runtimeId));
};

const directHubPeersReady = (env: RuntimeReplica, peers: VisibleHubProfile[]): boolean => directRuntimePeersReady(env, peers);

const visibleDirectSupportPeers = (
  identities: SupportPeerIdentity[],
  profiles: ReturnType<NonNullable<RuntimeReplica['gossip']>['getProfiles']>,
  selfEntityId: string,
  jurisdiction: unknown,
): VisibleSupportPeer[] => {
  const profilesByEntityId = new Map(
    profiles.map(profile => [String(profile.entityId || '').toLowerCase(), profile] as const),
  );
  return identities
    .map((identity) => {
      const entityId = identity.entityId.toLowerCase();
      if (entityId === selfEntityId.toLowerCase()) return null;
      const profile = profilesByEntityId.get(entityId);
      if (!profile) return null;
      const runtimeId = normalizeRuntimeId(profile.runtimeId || '');
      if (!runtimeId) return null;
      const peerJurisdiction = profile.metadata?.jurisdiction || identity;
      if (!sameJurisdictionRef(peerJurisdiction, jurisdiction)) return null;
      return { ...identity, runtimeId };
    })
    .filter((peer): peer is VisibleSupportPeer => peer !== null);
};

type HubMeshInputPlan = {
  openInputs: EntityInput[];
  creditInputs: EntityInput[];
};

const planSupportPeerInputs = (
  env: RuntimeReplica,
  owner: Pick<
    HubBootstrapEntry,
    'entityId' | 'signerId' | 'jurisdictionName' | 'chainId' | 'depositoryAddress'
  >,
  supportPeerIdentities: SupportPeerIdentity[],
  visibleProfiles: ReturnType<
    NonNullable<RuntimeReplica['gossip']>['getProfiles']
  >,
): HubMeshInputPlan => {
  const openInputs: EntityInput[] = [];
  const creditInputs: EntityInput[] = [];
  const tokenIds = tokenIdsForHubJurisdiction(owner);
  const [openTokenId = HUB_MESH_TOKEN_ID, ...extraTokenIds] = tokenIds;
  const peers = visibleDirectSupportPeers(
    supportPeerIdentities,
    visibleProfiles,
    owner.entityId,
    owner,
  );
  for (const peer of peers) {
    const account = getAccountState(env, owner.entityId, peer.entityId);
    const canWrite =
      !account?.pendingFrame && Number(account?.mempool?.length || 0) === 0;
    if (
      isCanonicalAccountOpener(owner.entityId, peer.entityId) &&
      !hasAccount(env, owner.entityId, peer.entityId) &&
      canWrite
    ) {
      if (hasQueuedOpenAccount(env, owner.entityId, peer.entityId)) continue;
      openInputs.push({
        entityId: owner.entityId,
        signerId: owner.signerId,
        entityTxs: [
          {
            type: 'openAccount',
            data: {
              targetEntityId: peer.entityId,
              tokenId: openTokenId,
              creditAmount: getBootstrapCreditAmount(openTokenId),
            },
          },
          ...extraTokenIds.map(tokenId => ({
            type: 'extendCredit' as const,
            data: {
              counterpartyEntityId: peer.entityId,
              tokenId,
              amount: getBootstrapCreditAmount(tokenId),
            },
          })),
        ],
      });
      continue;
    }
    if (!account || !canWrite) continue;
    const missingTokenIds = tokenIds.filter(
      tokenId =>
        getCreditGrantedByEntity(account, owner.entityId, tokenId) <
        getBootstrapCreditAmount(tokenId),
    );
    if (missingTokenIds.length === 0) continue;
    creditInputs.push({
      entityId: owner.entityId,
      signerId: owner.signerId,
      entityTxs: missingTokenIds.map(tokenId => ({
        type: 'extendCredit' as const,
        data: {
          counterpartyEntityId: peer.entityId,
          tokenId,
          amount: getBootstrapCreditAmount(tokenId),
        },
      })),
    });
  }
  return { openInputs, creditInputs };
};

const planHubPeerInputs = (
  env: RuntimeReplica,
  bootstrap: Pick<HubBootstrapEntry, 'entityId' | 'signerId'>,
  peers: VisibleHubProfile[],
): HubMeshInputPlan => {
  const openInputs: EntityInput[] = [];
  const creditInputs: EntityInput[] = [];
  for (const peer of peers) {
    const account = getAccountState(env, bootstrap.entityId, peer.entityId);
    const canWrite =
      !account?.pendingFrame && Number(account?.mempool?.length || 0) === 0;
    if (
      isCanonicalAccountOpener(bootstrap.entityId, peer.entityId) &&
      !hasAccount(env, bootstrap.entityId, peer.entityId) &&
      !hasQueuedOpenAccount(env, bootstrap.entityId, peer.entityId) &&
      canWrite
    ) {
      openInputs.push({
        entityId: bootstrap.entityId,
        signerId: bootstrap.signerId,
        entityTxs: [
          {
            type: 'openAccount',
            data: {
              targetEntityId: peer.entityId,
              tokenId: HUB_MESH_TOKEN_ID,
              creditAmount: getBootstrapCreditAmount(HUB_MESH_TOKEN_ID),
            },
          },
          ...DEFAULT_ACCOUNT_TOKEN_IDS.slice(1).map(tokenId => ({
            type: 'extendCredit' as const,
            data: {
              counterpartyEntityId: peer.entityId,
              tokenId,
              amount: getBootstrapCreditAmount(tokenId),
            },
          })),
        ],
      });
    }
    if (!account || !canWrite) continue;
    const missingTokenIds = DEFAULT_ACCOUNT_TOKEN_IDS.filter(
      tokenId =>
        getCreditGrantedByEntity(account, bootstrap.entityId, tokenId) <
        getBootstrapCreditAmount(tokenId),
    );
    if (missingTokenIds.length === 0) continue;
    creditInputs.push({
      entityId: bootstrap.entityId,
      signerId: bootstrap.signerId,
      entityTxs: missingTokenIds.map(tokenId => ({
        type: 'extendCredit' as const,
        data: {
          counterpartyEntityId: peer.entityId,
          tokenId,
          amount: getBootstrapCreditAmount(tokenId),
        },
      })),
    });
  }
  return { openInputs, creditInputs };
};

const planMeshBootstrapInputs = (
  env: RuntimeReplica,
  bootstrap: Pick<HubBootstrapEntry, 'entityId' | 'signerId'>,
  hubBootstraps: HubBootstrapEntry[],
  peers: VisibleHubProfile[],
  supportPeerIdentities: SupportPeerIdentity[],
): HubMeshInputPlan => {
  const visibleProfiles = env.gossip?.getProfiles?.() || [];
  const plans = [
    planHubPeerInputs(env, bootstrap, peers),
    ...hubBootstraps.map(owner =>
      planSupportPeerInputs(
        env,
        owner,
        supportPeerIdentities,
        visibleProfiles,
      ),
    ),
  ];
  return {
    openInputs: plans.flatMap(plan => plan.openInputs),
    creditInputs: plans.flatMap(plan => plan.creditInputs),
  };
};

const buildPairHealth = (env: RuntimeReplica, selfEntityId: string, peers: Array<{ name: string; entityId: string }>): HubPairHealth[] => {
  return peers.map(peer => {
    const account = getAccountState(env, selfEntityId, peer.entityId);
    const grantedByMe = account ? getCreditGrantedByEntity(account, selfEntityId, HUB_MESH_TOKEN_ID) : 0n;
    const grantedByPeer = account ? getCreditGrantedByEntity(account, peer.entityId, HUB_MESH_TOKEN_ID) : 0n;
    return {
      counterpartyId: peer.entityId,
      counterpartyName: peer.name,
      hasAccount: hasAccount(env, selfEntityId, peer.entityId),
      currentHeight: Number(account?.currentHeight ?? 0),
      pendingFrameHeight: account?.pendingFrame ? Number(account.pendingFrame.height) : null,
      pendingFrameHash: account?.pendingFrame?.stateHash ?? null,
      grantedByMe: grantedByMe.toString(),
      grantedByPeer: grantedByPeer.toString(),
      ready: hasPairMutualCredits(env, selfEntityId, peer.entityId, DEFAULT_ACCOUNT_TOKEN_IDS, getBootstrapCreditAmount),
    };
  });
};

const buildLocalHealth = (
  env: RuntimeReplica,
  entityId: string | null,
  tokenCatalog: JTokenInfo[],
  jadapter: JAdapter | null,
  hubEntities: HubBootstrapEntry[],
  bootstrapProgress: BootstrapProgressHealth,
): LocalHealthResponse => {
  const runtimeHalted = env.runtimeState?.halted === true;
  const selfJurisdictionName = getEntityJurisdictionName(env, entityId);
  const selfJurisdiction = getEntityJurisdiction(env, entityId) || selfJurisdictionName;
  const visibleHubProfiles = readVisibleHubProfiles(env, selfJurisdiction);
  const visibleNames = visibleHubProfiles.map(profile => profile.name);
  const visibleIds = visibleHubProfiles.map(profile => profile.entityId);
  const requiredNames = resolvedArgs.meshHubNames;
  const peers = entityId
    ? visibleHubProfiles.filter(profile => profile.entityId !== entityId.toLowerCase())
    : [];
  const pairs = entityId ? buildPairHealth(env, entityId, peers) : [];

  return {
    ok: !runtimeHalted && Boolean(entityId) && pairs.length === Math.max(0, requiredNames.length - 1) && pairs.every(pair => pair.ready),
    name: resolvedArgs.name,
    height: Math.max(0, Math.floor(Number(env.state.height || 0))),
    entityId,
    runtimeId: String(env.runtimeId || '') || null,
    relayUrl: resolvedArgs.relayUrl,
    directWsUrl,
    apiUrl,
    runtime: {
      halted: runtimeHalted,
      lifecyclePhase: env.runtimeState?.lifecyclePhase ?? null,
      fatalDebugPayload: env.runtimeState?.fatalDebugPayload ?? null,
    },
    quiescence: summarizeRuntimeQuiescence(env),
    p2p: {
      directPeers: getP2PState(env).directPeers || [],
    },
    gossip: {
      visibleHubNames: visibleNames,
      visibleHubIds: visibleIds,
      ready: requiredNames.every(name => visibleNames.includes(name)),
    },
    mesh: {
      ready: Boolean(entityId) && pairs.length === Math.max(0, requiredNames.length - 1) && pairs.every(pair => pair.ready),
      pairs,
    },
    bootstrapProgress,
    bootstrapReserves: buildHubBootstrapReserveHealth(env, entityId, tokenCatalog, hubEntities),
    jurisdiction: jurisdictionImportDiagnostics,
    jadapter: {
      ready: Boolean(jadapter?.addresses?.depository && jadapter?.addresses?.entityProvider),
      mode: jadapter?.mode ?? null,
      contracts: jadapter?.addresses ?? null,
      tokenCatalogCount: tokenCatalog.length,
    },
    timings,
  };
};

const summarizeRecentRuntimeInputs = (
  inputs:
    | Array<{
        entityId?: string;
        entityTxs?: Array<{ type?: string }>;
      }>
    | undefined,
): Array<{ entityId: string; txs: string[] }> =>
  (inputs || []).slice(-10).map(input => ({
    entityId: String(input.entityId || '').slice(-8),
    txs: (input.entityTxs || []).map(tx => String(tx?.type || '')),
  }));

const handleAccountStatusRequest = (
  env: RuntimeReplica,
  request: Request,
  url: URL,
  defaultHubEntityId: string | null,
  directInput: {
    lastSeen: DirectEntityInputDebug | null;
    lastError: DirectEntityInputDebug | null;
  },
): Response | null => {
  if (
    url.pathname !== '/api/account/status' ||
    request.method !== 'GET'
  ) {
    return null;
  }
  const hubEntityId = String(
    url.searchParams.get('hubEntityId') || defaultHubEntityId || '',
  ).toLowerCase();
  const counterpartyEntityId = String(
    url.searchParams.get('counterpartyEntityId') || '',
  ).toLowerCase();
  if (!hubEntityId || !counterpartyEntityId) {
    return new Response(
      safeStringify({
        success: false,
        code: 'ACCOUNT_STATUS_BAD_REQUEST',
        error: 'hubEntityId and counterpartyEntityId are required',
      }),
      { status: 400, headers: JSON_HEADERS },
    );
  }
  const account = getAccountState(env, hubEntityId, counterpartyEntityId);
  const replica = getEntityReplicaById(env, hubEntityId);
  const tokenIds = String(url.searchParams.get('tokenIds') || '')
    .split(',')
    .map(value => Number(value.trim()))
    .filter(value => Number.isInteger(value) && value > 0);
  return new Response(
    safeStringify({
      success: true,
      hubEntityId,
      counterpartyEntityId,
      hasAccount:
        hasAccount(env, hubEntityId, counterpartyEntityId) || Boolean(account),
      ready: Boolean(
        account?.currentFrame &&
          Number(account.currentHeight ?? 0) > 0 &&
          !account.pendingFrame &&
          Number(account.mempool?.length ?? 0) === 0,
      ),
      currentHeight: Number(account?.currentHeight ?? 0),
      pendingFrameHeight: account?.pendingFrame
        ? Number(account.pendingFrame.height ?? 0)
        : null,
      mempool: Number(account?.mempool?.length ?? 0),
      tokens: tokenIds.map(tokenId => ({
        tokenId,
        hasDelta: Boolean(account?.deltas?.has(tokenId)),
        hubOutCapacity: account
          ? getEntityOutCapacity(account, hubEntityId, tokenId).toString()
          : '0',
        delta: serializeAccountDelta(account?.deltas?.get(tokenId)),
      })),
      runtime: {
        height: Number(env.state.height ?? 0),
        timestamp: Number(env.state.timestamp ?? 0),
        halted: Boolean(env.runtimeState?.halted),
        fatalDebugPayload: env.runtimeState?.fatalDebugPayload ?? null,
        loopActive: Boolean(env.runtimeState?.loopActive),
        runtimeMempool: summarizeRecentRuntimeInputs(
          env.runtimeMempool?.entityInputs,
        ),
      },
      replica: replica
        ? {
            key: `${String(replica.entityId || '').toLowerCase()}:${String(
              replica.signerId || '',
            ).toLowerCase()}`,
            entityId: replica.entityId,
            signerId: replica.signerId,
            mempool: (replica.mempool || []).map(tx => String(tx?.type || '')),
            proposalTxs: (replica.proposal?.txs || []).map(tx =>
              String(tx?.type || ''),
            ),
            lockedFrameTxs: (replica.lockedFrame?.txs || []).map(tx =>
              String(tx?.type || ''),
            ),
          }
        : null,
      directInput,
    }),
    { headers: JSON_HEADERS },
  );
};

const handleMarketSnapshotsRequest = (
  env: RuntimeReplica,
  request: Request,
  url: URL,
  defaultHubEntityId: string,
): Response | null => {
  if (
    url.pathname !== '/api/market/snapshots' ||
    request.method !== 'GET'
  ) {
    return null;
  }
  const pairIds = Array.from(
    new Set(
      url.searchParams
        .getAll('pair')
        .concat(url.searchParams.getAll('pairId'))
        .map(normalizeMarketPairId)
        .filter((value): value is string => Boolean(value)),
    ),
  );
  if (pairIds.length === 0) {
    return new Response(
      safeStringify({ error: 'Missing valid pair query parameters' }),
      { status: 400, headers: JSON_HEADERS },
    );
  }
  const depthRaw = Number(
    url.searchParams.get('depth') || String(RPC_MARKET_DEFAULT_DEPTH),
  );
  const depth = Number.isFinite(depthRaw)
    ? Math.max(1, Math.min(Math.floor(depthRaw), RPC_MARKET_MAX_DEPTH))
    : RPC_MARKET_DEFAULT_DEPTH;
  const requestedRaw =
    url.searchParams.get('hubEntityId') ||
    url.searchParams.get('hub') ||
    '';
  const hubEntityId = requestedRaw
    ? normalizeMarketEntityId(requestedRaw)
    : defaultHubEntityId;
  if (!hubEntityId) {
    return new Response(
      safeStringify({
        error: 'Invalid hubEntityId query parameter',
        code: 'E_BAD_QUERY',
      }),
      { status: 400, headers: JSON_HEADERS },
    );
  }
  const replica = getEntityReplicaById(env, hubEntityId);
  if (!replica) {
    return new Response(
      safeStringify({
        error: `Unknown market hub: ${hubEntityId}`,
        code: 'E_UNKNOWN_HUB',
        hubEntityId,
      }),
      { status: 404, headers: JSON_HEADERS },
    );
  }
  const snapshots = pairIds.map(pairId =>
    buildMarketSnapshotForReplica(
      replica,
      hubEntityId,
      pairId,
      depth,
    ),
  );
  return new Response(
    safeStringify({ hubEntityId, depth, snapshots }),
    { headers: JSON_HEADERS },
  );
};

const handleDebugReserveRequest = async (
  env: RuntimeReplica,
  request: Request,
  url: URL,
): Promise<Response | null> => {
  if (url.pathname !== '/api/debug/reserve' || request.method !== 'GET') {
    return null;
  }
  const entityId = String(url.searchParams.get('entityId') || '').trim();
  const tokenId = Number(url.searchParams.get('tokenId') || '1');
  const jurisdictionRef = String(
    url.searchParams.get('jurisdiction') || '',
  ).trim();
  if (!entityId) {
    return new Response(safeStringify({ error: 'Missing entityId' }), {
      status: 400,
      headers: JSON_HEADERS,
    });
  }
  if (!Number.isInteger(tokenId) || tokenId <= 0) {
    return new Response(safeStringify({ error: 'Invalid tokenId' }), {
      status: 400,
      headers: JSON_HEADERS,
    });
  }
  try {
    const adapter = requireJAdapterForDebugReserve(
      env,
      entityId,
      jurisdictionRef,
    );
    const reserve = await adapter.getReserves(entityId, tokenId);
    return new Response(
      safeStringify({
        ok: true,
        entityId,
        tokenId,
        ...(jurisdictionRef ? { jurisdiction: jurisdictionRef } : {}),
        reserve: reserve.toString(),
      }),
      { headers: JSON_HEADERS },
    );
  } catch (error) {
    return new Response(
      safeStringify({
        error: error instanceof Error ? error.message : String(error),
      }),
      { status: 500, headers: JSON_HEADERS },
    );
  }
};

const createHubControlRequestHandler = (dependencies: {
  state: RuntimeReplica;
  nodeName: string;
  pauseBootstrap: () => Promise<void>;
  markShuttingDown: () => void;
}): ((request: Request, url: URL) => Promise<Response | null>) =>
  async (request, url) => {
    if (request.method !== 'POST') return null;
    const stopP2P = url.pathname === '/api/control/p2p/stop';
    const quiesceRuntime =
      url.pathname === '/api/control/runtime/quiesce';
    if (!stopP2P && !quiesceRuntime) return null;
    dependencies.markShuttingDown();
    try {
      await dependencies.pauseBootstrap();
      const result = await quiesceNodeRuntime(dependencies.state, {
        workTimeoutMs: stopP2P ? 10_000 : 20_000,
        loopTimeoutMs: 5_000,
        ...(quiesceRuntime ? { quietMs: 750 } : {}),
      });
      return new Response(safeStringify({ ok: true, ...result }), {
        headers: JSON_HEADERS,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      const operation = stopP2P ? 'p2p stop' : 'runtime quiesce';
      console.error(
        `[${dependencies.nodeName}] ${operation} failed: ${message}`,
      );
      return new Response(
        safeStringify({ ok: false, error: message }),
        { status: 503, headers: JSON_HEADERS },
      );
    }
  };

const handleHubJurisdictionsRequest = (
  env: RuntimeReplica,
  url: URL,
): Response | null => {
  if (url.pathname !== '/api/jurisdictions') return null;
  const payload = buildRuntimeJurisdictionsPayload(env);
  return payload
    ? new Response(payload, {
        headers: {
          ...JSON_HEADERS,
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        },
      })
    : new Response(
        safeStringify({ error: 'JURISDICTION_PAYLOAD_UNAVAILABLE' }),
        { status: 503, headers: JSON_HEADERS },
      );
};

const currentRuntimeHeight = (env: RuntimeReplica | null): number =>
  Math.max(0, Math.floor(Number(env?.state.height ?? 0)));

type HubHttpContext = {
  env: RuntimeReplica;
  hubBootstraps: HubBootstrapEntry[];
  externalWalletApi: ReturnType<typeof createExternalWalletApi>;
  faucetRelayStore: ReturnType<typeof createRelayStore>;
  runtimeIngressReceipts: ReturnType<
    typeof createRuntimeIngressReceiptStore
  >;
  getBootstrap: () => { entityId: string; signerId: string } | null;
  getJAdapter: () => JAdapter | null;
  ensureTokenCatalog: () => Promise<JTokenInfo[]>;
  getDirectInputDebug: () => {
    lastSeen: DirectEntityInputDebug | null;
    lastError: DirectEntityInputDebug | null;
  };
  handleStatus: (url: URL, operatorAuthorized: boolean) => Response | null;
  handleControl: (request: Request, url: URL) => Promise<Response | null>;
};

const handleHubHttpRequest = async (
  context: HubHttpContext,
  request: Request,
  url: URL,
  operatorAuthorized: boolean,
): Promise<Response> => {
  if (requiresLocalNodeOperator(url) && !operatorAuthorized) {
    return new Response(
      safeStringify({ error: 'Operator access required' }),
      { status: 403, headers: JSON_HEADERS },
    );
  }
  const statusResponse = context.handleStatus(url, operatorAuthorized);
  if (statusResponse) return statusResponse;
  const accountStatusResponse = handleAccountStatusRequest(
    context.env,
    request,
    url,
    context.getBootstrap()?.entityId ?? null,
    context.getDirectInputDebug(),
  );
  if (accountStatusResponse) return accountStatusResponse;
  const controlResponse = await context.handleControl(request, url);
  if (controlResponse) return controlResponse;
  const jurisdictionsResponse = handleHubJurisdictionsRequest(
    context.env,
    url,
  );
  if (jurisdictionsResponse) return jurisdictionsResponse;

  const bootstrap = context.getBootstrap();
  const jadapter = context.getJAdapter();
  if (!bootstrap || !jadapter) {
    return new Response(safeStringify({ error: 'HUB_NOT_READY' }), {
      status: 503,
      headers: JSON_HEADERS,
    });
  }
  const marketResponse = handleMarketSnapshotsRequest(
    context.env,
    request,
    url,
    bootstrap.entityId,
  );
  if (marketResponse) return marketResponse;
  if (url.pathname === '/api/lending/state' && request.method === 'GET') {
    return handleLendingStateRequest({
      req: request,
      env: context.env,
      headers: JSON_HEADERS,
      activeHubEntityIds: context.hubBootstraps.map(entry => entry.entityId),
    });
  }
  if (url.pathname === '/api/tokens' && request.method === 'GET') {
    return context.externalWalletApi.handleTokens();
  }
  if (
    url.pathname === '/api/external-wallet/snapshot' &&
    request.method === 'POST'
  ) {
    return context.externalWalletApi.handleWalletSnapshot(request);
  }
  if (url.pathname === '/api/faucet/erc20' && request.method === 'POST') {
    return context.externalWalletApi.handleErc20Faucet(request);
  }
  if (url.pathname === '/api/faucet/gas' && request.method === 'POST') {
    return context.externalWalletApi.handleGasFaucet(request);
  }
  if (url.pathname === '/api/faucet/reserve' && request.method === 'POST') {
    return handleReserveFaucet({
      req: request,
      env: context.env,
      headers: JSON_HEADERS,
      relayStore: { activeHubEntityIds: [bootstrap.entityId] },
      getJAdapter: () => jadapter,
      ensureTokenCatalog: context.ensureTokenCatalog,
      validateRuntimeInputAdmission,
      enqueueRuntimeInput,
    });
  }
  if (url.pathname === '/api/faucet/offchain' && request.method === 'POST') {
    context.faucetRelayStore.activeHubEntityIds =
      context.hubBootstraps.map(entry => entry.entityId);
    return handleOffchainFaucet({
      req: request,
      env: context.env,
      headers: JSON_HEADERS,
      relayStore: context.faucetRelayStore,
      enqueueRuntimeInput,
      validateRuntimeInputAdmission,
      registerReceipt: receipt =>
        context.runtimeIngressReceipts.register(receipt),
      getCurrentRuntimeHeight: currentRuntimeHeight,
      buildRuntimeInputStatusUrl: runtimeInputStatusUrl,
    });
  }
  const statusMatch = url.pathname.match(
    /^\/api\/control\/runtime-input\/([^/]+)\/status$/,
  );
  if (statusMatch && request.method === 'GET') {
    return handleRuntimeInputStatus(
      decodeURIComponent(statusMatch[1] || ''),
      JSON_HEADERS,
      context.env,
      {
        receipts: context.runtimeIngressReceipts,
        getCurrentRuntimeHeight: currentRuntimeHeight,
      },
    );
  }
  const debugReserveResponse = await handleDebugReserveRequest(
    context.env,
    request,
    url,
  );
  if (debugReserveResponse) return debugReserveResponse;
  if (
    url.pathname === '/api/debug/activity' &&
    request.method === 'GET'
  ) {
    return handleRuntimeActivityRequest(context.env, url, JSON_HEADERS);
  }
  return new Response(safeStringify({ error: 'Not found' }), {
    status: 404,
    headers: JSON_HEADERS,
  });
};

type MeshBootstrapMilestones = {
  gossipReady: boolean;
  accountsReady: boolean;
  creditReady: boolean;
  reserveReady: boolean;
};

type HubMeshBootstrapInput = {
  env: RuntimeReplica;
  bootstrap: { entityId: string; signerId: string };
  hubBootstraps: HubBootstrapEntry[];
  jurisdiction: JurisdictionConfig;
  tokenCatalog: JTokenInfo[];
  milestones: MeshBootstrapMilestones;
  totalStartedAt: number;
  markProgress: (step: string) => void;
  ensureFaucetReady: () => Promise<void>;
};

const ensureHubMeshReserves = async (
  input: HubMeshBootstrapInput,
): Promise<boolean> => {
  let peerReady = true;
  if (resolvedArgs.deployTokens) {
    input.markProgress('peer-reserve-funding');
    const localIds = new Set(
      input.hubBootstraps.map(entry => normalizeEntityId(entry.entityId)),
    );
    const peerProfiles = readVisibleHubProfiles(input.env, '').filter(
      profile => !localIds.has(normalizeEntityId(profile.entityId)),
    );
    const expected =
      Math.max(0, resolvedArgs.meshHubNames.length - 1) *
      input.hubBootstraps.length;
    peerReady = peerProfiles.length >= expected;
    if (peerReady) {
      await ensurePeerBootstrapReserves(
        input.env,
        peerProfiles,
        input.tokenCatalog,
        step => input.markProgress(`peer-reserve:${step}`),
      );
    }
  }
  input.markProgress('local-reserve-funding');
  const health = await ensureHubBootstrapReserves(
    input.env,
    input.hubBootstraps,
    step => input.markProgress(`local-reserve:${step}`),
  );
  return health.targetMet === true && peerReady;
};

const advanceHubMeshBootstrap = async (
  input: HubMeshBootstrapInput,
): Promise<void> => {
  const jurisdiction =
    getEntityJurisdiction(input.env, input.bootstrap.entityId) ||
    getEntityJurisdictionName(input.env, input.bootstrap.entityId) ||
    input.jurisdiction;
  const visibleProfiles = readVisibleHubProfiles(input.env, jurisdiction);
  const requiredNames = new Set(
    resolvedArgs.meshHubNames
      .map(name => name.trim().toLowerCase())
      .filter(Boolean),
  );
  const requiredProfiles = visibleProfiles.filter(profile => {
    const name =
      String(profile.hubName || profile.name || '')
        .trim()
        .split(/\s+/)[0]
        ?.toLowerCase() || '';
    return requiredNames.has(name);
  });
  if (
    !input.milestones.gossipReady &&
    requiredProfiles.length === resolvedArgs.meshHubNames.length
  ) {
    finishTiming(
      'gossip_ready',
      startedAtFor('gossip_ready') ?? startTiming('gossip_ready'),
    );
    input.milestones.gossipReady = true;
  } else if (!input.milestones.gossipReady) {
    startTiming('gossip_ready');
  }
  if (requiredProfiles.length !== resolvedArgs.meshHubNames.length) return;

  const peers = requiredProfiles.filter(
    profile => profile.entityId !== input.bootstrap.entityId.toLowerCase(),
  );
  input.markProgress('direct-peers');
  if (!directHubPeersReady(input.env, peers)) return;
  const { openInputs, creditInputs } = planMeshBootstrapInputs(
    input.env,
    input.bootstrap,
    input.hubBootstraps,
    peers,
    supportPeerIdentities,
  );
  if (openInputs.length > 0) {
    input.markProgress(`open-accounts:${openInputs.length}`);
    startTiming('mesh_accounts');
    enqueueRuntimeInput(input.env, {
      runtimeTxs: [],
      entityInputs: openInputs,
    });
    await settleRuntimeFor(input.env, 35);
  }
  const accountReady =
    peers.length === Math.max(0, resolvedArgs.meshHubNames.length - 1) &&
    peers.every(peer =>
      hasAccount(input.env, input.bootstrap.entityId, peer.entityId) &&
      DEFAULT_ACCOUNT_TOKEN_IDS.every(tokenId =>
        Boolean(
          getAccountState(
            input.env,
            input.bootstrap.entityId,
            peer.entityId,
          )?.deltas.get(tokenId),
        ),
      ),
    );
  if (accountReady && !input.milestones.accountsReady) {
    finishTiming(
      'mesh_accounts',
      startedAtFor('mesh_accounts') ?? startTiming('mesh_accounts'),
    );
    input.milestones.accountsReady = true;
  }
  if (creditInputs.length > 0) {
    input.markProgress(`extend-credit:${creditInputs.length}`);
    startTiming('mesh_credit');
    enqueueRuntimeInput(input.env, {
      runtimeTxs: [],
      entityInputs: creditInputs,
    });
    await settleRuntimeFor(input.env, 45);
  }
  const creditReady =
    peers.length === Math.max(0, resolvedArgs.meshHubNames.length - 1) &&
    peers.every(peer =>
      hasPairMutualCredits(
        input.env,
        input.bootstrap.entityId,
        peer.entityId,
        DEFAULT_ACCOUNT_TOKEN_IDS,
        getBootstrapCreditAmount,
      ),
    );
  if (!creditReady) return;
  if (!input.milestones.creditReady) {
    finishTiming(
      'mesh_credit',
      startedAtFor('mesh_credit') ?? startTiming('mesh_credit'),
    );
    input.milestones.creditReady = true;
  }
  if (!input.milestones.reserveReady) {
    input.milestones.reserveReady = await ensureHubMeshReserves(input);
  }
  if (
    input.milestones.reserveReady &&
    (timings['mesh_ready_total']?.ms ?? null) === null
  ) {
    input.markProgress('external-faucet-provision');
    await input.ensureFaucetReady();
    finishTiming('mesh_ready_total', input.totalStartedAt);
  }
};

const requireHubTokenCatalog = async (live: HubNodeLiveContext): Promise<JTokenInfo[]> => {
  if (!live.activeJAdapter) throw new Error('J-adapter not initialized');
  if (live.activeTokenCatalog.length === 0) {
    live.activeTokenCatalog = await waitForTokenCatalog(live.activeJAdapter);
  }
  return live.activeTokenCatalog;
};

const createHubExternalWalletApi = (live: HubNodeLiveContext) =>
  createExternalWalletApi({
    getJAdapter: () => live.activeJAdapter,
    getRuntimeId: () => String(live.env.runtimeId || ''),
    getTokenCatalog: () => requireHubTokenCatalog(live),
    jsonHeaders: JSON_HEADERS,
    faucetSeed: `${resolvedArgs.seed}:faucet`,
    faucetSignerLabel: FAUCET_SIGNER_LABEL,
    faucetWalletEthTarget: FAUCET_WALLET_ETH_TARGET,
    faucetTokenTargetUnits: FAUCET_TOKEN_TARGET_UNITS,
    emitDebugEvent: entry => {
      if (live.p2p?.sendDebugEvent(entry)) return;
      if (entry.event === 'error') {
        nodeLog.error('debug_event.delivery_failed', {
          reason: entry.reason,
          status: entry.status,
        });
      }
    },
    fundBrowserVmWallet: async () => false,
  });

const createHubStatusHandler = (
  live: HubNodeLiveContext,
  bootstrapClockMs: () => number,
): ((url: URL, operatorAuthorized: boolean) => Response | null) =>
  (url, operatorAuthorized) => {
    if (url.pathname === '/api/info') {
      return new Response(
        safeStringify({
          name: resolvedArgs.name,
          entityId: live.bootstrap?.entityId ?? null,
          hubEntities: live.hubBootstraps,
          runtimeId: live.env.runtimeId,
          apiUrl,
          relayUrl: resolvedArgs.relayUrl,
          directWsUrl,
          storage: {
            persistencePaused: Boolean(live.env.runtimeState?.persistencePaused),
          },
        }),
        { headers: JSON_HEADERS },
      );
    }
    if (url.pathname !== '/api/health') return null;
    const health = buildLocalHealth(
      live.env,
      live.bootstrap?.entityId ?? null,
      live.activeTokenCatalog,
      live.activeJAdapter,
      live.hubBootstraps,
      buildBootstrapProgressHealth(
        live.meshLoopProgress,
        live.meshLoopInFlight,
        bootstrapClockMs(),
        MESH_BOOTSTRAP_STALL_TIMEOUT_MS,
      ),
    );
    return new Response(
      safeStringify(operatorAuthorized ? health : publicLocalHubHealth(health)),
      { headers: JSON_HEADERS },
    );
  };

type HubHttpSurface = {
  server: ReturnType<typeof Bun.serve>;
  httpDrain: ReturnType<typeof createHttpDrainTracker>;
  externalWalletApi: ReturnType<typeof createExternalWalletApi>;
  directInputDebug: DirectInputDebugState;
};

const startHubHttpSurface = (
  live: HubNodeLiveContext,
  runtimeIngressReceipts: ReturnType<typeof createRuntimeIngressReceiptStore>,
  faucetRelayStore: ReturnType<typeof createRelayStore>,
  pauseBootstrap: () => Promise<void>,
  bootstrapClockMs: () => number,
): HubHttpSurface => {
  const externalWalletApi = createHubExternalWalletApi(live);
  const directInputDebug: DirectInputDebugState = { lastSeen: null, lastError: null };
  const directRuntimeWs = createHubDirectRuntimeRoute(
    live.env,
    resolvedArgs.seed,
    () => live.externalIngressReady,
    directInputDebug,
  );
  const handleRadapterWsMessage = createHubRadapterMessageHandler(
    live.env,
    runtimeIngressReceipts,
    () => live.externalIngressReady,
  );
  const httpDrain = createHttpDrainTracker();
  const handleControl = createHubControlRequestHandler({
    state: live.env,
    nodeName: resolvedArgs.name,
    pauseBootstrap,
    markShuttingDown: () => {
      live.shuttingDown = true;
    },
  });
  const context: HubHttpContext = {
    env: live.env,
    hubBootstraps: live.hubBootstraps,
    externalWalletApi,
    faucetRelayStore,
    runtimeIngressReceipts,
    getBootstrap: () => live.bootstrap,
    getJAdapter: () => live.activeJAdapter,
    ensureTokenCatalog: () => requireHubTokenCatalog(live),
    getDirectInputDebug: () => ({ ...directInputDebug }),
    handleStatus: createHubStatusHandler(live, bootstrapClockMs),
    handleControl,
  };
  const server = Bun.serve({
    hostname: resolvedArgs.apiHost,
    port: resolvedArgs.apiPort,
    idleTimeout: 120,
    async fetch(request, serverRef) {
      const releaseHttp = httpDrain.begin();
      try {
        const url = new URL(request.url);
        const operatorAuthorized = isLocalOperatorRequest(
          request,
          resolveSocketPeerAddress(serverRef, request),
        );
        if (request.headers.get('upgrade') === 'websocket' && url.pathname === '/rpc') {
          return serverRef.upgrade(request, { data: { type: 'rpc' } })
            ? undefined
            : new Response('WebSocket upgrade failed', { status: 400 });
        }
        const directUpgrade = directRuntimeWs.maybeUpgrade(request, serverRef);
        if (directUpgrade.handled) return directUpgrade.response;
        return await handleHubHttpRequest(context, request, url, operatorAuthorized);
      } finally {
        releaseHttp();
      }
    },
    websocket: {
      open(ws: HubServerSocket) {
        if (ws.data?.type === 'rpc') {
          attachRuntimeAdapterTicker(live.env, registerEnvChangeCallback);
          return;
        }
        directRuntimeWs.websocket.open(ws);
      },
      message(ws: HubServerSocket, raw: string | Buffer | ArrayBuffer) {
        if (ws.data?.type === 'rpc') {
          handleRadapterWsMessage(ws, raw);
          return;
        }
        return directRuntimeWs.websocket.message(ws, raw);
      },
      close(ws: HubServerSocket) {
        if (ws.data?.type === 'rpc') {
          forgetRuntimeAdapterClient(ws);
          return;
        }
        directRuntimeWs.websocket.close(ws);
      },
    },
  });
  return { server, httpDrain, externalWalletApi, directInputDebug };
};

type HubMeshBootstrapController = {
  pauseAndWait(): Promise<void>;
  start(
    jurisdiction: JurisdictionConfig,
    tokenCatalog: JTokenInfo[],
    externalWalletApi: ReturnType<typeof createExternalWalletApi>,
  ): void;
};

const createHubMeshBootstrapController = (
  live: HubNodeLiveContext,
  bootstrapClockMs: () => number,
): HubMeshBootstrapController => {
  let loop: ReturnType<typeof setInterval> | null = null;
  let fatal = false;
  let paused = false;

  const pauseAndWait = async (): Promise<void> => {
    paused = true;
    if (loop) {
      clearInterval(loop);
      loop = null;
    }
    while (live.meshLoopInFlight) await sleep(100);
  };

  const start: HubMeshBootstrapController['start'] = (jurisdiction, tokenCatalog, externalWalletApi) => {
    const totalStartedAt = startTiming('mesh_ready_total');
    const milestones: MeshBootstrapMilestones = {
      gossipReady: false,
      accountsReady: false,
      creditReady: false,
      reserveReady: false,
    };
    let faucetProvision: Promise<void> | null = null;
    const ensureFaucetReady = async (): Promise<void> => {
      if (!resolvedArgs.deployTokens || !AUTO_PROVISION_EXTERNAL_FAUCET) return;
      faucetProvision ??= externalWalletApi.provisionFaucetWallet().then(() => {
        if (!live.shuttingDown) nodeLog.info('faucet_provision.ready', { name: resolvedArgs.name });
      });
      await faucetProvision;
    };
    const markProgress = (step: string): void => {
      live.meshLoopProgress = advanceBootstrapProgress(live.meshLoopProgress, step, bootstrapClockMs());
    };
    const drive = async (): Promise<void> => {
      if (!live.bootstrap || live.shuttingDown || paused || fatal || live.meshLoopInFlight) return;
      // Inputs are derived only from committed Entity state. Waiting here
      // prevents re-enqueuing an account open while its prior frame is applying.
      if (hasPendingRuntimeWork(live.env)) return;
      live.meshLoopInFlight = true;
      try {
        await advanceHubMeshBootstrap({
          env: live.env,
          bootstrap: live.bootstrap,
          hubBootstraps: live.hubBootstraps,
          jurisdiction,
          tokenCatalog,
          milestones,
          totalStartedAt,
          markProgress,
          ensureFaucetReady,
        });
      } finally {
        live.meshLoopInFlight = false;
      }
    };
    const handleFatal = (error: unknown): void => {
      handleMeshBootstrapLoopError(error, {
        nodeName: resolvedArgs.name,
        isShuttingDown: () => live.shuttingDown || fatal,
        clearLoop: () => {
          fatal = true;
          if (loop) clearInterval(loop);
          loop = null;
        },
        exit: code => process.exit(code),
        logError: (...args) => console.error(...args),
      });
    };
    if (live.shuttingDown || fatal || paused) return;
    loop = setInterval(() => {
      if (!live.shuttingDown && !fatal && !paused) void drive().catch(handleFatal);
    }, BOOTSTRAP_POLL_MS);
    void drive().catch(handleFatal);
  };

  return { pauseAndWait, start };
};

const installHubShutdownHandlers = (
  live: HubNodeLiveContext,
  meshController: HubMeshBootstrapController,
  httpSurface: HubHttpSurface,
): void => {
  let shutdownStarted = false;
  const shutdown = async (code = 0): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    live.shuttingDown = true;
    const failures: string[] = [];
    const runCleanup = async (label: string, cleanup: () => Promise<unknown>): Promise<void> => {
      try {
        await cleanup();
      } catch (error) {
        failures.push(`${label}:${error instanceof Error ? error.message : String(error)}`);
      }
    };
    await runCleanup('mesh_producer', meshController.pauseAndWait);
    await runCleanup('quiesce', () => quiesceNodeRuntime(live.env, {
      workTimeoutMs: 10_000,
      loopTimeoutMs: 10_000,
    }));
    await runCleanup('server', () =>
      stopServerGracefully(httpSurface.server, httpSurface.httpDrain, resolvedArgs.name, 5_000));
    await runCleanup('runtime_db', () => closeRuntimeDb(live.env));
    await runCleanup('infra_db', () => closeInfraDb(live.env));
    if (failures.length > 0) {
      console.error(`[${resolvedArgs.name}] shutdown failed: ${failures.join('|')}`);
      process.exit(code || 1);
    }
    process.exit(code);
  };
  const stopParentWatch = startParentLivenessWatch(
    resolvedArgs.name,
    process.env['XLN_ORCHESTRATOR_PID'],
    () => void shutdown(1),
  );
  process.on('SIGTERM', () => {
    stopParentWatch();
    void shutdown();
  });
  process.on('SIGINT', () => {
    stopParentWatch();
    void shutdown();
  });
};

const run = async (): Promise<void> => {
  if (resolvedArgs.dbPath) {
    process.env['XLN_DB_PATH'] = resolvedArgs.dbPath;
  }
  process.env['JADAPTER_DEV_PRIVATE_KEY'] = deriveAnvilDevPrivateKey(resolveHubSignerIndex(resolvedArgs.name));

  const runtimeBootStartedAt = startTiming('runtime_boot');
  const localSignerLabels = buildLocalHubSignerLabels();
  const env = await main(resolvedArgs.seed, {
    localSigners: localSignerLabels.map(label => ({ label })),
    trustedJurisdictionRpcBindings: resolveMeshJurisdictionRpcBindings(
      resolvedArgs.rpcUrl,
      resolveLocalApiUrl,
    ),
  });
  nodeLog.info('signer_keys.ready', { name: resolvedArgs.name, count: localSignerLabels.length });
  if (restoredRuntimeRouteRelocated(env.gossip.getProfiles(), {
    runtimeId: String(env.runtimeId || ''),
    wsUrl: directWsUrl,
    relayUrls: [resolvedArgs.relayUrl],
  })) {
    await clearGossip(env, { runtimeId: String(env.runtimeId || '') });
    nodeLog.info('gossip.relocated_route_cache_cleared', { wsUrl: directWsUrl });
  }
  const runtimeIngressReceipts = createRuntimeIngressReceiptStore();
  const faucetRelayStore = createRelayStore(`${resolvedArgs.name}-faucet`);
  registerRuntimeFrameCommitCallback(env, ({ height, runtimeInput }) => {
    runtimeIngressReceipts.observeRuntimeInput(height, runtimeInput);
  });
  configureHubRuntimeLogging(env);
  finishTiming('runtime_boot', runtimeBootStartedAt);

  const live: HubNodeLiveContext = {
    env,
    bootstrap: null,
    hubBootstraps: [],
    activeJAdapter: null,
    activeTokenCatalog: [],
    p2p: null,
    externalIngressReady: false,
    shuttingDown: false,
    meshLoopProgress: beginBootstrapProgress(getPerfMs()),
    meshLoopInFlight: false,
  };
  // Bootstrap liveness measures elapsed process time, not civil time. Date.now
  // can move backwards under NTP and previously killed every hub at once.
  const bootstrapClockMs = (): number => getPerfMs();
  live.meshLoopProgress = beginBootstrapProgress(bootstrapClockMs());
  const meshController = createHubMeshBootstrapController(live, bootstrapClockMs);
  const httpSurface = startHubHttpSurface(
    live,
    runtimeIngressReceipts,
    faucetRelayStore,
    meshController.pauseAndWait,
    bootstrapClockMs,
  );

  const importJStartedAt = startTiming('import_j');
  const jurisdiction = await prepareJurisdictionForImport(resolveJurisdictionConfig(resolvedArgs.rpcUrl));
  await importJurisdiction(env, jurisdiction);
  finishTiming('import_j', importJStartedAt);

  const hubBootstrapStartedAt = startTiming('hub_bootstrap');
  const bootstrapped = await bootstrapHubJurisdictions(env, jurisdiction);
  live.bootstrap = bootstrapped.primaryBootstrap;
  live.hubBootstraps.push(...bootstrapped.entries);
  finishTiming('hub_bootstrap', hubBootstrapStartedAt);

  const primaryJurisdictionName = jurisdiction.name;

  const jadapter = getActiveJAdapter(env);
  if (!jadapter) throw new Error('ACTIVE_JADAPTER_MISSING_AFTER_IMPORT');
  live.activeJAdapter = jadapter;
  await ensureRpcStackReady(env, jadapter);

  const tokenCatalog = resolvedArgs.deployTokens
    ? await ensureTokenCatalog(jadapter, true, primaryJurisdictionName)
    : await waitForTokenCatalog(jadapter);
  live.activeTokenCatalog = tokenCatalog;
  if (live.bootstrap?.entityId) {
    tokenCatalogsByEntityId.set(normalizeEntityId(live.bootstrap.entityId), tokenCatalog);
  }

  startJurisdictionWatchers(env);
  const watcherDrain = await drainJWatcherBacklog(env, async currentEnv => processRuntime(currentEnv));
  live.externalIngressReady = true;
  nodeLog.info('startup.j_catchup_ready', {
    jurisdictions: watcherDrain.length,
    cursors: watcherDrain.map(status => `${status.chainId}:${status.committedCursor}/${status.targetBlock}`),
  });

  const p2pConnectStartedAt = startTiming('p2p_connect');
  live.p2p = startP2P(env, {
    relayUrls: [resolvedArgs.relayUrl],
    wsUrl: directWsUrl,
    preferRelayForEntityInput: true,
    advertiseEntityIds: live.hubBootstraps.map((entry) => entry.entityId),
    isHub: true,
    gossipPollMs: BOOTSTRAP_POLL_MS * 5,
  });
  if (!live.p2p) throw new Error('P2P_START_FAILED');
  startRuntimeLoop(env, {
    tickDelayMs: HUB_RUNTIME_TICK_DELAY_MS,
    maxEntityInputsPerFrame: HUB_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME,
    maxEntityTxsPerFrame: HUB_MAX_ENTITY_TXS_PER_RUNTIME_FRAME,
    onFatal: async payload => {
      await reportManagedChildFatal({
        runtimeId: String(env.runtimeId || ''),
        ...payload,
      });
    },
  });
  finishTiming('p2p_connect', p2pConnectStartedAt);

  meshController.start(jurisdiction, tokenCatalog, httpSurface.externalWalletApi);

  nodeLog.info('runtime.ready', {
    name: resolvedArgs.name,
    entityId: live.bootstrap.entityId,
    runtimeId: String(env.runtimeId || ''),
    api: apiUrl,
    relay: resolvedArgs.relayUrl,
  });
  if (LOG_HUB_ADMIN_URL) {
    try {
      const adminUrl = buildRuntimeAdminUrl(env);
      if (adminUrl) {
        nodeLog.info('admin_url.ready', {
          name: resolvedArgs.name,
          url: redactTokenBearingUrlForLog(adminUrl),
        });
      }
    } catch (error) {
      nodeLog.warn('admin_url.unavailable', {
        name: resolvedArgs.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  installHubShutdownHandlers(live, meshController, httpSurface);
  await waitUntil(() => false, Number.MAX_SAFE_INTEGER, 1000);
};

run().catch(error => {
  console.error(`[MESH-HUB] FAILED ${resolvedArgs.name}:`, (error as Error).stack || (error as Error).message);
  process.exit(1);
});
