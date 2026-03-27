#!/usr/bin/env bun

import { ethers, getIndexedAccountPath, HDNodeWallet, Mnemonic } from 'ethers';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ERC20Mock__factory } from '../../jurisdictions/typechain-types/index.ts';
import { createExternalWalletApi } from '../api/external-wallet-api';
import { createDirectRuntimeWsRoute } from '../networking/direct-runtime-bun';
import { bootstrapHub } from '../../scripts/bootstrap-hub';
import { DEFAULT_TOKENS, DEFAULT_TOKEN_SUPPLY, TOKEN_REGISTRATION_AMOUNT } from '../jadapter/default-tokens';
import type { JAdapter, JTokenInfo } from '../jadapter/types';
import { clearJurisdictionsCache, loadJurisdictions } from '../jurisdiction-loader';
import { resolveJurisdictionsJsonPath } from '../jurisdictions-path';
import { DEFAULT_SPREAD_DISTRIBUTION } from '../orderbook';
import {
  buildMarketSnapshotForReplica,
  normalizeMarketPairId,
  RPC_MARKET_DEFAULT_DEPTH,
  RPC_MARKET_MAX_DEPTH,
} from '../market-snapshot';
import { toPublicRpcUrl } from '../loopback-url';
import {
  getActiveJAdapter,
  getP2PState,
  main,
  process as runtimeProcess,
  enqueueRuntimeInput,
  handleInboundP2PEntityInput,
  resolveEntityProposerId,
  startP2P,
  stopP2P,
  startRuntimeLoop,
} from '../runtime.ts';
import type { EntityInput, Env } from '../types';
import {
  applyJEventsToEnv,
  hasPendingRuntimeWork,
  BOOTSTRAP_POLL_MS,
  DEFAULT_ACCOUNT_TOKEN_IDS,
  getAccountMachine,
  getCreditGrantedByEntity,
  getEntityReplicaById,
  HUB_DEFAULT_MIN_TRADE_SIZE,
  HUB_DEFAULT_SUPPORTED_PAIRS,
  HUB_MESH_CREDIT_AMOUNT,
  HUB_MESH_TOKEN_ID,
  HUB_REQUIRED_TOKEN_COUNT,
  HUB_RESERVE_TARGET_UNITS,
  hasAccount,
  hasQueuedOpenAccount,
  hasPairMutualCredit,
  hasPairMutualCredits,
  serializeReserves,
  settleRuntimeFor,
  sleep,
  waitUntil,
} from './mesh-common';

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

type StageTiming = {
  startedAt: number | null;
  completedAt: number | null;
  ms: number | null;
};

type TimingMap = Record<string, StageTiming>;

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
  bootstrapReserves: {
    ok: boolean;
    tokens: Array<{
      tokenId: number;
      symbol: string;
      decimals: number;
      current: string;
      expectedMin: string;
      ready: boolean;
    }>;
  };
  timings: TimingMap;
};

type JurisdictionConfig = {
  name: string;
  chainId: number;
  rpc: string;
  contracts: {
    depository: string;
    entityProvider: string;
    account?: string;
    deltaTransformer?: string;
  };
};

type PollableJAdapter = JAdapter & {
  pollNow?: () => Promise<void>;
};

type JurisdictionsFile = {
  version?: string;
  lastUpdated?: string;
  jurisdictions?: Record<string, {
    name?: string;
    chainId?: number;
    rpc?: string;
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
  const mnemonic = Mnemonic.fromPhrase(process.env.ANVIL_MNEMONIC || DEFAULT_ANVIL_MNEMONIC);
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
const directWsUrl = String(resolvedArgs.directWsUrl || '').trim();
if (!directWsUrl) {
  throw new Error(`[MESH-HUB] Missing required --direct-ws-url for ${resolvedArgs.name}`);
}

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
  if (timings[stage].startedAt === null) timings[stage].startedAt = now;
  return now;
};

const finishTiming = (stage: keyof typeof timings, startedAt: number): void => {
  const ms = Date.now() - startedAt;
  timings[stage].completedAt = Date.now();
  timings[stage].ms = ms;
  console.log(`[MESH-TIMING] ${resolvedArgs.name}.${stage} ${ms}ms`);
};

const resolveJurisdictionConfig = (rpcUrlOverride: string): JurisdictionConfig => {
  const data = loadJurisdictions();
  const map = data.jurisdictions ?? {};
  const requestedRpc = String(rpcUrlOverride || '').trim();
  const exactMatch = Object.values(map).find((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    return String((entry as JurisdictionConfig).rpc || '').trim() === requestedRpc;
  });
  const arrakis = exactMatch ?? map.arrakis ?? Object.values(map)[0];
  if (!arrakis) {
    throw new Error('JURISDICTION_NOT_FOUND');
  }
  return {
    ...(arrakis as JurisdictionConfig),
    rpc: rpcUrlOverride || (arrakis as JurisdictionConfig).rpc,
  };
};

const resolveJurisdictionPaths = (): string[] => {
  return [resolveJurisdictionsJsonPath()];
};

const writeJurisdictionAddresses = async (jadapter: JAdapter, rpcUrl: string): Promise<void> => {
  if (!jadapter.addresses?.depository || !jadapter.addresses?.entityProvider) {
    throw new Error('JURISDICTION_WRITE_ADDRESSES_MISSING');
  }
  const publicRpcUrl = toPublicRpcUrl(rpcUrl);
  const updatedAt = new Date().toISOString();
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
      name: previous.name ?? 'Arrakis (Shared Anvil)',
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
      version: current.version ?? '1.0.0',
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
  clearJurisdictionsCache();
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

  return JSON.stringify({
    version: '1.0.0',
    lastUpdated: new Date().toISOString(),
    jurisdictions: {
      arrakis: {
        name: String(replica.name || activeName || 'Arrakis (Shared Anvil)'),
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
  await jadapter.deployStack();
  syncEnvJurisdictionReplica(env, jadapter, resolvedArgs.rpcUrl);
  await writeJurisdictionAddresses(jadapter, resolvedArgs.rpcUrl);
};

const deployDefaultTokensOnRpc = async (jadapter: JAdapter): Promise<void> => {
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

  console.log(`[${resolvedArgs.name}] deploying default tokens on dev chain`);
  const signer = jadapter.signer;
  const erc20Factory = new ERC20Mock__factory(signer);
  for (const token of DEFAULT_TOKENS) {
    if (existingSymbols.has(String(token.symbol || '').trim().toUpperCase())) {
      continue;
    }
    const tokenContract = await erc20Factory.deploy(token.name, token.symbol, DEFAULT_TOKEN_SUPPLY);
    await tokenContract.waitForDeployment();
    const tokenAddress = await tokenContract.getAddress();

    const approveTx = await tokenContract.approve(depositoryAddress, TOKEN_REGISTRATION_AMOUNT);
    await approveTx.wait();

    const registerTx = await jadapter.depository.connect(signer).adminRegisterExternalToken({
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

const ensureTokenCatalog = async (jadapter: JAdapter, allowDeploy: boolean): Promise<JTokenInfo[]> => {
  const current = await jadapter.getTokenRegistry().catch(() => []);
  if (current.length >= HUB_REQUIRED_TOKEN_COUNT) return current;
  if (allowDeploy) {
    await deployDefaultTokensOnRpc(jadapter);
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
      ready: current >= expectedMin,
    };
  });
  return {
    ok: tokens.length >= HUB_REQUIRED_TOKEN_COUNT && tokens.every(token => token.ready),
    tokens,
  };
};

const syncReserveSnapshotFromChain = async (
  env: Env,
  entityId: string,
  tokenCatalog: JTokenInfo[],
): Promise<LocalHealthResponse['bootstrapReserves']> => {
  const jadapter = getActiveJAdapter(env);
  if (!jadapter) {
    throw new Error('ACTIVE_JADAPTER_MISSING_FOR_RESERVE_SYNC');
  }
  const replica = getEntityReplicaById(env, entityId);
  if (!replica?.state) {
    throw new Error(`HUB_REPLICA_MISSING_FOR_RESERVE_SYNC: ${entityId}`);
  }
  for (const token of tokenCatalog.slice(0, HUB_REQUIRED_TOKEN_COUNT)) {
    const tokenId = Number(token.tokenId);
    if (!Number.isFinite(tokenId) || tokenId <= 0) continue;
    const onChain = await jadapter.getReserves(entityId, tokenId);
    replica.state.reserves.set(tokenId, onChain);
  }
  return getReserveHealth(env, entityId, tokenCatalog);
};

const ensureBootstrapReserves = async (
  env: Env,
  entityId: string,
  tokenCatalog: JTokenInfo[],
): Promise<LocalHealthResponse['bootstrapReserves']> => {
  const startedAt = startTiming('reserve_funding');
  const jadapter = getActiveJAdapter(env);
  if (!jadapter) {
    throw new Error('ACTIVE_JADAPTER_MISSING');
  }

  const bootstrapTokens = tokenCatalog.slice(0, HUB_REQUIRED_TOKEN_COUNT);
  if (!resolvedArgs.deployTokens) {
    const reserveHealth = await syncReserveSnapshotFromChain(env, entityId, tokenCatalog);
    finishTiming('reserve_funding', startedAt);
    return reserveHealth;
  }

  const mints = bootstrapTokens
    .map(token => {
      const tokenId = Number(token.tokenId);
      if (!Number.isFinite(tokenId) || tokenId <= 0) return null;
      const decimals = Number.isFinite(token.decimals) ? Number(token.decimals) : 18;
      return {
        entityId,
        tokenId,
        amount: HUB_RESERVE_TARGET_UNITS * 10n ** BigInt(decimals),
      };
    })
    .filter((mint): mint is { entityId: string; tokenId: number; amount: bigint } => mint !== null);

  const events = await jadapter.debugFundReservesBatch(mints);
  await applyJEventsToEnv(env, events, `${resolvedArgs.name}-reserve-fund`);

  const pollable = jadapter as PollableJAdapter;
  if (typeof pollable.pollNow === 'function') {
    await pollable.pollNow();
  }

  await settleRuntimeFor(env, 30);
  const reserveHealth = await syncReserveSnapshotFromChain(env, entityId, tokenCatalog);

  finishTiming('reserve_funding', startedAt);
  return reserveHealth;
};

const ensurePeerBootstrapReserves = async (
  env: Env,
  peerEntityIds: string[],
  tokenCatalog: JTokenInfo[],
): Promise<void> => {
  if (!resolvedArgs.deployTokens || peerEntityIds.length === 0) return;
  const jadapter = getActiveJAdapter(env);
  if (!jadapter) {
    throw new Error('ACTIVE_JADAPTER_MISSING_FOR_PEER_RESERVES');
  }
  const mints: Array<{ entityId: string; tokenId: number; amount: bigint }> = [];
  for (const peerEntityId of peerEntityIds) {
    for (const token of tokenCatalog.slice(0, HUB_REQUIRED_TOKEN_COUNT)) {
      const tokenId = Number(token.tokenId);
      if (!Number.isFinite(tokenId) || tokenId <= 0) continue;
      const decimals = Number.isFinite(token.decimals) ? Number(token.decimals) : 18;
      const target = HUB_RESERVE_TARGET_UNITS * 10n ** BigInt(decimals);
      const current = await jadapter.getReserves(peerEntityId, tokenId);
      if (current >= target) continue;
      mints.push({
        entityId: peerEntityId,
        tokenId,
        amount: target - current,
      });
    }
  }
  if (mints.length === 0) return;
  const events = await jadapter.debugFundReservesBatch(mints);
  await applyJEventsToEnv(env, events, `${resolvedArgs.name}-peer-reserve-fund`);
  await settleRuntimeFor(env, 20);
};

const readVisibleHubProfiles = (env: Env): Array<{ name: string; entityId: string }> => {
  const profiles = env.gossip?.getProfiles?.() || [];
  return profiles
    .filter(profile => profile.metadata?.isHub === true)
    .map(profile => ({
      name: String(profile.name || '').trim(),
      entityId: String(profile.entityId || '').toLowerCase(),
    }))
    .filter(profile => profile.name.length > 0 && profile.entityId.length > 0);
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
): LocalHealthResponse => {
  const visibleHubProfiles = readVisibleHubProfiles(env);
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
    bootstrapReserves: entityId ? getReserveHealth(env, entityId, tokenCatalog) : { ok: false, tokens: [] },
    timings,
  };
};

const run = async (): Promise<void> => {
  if (resolvedArgs.dbPath) {
    process.env.XLN_DB_PATH = resolvedArgs.dbPath;
  }
  process.env.JADAPTER_DEV_PRIVATE_KEY = deriveAnvilDevPrivateKey(resolveHubSignerIndex(resolvedArgs.name));

  const runtimeBootStartedAt = startTiming('runtime_boot');
  const env = await main(resolvedArgs.seed);
  startRuntimeLoop(env);
  finishTiming('runtime_boot', runtimeBootStartedAt);

  let bootstrap: { entityId: string; signerId: string } | null = null;
  let activeJAdapter: JAdapter | null = null;
  let activeTokenCatalog: JTokenInfo[] = [];
  let meshLoop: ReturnType<typeof setInterval> | null = null;
  let shuttingDown = false;

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
      handleInboundP2PEntityInput(env, from, input, ingressTimestamp);
    },
  });

  const server = Bun.serve({
    hostname: resolvedArgs.apiHost,
    port: resolvedArgs.apiPort,
    async fetch(request, serverRef) {
      const url = new URL(request.url);
      const pathname = url.pathname;
      const headers = JSON_HEADERS;

      const upgraded = directRuntimeWs.maybeUpgrade(request, serverRef);
      if (upgraded !== undefined) return upgraded;

      if (pathname === '/api/info') {
        return new Response(JSON.stringify({
          name: resolvedArgs.name,
          entityId: bootstrap?.entityId ?? null,
          runtimeId: env.runtimeId,
          apiUrl,
          relayUrl: resolvedArgs.relayUrl,
          directWsUrl,
        }), { headers });
      }

      if (pathname === '/api/health') {
        return new Response(JSON.stringify(buildLocalHealth(env, bootstrap?.entityId ?? null, activeTokenCatalog)), {
          headers,
        });
      }

      if (pathname === '/api/control/p2p/stop' && request.method === 'POST') {
        shuttingDown = true;
        if (meshLoop) clearInterval(meshLoop);
        stopP2P(env);
        return new Response(JSON.stringify({ ok: true }), { headers });
      }

      if (pathname === '/api/jurisdictions') {
        const payload = buildRuntimeJurisdictionsPayload(env);
        if (!payload) {
          return new Response(JSON.stringify({ error: 'JURISDICTION_PAYLOAD_UNAVAILABLE' }), {
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
        return new Response(JSON.stringify({ error: 'HUB_NOT_READY' }), { status: 503, headers });
      }

      if (pathname === '/api/market/snapshots' && request.method === 'GET') {
        const pairIds = Array.from(new Set(
          url.searchParams.getAll('pair').concat(url.searchParams.getAll('pairId'))
            .map(normalizeMarketPairId)
            .filter((value): value is string => Boolean(value)),
        ));
        if (pairIds.length === 0) {
          return new Response(JSON.stringify({ error: 'Missing valid pair query parameters' }), {
            status: 400,
            headers,
          });
        }
        const depthRaw = Number(url.searchParams.get('depth') || String(RPC_MARKET_DEFAULT_DEPTH));
        const depth = Number.isFinite(depthRaw)
          ? Math.max(1, Math.min(Math.floor(depthRaw), RPC_MARKET_MAX_DEPTH))
          : RPC_MARKET_DEFAULT_DEPTH;
        const replica = getEntityReplicaById(env, bootstrap.entityId);
        const snapshots = pairIds.map((pairId) =>
          buildMarketSnapshotForReplica(replica, bootstrap.entityId, pairId, depth),
        );
        return new Response(JSON.stringify({ hubEntityId: bootstrap.entityId, depth, snapshots }), { headers });
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
          return new Response(JSON.stringify({ error: 'Missing userEntityId' }), { status: 400, headers });
        }
        if (!Number.isFinite(tokenId) || tokenId <= 0) {
          return new Response(JSON.stringify({ error: 'Invalid tokenId' }), { status: 400, headers });
        }

        const tokenMeta = activeTokenCatalog.find(token =>
          Number(token.tokenId) === tokenId ||
          (tokenSymbol ? String(token.symbol || '').toUpperCase() === tokenSymbol.toUpperCase() : false),
        );
        if (!tokenMeta) {
          return new Response(JSON.stringify({ error: 'Unknown token', tokenId, tokenSymbol }), {
            status: 400,
            headers,
          });
        }

        tokenId = Number(tokenMeta.tokenId);
        const decimals = typeof tokenMeta.decimals === 'number' ? Number(tokenMeta.decimals) : 18;
        const amountWei = ethers.parseUnits(amount, decimals);
        const prevUserReserve = await activeJAdapter.getReserves(userEntityId, tokenId).catch(() => 0n);
        const hubReplica = getEntityReplicaById(env, bootstrap.entityId);
        const hubReserve = hubReplica?.state?.reserves?.get(tokenId) ?? 0n;
        if (hubReserve < amountWei) {
          return new Response(JSON.stringify({
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
              entityId: bootstrap.entityId,
              signerId: bootstrap.signerId,
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
              entityId: bootstrap.entityId,
              signerId: bootstrap.signerId,
              entityTxs: [{ type: 'j_broadcast', data: {} }],
            }],
          });
        };

        enqueueReserveTransfer();
        await waitForRuntimeIdle(env, 5000);
        const broadcastWindowReady = await waitForEntityBroadcastWindow(env, bootstrap.entityId, 10000);
        if (!broadcastWindowReady) {
          return new Response(JSON.stringify({ error: 'Hub sentBatch did not clear in time' }), {
            status: 504,
            headers,
          });
        }
        enqueueBatchBroadcast();
        await waitForRuntimeIdle(env, 5000);
        const batchCleared = await waitForJBatchClear(env, 10000);
        if (!batchCleared) {
          return new Response(JSON.stringify({ error: 'J-batch did not broadcast in time' }), {
            status: 504,
            headers,
          });
        }
        const expectedMin = prevUserReserve + amountWei;
        const updatedReserve = await waitForReserveUpdate(activeJAdapter, userEntityId, tokenId, expectedMin, 10000);
        if (updatedReserve === null) {
          return new Response(JSON.stringify({ error: 'Reserve update not confirmed on-chain' }), {
            status: 504,
            headers,
          });
        }
        return new Response(JSON.stringify({
          success: true,
          type: 'reserve',
          amount,
          tokenId,
          from: bootstrap.entityId,
          to: userEntityId,
        }), { headers });
      }

      if (pathname === '/api/faucet/offchain' && request.method === 'POST') {
        const body = await request.json() as {
          userEntityId?: string;
          tokenId?: number;
          amount?: string;
        };
        const userEntityId = String(body.userEntityId || '').toLowerCase();
        if (!userEntityId) {
          return new Response(JSON.stringify({ success: false, error: 'Missing userEntityId' }), {
            status: 400,
            headers,
          });
        }
        if (!hasAccount(env, bootstrap.entityId, userEntityId)) {
          return new Response(JSON.stringify({
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
        enqueueRuntimeInput(env, {
          runtimeTxs: [],
          entityInputs: [{
            entityId: bootstrap.entityId,
            signerId: resolveEntityProposerId(env, bootstrap.entityId, 'hub-offchain-faucet'),
            entityTxs: [{
              type: 'directPayment',
              data: {
                targetEntityId: userEntityId,
                tokenId,
                amount: ethers.parseUnits(amount, 18),
                route: [bootstrap.entityId, userEntityId],
                description: 'faucet-offchain',
              },
            }],
          }],
        });
        return new Response(JSON.stringify({ success: true, accepted: true }), { headers });
      }

      if (pathname === '/api/debug/reserve' && request.method === 'GET') {
        const entityId = String(url.searchParams.get('entityId') || '').trim();
        const tokenId = Number(url.searchParams.get('tokenId') || '1');
        if (!entityId) {
          return new Response(JSON.stringify({ error: 'Missing entityId' }), { status: 400, headers });
        }
        if (!Number.isInteger(tokenId) || tokenId <= 0) {
          return new Response(JSON.stringify({ error: 'Invalid tokenId' }), { status: 400, headers });
        }
        try {
          const reserve = await activeJAdapter.getReserves(entityId, tokenId);
          return new Response(JSON.stringify({ ok: true, entityId, tokenId, reserve: reserve.toString() }), { headers });
        } catch (error) {
          return new Response(JSON.stringify({ error: (error as Error).message }), { status: 500, headers });
        }
      }

      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers });
    },
    websocket: directRuntimeWs.websocket,
  });

  const importJStartedAt = startTiming('import_j');
  const jurisdiction = resolveJurisdictionConfig(resolvedArgs.rpcUrl);
  enqueueRuntimeInput(env, {
    runtimeTxs: [{
      type: 'importJ',
      data: {
        name: jurisdiction.name,
        chainId: jurisdiction.chainId,
        ticker: 'XLN',
        rpcs: [jurisdiction.rpc],
        ...(resolvedArgs.deployTokens ? {} : { contracts: jurisdiction.contracts }),
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
  finishTiming('hub_bootstrap', hubBootstrapStartedAt);

  await ensureOrderbook(env, bootstrap.entityId, bootstrap.signerId);

  const jadapter = getActiveJAdapter(env);
  if (!jadapter) throw new Error('ACTIVE_JADAPTER_MISSING_AFTER_IMPORT');
  activeJAdapter = jadapter;
  await ensureRpcStackReady(env, jadapter);

  const tokenCatalog = resolvedArgs.deployTokens
    ? await ensureTokenCatalog(jadapter, true)
    : await waitForTokenCatalog(jadapter);
  activeTokenCatalog = tokenCatalog;
  if (resolvedArgs.deployTokens) {
    await externalWalletApi.provisionFaucetWallet();
  }

  const p2pConnectStartedAt = startTiming('p2p_connect');
  const p2p = startP2P(env, {
    relayUrls: [resolvedArgs.relayUrl],
    wsUrl: directWsUrl,
    advertiseEntityIds: [bootstrap.entityId],
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
      const visibleHubProfiles = readVisibleHubProfiles(env);
      const requiredHubProfiles = resolvedArgs.meshHubNames
        .map(name => visibleHubProfiles.find(profile => profile.name === name) || null)
        .filter((profile): profile is { name: string; entityId: string } => profile !== null);

      if (!gossipReadyMarked && requiredHubProfiles.length === resolvedArgs.meshHubNames.length) {
        finishTiming('gossip_ready', timings.gossip_ready.startedAt ?? startTiming('gossip_ready'));
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
        finishTiming('mesh_accounts', timings.mesh_accounts.startedAt ?? startTiming('mesh_accounts'));
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
        finishTiming('mesh_credit', timings.mesh_credit.startedAt ?? startTiming('mesh_credit'));
        creditReadyMarked = true;
      }
      if (allCreditReady && !reserveReadyMarked) {
        if (resolvedArgs.deployTokens && peers.length > 0) {
          await ensurePeerBootstrapReserves(env, peers.map(peer => peer.entityId), tokenCatalog);
        }
        const reserveHealth = await ensureBootstrapReserves(env, bootstrap.entityId, tokenCatalog);
        reserveReadyMarked = reserveHealth.ok;
      }
      if (allCreditReady && reserveReadyMarked && timings.mesh_ready_total.ms === null) {
        finishTiming('mesh_ready_total', totalMeshStartedAt);
      }
    } finally {
      meshLoopInFlight = false;
    }
  };

  const isExpectedMeshBootstrapError = (error: unknown): boolean => {
    const message = String((error as Error)?.message || error || '');
    return message.includes('ECONNREFUSED') || message.includes('fetch failed');
  };

  meshLoop = setInterval(() => {
    if (shuttingDown) return;
    void driveMeshBootstrap().catch(error => {
      if (shuttingDown || isExpectedMeshBootstrapError(error)) return;
      console.error(`[${resolvedArgs.name}] mesh bootstrap tick failed:`, (error as Error).message);
    });
  }, BOOTSTRAP_POLL_MS);
  void driveMeshBootstrap();

  console.log(
    `[MESH-HUB] READY name=${resolvedArgs.name} entityId=${bootstrap.entityId} runtimeId=${String(env.runtimeId || '')} api=${apiUrl} relay=${resolvedArgs.relayUrl}`,
  );

  const shutdown = async () => {
    shuttingDown = true;
    if (meshLoop) clearInterval(meshLoop);
    stopP2P(env);
    server.stop(true);
    process.exit(0);
  };

  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });

  await waitUntil(() => false, Number.MAX_SAFE_INTEGER, 1000);
};

run().catch(error => {
  console.error(`[MESH-HUB] FAILED ${resolvedArgs.name}:`, (error as Error).stack || (error as Error).message);
  process.exit(1);
});
