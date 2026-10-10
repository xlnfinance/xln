#!/usr/bin/env bun
import { canDeployHubDefaultTokens, ensureTokenCatalog, waitForTokenCatalog } from './hub/node/token-catalog';
import { importJurisdiction } from './hub/node/import-jurisdiction';
import {
  attachValidatedJurisdictionAdapter,
  hasLiveJAdapterForJurisdiction,
} from './hub/node/hub-jurisdiction-binding';
import {
  buildPairHealth,
  planMeshBootstrapInputs,
  supportPeerProvisioningReady,
} from './hub/node/hub-mesh-plan';
import {
  buildHubBootstrapReserveHealth,
  ensureHubBootstrapReserves,
  getEntityJurisdictionName,
  normalizeEntityId,
  type HubReserveDeps,
} from './hub/node/hub-reserves';
import {
  createHubControlRequestHandler,
  handleHubHttpRequest,
  type HubHttpContext,
} from './hub/node/hub-http';
import { configureCryptoPoolEntry } from '../protocol/crypto/crypto-pool';
import { ethers, getIndexedAccountPath, HDNodeWallet, Mnemonic } from 'ethers';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createExternalWalletApi } from '../api/public/external-wallet-api';
import { createBrainVaultOwnerController, type BrainVaultOwnerController } from '../api/server/ownership/brainvault';
import { hasCliFlag, readCliOption } from '../config/cli';
import { readBooleanEnv, readNonNegativeIntegerEnv, readPositiveIntegerEnv } from '../config/environment';
import { bootstrapHub } from '../../scripts/bootstrap-hub';
import {
  normalizeJurisdictionDisplayName,
  readVisibleHubProfiles,
  type VisibleHubProfile,
} from './hub/hub-visible-profiles';
import type { JAdapter, JTokenInfo } from '../jurisdiction/adapter/types';
import { getLiveJAdapter } from '../runtime/j-submit/live-jadapters';
import {
  normalizeJurisdictionKey,
  selectWritableJurisdictionKey,
} from '../jurisdiction/machine/config/jurisdiction-key';
import { resolveJurisdictionsJsonPath } from '../jurisdiction/adapter/jurisdictions-path';
import { DEFAULT_SPREAD_DISTRIBUTION } from '../orderbook';
import { toPublicRpcUrl } from '../network/p2p/loopback-url';
import { startParentLivenessWatch } from '../support/process/parent-watch';
import { createHttpDrainTracker, stopServerGracefully } from './graceful-server';
import { quiesceNodeRuntime } from './process/node-runtime-quiesce';
import { drainJWatcherBacklog } from '../jurisdiction/adapter/operations/backlog-drain';
import { createRelayStore } from '../network/relay/store';
import { safeStringify } from '../protocol/serialization';
import { writeDurableFile } from '../storage/fs-durability';
import { createStructuredLogger } from '../support/logger';
import { getPerfMs } from '../support/time';
import { handleMeshBootstrapLoopError } from './mesh/mesh-bootstrap-fail-fast';
import { reportManagedChildFatal } from './process/managed-child-fatal-ipc';
import {
  advanceBootstrapProgress,
  beginBootstrapProgress,
  buildBootstrapProgressHealth,
  type BootstrapProgressHealth,
} from './bootstrap/bootstrap-progress-watchdog';
import { restoredRuntimeRouteRelocated } from './mesh/restored-gossip-route';
import { readInheritedChildSecrets, resolveChildSecret } from '../support/process/child-secrets';
import { findMissingRpcContractCode } from './bootstrap/contract-readiness';
import { parseShardJurisdictions } from './j-select/jurisdictions';
import { isLocalOperatorRequest, publicLocalHubHealth, resolveSocketPeerAddress } from '../api/server/health/redaction';
import {
  deriveRuntimeAdapterCapabilityToken,
  registerRuntimeAdapterAuthSeed,
  resolveRuntimeAdapterAuthAudience,
  resolveRuntimeAdapterAuthSeed,
} from '../api/runtime-adapter/security/auth';
import {
  getJurisdictionIdentityRef,
} from '../jurisdiction/machine/jurisdiction-runtime';
import { requireJurisdictionChainId } from '../jurisdiction/machine/jurisdiction-stack';
import {
  attachRuntimeAdapterTicker,
  forgetRuntimeAdapterClient,
} from '../api/runtime-adapter/server';
import { redactTokenBearingUrlForLog } from './replica-import/runtime-import-log';
import { readRuntimeSecurityIncidentTelemetry } from '../runtime/observability/security-incidents';
import { createStackManagerController } from '../api/server/control/stack-manager';
import { hasDaemonControlAuth, parseTaggedControlBody } from '../api/server/control/auth';
import { JSON_HEADERS } from '../api/server/utils';
import {
  getActiveJAdapter,
  getP2P,
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
  waitForRuntimeWorkDrained,
} from '../runtime.ts';
import { registerEnvChangeCallback } from '../runtime/loop/loop-environment.ts';
import { ensurePendingNumberedRegistrationsResumed } from '../runtime/registration/numbered/numbered-registration-driver';
import { setRuntimeDeliveryReady } from '../runtime/envelope/p2p-lifecycle';
import type { RuntimeReplica } from '../runtime/types';
import {
  BOOTSTRAP_POLL_MS,
  DEFAULT_ACCOUNT_TOKEN_IDS,
  getAccountReplica,
  getBootstrapCreditAmount,
  getEntityReplicaById,
  HUB_DEFAULT_MIN_TRADE_SIZE,
  HUB_DEFAULT_SUPPORTED_PAIRS,
  hasAccount,
  hasPendingRuntimeWork,
  hasPairMutualCredits,
  settleRuntimeFor,
  sleep,
  summarizeRuntimeQuiescence,
  waitUntil,
} from './mesh/mesh-common';
import {
  resetMeshJurisdictionsCache,
  resolveMeshJurisdictionConfig,
  resolveMeshJurisdictionRpcBindings,
  resolveSecondaryJurisdictions,
} from './mesh/mesh-jurisdictions';
import {
  createHubDirectRuntimeRoute,
  createHubRadapterMessageHandler,
  type DirectInputDebugState,
  type HubServerSocket,
} from './hub/hub-runtime-transport';
import {
  dumpOpCounters,
  installGlobalOpCounters,
} from '../support/performance/op-counters';
import {
  dumpRuntimeSamplingProfile,
  startRuntimeSamplingProfiler,
} from '../support/performance/sampling-profiler';
import type {
  HubBootstrapEntry,
  HubNodeArgs,
  HubNodeLiveContext,
  JurisdictionConfig,
  JurisdictionImportDiagnostics,
  JurisdictionsFile,
  LocalHealthResponse,
  TimingMap,
} from './hub/node/hub-node-types';
import {
  bindHubMesh,
  hubMeshReady,
  parseConfiguredPeerIdentities,
  type HubMeshPeer,
} from './mesh/hub-mesh-peers';

const argsRaw = process.argv.slice(2);

const getArg = (name: string, defaultValue = ''): string =>
  readCliOption(argsRaw, name, defaultValue);

const hasFlag = (name: string): boolean => hasCliFlag(argsRaw, name);

const readRpcUrls = (): Record<number, string> => {
  const urls: Record<number, string> = {};
  for (let index = 1; index <= 8; index += 1) {
    const flag = index === 1 ? '--rpc-url' : `--rpc${index}-url`;
    const envName = index === 1 ? 'ANVIL_RPC' : `ANVIL_RPC${index}`;
    const defaultRpcUrl = index === 1
      ? process.env['ANVIL_RPC'] || ''
      : process.env[envName] || '';
    urls[index] = getArg(flag, index === 2 ? (process.env['ANVIL_RPC2'] || process.env['RPC_TRON'] || defaultRpcUrl) : defaultRpcUrl);
  }
  return urls;
};

const parseArgs = (): HubNodeArgs => {
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
    hubIdentitiesJson: getArg('--hub-identities-json', '[]'),
    supportPeerIdentitiesJson: getArg('--support-peer-identities-json', '[]'),
    dbPath: getArg('--db-path', ''),
    deployTokens: hasFlag('--deploy-tokens'),
    manualDisputeFinalize: hasFlag('--manual-dispute-finalize'),
  };
};

const DEFAULT_ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';
const FAUCET_SIGNER_LABEL = 'faucet-1';
const FAUCET_WALLET_ETH_TARGET = ethers.parseEther('10');
const FAUCET_TOKEN_TARGET_UNITS = 1_000_000n;
/**
 * `H<n>` takes Anvil dev account `n - 1`. Naming the three hubs one by one
 * silently gave every hub past H3 the same key as H1, which is fine until a
 * stand runs more than three shards and two of them sign as the same address.
 */
const resolveHubSignerIndex = (name: string): number => {
  const match = /^H(\d+)$/.exec(String(name || '').trim().toUpperCase());
  const ordinal = match ? Number(match[1]) : 1;
  return Number.isSafeInteger(ordinal) && ordinal >= 1 ? ordinal - 1 : 0;
};

const deriveAnvilDevPrivateKey = (index: number): string => {
  const mnemonic = Mnemonic.fromPhrase(process.env['ANVIL_MNEMONIC'] || DEFAULT_ANVIL_MNEMONIC);
  const wallet = HDNodeWallet.fromMnemonic(mnemonic, getIndexedAccountPath(index));
  return wallet.privateKey;
};

const resolvedArgs = parseArgs();
const supportPeerIdentities = parseConfiguredPeerIdentities(resolvedArgs.supportPeerIdentitiesJson, 'SUPPORT_PEER_IDENTITIES');
const meshHubIdentities = parseConfiguredPeerIdentities(resolvedArgs.hubIdentitiesJson, 'HUB_IDENTITIES');
if (meshHubIdentities.length === 0) throw new Error('HUB_IDENTITIES_MISSING');
const apiUrl = `http://${resolvedArgs.apiHost}:${resolvedArgs.apiPort}`;
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
  readPositiveIntegerEnv('XLN_MESH_BOOTSTRAP_STALL_TIMEOUT_MS', 30_000),
);
const MESH_PRODUCER_PAUSE_TIMEOUT_MS = Math.max(
  1_000,
  readPositiveIntegerEnv('XLN_MESH_PRODUCER_PAUSE_TIMEOUT_MS', 5_000),
);
const nodeLog = createStructuredLogger('mesh.hub', { hub: resolvedArgs.name });

const createHubBrainVaultOwner = (): BrainVaultOwnerController => createBrainVaultOwnerController({
  path: String(process.env['XLN_BRAINVAULT_OWNER_PATH'] || ''),
  ...(process.env['XLN_BRAINVAULT_WORKER_PATH']
    ? { workerPath: process.env['XLN_BRAINVAULT_WORKER_PATH'] }
    : {}),
  profileName: String(process.env['XLN_LOCAL_OWNER_PROFILE_NAME'] || 'xln finance').trim() || 'xln finance',
  enqueue: enqueueRuntimeInput,
  onFrameCommit: (targetEnv, callback) =>
    registerRuntimeFrameCommitCallback(targetEnv, ({ height }) => callback(height)),
  timeoutMs: 60_000,
});

const restoreHubBrainVaultOwner = async (
  live: HubNodeLiveContext,
  brainVaultOwner: BrainVaultOwnerController,
): Promise<void> => {
  const restored = await brainVaultOwner.restore(live.env);
  live.brainVaultReady = true;
  if (!restored) return;
  nodeLog.info('brainvault_owner.ready', {
    entityId: restored.entityId,
    created: restored.created,
    height: restored.height,
  });
};
let jurisdictionImportDiagnostics: JurisdictionImportDiagnostics | null = null;
// 0 means no delay / no cap.
const HUB_RUNTIME_TICK_DELAY_MS = readNonNegativeIntegerEnv('XLN_RUNTIME_TICK_DELAY_MS', 0);
const HUB_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME = readNonNegativeIntegerEnv('XLN_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME', 0);
const HUB_MAX_ENTITY_TXS_PER_RUNTIME_FRAME = readNonNegativeIntegerEnv('XLN_MAX_ENTITY_TXS_PER_RUNTIME_FRAME', 0);

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
  const seed = resolveRuntimeAdapterAuthSeed();
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
  url.hash = new URLSearchParams({
    runtime: 'remote',
    ws: runtimeAdapterUrl.toString(),
    token,
  }).toString();
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
      const parsed = parseShardJurisdictions(
        readFileSync(filePath, 'utf8'),
        `JURISDICTIONS_FILE_INVALID:path=${filePath}`,
      );
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
  const explicit = String(parsed?.['deployVersion'] || parsed?.['networkVersion'] || '').trim();
  if (explicit) return explicit;
  const lastUpdated = Date.parse(String(parsed?.['lastUpdated'] || ''));
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
      primary: previous['primary'] ?? true,
      chainId: requireJurisdictionChainId(jadapter.chainId, 'HUB_JADAPTER_CHAIN_ID_INVALID'),
      rpc: publicRpcUrl,
      explorer: previous['explorer'] ?? '',
      currency: previous['currency'] ?? 'USD',
      status: previous['status'] ?? 'active',
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
    await writeDurableFile(filePath, `${JSON.stringify(nextPayload, null, 2)}\n`);
  }
  resetMeshJurisdictionsCache();
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
      }
    | undefined;
  if (!replica) return null;

  const account = String(replica.contracts?.account || '').trim();
  const depository =
    String(replica.contracts?.depository || '').trim();
  const entityProvider =
    String(replica.contracts?.entityProvider || '').trim();
  const deltaTransformer = String(replica.contracts?.deltaTransformer || '').trim();
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
        chainId: requireJurisdictionChainId(replica.chainId, 'HUB_JURISDICTION_CHAIN_ID_INVALID'),
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
    attachValidatedJurisdictionAdapter(env, jadapter, resolvedArgs.rpcUrl);
    if (resolvedArgs.deployTokens) {
      await writeJurisdictionAddresses(jadapter, resolvedArgs.rpcUrl);
    }
    return;
  }
  throw new Error('RPC_STACK_ADDRESSES_MISSING');
};

const ORDERBOOK_INIT_DRAIN_TIMEOUT_MS = 10_000;

const ensureOrderbook = async (env: RuntimeReplica, entityId: string, signerId: string): Promise<void> => {
  const replica = getEntityReplicaById(env, entityId);
  if (replica?.state?.orderbookExt) return;
  if (!replica) throw new Error(`ORDERBOOK_HUB_REPLICA_MISSING:${entityId}`);
  const jurisdictionRef = getJurisdictionIdentityRef(replica.state.config.jurisdiction);
  const quoteAuthority = supportPeerIdentities.find(peer => peer.jurisdictionRef === jurisdictionRef);
  if (!quoteAuthority) {
    throw new Error(`ORDERBOOK_USD_QUOTE_AUTHORITY_MISSING:${jurisdictionRef}`);
  }

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
              usdQuoteAuthorityEntityId: quoteAuthority.entityId,
              minTradeSize: HUB_DEFAULT_MIN_TRADE_SIZE,
              supportedPairs: [...HUB_DEFAULT_SUPPORTED_PAIRS],
            },
          },
        ],
      },
    ],
  });
  // A rejected init (for example a bad quote authority) must stop the boot,
  // not leave a hub serving without an orderbook until the next restart.
  if (!await waitForRuntimeWorkDrained(env, ORDERBOOK_INIT_DRAIN_TIMEOUT_MS, 0)) {
    throw new Error(`ORDERBOOK_INIT_DRAIN_TIMEOUT:${entityId}`);
  }
  if (!getEntityReplicaById(env, entityId)?.state.orderbookExt) {
    throw new Error(`ORDERBOOK_INIT_NOT_COMMITTED:${entityId}`);
  }
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
  configuredContracts?: JurisdictionConfig['contracts'],
): ImportedJurisdictionContracts => {
  const replica = env.state.jReplicas?.get(jurisdictionName);
  const depositoryAddress = String(
    replica?.contracts?.depository || configuredContracts?.depository || '',
  ).trim();
  const entityProviderAddress = String(
    replica?.contracts?.entityProvider || configuredContracts?.entityProvider || '',
  ).trim();
  const chainId = Number(replica?.chainId);
  return {
    ...(Number.isFinite(chainId) && chainId > 0
      ? { chainId: Math.floor(chainId) }
      : {}),
    ...(depositoryAddress ? { depositoryAddress } : {}),
    ...(entityProviderAddress ? { entityProviderAddress } : {}),
  };
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
    disputeAutoFinalizeMode: resolvedArgs.manualDisputeFinalize ? 'ignore' : 'auto',
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

const hubReserveDeps: HubReserveDeps = {
  hubName: resolvedArgs.name,
  deployTokens: resolvedArgs.deployTokens,
  tokenCatalogsByEntityId,
  startTiming,
  finishTiming,
};

const getEntityJurisdiction = (env: RuntimeReplica, entityId: string | null): unknown | null => {
  if (!entityId) return null;
  const replica = getEntityReplicaById(env, entityId);
  return replica?.state?.config?.jurisdiction ?? null;
};

const directHubPeersReady = (env: RuntimeReplica, peers: HubMeshPeer<VisibleHubProfile>[]): boolean =>
  getP2P(env)?.prepareDirectEntityRoutes(peers.map(peer => peer.identity.entityId)) ?? false;

const buildLocalHealth = (
  env: RuntimeReplica,
  entityId: string | null,
  tokenCatalog: JTokenInfo[],
  jadapter: JAdapter | null,
  hubEntities: HubBootstrapEntry[],
  bootstrapProgress: BootstrapProgressHealth,
): LocalHealthResponse => {
  const runtimeHalted = env.infrastructure?.halted === true;
  const selfJurisdictionName = getEntityJurisdictionName(env, entityId);
  const selfJurisdiction = getEntityJurisdiction(env, entityId) || selfJurisdictionName;
  const mesh = bindHubMesh(meshHubIdentities, selfJurisdiction, entityId ?? '', readVisibleHubProfiles(env, selfJurisdiction));
  const pairs = entityId ? buildPairHealth(env, entityId, mesh.configuredPeers) : [];
  const meshReady = Boolean(entityId) && hubMeshReady(mesh, pairs);

  return {
    ok: !runtimeHalted && meshReady,
    name: resolvedArgs.name,
    height: Math.max(0, Math.floor(Number(env.state.height || 0))),
    entityId,
    runtimeId: String(env.runtimeId || '') || null,
    relayUrl: resolvedArgs.relayUrl,
    directWsUrl,
    apiUrl,
    runtime: {
      halted: runtimeHalted,
      operatorStatus: env.infrastructure?.operatorStatus ?? null,
      lifecyclePhase: env.infrastructure?.lifecyclePhase ?? null,
      fatalDebugPayload: env.infrastructure?.fatalDebugPayload ?? null,
      securityIncidents: readRuntimeSecurityIncidentTelemetry(env),
    },
    quiescence: summarizeRuntimeQuiescence(env),
    p2p: {
      directPeers: getP2PState(env).directPeers || [],
    },
    gossip: {
      visibleHubNames: mesh.visibleHubs.map(hub => hub.name),
      visibleHubIds: mesh.visibleHubs.map(hub => hub.entityId),
      ready: mesh.gossipReady,
    },
    mesh: {
      ready: meshReady,
      pairs,
    },
    bootstrapProgress,
    bootstrapReserves: buildHubBootstrapReserveHealth(hubReserveDeps, env, entityId, tokenCatalog, hubEntities),
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
  input.markProgress('local-reserve-funding');
  const health = await ensureHubBootstrapReserves(
    hubReserveDeps,
    input.env,
    input.hubBootstraps,
    step => input.markProgress(`local-reserve:${step}`),
  );
  return health.targetMet === true;
};

const advanceHubMeshBootstrap = async (
  input: HubMeshBootstrapInput,
): Promise<boolean> => {
  const jurisdiction =
    getEntityJurisdiction(input.env, input.bootstrap.entityId) ||
    getEntityJurisdictionName(input.env, input.bootstrap.entityId) ||
    input.jurisdiction;
  const mesh = bindHubMesh(
    meshHubIdentities,
    jurisdiction,
    input.bootstrap.entityId,
    readVisibleHubProfiles(input.env, jurisdiction),
  );
  if (mesh.ownerIndex < 0) throw new Error(`HUB_MESH_OWNER_UNCONFIGURED:${input.bootstrap.entityId}`);
  if (!input.milestones.gossipReady && mesh.gossipReady) {
    finishTiming(
      'gossip_ready',
      startedAtFor('gossip_ready') ?? startTiming('gossip_ready'),
    );
    input.milestones.gossipReady = true;
  } else if (!input.milestones.gossipReady) {
    startTiming('gossip_ready');
  }
  if (!mesh.gossipReady) return false;

  const peers = mesh.visiblePeers;
  input.markProgress('direct-peers');
  // Never commit Account-producing bootstrap commands before their one
  // authenticated route is open. Proceeding after a grace period used to send
  // the same financial envelope through a different router, where an async
  // target-not-connected rejection could disappear after the sender WAL commit.
  if (!directHubPeersReady(input.env, peers)) return false;
  const { openInputs, creditInputs } = planMeshBootstrapInputs(
    input.env,
    input.bootstrap,
    input.hubBootstraps,
    mesh.ownerIndex,
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
  const accountReady = peers.every(({ identity: peer }) =>
    hasAccount(input.env, input.bootstrap.entityId, peer.entityId) &&
    DEFAULT_ACCOUNT_TOKEN_IDS.every(tokenId =>
      Boolean(
        getAccountReplica(
          input.env,
          input.bootstrap.entityId,
          peer.entityId,
        )?.state.deltas.get(tokenId),
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
  const creditReady = peers.every(({ identity: peer }) =>
    hasPairMutualCredits(
      input.env,
      input.bootstrap.entityId,
      peer.entityId,
      DEFAULT_ACCOUNT_TOKEN_IDS,
      getBootstrapCreditAmount,
    ),
  );
  if (!creditReady) return false;
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
  if (!input.milestones.reserveReady) return false;
  // Faucet serves users on this hub. Market-maker support peers are optional
  // (isolated e2e and MM-off meshes never spawn them). Gating ETH/token
  // provision on those peers left the faucet wallet at 0 and 500'd /api/faucet.
  if ((timings['mesh_ready_total']?.ms ?? null) === null) {
    input.markProgress('external-faucet-provision');
    await input.ensureFaucetReady();
    finishTiming('mesh_ready_total', input.totalStartedAt);
  }
  const supportReady = supportPeerProvisioningReady(
    input.env,
    input.hubBootstraps,
    supportPeerIdentities,
  );
  if (!supportReady) return false;
  return input.milestones.gossipReady &&
    input.milestones.accountsReady &&
    input.milestones.creditReady;
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
    getJAdapter: (entityId, jurisdiction) => jurisdiction
      ? getLiveJAdapter(live.env, jurisdiction) ?? null
      : entityId ? getEntityJAdapter(live.env, entityId) : live.activeJAdapter,
    getRuntimeId: () => String(live.env.runtimeId || ''),
    getTokenCatalog: async (entityId, jurisdiction) => {
      if (jurisdiction) {
        const adapter = getLiveJAdapter(live.env, jurisdiction);
        if (!adapter) throw new Error(`FAUCET_JURISDICTION_UNAVAILABLE:${jurisdiction}`);
        return adapter.getTokenRegistry();
      }
      if (!entityId) return requireHubTokenCatalog(live);
      const adapter = getEntityJAdapter(live.env, entityId);
      if (!adapter) throw new Error('EXTERNAL_WALLET_ENTITY_J_ADAPTER_MISSING');
      return adapter.getTokenRegistry();
    },
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
            persistencePaused: Boolean(live.env.infrastructure?.persistencePaused),
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
  directRuntimeWs: ReturnType<typeof createHubDirectRuntimeRoute>;
};

const startHubHttpSurface = (
  live: HubNodeLiveContext,
  faucetRelayStore: ReturnType<typeof createRelayStore>,
  brainVaultOwner: BrainVaultOwnerController,
  pauseBootstrap: () => Promise<() => void>,
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
    () => live.externalIngressReady,
    brainVaultOwner,
    () => live.brainVaultReady,
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
  const stackManagerController = createStackManagerController({
    parseBody: parseTaggedControlBody,
    headers: JSON_HEADERS,
  });
  const context: HubHttpContext = {
    env: live.env,
    hubBootstraps: live.hubBootstraps,
    externalWalletApi,
    faucetRelayStore,
    getBootstrap: () => live.bootstrap,
    getJAdapter: () => live.activeJAdapter,
    ensureTokenCatalog: () => requireHubTokenCatalog(live),
    getDirectInputDebug: () => ({ ...directInputDebug }),
    getDirectRuntimeSessions: directRuntimeWs.getSessionState,
    handleStatus: createHubStatusHandler(live, bootstrapClockMs),
    handleControl,
    handleJurisdictions: url => handleHubJurisdictionsRequest(live.env, url),
    stackManagerController,
  };
  const server = Bun.serve<NonNullable<HubServerSocket['data']>>({
    hostname: resolvedArgs.apiHost,
    port: resolvedArgs.apiPort,
    idleTimeout: 120,
    maxRequestBodySize: 1024 * 1024,
    async fetch(request, serverRef) {
      const releaseHttp = httpDrain.begin();
      try {
        const url = new URL(request.url);
        const operatorAuthorized = isLocalOperatorRequest(
          request,
          resolveSocketPeerAddress(serverRef, request),
        ) || hasDaemonControlAuth(request, live.env);
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
      maxPayloadLength: directRuntimeWs.websocket.maxPayloadLength,
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
      drain(ws: HubServerSocket) {
        if (ws.data?.type !== 'rpc') directRuntimeWs.websocket.drain(ws);
      },
      close(ws: HubServerSocket, code: number, reason: string) {
        if (ws.data?.type === 'rpc') {
          forgetRuntimeAdapterClient(ws);
          return;
        }
        directRuntimeWs.websocket.close(ws, code, reason);
      },
    },
  });
  return { server, httpDrain, externalWalletApi, directInputDebug, directRuntimeWs };
};

type HubMeshBootstrapController = {
  pauseAndWait(): Promise<() => void>;
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
  let pauseLeaseCount = 0;
  let resumeDrive: (() => void) | null = null;

  const pauseAndWait = async (): Promise<() => void> => {
    pauseLeaseCount += 1;
    paused = true;
    if (loop) {
      clearInterval(loop);
      loop = null;
    }
    // Unbounded wait here previously left orphaned hub-nodes holding E2E ports
    // after SIGTERM: meshLoopInFlight can stick if advanceHubMeshBootstrap never
    // returns, and the parent only SIGKILLs after its own graceful window.
    const deadline = Date.now() + MESH_PRODUCER_PAUSE_TIMEOUT_MS;
    while (live.meshLoopInFlight && Date.now() < deadline) await sleep(100);
    if (live.meshLoopInFlight) {
      nodeLog.error('mesh_producer.pause_timeout', {
        name: resolvedArgs.name,
        timeoutMs: MESH_PRODUCER_PAUSE_TIMEOUT_MS,
        progress: live.meshLoopProgress,
      });
      // Fail closed: the producer stays paused because exporting a checkpoint
      // across an active producer would bind a root to the wrong WAL boundary.
      throw new Error('MESH_PRODUCER_PAUSE_TIMEOUT');
    }
    let released = false;
    return () => {
      if (released) throw new Error('MESH_PRODUCER_PAUSE_LEASE_ALREADY_RELEASED');
      released = true;
      pauseLeaseCount -= 1;
      if (pauseLeaseCount < 0) throw new Error('MESH_PRODUCER_PAUSE_LEASE_UNDERFLOW');
      if (pauseLeaseCount > 0 || live.shuttingDown || fatal) return;
      paused = false;
      resumeDrive?.();
    };
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
      // Every Hub exposes the faucet API and derives its own faucet signer.
      // H1 creates the shared token catalog, while H2/H3 wait for it above;
      // limiting funding to --deploy-tokens left their valid API unfunded.
      if (!AUTO_PROVISION_EXTERNAL_FAUCET || !canDeployHubDefaultTokens(jurisdiction.chainId)) return;
      faucetProvision ??= (async () => {
        // The same faucet signer needs gas and tokens on every served chain.
        for (const entry of live.hubBootstraps) {
          const adapter = getLiveJAdapter(live.env, entry.jurisdictionName);
          if (!adapter) throw new Error(`FAUCET_JURISDICTION_UNAVAILABLE:${entry.jurisdictionName}`);
          if (canDeployHubDefaultTokens(adapter.chainId)) {
            await externalWalletApi.provisionFaucetWallet(entry.jurisdictionName);
          }
        }
        if (!live.shuttingDown) nodeLog.info('faucet_provision.ready', { name: resolvedArgs.name });
      })();
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
        const complete = await advanceHubMeshBootstrap({
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
        if (complete) {
          markProgress('complete');
          live.p2p?.finishBootstrapPolling();
          if (loop) clearInterval(loop);
          loop = null;
        }
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
    const schedule = (): void => {
      if (live.shuttingDown || fatal || paused || loop) return;
      loop = setInterval(() => {
        if (!live.shuttingDown && !fatal && !paused) void drive().catch(handleFatal);
      }, BOOTSTRAP_POLL_MS);
      void drive().catch(handleFatal);
    };
    resumeDrive = schedule;
    schedule();
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
    dumpRuntimeSamplingProfile('shutdown');
    dumpOpCounters(resolvedArgs.name, 'shutdown');
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

  configureCryptoPoolEntry(new URL('../protocol/crypto/crypto-pool.ts', import.meta.url));
  await startRuntimeSamplingProfiler(resolvedArgs.name);
  await installGlobalOpCounters(resolvedArgs.name);
  const runtimeBootStartedAt = startTiming('runtime_boot');
  const localSignerLabels = buildLocalHubSignerLabels();
  const brainVaultOwner = createHubBrainVaultOwner();
  await brainVaultOwner.prewarm(resolvedArgs.seed);
  const env = await main(resolvedArgs.seed, {
    localSigners: localSignerLabels.map(label => ({ label })),
    trustedJurisdictionRpcBindings: resolveMeshJurisdictionRpcBindings(
      resolvedArgs.rpcUrl,
      resolveLocalApiUrl,
    ),
  });
  setRuntimeDeliveryReady(env, false);
  nodeLog.info('signer_keys.ready', { name: resolvedArgs.name, count: localSignerLabels.length });
  if (restoredRuntimeRouteRelocated(env.gossip.getProfiles(), {
    runtimeId: String(env.runtimeId || ''),
    wsUrl: directWsUrl,
    relayUrls: [resolvedArgs.relayUrl],
  })) {
    await clearGossip(env, { runtimeId: String(env.runtimeId || '') });
    nodeLog.info('gossip.relocated_route_cache_cleared', { wsUrl: directWsUrl });
  }
  const faucetRelayStore = createRelayStore(`${resolvedArgs.name}-faucet`);
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
    brainVaultReady: false,
    shuttingDown: false,
    meshLoopProgress: beginBootstrapProgress(getPerfMs()),
    meshLoopInFlight: false,
  };
  // Bootstrap liveness measures elapsed process time, not civil time. Date.now
  // can move backwards under NTP and previously killed every hub at once.
  const bootstrapClockMs = (): number => getPerfMs();
  live.meshLoopProgress = beginBootstrapProgress(bootstrapClockMs());
  const meshController = createHubMeshBootstrapController(live, bootstrapClockMs);
  const p2pConnectStartedAt = startTiming('p2p_connect');
  live.p2p = startP2P(env, {
    relayUrls: [resolvedArgs.relayUrl],
    wsUrl: directWsUrl,
    advertiseEntityIds: [...new Set([...env.state.eReplicas.values()].map(replica => replica.entityId))],
    gossipPollMs: BOOTSTRAP_POLL_MS * 5,
    gossipSet: 'default',
  });
  if (!live.p2p) throw new Error('P2P_START_FAILED');
  finishTiming('p2p_connect', p2pConnectStartedAt);
  const httpSurface = startHubHttpSurface(
    live,
    faucetRelayStore,
    brainVaultOwner,
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
  live.p2p.updateConfig({ advertiseEntityIds: live.hubBootstraps.map(entry => entry.entityId) });
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
  await restoreHubBrainVaultOwner(live, brainVaultOwner);
  await ensurePendingNumberedRegistrationsResumed(env);
  live.externalIngressReady = true;
  setRuntimeDeliveryReady(env, true);
  httpSurface.directRuntimeWs.setReady(true);
  nodeLog.info('startup.j_catchup_ready', {
    jurisdictions: watcherDrain.length,
    cursors: watcherDrain.map(status => `${status.chainId}:${status.committedCursor}/${status.targetBlock}`),
  });

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
