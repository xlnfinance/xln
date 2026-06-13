#!/usr/bin/env bun

import { ethers, getIndexedAccountPath, HDNodeWallet, Mnemonic } from 'ethers';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  ContractRunner as JurisdictionContractRunner,
  Signer as JurisdictionSigner,
} from 'ethers';
import { ERC20Mock__factory } from '../../jurisdictions/typechain-types/index.ts';
import { createExternalWalletApi } from '../api/external-wallet-api';
import { createDirectRuntimeWsRoute, type DirectWebSocket } from '../networking/direct-runtime-bun';
import { bootstrapHub } from '../../scripts/bootstrap-hub';
import { DEFAULT_TOKEN_SUPPLY, TOKEN_REGISTRATION_AMOUNT, defaultTokensForJurisdiction } from '../jadapter/default-tokens';
import type { JAdapter, JTokenInfo } from '../jadapter/types';
import { resolveJurisdictionsJsonPath } from '../jurisdictions-path';
import { DEFAULT_SPREAD_DISTRIBUTION } from '../orderbook';
import {
  buildMarketSnapshotForReplica,
  normalizeMarketEntityId,
  normalizeMarketPairId,
  RPC_MARKET_DEFAULT_DEPTH,
  RPC_MARKET_MAX_DEPTH,
} from '../market-snapshot';
import { toPublicRpcUrl } from '../loopback-url';
import { startParentLivenessWatch } from './parent-watch';
import { createHttpDrainTracker, stopServerGracefully } from './graceful-server';
import { applyJEventsToEnv } from '../jadapter/watcher';
import { safeStringify } from '../serialization-utils';
import { createStructuredLogger } from '../logger';
import { handleMeshBootstrapLoopError } from './mesh-bootstrap-fail-fast';
import { isLocalOperatorRequest, publicLocalHubHealth } from '../health-redaction';
import { decodeRuntimeAdapterMessage } from '../radapter/codec';
import { getJReplicaByJurisdictionRef } from '../jurisdiction-runtime';
import {
  attachRuntimeAdapterTicker,
  closeInvalidRuntimeAdapterMessage,
  forgetRuntimeAdapterClient,
  handleRuntimeAdapterMessage,
  type RuntimeAdapterSocket,
} from '../radapter/server';
import {
  handleLendingBorrowRequest,
  handleLendingOfferRequest,
  handleLendingRepayRequest,
  handleLendingStateRequest,
} from '../server/lending';
import {
  getActiveJAdapter,
  getP2PState,
  closeInfraDb,
  closeRuntimeDb,
  main,
  process as runtimeProcess,
  enqueueRuntimeInput,
  handleInboundP2PEntityInput,
  resolveEntityProposerId,
  startP2P,
  stopP2P,
  startRuntimeLoop,
  stopRuntimeLoopAndWait,
  getEntityJAdapter,
  readPersistedStorageFrameRecord,
  readPersistedStorageHead,
  listPersistedCheckpointHeights,
  loadEntityAccountDocFromStorageDb,
  loadEntityStateFromStorageDb,
  loadEntityViewPageFromStorageDb,
  listPersistedEntityIdsAtHeight,
  registerEnvChangeCallback,
} from '../runtime.ts';
import type { EntityInput, Env } from '../types';
import {
  hasPendingRuntimeWork,
  BOOTSTRAP_POLL_MS,
  DEFAULT_ACCOUNT_TOKEN_IDS,
  getAccountMachine,
  getCreditGrantedByEntity,
  getEntityOutCapacity,
  getEntityReplicaById,
  HUB_DEFAULT_MIN_TRADE_SIZE,
  HUB_DEFAULT_SUPPORTED_PAIRS,
  HUB_MESH_CREDIT_AMOUNT,
  HUB_MESH_TOKEN_ID,
  HUB_REQUIRED_TOKEN_COUNT,
  HUB_RESERVE_TARGET_UNITS,
  hasAccount,
  hasQueuedOpenAccount,
  hasPairMutualCredits,
  settleRuntimeFor,
  sleep,
  waitUntil,
} from './mesh-common';
import {
  requireJurisdictionBlockTimeMs,
  resetMeshJurisdictionsCache,
  resolveMeshJurisdictionConfig,
  resolveSecondaryJurisdictions,
  type MeshJurisdictionConfig,
} from './mesh-jurisdictions';

type HubServerSocket = DirectWebSocket & RuntimeAdapterSocket & { data?: { type?: string } };

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
  meshHubNames: string[];
  supportPeerIdentitiesJson: string;
  dbPath: string;
  deployTokens: boolean;
};

type SupportPeerIdentity = {
  name: string;
  entityId: string;
  signerId: string;
  creditAmount: bigint;
};

type HubPairHealth = {
  counterpartyId: string;
  counterpartyName: string;
  hasAccount: boolean;
  grantedByMe: string;
  grantedByPeer: string;
  ready: boolean;
};

type VisibleHubProfile = {
  name: string;
  entityId: string;
  jurisdictionName: string;
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

type LocalHealthResponse = {
  ok: boolean;
  name: string;
  entityId: string | null;
  runtimeId: string | null;
  relayUrl: string;
  directWsUrl?: string;
  apiUrl: string;
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

type JurisdictionConfig = MeshJurisdictionConfig;

type JurisdictionsFile = {
  version?: string;
  deployVersion?: string;
  networkVersion?: string;
  lastUpdated?: string;
  jurisdictions?: Record<string, {
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

const PRIMARY_TESTNET_JURISDICTION_NAME = 'Testnet';

const normalizeJurisdictionDisplayName = (value: unknown): string => {
  const name = String(value || '').trim();
  const normalized = name.toLowerCase();
  if (
    normalized === 'arrakis'
    || normalized === 'arrakis (shared anvil)'
    || normalized === 'shared anvil'
    || normalized === 'wakanda'
  ) {
    return PRIMARY_TESTNET_JURISDICTION_NAME;
  }
  return name;
};

type JurisdictionImportDiagnostics = {
  name: string;
  rpc: string;
  chainId: number;
  deployTokens: boolean;
  inputContracts: boolean;
  usedContracts: boolean;
  probeRan: boolean;
  missingCode: string[];
  mode: 'no-contracts' | 'connect-existing' | 'deploy-fresh' | 'dropped-stale';
};

const argsRaw = process.argv.slice(2);

const getArg = (name: string, fallback = ''): string => {
  const eq = argsRaw.find(arg => arg.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const index = argsRaw.indexOf(name);
  if (index === -1) return fallback;
  return argsRaw[index + 1] || fallback;
};

const hasFlag = (name: string): boolean => argsRaw.includes(name);

const parseArgs = (): Args => {
  const apiPort = Number(getArg('--api-port', '0'));
  if (!Number.isFinite(apiPort) || apiPort <= 0) {
    throw new Error(`Invalid --api-port: ${String(apiPort)}`);
  }

  return {
    name: getArg('--name', 'H1'),
    region: getArg('--region', 'global'),
    seed: getArg('--seed', 'xln-e2e-hub'),
    signerLabel: getArg('--signer-label', 'hub-1'),
    relayUrl: getArg('--relay-url', 'ws://127.0.0.1:20002/relay'),
    apiHost: getArg('--api-host', '127.0.0.1'),
    apiPort,
    directWsUrl: getArg('--direct-ws-url', ''),
    rpcUrl: getArg('--rpc-url', ''),
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
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => ({
      name: String(entry?.name || '').trim(),
      entityId: String(entry?.entityId || '').trim().toLowerCase(),
      signerId: String(entry?.signerId || '').trim().toLowerCase(),
      creditAmount: BigInt(String(entry?.creditAmount || HUB_MESH_CREDIT_AMOUNT)),
    })).filter((entry) => entry.name && entry.entityId && entry.signerId && entry.creditAmount > 0n);
  } catch {
    return [];
  }
};

const resolvedArgs = parseArgs();
const supportPeerIdentities = parseSupportPeerIdentities(resolvedArgs.supportPeerIdentitiesJson);
const apiUrl = `http://${resolvedArgs.apiHost}:${resolvedArgs.apiPort}`;
const resolveLocalApiUrl = (value: string): string => {
  const raw = String(value || '').trim();
  if (!raw.startsWith('/')) return raw;
  if (raw === '/rpc2' || raw.startsWith('/rpc2?') || raw.startsWith('/api/rpc2')) {
    const rpc2 = String(process.env['ANVIL_RPC2'] || process.env['RPC_TRON'] || '').trim();
    if (rpc2) return rpc2;
  }
  if (raw === '/rpc' || raw.startsWith('/rpc?') || raw.startsWith('/api/rpc')) {
    const rpc = String(process.env['ANVIL_RPC'] || resolvedArgs.rpcUrl || '').trim();
    if (rpc) return rpc;
  }
  return new URL(raw, apiUrl).toString();
};
const directWsUrl = String(resolvedArgs.directWsUrl || '').trim();
if (!directWsUrl) {
  throw new Error(`[MESH-HUB] Missing required --direct-ws-url for ${resolvedArgs.name}`);
}
const nodeLog = createStructuredLogger('mesh.hub', { hub: resolvedArgs.name });
let jurisdictionImportDiagnostics: JurisdictionImportDiagnostics | null = null;

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
  resolveMeshJurisdictionConfig<JurisdictionConfig>(rpcUrlOverride);

const REQUIRED_RPC_CONTRACT_KEYS = ['account', 'depository', 'entityProvider', 'deltaTransformer'] as const;

const findMissingRpcContractCode = async (
  rpcUrl: string,
  contracts: JurisdictionConfig['contracts'],
): Promise<string[]> => {
  if (!contracts) return ['contracts'];
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const missing: string[] = [];
  for (const key of REQUIRED_RPC_CONTRACT_KEYS) {
    const address = String(contracts[key] || '').trim();
    if (!address) {
      missing.push(`${key}:missing`);
      continue;
    }
    const code = await provider.getCode(address);
    if (!code || code === '0x') missing.push(`${key}:${address}`);
  }
  return missing;
};

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

  // H1 is the dev/testnet deployer. If an isolated anvil starts from an empty
  // state file while jurisdictions.json still contains canonical hardhat
  // addresses, connect-only importJ would bind to dead contracts and kill the
  // hub before it can bootstrap. Drop those stale addresses and let importJ
  // deploy a fresh stack; ensureRpcStackReady writes the resulting addresses
  // back for H2/H3/MM.
  console.warn(
    `[${resolvedArgs.name}] RPC contracts have no code; deploying fresh stack instead of using stale addresses: ` +
      missingCode.join(', '),
  );
  jurisdictionImportDiagnostics.usedContracts = false;
  jurisdictionImportDiagnostics.mode = 'dropped-stale';
  const { contracts: _staleContracts, ...withoutContracts } = jurisdiction;
  return withoutContracts;
};

const resolveJurisdictionPaths = (): string[] => {
  return [resolveJurisdictionsJsonPath()];
};

const readCurrentJurisdictionsVersion = (): string => {
  for (const filePath of resolveJurisdictionPaths()) {
    if (!existsSync(filePath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as JurisdictionsFile;
      const version = String(parsed.version || '').trim();
      if (version) return version;
    } catch {
      // Ignore malformed local file and keep falling back.
    }
  }
  return '1';
};

const readCurrentNetworkVersion = (): string => {
  for (const filePath of resolveJurisdictionPaths()) {
    if (!existsSync(filePath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as JurisdictionsFile;
      const explicit = String(parsed.deployVersion || parsed.networkVersion || '').trim();
      if (explicit) return explicit;
      const lastUpdated = Date.parse(String(parsed.lastUpdated || ''));
      if (Number.isFinite(lastUpdated)) return String(lastUpdated);
    } catch {
      // Ignore malformed local file and keep falling back.
    }
  }
  return readCurrentJurisdictionsVersion();
};

const writeJurisdictionAddresses = async (jadapter: JAdapter, rpcUrl: string): Promise<void> => {
  if (!jadapter.addresses?.depository || !jadapter.addresses?.entityProvider) {
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
    const targetKey = 'arrakis';
    const previous = jurisdictions[targetKey] ?? {};
    jurisdictions[targetKey] = {
      ...previous,
      name: normalizeJurisdictionDisplayName(previous.name) || PRIMARY_TESTNET_JURISDICTION_NAME,
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

const syncEnvJurisdictionReplica = (env: Env, jadapter: JAdapter, rpcUrl: string): void => {
  const activeName = env.activeJurisdiction || Array.from(env.jReplicas?.keys?.() || [])[0];
  if (!activeName) return;
  const replica = env.jReplicas?.get(activeName);
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

const buildRuntimeJurisdictionsPayload = (env: Env): string | null => {
  const activeName = env.activeJurisdiction || Array.from(env.jReplicas?.keys?.() || [])[0];
  if (!activeName) return null;
  const replica = env.jReplicas?.get(activeName) as
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
  const depository =
    String(addresses.depository || replica.depositoryAddress || replica.contracts?.depository || '').trim();
  const entityProvider =
    String(addresses.entityProvider || replica.entityProviderAddress || replica.contracts?.entityProvider || '').trim();
  if (!depository || !entityProvider) return null;

  const version = readCurrentJurisdictionsVersion();
  const networkVersion = readCurrentNetworkVersion();
  return JSON.stringify({
    version,
    deployVersion: networkVersion,
    networkVersion,
    lastUpdated: new Date().toISOString(),
    jurisdictions: {
      arrakis: {
        name: normalizeJurisdictionDisplayName(replica.name || activeName) || PRIMARY_TESTNET_JURISDICTION_NAME,
        chainId: Number(replica.chainId || 31337),
        rpc: toPublicRpcUrl(String(replica.rpcs?.[0] || resolvedArgs.rpcUrl || '/rpc')),
        contracts: {
          account: String(addresses.account || replica.contracts?.account || ''),
          depository,
          entityProvider,
          deltaTransformer: String(addresses.deltaTransformer || replica.contracts?.deltaTransformer || ''),
        },
      },
    },
  });
};

const ensureRpcStackReady = async (env: Env, jadapter: JAdapter): Promise<void> => {
  if (jadapter.mode === 'browservm') return;
  const hasAddresses = Boolean(jadapter.addresses?.depository && jadapter.addresses?.entityProvider);
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
  if (!resolvedArgs.deployTokens) {
    throw new Error('RPC_STACK_ADDRESSES_MISSING');
  }
  console.log(`[${resolvedArgs.name}] deploying fresh RPC contract stack`);
  if (jurisdictionImportDiagnostics) {
    jurisdictionImportDiagnostics.usedContracts = false;
    jurisdictionImportDiagnostics.mode = 'deploy-fresh';
  }
  await jadapter.deployStack();
  syncEnvJurisdictionReplica(env, jadapter, resolvedArgs.rpcUrl);
  await writeJurisdictionAddresses(jadapter, resolvedArgs.rpcUrl);
};

const deployDefaultTokensOnRpc = async (jadapter: JAdapter, jurisdictionName = ''): Promise<void> => {
  if (jadapter.mode === 'browservm') return;
  const existing = await jadapter.getTokenRegistry().catch(() => []);
  const existingSymbols = new Set(
    existing
      .map(token => String(token.symbol || '').trim().toUpperCase())
      .filter(symbol => symbol.length > 0),
  );

  const depositoryAddress = jadapter.addresses?.depository;
  if (!depositoryAddress) {
    throw new Error('TOKEN_DEPLOY_DEPOSITORY_MISSING');
  }

  const desiredTokens = defaultTokensForJurisdiction({
    name: jurisdictionName,
    chainId: Number((jadapter as { chainId?: number }).chainId),
  });
  console.log(`[${resolvedArgs.name}] deploying default tokens on dev chain: ${desiredTokens.map(token => token.symbol).join(',')}`);
  const signer = jadapter.signer as unknown as JurisdictionSigner;
  const erc20Factory = new ERC20Mock__factory(signer);
  for (const token of desiredTokens) {
    if (existingSymbols.has(String(token.symbol || '').trim().toUpperCase())) {
      continue;
    }
    const tokenContract = await erc20Factory.deploy(token.name, token.symbol, DEFAULT_TOKEN_SUPPLY);
    await tokenContract.waitForDeployment();
    const tokenAddress = await tokenContract.getAddress();

    const approveTx = await tokenContract.approve(depositoryAddress, TOKEN_REGISTRATION_AMOUNT);
    await approveTx.wait();

    const registerTx = await jadapter.depository.connect(signer as unknown as JurisdictionContractRunner).adminRegisterExternalToken({
      entity: ethers.ZeroHash,
      contractAddress: tokenAddress,
      externalTokenId: 0,
      tokenType: 0,
      internalTokenId: 0,
      amount: TOKEN_REGISTRATION_AMOUNT,
    });
    await registerTx.wait();
    console.log(`[${resolvedArgs.name}] token registered ${token.symbol} -> ${tokenAddress}`);
  }
};

const ensureTokenCatalog = async (jadapter: JAdapter, allowDeploy: boolean, jurisdictionName = ''): Promise<JTokenInfo[]> => {
  const current = await jadapter.getTokenRegistry().catch(() => []);
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
    await deployDefaultTokensOnRpc(jadapter, jurisdictionName);
    return await waitForTokenCatalog(jadapter);
  }
  return [];
};

const waitForTokenCatalog = async (jadapter: JAdapter, rounds = 80): Promise<JTokenInfo[]> => {
  for (let i = 0; i < rounds; i += 1) {
    const tokens = await jadapter.getTokenRegistry().catch(() => []);
    if (tokens.length >= HUB_REQUIRED_TOKEN_COUNT) return tokens;
    await sleep(250);
  }
  throw new Error(`TOKEN_CATALOG_INCOMPLETE required=${HUB_REQUIRED_TOKEN_COUNT}`);
};

const ensureOrderbook = async (env: Env, entityId: string, signerId: string): Promise<void> => {
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

const resolveRuntimeWaitPollMs = (): number => 25;
const resolveReserveWaitPollMs = (): number => 50;

const waitForRuntimeIdle = async (env: Env, timeoutMs = 5000): Promise<boolean> => {
  const started = Date.now();
  const pollMs = resolveRuntimeWaitPollMs();
  while (Date.now() - started < timeoutMs) {
    if (!hasPendingRuntimeWork(env)) return true;
    await sleep(pollMs);
  }
  return false;
};

const waitForJBatchClear = async (env: Env, timeoutMs = 5000): Promise<boolean> => {
  const started = Date.now();
  const pollMs = resolveRuntimeWaitPollMs();
  while (Date.now() - started < timeoutMs) {
    const pendingJ = Array.from(env.jReplicas?.values?.() || []).some(j => (j.mempool?.length ?? 0) > 0);
    if (!pendingJ && !hasPendingRuntimeWork(env)) return true;
    await sleep(pollMs);
  }
  return false;
};

const hasEntitySentBatchPending = (env: Env, entityId: string): boolean => {
  const replica = getEntityReplicaById(env, entityId);
  return Boolean(replica?.state?.jBatchState?.sentBatch);
};

const waitForEntityBroadcastWindow = async (
  env: Env,
  entityId: string,
  timeoutMs = 10000,
): Promise<boolean> => {
  const started = Date.now();
  const pollMs = resolveRuntimeWaitPollMs();
  while (Date.now() - started < timeoutMs) {
    if (!hasEntitySentBatchPending(env, entityId)) return true;
    await sleep(pollMs);
  }
  return false;
};

const waitForReserveUpdate = async (
  jadapter: JAdapter,
  entityId: string,
  tokenId: number,
  expectedMin: bigint,
  timeoutMs = 10000,
): Promise<bigint | null> => {
  const started = Date.now();
  const pollMs = resolveReserveWaitPollMs();
  while (Date.now() - started < timeoutMs) {
    try {
      const current = await jadapter.getReserves(entityId, tokenId);
      if (current >= expectedMin) return current;
    } catch {}
    await sleep(pollMs);
  }
  return null;
};

const tokenCatalogsByEntityId = new Map<string, JTokenInfo[]>();

const normalizeEntityId = (entityId: string): string => String(entityId || '').trim().toLowerCase();

const requireJAdapterForEntity = (env: Env, entityId: string, purpose: string): JAdapter => {
  const adapter = getEntityJAdapter(env, entityId);
  if (!adapter) {
    throw new Error(`${purpose}_JADAPTER_MISSING: entity=${entityId}`);
  }
  return adapter;
};

const requireJAdapterForDebugReserve = (
  env: Env,
  entityId: string,
  jurisdictionRef: string,
): JAdapter => {
  const explicitJurisdiction = String(jurisdictionRef || '').trim();
  if (explicitJurisdiction) {
    const jReplica = getJReplicaByJurisdictionRef(env, explicitJurisdiction);
    const adapter = jReplica?.jadapter;
    if (!adapter) {
      throw new Error(`DEBUG_RESERVE_JURISDICTION_UNAVAILABLE: entity=${entityId} jurisdiction=${explicitJurisdiction}`);
    }
    return adapter;
  }
  return requireJAdapterForEntity(env, entityId, 'DEBUG_RESERVE');
};

const getReserveHealth = (env: Env, entityId: string, tokenCatalog: JTokenInfo[]): LocalHealthResponse['bootstrapReserves'] => {
  const replica = getEntityReplicaById(env, entityId);
  const tokens = tokenCatalog.slice(0, HUB_REQUIRED_TOKEN_COUNT).map(token => {
    const tokenId = Number(token.tokenId);
    const decimals = Number.isFinite(token.decimals) ? Number(token.decimals) : 18;
    const current = replica?.state?.reserves?.get(tokenId) ?? 0n;
    const expectedMin = HUB_RESERVE_TARGET_UNITS * 10n ** BigInt(decimals);
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

const syncReserveSnapshotFromChain = async (
  env: Env,
  entityId: string,
  tokenCatalog: JTokenInfo[],
): Promise<LocalHealthResponse['bootstrapReserves']> => {
  const jadapter = requireJAdapterForEntity(env, entityId, 'RESERVE_SYNC');
  const replica = getEntityReplicaById(env, entityId);
  if (!replica?.state) {
    throw new Error(`HUB_REPLICA_MISSING_FOR_RESERVE_SYNC: ${entityId}`);
  }
  for (const token of tokenCatalog.slice(0, HUB_REQUIRED_TOKEN_COUNT)) {
    const tokenId = Number(token.tokenId);
    if (!Number.isFinite(tokenId) || tokenId <= 0) continue;
    const current = await jadapter.getReserves(entityId, tokenId);
    replica.state.reserves.set(tokenId, current);
  }
  return getReserveHealth(env, entityId, tokenCatalog);
};

const ensureBootstrapReserves = async (
  env: Env,
  entityId: string,
  tokenCatalog: JTokenInfo[],
): Promise<LocalHealthResponse['bootstrapReserves']> => {
  const startedAt = startTiming('reserve_funding');
  const jadapter = requireJAdapterForEntity(env, entityId, 'RESERVE_FUNDING');

  const bootstrapTokens = tokenCatalog.slice(0, HUB_REQUIRED_TOKEN_COUNT);
  await syncReserveSnapshotFromChain(env, entityId, tokenCatalog);
  if (!resolvedArgs.deployTokens) {
    const reserveHealth = getReserveHealth(env, entityId, tokenCatalog);
    finishTiming('reserve_funding', startedAt);
    return reserveHealth;
  }
  const replica = getEntityReplicaById(env, entityId);

  const mints = bootstrapTokens
    .map(token => {
      const tokenId = Number(token.tokenId);
      if (!Number.isFinite(tokenId) || tokenId <= 0) return null;
      const decimals = Number.isFinite(token.decimals) ? Number(token.decimals) : 18;
      const target = HUB_RESERVE_TARGET_UNITS * 10n ** BigInt(decimals);
      const current = replica?.state?.reserves?.get(tokenId) ?? 0n;
      if (current >= target) return null;
      return {
        entityId,
        tokenId,
        amount: target - current,
      };
    })
    .filter((mint): mint is { entityId: string; tokenId: number; amount: bigint } => mint !== null);

  if (mints.length > 0) {
    const events = await jadapter.debugFundReservesBatch(mints);
    await applyJEventsToEnv(env, events, `${resolvedArgs.name}-reserve-fund`);
    await settleRuntimeFor(env, 30);
  }
  const reserveHealth = await syncReserveSnapshotFromChain(env, entityId, tokenCatalog);

  finishTiming('reserve_funding', startedAt);
  return reserveHealth;
};

const ensurePeerBootstrapReserves = async (
  env: Env,
  peerProfiles: VisibleHubProfile[],
  tokenCatalog: JTokenInfo[],
): Promise<void> => {
  if (!resolvedArgs.deployTokens || peerProfiles.length === 0) return;
  const profilesByJurisdiction = new Map<string, VisibleHubProfile[]>();
  for (const profile of peerProfiles) {
    const jurisdictionName = String(profile.jurisdictionName || '').trim();
    if (!jurisdictionName) {
      throw new Error(`PEER_RESERVE_JURISDICTION_MISSING: entity=${profile.entityId}`);
    }
    if (!profilesByJurisdiction.has(jurisdictionName)) profilesByJurisdiction.set(jurisdictionName, []);
    profilesByJurisdiction.get(jurisdictionName)!.push(profile);
  }

  for (const [jurisdictionName, profiles] of profilesByJurisdiction) {
    const jadapter = env.jReplicas?.get(jurisdictionName)?.jadapter;
    if (!jadapter) {
      throw new Error(`PEER_RESERVE_JADAPTER_MISSING: jurisdiction=${jurisdictionName}`);
    }
    const catalog = jurisdictionName === env.activeJurisdiction
      ? tokenCatalog
      : await ensureTokenCatalog(jadapter, true, jurisdictionName);
    const mints: Array<{ entityId: string; tokenId: number; amount: bigint }> = [];
    for (const peer of profiles) {
      for (const token of catalog.slice(0, HUB_REQUIRED_TOKEN_COUNT)) {
        const tokenId = Number(token.tokenId);
        if (!Number.isFinite(tokenId) || tokenId <= 0) continue;
        const decimals = Number.isFinite(token.decimals) ? Number(token.decimals) : 18;
        const target = HUB_RESERVE_TARGET_UNITS * 10n ** BigInt(decimals);
        const current = await jadapter.getReserves(peer.entityId, tokenId);
        if (current >= target) continue;
        mints.push({
          entityId: peer.entityId,
          tokenId,
          amount: target - current,
        });
      }
    }
    if (mints.length === 0) continue;
    const events = await jadapter.debugFundReservesBatch(mints);
    await applyJEventsToEnv(env, events, `${resolvedArgs.name}-peer-reserve-fund-${jurisdictionName}`);
    await settleRuntimeFor(env, 20);
  }
};

const getEntityJurisdictionName = (env: Env, entityId: string | null): string => {
  if (!entityId) return '';
  const replica = getEntityReplicaById(env, entityId);
  return String(replica?.state?.config?.jurisdiction?.name || '').trim().toLowerCase();
};

const resolveEntityTokenCatalog = async (
  env: Env,
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
  env: Env,
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
  env: Env,
  hubEntities: HubBootstrapEntry[],
): Promise<BootstrapReserveHealth> => {
  const entities: BootstrapReserveEntityHealth[] = [];
  let primaryHealth: BootstrapReserveHealth | null = null;

  for (const entry of hubEntities) {
    const catalog = await resolveEntityTokenCatalog(env, entry.entityId);
    const health = await ensureBootstrapReserves(env, entry.entityId, catalog);
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

const readVisibleHubProfiles = (env: Env, jurisdictionName: string): VisibleHubProfile[] => {
  const normalizedJurisdiction = String(jurisdictionName || '').trim().toLowerCase();
  const profiles = env.gossip?.getProfiles?.() || [];
  return profiles
    .filter(profile => profile.metadata?.isHub === true)
    .filter(profile => {
      if (!normalizedJurisdiction) return true;
      return String(profile.metadata?.jurisdiction?.name || '').trim().toLowerCase() === normalizedJurisdiction;
    })
    .map(profile => ({
      name: String(profile.name || '').trim(),
      entityId: String(profile.entityId || '').toLowerCase(),
      jurisdictionName: String(profile.metadata?.jurisdiction?.name || '').trim(),
    }))
    .filter(profile => profile.name.length > 0 && profile.entityId.length > 0 && profile.jurisdictionName.length > 0);
};

const buildPairHealth = (env: Env, selfEntityId: string, peers: Array<{ name: string; entityId: string }>): HubPairHealth[] => {
  return peers.map(peer => {
    const account = getAccountMachine(env, selfEntityId, peer.entityId);
    const grantedByMe = account ? getCreditGrantedByEntity(account, selfEntityId, HUB_MESH_TOKEN_ID) : 0n;
    const grantedByPeer = account ? getCreditGrantedByEntity(account, peer.entityId, HUB_MESH_TOKEN_ID) : 0n;
    return {
      counterpartyId: peer.entityId,
      counterpartyName: peer.name,
      hasAccount: hasAccount(env, selfEntityId, peer.entityId),
      grantedByMe: grantedByMe.toString(),
      grantedByPeer: grantedByPeer.toString(),
      ready: hasPairMutualCredits(env, selfEntityId, peer.entityId, DEFAULT_ACCOUNT_TOKEN_IDS, HUB_MESH_CREDIT_AMOUNT),
    };
  });
};

const buildLocalHealth = (
  env: Env,
  entityId: string | null,
  tokenCatalog: JTokenInfo[],
  jadapter: JAdapter | null,
  hubEntities: HubBootstrapEntry[] = [],
): LocalHealthResponse => {
  const selfJurisdictionName = getEntityJurisdictionName(env, entityId);
  const visibleHubProfiles = readVisibleHubProfiles(env, selfJurisdictionName);
  const visibleNames = visibleHubProfiles.map(profile => profile.name);
  const visibleIds = visibleHubProfiles.map(profile => profile.entityId);
  const requiredNames = resolvedArgs.meshHubNames;
  const peers = entityId
    ? visibleHubProfiles.filter(profile => profile.entityId !== entityId.toLowerCase())
    : [];
  const pairs = entityId ? buildPairHealth(env, entityId, peers) : [];

  return {
    ok: Boolean(entityId) && pairs.length === Math.max(0, requiredNames.length - 1) && pairs.every(pair => pair.ready),
    name: resolvedArgs.name,
    entityId,
    runtimeId: String(env.runtimeId || '') || null,
    relayUrl: resolvedArgs.relayUrl,
    directWsUrl,
    apiUrl,
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

const run = async (): Promise<void> => {
  if (resolvedArgs.dbPath) {
    process.env['XLN_DB_PATH'] = resolvedArgs.dbPath;
  }
  process.env['JADAPTER_DEV_PRIVATE_KEY'] = deriveAnvilDevPrivateKey(resolveHubSignerIndex(resolvedArgs.name));

  const runtimeBootStartedAt = startTiming('runtime_boot');
  const env = await main(resolvedArgs.seed);
  startRuntimeLoop(env);
  finishTiming('runtime_boot', runtimeBootStartedAt);

  let bootstrap: { entityId: string; signerId: string } | null = null;
  const hubBootstraps: HubBootstrapEntry[] = [];
  const getImportedJurisdictionContracts = (
    jurisdictionName: string,
    fallback?: JurisdictionConfig['contracts'],
  ): {
    chainId?: number;
    depositoryAddress?: string;
    entityProviderAddress?: string;
  } => {
    const replica = env.jReplicas?.get(jurisdictionName) as
      | {
          chainId?: number;
          depositoryAddress?: string;
          entityProviderAddress?: string;
          contracts?: { depository?: string; entityProvider?: string };
          jadapter?: { chainId?: number; addresses?: { depository?: string; entityProvider?: string } };
        }
      | undefined;
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
      ...(Number.isFinite(chainId) && chainId > 0 ? { chainId: Math.floor(chainId) } : {}),
      ...(depositoryAddress ? { depositoryAddress } : {}),
      ...(entityProviderAddress ? { entityProviderAddress } : {}),
    };
  };
  let activeJAdapter: JAdapter | null = null;
  let activeTokenCatalog: JTokenInfo[] = [];
  let meshLoop: ReturnType<typeof setInterval> | null = null;
  let shuttingDown = false;
  type DirectEntityInputDebug = {
    at: number;
    fromRuntimeId: string;
    entityId: string;
    signerId: string;
    txTypes: string[];
    error?: string;
  };
  let lastDirectEntityInput: DirectEntityInputDebug | null = null;
  let lastDirectEntityInputError: DirectEntityInputDebug | null = null;

  const externalWalletApi = createExternalWalletApi({
    getJAdapter: () => activeJAdapter,
    getRuntimeId: () => String(env.runtimeId || ''),
    getTokenCatalog: async () => {
      if (!activeJAdapter) throw new Error('J-adapter not initialized');
      if (activeTokenCatalog.length > 0) return activeTokenCatalog;
      activeTokenCatalog = await waitForTokenCatalog(activeJAdapter);
      return activeTokenCatalog;
    },
    jsonHeaders: JSON_HEADERS,
    faucetSeed: `${resolvedArgs.seed}:faucet`,
    faucetSignerLabel: FAUCET_SIGNER_LABEL,
    faucetWalletEthTarget: FAUCET_WALLET_ETH_TARGET,
    faucetTokenTargetUnits: FAUCET_TOKEN_TARGET_UNITS,
    emitDebugEvent: () => {},
    fundBrowserVmWallet: async () => false,
  });

  const directRuntimeWs = createDirectRuntimeWsRoute({
    runtimeId: String(env.runtimeId || ''),
    runtimeSeed: resolvedArgs.seed,
    onEntityInput: async (from, input, ingressTimestamp) => {
      const debugEntry: DirectEntityInputDebug = {
        at: Date.now(),
        fromRuntimeId: String(from || ''),
        entityId: String(input.entityId || ''),
        signerId: String(input.signerId || ''),
        txTypes: (input.entityTxs || []).map(tx => String(tx?.type || '')),
      };
      lastDirectEntityInput = debugEntry;
      try {
        handleInboundP2PEntityInput(env, from, input, ingressTimestamp);
      } catch (error) {
        lastDirectEntityInputError = {
          ...debugEntry,
          error: error instanceof Error ? error.message : String(error),
        };
        throw error;
      }
    },
  });
  env.runtimeState = env.runtimeState ?? {};
  env.runtimeState.directEntityInputDispatch = (targetRuntimeId, input, ingressTimestamp) =>
    directRuntimeWs.sendEntityInput(targetRuntimeId, input, ingressTimestamp);
  const handleRadapterWsMessage = (ws: HubServerSocket, raw: string | Buffer | ArrayBuffer): void => {
    let msg: Record<string, unknown>;
    try {
      msg = decodeRuntimeAdapterMessage<Record<string, unknown>>(raw);
    } catch (error) {
      closeInvalidRuntimeAdapterMessage(ws, error);
      return;
    }
    Promise.resolve(handleRuntimeAdapterMessage(ws, msg, env, {
      enqueueRuntimeInput,
      readHead: (targetEnv) => readPersistedStorageHead(targetEnv),
      readFrame: (targetEnv, height) => readPersistedStorageFrameRecord(targetEnv, height),
      listCheckpoints: (targetEnv) => listPersistedCheckpointHeights(targetEnv),
      loadEntityState: (targetEnv, entityId, height) => loadEntityStateFromStorageDb(targetEnv, entityId, height),
      loadEntityAccountDoc: (targetEnv, entityId, counterpartyId, height) => loadEntityAccountDocFromStorageDb(targetEnv, entityId, counterpartyId, height),
      loadEntityViewPage: (targetEnv, entityId, height, query) => loadEntityViewPageFromStorageDb(targetEnv, entityId, height, query),
      listEntityIdsAtHeight: (targetEnv, height) => listPersistedEntityIdsAtHeight(targetEnv, height),
    })).catch(error => {
      ws.send(safeStringify({ type: 'error', error: `Runtime adapter failed: ${(error as Error).message}` }));
    });
  };

  const httpDrain = createHttpDrainTracker();
  const server = Bun.serve({
    hostname: resolvedArgs.apiHost,
    port: resolvedArgs.apiPort,
    async fetch(request, serverRef) {
      const releaseHttp = httpDrain.begin();
      try {
	      const url = new URL(request.url);
	      const pathname = url.pathname;
	      const headers = JSON_HEADERS;

	      if (request.headers.get('upgrade') === 'websocket' && pathname === '/rpc') {
	        const upgraded = serverRef.upgrade(request, { data: { type: 'rpc' } });
	        if (upgraded) return;
	        return new Response('WebSocket upgrade failed', { status: 400 });
	      }

	      const upgraded = directRuntimeWs.maybeUpgrade(request, serverRef);
	      if (upgraded !== undefined) return upgraded;

      if (pathname === '/api/info') {
        return new Response(safeStringify({
          name: resolvedArgs.name,
          entityId: bootstrap?.entityId ?? null,
          hubEntities: hubBootstraps,
          runtimeId: env.runtimeId,
          apiUrl,
          relayUrl: resolvedArgs.relayUrl,
          directWsUrl,
        }), { headers });
      }

      if (pathname === '/api/health') {
        const health = buildLocalHealth(env, bootstrap?.entityId ?? null, activeTokenCatalog, activeJAdapter, hubBootstraps);
        return new Response(safeStringify(isLocalOperatorRequest(request) ? health : publicLocalHubHealth(health)), {
          headers,
        });
      }

      if (pathname === '/api/account/status' && request.method === 'GET') {
        const hubEntityId = String(url.searchParams.get('hubEntityId') || bootstrap?.entityId || '').toLowerCase();
        const counterpartyEntityId = String(url.searchParams.get('counterpartyEntityId') || '').toLowerCase();
        if (!hubEntityId || !counterpartyEntityId) {
          return new Response(safeStringify({
            success: false,
            code: 'ACCOUNT_STATUS_BAD_REQUEST',
            error: 'hubEntityId and counterpartyEntityId are required',
          }), { status: 400, headers });
        }
        const account = getAccountMachine(env, hubEntityId, counterpartyEntityId);
        const replica = getEntityReplicaById(env, hubEntityId);
        const runtimeState = env.runtimeState;
        const summarizeRuntimeInputs = (inputs: Array<{ entityId?: string; entityTxs?: Array<{ type?: string }> }> | undefined) =>
          (inputs || []).slice(-10).map(input => ({
            entityId: String(input.entityId || '').slice(-8),
            txs: (input.entityTxs || []).map(tx => String(tx?.type || '')),
          }));
        const tokenIds = String(url.searchParams.get('tokenIds') || '')
          .split(',')
          .map(value => Number(value.trim()))
          .filter(value => Number.isInteger(value) && value > 0);
        const status = {
          success: true,
          hubEntityId,
          counterpartyEntityId,
          hasAccount: hasAccount(env, hubEntityId, counterpartyEntityId) || Boolean(account),
          ready: Boolean(
            account?.currentFrame &&
            Number(account.currentHeight ?? 0) > 0 &&
            !account.pendingFrame &&
            Number(account.mempool?.length ?? 0) === 0
          ),
          currentHeight: Number(account?.currentHeight ?? 0),
          pendingFrameHeight: account?.pendingFrame ? Number(account.pendingFrame.height ?? 0) : null,
          mempool: Number(account?.mempool?.length ?? 0),
          tokens: tokenIds.map(tokenId => ({
            tokenId,
            hasDelta: Boolean(account?.deltas?.has(tokenId)),
            hubOutCapacity: account ? getEntityOutCapacity(account, hubEntityId, tokenId).toString() : '0',
          })),
          runtime: {
            height: Number(env.height ?? 0),
            timestamp: Number(env.timestamp ?? 0),
            halted: Boolean(runtimeState?.halted),
            fatalDebugPayload: runtimeState?.fatalDebugPayload ?? null,
            loopActive: Boolean(runtimeState?.loopActive),
            runtimeInput: summarizeRuntimeInputs(env.runtimeInput?.entityInputs),
            runtimeMempool: summarizeRuntimeInputs(env.runtimeMempool?.entityInputs),
          },
          replica: replica ? {
            key: `${String(replica.entityId || '').toLowerCase()}:${String(replica.signerId || '').toLowerCase()}`,
            entityId: replica.entityId,
            signerId: replica.signerId,
            mempool: (replica.mempool || []).map(tx => String(tx?.type || '')),
            proposalTxs: (replica.proposal?.txs || []).map(tx => String(tx?.type || '')),
            lockedFrameTxs: (replica.lockedFrame?.txs || []).map(tx => String(tx?.type || '')),
            messages: (replica.state?.messages || []).slice(-10),
          } : null,
          directInput: {
            lastSeen: lastDirectEntityInput,
            lastError: lastDirectEntityInputError,
          },
        };
        return new Response(safeStringify(status), { headers });
      }

      if (pathname === '/api/control/p2p/stop' && request.method === 'POST') {
        shuttingDown = true;
        if (meshLoop) clearInterval(meshLoop);
        stopP2P(env);
        return new Response(safeStringify({ ok: true }), { headers });
      }

      if (pathname === '/api/jurisdictions') {
        const payload = buildRuntimeJurisdictionsPayload(env);
        if (!payload) {
          return new Response(safeStringify({ error: 'JURISDICTION_PAYLOAD_UNAVAILABLE' }), {
            status: 503,
            headers,
          });
        }
        return new Response(payload, {
          headers: {
            ...headers,
            'Cache-Control': 'no-store, no-cache, must-revalidate',
          },
        });
      }

      if (!bootstrap || !activeJAdapter) {
        return new Response(safeStringify({ error: 'HUB_NOT_READY' }), { status: 503, headers });
      }
      const readyBootstrap = bootstrap;
      const readyJAdapter = activeJAdapter;

      if (pathname === '/api/market/snapshots' && request.method === 'GET') {
        const pairIds = Array.from(new Set(
          url.searchParams.getAll('pair').concat(url.searchParams.getAll('pairId'))
            .map(normalizeMarketPairId)
            .filter((value): value is string => Boolean(value)),
        ));
        if (pairIds.length === 0) {
          return new Response(safeStringify({ error: 'Missing valid pair query parameters' }), {
            status: 400,
            headers,
          });
        }
        const depthRaw = Number(url.searchParams.get('depth') || String(RPC_MARKET_DEFAULT_DEPTH));
        const depth = Number.isFinite(depthRaw)
          ? Math.max(1, Math.min(Math.floor(depthRaw), RPC_MARKET_MAX_DEPTH))
          : RPC_MARKET_DEFAULT_DEPTH;
        const requestedHubEntityIdRaw = url.searchParams.get('hubEntityId') || url.searchParams.get('hub') || '';
        const requestedHubEntityId = requestedHubEntityIdRaw
          ? normalizeMarketEntityId(requestedHubEntityIdRaw)
          : readyBootstrap.entityId;
        if (!requestedHubEntityId) {
          return new Response(safeStringify({
            error: 'Invalid hubEntityId query parameter',
            code: 'E_BAD_QUERY',
          }), {
            status: 400,
            headers,
          });
        }
        const replica = getEntityReplicaById(env, requestedHubEntityId);
        if (!replica) {
          return new Response(safeStringify({
            error: `Unknown market hub: ${requestedHubEntityId}`,
            code: 'E_UNKNOWN_HUB',
            hubEntityId: requestedHubEntityId,
          }), {
            status: 404,
            headers,
          });
        }
        const snapshots = pairIds.map((pairId) =>
          buildMarketSnapshotForReplica(replica, requestedHubEntityId, pairId, depth),
        );
        return new Response(safeStringify({ hubEntityId: requestedHubEntityId, depth, snapshots }), { headers });
      }

      if (pathname === '/api/lending/state' && request.method === 'GET') {
        return handleLendingStateRequest({
          req: request,
          env,
          headers,
          activeHubEntityIds: hubBootstraps.map(entry => entry.entityId),
        });
      }
      if (pathname === '/api/lending/offer' && request.method === 'POST') {
        return handleLendingOfferRequest({
          req: request,
          env,
          headers,
          activeHubEntityIds: hubBootstraps.map(entry => entry.entityId),
          enqueueRuntimeInput,
        });
      }
      if (pathname === '/api/lending/borrow' && request.method === 'POST') {
        return handleLendingBorrowRequest({
          req: request,
          env,
          headers,
          activeHubEntityIds: hubBootstraps.map(entry => entry.entityId),
          enqueueRuntimeInput,
        });
      }
      if (pathname === '/api/lending/repay' && request.method === 'POST') {
        return handleLendingRepayRequest({
          req: request,
          env,
          headers,
          activeHubEntityIds: hubBootstraps.map(entry => entry.entityId),
          enqueueRuntimeInput,
        });
      }

      if (pathname === '/api/tokens' && request.method === 'GET') {
        return await externalWalletApi.handleTokens();
      }

      if (pathname === '/api/faucet/erc20' && request.method === 'POST') {
        return await externalWalletApi.handleErc20Faucet(request);
      }

      if (pathname === '/api/faucet/gas' && request.method === 'POST') {
        return await externalWalletApi.handleGasFaucet(request);
      }

      if (pathname === '/api/faucet/reserve' && request.method === 'POST') {
        const body = await request.json() as {
          userEntityId?: string;
          tokenId?: number | string;
          tokenSymbol?: string;
          amount?: string | number;
        };
        const userEntityId = String(body.userEntityId || '').toLowerCase();
        const rawTokenId = body.tokenId ?? 1;
        let tokenId = typeof rawTokenId === 'number' ? rawTokenId : Number(rawTokenId);
        const tokenSymbol = typeof body.tokenSymbol === 'string' ? body.tokenSymbol : undefined;
        const amount = typeof body.amount === 'string' ? body.amount : String(body.amount ?? '100');
        if (!userEntityId) {
          return new Response(safeStringify({ error: 'Missing userEntityId' }), { status: 400, headers });
        }
        if (!Number.isFinite(tokenId) || tokenId <= 0) {
          return new Response(safeStringify({ error: 'Invalid tokenId' }), { status: 400, headers });
        }

        const tokenMeta = activeTokenCatalog.find(token =>
          Number(token.tokenId) === tokenId ||
          (tokenSymbol ? String(token.symbol || '').toUpperCase() === tokenSymbol.toUpperCase() : false),
        );
        if (!tokenMeta) {
          return new Response(safeStringify({ error: 'Unknown token', tokenId, tokenSymbol }), {
            status: 400,
            headers,
          });
        }

        tokenId = Number(tokenMeta.tokenId);
        const decimals = typeof tokenMeta.decimals === 'number' ? Number(tokenMeta.decimals) : 18;
        const amountWei = ethers.parseUnits(amount, decimals);
        const prevUserReserve = await readyJAdapter.getReserves(userEntityId, tokenId).catch(() => 0n);
        const hubReplica = getEntityReplicaById(env, readyBootstrap.entityId);
        const hubReserve = hubReplica?.state?.reserves?.get(tokenId) ?? 0n;
        if (hubReserve < amountWei) {
          return new Response(safeStringify({
            error: 'Hub has insufficient reserves',
            have: hubReserve.toString(),
            need: amountWei.toString(),
          }), {
            status: 409,
            headers,
          });
        }

        const enqueueReserveTransfer = (): void => {
          enqueueRuntimeInput(env, {
            runtimeTxs: [],
            entityInputs: [{
              entityId: readyBootstrap.entityId,
              signerId: readyBootstrap.signerId,
              entityTxs: [
                {
                  type: 'r2r',
                  data: { toEntityId: userEntityId, tokenId, amount: amountWei },
                },
              ],
            }],
          });
        };

        const enqueueBatchBroadcast = (): void => {
          enqueueRuntimeInput(env, {
            runtimeTxs: [],
            entityInputs: [{
              entityId: readyBootstrap.entityId,
              signerId: readyBootstrap.signerId,
              entityTxs: [{ type: 'j_broadcast', data: {} }],
            }],
          });
        };

        enqueueReserveTransfer();
        await waitForRuntimeIdle(env, 5000);
        const broadcastWindowReady = await waitForEntityBroadcastWindow(env, readyBootstrap.entityId, 10000);
        if (!broadcastWindowReady) {
          return new Response(safeStringify({ error: 'Hub sentBatch did not clear in time' }), {
            status: 504,
            headers,
          });
        }
        enqueueBatchBroadcast();
        await waitForRuntimeIdle(env, 5000);
        const batchCleared = await waitForJBatchClear(env, 10000);
        if (!batchCleared) {
          return new Response(safeStringify({ error: 'J-batch did not broadcast in time' }), {
            status: 504,
            headers,
          });
        }
        const expectedMin = prevUserReserve + amountWei;
        const updatedReserve = await waitForReserveUpdate(readyJAdapter, userEntityId, tokenId, expectedMin, 10000);
        if (updatedReserve === null) {
          return new Response(safeStringify({ error: 'Reserve update not confirmed on-chain' }), {
            status: 504,
            headers,
          });
        }
        return new Response(safeStringify({
          success: true,
          type: 'reserve',
          amount,
          tokenId,
          from: readyBootstrap.entityId,
          to: userEntityId,
        }), { headers });
      }

      if (pathname === '/api/faucet/offchain' && request.method === 'POST') {
        const requestStartedAt = Date.now();
        const body = await request.json() as {
          userEntityId?: string;
          hubEntityId?: string;
          tokenId?: number;
          amount?: string;
        };
        const userEntityId = String(body.userEntityId || '').toLowerCase();
        const requestedHubEntityId = String(body.hubEntityId || '').toLowerCase();
        const faucetHubEntityId = requestedHubEntityId || String(readyBootstrap.entityId || '').toLowerCase();
        if (!userEntityId) {
          return new Response(safeStringify({ success: false, error: 'Missing userEntityId' }), {
            status: 400,
            headers,
          });
        }
        if (!getEntityReplicaById(env, faucetHubEntityId)) {
          return new Response(safeStringify({
            success: false,
            code: 'FAUCET_HUB_NOT_FOUND',
            error: 'Requested hub entity is not available on this hub runtime.',
          }), {
            status: 404,
            headers,
          });
        }
        if (!hasAccount(env, faucetHubEntityId, userEntityId)) {
          return new Response(safeStringify({
            success: false,
            code: 'FAUCET_ACCOUNT_NOT_OPEN',
            error: 'No bilateral account with this hub. Open account first, then retry faucet.',
          }), {
            status: 409,
            headers,
          });
        }

        const amount = String(body.amount || '100');
        const tokenId = Number(body.tokenId ?? 1);
        const accountMachine = getAccountMachine(env, faucetHubEntityId, userEntityId);
        const accountReady = Boolean(
          accountMachine?.currentFrame &&
          Number(accountMachine.currentHeight ?? 0) > 0 &&
          !accountMachine.pendingFrame &&
          Number(accountMachine.mempool?.length ?? 0) === 0,
        );
        if (!accountReady) {
          return new Response(safeStringify({
            success: false,
            code: 'FAUCET_ACCOUNT_NOT_READY',
            error: 'Bilateral account is still settling setup frames. Retry after commit.',
            accountState: {
              currentHeight: Number(accountMachine?.currentHeight ?? 0),
              pendingFrameHeight: accountMachine?.pendingFrame ? Number(accountMachine.pendingFrame.height ?? 0) : null,
              mempool: Number(accountMachine?.mempool?.length ?? 0),
            },
          }), {
            status: 409,
            headers,
          });
        }
        const amountWei = ethers.parseUnits(amount, 18);
        const outCapacity = getEntityOutCapacity(accountMachine, faucetHubEntityId, tokenId);
        if (outCapacity < amountWei) {
          return new Response(safeStringify({
            success: false,
            code: 'FAUCET_INSUFFICIENT_OUT_CAPACITY',
            error: 'Selected hub does not have enough outbound capacity for offchain faucet.',
            tokenId,
            requiredAmount: amountWei.toString(),
            senderOutCapacity: outCapacity.toString(),
          }), {
            status: 409,
            headers,
          });
        }
        enqueueRuntimeInput(env, {
          runtimeTxs: [],
          entityInputs: [{
            entityId: faucetHubEntityId,
            signerId: resolveEntityProposerId(env, faucetHubEntityId, 'hub-offchain-faucet'),
            entityTxs: [{
              type: 'directPayment',
              data: {
                targetEntityId: userEntityId,
                tokenId,
                amount: amountWei,
                route: [faucetHubEntityId, userEntityId],
                description: 'faucet-offchain',
              },
            }],
          }],
        });
        return new Response(safeStringify({
          success: true,
          accepted: true,
          hubEntityId: faucetHubEntityId,
          serverDurationMs: Date.now() - requestStartedAt,
        }), { headers });
      }

      if (pathname === '/api/debug/reserve' && request.method === 'GET') {
        const entityId = String(url.searchParams.get('entityId') || '').trim();
        const tokenId = Number(url.searchParams.get('tokenId') || '1');
        const jurisdictionRef = String(url.searchParams.get('jurisdiction') || '').trim();
        if (!entityId) {
          return new Response(safeStringify({ error: 'Missing entityId' }), { status: 400, headers });
        }
        if (!Number.isInteger(tokenId) || tokenId <= 0) {
          return new Response(safeStringify({ error: 'Invalid tokenId' }), { status: 400, headers });
        }
        try {
          const jadapter = requireJAdapterForDebugReserve(env, entityId, jurisdictionRef);
          const reserve = await jadapter.getReserves(entityId, tokenId);
          return new Response(safeStringify({
            ok: true,
            entityId,
            tokenId,
            ...(jurisdictionRef ? { jurisdiction: jurisdictionRef } : {}),
            reserve: reserve.toString(),
          }), { headers });
        } catch (error) {
          return new Response(safeStringify({ error: (error as Error).message }), { status: 500, headers });
        }
      }

      return new Response(safeStringify({ error: 'Not found' }), { status: 404, headers });
      } finally {
        releaseHttp();
      }
	    },
	    websocket: {
	      open(ws: HubServerSocket) {
	        if (ws.data?.type === 'rpc') {
	          attachRuntimeAdapterTicker(env, registerEnvChangeCallback);
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

  const importJStartedAt = startTiming('import_j');
  const jurisdiction = await prepareJurisdictionForImport(resolveJurisdictionConfig(resolvedArgs.rpcUrl));
  enqueueRuntimeInput(env, {
    runtimeTxs: [{
      type: 'importJ',
      data: {
        name: jurisdiction.name,
        chainId: jurisdiction.chainId,
        ticker: 'XLN',
        rpcs: [jurisdiction.rpc],
        blockTimeMs: requireJurisdictionBlockTimeMs(jurisdiction),
        ...(jurisdiction.contracts ? { contracts: jurisdiction.contracts } : {}),
      },
    }],
    entityInputs: [],
  });
  await runtimeProcess(env);
  finishTiming('import_j', importJStartedAt);

  const hubBootstrapStartedAt = startTiming('hub_bootstrap');
  bootstrap = await bootstrapHub(env, {
    name: resolvedArgs.name,
    region: resolvedArgs.region,
    signerId: resolvedArgs.signerLabel,
    seed: resolvedArgs.seed,
    routingFeePPM: 1,
    baseFee: 0n,
    swapTakerFeeBps: 1,
    disputeAutoFinalizeMode: resolvedArgs.name.toLowerCase() === 'h2' ? 'ignore' : 'auto',
    rebalanceBaseFee: 10n ** 17n,
    rebalanceLiquidityFeeBps: 1n,
    rebalanceGasFee: 0n,
    rebalanceTimeoutMs: 10 * 60 * 1000,
    relayUrl: resolvedArgs.relayUrl,
    rpcUrl: jurisdiction.rpc,
    httpUrl: apiUrl,
    port: resolvedArgs.apiPort,
  });
  if (!bootstrap?.entityId) throw new Error('HUB_BOOTSTRAP_FAILED');
  const primaryContracts = getImportedJurisdictionContracts(jurisdiction.name, jurisdiction.contracts);
  hubBootstraps.push({
    entityId: bootstrap.entityId,
    signerId: bootstrap.signerId,
    name: resolvedArgs.name,
    jurisdictionName: jurisdiction.name,
    chainId: primaryContracts.chainId ?? jurisdiction.chainId,
    ...(primaryContracts.depositoryAddress ? { depositoryAddress: primaryContracts.depositoryAddress } : {}),
    ...(primaryContracts.entityProviderAddress ? { entityProviderAddress: primaryContracts.entityProviderAddress } : {}),
    primary: true,
  });
  finishTiming('hub_bootstrap', hubBootstrapStartedAt);

  await ensureOrderbook(env, bootstrap.entityId, bootstrap.signerId);

  const primaryJurisdictionName = jurisdiction.name;
  const secondaryJurisdictions = resolveSecondaryJurisdictions(jurisdiction.rpc);
  for (const [index, secondary] of secondaryJurisdictions.entries()) {
    const secondaryName = String(secondary.name || `Secondary ${index + 1}`).trim();
    if (!secondaryName) continue;
    const secondaryRpcUrl = resolveLocalApiUrl(secondary.rpc);
    if (!env.jReplicas.has(secondaryName)) {
      console.log(`[${resolvedArgs.name}] Importing sibling hub jurisdiction ${secondaryName} (${secondary.rpc})`);
      enqueueRuntimeInput(env, {
        runtimeTxs: [{
          type: 'importJ',
          data: {
            name: secondaryName,
            chainId: secondary.chainId,
            ticker: 'XLN',
            rpcs: [secondaryRpcUrl],
            blockTimeMs: requireJurisdictionBlockTimeMs(secondary),
            ...(secondary.contracts ? { contracts: secondary.contracts } : {}),
          },
        }],
        entityInputs: [],
      });
      await runtimeProcess(env);
    } else {
      console.log(`[${resolvedArgs.name}] Reusing sibling hub jurisdiction ${secondaryName}`);
    }

    const priorActiveJurisdiction = env.activeJurisdiction;
    env.activeJurisdiction = secondaryName;
    const sibling = await bootstrapHub(env, {
      name: resolvedArgs.name,
      region: resolvedArgs.region,
      signerId: `${resolvedArgs.signerLabel}:${secondaryName}`,
      seed: resolvedArgs.seed,
      routingFeePPM: 1,
      baseFee: 0n,
      swapTakerFeeBps: 1,
      disputeAutoFinalizeMode: resolvedArgs.name.toLowerCase() === 'h2' ? 'ignore' : 'auto',
      rebalanceBaseFee: 10n ** 17n,
      rebalanceLiquidityFeeBps: 1n,
      rebalanceGasFee: 0n,
      rebalanceTimeoutMs: 10 * 60 * 1000,
      relayUrl: resolvedArgs.relayUrl,
      rpcUrl: secondaryRpcUrl,
      httpUrl: apiUrl,
      port: resolvedArgs.apiPort,
      jurisdictionName: secondaryName,
      position: { x: 160 + index * 80, y: 0, z: 120, jurisdiction: secondaryName },
    });
    env.activeJurisdiction = priorActiveJurisdiction || primaryJurisdictionName;
    if (!sibling?.entityId) throw new Error(`HUB_SIBLING_BOOTSTRAP_FAILED: ${secondaryName}`);
    const secondaryContracts = getImportedJurisdictionContracts(secondaryName, secondary.contracts);
    hubBootstraps.push({
      entityId: sibling.entityId,
      signerId: sibling.signerId,
      name: resolvedArgs.name,
      jurisdictionName: secondaryName,
      chainId: secondaryContracts.chainId ?? secondary.chainId,
      ...(secondaryContracts.depositoryAddress ? { depositoryAddress: secondaryContracts.depositoryAddress } : {}),
      ...(secondaryContracts.entityProviderAddress ? { entityProviderAddress: secondaryContracts.entityProviderAddress } : {}),
      primary: false,
    });
    await ensureOrderbook(env, sibling.entityId, sibling.signerId);
    console.log(
      `[${resolvedArgs.name}] Sibling hub ready jurisdiction=${secondaryName} entity=${sibling.entityId.slice(0, 12)}`,
    );
  }
  env.activeJurisdiction = primaryJurisdictionName;

  const jadapter = getActiveJAdapter(env);
  if (!jadapter) throw new Error('ACTIVE_JADAPTER_MISSING_AFTER_IMPORT');
  activeJAdapter = jadapter;
  await ensureRpcStackReady(env, jadapter);

  const tokenCatalog = resolvedArgs.deployTokens
    ? await ensureTokenCatalog(jadapter, true, primaryJurisdictionName)
    : await waitForTokenCatalog(jadapter);
  activeTokenCatalog = tokenCatalog;
  if (bootstrap?.entityId) {
    tokenCatalogsByEntityId.set(normalizeEntityId(bootstrap.entityId), tokenCatalog);
  }
  if (resolvedArgs.deployTokens) {
    await externalWalletApi.provisionFaucetWallet();
  }

  const p2pConnectStartedAt = startTiming('p2p_connect');
  const p2p = startP2P(env, {
    relayUrls: [resolvedArgs.relayUrl],
    wsUrl: directWsUrl,
    advertiseEntityIds: hubBootstraps.map((entry) => entry.entityId),
    isHub: true,
    gossipPollMs: BOOTSTRAP_POLL_MS * 5,
  });
  if (!p2p) throw new Error('P2P_START_FAILED');
  finishTiming('p2p_connect', p2pConnectStartedAt);

  const totalMeshStartedAt = startTiming('mesh_ready_total');
  let gossipReadyMarked = false;
  let accountsReadyMarked = false;
  let creditReadyMarked = false;
  let reserveReadyMarked = false;
  let meshLoopInFlight = false;

  const driveMeshBootstrap = async (): Promise<void> => {
    if (!bootstrap || meshLoopInFlight) return;
    meshLoopInFlight = true;
    try {
      const visibleHubProfiles = readVisibleHubProfiles(env, primaryJurisdictionName);
      const requiredHubProfiles = resolvedArgs.meshHubNames
        .map(name => visibleHubProfiles.find(profile => profile.name === name) || null)
        .filter((profile): profile is VisibleHubProfile => profile !== null);

      if (!gossipReadyMarked && requiredHubProfiles.length === resolvedArgs.meshHubNames.length) {
        finishTiming('gossip_ready', startedAtFor('gossip_ready') ?? startTiming('gossip_ready'));
        gossipReadyMarked = true;
      } else if (!gossipReadyMarked) {
        startTiming('gossip_ready');
      }

      const peers = requiredHubProfiles.filter(profile => profile.entityId !== bootstrap.entityId.toLowerCase());
      const visibleProfiles = env.gossip?.getProfiles?.() || [];
      const visibleSupportPeers = supportPeerIdentities.filter((identity) =>
        identity.entityId !== bootstrap.entityId.toLowerCase() &&
        visibleProfiles.some((profile) => profile.entityId.toLowerCase() === identity.entityId),
      );

      const openInputs: EntityInput[] = [];
      const creditInputs: EntityInput[] = [];

      for (const peer of peers) {
        const localAccount = getAccountMachine(env, bootstrap.entityId, peer.entityId);
        const canWrite = !localAccount?.pendingFrame && Number(localAccount?.mempool?.length || 0) === 0;
        if (
          bootstrap.entityId.toLowerCase() < peer.entityId.toLowerCase() &&
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
                data: { targetEntityId: peer.entityId, tokenId: HUB_MESH_TOKEN_ID, creditAmount: HUB_MESH_CREDIT_AMOUNT },
              },
              ...DEFAULT_ACCOUNT_TOKEN_IDS.slice(1).map((tokenId) => ({
                type: 'extendCredit' as const,
                data: { counterpartyEntityId: peer.entityId, tokenId, amount: HUB_MESH_CREDIT_AMOUNT },
              })),
            ],
          });
        }
        if (!localAccount || !canWrite) continue;
        const missingTokenIds = DEFAULT_ACCOUNT_TOKEN_IDS.filter((tokenId) =>
          getCreditGrantedByEntity(localAccount, bootstrap.entityId, tokenId) < HUB_MESH_CREDIT_AMOUNT,
        );
        if (missingTokenIds.length > 0) {
          creditInputs.push({
            entityId: bootstrap.entityId,
            signerId: bootstrap.signerId,
            entityTxs: missingTokenIds.map((tokenId) => ({
              type: 'extendCredit' as const,
              data: { counterpartyEntityId: peer.entityId, tokenId, amount: HUB_MESH_CREDIT_AMOUNT },
            })),
          });
        }
      }

      for (const peer of visibleSupportPeers) {
        const localAccount = getAccountMachine(env, bootstrap.entityId, peer.entityId);
        const canWrite = !localAccount?.pendingFrame && Number(localAccount?.mempool?.length || 0) === 0;
        if (!hasAccount(env, bootstrap.entityId, peer.entityId) && canWrite) {
          if (hasQueuedOpenAccount(env, bootstrap.entityId, peer.entityId)) continue;
          openInputs.push({
            entityId: bootstrap.entityId,
            signerId: bootstrap.signerId,
            entityTxs: [
              {
                type: 'openAccount',
                data: { targetEntityId: peer.entityId, tokenId: HUB_MESH_TOKEN_ID, creditAmount: peer.creditAmount },
              },
              ...DEFAULT_ACCOUNT_TOKEN_IDS.slice(1).map((tokenId) => ({
                type: 'extendCredit' as const,
                data: { counterpartyEntityId: peer.entityId, tokenId, amount: peer.creditAmount },
              })),
            ],
          });
          continue;
        }
        if (!localAccount || !canWrite) continue;
        const missingTokenIds = DEFAULT_ACCOUNT_TOKEN_IDS.filter((tokenId) =>
          getCreditGrantedByEntity(localAccount, bootstrap.entityId, tokenId) < peer.creditAmount,
        );
        if (missingTokenIds.length > 0) {
          creditInputs.push({
            entityId: bootstrap.entityId,
            signerId: bootstrap.signerId,
            entityTxs: missingTokenIds.map((tokenId) => ({
              type: 'extendCredit' as const,
              data: { counterpartyEntityId: peer.entityId, tokenId, amount: peer.creditAmount },
            })),
          });
        }
      }

      if (openInputs.length > 0) {
        startTiming('mesh_accounts');
        enqueueRuntimeInput(env, { runtimeTxs: [], entityInputs: openInputs });
        await settleRuntimeFor(env, 35);
      }

      const allAccountsReady =
        peers.length === Math.max(0, resolvedArgs.meshHubNames.length - 1) &&
        peers.every(peer =>
          hasAccount(env, bootstrap.entityId, peer.entityId) &&
          DEFAULT_ACCOUNT_TOKEN_IDS.every((tokenId) => Boolean(getAccountMachine(env, bootstrap.entityId, peer.entityId)?.deltas.get(tokenId))),
        );
      if (allAccountsReady && !accountsReadyMarked) {
        finishTiming('mesh_accounts', startedAtFor('mesh_accounts') ?? startTiming('mesh_accounts'));
        accountsReadyMarked = true;
      }

      if (creditInputs.length > 0) {
        startTiming('mesh_credit');
        enqueueRuntimeInput(env, { runtimeTxs: [], entityInputs: creditInputs });
        await settleRuntimeFor(env, 45);
      }

      const allCreditReady =
        peers.length === Math.max(0, resolvedArgs.meshHubNames.length - 1) &&
        peers.every(peer =>
          hasPairMutualCredits(env, bootstrap.entityId, peer.entityId, DEFAULT_ACCOUNT_TOKEN_IDS, HUB_MESH_CREDIT_AMOUNT),
        );
      if (allCreditReady && !creditReadyMarked) {
        finishTiming('mesh_credit', startedAtFor('mesh_credit') ?? startTiming('mesh_credit'));
        creditReadyMarked = true;
      }
      if (allCreditReady && !reserveReadyMarked) {
        if (resolvedArgs.deployTokens) {
          const localHubEntityIds = new Set(hubBootstraps.map(entry => normalizeEntityId(entry.entityId)));
          const allPeerProfiles = readVisibleHubProfiles(env, '')
            .filter(profile => !localHubEntityIds.has(normalizeEntityId(profile.entityId)));
          await ensurePeerBootstrapReserves(env, allPeerProfiles, tokenCatalog);
        }
        const reserveHealth = await ensureHubBootstrapReserves(env, hubBootstraps);
        reserveReadyMarked = reserveHealth.targetMet === true;
      }
      if (allCreditReady && reserveReadyMarked && (timings['mesh_ready_total']?.ms ?? null) === null) {
        finishTiming('mesh_ready_total', totalMeshStartedAt);
      }
    } finally {
      meshLoopInFlight = false;
    }
  };

  let meshLoopFatal = false;
  const handleMeshBootstrapFatal = (error: unknown): void => {
    handleMeshBootstrapLoopError(error, {
      nodeName: resolvedArgs.name,
      isShuttingDown: () => shuttingDown || meshLoopFatal,
      clearLoop: () => {
        meshLoopFatal = true;
        if (meshLoop) clearInterval(meshLoop);
      },
      exit: (code) => process.exit(code),
      logError: (...args) => console.error(...args),
    });
  };

  meshLoop = setInterval(() => {
    if (shuttingDown) return;
    void driveMeshBootstrap().catch(handleMeshBootstrapFatal);
  }, BOOTSTRAP_POLL_MS);
  void driveMeshBootstrap().catch(handleMeshBootstrapFatal);

  console.log(
    `[MESH-HUB] READY name=${resolvedArgs.name} entityId=${bootstrap.entityId} runtimeId=${String(env.runtimeId || '')} api=${apiUrl} relay=${resolvedArgs.relayUrl}`,
  );

  let shutdownStarted = false;
  const shutdown = async (code: number = 0) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    shuttingDown = true;
    if (meshLoop) clearInterval(meshLoop);
    try {
      await stopServerGracefully(server, httpDrain, resolvedArgs.name, 5_000);
      stopP2P(env);
      const idle = await stopRuntimeLoopAndWait(env, 10_000);
      if (!idle) {
        console.warn(`[${resolvedArgs.name}] shutdown timed out waiting for runtime loop to drain`);
      }
      await closeRuntimeDb(env);
      await closeInfraDb(env);
    } catch (error) {
      console.error(`[${resolvedArgs.name}] shutdown flush failed:`, error instanceof Error ? error.message : error);
      process.exit(code || 1);
    }
    process.exit(code);
  };
  const stopParentWatch = startParentLivenessWatch(resolvedArgs.name, process.env['XLN_ORCHESTRATOR_PID'], () => {
    void shutdown(1);
  });

  process.on('SIGTERM', () => { stopParentWatch(); void shutdown(); });
  process.on('SIGINT', () => { stopParentWatch(); void shutdown(); });

  await waitUntil(() => false, Number.MAX_SAFE_INTEGER, 1000);
};

run().catch(error => {
  console.error(`[MESH-HUB] FAILED ${resolvedArgs.name}:`, (error as Error).stack || (error as Error).message);
  process.exit(1);
});
