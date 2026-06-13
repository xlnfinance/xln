#!/usr/bin/env bun

import { compareStableText, safeStringify } from '../serialization-utils';
import { createStructuredLogger } from '../logger';
import { decodeRuntimeAdapterMessage } from '../radapter/codec';
import { encodeBoard, hashBoard } from '../entity-factory';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../account-crypto';
import { createDirectRuntimeWsRoute, type DirectWebSocket } from '../networking/direct-runtime-bun';
import {
  attachRuntimeAdapterTicker,
  closeInvalidRuntimeAdapterMessage,
  forgetRuntimeAdapterClient,
  handleRuntimeAdapterMessage,
  type RuntimeAdapterSocket,
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
import type { AccountMachine, CrossJurisdictionSwapRoute, EntityInput, Env, RoutedEntityInput } from '../types';
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
import { buildDefaultEntitySwapPairs, getSwapPairOrientation, getSwapPairPolicyByBaseQuote, getTokenIdsForJurisdiction } from '../account-utils';
import { LIMITS, SWAP as SWAP_CONSTANTS } from '../constants';
import { ORDERBOOK_PRICE_SCALE, SWAP_LOT_SCALE } from '../orderbook';
import { hasCrossJurisdictionBookOrder } from '../orderbook/cross-j';
import {
  deriveCanonicalCrossJurisdictionBookOwnerForLegs,
  deriveCanonicalCrossJurisdictionMarketForLegs,
  withCanonicalCrossJurisdictionRouteHash,
} from '../cross-jurisdiction';
import { resolveCrossJurisdictionRuntimeTopology } from '../cross-jurisdiction-boundary';
import { crossJurisdictionBookOwnerRef } from '../cross-jurisdiction-orderbook';
import { getJurisdictionStackId } from '../jurisdiction-stack';
import { startParentLivenessWatch } from './parent-watch';
import { createHttpDrainTracker, stopServerGracefully } from './graceful-server';
import {
  formatJurisdictionDisplayName,
  requireJurisdictionBlockTimeMs,
  resetMeshJurisdictionsCache,
  resolveMeshJurisdictionConfig,
  resolveSecondaryJurisdictions,
  type MeshJurisdictionConfig,
} from './mesh-jurisdictions';

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

type MarketMakerServerSocket = DirectWebSocket & RuntimeAdapterSocket & { data?: { type?: string } };

type MeshHubIdentity = {
  name: string;
  entityId: string;
  signerId: string;
};

type JurisdictionConfig = MeshJurisdictionConfig & {
  contracts: NonNullable<MeshJurisdictionConfig['contracts']>;
};

type HubProfile = {
  name: string;
  entityId: string;
  signerId?: string;
  runtimeId?: string;
  jurisdictionName?: string;
  chainId?: number;
  depositoryAddress?: string;
  jurisdictionRef?: string;
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
  depositoryAddress?: string;
  jurisdictionRef: string;
};

type MarketMakerTokenIdsByContext = ReadonlyMap<string, number[]>;

type MarketMakerCrossRouteHealth = {
  sourceJurisdiction: string;
  targetJurisdiction: string;
  sourceHubEntityId: string;
  targetHubEntityId: string;
  offers: number;
  ready: boolean;
  pairs: Array<{
    pairId: string;
    offers: number;
    ready: boolean;
    sourceTokenIds: number[];
    targetTokenIds: number[];
  }>;
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
  cross: {
    ok: boolean;
    expectedRoutes: number;
    expectedOffersPerRoute: number;
    expectedOffersPerPair: number;
    routes: MarketMakerCrossRouteHealth[];
  };
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
const MARKET_MAKER_MAX_LEVELS_PER_PAIR = Math.max(
  1,
  Math.min(
    15,
    Number(process.env['MARKET_MAKER_MAX_LEVELS_PER_PAIR'] || '15'),
  ),
);
const MARKET_MAKER_CROSS_EXPIRY_MS = Math.max(
  60_000,
  Number(process.env['MARKET_MAKER_CROSS_EXPIRY_MS'] || String(24 * 60 * 60 * 1000)),
);
const ORDERBOOK_MAX_QTY_LOTS = 0xFFFFFFFFn;
const ORDERBOOK_MAX_BASE_AMOUNT = ORDERBOOK_MAX_QTY_LOTS * SWAP_LOT_SCALE;
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

const resolveJurisdictionConfig = (rpcUrlOverride: string): JurisdictionConfig =>
  resolveMeshJurisdictionConfig<JurisdictionConfig>(rpcUrlOverride);

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
    depositoryAddress: jurisdiction.contracts.depository,
    jurisdictionRef: getJurisdictionStackId({
      chainId: jurisdiction.chainId,
      depositoryAddress: jurisdiction.contracts.depository,
    }),
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

const readHubSignerId = (profile: { metadata?: { board?: { validators?: Array<{ signerId?: string; signer?: string }> } } }): string => {
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
      runtimeId: String(profile.runtimeId || '').trim().toLowerCase(),
      jurisdictionName: String(profile.metadata?.jurisdiction?.name || '').trim(),
      chainId: Number(profile.metadata?.jurisdiction?.chainId || 0),
      depositoryAddress: String(profile.metadata?.jurisdiction?.depositoryAddress || '').trim(),
      jurisdictionRef: getJurisdictionStackId({
        chainId: Number(profile.metadata?.jurisdiction?.chainId || 0),
        depositoryAddress: String(profile.metadata?.jurisdiction?.depositoryAddress || '').trim(),
      }),
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

const normalizePositiveTokenIds = (tokenIds: readonly number[]): number[] =>
  Array.from(new Set(tokenIds.filter(tokenId => Number.isFinite(tokenId) && tokenId > 0).map(tokenId => Math.floor(tokenId))))
    .sort((a, b) => a - b);

const buildMarketMakerCrossTokenPairs = (
  sourceTokenIds: number[],
  targetTokenIds: number[] = sourceTokenIds,
): Array<{ sourceTokenId: number; targetTokenId: number }> => {
  const uniqueSourceTokenIds = normalizePositiveTokenIds(sourceTokenIds);
  const uniqueTargetTokenIds = normalizePositiveTokenIds(targetTokenIds);
  const pairs: Array<{ sourceTokenId: number; targetTokenId: number }> = [];
  for (const sourceTokenId of uniqueSourceTokenIds) {
    for (const targetTokenId of uniqueTargetTokenIds) {
      pairs.push({ sourceTokenId, targetTokenId });
    }
  }
  return pairs;
};

const invertPriceTicks = (ticks: bigint): bigint => {
  if (ticks <= 0n) return 0n;
  return (ORDERBOOK_PRICE_SCALE * ORDERBOOK_PRICE_SCALE) / ticks;
};

const getCrossSourceToTargetMidTicks = (sourceTokenId: number, targetTokenId: number): bigint => {
  if (sourceTokenId === targetTokenId) return ORDERBOOK_PRICE_SCALE;
  const oriented = getSwapPairOrientation(sourceTokenId, targetTokenId);
  const policy = getSwapPairPolicyByBaseQuote(oriented.baseTokenId, oriented.quoteTokenId);
  return sourceTokenId === oriented.baseTokenId
    ? policy.mmMidPriceTicks
    : invertPriceTicks(policy.mmMidPriceTicks);
};

const computeCrossTargetAmount = (
  sourceAmount: bigint,
  sourceIsBase: boolean,
  priceTicks: bigint,
): bigint => {
  if (sourceAmount <= 0n || priceTicks <= 0n) return 0n;
  return sourceIsBase
    ? (sourceAmount * priceTicks) / ORDERBOOK_PRICE_SCALE
    : (sourceAmount * ORDERBOOK_PRICE_SCALE) / priceTicks;
};

const snapPriceTicks = (ticks: bigint, stepTicks: number, mode: 'up' | 'down'): bigint => {
  const step = BigInt(Math.max(1, stepTicks));
  if (mode === 'up') return ((ticks + step - 1n) / step) * step;
  return (ticks / step) * step;
};

const fitCrossAmountsToOrderbook = (
  sourceJurisdiction: string,
  sourceTokenId: number,
  sourceAmount: bigint,
  targetJurisdiction: string,
  targetTokenId: number,
  targetAmount: bigint,
  priceTicks: bigint,
): { sourceAmount: bigint; targetAmount: bigint } | null => {
  if (sourceAmount <= 0n || targetAmount <= 0n || priceTicks <= 0n) return null;
  const market = deriveCanonicalCrossJurisdictionMarketForLegs(
    sourceJurisdiction,
    sourceTokenId,
    targetJurisdiction,
    targetTokenId,
  );
  const baseAmount = market.sourceIsBase ? sourceAmount : targetAmount;
  if (baseAmount <= ORDERBOOK_MAX_BASE_AMOUNT) return { sourceAmount, targetAmount };

  const cappedBase = ORDERBOOK_MAX_BASE_AMOUNT;
  const cappedQuote = (cappedBase * priceTicks) / ORDERBOOK_PRICE_SCALE;
  if (cappedQuote <= 0n) return null;
  return market.sourceIsBase
    ? { sourceAmount: cappedBase, targetAmount: cappedQuote }
    : { sourceAmount: cappedQuote, targetAmount: cappedBase };
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
  const unique = Array.from(new Set(ids));
  if (unique.length >= HUB_REQUIRED_TOKEN_COUNT) {
    return unique;
  }
  return [...DEFAULT_ACCOUNT_TOKEN_IDS];
};

const marketMakerContextKey = (context: Pick<MarketMakerEntityContext, 'entityId'>): string =>
  normalizeEntityRef(context.entityId);

const buildMarketMakerTokenIdsByContext = (
  tokenCatalog: JTokenInfo[],
  contexts: MarketMakerEntityContext[],
): Map<string, number[]> => {
  const catalogTokenIds = normalizeTokenIdsForMm(tokenCatalog);
  const fallback = catalogTokenIds.length >= HUB_REQUIRED_TOKEN_COUNT ? catalogTokenIds : [...DEFAULT_ACCOUNT_TOKEN_IDS];
  const byContext = new Map<string, number[]>();
  for (const context of contexts) {
    const jurisdictionTokenIds = normalizePositiveTokenIds(getTokenIdsForJurisdiction({
      name: context.jurisdictionName,
      chainId: context.chainId,
    }));
    byContext.set(
      marketMakerContextKey(context),
      jurisdictionTokenIds.length >= HUB_REQUIRED_TOKEN_COUNT ? jurisdictionTokenIds : fallback,
    );
  }
  return byContext;
};

const getMarketMakerTokenIds = (
  tokenIdsByContext: MarketMakerTokenIdsByContext,
  context: MarketMakerEntityContext,
  fallback: number[] = [...DEFAULT_ACCOUNT_TOKEN_IDS],
): number[] => {
  const ids = tokenIdsByContext.get(marketMakerContextKey(context));
  return ids && ids.length >= HUB_REQUIRED_TOKEN_COUNT ? ids : fallback;
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
    const maxLevelsByAccountLimit = Math.max(
      1,
      Math.floor(LIMITS.MAX_ACCOUNT_SWAP_OFFERS / Math.max(1, pairContexts.length * 2)),
    );
    const maxLevels = Math.min(
      MARKET_MAKER_MAX_LEVELS_PER_PAIR,
      maxLevelsByAccountLimit,
      pairContexts.reduce((max, entry) => Math.max(max, entry.levelProfile.offsetsBps.length), 0),
    );
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
  left: Pick<MarketMakerEntityContext | HubProfile, 'jurisdictionName' | 'chainId' | 'jurisdictionRef'>,
  right: Pick<MarketMakerEntityContext | HubProfile, 'jurisdictionName' | 'chainId' | 'jurisdictionRef'>,
): boolean => {
  return Boolean(left.jurisdictionRef && right.jurisdictionRef && left.jurisdictionRef === right.jurisdictionRef);
};

const normalizeEntityRef = (value: string): string => String(value || '').trim().toLowerCase();

const resolveEntityRuntimeIdForCrossJ = (env: Env, routeEntityIds: string[], entityId: string): string | null => {
  const target = normalizeEntityRef(entityId);
  const localRuntimeId = String(env.runtimeId || '').trim().toLowerCase();
  if (localRuntimeId && getEntityReplicaById(env, target)) return localRuntimeId;
  const profile = (env.gossip?.getProfiles?.() || []).find(item => normalizeEntityRef(item.entityId) === target);
  const runtimeId = String(profile?.runtimeId || '').trim().toLowerCase();
  if (runtimeId) return runtimeId;
  return routeEntityIds.includes(target) && localRuntimeId ? null : null;
};

const isCrossJurisdictionRouteTwoRuntime = (env: Env, route: CrossJurisdictionSwapRoute): boolean => {
  const canonical = withCanonicalCrossJurisdictionRouteHash(route);
  const requiredEntityIds = [
    canonical.source.entityId,
    canonical.source.counterpartyEntityId,
    canonical.target.entityId,
    canonical.target.counterpartyEntityId,
    canonical.bookOwnerEntityId || '',
    canonical.hubEntityId || '',
  ].map(normalizeEntityRef).filter(Boolean);
  return Boolean(resolveCrossJurisdictionRuntimeTopology(
    canonical,
    entityId => resolveEntityRuntimeIdForCrossJ(env, requiredEntityIds, entityId),
  ));
};

const canonicalizeLocalCrossJurisdictionRoute = (
  env: Env,
  route: CrossJurisdictionSwapRoute,
): CrossJurisdictionSwapRoute | null => {
  const canonical = withCanonicalCrossJurisdictionRouteHash(route);
  return isCrossJurisdictionRouteTwoRuntime(env, canonical) ? canonical : null;
};

const buildMarketMakerCrossOfferSpecs = (
  env: Env,
  sourceContext: MarketMakerEntityContext,
  targetContext: MarketMakerEntityContext,
  sourceHubs: HubProfile[],
  targetHubs: HubProfile[],
  sourceTokenIds: number[],
  targetTokenIds: number[],
): MarketMakerOfferSpec[] => {
  if (sourceContext.entityId === targetContext.entityId || sameJurisdiction(sourceContext, targetContext)) return [];
  const sourceJurisdictionRef = sourceContext.jurisdictionRef;
  const targetJurisdictionRef = targetContext.jurisdictionRef;
  if (!sourceJurisdictionRef || !targetJurisdictionRef) return [];
  const specs: MarketMakerOfferSpec[] = [];
  const crossPairs = buildMarketMakerCrossTokenPairs(sourceTokenIds, targetTokenIds);
  const targetByBaseName = new Map(targetHubs.map(hub => [hubBaseName(hub.name), hub] as const));
  const now = Number(env.timestamp || Date.now());

  for (const sourceHub of sourceHubs) {
    const targetHub = targetByBaseName.get(hubBaseName(sourceHub.name));
    if (!targetHub || sameJurisdiction(sourceHub, targetHub)) continue;
    const sourceHubSuffix = sourceHub.entityId.slice(-6).toLowerCase();
    const targetHubSuffix = targetHub.entityId.slice(-6).toLowerCase();

    for (const pair of crossPairs) {
      const market = deriveCanonicalCrossJurisdictionMarketForLegs(
        sourceJurisdictionRef,
        pair.sourceTokenId,
        targetJurisdictionRef,
        pair.targetTokenId,
      );
      const sourceToTargetMidTicks = getCrossSourceToTargetMidTicks(pair.sourceTokenId, pair.targetTokenId);
      const canonicalMidTicks = market.sourceIsBase ? sourceToTargetMidTicks : invertPriceTicks(sourceToTargetMidTicks);
      const oriented = pair.sourceTokenId === pair.targetTokenId
        ? { baseTokenId: pair.sourceTokenId, quoteTokenId: pair.targetTokenId }
        : getSwapPairOrientation(pair.sourceTokenId, pair.targetTokenId);
      const pairPolicy = getSwapPairPolicyByBaseQuote(oriented.baseTokenId, oriented.quoteTokenId);
      const levelProfile = getMarketMakerLevelProfile(oriented.baseTokenId, oriented.quoteTokenId);
      const levelCount = Math.min(MARKET_MAKER_CROSS_LEVELS_PER_PAIR, levelProfile.offsetsBps.length);

      for (let level = 0; level < levelCount; level += 1) {
        const offsetBps = levelProfile.offsetsBps[level]!;
        const sourceAmount = levelProfile.baseSizes[level]!;
        const rawPriceTicks = market.sourceIsBase
          ? (canonicalMidTicks * BigInt(10_000 + offsetBps)) / 10_000n
          : (canonicalMidTicks * BigInt(Math.max(1, 10_000 - offsetBps))) / 10_000n;
        const priceTicks = snapPriceTicks(rawPriceTicks, pairPolicy.priceStepTicks, market.sourceIsBase ? 'up' : 'down');
        if (!isWithinPairBand(canonicalMidTicks, priceTicks)) continue;
        const targetAmount = computeCrossTargetAmount(sourceAmount, market.sourceIsBase, priceTicks);
        const levelId = level + 1;
        const bookOwnerEntityId = deriveCanonicalCrossJurisdictionBookOwnerForLegs(
          sourceJurisdictionRef,
          pair.sourceTokenId,
          sourceHub.entityId,
          targetJurisdictionRef,
          pair.targetTokenId,
          targetHub.entityId,
        );
        const bookHubSignerId = normalizeEntityRef(bookOwnerEntityId) === normalizeEntityRef(sourceHub.entityId)
          ? sourceHub.signerId
          : targetHub.signerId;
        const routeBase = {
          makerEntityId: sourceContext.entityId,
          hubEntityId: sourceHub.entityId,
          bookOwnerEntityId,
          sourceSignerId: sourceContext.signerId,
          ...(sourceHub.signerId ? { sourceHubSignerId: sourceHub.signerId } : {}),
          ...(targetHub.signerId ? { targetHubSignerId: targetHub.signerId } : {}),
          targetSignerId: targetContext.signerId,
          ...(bookHubSignerId ? { bookHubSignerId } : {}),
          status: 'intent' as const,
          createdAt: now,
          updatedAt: now,
          expiresAt: now + MARKET_MAKER_CROSS_EXPIRY_MS,
        };

        const amounts = fitCrossAmountsToOrderbook(
          sourceJurisdictionRef,
          pair.sourceTokenId,
          sourceAmount,
          targetJurisdictionRef,
          pair.targetTokenId,
          targetAmount,
          priceTicks,
        );
        if (amounts) {
          const offerId = `mmx-${sourceHubSuffix}-${targetHubSuffix}-${pair.sourceTokenId}-${pair.targetTokenId}-sell-${levelId}`;
          const route = canonicalizeLocalCrossJurisdictionRoute(env, {
            ...routeBase,
            orderId: offerId,
            priceTicks,
            source: {
              jurisdiction: sourceJurisdictionRef,
              entityId: sourceContext.entityId,
              counterpartyEntityId: sourceHub.entityId,
              tokenId: pair.sourceTokenId,
              amount: amounts.sourceAmount,
            },
            target: {
              jurisdiction: targetJurisdictionRef,
              entityId: targetHub.entityId,
              counterpartyEntityId: targetContext.entityId,
              tokenId: pair.targetTokenId,
              amount: amounts.targetAmount,
            },
          });
          if (!route) continue;
          specs.push({
            offerId,
            pairId: market.venueId,
            hubEntityId: sourceHub.entityId,
            giveTokenId: pair.sourceTokenId,
            giveAmount: amounts.sourceAmount,
            wantTokenId: pair.targetTokenId,
            wantAmount: amounts.targetAmount,
            minFillRatio: 0,
            crossJurisdiction: route,
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
  const remoteCreditInputsByEntity = new Map<string, RoutedEntityInput>();

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

const collectPendingCrossRequestOrderIds = (env: Env, entityId: string): Set<string> => {
  const normalizedEntityId = normalizeEntityRef(entityId);
  const ids = new Set<string>();
  const collectFromTxs = (txs: EntityInput['entityTxs'] | undefined): void => {
    for (const tx of txs ?? []) {
      if (tx?.type !== 'requestCrossJurisdictionSwap') continue;
      const orderId = String(tx.data?.route?.orderId || '').trim();
      if (orderId) ids.add(orderId);
    }
  };

  const replica = getEntityReplicaById(env, normalizedEntityId);
  collectFromTxs(replica?.mempool);
  collectFromTxs(replica?.proposal?.txs);
  collectFromTxs(replica?.lockedFrame?.txs);
  for (const orderId of replica?.state?.crossJurisdictionSwaps?.keys?.() ?? []) {
    if (orderId) ids.add(String(orderId));
  }

  const runtimeInputs = [
    ...(env.runtimeMempool?.entityInputs ?? []),
    ...(env.runtimeInput?.entityInputs ?? []),
  ];
  for (const input of runtimeInputs) {
    if (normalizeEntityRef(input.entityId) !== normalizedEntityId) continue;
    collectFromTxs(input.entityTxs);
  }
  return ids;
};

const hasMarketMakerCrossRequestInFlight = (env: Env, spec: MarketMakerOfferSpec): boolean => {
  const route = spec.crossJurisdiction;
  if (!route) return false;
  return collectPendingCrossRequestOrderIds(env, route.source.entityId).has(route.orderId);
};

const hasMarketMakerCrossOffer = (env: Env, spec: MarketMakerOfferSpec): boolean => {
  const route = spec.crossJurisdiction;
  if (!route) return false;
  const bookOwnerEntityId = crossJurisdictionBookOwnerRef(route);
  const bookOwner = bookOwnerEntityId ? getEntityReplicaById(env, bookOwnerEntityId)?.state : null;
  return Boolean(bookOwner && hasCrossJurisdictionBookOrder(bookOwner, route));
};

const buildMarketMakerCrossHealth = (
  env: Env,
  contexts: MarketMakerEntityContext[],
  visibleHubs: HubProfile[],
  tokenIdsByContext: MarketMakerTokenIdsByContext,
): MarketMakerHealth['cross'] => {
  const jurisdictionCount = new Set(contexts.map(context => context.jurisdictionRef).filter(Boolean)).size;
  const routeGroups = new Map<string, {
    sourceJurisdiction: string;
    targetJurisdiction: string;
    sourceHubEntityId: string;
    targetHubEntityId: string;
    specs: MarketMakerOfferSpec[];
  }>();

  for (const sourceContext of contexts) {
    const sourceHubs = visibleHubs.filter(profile => sameJurisdiction(sourceContext, profile));
    if (sourceHubs.length === 0) continue;
    const sourceTokenIds = getMarketMakerTokenIds(tokenIdsByContext, sourceContext);
    for (const targetContext of contexts) {
      if (sourceContext.entityId === targetContext.entityId || sameJurisdiction(sourceContext, targetContext)) continue;
      const targetHubs = visibleHubs.filter(profile => sameJurisdiction(targetContext, profile));
      if (targetHubs.length === 0) continue;
      const targetTokenIds = getMarketMakerTokenIds(tokenIdsByContext, targetContext);
      for (const spec of buildMarketMakerCrossOfferSpecs(
        env,
        sourceContext,
        targetContext,
        sourceHubs,
        targetHubs,
        sourceTokenIds,
        targetTokenIds,
      )) {
        const route = spec.crossJurisdiction;
        if (!route) continue;
        const sourceHubEntityId = normalizeEntityRef(route.source.counterpartyEntityId);
        const targetHubEntityId = normalizeEntityRef(route.target.entityId);
        if (!sourceHubEntityId || !targetHubEntityId) continue;
        const key = `${sourceContext.entityId}:${targetContext.entityId}:${sourceHubEntityId}:${targetHubEntityId}`;
        const group = routeGroups.get(key) ?? {
          sourceJurisdiction: sourceContext.jurisdictionName,
          targetJurisdiction: targetContext.jurisdictionName,
          sourceHubEntityId,
          targetHubEntityId,
          specs: [],
        };
        group.specs.push(spec);
        routeGroups.set(key, group);
      }
    }
  }

  const expectedRouteCount = jurisdictionCount > 1 && contexts.every(context =>
    getMarketMakerTokenIds(tokenIdsByContext, context).length >= HUB_REQUIRED_TOKEN_COUNT,
  )
    ? routeGroups.size
    : 0;
  const routes = Array.from(routeGroups.values()).map((group) => {
    const expectedByPair = new Map<string, MarketMakerOfferSpec[]>();
    for (const spec of group.specs) {
      const pairSpecs = expectedByPair.get(spec.pairId) ?? [];
      pairSpecs.push(spec);
      expectedByPair.set(spec.pairId, pairSpecs);
    }
    const pairs = Array.from(expectedByPair.entries())
      .map(([pairId, specs]) => {
        const offers = specs.filter(spec => hasMarketMakerCrossOffer(env, spec)).length;
        const sourceTokenIds = normalizePositiveTokenIds(specs.map(spec => spec.crossJurisdiction?.source.tokenId ?? 0));
        const targetTokenIds = normalizePositiveTokenIds(specs.map(spec => spec.crossJurisdiction?.target.tokenId ?? 0));
        return {
          pairId,
          offers,
          ready: specs.length > 0 && offers >= specs.length,
          sourceTokenIds,
          targetTokenIds,
        };
      })
      .sort((left, right) => compareStableText(left.pairId, right.pairId));
    const offers = group.specs.filter(spec => hasMarketMakerCrossOffer(env, spec)).length;
    return {
      sourceJurisdiction: group.sourceJurisdiction,
      targetJurisdiction: group.targetJurisdiction,
      sourceHubEntityId: group.sourceHubEntityId,
      targetHubEntityId: group.targetHubEntityId,
      offers,
      ready: group.specs.length > 0 && offers >= group.specs.length && pairs.every(pair => pair.ready),
      pairs,
    };
  }).sort((left, right) =>
    compareStableText(left.sourceJurisdiction, right.sourceJurisdiction) ||
    compareStableText(left.targetJurisdiction, right.targetJurisdiction) ||
    compareStableText(left.sourceHubEntityId, right.sourceHubEntityId) ||
    compareStableText(left.targetHubEntityId, right.targetHubEntityId),
  );

  const expectedOffersPerRoute = Math.max(0, ...Array.from(routeGroups.values()).map(group => group.specs.length));
  const expectedOffersPerPair = Math.max(0, ...Array.from(routeGroups.values()).flatMap((group) => {
    const counts = new Map<string, number>();
    for (const spec of group.specs) counts.set(spec.pairId, (counts.get(spec.pairId) || 0) + 1);
    return Array.from(counts.values());
  }));

  return {
    ok: expectedRouteCount > 0
      ? routes.length >= expectedRouteCount && routes.every(route => route.ready)
      : routes.every(route => route.ready),
    expectedRoutes: expectedRouteCount || routes.length,
    expectedOffersPerRoute,
    expectedOffersPerPair,
    routes,
  };
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
  sourceTokenIds: number[],
  targetTokenIds: number[],
  maxOffersPerAccount = Math.max(2, Math.floor(MARKET_MAKER_OFFERS_PER_ACCOUNT_PER_TICK / 2)),
  maxNewOffersTotal = Math.max(2, Math.floor(MARKET_MAKER_MAX_NEW_OFFERS_PER_TICK / 2)),
): Promise<void> => {
  if (
    sourceHubs.length === 0 ||
    targetHubs.length === 0 ||
    sourceTokenIds.length < HUB_REQUIRED_TOKEN_COUNT ||
    targetTokenIds.length < HUB_REQUIRED_TOKEN_COUNT ||
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
    sourceTokenIds,
  );
  await ensureMarketMakerHubConnectivity(
    env,
    targetContext.entityId,
    targetContext.signerId,
    targetHubEntityIds,
    hubSignerIdsByEntityId,
    targetTokenIds,
  );

  if (!isMarketMakerConnectivityReady(env, sourceContext.entityId, sourceHubEntityIds, sourceTokenIds)) return;
  if (!isMarketMakerConnectivityReady(env, targetContext.entityId, targetHubEntityIds, targetTokenIds)) return;

  const desiredOffers = buildMarketMakerCrossOfferSpecs(
    env,
    sourceContext,
    targetContext,
    sourceHubs,
    targetHubs,
    sourceTokenIds,
    targetTokenIds,
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
          !hasMarketMakerCrossRequestInFlight(env, spec) &&
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
  crossOptions?: {
    contexts: MarketMakerEntityContext[];
    visibleHubs: HubProfile[];
    tokenIdsByContext: MarketMakerTokenIdsByContext;
  },
): MarketMakerHealth => {
  const pairs = buildDefaultEntitySwapPairs(tokenIds);
  const desiredSpecs = buildMarketMakerOfferSpecs(hubEntityIds, tokenIds);
  const cross = crossOptions
    ? buildMarketMakerCrossHealth(env, crossOptions.contexts, crossOptions.visibleHubs, crossOptions.tokenIdsByContext)
    : {
        ok: true,
        expectedRoutes: 0,
        expectedOffersPerRoute: 0,
        expectedOffersPerPair: 0,
        routes: [],
      };
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
      cross,
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
    ok: hubs.length > 0 && hubs.every((entry) => entry.ready) && cross.ok,
    entityId: mmEntityId,
    connectivity,
    expectedOffersPerHub,
    expectedOffersPerPair,
    hubs,
    cross,
  };
};

const run = async (): Promise<void> => {
  if (resolvedArgs.dbPath) process.env['XLN_DB_PATH'] = resolvedArgs.dbPath;

  const env = await main(resolvedArgs.seed);
  startRuntimeLoop(env);
  let startupPhase = 'boot';
  let activeMmEntityId: string | null = null;
  let mmContexts: MarketMakerEntityContext[] = [];
  let mmTokenIdsByContext: Map<string, number[]> = new Map();
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

  const jurisdiction = resolveJurisdictionConfig(resolvedArgs.rpcUrl);
  nodeLog.info('startup phase', { phase: startupPhase });

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
  const handleRadapterWsMessage = (ws: MarketMakerServerSocket, raw: string | Buffer | ArrayBuffer): void => {
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
        const primaryContext = mmContexts[0] ?? null;
        const visibleHubs = readVisibleHubProfiles(env).filter(profile =>
          primaryContext ? sameJurisdiction(primaryContext, profile) : true,
        );
        const allVisibleHubs = readVisibleHubProfiles(env, true);
        const activeEntityId = activeMmEntityId;
        const primaryTokenIds = primaryContext
          ? getMarketMakerTokenIds(mmTokenIdsByContext, primaryContext, normalizeTokenIdsForMm([]))
          : normalizeTokenIdsForMm([]);
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
            directInput: {
              lastSeen: lastDirectEntityInput,
              lastError: lastDirectEntityInputError,
            },
          },
          gossip: {
            visibleHubNames: visibleHubs.map(profile => profile.name),
            visibleHubIds: visibleHubs.map(profile => profile.entityId),
            ready: visibleHubs.length === resolvedArgs.meshHubNames.length,
          },
          marketMaker: activeEntityId
            ? getMarketMakerHealth(env, activeEntityId, visibleHubs.map(profile => profile.entityId), primaryTokenIds, {
                contexts: mmContexts,
                visibleHubs: allVisibleHubs,
                tokenIdsByContext: mmTokenIdsByContext,
              })
            : {
                enabled: true,
                ok: false,
                entityId: null,
                expectedOffersPerHub: 0,
                expectedOffersPerPair: 0,
                hubs: [],
                cross: {
                  ok: false,
                  expectedRoutes: 0,
                  expectedOffersPerRoute: 0,
                  expectedOffersPerPair: 0,
                  routes: [],
                },
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
	      open(ws: MarketMakerServerSocket) {
	        if (ws.data?.type === 'rpc') {
	          attachRuntimeAdapterTicker(env, registerEnvChangeCallback);
	          return;
	        }
	        directRuntimeWs.websocket.open(ws);
	      },
	      message(ws: MarketMakerServerSocket, raw: string | Buffer | ArrayBuffer) {
	        if (ws.data?.type === 'rpc') {
	          handleRadapterWsMessage(ws, raw);
	          return;
	        }
	        return directRuntimeWs.websocket.message(ws, raw);
	      },
	      close(ws: MarketMakerServerSocket) {
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

  const secondaryJurisdictions = resolveSecondaryJurisdictions<JurisdictionConfig>(jurisdiction.rpc);
  for (const [index, secondary] of secondaryJurisdictions.entries()) {
    const secondaryName = String(secondary.name || `Secondary ${index + 1}`).trim();
    const secondaryDisplayName = formatJurisdictionDisplayName(secondaryName) || secondaryName;
    if (!secondaryName) continue;
    startupPhase = `import-jurisdiction-${secondaryName}`;
    await importJurisdictionIfNeeded(env, secondary);
    startupPhase = `import-replica-${secondaryName}`;
    const siblingContext = await createMarketMakerEntityContext(
      env,
      secondary,
      `${resolvedArgs.signerLabel}:${secondaryName}`,
      `${resolvedArgs.name} ${secondaryDisplayName}`,
      { x: 160 + index * 80, y: -40, z: 120, jurisdiction: secondaryName },
    );
    mmContexts.push(siblingContext);
    console.log(
      `[MESH-MM] Sibling MM ready jurisdiction=${secondaryName} entity=${siblingContext.entityId.slice(0, 12)}`,
    );
  }
  mmTokenIdsByContext = buildMarketMakerTokenIdsByContext(tokenCatalog, mmContexts);
  console.log(`[MESH-MM] Token universe for market making: ${mmContexts
    .map(context => `${formatJurisdictionDisplayName(context.jurisdictionName) || context.jurisdictionName}=${getMarketMakerTokenIds(mmTokenIdsByContext, context).join(',')}`)
    .join(' ')}`);

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
        const contextTokenIds = getMarketMakerTokenIds(mmTokenIdsByContext, context);
        const desiredOfferCount = buildMarketMakerOfferSpecs(hubEntityIds, contextTokenIds).length;
        const expectedOffersPerHub = Math.max(1, Math.ceil(desiredOfferCount / Math.max(1, hubEntityIds.length)));
        await maintainMarketMakerQuotes(
          env,
          context.entityId,
          context.signerId,
          hubEntityIds,
          hubSignerIdsByEntityId,
          contextTokenIds,
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
        const sourceTokenIds = getMarketMakerTokenIds(mmTokenIdsByContext, sourceContext);
        for (const targetContext of mmContexts) {
          if (sourceContext.entityId === targetContext.entityId || sameJurisdiction(sourceContext, targetContext)) continue;
          const targetHubs = visibleHubs.filter(profile => sameJurisdiction(targetContext, profile));
          if (targetHubs.length === 0) continue;
          const targetTokenIds = getMarketMakerTokenIds(mmTokenIdsByContext, targetContext);
          const desiredCrossOfferCount = buildMarketMakerCrossOfferSpecs(
            env,
            sourceContext,
            targetContext,
            sourceHubs,
            targetHubs,
            sourceTokenIds,
            targetTokenIds,
          ).length;
          await maintainMarketMakerCrossQuotes(
            env,
            sourceContext,
            targetContext,
            sourceHubs,
            targetHubs,
            hubSignerIdsByEntityId,
            sourceTokenIds,
            targetTokenIds,
            mode === 'bootstrap'
              ? Math.max(MARKET_MAKER_CROSS_LEVELS_PER_PAIR * buildMarketMakerCrossTokenPairs(sourceTokenIds, targetTokenIds).length, MARKET_MAKER_OFFERS_PER_ACCOUNT_PER_TICK)
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
      const visibleHubs = readVisibleHubProfiles(env).filter(profile => sameJurisdiction(primaryMmContext, profile));
      const allVisibleHubs = readVisibleHubProfiles(env, true);
      const primaryTokenIds = getMarketMakerTokenIds(mmTokenIdsByContext, primaryMmContext);
      const health = getMarketMakerHealth(env, primaryMmContext.entityId, visibleHubs.map(profile => profile.entityId), primaryTokenIds, {
        contexts: mmContexts,
        visibleHubs: allVisibleHubs,
        tokenIdsByContext: mmTokenIdsByContext,
      });
      if (health.ok) return true;
      await sleep(MARKET_MAKER_BOOTSTRAP_LOOP_MS);
    }
    const visibleHubs = readVisibleHubProfiles(env).filter(profile => sameJurisdiction(primaryMmContext, profile));
    const allVisibleHubs = readVisibleHubProfiles(env, true);
    const primaryTokenIds = getMarketMakerTokenIds(mmTokenIdsByContext, primaryMmContext);
    const health = getMarketMakerHealth(env, primaryMmContext.entityId, visibleHubs.map(profile => profile.entityId), primaryTokenIds, {
      contexts: mmContexts,
      visibleHubs: allVisibleHubs,
      tokenIdsByContext: mmTokenIdsByContext,
    });
    console.warn(
      `[MESH-MM] BOOTSTRAP_TIMEOUT visibleHubs=${visibleHubs.length} offers=${safeStringify(health.hubs.map(hub => ({ hubEntityId: hub.hubEntityId, offers: hub.offers })))} cross=${safeStringify({ expectedRoutes: health.cross.expectedRoutes, routes: health.cross.routes.map(route => ({ sourceHubEntityId: route.sourceHubEntityId, targetHubEntityId: route.targetHubEntityId, offers: route.offers, ready: route.ready })) })}`,
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
        const visibleHubs = readVisibleHubProfiles(env).filter(profile => sameJurisdiction(primaryMmContext, profile));
        const allVisibleHubs = readVisibleHubProfiles(env, true);
        const primaryTokenIds = getMarketMakerTokenIds(mmTokenIdsByContext, primaryMmContext);
        const health = getMarketMakerHealth(env, primaryMmContext.entityId, visibleHubs.map(profile => profile.entityId), primaryTokenIds, {
          contexts: mmContexts,
          visibleHubs: allVisibleHubs,
          tokenIdsByContext: mmTokenIdsByContext,
        });
        if (health.ok) {
          markOffersReady();
        }
      }
    })().catch(error => {
      if (shuttingDown) return;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[MM] quote loop failed; shutting down:`, message);
      if (loop) clearInterval(loop);
      process.exit(1);
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

resetMeshJurisdictionsCache();
run().catch(error => {
  console.error(`[MESH-MM] FAILED:`, (error as Error).stack || (error as Error).message);
  process.exit(1);
});
