#!/usr/bin/env bun

import { compareStableText, safeStringify } from '../serialization-utils';
import { createStructuredLogger } from '../logger';
import { decodeRuntimeAdapterMessage } from '../radapter/codec';
import { encodeBoard, hashBoard } from '../entity-factory';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../account-crypto';
import { createDirectRuntimeWsRoute } from '../networking/direct-runtime-bun';
import { clearJurisdictionsCache, loadJurisdictions } from '../jurisdiction-loader';
import {
  attachRuntimeAdapterTicker,
  closeInvalidRuntimeAdapterMessage,
  forgetRuntimeAdapterClient,
  handleRuntimeAdapterMessage,
} from '../radapter/server';
import {
  getActiveJAdapter,
  getP2PState,
  closeInfraDb,
  closeRuntimeDb,
  main,
  enqueueRuntimeInput,
  handleInboundP2PEntityInput,
  sendEntityInput,
  startP2P,
  stopP2P,
  startRuntimeLoop,
  stopRuntimeLoopAndWait,
  readPersistedStorageFrameRecord,
  readPersistedStorageHead,
  listPersistedCheckpointHeights,
  loadEntityAccountDocFromStorageDb,
  loadEntityStateFromStorageDb,
  loadEntityViewPageFromStorageDb,
  listPersistedEntityIdsAtHeight,
  registerEnvChangeCallback,
} from '../runtime.ts';
import type { AccountMachine, CrossJurisdictionSwapRoute, EntityInput, Env } from '../types';
import type { JAdapter, JTokenInfo } from '../jadapter/types';
import {
  BOOTSTRAP_POLL_MS,
  DEFAULT_ACCOUNT_TOKEN_IDS,
  HUB_REQUIRED_TOKEN_COUNT,
  getAccountMachine,
  getCreditGrantedByEntity,
  getEntityOutCapacity,
  getEntityReplicaById,
  hasQueuedOpenAccount,
  hasPairMutualCredit,
  isAccountConsensusReady,
  settleRuntimeFor,
  sleep,
  waitUntil,
} from './mesh-common';
import { buildDefaultEntitySwapPairs, getSwapPairPolicyByBaseQuote } from '../account-utils';
import { LIMITS, SWAP as SWAP_CONSTANTS } from '../constants';
import { ORDERBOOK_PRICE_SCALE } from '../orderbook';
import { startParentLivenessWatch } from './parent-watch';
import { createHttpDrainTracker, stopServerGracefully } from './graceful-server';

type Args = {
  name: string;
  seed: string;
  signerLabel: string;
  relayUrl: string;
  apiHost: string;
  apiPort: number;
  directWsUrl: string;
  rpcUrl: string;
  meshHubNames: string[];
  meshHubIdentitiesJson: string;
  dbPath: string;
};

type MeshHubIdentity = {
  name: string;
  entityId: string;
  signerId: string;
};

type JurisdictionConfig = {
  name: string;
  chainId: number;
  rpc: string;
  blockTimeMs?: number;
  contracts: {
    depository: string;
    entityProvider: string;
    account?: string;
    deltaTransformer?: string;
  };
};

type HubProfile = {
  name: string;
  entityId: string;
  signerId?: string;
  jurisdictionName?: string;
  chainId?: number;
};

type MarketMakerOfferSpec = {
  offerId: string;
  pairId: string;
  hubEntityId: string;
  giveTokenId: number;
  giveAmount: bigint;
  wantTokenId: number;
  wantAmount: bigint;
  minFillRatio: number;
  crossJurisdiction?: CrossJurisdictionSwapRoute;
};

type MarketMakerEntityContext = {
  entityId: string;
  signerId: string;
  jurisdictionName: string;
  chainId: number;
};

type MarketMakerHealth = {
  enabled: boolean;
  ok: boolean;
  entityId: string | null;
  p2p?: {
    directPeers: Array<{ runtimeId: string; endpoint: string; open: boolean }>;
  };
  connectivity?: Array<{
    hubEntityId: string;
    accountReady: boolean;
    status: string | null;
    currentHeight: number | null;
    mempoolLength: number;
    pendingFrame: boolean;
    swapOffers: number;
    tokens: Array<{
      tokenId: number;
      mmGranted: string;
      hubGranted: string;
      mmOutCapacity: string;
      hubOutCapacity: string;
      mutualReady: boolean;
    }>;
  }>;
  expectedOffersPerHub: number;
  expectedOffersPerPair: number;
  hubs: Array<{
    hubEntityId: string;
    offers: number;
    ready: boolean;
    pairs: Array<{ pairId: string; offers: number; ready: boolean }>;
  }>;
};

const MARKET_MAKER_CREDIT_AMOUNT = 50_000_000n * 10n ** 18n;
const MARKET_MAKER_QUOTE_LOOP_MS = Math.max(1000, Number(process.env['MARKET_MAKER_QUOTE_LOOP_MS'] || '30000'));
const MARKET_MAKER_BOOTSTRAP_LOOP_MS = Math.max(250, Number(process.env['MARKET_MAKER_BOOTSTRAP_LOOP_MS'] || '1000'));
const MARKET_MAKER_BOOTSTRAP_TIMEOUT_MS = Math.max(
  10_000,
  Number(process.env['MARKET_MAKER_BOOTSTRAP_TIMEOUT_MS'] || '300000'),
);
const MARKET_MAKER_OFFERS_PER_ACCOUNT_PER_TICK = Math.max(
  2,
  Number(process.env['MARKET_MAKER_OFFERS_PER_ACCOUNT_PER_TICK'] || '30'),
);
const MARKET_MAKER_MAX_NEW_OFFERS_PER_TICK = Math.max(
  4,
  Number(process.env['MARKET_MAKER_MAX_NEW_OFFERS_PER_TICK'] || '12'),
);
const MARKET_MAKER_CROSS_LEVELS_PER_PAIR = Math.max(
  1,
  Math.min(8, Number(process.env['MARKET_MAKER_CROSS_LEVELS_PER_PAIR'] || '4')),
);
const MARKET_MAKER_CROSS_EXPIRY_MS = Math.max(
  60_000,
  Number(process.env['MARKET_MAKER_CROSS_EXPIRY_MS'] || String(24 * 60 * 60 * 1000)),
);
const MARKET_MAKER_LEVEL_OFFSETS_BPS = [2, 4, 6, 8, 10, 12, 15, 20, 25, 32, 40, 50, 65, 80, 100] as const;
const MARKET_MAKER_LEVEL_BASE_SIZES = [
  120n * 10n ** 18n,
  140n * 10n ** 18n,
  160n * 10n ** 18n,
  180n * 10n ** 18n,
  210n * 10n ** 18n,
  240n * 10n ** 18n,
  270n * 10n ** 18n,
  300n * 10n ** 18n,
  360n * 10n ** 18n,
  420n * 10n ** 18n,
  500n * 10n ** 18n,
  600n * 10n ** 18n,
  720n * 10n ** 18n,
  840n * 10n ** 18n,
  960n * 10n ** 18n,
] as const;
const MARKET_MAKER_STABLE_LEVEL_OFFSETS_BPS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 28, 36, 48] as const;
const MARKET_MAKER_STABLE_LEVEL_BASE_SIZES = [
  120n * 10n ** 18n,
  140n * 10n ** 18n,
  180n * 10n ** 18n,
  210n * 10n ** 18n,
  240n * 10n ** 18n,
  300n * 10n ** 18n,
  360n * 10n ** 18n,
  420n * 10n ** 18n,
  480n * 10n ** 18n,
  560n * 10n ** 18n,
  640n * 10n ** 18n,
  720n * 10n ** 18n,
  800n * 10n ** 18n,
  900n * 10n ** 18n,
  1_000n * 10n ** 18n,
] as const;
const argsRaw = process.argv.slice(2);

const getArg = (name: string, fallback = ''): string => {
  const eq = argsRaw.find(arg => arg.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const index = argsRaw.indexOf(name);
  if (index === -1) return fallback;
  return argsRaw[index + 1] || fallback;
};

const parseArgs = (): Args => {
  const apiPort = Number(getArg('--api-port', '0'));
  if (!Number.isFinite(apiPort) || apiPort <= 0) {
    throw new Error(`Invalid --api-port: ${String(apiPort)}`);
  }
  return {
    name: getArg('--name', 'MM'),
    seed: getArg('--seed', 'xln-mesh-mm'),
    signerLabel: getArg('--signer-label', 'mm-1'),
    relayUrl: getArg('--relay-url', 'ws://127.0.0.1:20002/relay'),
    apiHost: getArg('--api-host', '127.0.0.1'),
    apiPort,
    directWsUrl: getArg('--direct-ws-url', ''),
    rpcUrl: getArg('--rpc-url', ''),
    meshHubNames: getArg('--mesh-hub-names', 'H1,H2,H3')
      .split(',')
      .map(part => part.trim())
      .filter(Boolean),
    meshHubIdentitiesJson: getArg('--mesh-hub-identities-json', '[]'),
    dbPath: getArg('--db-path', ''),
  };
};

const resolvedArgs = parseArgs();
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
  throw new Error('[MESH-MM] Missing required --direct-ws-url');
}
const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;
const nodeLog = createStructuredLogger('mesh.marketMaker', { name: resolvedArgs.name });

const resolveJurisdictionConfig = (rpcUrlOverride: string): JurisdictionConfig => {
  const data = loadJurisdictions();
  const map = data.jurisdictions ?? {};
  const requestedRpc = String(rpcUrlOverride || '').trim();
  const exactMatch = Object.values(map).find((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    return String((entry as JurisdictionConfig).rpc || '').trim() === requestedRpc;
  });
  const arrakis = exactMatch ?? map['arrakis'] ?? Object.values(map)[0];
  if (!arrakis) {
    throw new Error('JURISDICTION_NOT_FOUND');
  }
  return {
    ...(arrakis as JurisdictionConfig),
    rpc: rpcUrlOverride || (arrakis as JurisdictionConfig).rpc,
  };
};

const requireJurisdictionBlockTimeMs = (jurisdiction: JurisdictionConfig): number => {
  const value = Number(jurisdiction.blockTimeMs);
  if (Number.isFinite(value) && value > 0) return Math.floor(value);
  throw new Error(`JURISDICTION_BLOCK_TIME_MISSING:${jurisdiction.name}`);
};

const isSecondaryJurisdictionConfig = (key: string, jurisdiction: JurisdictionConfig, primaryRpc: string): boolean => {
  const normalizedKey = String(key || '').trim().toLowerCase();
  const normalizedName = String(jurisdiction.name || '').trim().toLowerCase();
  const normalizedRpc = String(jurisdiction.rpc || '').trim();
  if (primaryRpc && normalizedRpc === primaryRpc) return false;
  return normalizedKey === 'tron' || normalizedKey === 'rpc2' || normalizedName.includes('tron') || normalizedRpc.includes('/rpc2');
};

const resolveSecondaryJurisdictions = (primaryRpc: string): JurisdictionConfig[] => {
  clearJurisdictionsCache();
  const data = loadJurisdictions();
  const entries = Object.entries(data.jurisdictions ?? {});
  return entries
    .filter(([, jurisdiction]) => Boolean(jurisdiction?.rpc && jurisdiction?.contracts?.depository && jurisdiction?.contracts?.entityProvider))
    .filter(([key, jurisdiction]) => isSecondaryJurisdictionConfig(key, jurisdiction as JurisdictionConfig, primaryRpc))
    .map(([, jurisdiction]) => jurisdiction as JurisdictionConfig);
};

const resolveImportedJurisdictionRpc = (jurisdiction: JurisdictionConfig): string =>
  resolveLocalApiUrl(jurisdiction.rpc);

const toEntityJurisdictionConfig = (jurisdiction: JurisdictionConfig) => ({
  name: jurisdiction.name,
  address: resolveImportedJurisdictionRpc(jurisdiction),
  entityProviderAddress: jurisdiction.contracts.entityProvider,
  depositoryAddress: jurisdiction.contracts.depository,
  chainId: jurisdiction.chainId,
});

const hasJurisdictionReplica = (env: Env, name: string): boolean => {
  const normalized = String(name || '').trim().toLowerCase();
  if (!normalized) return false;
  for (const existing of env.jReplicas?.keys?.() || []) {
    if (String(existing || '').trim().toLowerCase() === normalized) return true;
  }
  return false;
};

const importJurisdictionIfNeeded = async (
  env: Env,
  jurisdiction: JurisdictionConfig,
  rounds = 35,
): Promise<void> => {
  if (hasJurisdictionReplica(env, jurisdiction.name)) return;
  enqueueRuntimeInput(env, {
    runtimeTxs: [{
      type: 'importJ',
      data: {
        name: jurisdiction.name,
        chainId: jurisdiction.chainId,
        ticker: 'XLN',
        rpcs: [resolveImportedJurisdictionRpc(jurisdiction)],
        blockTimeMs: requireJurisdictionBlockTimeMs(jurisdiction),
        contracts: jurisdiction.contracts,
      },
    }],
    entityInputs: [],
  });
  await settleRuntimeFor(env, rounds);
};

const createMarketMakerEntityContext = async (
  env: Env,
  jurisdiction: JurisdictionConfig,
  signerLabel: string,
  profileName: string,
  position: { x: number; y: number; z: number; jurisdiction?: string },
): Promise<MarketMakerEntityContext> => {
  const privateKey = deriveSignerKeySync(resolvedArgs.seed, signerLabel);
  const signerId = deriveSignerAddressSync(resolvedArgs.seed, signerLabel).toLowerCase();
  registerSignerKey(signerId, privateKey);
  const consensusConfig = {
    mode: 'proposer-based' as const,
    threshold: 1n,
    validators: [signerId],
    shares: { [signerId]: 1n },
    jurisdiction: toEntityJurisdictionConfig(jurisdiction),
  };
  const entityId = hashBoard(encodeBoard(consensusConfig)).toLowerCase();
  if (!getEntityReplicaById(env, entityId)) {
    enqueueRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importReplica',
        entityId,
        signerId,
        data: {
          config: consensusConfig,
          isProposer: true,
          profileName,
          position,
        },
      }],
      entityInputs: [],
    });
    await settleRuntimeFor(env, 35);
    await waitForReplicaReady(env, entityId);
  }
  return {
    entityId,
    signerId,
    jurisdictionName: jurisdiction.name,
    chainId: Number(jurisdiction.chainId || 0),
  };
};

const waitForTokenCatalog = async (jadapter: JAdapter, rounds = 80): Promise<JTokenInfo[]> => {
  for (let i = 0; i < rounds; i += 1) {
    const tokens = await jadapter.getTokenRegistry().catch(() => []);
    if (tokens.length >= HUB_REQUIRED_TOKEN_COUNT) return tokens;
    await sleep(250);
  }
  throw new Error('TOKEN_CATALOG_EMPTY');
};

const waitForActiveJAdapter = async (env: Env, rounds = 200): Promise<JAdapter> => {
  for (let i = 0; i < rounds; i += 1) {
    const jadapter = getActiveJAdapter(env);
    if (jadapter) return jadapter;
    await settleRuntimeFor(env, 5);
    await sleep(50);
  }
  throw new Error('ACTIVE_JADAPTER_NOT_READY');
};

const waitForReplicaReady = async (env: Env, entityId: string, rounds = 200): Promise<void> => {
  const ready = await waitUntil(() => Boolean(getEntityReplicaById(env, entityId)), rounds, BOOTSTRAP_POLL_MS);
  if (!ready) {
    throw new Error(`MM_REPLICA_NOT_READY entityId=${entityId}`);
  }
};

const ensureJurisdictionReplica = (env: Env, jadapter: JAdapter, rpcUrl: string): void => {
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

const hubBaseName = (name: string): string => String(name || '').trim().split(/\s+/)[0]?.toLowerCase() || '';

const readHubSignerId = (profile: { metadata?: any }): string => {
  const validators = profile.metadata?.board?.validators;
  if (!Array.isArray(validators) || validators.length === 0) return '';
  const first = validators[0] || {};
  return String(first.signerId || first.signer || '').trim().toLowerCase();
};

const readVisibleHubProfiles = (env: Env, includeSiblings = false): HubProfile[] => {
  const required = new Set(resolvedArgs.meshHubNames.map((name) => name.toLowerCase()));
  return (env.gossip?.getProfiles?.() || [])
    .filter(profile =>
      typeof profile?.name === 'string' &&
      typeof profile?.entityId === 'string' &&
      profile.metadata?.isHub === true,
    )
    .filter(profile => {
      const name = String(profile.name || '').trim();
      const lower = name.toLowerCase();
      if (required.has(lower)) return true;
      return includeSiblings && required.has(hubBaseName(name));
    })
    .map(profile => ({
      name: String(profile.name || '').trim(),
      entityId: String(profile.entityId || '').toLowerCase(),
      signerId: readHubSignerId(profile),
      jurisdictionName: String(profile.metadata?.jurisdiction?.name || '').trim(),
      chainId: Number(profile.metadata?.jurisdiction?.chainId || 0),
    }))
    .sort((left, right) =>
      compareStableText(hubBaseName(left.name), hubBaseName(right.name)) ||
      (Number(left.chainId || 0) - Number(right.chainId || 0)) ||
      compareStableText(left.entityId, right.entityId),
    );
};

const parseMeshHubIdentities = (raw: string): MeshHubIdentity[] => {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => ({
        name: String(entry?.name || '').trim(),
        entityId: String(entry?.entityId || '').trim().toLowerCase(),
        signerId: String(entry?.signerId || '').trim().toLowerCase(),
      }))
      .filter((entry) => entry.name && entry.entityId && entry.signerId);
  } catch {
    return [];
  }
};

const getMarketMakerLevelProfile = (baseTokenId: number, quoteTokenId: number): {
  offsetsBps: readonly number[];
  baseSizes: readonly bigint[];
} => {
  if (baseTokenId === 1 && quoteTokenId === 3) {
    return {
      offsetsBps: MARKET_MAKER_STABLE_LEVEL_OFFSETS_BPS,
      baseSizes: MARKET_MAKER_STABLE_LEVEL_BASE_SIZES,
    };
  }
  return {
    offsetsBps: MARKET_MAKER_LEVEL_OFFSETS_BPS,
    baseSizes: MARKET_MAKER_LEVEL_BASE_SIZES,
  };
};

const snapPriceTicks = (ticks: bigint, stepTicks: number, mode: 'up' | 'down'): bigint => {
  const step = BigInt(Math.max(1, stepTicks));
  if (mode === 'up') return ((ticks + step - 1n) / step) * step;
  return (ticks / step) * step;
};

const isWithinPairBand = (anchorTicks: bigint, priceTicks: bigint): boolean => {
  if (anchorTicks <= 0n || priceTicks <= 0n) return false;
  const rejectDelta = (anchorTicks * BigInt(SWAP_CONSTANTS.PRICE_REJECT_BPS)) / BigInt(SWAP_CONSTANTS.BPS_BASE);
  const minAllowed = anchorTicks - rejectDelta;
  const maxAllowed = anchorTicks + rejectDelta;
  return priceTicks >= minAllowed && priceTicks <= maxAllowed;
};

const normalizeTokenIdsForMm = (tokenCatalog: JTokenInfo[]): number[] => {
  const ids = tokenCatalog
    .map(token => Number(token.tokenId))
    .filter(tokenId => Number.isFinite(tokenId) && tokenId > 0)
    .sort((a, b) => a - b);
  const unique = Array.from(new Set(ids)).slice(0, 3);
  if (unique.length >= HUB_REQUIRED_TOKEN_COUNT) {
    return unique;
  }
  return [...DEFAULT_ACCOUNT_TOKEN_IDS];
};

const collectOfferIdsForAccount = (
  account: Pick<AccountMachine, 'swapOffers' | 'mempool' | 'pendingFrame'> | null | undefined,
): Set<string> => {
  const ids = new Set<string>();
  if (account?.swapOffers instanceof Map) {
    for (const offerId of account.swapOffers.keys()) ids.add(String(offerId));
  }
  for (const tx of account?.mempool ?? []) {
    if (tx?.type !== 'swap_offer') continue;
    const offerId = String(tx?.data?.offerId || '');
    if (offerId) ids.add(offerId);
  }
  for (const tx of account?.pendingFrame?.accountTxs ?? []) {
    if (tx?.type !== 'swap_offer') continue;
    const offerId = String(tx?.data?.offerId || '');
    if (offerId) ids.add(offerId);
  }
  return ids;
};

const buildMarketMakerOfferSpecs = (hubEntityIds: string[], tokenIds: number[]): MarketMakerOfferSpec[] => {
  const specs: MarketMakerOfferSpec[] = [];
  const defaultPairs = buildDefaultEntitySwapPairs(tokenIds);
  const hubSkewBps = (hubEntityId: string, pairIndex: number): number => {
    const tail = hubEntityId.slice(-6);
    let hash = 0;
    for (let i = 0; i < tail.length; i += 1) {
      hash = ((hash * 33) + tail.charCodeAt(i) + (pairIndex * 17)) % 11;
    }
    return hash - 5;
  };
  for (const hubEntityId of hubEntityIds) {
    const hubSuffix = hubEntityId.slice(-6).toLowerCase();
    const pairContexts = defaultPairs.map((pair, pairIndex) => {
      const pairPolicy = getSwapPairPolicyByBaseQuote(pair.baseTokenId, pair.quoteTokenId);
      const levelProfile = getMarketMakerLevelProfile(pair.baseTokenId, pair.quoteTokenId);
      const skewBps = hubSkewBps(hubEntityId, pairIndex);
      const midPriceTicks = (pairPolicy.mmMidPriceTicks * BigInt(10_000 + skewBps)) / 10_000n;
      return {
        pair,
        levelProfile,
        midPriceTicks,
        stepTicksBig: BigInt(Math.max(1, pairPolicy.priceStepTicks)),
        stepTicks: Math.max(1, pairPolicy.priceStepTicks),
      };
    });
    const maxLevels = pairContexts.reduce((max, entry) => Math.max(max, entry.levelProfile.offsetsBps.length), 0);
    for (let level = 0; level < maxLevels; level += 1) {
      for (const entry of pairContexts) {
        if (level >= entry.levelProfile.offsetsBps.length) continue;
        const offsetBps = entry.levelProfile.offsetsBps[level]!;
        const baseSize = entry.levelProfile.baseSizes[level]!;
        const askRaw = (entry.midPriceTicks * BigInt(10_000 + offsetBps)) / 10_000n;
        const bidRaw = (entry.midPriceTicks * BigInt(Math.max(1, 10_000 - offsetBps))) / 10_000n;
        const askPriceTicks = snapPriceTicks(askRaw, entry.stepTicks, 'up');
        let bidPriceTicks = snapPriceTicks(bidRaw, entry.stepTicks, 'down');
        if (bidPriceTicks >= askPriceTicks) {
          bidPriceTicks = askPriceTicks > entry.stepTicksBig ? askPriceTicks - entry.stepTicksBig : 1n;
        }
        if (!isWithinPairBand(entry.midPriceTicks, askPriceTicks)) continue;
        if (!isWithinPairBand(entry.midPriceTicks, bidPriceTicks)) continue;
        const askWantAmount = (baseSize * askPriceTicks) / ORDERBOOK_PRICE_SCALE;
        const bidGiveAmount = (baseSize * bidPriceTicks) / ORDERBOOK_PRICE_SCALE;
        const levelId = level + 1;

        if (askWantAmount > 0n) {
          specs.push({
            offerId: `mm-${hubSuffix}-${entry.pair.baseTokenId}-${entry.pair.quoteTokenId}-ask-${levelId}`,
            pairId: entry.pair.pairId,
            hubEntityId,
            giveTokenId: entry.pair.baseTokenId,
            giveAmount: baseSize,
            wantTokenId: entry.pair.quoteTokenId,
            wantAmount: askWantAmount,
            // Resting MM quotes must be ordinary GTC orders. A non-zero minFillRatio on
            // a resting book order creates AON-like semantics that the matcher cannot
            // honor safely across bilateral state channels, so keep it at zero here.
            minFillRatio: 0,
          });
        }
        if (bidGiveAmount > 0n) {
          specs.push({
            offerId: `mm-${hubSuffix}-${entry.pair.baseTokenId}-${entry.pair.quoteTokenId}-bid-${levelId}`,
            pairId: entry.pair.pairId,
            hubEntityId,
            giveTokenId: entry.pair.quoteTokenId,
            giveAmount: bidGiveAmount,
            wantTokenId: entry.pair.baseTokenId,
            wantAmount: baseSize,
            // Same rule for resting bids: keep them plain GTC so they are always
            // eligible to rest on book and match incrementally.
            minFillRatio: 0,
          });
        }
      }
    }
  }
  return specs;
};

const sameJurisdiction = (
  left: Pick<MarketMakerEntityContext | HubProfile, 'jurisdictionName' | 'chainId'>,
  right: Pick<MarketMakerEntityContext | HubProfile, 'jurisdictionName' | 'chainId'>,
): boolean => {
  const leftName = String(left.jurisdictionName || '').trim().toLowerCase();
  const rightName = String(right.jurisdictionName || '').trim().toLowerCase();
  if (leftName && rightName) return leftName === rightName;
  const leftChain = Number(left.chainId || 0);
  const rightChain = Number(right.chainId || 0);
  return leftChain > 0 && leftChain === rightChain;
};

const buildMarketMakerCrossOfferSpecs = (
  env: Env,
  sourceContext: MarketMakerEntityContext,
  targetContext: MarketMakerEntityContext,
  sourceHubs: HubProfile[],
  targetHubs: HubProfile[],
  tokenIds: number[],
): MarketMakerOfferSpec[] => {
  if (sourceContext.entityId === targetContext.entityId || sameJurisdiction(sourceContext, targetContext)) return [];
  const specs: MarketMakerOfferSpec[] = [];
  const defaultPairs = buildDefaultEntitySwapPairs(tokenIds);
  const targetByBaseName = new Map(targetHubs.map(hub => [hubBaseName(hub.name), hub] as const));
  const now = Number(env.timestamp || Date.now());

  for (const sourceHub of sourceHubs) {
    const targetHub = targetByBaseName.get(hubBaseName(sourceHub.name));
    if (!targetHub || sameJurisdiction(sourceHub, targetHub)) continue;
    const sourceHubSuffix = sourceHub.entityId.slice(-6).toLowerCase();
    const targetHubSuffix = targetHub.entityId.slice(-6).toLowerCase();

    for (const pair of defaultPairs) {
      const pairPolicy = getSwapPairPolicyByBaseQuote(pair.baseTokenId, pair.quoteTokenId);
      const levelProfile = getMarketMakerLevelProfile(pair.baseTokenId, pair.quoteTokenId);
      const levelCount = Math.min(MARKET_MAKER_CROSS_LEVELS_PER_PAIR, levelProfile.offsetsBps.length);

      for (let level = 0; level < levelCount; level += 1) {
        const offsetBps = levelProfile.offsetsBps[level]!;
        const baseSize = levelProfile.baseSizes[level]!;
        const askRaw = (pairPolicy.mmMidPriceTicks * BigInt(10_000 + offsetBps)) / 10_000n;
        const bidRaw = (pairPolicy.mmMidPriceTicks * BigInt(Math.max(1, 10_000 - offsetBps))) / 10_000n;
        const askPriceTicks = snapPriceTicks(askRaw, pairPolicy.priceStepTicks, 'up');
        let bidPriceTicks = snapPriceTicks(bidRaw, pairPolicy.priceStepTicks, 'down');
        const stepTicksBig = BigInt(Math.max(1, pairPolicy.priceStepTicks));
        if (bidPriceTicks >= askPriceTicks) {
          bidPriceTicks = askPriceTicks > stepTicksBig ? askPriceTicks - stepTicksBig : 1n;
        }
        if (!isWithinPairBand(pairPolicy.mmMidPriceTicks, askPriceTicks)) continue;
        if (!isWithinPairBand(pairPolicy.mmMidPriceTicks, bidPriceTicks)) continue;

        const askWantAmount = (baseSize * askPriceTicks) / ORDERBOOK_PRICE_SCALE;
        const bidGiveAmount = (baseSize * bidPriceTicks) / ORDERBOOK_PRICE_SCALE;
        const levelId = level + 1;
        const routeBase = {
          makerEntityId: sourceContext.entityId,
          hubEntityId: sourceHub.entityId,
          status: 'intent' as const,
          createdAt: now,
          updatedAt: now,
          expiresAt: now + MARKET_MAKER_CROSS_EXPIRY_MS,
        };

        if (askWantAmount > 0n) {
          const offerId = `mmx-${sourceHubSuffix}-${targetHubSuffix}-${pair.baseTokenId}-${pair.quoteTokenId}-ask-${levelId}`;
          specs.push({
            offerId,
            pairId: `cross:${sourceContext.chainId}:${pair.baseTokenId}/${targetContext.chainId}:${pair.quoteTokenId}`,
            hubEntityId: sourceHub.entityId,
            giveTokenId: pair.baseTokenId,
            giveAmount: baseSize,
            wantTokenId: pair.quoteTokenId,
            wantAmount: askWantAmount,
            minFillRatio: 0,
            crossJurisdiction: {
              ...routeBase,
              orderId: offerId,
              priceTicks: askPriceTicks,
              source: {
                jurisdiction: sourceContext.jurisdictionName,
                entityId: sourceContext.entityId,
                counterpartyEntityId: sourceHub.entityId,
                tokenId: pair.baseTokenId,
                amount: baseSize,
              },
              target: {
                jurisdiction: targetContext.jurisdictionName,
                entityId: targetHub.entityId,
                counterpartyEntityId: targetContext.entityId,
                tokenId: pair.quoteTokenId,
                amount: askWantAmount,
              },
            },
          });
        }

        if (bidGiveAmount > 0n) {
          const offerId = `mmx-${sourceHubSuffix}-${targetHubSuffix}-${pair.baseTokenId}-${pair.quoteTokenId}-bid-${levelId}`;
          specs.push({
            offerId,
            pairId: `cross:${sourceContext.chainId}:${pair.quoteTokenId}/${targetContext.chainId}:${pair.baseTokenId}`,
            hubEntityId: sourceHub.entityId,
            giveTokenId: pair.quoteTokenId,
            giveAmount: bidGiveAmount,
            wantTokenId: pair.baseTokenId,
            wantAmount: baseSize,
            minFillRatio: 0,
            crossJurisdiction: {
              ...routeBase,
              orderId: offerId,
              priceTicks: bidPriceTicks,
              source: {
                jurisdiction: sourceContext.jurisdictionName,
                entityId: sourceContext.entityId,
                counterpartyEntityId: sourceHub.entityId,
                tokenId: pair.quoteTokenId,
                amount: bidGiveAmount,
              },
              target: {
                jurisdiction: targetContext.jurisdictionName,
                entityId: targetHub.entityId,
                counterpartyEntityId: targetContext.entityId,
                tokenId: pair.baseTokenId,
                amount: baseSize,
              },
            },
          });
        }
      }
    }
  }

  return specs;
};

const countMarketMakerOffersForHubPair = (
  env: Env,
  mmEntityId: string,
  hubEntityId: string,
  pair: { baseTokenId: number; quoteTokenId: number },
): number => {
  const account = getAccountMachine(env, mmEntityId, hubEntityId);
  if (!account) return 0;
  const prefix = `mm-${hubEntityId.slice(-6).toLowerCase()}-${pair.baseTokenId}-${pair.quoteTokenId}-`;
  let count = 0;
  for (const offerId of collectOfferIdsForAccount(account)) {
    if (offerId.startsWith(prefix)) count += 1;
  }
  return count;
};

const countMarketMakerOffersForHub = (env: Env, mmEntityId: string, hubEntityId: string): number => {
  const account = getAccountMachine(env, mmEntityId, hubEntityId);
  if (!account) return 0;
  const prefix = `mm-${hubEntityId.slice(-6).toLowerCase()}-`;
  let count = 0;
  for (const offerId of collectOfferIdsForAccount(account)) {
    if (offerId.startsWith(prefix)) count += 1;
  }
  return count;
};

const ensureMarketMakerHubConnectivity = async (
  env: Env,
  mmEntityId: string,
  mmSignerId: string,
  hubEntityIds: string[],
  hubSignerIdsByEntityId: ReadonlyMap<string, string>,
  tokenIds: number[],
): Promise<void> => {
  const accountOpenInputs: EntityInput[] = [];
  const localCreditInputsByEntity = new Map<string, EntityInput>();
  const remoteCreditInputsByEntity = new Map<string, EntityInput>();

  for (const hubEntityId of hubEntityIds) {
    const hubSignerId = String(hubSignerIdsByEntityId.get(hubEntityId.toLowerCase()) || '');
    if (!hubSignerId) continue;
    const mmAccount = getAccountMachine(env, mmEntityId, hubEntityId);
    const hasPendingConsensus =
      Boolean(mmAccount?.pendingFrame) ||
      Number(mmAccount?.mempool?.length || 0) > 0;
    if (!mmAccount && !hasPendingConsensus && !hasQueuedOpenAccount(env, mmEntityId, hubEntityId)) {
      accountOpenInputs.push({
        entityId: mmEntityId,
        signerId: mmSignerId,
        entityTxs: [{
          type: 'openAccount',
          data: {
            targetEntityId: hubEntityId,
            tokenId: tokenIds[0] ?? 1,
            creditAmount: MARKET_MAKER_CREDIT_AMOUNT,
          },
        }],
      });
    }
  }

  if (accountOpenInputs.length > 0) {
    enqueueRuntimeInput(env, { runtimeTxs: [], entityInputs: accountOpenInputs });
    await settleRuntimeFor(env, 35);
  }

  for (const hubEntityId of hubEntityIds) {
    const hubSignerId = String(hubSignerIdsByEntityId.get(hubEntityId.toLowerCase()) || '');
    if (!hubSignerId) continue;
    const mmAccount = getAccountMachine(env, mmEntityId, hubEntityId);
    const hasPendingConsensus =
      Boolean(mmAccount?.pendingFrame) ||
      Number(mmAccount?.mempool?.length || 0) > 0;
    if (hasPendingConsensus) continue;
    if (!mmAccount) continue;

    for (const tokenId of tokenIds) {
      if (hasPairMutualCredit(env, mmEntityId, hubEntityId, tokenId, MARKET_MAKER_CREDIT_AMOUNT)) continue;
      const mmOutCapacity = getEntityOutCapacity(mmAccount, mmEntityId, tokenId);
      const hubOutCapacity = getEntityOutCapacity(mmAccount, hubEntityId, tokenId);

      if (mmOutCapacity < MARKET_MAKER_CREDIT_AMOUNT) {
        const input = remoteCreditInputsByEntity.get(hubEntityId) ?? {
          entityId: hubEntityId,
          signerId: hubSignerId,
          entityTxs: [],
        };
        const entityTxs = input.entityTxs ?? (input.entityTxs = []);
        entityTxs.push({
          type: 'extendCredit',
          data: {
            counterpartyEntityId: mmEntityId,
            tokenId,
            amount: MARKET_MAKER_CREDIT_AMOUNT,
          },
        });
        remoteCreditInputsByEntity.set(hubEntityId, input);
      }

      if (hubOutCapacity < MARKET_MAKER_CREDIT_AMOUNT) {
        const input = localCreditInputsByEntity.get(mmEntityId) ?? {
          entityId: mmEntityId,
          signerId: mmSignerId,
          entityTxs: [],
        };
        const entityTxs = input.entityTxs ?? (input.entityTxs = []);
        entityTxs.push({
          type: 'extendCredit',
          data: {
            counterpartyEntityId: hubEntityId,
            tokenId,
            amount: MARKET_MAKER_CREDIT_AMOUNT,
          },
        });
        localCreditInputsByEntity.set(mmEntityId, input);
      }
    }
  }

  const localCreditInputs = Array.from(localCreditInputsByEntity.values());
  if (localCreditInputs.length > 0) {
    enqueueRuntimeInput(env, { runtimeTxs: [], entityInputs: localCreditInputs });
    await settleRuntimeFor(env, 45);
  }

  const remoteCreditInputs = Array.from(remoteCreditInputsByEntity.values());
  for (const input of remoteCreditInputs) {
    const result = sendEntityInput(env, input);
    if (result.deferred) {
      console.warn(
        `[MESH-MM] deferred hub credit request entity=${input.entityId.slice(-6)} txs=${input.entityTxs?.length || 0}`,
      );
    }
  }
  if (remoteCreditInputs.length > 0) {
    await settleRuntimeFor(env, 45);
  }
};

const isMarketMakerConnectivityReady = (
  env: Env,
  mmEntityId: string,
  hubEntityIds: string[],
  tokenIds: number[],
): boolean => hubEntityIds.every((hubEntityId) => {
  const account = getAccountMachine(env, mmEntityId, hubEntityId);
  if (!isAccountConsensusReady(account)) return false;
  return tokenIds.every((tokenId) =>
    hasPairMutualCredit(env, mmEntityId, hubEntityId, tokenId, MARKET_MAKER_CREDIT_AMOUNT),
  );
});

const maintainMarketMakerQuotes = async (
  env: Env,
  mmEntityId: string,
  mmSignerId: string,
  hubEntityIds: string[],
  hubSignerIdsByEntityId: ReadonlyMap<string, string>,
  tokenIds: number[],
  maxOffersPerAccount = MARKET_MAKER_OFFERS_PER_ACCOUNT_PER_TICK,
  maxNewOffersTotal = MARKET_MAKER_MAX_NEW_OFFERS_PER_TICK,
): Promise<void> => {
  if (hubEntityIds.length === 0 || tokenIds.length < 3) return;
  await ensureMarketMakerHubConnectivity(env, mmEntityId, mmSignerId, hubEntityIds, hubSignerIdsByEntityId, tokenIds);
  if (!isMarketMakerConnectivityReady(env, mmEntityId, hubEntityIds, tokenIds)) {
    return;
  }
  const desiredOffers = buildMarketMakerOfferSpecs(hubEntityIds, tokenIds);
  const grouped = new Map<string, MarketMakerOfferSpec[]>();
  for (const spec of desiredOffers) {
    const arr = grouped.get(spec.hubEntityId) ?? [];
    arr.push(spec);
    grouped.set(spec.hubEntityId, arr);
  }

  const entityTxs: EntityInput['entityTxs'] = [];
  let remainingNewOffers = Math.max(1, Math.floor(maxNewOffersTotal));
  for (const [hubEntityId, specs] of grouped.entries()) {
    if (remainingNewOffers <= 0) break;
    const account = getAccountMachine(env, mmEntityId, hubEntityId);
    if (!account) continue;
    if (String(account.status || 'active') !== 'active') continue;
    if (!isAccountConsensusReady(account)) continue;

    const existingOfferIds = collectOfferIdsForAccount(account);
    const remainingOpenSlots = Math.max(0, LIMITS.MAX_ACCOUNT_SWAP_OFFERS - existingOfferIds.size);
    const allowedNewOffers = Math.min(
      Math.max(1, Math.floor(maxOffersPerAccount)),
      remainingOpenSlots,
      remainingNewOffers,
    );
    if (allowedNewOffers <= 0) continue;
    const missing = specs
      .filter(spec => !existingOfferIds.has(spec.offerId))
      .filter(spec =>
        hasPairMutualCredit(env, mmEntityId, hubEntityId, spec.giveTokenId, spec.giveAmount)
        && hasPairMutualCredit(env, mmEntityId, hubEntityId, spec.wantTokenId, spec.wantAmount),
      )
      .slice(0, allowedNewOffers);
    if (missing.length === 0) continue;
    entityTxs.push(...missing.map(spec => ({
      type: 'placeSwapOffer' as const,
      data: {
        counterpartyEntityId: spec.hubEntityId,
        offerId: spec.offerId,
        giveTokenId: spec.giveTokenId,
        giveAmount: spec.giveAmount,
        wantTokenId: spec.wantTokenId,
        wantAmount: spec.wantAmount,
        minFillRatio: spec.minFillRatio,
      },
    })));
    remainingNewOffers -= missing.length;
  }

  if (entityTxs.length > 0) {
    enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: [{
        entityId: mmEntityId,
        signerId: mmSignerId,
        entityTxs,
      }],
    });
  }
};

const hasCrossRouteRegistered = (env: Env, entityId: string, orderId: string): boolean => {
  const replica = getEntityReplicaById(env, entityId);
  return Boolean(replica?.state?.crossJurisdictionSwaps?.has(orderId));
};

const pushEntityTx = (
  inputsByEntity: Map<string, EntityInput>,
  entityId: string,
  signerId: string,
  tx: NonNullable<EntityInput['entityTxs']>[number],
): void => {
  const key = `${entityId}:${signerId}`;
  const input = inputsByEntity.get(key) ?? {
    entityId,
    signerId,
    entityTxs: [],
  };
  const entityTxs = input.entityTxs ?? (input.entityTxs = []);
  entityTxs.push(tx);
  inputsByEntity.set(key, input);
};

const maintainMarketMakerCrossQuotes = async (
  env: Env,
  sourceContext: MarketMakerEntityContext,
  targetContext: MarketMakerEntityContext,
  sourceHubs: HubProfile[],
  targetHubs: HubProfile[],
  hubSignerIdsByEntityId: ReadonlyMap<string, string>,
  tokenIds: number[],
  maxOffersPerAccount = Math.max(2, Math.floor(MARKET_MAKER_OFFERS_PER_ACCOUNT_PER_TICK / 2)),
  maxNewOffersTotal = Math.max(2, Math.floor(MARKET_MAKER_MAX_NEW_OFFERS_PER_TICK / 2)),
): Promise<void> => {
  if (
    sourceHubs.length === 0 ||
    targetHubs.length === 0 ||
    tokenIds.length < 3 ||
    sourceContext.entityId === targetContext.entityId ||
    sameJurisdiction(sourceContext, targetContext)
  ) {
    return;
  }

  const sourceHubEntityIds = sourceHubs.map(profile => profile.entityId);
  const targetHubEntityIds = targetHubs.map(profile => profile.entityId);
  await ensureMarketMakerHubConnectivity(
    env,
    sourceContext.entityId,
    sourceContext.signerId,
    sourceHubEntityIds,
    hubSignerIdsByEntityId,
    tokenIds,
  );
  await ensureMarketMakerHubConnectivity(
    env,
    targetContext.entityId,
    targetContext.signerId,
    targetHubEntityIds,
    hubSignerIdsByEntityId,
    tokenIds,
  );

  if (!isMarketMakerConnectivityReady(env, sourceContext.entityId, sourceHubEntityIds, tokenIds)) return;
  if (!isMarketMakerConnectivityReady(env, targetContext.entityId, targetHubEntityIds, tokenIds)) return;

  const desiredOffers = buildMarketMakerCrossOfferSpecs(
    env,
    sourceContext,
    targetContext,
    sourceHubs,
    targetHubs,
    tokenIds,
  );
  if (desiredOffers.length === 0) return;

  const grouped = new Map<string, MarketMakerOfferSpec[]>();
  for (const spec of desiredOffers) {
    const arr = grouped.get(spec.hubEntityId) ?? [];
    arr.push(spec);
    grouped.set(spec.hubEntityId, arr);
  }

  const inputsByEntity = new Map<string, EntityInput>();
  let remainingNewOffers = Math.max(1, Math.floor(maxNewOffersTotal));
  for (const [sourceHubEntityId, specs] of grouped.entries()) {
    const account = getAccountMachine(env, sourceContext.entityId, sourceHubEntityId);
    if (!account) continue;
    if (String(account.status || 'active') !== 'active') continue;
    if (!isAccountConsensusReady(account)) continue;

    const existingOfferIds = collectOfferIdsForAccount(account);
    if (remainingNewOffers <= 0) continue;
    const remainingOpenSlots = Math.max(0, LIMITS.MAX_ACCOUNT_SWAP_OFFERS - existingOfferIds.size);
    const allowedNewOffers = Math.min(
      Math.max(1, Math.floor(maxOffersPerAccount)),
      remainingOpenSlots,
      remainingNewOffers,
    );
    if (allowedNewOffers <= 0) continue;

    const missing = specs
      .filter(spec => spec.crossJurisdiction && !existingOfferIds.has(spec.offerId))
      .filter(spec => {
        const route = spec.crossJurisdiction!;
        return (
          !hasCrossRouteRegistered(env, route.source.counterpartyEntityId, route.orderId) &&
          hasPairMutualCredit(env, sourceContext.entityId, route.source.counterpartyEntityId, route.source.tokenId, route.source.amount) &&
          hasPairMutualCredit(env, targetContext.entityId, route.target.entityId, route.target.tokenId, route.target.amount)
        );
      })
      .slice(0, allowedNewOffers);
    if (missing.length === 0) continue;

    for (const spec of missing) {
      const route = spec.crossJurisdiction!;
      pushEntityTx(inputsByEntity, route.source.entityId, sourceContext.signerId, {
        type: 'requestCrossJurisdictionSwap',
        data: { route },
      });
    }
    remainingNewOffers -= missing.length;
  }

  const entityInputs = Array.from(inputsByEntity.values()).filter(input => (input.entityTxs?.length || 0) > 0);
  if (entityInputs.length > 0) {
    enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs,
    });
  }
};

const getMarketMakerHealth = (
  env: Env,
  mmEntityId: string | null,
  hubEntityIds: string[],
  tokenIds: number[],
): MarketMakerHealth => {
  const pairs = buildDefaultEntitySwapPairs(tokenIds);
  const desiredSpecs = buildMarketMakerOfferSpecs(hubEntityIds, tokenIds);
  const expectedOffersByHub = new Map<string, number>();
  const expectedOffersByHubPair = new Map<string, number>();
  for (const spec of desiredSpecs) {
    expectedOffersByHub.set(spec.hubEntityId, (expectedOffersByHub.get(spec.hubEntityId) || 0) + 1);
    const pairKey = `${spec.hubEntityId}:${spec.pairId}`;
    expectedOffersByHubPair.set(pairKey, (expectedOffersByHubPair.get(pairKey) || 0) + 1);
  }
  const expectedOffersPerHub = hubEntityIds.reduce(
    (max, hubEntityId) => Math.max(max, expectedOffersByHub.get(hubEntityId) || 0),
    0,
  );
  const expectedOffersPerPair = Math.max(
    ...pairs.map((pair) =>
      Math.max(...hubEntityIds.map((hubEntityId) => expectedOffersByHubPair.get(`${hubEntityId}:${pair.pairId}`) || 0), 0),
    ),
    0,
  );
  if (!mmEntityId || hubEntityIds.length === 0 || expectedOffersPerHub <= 0) {
    return {
      enabled: false,
      ok: false,
      entityId: mmEntityId,
      expectedOffersPerHub: Math.max(0, expectedOffersPerHub),
      expectedOffersPerPair,
      hubs: [],
    };
  }

  const hubs = hubEntityIds.map((hubEntityId) => {
    const offers = countMarketMakerOffersForHub(env, mmEntityId, hubEntityId);
    const expectedHubOffers = expectedOffersByHub.get(hubEntityId) || 0;
    const pairHealth = pairs.map((pair) => {
      const pairOffers = countMarketMakerOffersForHubPair(env, mmEntityId, hubEntityId, pair);
      const expectedPairOffers = expectedOffersByHubPair.get(`${hubEntityId}:${pair.pairId}`) || 0;
      return {
        pairId: pair.pairId,
        offers: pairOffers,
        ready: pairOffers >= expectedPairOffers,
      };
    });
    return {
      hubEntityId,
      offers,
      ready: offers >= expectedHubOffers && pairHealth.every((pair) => pair.ready),
      pairs: pairHealth,
    };
  });

  const connectivity = hubEntityIds.map((hubEntityId) => {
    const account = getAccountMachine(env, mmEntityId, hubEntityId);
    return {
      hubEntityId,
      accountReady: isAccountConsensusReady(account),
      status: account ? String(account.status || 'active') : null,
      currentHeight: account ? Number(account.currentHeight ?? 0) : null,
      mempoolLength: Number(account?.mempool?.length || 0),
      pendingFrame: Boolean(account?.pendingFrame),
      swapOffers: Number(account?.swapOffers?.size || 0),
      tokens: tokenIds.map((tokenId) => ({
        tokenId,
        mmGranted: account ? getCreditGrantedByEntity(account, mmEntityId, tokenId).toString() : '0',
        hubGranted: account ? getCreditGrantedByEntity(account, hubEntityId, tokenId).toString() : '0',
        mmOutCapacity: account ? getEntityOutCapacity(account, mmEntityId, tokenId).toString() : '0',
        hubOutCapacity: account ? getEntityOutCapacity(account, hubEntityId, tokenId).toString() : '0',
        mutualReady: hasPairMutualCredit(env, mmEntityId, hubEntityId, tokenId, MARKET_MAKER_CREDIT_AMOUNT),
      })),
    };
  });

  return {
    enabled: true,
    ok: hubs.length > 0 && hubs.every((entry) => entry.ready),
    entityId: mmEntityId,
    connectivity,
    expectedOffersPerHub,
    expectedOffersPerPair,
    hubs,
  };
};

const run = async (): Promise<void> => {
  if (resolvedArgs.dbPath) process.env['XLN_DB_PATH'] = resolvedArgs.dbPath;

  const env = await main(resolvedArgs.seed);
  startRuntimeLoop(env);
  let startupPhase = 'boot';
  let activeMmEntityId: string | null = null;
  let mmContexts: MarketMakerEntityContext[] = [];

  const jurisdiction = resolveJurisdictionConfig(resolvedArgs.rpcUrl);
  nodeLog.info('startup phase', { phase: startupPhase });

  const directRuntimeWs = createDirectRuntimeWsRoute({
    runtimeId: String(env.runtimeId || ''),
    runtimeSeed: resolvedArgs.seed,
    onEntityInput: async (from, input, ingressTimestamp) => {
      handleInboundP2PEntityInput(env, from, input, ingressTimestamp);
    },
  });
  env.runtimeState = env.runtimeState ?? {};
  env.runtimeState.directEntityInputDispatch = (targetRuntimeId, input, ingressTimestamp) =>
    directRuntimeWs.sendEntityInput(targetRuntimeId, input, ingressTimestamp);
  const handleRadapterWsMessage = (ws: any, raw: string | Buffer | ArrayBuffer): void => {
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
          entityId: activeMmEntityId,
          runtimeId: env.runtimeId,
          apiUrl,
          relayUrl: resolvedArgs.relayUrl,
          directWsUrl,
          startupPhase,
        }), { headers: JSON_HEADERS });
      }

      if (pathname === '/api/health') {
        const visibleHubs = readVisibleHubProfiles(env);
        const activeEntityId = activeMmEntityId;
        const health = {
          ok: visibleHubs.length === resolvedArgs.meshHubNames.length,
          name: resolvedArgs.name,
          entityId: activeEntityId,
          runtimeId: String(env.runtimeId || '') || null,
          relayUrl: resolvedArgs.relayUrl,
          directWsUrl,
          apiUrl,
          startupPhase,
          p2p: {
            directPeers: getP2PState(env).directPeers || [],
          },
          gossip: {
            visibleHubNames: visibleHubs.map(profile => profile.name),
            visibleHubIds: visibleHubs.map(profile => profile.entityId),
            ready: visibleHubs.length === resolvedArgs.meshHubNames.length,
          },
          marketMaker: activeEntityId
            ? getMarketMakerHealth(env, activeEntityId, visibleHubs.map(profile => profile.entityId), normalizeTokenIdsForMm([]))
            : {
                enabled: true,
                ok: false,
                entityId: null,
                expectedOffersPerHub: 0,
                expectedOffersPerPair: 0,
                hubs: [],
              },
        };
        return new Response(safeStringify(health), { headers: JSON_HEADERS });
      }

      if (pathname === '/api/control/p2p/stop' && request.method === 'POST') {
        stopP2P(env);
        return new Response(safeStringify({ ok: true }), {
          headers: JSON_HEADERS,
        });
      }

      return new Response(safeStringify({ error: 'Not found' }), {
        status: 404,
        headers: JSON_HEADERS,
      });
      } finally {
        releaseHttp();
      }
	    },
	    websocket: {
	      open(ws: any) {
	        if (ws.data?.type === 'rpc') {
	          attachRuntimeAdapterTicker(env, registerEnvChangeCallback);
	          return;
	        }
	        directRuntimeWs.websocket.open(ws);
	      },
	      message(ws: any, raw: string | Buffer | ArrayBuffer) {
	        if (ws.data?.type === 'rpc') {
	          handleRadapterWsMessage(ws, raw);
	          return;
	        }
	        return directRuntimeWs.websocket.message(ws, raw);
	      },
	      close(ws: any) {
	        if (ws.data?.type === 'rpc') {
	          forgetRuntimeAdapterClient(ws);
	          return;
	        }
	        directRuntimeWs.websocket.close(ws);
	      },
	    },
	  });

  startupPhase = 'import-jurisdiction';
  enqueueRuntimeInput(env, {
    runtimeTxs: [{
      type: 'importJ',
      data: {
        name: jurisdiction.name,
            chainId: jurisdiction.chainId,
            ticker: 'XLN',
            rpcs: [resolveImportedJurisdictionRpc(jurisdiction)],
            blockTimeMs: requireJurisdictionBlockTimeMs(jurisdiction),
            contracts: jurisdiction.contracts,
      },
    }],
    entityInputs: [],
  });
  await settleRuntimeFor(env, 35);

  const jadapter = await waitForActiveJAdapter(env);
  ensureJurisdictionReplica(env, jadapter, resolveImportedJurisdictionRpc(jurisdiction));
  startupPhase = 'token-catalog';
  const tokenCatalog = await waitForTokenCatalog(jadapter);
  const tokenIds = normalizeTokenIdsForMm(tokenCatalog);
  const meshHubIdentities = parseMeshHubIdentities(resolvedArgs.meshHubIdentitiesJson);
  const configuredHubSignerIdsByEntityId = new Map(
    meshHubIdentities.map((hub) => [hub.entityId.toLowerCase(), hub.signerId.toLowerCase()] as const),
  );

  startupPhase = 'import-replica';
  const primaryMmContext = await createMarketMakerEntityContext(
    env,
    jurisdiction,
    resolvedArgs.signerLabel,
    resolvedArgs.name,
    { x: 0, y: -40, z: 120, jurisdiction: jurisdiction.name },
  );
  activeMmEntityId = primaryMmContext.entityId;
  mmContexts = [primaryMmContext];

  const secondaryJurisdictions = resolveSecondaryJurisdictions(jurisdiction.rpc);
  for (const [index, secondary] of secondaryJurisdictions.entries()) {
    const secondaryName = String(secondary.name || `Secondary ${index + 1}`).trim();
    if (!secondaryName) continue;
    startupPhase = `import-jurisdiction-${secondaryName}`;
    await importJurisdictionIfNeeded(env, secondary);
    startupPhase = `import-replica-${secondaryName}`;
    const siblingContext = await createMarketMakerEntityContext(
      env,
      secondary,
      `${resolvedArgs.signerLabel}:${secondaryName}`,
      `${resolvedArgs.name} ${secondaryName}`,
      { x: 160 + index * 80, y: -40, z: 120, jurisdiction: secondaryName },
    );
    mmContexts.push(siblingContext);
    console.log(
      `[MESH-MM] Sibling MM ready jurisdiction=${secondaryName} entity=${siblingContext.entityId.slice(0, 12)}`,
    );
  }

  startupPhase = 'start-p2p';
  const p2p = startP2P(env, {
    relayUrls: [resolvedArgs.relayUrl],
    wsUrl: directWsUrl,
    advertiseEntityIds: mmContexts.map(context => context.entityId),
    gossipPollMs: BOOTSTRAP_POLL_MS * 5 || 250,
  });
  if (!p2p) throw new Error('P2P_START_FAILED');

  let shuttingDown = false;
  let loopInFlight = false;
  const driveQuotes = async (mode: 'bootstrap' | 'steady' = 'steady'): Promise<void> => {
    if (loopInFlight) return;
    loopInFlight = true;
    try {
      const visibleHubs = readVisibleHubProfiles(env, true);
      if (visibleHubs.length === 0) return;
      const hubSignerIdsByEntityId = new Map(configuredHubSignerIdsByEntityId);
      for (const profile of visibleHubs) {
        if (profile.signerId) hubSignerIdsByEntityId.set(profile.entityId.toLowerCase(), profile.signerId.toLowerCase());
      }

      for (const context of mmContexts) {
        const sameJurisdictionHubs = visibleHubs.filter(profile => sameJurisdiction(context, profile));
        const hubEntityIds = sameJurisdictionHubs.map(profile => profile.entityId);
        if (hubEntityIds.length === 0) continue;
        const desiredOfferCount = buildMarketMakerOfferSpecs(hubEntityIds, tokenIds).length;
        const expectedOffersPerHub = Math.max(1, Math.ceil(desiredOfferCount / Math.max(1, hubEntityIds.length)));
        await maintainMarketMakerQuotes(
          env,
          context.entityId,
          context.signerId,
          hubEntityIds,
          hubSignerIdsByEntityId,
          tokenIds,
          mode === 'bootstrap'
            ? Math.max(MARKET_MAKER_OFFERS_PER_ACCOUNT_PER_TICK, expectedOffersPerHub)
            : MARKET_MAKER_OFFERS_PER_ACCOUNT_PER_TICK,
          mode === 'bootstrap'
            ? Math.max(MARKET_MAKER_MAX_NEW_OFFERS_PER_TICK, desiredOfferCount)
            : MARKET_MAKER_MAX_NEW_OFFERS_PER_TICK,
        );
      }

      for (const sourceContext of mmContexts) {
        const sourceHubs = visibleHubs.filter(profile => sameJurisdiction(sourceContext, profile));
        if (sourceHubs.length === 0) continue;
        for (const targetContext of mmContexts) {
          if (sourceContext.entityId === targetContext.entityId || sameJurisdiction(sourceContext, targetContext)) continue;
          const targetHubs = visibleHubs.filter(profile => sameJurisdiction(targetContext, profile));
          if (targetHubs.length === 0) continue;
          const desiredCrossOfferCount = buildMarketMakerCrossOfferSpecs(
            env,
            sourceContext,
            targetContext,
            sourceHubs,
            targetHubs,
            tokenIds,
          ).length;
          await maintainMarketMakerCrossQuotes(
            env,
            sourceContext,
            targetContext,
            sourceHubs,
            targetHubs,
            hubSignerIdsByEntityId,
            tokenIds,
            mode === 'bootstrap'
              ? Math.max(MARKET_MAKER_CROSS_LEVELS_PER_PAIR * buildDefaultEntitySwapPairs(tokenIds).length * 2, MARKET_MAKER_OFFERS_PER_ACCOUNT_PER_TICK)
              : Math.max(2, Math.floor(MARKET_MAKER_OFFERS_PER_ACCOUNT_PER_TICK / 2)),
            mode === 'bootstrap'
              ? Math.max(MARKET_MAKER_MAX_NEW_OFFERS_PER_TICK, desiredCrossOfferCount)
              : Math.max(2, Math.floor(MARKET_MAKER_MAX_NEW_OFFERS_PER_TICK / 2)),
          );
        }
      }
      await settleRuntimeFor(env, 45);
    } finally {
      loopInFlight = false;
    }
  };

  const markOffersReady = (): void => {
    if (startupPhase === 'offers-ready') return;
    startupPhase = 'offers-ready';
    console.log(
      `[MESH-MM] OFFERS_READY entityId=${primaryMmContext.entityId} runtimeId=${String(env.runtimeId || '')} api=${apiUrl} relay=${resolvedArgs.relayUrl}`,
    );
  };

  const waitForBootstrapOffers = async (): Promise<boolean> => {
    const deadline = Date.now() + MARKET_MAKER_BOOTSTRAP_TIMEOUT_MS;
    while (!shuttingDown && Date.now() < deadline) {
      await driveQuotes('bootstrap');
      const visibleHubs = readVisibleHubProfiles(env);
      const health = getMarketMakerHealth(env, primaryMmContext.entityId, visibleHubs.map(profile => profile.entityId), tokenIds);
      if (health.ok) return true;
      await sleep(MARKET_MAKER_BOOTSTRAP_LOOP_MS);
    }
    const visibleHubs = readVisibleHubProfiles(env);
    const health = getMarketMakerHealth(env, primaryMmContext.entityId, visibleHubs.map(profile => profile.entityId), tokenIds);
    console.warn(
      `[MESH-MM] BOOTSTRAP_TIMEOUT visibleHubs=${visibleHubs.length} offers=${safeStringify(health.hubs.map(hub => ({ hubEntityId: hub.hubEntityId, offers: hub.offers })))}`,
    );
    return false;
  };

  let loop: ReturnType<typeof setInterval> | null = null;
  startupPhase = 'runtime-ready';
  console.log(
    `[MESH-MM] RUNTIME_READY entityId=${primaryMmContext.entityId} runtimeId=${String(env.runtimeId || '')} api=${apiUrl} relay=${resolvedArgs.relayUrl}`,
  );

  startupPhase = 'bootstrap-offers';
  if (await waitForBootstrapOffers()) {
    markOffersReady();
  } else {
    startupPhase = 'bootstrap-degraded';
  }
  loop = setInterval(() => {
    if (shuttingDown) return;
    void (async () => {
      await driveQuotes();
      if (startupPhase !== 'offers-ready') {
        const visibleHubs = readVisibleHubProfiles(env);
        const health = getMarketMakerHealth(env, primaryMmContext.entityId, visibleHubs.map(profile => profile.entityId), tokenIds);
        if (health.ok) {
          markOffersReady();
        }
      }
    })().catch(error => {
      if (shuttingDown) return;
      console.error(`[MM] quote loop failed:`, (error as Error).message);
    });
  }, MARKET_MAKER_QUOTE_LOOP_MS);

  let shutdownStarted = false;
  const shutdown = async (code: number = 0): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    shuttingDown = true;
    if (loop) clearInterval(loop);
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
  await new Promise<void>(() => {});
};

clearJurisdictionsCache();
run().catch(error => {
  console.error(`[MESH-MM] FAILED:`, (error as Error).stack || (error as Error).message);
  process.exit(1);
});
