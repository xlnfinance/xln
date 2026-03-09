#!/usr/bin/env bun

import { ethers, HDNodeWallet, Mnemonic } from 'ethers';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ERC20Mock__factory } from '../../jurisdictions/typechain-types';
import { bootstrapHub } from '../../scripts/bootstrap-hub';
import { DEFAULT_TOKENS, DEFAULT_TOKEN_SUPPLY, TOKEN_REGISTRATION_AMOUNT } from '../jadapter/default-tokens';
import type { JAdapter, JTokenInfo } from '../jadapter/types';
import { clearJurisdictionsCache, loadJurisdictions } from '../jurisdiction-loader';
import { resolveJurisdictionsJsonPath } from '../jurisdictions-path';
import { DEFAULT_SPREAD_DISTRIBUTION } from '../orderbook';
import {
  getActiveJAdapter,
  main,
  process as runtimeProcess,
  enqueueRuntimeInput,
  resolveEntityProposerId,
  startP2P,
  startRuntimeLoop,
} from '../runtime';
import type { EntityInput, Env } from '../types';
import {
  applyJEventsToEnv,
  BOOTSTRAP_POLL_MS,
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
  hasPairMutualCredit,
  serializeReserves,
  settleRuntimeFor,
  sleep,
  waitUntil,
} from '../e2e/mesh-common';

type Args = {
  name: string;
  region: string;
  seed: string;
  signerLabel: string;
  relayUrl: string;
  apiHost: string;
  apiPort: number;
  rpcUrl: string;
  meshHubNames: string[];
  dbPath: string;
  deployTokens: boolean;
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
  apiUrl: string;
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
    rpcUrl: getArg('--rpc-url', ''),
    meshHubNames: getArg('--mesh-hub-names', 'H1,H2,H3')
      .split(',')
      .map(part => part.trim())
      .filter(Boolean),
    dbPath: getArg('--db-path', ''),
    deployTokens: hasFlag('--deploy-tokens'),
  };
};

const resolvedArgs = parseArgs();
const apiUrl = `http://${resolvedArgs.apiHost}:${resolvedArgs.apiPort}`;
const DEFAULT_ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';

const resolveHubSignerIndex = (name: string): number => {
  const normalized = String(name || '').trim().toUpperCase();
  if (normalized === 'H1') return 0;
  if (normalized === 'H2') return 1;
  if (normalized === 'H3') return 2;
  return 0;
};

const deriveAnvilDevPrivateKey = (index: number): string => {
  const mnemonic = Mnemonic.fromPhrase(process.env.ANVIL_MNEMONIC || DEFAULT_ANVIL_MNEMONIC);
  const wallet = HDNodeWallet.fromMnemonic(mnemonic, `m/44'/60'/0'/0/${index}`);
  return wallet.privateKey;
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
  if (timings[stage].startedAt === null) timings[stage].startedAt = now;
  return now;
};

const finishTiming = (stage: keyof typeof timings, startedAt: number): void => {
  const ms = Date.now() - startedAt;
  timings[stage].completedAt = Date.now();
  timings[stage].ms = ms;
  console.log(`[MESH-TIMING] ${resolvedArgs.name}.${stage} ${ms}ms`);
};

const getJurisdictionKeyForRpc = (rpcUrl: string): string => {
  try {
    const parsed = new URL(rpcUrl);
    const port = parsed.port || 'default';
    return `arrakis_${port}`;
  } catch {
    return 'arrakis_local';
  }
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
  const updatedAt = new Date().toISOString();
  for (const filePath of resolveJurisdictionPaths()) {
    const parent = dirname(filePath);
    mkdirSync(parent, { recursive: true });
    const current: JurisdictionsFile = existsSync(filePath)
      ? JSON.parse(readFileSync(filePath, 'utf8'))
      : {};
    const jurisdictions = current.jurisdictions ?? {};
    const targetKey = getJurisdictionKeyForRpc(rpcUrl);
    const previous = jurisdictions[targetKey] ?? {};
    jurisdictions[targetKey] = {
      ...previous,
      name: previous.name ?? 'Arrakis (Shared Anvil)',
      chainId: Number(jadapter.chainId || 31337),
      rpc: rpcUrl,
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
        rpc: String(replica.rpcs?.[0] || resolvedArgs.rpcUrl || '/rpc'),
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

    const registerTx = await jadapter.depository.connect(signer).externalTokenToReserve({
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
    return await jadapter.getTokenRegistry().catch(() => []);
  }
  return [];
};

const waitForTokenCatalog = async (jadapter: JAdapter, rounds = 80): Promise<JTokenInfo[]> => {
  for (let i = 0; i < rounds; i += 1) {
    const tokens = await jadapter.getTokenRegistry().catch(() => []);
    if (tokens.length > 0) return tokens;
    await sleep(250);
  }
  throw new Error('TOKEN_CATALOG_EMPTY');
};

const applyHubConfig = (env: Env, entityId: string): void => {
  const replica = getEntityReplicaById(env, entityId);
  if (!replica?.state) {
    throw new Error(`HUB_REPLICA_MISSING: ${entityId}`);
  }
  replica.state.hubRebalanceConfig = {
    matchingStrategy: 'amount',
    policyVersion: 1,
    routingFeePPM: 1000,
    baseFee: 0n,
    disputeAutoFinalizeMode: resolvedArgs.name.toLowerCase() === 'h2' ? 'ignore' : 'auto',
    rebalanceBaseFee: 10n ** 17n,
    rebalanceLiquidityFeeBps: 1n,
    rebalanceGasFee: 0n,
    rebalanceTimeoutMs: 10 * 60 * 1000,
  };
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

const getReserveHealth = (env: Env, entityId: string, tokenCatalog: JTokenInfo[]): LocalHealthResponse['bootstrapReserves'] => {
  const replica = getEntityReplicaById(env, entityId);
  const tokens = tokenCatalog.slice(0, HUB_REQUIRED_TOKEN_COUNT).map(token => {
    const tokenId = Number(token.tokenId);
    const decimals = Number.isFinite(token.decimals) ? Number(token.decimals) : 18;
    const current = replica?.state?.reserves?.get(String(tokenId)) ?? 0n;
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
    replica.state.reserves.set(String(tokenId), onChain);
  }
  return getReserveHealth(env, entityId, tokenCatalog);
};

const ensureBootstrapReserves = async (
  env: Env,
  entityId: string,
  tokenCatalog: JTokenInfo[],
): Promise<void> => {
  const startedAt = startTiming('reserve_funding');
  const jadapter = getActiveJAdapter(env);
  if (!jadapter) {
    throw new Error('ACTIVE_JADAPTER_MISSING');
  }

  const bootstrapTokens = tokenCatalog.slice(0, HUB_REQUIRED_TOKEN_COUNT);
  if (!resolvedArgs.deployTokens) {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const health = await syncReserveSnapshotFromChain(env, entityId, tokenCatalog);
      if (health.ok) {
        finishTiming('reserve_funding', startedAt);
        return;
      }
      await sleep(250);
    }
    throw new Error(`RESERVE_SYNC_TIMEOUT: ${resolvedArgs.name}`);
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
  await syncReserveSnapshotFromChain(env, entityId, tokenCatalog);

  finishTiming('reserve_funding', startedAt);
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
      name: String(profile.metadata?.name || '').trim(),
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
      ready: hasPairMutualCredit(env, selfEntityId, peer.entityId, HUB_MESH_TOKEN_ID, HUB_MESH_CREDIT_AMOUNT),
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
    apiUrl,
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

  const importJStartedAt = startTiming('import_j');
  const jurisdiction = resolveJurisdictionConfig(resolvedArgs.rpcUrl);
  enqueueRuntimeInput(env, {
    runtimeTxs: [
      {
        type: 'importJ',
        data: {
          name: jurisdiction.name,
          chainId: jurisdiction.chainId,
          ticker: 'XLN',
          rpcs: [jurisdiction.rpc],
          ...(resolvedArgs.deployTokens ? {} : { contracts: jurisdiction.contracts }),
        },
      },
    ],
    entityInputs: [],
  });
  await runtimeProcess(env);
  finishTiming('import_j', importJStartedAt);

  const hubBootstrapStartedAt = startTiming('hub_bootstrap');
  const bootstrap = await bootstrapHub(env, {
    name: resolvedArgs.name,
    region: resolvedArgs.region,
    signerId: resolvedArgs.signerLabel,
    seed: resolvedArgs.seed,
    relayUrl: resolvedArgs.relayUrl,
    rpcUrl: jurisdiction.rpc,
    httpUrl: apiUrl,
    port: resolvedArgs.apiPort,
    capabilities: ['hub', 'routing', 'faucet'],
  });
  if (!bootstrap?.entityId) {
    throw new Error('HUB_BOOTSTRAP_FAILED');
  }
  applyHubConfig(env, bootstrap.entityId);
  finishTiming('hub_bootstrap', hubBootstrapStartedAt);

  await ensureOrderbook(env, bootstrap.entityId, bootstrap.signerId);

  const jadapter = getActiveJAdapter(env);
  if (!jadapter) {
    throw new Error('ACTIVE_JADAPTER_MISSING_AFTER_IMPORT');
  }
  await ensureRpcStackReady(env, jadapter);

  const tokenCatalog = resolvedArgs.deployTokens
    ? await ensureTokenCatalog(jadapter, true)
    : await waitForTokenCatalog(jadapter);

  const p2pConnectStartedAt = startTiming('p2p_connect');
  const p2p = startP2P(env, {
    relayUrls: [resolvedArgs.relayUrl],
    advertiseEntityIds: [bootstrap.entityId],
    isHub: true,
    profileName: resolvedArgs.name,
    gossipPollMs: BOOTSTRAP_POLL_MS * 5,
  });
  if (!p2p) {
    throw new Error('P2P_START_FAILED');
  }
  finishTiming('p2p_connect', p2pConnectStartedAt);

  await ensureBootstrapReserves(env, bootstrap.entityId, tokenCatalog);

  const totalMeshStartedAt = startTiming('mesh_ready_total');
  let gossipReadyMarked = false;
  let accountsReadyMarked = false;
  let creditReadyMarked = false;
  let meshLoopInFlight = false;

  const driveMeshBootstrap = async (): Promise<void> => {
    if (meshLoopInFlight) return;
    meshLoopInFlight = true;
    try {
      const visibleHubProfiles = readVisibleHubProfiles(env);
      const requiredHubProfiles = resolvedArgs.meshHubNames
        .map(name => visibleHubProfiles.find(profile => profile.name === name) || null)
        .filter((profile): profile is { name: string; entityId: string } => profile !== null);

      if (!gossipReadyMarked && requiredHubProfiles.length === resolvedArgs.meshHubNames.length) {
        const startedAt = timings.gossip_ready.startedAt ?? startTiming('gossip_ready');
        finishTiming('gossip_ready', startedAt);
        gossipReadyMarked = true;
      } else if (!gossipReadyMarked) {
        startTiming('gossip_ready');
      }

      const peers = requiredHubProfiles.filter(profile => profile.entityId !== bootstrap.entityId.toLowerCase());
      if (gossipReadyMarked && peers.length > 0) {
        await ensurePeerBootstrapReserves(env, peers.map(peer => peer.entityId), tokenCatalog);
        await syncReserveSnapshotFromChain(env, bootstrap.entityId, tokenCatalog);
      }
      const openInputs: EntityInput[] = [];
      const creditInputs: EntityInput[] = [];

      for (const peer of peers) {
        const localAccount = getAccountMachine(env, bootstrap.entityId, peer.entityId);
        const canWrite = !localAccount?.pendingFrame && Number(localAccount?.mempool?.length || 0) === 0;

        if (
          bootstrap.entityId.toLowerCase() < peer.entityId.toLowerCase() &&
          !hasAccount(env, bootstrap.entityId, peer.entityId) &&
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
                  creditAmount: HUB_MESH_CREDIT_AMOUNT,
                },
              },
            ],
          });
        }

        if (!localAccount || !canWrite) continue;
        const grantedByMe = getCreditGrantedByEntity(localAccount, bootstrap.entityId, HUB_MESH_TOKEN_ID);
        if (grantedByMe < HUB_MESH_CREDIT_AMOUNT) {
          creditInputs.push({
            entityId: bootstrap.entityId,
            signerId: bootstrap.signerId,
            entityTxs: [
              {
                type: 'extendCredit',
                data: {
                  counterpartyEntityId: peer.entityId,
                  tokenId: HUB_MESH_TOKEN_ID,
                  amount: HUB_MESH_CREDIT_AMOUNT,
                },
              },
            ],
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
        peers.every(peer => hasAccount(env, bootstrap.entityId, peer.entityId));
      if (allAccountsReady && !accountsReadyMarked) {
        const startedAt = timings.mesh_accounts.startedAt ?? startTiming('mesh_accounts');
        finishTiming('mesh_accounts', startedAt);
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
          hasPairMutualCredit(env, bootstrap.entityId, peer.entityId, HUB_MESH_TOKEN_ID, HUB_MESH_CREDIT_AMOUNT),
        );
      if (allCreditReady && !creditReadyMarked) {
        const startedAt = timings.mesh_credit.startedAt ?? startTiming('mesh_credit');
        finishTiming('mesh_credit', startedAt);
        creditReadyMarked = true;
      }

      if (allCreditReady && timings.mesh_ready_total.ms === null) {
        finishTiming('mesh_ready_total', totalMeshStartedAt);
      }
    } finally {
      meshLoopInFlight = false;
    }
  };

  const meshLoop = setInterval(() => {
    void driveMeshBootstrap().catch(error => {
      console.error(`[${resolvedArgs.name}] mesh bootstrap tick failed:`, (error as Error).message);
    });
  }, BOOTSTRAP_POLL_MS);
  void driveMeshBootstrap();

  const server = Bun.serve({
    hostname: resolvedArgs.apiHost,
    port: resolvedArgs.apiPort,
    async fetch(request) {
      const url = new URL(request.url);
      const pathname = url.pathname;
      const headers = { 'Content-Type': 'application/json' };

      if (pathname === '/api/info') {
        return new Response(
          JSON.stringify({
            name: resolvedArgs.name,
            entityId: bootstrap.entityId,
            runtimeId: env.runtimeId,
            apiUrl,
            relayUrl: resolvedArgs.relayUrl,
          }),
          { headers },
        );
      }

      if (pathname === '/api/health') {
        const health = buildLocalHealth(env, bootstrap.entityId, tokenCatalog);
        return new Response(JSON.stringify(health), { headers });
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

      if (pathname === '/api/faucet/offchain' && request.method === 'POST') {
        const body = await request.json() as {
          userEntityId?: string;
          userRuntimeId?: string;
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
          return new Response(
            JSON.stringify({
              success: false,
              code: 'FAUCET_ACCOUNT_NOT_OPEN',
              error: 'No bilateral account with this hub. Open account first, then retry faucet.',
            }),
            { status: 409, headers },
          );
        }

        const amount = String(body.amount || '100');
        const tokenId = Number(body.tokenId ?? 1);
        const signerId = resolveEntityProposerId(env, bootstrap.entityId, 'hub-offchain-faucet');
        enqueueRuntimeInput(env, {
          runtimeTxs: [],
          entityInputs: [
            {
              entityId: bootstrap.entityId,
              signerId,
              entityTxs: [
                {
                  type: 'directPayment',
                  data: {
                    targetEntityId: userEntityId,
                    tokenId,
                    amount: ethers.parseUnits(amount, 18),
                    route: [bootstrap.entityId, userEntityId],
                    description: 'faucet-offchain',
                  },
                },
              ],
            },
          ],
        });
        return new Response(JSON.stringify({ success: true, accepted: true }), { headers });
      }

      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers });
    },
  });

  console.log(
    `[E2E-HUB] READY name=${resolvedArgs.name} entityId=${bootstrap.entityId} runtimeId=${String(env.runtimeId || '')} api=${apiUrl} relay=${resolvedArgs.relayUrl}`,
  );

  const shutdown = async () => {
    clearInterval(meshLoop);
    server.stop(true);
    process.exit(0);
  };

  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });

  await waitUntil(() => false, Number.MAX_SAFE_INTEGER, 1000);
};

run().catch(error => {
  console.error(`[E2E-HUB] FAILED ${resolvedArgs.name}:`, (error as Error).stack || (error as Error).message);
  process.exit(1);
});
