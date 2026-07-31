#!/usr/bin/env bun

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../account/crypto';
import {
  buildDefaultEntitySwapPairs,
  getSwapPairOrientation,
  getSwapPairPolicyByBaseQuote,
  getTokenIdsForJurisdiction,
  getTokenInfo,
  isLiquidSwapToken,
} from '../account/utils';
import { deriveAccountWatchSeed } from '../protocol/account-watch-seed';
import { LIMITS, SWAP_CONSTANTS } from '../config/constants';
import { readCliOption } from '../config/cli';
import { readBooleanEnv } from '../config/environment';
import { resolveCrossJurisdictionRuntimeTopology } from '../extensions/cross-j/boundary';
import {
  deriveCanonicalCrossJurisdictionBookOwnerForLegs,
  deriveCanonicalCrossJurisdictionMarketForLegs,
  withCanonicalCrossJurisdictionRouteHash,
} from '../extensions/cross-j/index';
import { crossJurisdictionBookOwnerRef } from '../extensions/cross-j/orderbook';
import { createStructuredLogger } from '../infra/logger';
import type { JAdapter, JTokenInfo } from '../jadapter/types';
import {
  attachLiveJAdapter,
  getLiveJAdapter,
  getLiveJAdapterEntries,
} from '../runtime/live-jadapters';
import { getJurisdictionIdentityRef } from '../jurisdiction/jurisdiction-runtime';
import { getJurisdictionStackId, requireJurisdictionChainId } from '../jurisdiction/jurisdiction-stack';
import { type DirectWebSocket } from '../network/p2p/direct-runtime-bun';
import { normalizeRuntimeId } from '../network/p2p/runtime-id';
import {
  baseAmountAtPrice,
  baseAmountAtPriceCeil,
  computePriceTicksForBaseQuote,
  getSwapLotScale,
  MAX_ORDERBOOK_QTY_LOTS,
  ORDERBOOK_PRICE_SCALE,
  quoteAmountAtPrice,
} from '../orderbook';
import { hasCrossJurisdictionBookOrder } from '../orderbook/cross-j';
import { compareStableText, safeStringify } from '../protocol/serialization';
import { registerRuntimeAdapterAuthSeed } from '../radapter/auth';
import { type RuntimeAdapterSocket } from '../radapter/server';
import { enqueueRuntimeInput } from '../runtime.ts';
import type { AccountReplica, SwapOffer } from '../types/account';
import type { CrossJurisdictionSwapRoute } from '../types/cross-jurisdiction';
import type { EntityInput } from '../entity/types';
import type { RuntimeReplica } from '../runtime/types';
import { readInheritedChildSecrets, resolveChildSecret } from '../infra/child-secrets';
import {
  BOOTSTRAP_POLL_MS,
  buildMarketMakerConsensusConfig,
  collectQueuedSwapOfferIds,
  DEFAULT_ACCOUNT_TOKEN_IDS,
  deriveMarketMakerEntityId,
  getAccountState,
  getBootstrapCreditAmount,
  getEntityOutCapacity,
  getEntityReplicaById,
  hasCommittedAccountState,
  hasPairMutualCredit,
  hasQueuedExtendCredit,
  hasQueuedOpenAccount,
  HUB_REQUIRED_TOKEN_COUNT,
  isAccountConsensusReady,
  isCanonicalAccountOpener,
  settleRuntimeFor,
  sleep,
  waitUntil,
  type MarketMakerEntityJurisdictionConfig,
} from './mesh-common';
import {
  requireJurisdictionBlockTimeMs,
  resolveMeshJurisdictionConfig,
  resolveSecondaryJurisdictions,
  type ResolvedMeshJurisdictionConfig,
} from './mesh-jurisdictions';
import { runtimeBacklogBlocksMarketMakerQuotes } from './mm-bootstrap-progress';

type Args = {
  name: string;
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
  dbPath: string;
};

export type MarketMakerServerSocket = DirectWebSocket & RuntimeAdapterSocket & { data?: { type?: string } };

export type JurisdictionConfig = ResolvedMeshJurisdictionConfig;

export type HubProfile = {
  name: string;
  hubName?: string;
  entityId: string;
  signerId?: string;
  runtimeId?: string;
  jurisdictionName?: string;
  chainId?: number;
  depositoryAddress?: string;
  jurisdictionRef: string;
};

export type MarketMakerOfferSpec = {
  offerId: string;
  pairId: string;
  hubEntityId: string;
  giveTokenId: number;
  giveAmount: bigint;
  wantTokenId: number;
  wantAmount: bigint;
  priceTicks: bigint;
  crossJurisdiction?: CrossJurisdictionSwapRoute;
};

export type MarketMakerConnectivityBudget = {
  remainingTxs: number;
};

export type MarketMakerEntityContext = {
  entityId: string;
  signerId: string;
  jurisdictionName: string;
  chainId: number;
  depositoryAddress?: string;
  jurisdictionRef: string;
};

export type MarketMakerTokenIdsByContext = ReadonlyMap<string, number[]>;

export type CrossQuoteJob = {
  sourceContext: MarketMakerEntityContext;
  targetContext: MarketMakerEntityContext;
  sourceHubs: HubProfile[];
  targetHubs: HubProfile[];
  sourceTokenIds: number[];
  targetTokenIds: number[];
};

export type SameQuoteJob = {
  context: MarketMakerEntityContext;
  hub: HubProfile;
  tokenIds: number[];
};

export type MarketMakerAccountBlocker = {
  entityId: string;
  counterpartyEntityId: string;
  reason: 'missing-account' | 'inactive-account' | 'height-zero' | 'pending-frame' | 'mempool';
  status: string | null;
  currentHeight: number | null;
  pendingFrame: boolean;
  pendingFrameHeight: number | null;
  mempoolLength: number;
  swapOffers: number;
};

export type MarketMakerCrossRouteBlocker = {
  role: 'source-mm-hub' | 'target-mm-hub';
  entityId: string;
  counterpartyEntityId: string;
  reason: 'missing-account' | 'inactive-account' | 'height-zero' | 'pending-frame' | 'mempool';
  status: string | null;
  currentHeight: number | null;
  pendingFrame: boolean;
  pendingFrameHeight: number | null;
  mempoolLength: number;
  swapOffers: number;
};

type MarketMakerCrossRouteHealth = {
  sourceJurisdiction: string;
  targetJurisdiction: string;
  sourceMmEntityId: string;
  targetMmEntityId: string;
  sourceHubEntityId: string;
  targetHubEntityId: string;
  offers: number;
  ready: boolean;
  depthReady: boolean;
  blockers: MarketMakerCrossRouteBlocker[];
  pairs: Array<{
    pairId: string;
    offers: number;
    ready: boolean;
    depthReady: boolean;
    expectedOffers: number;
    sourceTokenIds: number[];
    targetTokenIds: number[];
  }>;
};

export type MarketMakerHealth = {
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
    depthReady: boolean;
    blockers: MarketMakerAccountBlocker[];
    pairs: Array<{ pairId: string; offers: number; ready: boolean; depthReady: boolean; expectedOffers: number }>;
  }>;
  cross: {
    applicable: boolean;
    ok: boolean;
    expectedRoutes: number;
    expectedOffersPerRoute: number;
    expectedOffersPerPair: number;
    routeCount?: number;
    routes: MarketMakerCrossRouteHealth[];
  };
};

export const MARKET_MAKER_QUOTE_LOOP_MS = Math.max(1000, Number(process.env['MARKET_MAKER_QUOTE_LOOP_MS'] || '30000'));
export const MARKET_MAKER_HEALTH_REFRESH_MS = Math.max(
  250,
  Number(process.env['MARKET_MAKER_HEALTH_REFRESH_MS'] || '1000'),
);
export const MARKET_MAKER_BOOTSTRAP_LOOP_MS = Math.max(1, Number(process.env['MARKET_MAKER_BOOTSTRAP_LOOP_MS'] || '1'));
export const MARKET_MAKER_BOOTSTRAP_START_DELAY_MS = Math.max(
  0,
  Number(process.env['MARKET_MAKER_BOOTSTRAP_START_DELAY_MS'] || '0'),
);
export const MARKET_MAKER_RUNTIME_TICK_DELAY_MS = Math.max(
  0,
  Number(process.env['MARKET_MAKER_RUNTIME_TICK_DELAY_MS'] || '0'),
);
export const MARKET_MAKER_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME = Math.max(
  0,
  Number(process.env['MARKET_MAKER_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME'] || '0'),
);
export const MARKET_MAKER_MAX_ENTITY_TXS_PER_RUNTIME_FRAME = Math.max(
  0,
  Number(process.env['MARKET_MAKER_MAX_ENTITY_TXS_PER_RUNTIME_FRAME'] || '0'),
);
const MARKET_MAKER_API_YIELD_MS = Math.max(1, Number(process.env['MARKET_MAKER_API_YIELD_MS'] || '5'));
export const MARKET_MAKER_OFFERS_PER_ACCOUNT_PER_TICK = Math.max(
  2,
  Number(process.env['MARKET_MAKER_OFFERS_PER_ACCOUNT_PER_TICK'] || '1000'),
);
export const MARKET_MAKER_MAX_NEW_OFFERS_PER_TICK = Math.max(
  4,
  Number(process.env['MARKET_MAKER_MAX_NEW_OFFERS_PER_TICK'] || '1000'),
);
// Bootstrap is full readiness: every configured same-chain and cross route level
// must be committed before offers-ready, so tests do not race background fills.
// Keep same-chain bootstrap throughput high; correctness is enforced by
// committed-depth health, not by slowly dripping orders into the producer.
const MARKET_MAKER_BOOTSTRAP_DEFAULT_OFFERS_PER_ACCOUNT_PER_TICK = 1000;
const MARKET_MAKER_BOOTSTRAP_DEFAULT_MAX_NEW_OFFERS_PER_TICK = 1000;
export const MARKET_MAKER_BOOTSTRAP_SAME_QUOTE_HUB_GROUPS_PER_WAVE = Math.max(
  1,
  Number(process.env['MARKET_MAKER_BOOTSTRAP_SAME_QUOTE_HUB_GROUPS_PER_WAVE'] || '1'),
);
export const MARKET_MAKER_BOOTSTRAP_OFFERS_PER_ACCOUNT_PER_TICK = Math.max(
  2,
  Number(
    process.env['MARKET_MAKER_BOOTSTRAP_OFFERS_PER_ACCOUNT_PER_TICK'] ||
      String(MARKET_MAKER_BOOTSTRAP_DEFAULT_OFFERS_PER_ACCOUNT_PER_TICK),
  ),
);
export const MARKET_MAKER_BOOTSTRAP_MAX_NEW_OFFERS_PER_TICK = Math.max(
  4,
  Number(
    process.env['MARKET_MAKER_BOOTSTRAP_MAX_NEW_OFFERS_PER_TICK'] ||
      String(MARKET_MAKER_BOOTSTRAP_DEFAULT_MAX_NEW_OFFERS_PER_TICK),
  ),
);
// Each source-hub Entity independently admits at most 45 intents per frame.
// Bootstrap may fill all three independent hub groups in one wave; the old
// global limit of 45 serialized them into needless consensus roundtrips.
const MARKET_MAKER_BOOTSTRAP_DEFAULT_CROSS_OFFERS_PER_ACCOUNT_PER_TICK = 45;
const MARKET_MAKER_BOOTSTRAP_DEFAULT_MAX_NEW_CROSS_OFFERS_PER_TICK = 135;
export const MARKET_MAKER_BOOTSTRAP_CROSS_OFFERS_PER_ACCOUNT_PER_TICK = Math.max(
  1,
  Number(
    process.env['MARKET_MAKER_BOOTSTRAP_CROSS_OFFERS_PER_ACCOUNT_PER_TICK'] ||
      String(MARKET_MAKER_BOOTSTRAP_DEFAULT_CROSS_OFFERS_PER_ACCOUNT_PER_TICK),
  ),
);
export const MARKET_MAKER_BOOTSTRAP_MAX_NEW_CROSS_OFFERS_PER_TICK = Math.max(
  1,
  Number(
    process.env['MARKET_MAKER_BOOTSTRAP_MAX_NEW_CROSS_OFFERS_PER_TICK'] ||
      String(MARKET_MAKER_BOOTSTRAP_DEFAULT_MAX_NEW_CROSS_OFFERS_PER_TICK),
  ),
);
export const MARKET_MAKER_BOOTSTRAP_CROSS_SOURCE_HUB_GROUPS_PER_WAVE = Math.max(
  1,
  Number(process.env['MARKET_MAKER_BOOTSTRAP_CROSS_SOURCE_HUB_GROUPS_PER_WAVE'] || '3'),
);
export const MARKET_MAKER_STEADY_CROSS_ROUTE_JOBS_PER_TICK = Math.max(
  1,
  Number(process.env['MARKET_MAKER_STEADY_CROSS_ROUTE_JOBS_PER_TICK'] || '1000'),
);
export const MARKET_MAKER_CONNECTIVITY_MAX_TXS_PER_TICK = Math.max(
  1,
  Number(process.env['MARKET_MAKER_CONNECTIVITY_MAX_TXS_PER_TICK'] || '1000'),
);
export const MARKET_MAKER_BOOTSTRAP_CONNECTIVITY_MAX_TXS_PER_TICK = Math.max(
  1,
  Number(process.env['MARKET_MAKER_BOOTSTRAP_CONNECTIVITY_MAX_TXS_PER_TICK'] || '1000'),
);
// One canonical visible ladder for every market. A production shell override
// previously reduced cross-J to three levels while same-J exposed ten, so
// health was green although users saw a materially thinner cross-J book.
export const MARKET_MAKER_LEVELS_PER_SIDE = 10;
const MARKET_MAKER_CROSS_MAX_TOKEN_PAIRS_PER_ROUTE = Math.max(
  1,
  Math.min(1000, Number(process.env['MARKET_MAKER_CROSS_MAX_TOKEN_PAIRS_PER_ROUTE'] || '1000')),
);
export const MARKET_MAKER_BOOTSTRAP_EVENTS_JSONL = String(
  process.env['XLN_MARKET_MAKER_BOOTSTRAP_EVENTS_JSONL'] || '',
).trim();
export const MARKET_MAKER_BOOTSTRAP_LOG_BACKLOG = process.env['XLN_MARKET_MAKER_BOOTSTRAP_LOG_BACKLOG'] === '1';

export const emitMarketMakerBootstrapDebugEvent = (event: string, fields: Record<string, unknown> = {}): void => {
  if (!MARKET_MAKER_BOOTSTRAP_EVENTS_JSONL) return;
  const record = {
    schema: 'xln-market-maker-bootstrap-debug-event-v1',
    at: new Date().toISOString(),
    event,
    ...fields,
  };
  try {
    mkdirSync(dirname(MARKET_MAKER_BOOTSTRAP_EVENTS_JSONL), { recursive: true });
    appendFileSync(MARKET_MAKER_BOOTSTRAP_EVENTS_JSONL, `${safeStringify(record)}\n`);
  } catch (error) {
    console.error(
      `[MESH-MM] BOOTSTRAP_DEBUG_EVENT_WRITE_FAILED path=${MARKET_MAKER_BOOTSTRAP_EVENTS_JSONL} ` +
        `error=${error instanceof Error ? error.message : String(error)}`,
    );
  }
};
const MARKET_MAKER_CROSS_EXPIRY_MS = Math.max(
  60_000,
  Number(process.env['MARKET_MAKER_CROSS_EXPIRY_MS'] || String(24 * 60 * 60 * 1000)),
);
export const yieldMarketMakerApi = async (): Promise<void> => {
  await new Promise<void>(resolve => setTimeout(resolve, MARKET_MAKER_API_YIELD_MS));
};
const DEFAULT_AMOUNT_SCALE = 10n ** 18n;
const scaleDefaultAmountForToken = (tokenId: number, amountAt18Decimals: bigint): bigint => {
  const tokenUnit = 10n ** BigInt(getTokenInfo(tokenId).decimals);
  const numerator = amountAt18Decimals * tokenUnit;
  if (numerator % DEFAULT_AMOUNT_SCALE !== 0n) {
    throw new Error(`MARKET_MAKER_TOKEN_SCALE_INEXACT:token=${tokenId}:amount=${amountAt18Decimals}`);
  }
  return numerator / DEFAULT_AMOUNT_SCALE;
};
const minimumTradeAmount = (tokenId: number): bigint => 10n * 10n ** BigInt(getTokenInfo(tokenId).decimals);
const orderbookMaxBaseAmount = (baseTokenId: number): bigint => MAX_ORDERBOOK_QTY_LOTS * getSwapLotScale(baseTokenId);
// All resting offers on one bilateral account share the same collateral limit.
// Size the complete default ladder, not each quote independently, so same-chain
// plus cross-j depth fits $1M credit even on the five-token jurisdiction.
const MARKET_MAKER_SIZE_UNIT = 85n * 10n ** 15n;
const MARKET_MAKER_STABLE_SIZE_UNIT = 85n * 10n ** 18n;
const MARKET_MAKER_LEVEL_OFFSETS_BPS = [2, 4, 6, 8, 10, 12, 15, 20, 25, 32, 40, 50, 65, 80, 100] as const;
const MARKET_MAKER_LEVEL_BASE_SIZES = [
  120n * MARKET_MAKER_SIZE_UNIT,
  140n * MARKET_MAKER_SIZE_UNIT,
  160n * MARKET_MAKER_SIZE_UNIT,
  180n * MARKET_MAKER_SIZE_UNIT,
  210n * MARKET_MAKER_SIZE_UNIT,
  240n * MARKET_MAKER_SIZE_UNIT,
  270n * MARKET_MAKER_SIZE_UNIT,
  300n * MARKET_MAKER_SIZE_UNIT,
  330n * MARKET_MAKER_SIZE_UNIT,
  360n * MARKET_MAKER_SIZE_UNIT,
  370n * MARKET_MAKER_SIZE_UNIT,
  380n * MARKET_MAKER_SIZE_UNIT,
  385n * MARKET_MAKER_SIZE_UNIT,
  390n * MARKET_MAKER_SIZE_UNIT,
  395n * MARKET_MAKER_SIZE_UNIT,
] as const;
const MARKET_MAKER_STABLE_LEVEL_OFFSETS_BPS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 28, 36, 48] as const;
const MARKET_MAKER_STABLE_LEVEL_BASE_SIZES = [
  120n * MARKET_MAKER_STABLE_SIZE_UNIT,
  140n * MARKET_MAKER_STABLE_SIZE_UNIT,
  180n * MARKET_MAKER_STABLE_SIZE_UNIT,
  210n * MARKET_MAKER_STABLE_SIZE_UNIT,
  240n * MARKET_MAKER_STABLE_SIZE_UNIT,
  300n * MARKET_MAKER_STABLE_SIZE_UNIT,
  360n * MARKET_MAKER_STABLE_SIZE_UNIT,
  420n * MARKET_MAKER_STABLE_SIZE_UNIT,
  480n * MARKET_MAKER_STABLE_SIZE_UNIT,
  560n * MARKET_MAKER_STABLE_SIZE_UNIT,
  640n * MARKET_MAKER_STABLE_SIZE_UNIT,
  720n * MARKET_MAKER_STABLE_SIZE_UNIT,
  800n * MARKET_MAKER_STABLE_SIZE_UNIT,
  900n * MARKET_MAKER_STABLE_SIZE_UNIT,
  1_000n * MARKET_MAKER_STABLE_SIZE_UNIT,
] as const;
const argsRaw = process.argv.slice(2);

const getArg = (name: string, fallback = ''): string =>
  readCliOption(argsRaw, name, fallback);

const readRpcUrls = (): Record<number, string> => {
  const urls: Record<number, string> = {};
  for (let index = 1; index <= 8; index += 1) {
    const flag = index === 1 ? '--rpc-url' : `--rpc${index}-url`;
    const envName = index === 1 ? 'ANVIL_RPC' : `ANVIL_RPC${index}`;
    const fallback =
      index === 1
        ? process.env['ANVIL_RPC'] || ''
        : process.env[envName] || process.env[`RPC${index}`] || process.env[`XLN_RPC${index}_URL`] || '';
    urls[index] = getArg(
      flag,
      index === 2 ? process.env['ANVIL_RPC2'] || process.env['RPC_TRON'] || fallback : fallback,
    );
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
  const seed = resolveChildSecret(childSecrets, 'runtimeSeed', getArg('--seed', process.env['XLN_RUNTIME_SEED'] || ''));
  if (!seed) throw new Error('Market-maker seed is required via inherited secret FD, --seed, or XLN_RUNTIME_SEED');
  return {
    name: getArg('--name', 'MM'),
    seed,
    signerLabel: getArg('--signer-label', 'mm-1'),
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
    dbPath: getArg('--db-path', ''),
  };
};

const defaultArgsForImport = (): Args => ({
  name: 'MM',
  seed: '',
  signerLabel: 'mm-1',
  relayUrl: 'ws://127.0.0.1:20002/relay',
  apiHost: '127.0.0.1',
  apiPort: 0,
  directWsUrl: '',
  rpcUrl: '',
  rpc2Url: '',
  rpcUrls: {},
  meshHubNames: ['H1', 'H2', 'H3'],
  dbPath: '',
});

// This module is imported by the tiny executable facade, so `import.meta.main`
// is false here even when the market-maker process itself is the entry point.
// Keep import-time defaults inert for unit tests, then activate real arguments
// synchronously at the start of runMarketMakerNode before any key is derived.
export const resolvedArgs = defaultArgsForImport();
export let apiUrl = `http://${resolvedArgs.apiHost}:${resolvedArgs.apiPort}`;
export let directWsUrl = '';
export let nodeLog = createStructuredLogger('mesh.marketMaker', { name: resolvedArgs.name });

export const activateMarketMakerProcessArgs = (): void => {
  const parsed = parseArgs();
  Object.assign(resolvedArgs, parsed);
  apiUrl = `http://${parsed.apiHost}:${parsed.apiPort}`;
  directWsUrl = String(parsed.directWsUrl || '').trim();
  if (!directWsUrl) throw new Error('[MESH-MM] Missing required --direct-ws-url');
  nodeLog = createStructuredLogger('mesh.marketMaker', { name: parsed.name });
};

export const resolveLocalApiUrl = (value: string): string => {
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
export const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

export const buildLocalMarketMakerSignerLabels = (): string[] => {
  const primary = resolveJurisdictionConfig(resolvedArgs.rpcUrl);
  const labels = [resolvedArgs.signerLabel];
  for (const [index, secondary] of resolveSecondaryJurisdictions(primary.rpc).entries()) {
    const secondaryName = String(secondary.name || `Secondary ${index + 1}`).trim();
    if (secondaryName) labels.push(`${resolvedArgs.signerLabel}:${secondaryName}`);
  }
  return labels;
};

export const configureMarketMakerRuntimeLogging = (env: RuntimeReplica): void => {
  if (readBooleanEnv('XLN_MARKET_MAKER_VERBOSE_RUNTIME_LOGS', false)) return;
  env.quietRuntimeLogs = true;
};

export const resolveJurisdictionConfig = (rpcUrlOverride: string): JurisdictionConfig =>
  resolveMeshJurisdictionConfig(rpcUrlOverride);

export const resolveImportedJurisdictionRpc = (jurisdiction: JurisdictionConfig): string =>
  resolveLocalApiUrl(jurisdiction.rpc);

const toEntityJurisdictionConfig = (jurisdiction: JurisdictionConfig): MarketMakerEntityJurisdictionConfig => ({
  name: jurisdiction.name,
  address: resolveImportedJurisdictionRpc(jurisdiction),
  entityProviderAddress: jurisdiction.contracts.entityProvider,
  depositoryAddress: jurisdiction.contracts.depository,
  chainId: jurisdiction.chainId,
  blockTimeMs: requireJurisdictionBlockTimeMs(jurisdiction),
});

const sameImportedJurisdiction = (target: JurisdictionConfig, replica: unknown): boolean => {
  const targetRef = getJurisdictionIdentityRef(target);
  const replicaRef = getJurisdictionIdentityRef(replica);
  return Boolean(targetRef && replicaRef && targetRef === replicaRef);
};

const hasJurisdictionReplica = (env: RuntimeReplica, jurisdiction: JurisdictionConfig): boolean => {
  for (const replica of env.state.jReplicas?.values?.() || []) {
    if (sameImportedJurisdiction(jurisdiction, replica)) return true;
  }
  return false;
};

const hasLiveJurisdictionAdapter = (env: RuntimeReplica, jurisdiction: JurisdictionConfig): boolean => {
  for (const [name, replica] of env.state.jReplicas?.entries?.() || []) {
    if (sameImportedJurisdiction(jurisdiction, replica)) {
      return Boolean(getLiveJAdapter(env, name));
    }
  }
  return false;
};

export const importJurisdictionIfNeeded = async (
  env: RuntimeReplica,
  jurisdiction: JurisdictionConfig,
  rounds = 35,
): Promise<void> => {
  if (hasJurisdictionReplica(env, jurisdiction) && hasLiveJurisdictionAdapter(env, jurisdiction)) return;
  enqueueRuntimeInput(env, {
    runtimeTxs: [
      {
        type: 'importJ',
        data: {
          name: jurisdiction.name,
          chainId: jurisdiction.chainId,
          ticker: 'XLN',
          rpcs: [resolveImportedJurisdictionRpc(jurisdiction)],
          entityProviderDeploymentBlock: jurisdiction.entityProviderDeploymentBlock,
          blockTimeMs: requireJurisdictionBlockTimeMs(jurisdiction),
          contracts: jurisdiction.contracts,
          startAtCurrentBlock: false,
        },
      },
    ],
    entityInputs: [],
  });
  await settleRuntimeFor(env, rounds);
  await waitForJurisdictionAdapter(env, jurisdiction);
};

export const createMarketMakerEntityContext = async (
  env: RuntimeReplica,
  jurisdiction: JurisdictionConfig,
  signerLabel: string,
  profileName: string,
  position: { x: number; y: number; z: number; jurisdiction?: string },
): Promise<MarketMakerEntityContext> => {
  const privateKey = deriveSignerKeySync(resolvedArgs.seed, signerLabel);
  const signerId = deriveSignerAddressSync(resolvedArgs.seed, signerLabel).toLowerCase();
  registerSignerKey(env, signerId, privateKey);
  const entityJurisdiction = toEntityJurisdictionConfig(jurisdiction);
  const consensusConfig = buildMarketMakerConsensusConfig(signerId, entityJurisdiction);
  const entityId = deriveMarketMakerEntityId(signerId, entityJurisdiction);
  if (!getEntityReplicaById(env, entityId)) {
    enqueueRuntimeInput(env, {
      runtimeTxs: [
        {
          type: 'importReplica',
          entityId,
          signerId,
          data: {
            config: consensusConfig,
            isProposer: true,
            profileName,
            position,
          },
        },
      ],
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

export const waitForTokenCatalog = async (jadapter: JAdapter, rounds = 80): Promise<JTokenInfo[]> => {
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
  throw new Error('TOKEN_CATALOG_EMPTY');
};

const findJurisdictionAdapters = (env: RuntimeReplica, jurisdiction: JurisdictionConfig): JAdapter[] =>
  getLiveJAdapterEntries(env)
    .filter(({ name }) => sameImportedJurisdiction(jurisdiction, env.state.jReplicas.get(name)))
    .map(({ adapter }) => adapter);

export const waitForJurisdictionAdapter = async (
  env: RuntimeReplica,
  jurisdiction: JurisdictionConfig,
  rounds = 1200,
): Promise<JAdapter> => {
  for (let i = 0; i < rounds; i += 1) {
    const matches = findJurisdictionAdapters(env, jurisdiction);
    if (matches.length > 1) {
      throw new Error(
        `JURISDICTION_ADAPTER_AMBIGUOUS:${getJurisdictionIdentityRef(jurisdiction) || jurisdiction.name}`,
      );
    }
    if (matches[0]) return matches[0];
    await settleRuntimeFor(env, 5);
    await sleep(50);
  }
  throw new Error(
    `JURISDICTION_ADAPTER_NOT_READY name=${jurisdiction.name} ` +
      `stack=${getJurisdictionIdentityRef(jurisdiction) || 'invalid'} ` +
      `active=${String(env.activeJurisdiction || 'none')} ` +
      `jReplicas=${Array.from(env.state.jReplicas?.keys?.() || []).join(',') || 'none'} ` +
      `runtimeMempool=${Number(env.runtimeMempool?.runtimeTxs?.length || 0)}`,
  );
};

const waitForReplicaReady = async (env: RuntimeReplica, entityId: string, rounds = 200): Promise<void> => {
  const ready = await waitUntil(() => Boolean(getEntityReplicaById(env, entityId)), rounds, BOOTSTRAP_POLL_MS);
  if (!ready) {
    throw new Error(`MM_REPLICA_NOT_READY entityId=${entityId}`);
  }
};

export const ensureJurisdictionReplica = (env: RuntimeReplica, jadapter: JAdapter, rpcUrl: string): void => {
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
  replica.chainId = requireJurisdictionChainId(jadapter.chainId, 'MM_JADAPTER_CHAIN_ID_INVALID');
  attachLiveJAdapter(env, activeName, jadapter);
};

const hubBaseName = (name: string): string =>
  String(name || '')
    .trim()
    .split(/\s+/)[0]
    ?.toLowerCase() || '';
export const hubRoleName = (profile: Pick<HubProfile, 'name' | 'hubName'>): string =>
  hubBaseName(profile.hubName || profile.name);
const readHubRoleName = (profile: { name?: string; metadata?: { hubName?: unknown } }): string => {
  const metadataName = typeof profile.metadata?.hubName === 'string' ? profile.metadata.hubName : '';
  return hubBaseName(metadataName || String(profile.name || ''));
};

const readHubSignerId = (profile: {
  metadata?: { board?: { validators?: Array<{ signerId?: string; signer?: string }> } };
}): string => {
  const validators = profile.metadata?.board?.validators;
  if (!Array.isArray(validators) || validators.length === 0) return '';
  const first = validators[0] || {};
  return String(first.signerId || first.signer || '')
    .trim()
    .toLowerCase();
};

export const readVisibleHubProfiles = (env: RuntimeReplica, includeSiblings = false): HubProfile[] => {
  const required = new Set(resolvedArgs.meshHubNames.map(name => name.toLowerCase()));
  return (env.gossip?.getProfiles?.() || [])
    .filter(
      profile =>
        typeof profile?.name === 'string' && typeof profile?.entityId === 'string' && profile.metadata?.isHub === true,
    )
    .filter(profile => {
      const roleName = readHubRoleName(profile);
      if (required.has(roleName)) return true;
      return includeSiblings && roleName.length > 0;
    })
    .map(profile => ({
      name: String(profile.name || '').trim(),
      hubName: readHubRoleName(profile),
      entityId: String(profile.entityId || '').toLowerCase(),
      signerId: readHubSignerId(profile),
      runtimeId: normalizeRuntimeId(profile.runtimeId || ''),
      jurisdictionName: String(profile.metadata?.jurisdiction?.name || '').trim(),
      chainId: Number(profile.metadata?.jurisdiction?.chainId || 0),
      depositoryAddress: String(profile.metadata?.jurisdiction?.depositoryAddress || '').trim(),
      jurisdictionRef: getJurisdictionStackId({
        chainId: Number(profile.metadata?.jurisdiction?.chainId || 0),
        depositoryAddress: String(profile.metadata?.jurisdiction?.depositoryAddress || '').trim(),
      }),
    }))
    .filter(profile => profile.jurisdictionRef.length > 0)
    .sort(
      (left, right) =>
        compareStableText(hubRoleName(left), hubRoleName(right)) ||
        Number(left.chainId || 0) - Number(right.chainId || 0) ||
        compareStableText(left.entityId, right.entityId),
    );
};

const getMarketMakerLevelProfile = (
  baseTokenId: number,
  quoteTokenId: number,
): {
  offsetsBps: readonly number[];
  baseSizes: readonly bigint[];
} => {
  if (isLiquidSwapToken(baseTokenId) && isLiquidSwapToken(quoteTokenId)) {
    return {
      offsetsBps: MARKET_MAKER_STABLE_LEVEL_OFFSETS_BPS,
      baseSizes: MARKET_MAKER_STABLE_LEVEL_BASE_SIZES.map(amount => scaleDefaultAmountForToken(baseTokenId, amount)),
    };
  }
  return {
    offsetsBps: MARKET_MAKER_LEVEL_OFFSETS_BPS,
    baseSizes: MARKET_MAKER_LEVEL_BASE_SIZES.map(amount => scaleDefaultAmountForToken(baseTokenId, amount)),
  };
};

export const normalizePositiveTokenIds = (tokenIds: readonly number[]): number[] =>
  Array.from(
    new Set(tokenIds.filter(tokenId => Number.isFinite(tokenId) && tokenId > 0).map(tokenId => Math.floor(tokenId))),
  ).sort((a, b) => a - b);

export const buildMarketMakerCrossTokenPairs = (
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
  return pairs.slice(0, MARKET_MAKER_CROSS_MAX_TOKEN_PAIRS_PER_ROUTE);
};

const invertPriceTicks = (ticks: bigint): bigint => {
  if (ticks <= 0n) return 0n;
  return (ORDERBOOK_PRICE_SCALE * ORDERBOOK_PRICE_SCALE) / ticks;
};

const ceilDiv = (numerator: bigint, denominator: bigint): bigint => {
  if (denominator <= 0n) throw new Error('ceilDiv denominator must be positive');
  return (numerator + denominator - 1n) / denominator;
};

const alignUpToLot = (baseTokenId: number, amount: bigint): bigint => {
  if (amount <= 0n) return 0n;
  const lotScale = getSwapLotScale(baseTokenId);
  return ceilDiv(amount, lotScale) * lotScale;
};

const minBaseAmountForQuoteNotional = (baseTokenId: number, quoteTokenId: number, priceTicks: bigint): bigint => {
  if (priceTicks <= 0n) return 0n;
  return alignUpToLot(
    baseTokenId,
    baseAmountAtPriceCeil(baseTokenId, quoteTokenId, minimumTradeAmount(quoteTokenId), priceTicks),
  );
};

const withMinQuoteNotionalBaseSize = (
  baseTokenId: number,
  quoteTokenId: number,
  baseSize: bigint,
  priceTicks: bigint,
): bigint => {
  const minBaseSize = minBaseAmountForQuoteNotional(baseTokenId, quoteTokenId, priceTicks);
  const desiredBaseSize = baseSize >= minBaseSize ? baseSize : minBaseSize;
  const maxBaseAmount = orderbookMaxBaseAmount(baseTokenId);
  return desiredBaseSize <= maxBaseAmount ? desiredBaseSize : maxBaseAmount;
};

const withCrossMinQuoteNotionalSourceAmount = (
  sourceTokenId: number,
  baseTokenId: number,
  quoteTokenId: number,
  desiredBaseAmount: bigint,
  sourceIsBase: boolean,
  priceTicks: bigint,
): bigint => {
  const baseAmount = withMinQuoteNotionalBaseSize(baseTokenId, quoteTokenId, desiredBaseAmount, priceTicks);
  if (sourceIsBase) {
    return baseAmount;
  }
  const quoteAmount = quoteAmountAtPrice(baseTokenId, quoteTokenId, baseAmount, priceTicks);
  const minimumSourceAmount = minimumTradeAmount(sourceTokenId);
  return quoteAmount >= minimumSourceAmount ? quoteAmount : minimumSourceAmount;
};

const getCrossSourceToTargetMidTicks = (sourceTokenId: number, targetTokenId: number): bigint => {
  if (sourceTokenId === targetTokenId) return ORDERBOOK_PRICE_SCALE;
  const oriented = getSwapPairOrientation(sourceTokenId, targetTokenId);
  const policy = getSwapPairPolicyByBaseQuote(oriented.baseTokenId, oriented.quoteTokenId);
  return sourceTokenId === oriented.baseTokenId ? policy.mmMidPriceTicks : invertPriceTicks(policy.mmMidPriceTicks);
};

const computeCrossTargetAmount = (
  baseTokenId: number,
  quoteTokenId: number,
  sourceAmount: bigint,
  sourceIsBase: boolean,
  priceTicks: bigint,
): bigint => {
  if (sourceAmount <= 0n || priceTicks <= 0n) return 0n;
  return sourceIsBase
    ? quoteAmountAtPrice(baseTokenId, quoteTokenId, sourceAmount, priceTicks)
    : baseAmountAtPrice(baseTokenId, quoteTokenId, sourceAmount, priceTicks);
};

const computeCrossOrderbookPriceTicks = (
  sourceIsBase: boolean,
  baseTokenId: number,
  quoteTokenId: number,
  baseAmount: bigint,
  quoteAmount: bigint,
): bigint => computePriceTicksForBaseQuote(sourceIsBase ? 1 : 0, baseTokenId, quoteTokenId, baseAmount, quoteAmount);

const snapPriceTicks = (ticks: bigint, stepTicks: number, mode: 'up' | 'down'): bigint => {
  const step = BigInt(Math.max(1, stepTicks));
  if (mode === 'up') return ((ticks + step - 1n) / step) * step;
  return (ticks / step) * step;
};

export const fitCrossAmountsToOrderbook = (
  sourceJurisdiction: string,
  sourceTokenId: number,
  sourceAmount: bigint,
  targetJurisdiction: string,
  targetTokenId: number,
  targetAmount: bigint,
  priceTicks: bigint,
): { sourceAmount: bigint; targetAmount: bigint; priceTicks: bigint } | null => {
  if (sourceAmount <= 0n || targetAmount <= 0n || priceTicks <= 0n) return null;
  const market = deriveCanonicalCrossJurisdictionMarketForLegs(
    sourceJurisdiction,
    sourceTokenId,
    targetJurisdiction,
    targetTokenId,
  );
  const oriented =
    sourceTokenId === targetTokenId
      ? { baseTokenId: sourceTokenId, quoteTokenId: targetTokenId }
      : getSwapPairOrientation(sourceTokenId, targetTokenId);
  const requestedBaseAmount = market.sourceIsBase ? sourceAmount : targetAmount;
  const maxBaseAmount = orderbookMaxBaseAmount(oriented.baseTokenId);
  const cappedBaseAmount = requestedBaseAmount <= maxBaseAmount ? requestedBaseAmount : maxBaseAmount;
  const lotScale = getSwapLotScale(oriented.baseTokenId);
  const quantizedBaseAmount = (cappedBaseAmount / lotScale) * lotScale;
  if (quantizedBaseAmount <= 0n) return null;

  const requestedQuoteAmount = quoteAmountAtPrice(
    oriented.baseTokenId,
    oriented.quoteTokenId,
    quantizedBaseAmount,
    priceTicks,
  );
  if (requestedQuoteAmount <= 0n) return null;
  const effectivePriceTicks = computeCrossOrderbookPriceTicks(
    market.sourceIsBase,
    oriented.baseTokenId,
    oriented.quoteTokenId,
    quantizedBaseAmount,
    requestedQuoteAmount,
  );
  if (effectivePriceTicks <= 0n) return null;
  // The raw amounts are authoritative. Re-encoding the already-rounded price
  // into a second quote amount can cross a one-tick boundary for mixed-decimal
  // pairs. Keep the original quote and publish the price derived from those
  // exact bytes; Account then recomputes the identical tick one-for-one.
  const effectiveQuoteAmount = requestedQuoteAmount;
  return market.sourceIsBase
    ? { sourceAmount: quantizedBaseAmount, targetAmount: effectiveQuoteAmount, priceTicks: effectivePriceTicks }
    : { sourceAmount: effectiveQuoteAmount, targetAmount: quantizedBaseAmount, priceTicks: effectivePriceTicks };
};

const isWithinPairBand = (anchorTicks: bigint, priceTicks: bigint): boolean => {
  if (anchorTicks <= 0n || priceTicks <= 0n) return false;
  const rejectDelta = (anchorTicks * BigInt(SWAP_CONSTANTS.PRICE_REJECT_BPS)) / BigInt(SWAP_CONSTANTS.BPS_BASE);
  const minAllowed = anchorTicks - rejectDelta;
  const maxAllowed = anchorTicks + rejectDelta;
  return priceTicks >= minAllowed && priceTicks <= maxAllowed;
};

const selectMarketMakerBootstrapTokenIds = (tokenIds: readonly number[]): number[] => {
  const unique = normalizePositiveTokenIds([...tokenIds]);
  if (unique.length >= HUB_REQUIRED_TOKEN_COUNT) {
    return unique;
  }
  return [...DEFAULT_ACCOUNT_TOKEN_IDS];
};

const normalizeTokenIdsForMm = (tokenCatalog: JTokenInfo[]): number[] =>
  selectMarketMakerBootstrapTokenIds(tokenCatalog.map(token => Number(token.tokenId)));

export const marketMakerContextKey = (context: Pick<MarketMakerEntityContext, 'entityId'>): string =>
  normalizeEntityRef(context.entityId);

export const buildMarketMakerTokenIdsByContext = (
  tokenCatalog: JTokenInfo[],
  contexts: MarketMakerEntityContext[],
): Map<string, number[]> => {
  const catalogTokenIds = normalizeTokenIdsForMm(tokenCatalog);
  const fallback =
    catalogTokenIds.length >= HUB_REQUIRED_TOKEN_COUNT ? catalogTokenIds : [...DEFAULT_ACCOUNT_TOKEN_IDS];
  const byContext = new Map<string, number[]>();
  for (const context of contexts) {
    const jurisdictionTokenIds = normalizePositiveTokenIds(
      getTokenIdsForJurisdiction({
        name: context.jurisdictionName,
        chainId: context.chainId,
      }),
    );
    byContext.set(
      marketMakerContextKey(context),
      jurisdictionTokenIds.length >= HUB_REQUIRED_TOKEN_COUNT
        ? selectMarketMakerBootstrapTokenIds(jurisdictionTokenIds)
        : fallback,
    );
  }
  return byContext;
};

export const getMarketMakerTokenIds = (
  tokenIdsByContext: MarketMakerTokenIdsByContext,
  context: MarketMakerEntityContext,
  fallback: number[] = [...DEFAULT_ACCOUNT_TOKEN_IDS],
): number[] => {
  const ids = tokenIdsByContext.get(marketMakerContextKey(context));
  return ids && ids.length >= HUB_REQUIRED_TOKEN_COUNT ? ids : fallback;
};

export const collectOfferIdsForAccount = (
  account: Pick<AccountReplica, 'swapOffers' | 'mempool' | 'pendingFrame'> | null | undefined,
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

const collectCommittedOfferIdsForAccount = (
  account: Pick<AccountReplica, 'swapOffers'> | null | undefined,
): Set<string> => {
  const ids = new Set<string>();
  if (account?.swapOffers instanceof Map) {
    for (const offerId of account.swapOffers.keys()) ids.add(String(offerId));
  }
  return ids;
};

export const getMarketMakerOfferLevel = (spec: Pick<MarketMakerOfferSpec, 'offerId'>): number => {
  const match = String(spec.offerId || '').match(/-(?:ask|bid|sell)-(\d+)$/);
  const level = match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
  return Number.isFinite(level) && level > 0 ? Math.floor(level) : Number.MAX_SAFE_INTEGER;
};

const selectByteBudgetedCrossSpecs = (specs: readonly MarketMakerOfferSpec[]): MarketMakerOfferSpec[] => {
  const routes = specs
    .map(spec => spec.crossJurisdiction)
    .filter((route): route is CrossJurisdictionSwapRoute => Boolean(route));
  if (routes.length === 0) return [];
  const ordered = [...specs].sort(
    (left, right) =>
      getMarketMakerOfferLevel(left) - getMarketMakerOfferLevel(right) ||
      compareStableText(left.pairId, right.pairId) ||
      compareStableText(left.offerId, right.offerId),
  );
  const sourceTokens = routes.map(route => route.source.tokenId);
  const targetTokens = routes.map(route => route.target.tokenId);
  const minSource = Math.min(...sourceTokens);
  const maxSource = Math.max(...sourceTokens);
  const minTarget = Math.min(...targetTokens);
  const maxTarget = Math.max(...targetTokens);
  const selected: MarketMakerOfferSpec[] = [];
  const take = (matches: (route: CrossJurisdictionSwapRoute) => boolean): void => {
    const spec = ordered.find(candidate => {
      const route = candidate.crossJurisdiction;
      return !selected.includes(candidate) && Boolean(route && matches(route));
    });
    if (spec) selected.push(spec);
  };
  take(route => route.source.tokenId === minSource && route.target.tokenId === minTarget);
  take(route => route.source.tokenId === maxSource);
  take(route => route.target.tokenId === maxTarget);
  for (const spec of ordered) {
    if (selected.length >= LIMITS.MAX_ACCOUNT_CROSS_J_SWAP_OFFERS) break;
    if (!selected.includes(spec)) selected.push(spec);
  }
  return selected.slice(0, LIMITS.MAX_ACCOUNT_CROSS_J_SWAP_OFFERS);
};

export const buildMarketMakerOfferSpecs = (hubEntityIds: string[], tokenIds: number[]): MarketMakerOfferSpec[] => {
  const specs: MarketMakerOfferSpec[] = [];
  const defaultPairs = buildDefaultEntitySwapPairs(tokenIds);
  for (const hubEntityId of hubEntityIds) {
    const hubSuffix = hubEntityId.slice(-6).toLowerCase();
    const pairContexts = defaultPairs.map(pair => {
      const pairPolicy = getSwapPairPolicyByBaseQuote(pair.baseTokenId, pair.quoteTokenId);
      const levelProfile = getMarketMakerLevelProfile(pair.baseTokenId, pair.quoteTokenId);
      const skewBps = 0;
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
      Math.floor(LIMITS.MAX_ACCOUNT_SAME_J_SWAP_OFFERS / Math.max(1, pairContexts.length * 2)),
    );
    const maxLevels = Math.min(
      MARKET_MAKER_LEVELS_PER_SIDE,
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
        const askBaseSize = withMinQuoteNotionalBaseSize(
          entry.pair.baseTokenId,
          entry.pair.quoteTokenId,
          baseSize,
          askPriceTicks,
        );
        const bidBaseSize = withMinQuoteNotionalBaseSize(
          entry.pair.baseTokenId,
          entry.pair.quoteTokenId,
          baseSize,
          bidPriceTicks,
        );
        const askWantAmount = quoteAmountAtPrice(
          entry.pair.baseTokenId,
          entry.pair.quoteTokenId,
          askBaseSize,
          askPriceTicks,
        );
        const bidGiveAmount = quoteAmountAtPrice(
          entry.pair.baseTokenId,
          entry.pair.quoteTokenId,
          bidBaseSize,
          bidPriceTicks,
        );
        const levelId = level + 1;

        if (askWantAmount > 0n) {
          specs.push({
            offerId: `mm-${hubSuffix}-${entry.pair.baseTokenId}-${entry.pair.quoteTokenId}-ask-${levelId}`,
            pairId: entry.pair.pairId,
            hubEntityId,
            giveTokenId: entry.pair.baseTokenId,
            giveAmount: askBaseSize,
            wantTokenId: entry.pair.quoteTokenId,
            wantAmount: askWantAmount,
            priceTicks: askPriceTicks,
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
            wantAmount: bidBaseSize,
            priceTicks: bidPriceTicks,
          });
        }
      }
    }
  }
  return specs;
};

export const sameJurisdiction = (
  left: Pick<MarketMakerEntityContext | HubProfile, 'jurisdictionName' | 'chainId' | 'jurisdictionRef'>,
  right: Pick<MarketMakerEntityContext | HubProfile, 'jurisdictionName' | 'chainId' | 'jurisdictionRef'>,
): boolean => {
  return Boolean(left.jurisdictionRef && right.jurisdictionRef && left.jurisdictionRef === right.jurisdictionRef);
};

export const normalizeEntityRef = (value: string): string =>
  String(value || '')
    .trim()
    .toLowerCase();

type MarketMakerEntityTx = NonNullable<EntityInput['entityTxs']>[number];

const pushMarketMakerEntityTx = (
  inputsByEntitySigner: Map<string, EntityInput>,
  entityId: string,
  signerId: string,
  tx: MarketMakerEntityTx,
): void => {
  const key = `${normalizeEntityRef(entityId)}:${normalizeEntityRef(signerId)}`;
  const input = inputsByEntitySigner.get(key) ?? {
    entityId,
    signerId,
    entityTxs: [],
  };
  const entityTxs = input.entityTxs ?? (input.entityTxs = []);
  entityTxs.push(tx);
  inputsByEntitySigner.set(key, input);
};

const resolveEntityRuntimeIdForCrossJ = (
  env: RuntimeReplica,
  entityId: string,
): string | null => {
  const target = normalizeEntityRef(entityId);
  const localRuntimeId = String(env.runtimeId || '')
    .trim()
    .toLowerCase();
  if (localRuntimeId && getEntityReplicaById(env, target)) return localRuntimeId;
  const profile = (env.gossip?.getProfiles?.() || []).find(item => normalizeEntityRef(item.entityId) === target);
  const runtimeId = String(profile?.runtimeId || '')
    .trim()
    .toLowerCase();
  if (runtimeId) return runtimeId;
  return null;
};

const isCrossJurisdictionRouteTwoRuntime = (env: RuntimeReplica, route: CrossJurisdictionSwapRoute): boolean => {
  const canonical = withCanonicalCrossJurisdictionRouteHash(route);
  return Boolean(
    resolveCrossJurisdictionRuntimeTopology(canonical, entityId =>
      resolveEntityRuntimeIdForCrossJ(env, entityId),
    ),
  );
};

const canonicalizeLocalCrossJurisdictionRoute = (
  env: RuntimeReplica,
  route: CrossJurisdictionSwapRoute,
): CrossJurisdictionSwapRoute | null => {
  const canonical = withCanonicalCrossJurisdictionRouteHash(route);
  return isCrossJurisdictionRouteTwoRuntime(env, canonical) ? canonical : null;
};

const requireMarketMakerQuoteTimestamp = (env: RuntimeReplica): number => {
  const timestamp = Math.floor(Number(env.state.timestamp));
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    throw new Error(`MARKET_MAKER_CROSS_TIMESTAMP_INVALID:${String(env.state.timestamp)}`);
  }
  return timestamp;
};

export const buildMarketMakerCrossOfferSpecs = (
  env: RuntimeReplica,
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
  const targetByBaseName = new Map(targetHubs.map(hub => [hubRoleName(hub), hub] as const));
  const now = requireMarketMakerQuoteTimestamp(env);

  for (const sourceHub of sourceHubs) {
    const targetHub = targetByBaseName.get(hubRoleName(sourceHub));
    if (!targetHub || sameJurisdiction(sourceHub, targetHub)) continue;
    const sourceHubSuffix = sourceHub.entityId.slice(-6).toLowerCase();
    const targetHubSuffix = targetHub.entityId.slice(-6).toLowerCase();

    const hubSpecStart = specs.length;
    for (const pair of crossPairs) {
      const market = deriveCanonicalCrossJurisdictionMarketForLegs(
        sourceJurisdictionRef,
        pair.sourceTokenId,
        targetJurisdictionRef,
        pair.targetTokenId,
      );
      const sourceToTargetMidTicks = getCrossSourceToTargetMidTicks(pair.sourceTokenId, pair.targetTokenId);
      const canonicalMidTicks = market.sourceIsBase ? sourceToTargetMidTicks : invertPriceTicks(sourceToTargetMidTicks);
      const oriented =
        pair.sourceTokenId === pair.targetTokenId
          ? { baseTokenId: pair.sourceTokenId, quoteTokenId: pair.targetTokenId }
          : getSwapPairOrientation(pair.sourceTokenId, pair.targetTokenId);
      const pairPolicy = getSwapPairPolicyByBaseQuote(oriented.baseTokenId, oriented.quoteTokenId);
      const levelProfile = getMarketMakerLevelProfile(oriented.baseTokenId, oriented.quoteTokenId);
      const levelCount = Math.min(MARKET_MAKER_LEVELS_PER_SIDE, levelProfile.offsetsBps.length);

      for (let level = 0; level < levelCount; level += 1) {
        const offsetBps = levelProfile.offsetsBps[level]!;
        const rawPriceTicks = market.sourceIsBase
          ? (canonicalMidTicks * BigInt(10_000 + offsetBps)) / 10_000n
          : (canonicalMidTicks * BigInt(Math.max(1, 10_000 - offsetBps))) / 10_000n;
        const priceTicks = snapPriceTicks(
          rawPriceTicks,
          pairPolicy.priceStepTicks,
          market.sourceIsBase ? 'up' : 'down',
        );
        if (!isWithinPairBand(canonicalMidTicks, priceTicks)) continue;
        const sourceAmount = withCrossMinQuoteNotionalSourceAmount(
          pair.sourceTokenId,
          oriented.baseTokenId,
          oriented.quoteTokenId,
          levelProfile.baseSizes[level]!,
          market.sourceIsBase,
          priceTicks,
        );
        const targetAmount = computeCrossTargetAmount(
          oriented.baseTokenId,
          oriented.quoteTokenId,
          sourceAmount,
          market.sourceIsBase,
          priceTicks,
        );
        const levelId = level + 1;
        const bookOwnerEntityId = deriveCanonicalCrossJurisdictionBookOwnerForLegs(
          sourceJurisdictionRef,
          sourceHub.entityId,
          targetJurisdictionRef,
          targetHub.entityId,
        );
        const bookHubSignerId =
          normalizeEntityRef(bookOwnerEntityId) === normalizeEntityRef(sourceHub.entityId)
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
          const quoteAmount = market.sourceIsBase ? amounts.targetAmount : amounts.sourceAmount;
          if (quoteAmount < minimumTradeAmount(oriented.quoteTokenId)) continue;
          if (!isWithinPairBand(canonicalMidTicks, amounts.priceTicks)) continue;
          const offerId = `mmx-${sourceHubSuffix}-${targetHubSuffix}-${pair.sourceTokenId}-${pair.targetTokenId}-sell-${levelId}`;
          const route = canonicalizeLocalCrossJurisdictionRoute(env, {
            ...routeBase,
            orderId: offerId,
            priceTicks: amounts.priceTicks,
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
            priceTicks: amounts.priceTicks,
            crossJurisdiction: route,
          });
        }
      }
    }
    const hubSpecs = specs.splice(hubSpecStart);
    specs.push(...selectByteBudgetedCrossSpecs(hubSpecs));
  }

  return specs;
};

export const countCommittedMarketMakerOffersForHubPair = (
  env: RuntimeReplica,
  mmEntityId: string,
  hubEntityId: string,
  pair: { baseTokenId: number; quoteTokenId: number },
): number => {
  const account = getAccountState(env, mmEntityId, hubEntityId);
  if (!account) return 0;
  const prefix = `mm-${hubEntityId.slice(-6).toLowerCase()}-${pair.baseTokenId}-${pair.quoteTokenId}-`;
  let count = 0;
  for (const offerId of collectCommittedOfferIdsForAccount(account)) {
    if (offerId.startsWith(prefix)) count += 1;
  }
  return count;
};

const countMarketMakerOffersForHub = (env: RuntimeReplica, mmEntityId: string, hubEntityId: string): number => {
  const account = getAccountState(env, mmEntityId, hubEntityId);
  if (!account) return 0;
  const prefix = `mm-${hubEntityId.slice(-6).toLowerCase()}-`;
  let count = 0;
  for (const offerId of collectOfferIdsForAccount(account)) {
    if (offerId.startsWith(prefix)) count += 1;
  }
  return count;
};

export const countCommittedMarketMakerOffersForHub = (
  env: RuntimeReplica,
  mmEntityId: string,
  hubEntityId: string,
): number => {
  const account = getAccountState(env, mmEntityId, hubEntityId);
  if (!account) return 0;
  const prefix = `mm-${hubEntityId.slice(-6).toLowerCase()}-`;
  let count = 0;
  for (const offerId of collectCommittedOfferIdsForAccount(account)) {
    if (offerId.startsWith(prefix)) count += 1;
  }
  return count;
};

export const isSameQuoteJobDepthReady = (env: RuntimeReplica, job: SameQuoteJob): boolean => {
  const account = getAccountState(env, job.context.entityId, job.hub.entityId);
  if (!hasCommittedAccountState(account)) return false;
  const specs = buildMarketMakerOfferSpecs([job.hub.entityId], job.tokenIds);
  if (specs.length === 0) return true;
  const expectedByPair = new Map<string, number>();
  for (const spec of specs) {
    expectedByPair.set(spec.pairId, (expectedByPair.get(spec.pairId) || 0) + 1);
  }
  return buildDefaultEntitySwapPairs(job.tokenIds).every(pair => {
    const expected = expectedByPair.get(pair.pairId) || 0;
    return (
      expected > 0 &&
      countCommittedMarketMakerOffersForHubPair(env, job.context.entityId, job.hub.entityId, pair) === expected
    );
  });
};

type PendingCrossRequestReader = (entityId: string) => Set<string>;

export const hasCrossSpecBootstrapProgress = (
  env: RuntimeReplica,
  spec: MarketMakerOfferSpec,
  getPendingCrossRequestOrderIds: PendingCrossRequestReader,
): boolean => {
  const route = spec.crossJurisdiction;
  if (!route) return false;
  if (hasSourceAccountCrossOffer(env, route)) return true;
  if (hasCrossRouteRegistered(env, route.source.entityId, route.orderId)) return true;
  if (hasCrossRouteRegistered(env, route.source.counterpartyEntityId, route.orderId)) return true;
  return getPendingCrossRequestOrderIds(route.source.entityId).has(route.orderId);
};

export const countCrossSpecBootstrapProgress = (
  env: RuntimeReplica,
  specs: MarketMakerOfferSpec[],
  getPendingCrossRequestOrderIds: PendingCrossRequestReader,
): number => {
  let count = 0;
  for (const spec of specs) {
    if (hasCrossSpecBootstrapProgress(env, spec, getPendingCrossRequestOrderIds)) count += 1;
  }
  return count;
};

export const countCrossSpecBootstrapProgressByPair = (
  env: RuntimeReplica,
  specs: MarketMakerOfferSpec[],
  getPendingCrossRequestOrderIds: PendingCrossRequestReader,
): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const spec of specs) {
    if (!hasCrossSpecBootstrapProgress(env, spec, getPendingCrossRequestOrderIds)) continue;
    counts.set(spec.pairId, (counts.get(spec.pairId) || 0) + 1);
  }
  return counts;
};

export const countCrossSpecVisibleOffersByPair = (
  env: RuntimeReplica,
  specs: MarketMakerOfferSpec[],
): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const spec of specs) {
    if (!spec.crossJurisdiction || !hasMarketMakerCrossOffer(env, spec)) continue;
    counts.set(spec.pairId, (counts.get(spec.pairId) || 0) + 1);
  }
  return counts;
};

const countFinalizedCrossOffersByPair = (env: RuntimeReplica, specs: MarketMakerOfferSpec[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const spec of specs) {
    if (!spec.crossJurisdiction || !hasFinalizedMarketMakerCrossOffer(env, spec)) continue;
    counts.set(spec.pairId, (counts.get(spec.pairId) || 0) + 1);
  }
  return counts;
};

const crossSpecPairIds = (specs: MarketMakerOfferSpec[]): string[] =>
  Array.from(new Set(specs.map(spec => spec.pairId).filter(Boolean))).sort(compareStableText);

export const countCrossPairCoverageGaps = (env: RuntimeReplica, specs: MarketMakerOfferSpec[]): number => {
  const finalizedByPair = countFinalizedCrossOffersByPair(env, specs);
  return crossSpecPairIds(specs).filter(pairId => (finalizedByPair.get(pairId) || 0) === 0).length;
};

export const ensureMarketMakerHubConnectivity = async (
  env: RuntimeReplica,
  mmEntityId: string,
  mmSignerId: string,
  hubEntityIds: string[],
  tokenIds: number[],
  budget: MarketMakerConnectivityBudget,
): Promise<boolean> => {
  const localCreditInputsByEntity = new Map<string, EntityInput>();
  const deriveMarketMakerAccountWatchSeed = (counterpartyId: string): string =>
    deriveAccountWatchSeed({
      runtimeSeed: env.runtimeSeed ?? '',
      runtimeId: env.runtimeId ?? null,
      entityId: mmEntityId,
      counterpartyId,
      timestamp: 0,
    });
  const pushLocalConnectivityTx = (
    entityId: string,
    signerId: string,
    tx: NonNullable<EntityInput['entityTxs']>[number],
  ): boolean => {
    if (budget.remainingTxs <= 0) return false;
    pushMarketMakerEntityTx(localCreditInputsByEntity, entityId, signerId, tx);
    budget.remainingTxs = Math.max(0, budget.remainingTxs - 1);
    return true;
  };

  collectOpenAccountInputs: for (const hubEntityId of hubEntityIds) {
    const mmAccount = getAccountState(env, mmEntityId, hubEntityId);
    const hasPendingConsensus = Boolean(mmAccount?.pendingFrame) || Number(mmAccount?.mempool?.length || 0) > 0;
    if (
      !mmAccount &&
      !hasPendingConsensus &&
      isCanonicalAccountOpener(mmEntityId, hubEntityId) &&
      !hasQueuedOpenAccount(env, mmEntityId, hubEntityId)
    ) {
      const [openTokenId = 1, ...extraCreditTokenIds] = normalizePositiveTokenIds(tokenIds);
      const connectivityTxs: NonNullable<EntityInput['entityTxs']> = [
        {
          type: 'openAccount' as const,
          data: {
            targetEntityId: hubEntityId,
            watchSeed: deriveMarketMakerAccountWatchSeed(hubEntityId),
            tokenId: openTokenId,
            creditAmount: getBootstrapCreditAmount(openTokenId),
          },
        },
        ...extraCreditTokenIds.map(tokenId => ({
          type: 'extendCredit' as const,
          data: {
            counterpartyEntityId: hubEntityId,
            tokenId,
            amount: getBootstrapCreditAmount(tokenId),
          },
        })),
      ];
      for (const tx of connectivityTxs) {
        if (!pushLocalConnectivityTx(mmEntityId, mmSignerId, tx)) {
          break collectOpenAccountInputs;
        }
      }
    }
  }

  collectCreditInputs: for (const hubEntityId of hubEntityIds) {
    const mmAccount = getAccountState(env, mmEntityId, hubEntityId);
    const hasPendingConsensus = Boolean(mmAccount?.pendingFrame) || Number(mmAccount?.mempool?.length || 0) > 0;
    if (hasPendingConsensus) continue;
    if (!mmAccount) continue;

    for (const tokenId of tokenIds) {
      const creditAmount = getBootstrapCreditAmount(tokenId);
      if (hasPairMutualCredit(env, mmEntityId, hubEntityId, tokenId, creditAmount)) continue;
      if (hasQueuedExtendCredit(env, mmEntityId, hubEntityId, tokenId, creditAmount)) continue;
      const hubOutCapacity = getEntityOutCapacity(mmAccount, hubEntityId, tokenId);

      if (hubOutCapacity < creditAmount) {
        if (
          !pushLocalConnectivityTx(mmEntityId, mmSignerId, {
            type: 'extendCredit',
            data: {
              counterpartyEntityId: hubEntityId,
              tokenId,
              amount: creditAmount,
            },
          })
        ) {
          break collectCreditInputs;
        }
      }
    }
  }

  const localCreditInputs = Array.from(localCreditInputsByEntity.values());
  if (localCreditInputs.length > 0) {
    enqueueRuntimeInput(env, { runtimeTxs: [], entityInputs: localCreditInputs });
    await yieldMarketMakerApi();
    return true;
  }
  return false;
};

const isMarketMakerConnectivityReady = (
  env: RuntimeReplica,
  mmEntityId: string,
  hubEntityIds: string[],
  tokenIds: number[],
): boolean =>
  hubEntityIds.every(hubEntityId => {
    const account = getAccountState(env, mmEntityId, hubEntityId);
    if (!hasCommittedAccountState(account)) return false;
    return tokenIds.every(tokenId =>
      hasPairMutualCredit(env, mmEntityId, hubEntityId, tokenId, getBootstrapCreditAmount(tokenId)),
    );
  });

export const maintainMarketMakerQuotes = async (
  env: RuntimeReplica,
  mmEntityId: string,
  mmSignerId: string,
  hubEntityIds: string[],
  tokenIds: number[],
  maxOffersPerAccount = MARKET_MAKER_OFFERS_PER_ACCOUNT_PER_TICK,
  maxNewOffersTotal = MARKET_MAKER_MAX_NEW_OFFERS_PER_TICK,
  connectivityBudget: MarketMakerConnectivityBudget = { remainingTxs: MARKET_MAKER_CONNECTIVITY_MAX_TXS_PER_TICK },
  shouldContinue: () => boolean = () => true,
): Promise<boolean> => {
  if (hubEntityIds.length === 0 || tokenIds.length < 3) return false;
  if (!shouldContinue()) return false;
  if (await ensureMarketMakerHubConnectivity(env, mmEntityId, mmSignerId, hubEntityIds, tokenIds, connectivityBudget))
    return true;
  if (!shouldContinue()) return false;
  const quoteReadyHubEntityIds = hubEntityIds.filter(hubEntityId =>
    isMarketMakerConnectivityReady(env, mmEntityId, [hubEntityId], tokenIds),
  );
  if (quoteReadyHubEntityIds.length === 0) {
    return false;
  }
  const desiredOffers = buildMarketMakerOfferSpecs(quoteReadyHubEntityIds, tokenIds);
  const grouped = new Map<string, MarketMakerOfferSpec[]>();
  for (const spec of desiredOffers) {
    const arr = grouped.get(spec.hubEntityId) ?? [];
    arr.push(spec);
    grouped.set(spec.hubEntityId, arr);
  }

  const entityInputsByEntitySigner = new Map<string, EntityInput>();
  let remainingNewOffers = Math.max(1, Math.floor(maxNewOffersTotal));
  const groupedEntries = Array.from(grouped.entries()).sort(
    (left, right) =>
      countMarketMakerOffersForHub(env, mmEntityId, left[0]) -
        countMarketMakerOffersForHub(env, mmEntityId, right[0]) || compareStableText(left[0], right[0]),
  );

  for (const [hubEntityId, specs] of groupedEntries) {
    await yieldMarketMakerApi();
    if (!shouldContinue()) return false;
    if (remainingNewOffers <= 0) break;
    const account = getAccountState(env, mmEntityId, hubEntityId);
    if (!account) continue;
    if (String(account.status || 'active') !== 'active') continue;
    if (!isAccountConsensusReady(account)) continue;

    const existingOfferIds = collectOfferIdsForAccount(account);
    for (const offerId of collectQueuedSwapOfferIds(env, mmEntityId, hubEntityId)) {
      existingOfferIds.add(offerId);
    }
    const remainingOpenSlots = Math.max(0, LIMITS.MAX_ACCOUNT_SWAP_OFFERS - existingOfferIds.size);
    const allowedNewOffers = Math.min(
      Math.max(1, Math.floor(maxOffersPerAccount)),
      remainingOpenSlots,
      remainingNewOffers,
    );
    if (allowedNewOffers <= 0) continue;
    const missing = specs
      .filter(spec => !existingOfferIds.has(spec.offerId))
      .filter(
        spec =>
          hasPairMutualCredit(env, mmEntityId, hubEntityId, spec.giveTokenId, spec.giveAmount) &&
          hasPairMutualCredit(env, mmEntityId, hubEntityId, spec.wantTokenId, spec.wantAmount),
      )
      .slice(0, allowedNewOffers);
    if (missing.length === 0) continue;
    for (const spec of missing) {
      pushMarketMakerEntityTx(entityInputsByEntitySigner, mmEntityId, mmSignerId, {
        type: 'placeSwapOffer' as const,
        data: {
          counterpartyEntityId: spec.hubEntityId,
          offerId: spec.offerId,
          giveTokenId: spec.giveTokenId,
          giveAmount: spec.giveAmount,
          wantTokenId: spec.wantTokenId,
          wantAmount: spec.wantAmount,
          priceTicks: spec.priceTicks,
        },
      });
    }
    remainingNewOffers -= missing.length;
  }

  const entityInputs = Array.from(entityInputsByEntitySigner.values());
  if (entityInputs.length > 0) {
    if (!shouldContinue()) return false;
    enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs,
    });
    await yieldMarketMakerApi();
    return true;
  }
  return false;
};

export const hasCrossRouteRegistered = (env: RuntimeReplica, entityId: string, orderId: string): boolean => {
  const replica = getEntityReplicaById(env, entityId);
  return Boolean(replica?.state?.crossJurisdictionSwaps?.has(orderId));
};

const isMatchingCrossOfferRoute = (
  candidate: CrossJurisdictionSwapRoute | null | undefined,
  expected: CrossJurisdictionSwapRoute,
): boolean => {
  if (!candidate) return false;
  const candidatePriceTicks = candidate.priceTicks === undefined ? null : BigInt(candidate.priceTicks);
  const expectedPriceTicks = expected.priceTicks === undefined ? null : BigInt(expected.priceTicks);
  // routeHash includes the runtime expiry window; regenerated MM specs can roll
  // that window forward. Readiness binds to route identity and economics here.
  return (
    String(candidate.orderId || '') === String(expected.orderId || '') &&
    normalizeEntityRef(candidate.makerEntityId) === normalizeEntityRef(expected.makerEntityId) &&
    normalizeEntityRef(candidate.hubEntityId) === normalizeEntityRef(expected.hubEntityId) &&
    normalizeEntityRef(candidate.bookOwnerEntityId || '') === normalizeEntityRef(expected.bookOwnerEntityId || '') &&
    String(candidate.venueId || '') === String(expected.venueId || '') &&
    normalizeEntityRef(candidate.source.entityId) === normalizeEntityRef(expected.source.entityId) &&
    normalizeEntityRef(candidate.source.counterpartyEntityId) ===
      normalizeEntityRef(expected.source.counterpartyEntityId) &&
    normalizeEntityRef(candidate.target.entityId) === normalizeEntityRef(expected.target.entityId) &&
    normalizeEntityRef(candidate.target.counterpartyEntityId) ===
      normalizeEntityRef(expected.target.counterpartyEntityId) &&
    Number(candidate.source.tokenId) === Number(expected.source.tokenId) &&
    Number(candidate.target.tokenId) === Number(expected.target.tokenId) &&
    BigInt(candidate.source.amount) === BigInt(expected.source.amount) &&
    BigInt(candidate.target.amount) === BigInt(expected.target.amount) &&
    candidatePriceTicks === expectedPriceTicks
  );
};

const hasSourceAccountCrossOffer = (env: RuntimeReplica, route: CrossJurisdictionSwapRoute): boolean => {
  const account = getAccountState(env, route.source.entityId, route.source.counterpartyEntityId);
  if (!account) return false;
  const committed = account.swapOffers?.get(route.orderId);
  if (isMatchingCrossOfferRoute(committed?.crossJurisdiction, route)) return true;
  const pendingTxs = [...(account.mempool ?? []), ...(account.pendingFrame?.accountTxs ?? [])];
  return pendingTxs.some(
    tx =>
      tx?.type === 'swap_offer' &&
      String(tx.data?.offerId || '') === route.orderId &&
      isMatchingCrossOfferRoute(tx.data?.crossJurisdiction, route),
  );
};

export const getCommittedSourceAccountCrossOffer = (
  env: RuntimeReplica,
  route: CrossJurisdictionSwapRoute,
): SwapOffer | null => {
  const account = getAccountState(env, route.source.entityId, route.source.counterpartyEntityId);
  const committed = account?.swapOffers?.get(route.orderId);
  return isMatchingCrossOfferRoute(committed?.crossJurisdiction, route) ? committed! : null;
};

export const collectPendingCrossRequestOrderIds = (env: RuntimeReplica, entityId: string): Set<string> => {
  const normalizedEntityId = normalizeEntityRef(entityId);
  const ids = new Set<string>();
  const replica = getEntityReplicaById(env, normalizedEntityId);
  for (const orderId of replica?.state?.crossJurisdictionSwaps?.keys?.() ?? []) {
    if (orderId) ids.add(String(orderId));
  }
  return ids;
};

export const hasMarketMakerCrossOffer = (env: RuntimeReplica, spec: MarketMakerOfferSpec): boolean => {
  const route = spec.crossJurisdiction;
  if (!route) return false;
  if (hasSourceAccountCrossOffer(env, route)) return true;
  if (hasCrossRouteRegistered(env, route.source.entityId, route.orderId)) return true;
  const bookOwnerEntityId = crossJurisdictionBookOwnerRef(route);
  const bookOwner = bookOwnerEntityId ? getEntityReplicaById(env, bookOwnerEntityId)?.state : null;
  return Boolean(bookOwner && hasCrossJurisdictionBookOrder(bookOwner, route));
};

export const hasFinalizedMarketMakerCrossOffer = (env: RuntimeReplica, spec: MarketMakerOfferSpec): boolean => {
  const route = spec.crossJurisdiction;
  if (!route) return false;
  return Boolean(getCommittedSourceAccountCrossOffer(env, route));
};

export const hasMarketMakerAccountBacklog = (env: RuntimeReplica, entityId: string, hubEntityId: string): boolean => {
  const account = getAccountState(env, entityId, hubEntityId);
  return Boolean(account?.pendingFrame) || Number(account?.mempool?.length || 0) > 0;
};

export const hasMarketMakerRuntimeBacklog = (env: RuntimeReplica): boolean => {
  const runtimeMempool = env.runtimeMempool;
  return runtimeBacklogBlocksMarketMakerQuotes({
    processing: Boolean(env.infrastructure?.processingPromise),
    runtimeTxs: Number(runtimeMempool?.runtimeTxs?.length || 0),
    entityInputs: Number(runtimeMempool?.entityInputs?.length || 0),
    inFlightEntityInputs: Number(env.infrastructure?.inFlightEntityInputs || 0),
    jInputs: Number(runtimeMempool?.jInputs?.length || 0),
  });
};

export const getMarketMakerRuntimeBacklogSnapshot = (
  env: RuntimeReplica,
  options: { includeQueuedEntityInputs?: boolean } = {},
): Record<string, unknown> => {
  const snapshot: Record<string, unknown> = {
    processing: Boolean(env.infrastructure?.processingPromise),
    runtimeTxs: Number(env.runtimeMempool?.runtimeTxs?.length || 0),
    entityInputs: Number(env.runtimeMempool?.entityInputs?.length || 0),
    inFlightEntityInputs: Number(env.infrastructure?.inFlightEntityInputs || 0),
    jInputs: Number(env.runtimeMempool?.jInputs?.length || 0),
  };
  if (options.includeQueuedEntityInputs === true) {
    snapshot['queuedEntityInputs'] = (env.runtimeMempool?.entityInputs ?? []).slice(0, 8).map(input => ({
      entityId: input.entityId,
      txCount: Number(input.entityTxs?.length || 0),
      txTypes: (input.entityTxs ?? []).slice(0, 16).map(tx => tx?.type ?? 'unknown'),
    }));
  }
  return snapshot;
};
