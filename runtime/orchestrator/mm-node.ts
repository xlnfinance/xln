#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { compareStableText, safeStringify } from '../serialization-utils';
import { createStructuredLogger } from '../logger';
import { decodeRuntimeAdapterMessage } from '../radapter/codec';
import { deriveAccountWatchSeed } from '../account-watch-seed';
import { deriveSignerAddressSync, deriveSignerKeySync, prewarmSignerLabels, registerSignerKey } from '../account-crypto';
import { createDirectRuntimeWsRoute, type DirectWebSocket } from '../networking/direct-runtime-bun';
import { normalizeRuntimeId } from '../networking/runtime-id';
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
  startP2P,
  stopP2P,
  startRuntimeLoop,
  stopRuntimeLoopAndWait,
  waitForRuntimeWorkDrained,
  persistRestoredEnvToDB,
  readPersistedStorageFrameRecord,
  readPersistedStorageHead,
  listPersistedCheckpointHeights,
  loadEntityAccountDocFromStorageDb,
  loadEntityStateFromStorageDb,
  loadEntityViewPageFromStorageDb,
  listPersistedEntityIdsAtHeight,
  registerEnvChangeCallback,
} from '../runtime.ts';
import type { AccountMachine, CrossJurisdictionSwapRoute, EntityInput, Env, SwapOffer } from '../types';
import type { JAdapter, JTokenInfo } from '../jadapter/types';
import {
  BOOTSTRAP_POLL_MS,
  DEFAULT_ACCOUNT_TOKEN_IDS,
  HUB_DEFAULT_MIN_TRADE_SIZE,
  MARKET_MAKER_CREDIT_AMOUNT,
  HUB_REQUIRED_TOKEN_COUNT,
  buildMarketMakerConsensusConfig,
  deriveMarketMakerEntityId,
  getAccountMachine,
  getCreditGrantedByEntity,
  getEntityOutCapacity,
  getEntityReplicaById,
  collectQueuedSwapOfferIds,
  hasQueuedOpenAccount,
  hasQueuedExtendCredit,
  hasPairMutualCredit,
  isCanonicalAccountOpener,
  isAccountConsensusReady,
  settleRuntimeFor,
  sleep,
  waitUntil,
  type MarketMakerEntityJurisdictionConfig,
} from './mesh-common';
import { buildDefaultEntitySwapPairs, getSwapPairOrientation, getSwapPairPolicyByBaseQuote, getTokenIdsForJurisdiction } from '../account-utils';
import { LIMITS, SWAP as SWAP_CONSTANTS } from '../constants';
import { MAX_ORDERBOOK_QTY_LOTS, ORDERBOOK_PRICE_SCALE, SWAP_LOT_SCALE } from '../orderbook';
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
import { areMarketMakerHubTransportsReady } from './mm-transport';
import { computeCanonicalEntityHashesFromEnv, computeCanonicalStateHashFromEnv } from '../storage/canonical-hash';

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

type MarketMakerServerSocket = DirectWebSocket & RuntimeAdapterSocket & { data?: { type?: string } };

type JurisdictionConfig = MeshJurisdictionConfig & {
  contracts: NonNullable<MeshJurisdictionConfig['contracts']>;
};

export type HubProfile = {
  name: string;
  entityId: string;
  signerId?: string;
  runtimeId?: string;
  jurisdictionName?: string;
  chainId?: number;
  depositoryAddress?: string;
  jurisdictionRef?: string;
};

export type MarketMakerOfferSpec = {
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

type MarketMakerConnectivityBudget = {
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

type CrossQuoteJob = {
  sourceContext: MarketMakerEntityContext;
  targetContext: MarketMakerEntityContext;
  sourceHubs: HubProfile[];
  targetHubs: HubProfile[];
  sourceTokenIds: number[];
  targetTokenIds: number[];
};

type SameQuoteJob = {
  context: MarketMakerEntityContext;
  hub: HubProfile;
  tokenIds: number[];
};

type MarketMakerAccountBlocker = {
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

type MarketMakerCrossRouteBlocker = {
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
    routes: MarketMakerCrossRouteHealth[];
  };
};

const MARKET_MAKER_QUOTE_LOOP_MS = Math.max(1000, Number(process.env['MARKET_MAKER_QUOTE_LOOP_MS'] || '30000'));
const MARKET_MAKER_BOOTSTRAP_LOOP_MS = Math.max(25, Number(process.env['MARKET_MAKER_BOOTSTRAP_LOOP_MS'] || '25'));
const MARKET_MAKER_BOOTSTRAP_TIMEOUT_MS = Math.max(
  10_000,
  Number(process.env['MARKET_MAKER_BOOTSTRAP_TIMEOUT_MS'] || '1500000'),
);
const MARKET_MAKER_BOOTSTRAP_START_DELAY_MS = Math.max(
  0,
  Number(process.env['MARKET_MAKER_BOOTSTRAP_START_DELAY_MS'] || '0'),
);
const MARKET_MAKER_RUNTIME_TICK_DELAY_MS = Math.max(
  0,
  Number(process.env['MARKET_MAKER_RUNTIME_TICK_DELAY_MS'] || '10'),
);
const MARKET_MAKER_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME = Math.max(
  1,
  Number(process.env['MARKET_MAKER_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME'] || '1000'),
);
const MARKET_MAKER_API_YIELD_MS = Math.max(
  1,
  Number(process.env['MARKET_MAKER_API_YIELD_MS'] || '1'),
);
const MARKET_MAKER_OFFERS_PER_ACCOUNT_PER_TICK = Math.max(
  2,
  Number(process.env['MARKET_MAKER_OFFERS_PER_ACCOUNT_PER_TICK'] || '1000'),
);
const MARKET_MAKER_MAX_NEW_OFFERS_PER_TICK = Math.max(
  4,
  Number(process.env['MARKET_MAKER_MAX_NEW_OFFERS_PER_TICK'] || '1000'),
);
// These are scheduler wave sizes, not data limits. Same-chain bootstrap must
// fill full books in one account/entity wave when possible; progress/yielding
// happens at runtime frame boundaries, not via tiny producer caps.
const MARKET_MAKER_BOOTSTRAP_DEFAULT_OFFERS_PER_ACCOUNT_PER_TICK = 1000;
const MARKET_MAKER_BOOTSTRAP_DEFAULT_MAX_NEW_OFFERS_PER_TICK = 1000;
const MARKET_MAKER_BOOTSTRAP_SAME_QUOTE_HUB_GROUPS_PER_WAVE = Math.max(
  1,
  Number(process.env['MARKET_MAKER_BOOTSTRAP_SAME_QUOTE_HUB_GROUPS_PER_WAVE'] || '1'),
);
const MARKET_MAKER_BOOTSTRAP_OFFERS_PER_ACCOUNT_PER_TICK = Math.max(
  2,
  Number(
    process.env['MARKET_MAKER_BOOTSTRAP_OFFERS_PER_ACCOUNT_PER_TICK'] ||
      String(MARKET_MAKER_BOOTSTRAP_DEFAULT_OFFERS_PER_ACCOUNT_PER_TICK),
  ),
);
const MARKET_MAKER_BOOTSTRAP_MAX_NEW_OFFERS_PER_TICK = Math.max(
  4,
  Number(
    process.env['MARKET_MAKER_BOOTSTRAP_MAX_NEW_OFFERS_PER_TICK'] ||
      String(MARKET_MAKER_BOOTSTRAP_DEFAULT_MAX_NEW_OFFERS_PER_TICK),
  ),
);
// Cross bootstrap is a book-construction phase. Keep the scheduler permissive
// enough to build the full book in one entity/account frame when consensus can
// accept it; responsiveness comes from frame boundaries and explicit API yields.
const MARKET_MAKER_BOOTSTRAP_DEFAULT_CROSS_OFFERS_PER_ACCOUNT_PER_TICK = 1000;
const MARKET_MAKER_BOOTSTRAP_DEFAULT_MAX_NEW_CROSS_OFFERS_PER_TICK = 1000;
const MARKET_MAKER_BOOTSTRAP_CROSS_OFFERS_PER_ACCOUNT_PER_TICK = Math.max(
  1,
  Number(
    process.env['MARKET_MAKER_BOOTSTRAP_CROSS_OFFERS_PER_ACCOUNT_PER_TICK'] ||
      String(MARKET_MAKER_BOOTSTRAP_DEFAULT_CROSS_OFFERS_PER_ACCOUNT_PER_TICK),
  ),
);
const MARKET_MAKER_BOOTSTRAP_MAX_NEW_CROSS_OFFERS_PER_TICK = Math.max(
  1,
  Number(
    process.env['MARKET_MAKER_BOOTSTRAP_MAX_NEW_CROSS_OFFERS_PER_TICK'] ||
      String(MARKET_MAKER_BOOTSTRAP_DEFAULT_MAX_NEW_CROSS_OFFERS_PER_TICK),
  ),
);
const MARKET_MAKER_BOOTSTRAP_CROSS_SOURCE_HUB_GROUPS_PER_WAVE = Math.max(
  1,
  Number(process.env['MARKET_MAKER_BOOTSTRAP_CROSS_SOURCE_HUB_GROUPS_PER_WAVE'] || '1000'),
);
const MARKET_MAKER_STEADY_CROSS_ROUTE_JOBS_PER_TICK = Math.max(
  1,
  Number(process.env['MARKET_MAKER_STEADY_CROSS_ROUTE_JOBS_PER_TICK'] || '1000'),
);
const MARKET_MAKER_CONNECTIVITY_MAX_TXS_PER_TICK = Math.max(
  1,
  Number(process.env['MARKET_MAKER_CONNECTIVITY_MAX_TXS_PER_TICK'] || '1000'),
);
const MARKET_MAKER_BOOTSTRAP_CONNECTIVITY_MAX_TXS_PER_TICK = Math.max(
  1,
  Number(process.env['MARKET_MAKER_BOOTSTRAP_CONNECTIVITY_MAX_TXS_PER_TICK'] || '1000'),
);
const MARKET_MAKER_CROSS_LEVELS_PER_PAIR = Math.max(
  1,
  // Keep default cross depth small for bootstrap speed; account frames can now
  // carry 1000 txs, and MAX_ACCOUNT_SWAP_OFFERS bounds env-driven depth.
  Math.min(1000, Number(process.env['MARKET_MAKER_CROSS_LEVELS_PER_PAIR'] || '3')),
);
const MARKET_MAKER_MAX_LEVELS_PER_PAIR = Math.max(
  1,
  Math.min(
    1000,
    Number(process.env['MARKET_MAKER_MAX_LEVELS_PER_PAIR'] || '10'),
  ),
);
const MARKET_MAKER_BOOTSTRAP_EVENTS_JSONL = String(
  process.env['XLN_MARKET_MAKER_BOOTSTRAP_EVENTS_JSONL'] || '',
).trim();

const emitMarketMakerBootstrapDebugEvent = (event: string, fields: Record<string, unknown> = {}): void => {
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
const yieldMarketMakerApi = async (): Promise<void> => {
  await new Promise<void>(resolve => setTimeout(resolve, MARKET_MAKER_API_YIELD_MS));
};
const ORDERBOOK_MAX_BASE_AMOUNT = MAX_ORDERBOOK_QTY_LOTS * SWAP_LOT_SCALE;
const MARKET_MAKER_DEPTH_MULTIPLIER = (() => {
  try {
    const parsed = BigInt(String(process.env['MARKET_MAKER_DEPTH_MULTIPLIER'] || '10'));
    return parsed > 0n ? parsed : 10n;
  } catch {
    return 10n;
  }
})();
const MARKET_MAKER_STABLE_DEPTH_MULTIPLIER = (() => {
  try {
    const parsed = BigInt(String(process.env['MARKET_MAKER_STABLE_DEPTH_MULTIPLIER'] || '1000'));
    return parsed > 0n ? parsed : 1000n;
  } catch {
    return 1000n;
  }
})();
const MARKET_MAKER_SIZE_UNIT = MARKET_MAKER_DEPTH_MULTIPLIER * 10n ** 18n;
const MARKET_MAKER_STABLE_SIZE_UNIT = MARKET_MAKER_STABLE_DEPTH_MULTIPLIER * 10n ** 18n;
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
  360n * MARKET_MAKER_SIZE_UNIT,
  420n * MARKET_MAKER_SIZE_UNIT,
  500n * MARKET_MAKER_SIZE_UNIT,
  600n * MARKET_MAKER_SIZE_UNIT,
  720n * MARKET_MAKER_SIZE_UNIT,
  840n * MARKET_MAKER_SIZE_UNIT,
  960n * MARKET_MAKER_SIZE_UNIT,
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

const getArg = (name: string, fallback = ''): string => {
  const eq = argsRaw.find(arg => arg.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const index = argsRaw.indexOf(name);
  if (index === -1) return fallback;
  return argsRaw[index + 1] || fallback;
};

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
  return {
    name: getArg('--name', 'MM'),
    seed: getArg('--seed', 'xln-mesh-mm'),
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
  seed: 'xln-mesh-mm',
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

const resolvedArgs = import.meta.main ? parseArgs() : defaultArgsForImport();
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
if (import.meta.main && !directWsUrl) {
  throw new Error('[MESH-MM] Missing required --direct-ws-url');
}
const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;
const nodeLog = createStructuredLogger('mesh.marketMaker', { name: resolvedArgs.name });

const envFlagEnabled = (value: unknown): boolean => {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
};

const buildLocalMarketMakerSignerLabels = (): string[] => {
  const primary = resolveJurisdictionConfig(resolvedArgs.rpcUrl);
  const labels = [resolvedArgs.signerLabel];
  for (const [index, secondary] of resolveSecondaryJurisdictions<JurisdictionConfig>(primary.rpc).entries()) {
    const secondaryName = String(secondary.name || `Secondary ${index + 1}`).trim();
    if (secondaryName) labels.push(`${resolvedArgs.signerLabel}:${secondaryName}`);
  }
  return labels;
};

const prewarmLocalMarketMakerSignerKeys = (): void => {
  const signerIds = prewarmSignerLabels(resolvedArgs.seed, buildLocalMarketMakerSignerLabels());
  console.log(`[MESH-MM] SIGNER_KEYS_PREWARMED name=${resolvedArgs.name} count=${signerIds.length}`);
};

const configureMarketMakerStorage = (env: Env): void => {
  if (!envFlagEnabled(process.env['XLN_MARKET_MAKER_DISABLE_STORAGE'])) return;
  env.runtimeConfig = {
    ...(env.runtimeConfig || {}),
    storage: {
      ...(env.runtimeConfig?.storage || {}),
      enabled: false,
    },
  };
  console.log('[MESH-MM] Runtime storage disabled for rebuildable market-maker state');
};

const configureMarketMakerRuntimeLogging = (env: Env): void => {
  if (envFlagEnabled(process.env['XLN_MARKET_MAKER_VERBOSE_RUNTIME_LOGS'])) return;
  env.quietRuntimeLogs = true;
};

const shouldStartJWatcherAtCurrentBlock = (): boolean =>
  !envFlagEnabled(process.env['XLN_MARKET_MAKER_REPLAY_HISTORICAL_J_EVENTS']);

const resolveJurisdictionConfig = (rpcUrlOverride: string): JurisdictionConfig =>
  resolveMeshJurisdictionConfig<JurisdictionConfig>(rpcUrlOverride);

const resolveImportedJurisdictionRpc = (jurisdiction: JurisdictionConfig): string =>
  resolveLocalApiUrl(jurisdiction.rpc);

const toEntityJurisdictionConfig = (jurisdiction: JurisdictionConfig): MarketMakerEntityJurisdictionConfig => ({
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

const hasLiveJurisdictionAdapter = (env: Env, name: string): boolean => {
  const normalized = String(name || '').trim().toLowerCase();
  if (!normalized) return false;
  for (const [existing, replica] of env.jReplicas?.entries?.() || []) {
    if (
      String(existing || '').trim().toLowerCase() === normalized ||
      String(replica?.name || '').trim().toLowerCase() === normalized
    ) {
      return Boolean(replica?.jadapter);
    }
  }
  return false;
};

const importJurisdictionIfNeeded = async (
  env: Env,
  jurisdiction: JurisdictionConfig,
  rounds = 35,
): Promise<void> => {
  if (hasJurisdictionReplica(env, jurisdiction.name) && hasLiveJurisdictionAdapter(env, jurisdiction.name)) return;
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
        startAtCurrentBlock: shouldStartJWatcherAtCurrentBlock(),
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
  const entityJurisdiction = toEntityJurisdictionConfig(jurisdiction);
  const consensusConfig = buildMarketMakerConsensusConfig(signerId, entityJurisdiction);
  const entityId = deriveMarketMakerEntityId(signerId, entityJurisdiction);
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

const waitForActiveJAdapter = async (env: Env, jurisdictionName: string, rounds = 1200): Promise<JAdapter> => {
  for (let i = 0; i < rounds; i += 1) {
    const jadapter = getActiveJAdapter(env);
    if (jadapter) return jadapter;
    await settleRuntimeFor(env, 5);
    await sleep(50);
  }
  throw new Error(
    `ACTIVE_JADAPTER_NOT_READY name=${jurisdictionName} ` +
    `active=${String(env.activeJurisdiction || 'none')} ` +
    `jReplicas=${Array.from(env.jReplicas?.keys?.() || []).join(',') || 'none'} ` +
    `runtimeMempool=${Number(env.runtimeMempool?.runtimeTxs?.length || 0)}`,
  );
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
      runtimeId: normalizeRuntimeId(profile.runtimeId || ''),
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

const ceilDiv = (numerator: bigint, denominator: bigint): bigint => {
  if (denominator <= 0n) throw new Error('ceilDiv denominator must be positive');
  return (numerator + denominator - 1n) / denominator;
};

const alignUpToLot = (amount: bigint): bigint => {
  if (amount <= 0n) return 0n;
  return ceilDiv(amount, SWAP_LOT_SCALE) * SWAP_LOT_SCALE;
};

const minBaseAmountForQuoteNotional = (priceTicks: bigint): bigint => {
  if (priceTicks <= 0n) return 0n;
  return alignUpToLot(ceilDiv(HUB_DEFAULT_MIN_TRADE_SIZE * ORDERBOOK_PRICE_SCALE, priceTicks));
};

const withMinQuoteNotionalBaseSize = (baseSize: bigint, priceTicks: bigint): bigint => {
  const minBaseSize = minBaseAmountForQuoteNotional(priceTicks);
  const desiredBaseSize = baseSize >= minBaseSize ? baseSize : minBaseSize;
  return desiredBaseSize <= ORDERBOOK_MAX_BASE_AMOUNT ? desiredBaseSize : ORDERBOOK_MAX_BASE_AMOUNT;
};

const withCrossMinQuoteNotionalSourceAmount = (
  sourceAmount: bigint,
  sourceIsBase: boolean,
  priceTicks: bigint,
): bigint => {
  if (sourceIsBase) return withMinQuoteNotionalBaseSize(sourceAmount, priceTicks);
  return sourceAmount >= HUB_DEFAULT_MIN_TRADE_SIZE ? sourceAmount : HUB_DEFAULT_MIN_TRADE_SIZE;
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

const computeCrossOrderbookPriceTicks = (
  sourceIsBase: boolean,
  baseAmount: bigint,
  quoteAmount: bigint,
  stepTicks: number,
): bigint => {
  if (baseAmount <= 0n || quoteAmount <= 0n) return 0n;
  const step = BigInt(Math.max(1, stepTicks));
  const scaledQuoteAmount = quoteAmount * ORDERBOOK_PRICE_SCALE;
  const remainder = scaledQuoteAmount % baseAmount;
  let ticks = scaledQuoteAmount / baseAmount;
  if (sourceIsBase) {
    if (remainder > 0n) ticks += 1n;
    return ((ticks + step - 1n) / step) * step;
  }
  return (ticks / step) * step;
};

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
  const oriented = sourceTokenId === targetTokenId
    ? { baseTokenId: sourceTokenId, quoteTokenId: targetTokenId }
    : getSwapPairOrientation(sourceTokenId, targetTokenId);
  const pairPolicy = getSwapPairPolicyByBaseQuote(oriented.baseTokenId, oriented.quoteTokenId);
  const requestedBaseAmount = market.sourceIsBase ? sourceAmount : targetAmount;
  const cappedBaseAmount = requestedBaseAmount <= ORDERBOOK_MAX_BASE_AMOUNT
    ? requestedBaseAmount
    : ORDERBOOK_MAX_BASE_AMOUNT;
  const quantizedBaseAmount = (cappedBaseAmount / SWAP_LOT_SCALE) * SWAP_LOT_SCALE;
  if (quantizedBaseAmount <= 0n) return null;

  const requestedQuoteAmount = (quantizedBaseAmount * priceTicks) / ORDERBOOK_PRICE_SCALE;
  if (requestedQuoteAmount <= 0n) return null;
  const effectivePriceTicks = computeCrossOrderbookPriceTicks(
    market.sourceIsBase,
    quantizedBaseAmount,
    requestedQuoteAmount,
    pairPolicy.priceStepTicks,
  );
  if (effectivePriceTicks <= 0n) return null;

  const effectiveQuoteAmount = (quantizedBaseAmount * effectivePriceTicks) / ORDERBOOK_PRICE_SCALE;
  if (effectiveQuoteAmount <= 0n) return null;
  // Account cross swap_offer recomputes ticks with step=1 from final amounts.
  // Keep this assert so future wider MM book steps cannot silently diverge.
  const accountCrossPriceTicks = computeCrossOrderbookPriceTicks(
    market.sourceIsBase,
    quantizedBaseAmount,
    effectiveQuoteAmount,
    1,
  );
  if (accountCrossPriceTicks !== effectivePriceTicks) {
    throw new Error(
      `MARKET_MAKER_CROSS_ACCOUNT_PRICE_DIVERGENCE priceTicks=${effectivePriceTicks.toString()} accountTicks=${accountCrossPriceTicks.toString()}`,
    );
  }
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
      jurisdictionTokenIds.length >= HUB_REQUIRED_TOKEN_COUNT
        ? selectMarketMakerBootstrapTokenIds(jurisdictionTokenIds)
        : fallback,
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

const collectCommittedOfferIdsForAccount = (
  account: Pick<AccountMachine, 'swapOffers'> | null | undefined,
): Set<string> => {
  const ids = new Set<string>();
  if (account?.swapOffers instanceof Map) {
    for (const offerId of account.swapOffers.keys()) ids.add(String(offerId));
  }
  return ids;
};

const getMarketMakerOfferLevel = (spec: Pick<MarketMakerOfferSpec, 'offerId'>): number => {
  const match = String(spec.offerId || '').match(/-(?:ask|bid|sell)-(\d+)$/);
  const level = match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
  return Number.isFinite(level) && level > 0 ? Math.floor(level) : Number.MAX_SAFE_INTEGER;
};

const buildMarketMakerOfferSpecs = (hubEntityIds: string[], tokenIds: number[]): MarketMakerOfferSpec[] => {
  const specs: MarketMakerOfferSpec[] = [];
  const defaultPairs = buildDefaultEntitySwapPairs(tokenIds);
  for (const hubEntityId of hubEntityIds) {
    const hubSuffix = hubEntityId.slice(-6).toLowerCase();
    const pairContexts = defaultPairs.map((pair) => {
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
        const askBaseSize = withMinQuoteNotionalBaseSize(baseSize, askPriceTicks);
        const bidBaseSize = withMinQuoteNotionalBaseSize(baseSize, bidPriceTicks);
        const askWantAmount = (askBaseSize * askPriceTicks) / ORDERBOOK_PRICE_SCALE;
        const bidGiveAmount = (bidBaseSize * bidPriceTicks) / ORDERBOOK_PRICE_SCALE;
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
            wantAmount: bidBaseSize,
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

export const buildMarketMakerCrossOfferSpecs = (
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
        const rawPriceTicks = market.sourceIsBase
          ? (canonicalMidTicks * BigInt(10_000 + offsetBps)) / 10_000n
          : (canonicalMidTicks * BigInt(Math.max(1, 10_000 - offsetBps))) / 10_000n;
        const priceTicks = snapPriceTicks(rawPriceTicks, pairPolicy.priceStepTicks, market.sourceIsBase ? 'up' : 'down');
        if (!isWithinPairBand(canonicalMidTicks, priceTicks)) continue;
        const sourceAmount = withCrossMinQuoteNotionalSourceAmount(
          levelProfile.baseSizes[level]!,
          market.sourceIsBase,
          priceTicks,
        );
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
          const quoteAmount = market.sourceIsBase ? amounts.targetAmount : amounts.sourceAmount;
          if (quoteAmount < HUB_DEFAULT_MIN_TRADE_SIZE) continue;
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
            minFillRatio: 0,
            crossJurisdiction: route,
          });
        }
      }
    }
  }

  return specs;
};

const countCommittedMarketMakerOffersForHubPair = (
  env: Env,
  mmEntityId: string,
  hubEntityId: string,
  pair: { baseTokenId: number; quoteTokenId: number },
): number => {
  const account = getAccountMachine(env, mmEntityId, hubEntityId);
  if (!account) return 0;
  const prefix = `mm-${hubEntityId.slice(-6).toLowerCase()}-${pair.baseTokenId}-${pair.quoteTokenId}-`;
  let count = 0;
  for (const offerId of collectCommittedOfferIdsForAccount(account)) {
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

const countCommittedMarketMakerOffersForHub = (env: Env, mmEntityId: string, hubEntityId: string): number => {
  const account = getAccountMachine(env, mmEntityId, hubEntityId);
  if (!account) return 0;
  const prefix = `mm-${hubEntityId.slice(-6).toLowerCase()}-`;
  let count = 0;
  for (const offerId of collectCommittedOfferIdsForAccount(account)) {
    if (offerId.startsWith(prefix)) count += 1;
  }
  return count;
};

const isSameQuoteJobDepthComplete = (env: Env, job: SameQuoteJob): boolean => {
  const desiredOffers = buildMarketMakerOfferSpecs([job.hub.entityId], job.tokenIds);
  if (desiredOffers.length === 0) return true;
  const account = getAccountMachine(env, job.context.entityId, job.hub.entityId);
  const committedOfferIds = collectCommittedOfferIdsForAccount(account);
  return desiredOffers.every(spec => committedOfferIds.has(spec.offerId));
};

type PendingCrossRequestReader = (entityId: string) => Set<string>;

const hasCrossSpecBootstrapProgress = (
  env: Env,
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

const countCrossSpecBootstrapProgress = (
  env: Env,
  specs: MarketMakerOfferSpec[],
  getPendingCrossRequestOrderIds: PendingCrossRequestReader,
): number => {
  let count = 0;
  for (const spec of specs) {
    if (hasCrossSpecBootstrapProgress(env, spec, getPendingCrossRequestOrderIds)) count += 1;
  }
  return count;
};

const countCrossSpecBootstrapProgressByPair = (
  env: Env,
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

const countCrossSpecVisibleOffersByPair = (
  env: Env,
  specs: MarketMakerOfferSpec[],
): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const spec of specs) {
    if (!spec.crossJurisdiction || !hasMarketMakerCrossOffer(env, spec)) continue;
    counts.set(spec.pairId, (counts.get(spec.pairId) || 0) + 1);
  }
  return counts;
};

const crossSpecPairIds = (specs: MarketMakerOfferSpec[]): string[] =>
  Array.from(new Set(specs.map(spec => spec.pairId).filter(Boolean)))
    .sort(compareStableText);

const countCrossPairCoverageGaps = (
  env: Env,
  specs: MarketMakerOfferSpec[],
): number => {
  const visibleByPair = countCrossSpecVisibleOffersByPair(env, specs);
  return crossSpecPairIds(specs).filter(pairId => (visibleByPair.get(pairId) || 0) === 0).length;
};

const ensureMarketMakerHubConnectivity = async (
  env: Env,
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

  collectOpenAccountInputs:
  for (const hubEntityId of hubEntityIds) {
    const mmAccount = getAccountMachine(env, mmEntityId, hubEntityId);
    const hasPendingConsensus =
      Boolean(mmAccount?.pendingFrame) ||
      Number(mmAccount?.mempool?.length || 0) > 0;
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
            creditAmount: MARKET_MAKER_CREDIT_AMOUNT,
          },
        },
        ...extraCreditTokenIds.map((tokenId) => ({
          type: 'extendCredit' as const,
          data: {
            counterpartyEntityId: hubEntityId,
            tokenId,
            amount: MARKET_MAKER_CREDIT_AMOUNT,
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

  collectCreditInputs:
  for (const hubEntityId of hubEntityIds) {
    const mmAccount = getAccountMachine(env, mmEntityId, hubEntityId);
    const hasPendingConsensus =
      Boolean(mmAccount?.pendingFrame) ||
      Number(mmAccount?.mempool?.length || 0) > 0;
    if (hasPendingConsensus) continue;
    if (!mmAccount) continue;

    for (const tokenId of tokenIds) {
      if (hasPairMutualCredit(env, mmEntityId, hubEntityId, tokenId, MARKET_MAKER_CREDIT_AMOUNT)) continue;
      if (hasQueuedExtendCredit(env, mmEntityId, hubEntityId, tokenId, MARKET_MAKER_CREDIT_AMOUNT)) continue;
      const hubOutCapacity = getEntityOutCapacity(mmAccount, hubEntityId, tokenId);

      if (hubOutCapacity < MARKET_MAKER_CREDIT_AMOUNT) {
        if (!pushLocalConnectivityTx(mmEntityId, mmSignerId, {
          type: 'extendCredit',
          data: {
            counterpartyEntityId: hubEntityId,
            tokenId,
            amount: MARKET_MAKER_CREDIT_AMOUNT,
          },
        })) {
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
  tokenIds: number[],
  maxOffersPerAccount = MARKET_MAKER_OFFERS_PER_ACCOUNT_PER_TICK,
  maxNewOffersTotal = MARKET_MAKER_MAX_NEW_OFFERS_PER_TICK,
  connectivityBudget: MarketMakerConnectivityBudget = { remainingTxs: MARKET_MAKER_CONNECTIVITY_MAX_TXS_PER_TICK },
  shouldContinue: () => boolean = () => true,
): Promise<boolean> => {
  if (hubEntityIds.length === 0 || tokenIds.length < 3) return false;
  if (!shouldContinue()) return false;
  if (await ensureMarketMakerHubConnectivity(
    env,
    mmEntityId,
    mmSignerId,
    hubEntityIds,
    tokenIds,
    connectivityBudget,
  )) return true;
  if (!shouldContinue()) return false;
  const quoteReadyHubEntityIds = hubEntityIds.filter((hubEntityId) =>
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
  let remainingNewOffers = Math.max(
    1,
    Math.floor(maxNewOffersTotal),
  );
  const groupedEntries = Array.from(grouped.entries())
    .sort((left, right) =>
      countMarketMakerOffersForHub(env, mmEntityId, left[0]) -
      countMarketMakerOffersForHub(env, mmEntityId, right[0]) ||
      compareStableText(left[0], right[0]),
    );

  for (const [hubEntityId, specs] of groupedEntries) {
    await yieldMarketMakerApi();
    if (!shouldContinue()) return false;
    if (remainingNewOffers <= 0) break;
    const account = getAccountMachine(env, mmEntityId, hubEntityId);
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
      .filter(spec =>
        hasPairMutualCredit(env, mmEntityId, hubEntityId, spec.giveTokenId, spec.giveAmount)
        && hasPairMutualCredit(env, mmEntityId, hubEntityId, spec.wantTokenId, spec.wantAmount),
      )
      .slice(0, allowedNewOffers);
    if (missing.length === 0) continue;
    for (const spec of missing) {
      pushMarketMakerEntityTx(
        entityInputsByEntitySigner,
        mmEntityId,
        mmSignerId,
        {
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
        },
      );
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

const hasCrossRouteRegistered = (env: Env, entityId: string, orderId: string): boolean => {
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
    normalizeEntityRef(candidate.source.counterpartyEntityId) === normalizeEntityRef(expected.source.counterpartyEntityId) &&
    normalizeEntityRef(candidate.target.entityId) === normalizeEntityRef(expected.target.entityId) &&
    normalizeEntityRef(candidate.target.counterpartyEntityId) === normalizeEntityRef(expected.target.counterpartyEntityId) &&
    Number(candidate.source.tokenId) === Number(expected.source.tokenId) &&
    Number(candidate.target.tokenId) === Number(expected.target.tokenId) &&
    BigInt(candidate.source.amount) === BigInt(expected.source.amount) &&
    BigInt(candidate.target.amount) === BigInt(expected.target.amount) &&
    candidatePriceTicks === expectedPriceTicks
  );
};

const hasSourceAccountCrossOffer = (env: Env, route: CrossJurisdictionSwapRoute): boolean => {
  const account = getAccountMachine(env, route.source.entityId, route.source.counterpartyEntityId);
  if (!account) return false;
  const committed = account.swapOffers?.get(route.orderId);
  if (isMatchingCrossOfferRoute(committed?.crossJurisdiction, route)) return true;
  const pendingTxs = [
    ...(account.mempool ?? []),
    ...(account.pendingFrame?.accountTxs ?? []),
  ];
  return pendingTxs.some((tx) =>
    tx?.type === 'swap_offer' &&
    String(tx.data?.offerId || '') === route.orderId &&
    isMatchingCrossOfferRoute(tx.data?.crossJurisdiction, route)
  );
};

const getCommittedSourceAccountCrossOffer = (
  env: Env,
  route: CrossJurisdictionSwapRoute,
): SwapOffer | null => {
  const account = getAccountMachine(env, route.source.entityId, route.source.counterpartyEntityId);
  const committed = account?.swapOffers?.get(route.orderId);
  return isMatchingCrossOfferRoute(committed?.crossJurisdiction, route) ? committed! : null;
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

const hasMarketMakerCrossOffer = (env: Env, spec: MarketMakerOfferSpec): boolean => {
  const route = spec.crossJurisdiction;
  if (!route) return false;
  if (hasSourceAccountCrossOffer(env, route)) return true;
  if (hasCrossRouteRegistered(env, route.source.entityId, route.orderId)) return true;
  const bookOwnerEntityId = crossJurisdictionBookOwnerRef(route);
  const bookOwner = bookOwnerEntityId ? getEntityReplicaById(env, bookOwnerEntityId)?.state : null;
  return Boolean(bookOwner && hasCrossJurisdictionBookOrder(bookOwner, route));
};

export const hasFinalizedMarketMakerCrossOffer = (env: Env, spec: MarketMakerOfferSpec): boolean => {
  const route = spec.crossJurisdiction;
  if (!route) return false;
  return Boolean(getCommittedSourceAccountCrossOffer(env, route));
};

type MarketMakerCrossBootstrapWaveDebug = {
  direction: string;
  sourceHubEntityId?: string;
  candidateCount?: number;
  selectedCount?: number;
  desiredOffers?: number;
  groupedSourceHubs?: number;
  enqueuedEntityInputs?: number;
  enqueuedEntityTxs?: number;
  durationMs?: number;
  remainingNewOffers?: number;
  remainingSourceHubGroups?: number;
};

const emitMarketMakerCrossBootstrapWaveEvent = (
  event: string,
  fields: MarketMakerCrossBootstrapWaveDebug,
): void => {
  emitMarketMakerBootstrapDebugEvent(event, {
    stage: 'bootstrap-cross',
    ...fields,
  });
};

const isCrossQuoteJobDepthComplete = (env: Env, job: CrossQuoteJob): boolean => {
  const desiredOffers = buildMarketMakerCrossOfferSpecs(
    env,
    job.sourceContext,
    job.targetContext,
    job.sourceHubs,
    job.targetHubs,
    job.sourceTokenIds,
    job.targetTokenIds,
  );
  return desiredOffers.length === 0 || desiredOffers.every(spec => hasFinalizedMarketMakerCrossOffer(env, spec));
};

type MarketMakerCrossHealthPairExpectation = {
  sourceTokenIds: number[];
  targetTokenIds: number[];
};

type MarketMakerCrossHealthRouteGroup = {
  sourceJurisdiction: string;
  targetJurisdiction: string;
  sourceMmEntityId: string;
  targetMmEntityId: string;
  sourceHubEntityId: string;
  targetHubEntityId: string;
  expectedPairs: Map<string, MarketMakerCrossHealthPairExpectation>;
  specs: MarketMakerOfferSpec[];
};

const describeMarketMakerAccountBlocker = (
  env: Env,
  role: MarketMakerCrossRouteBlocker['role'],
  entityId: string,
  counterpartyEntityId: string,
): MarketMakerCrossRouteBlocker | null => {
  const account = getAccountMachine(env, entityId, counterpartyEntityId);
  const status = account ? String(account.status || 'active') : null;
  const currentHeight = account ? Number(account.currentHeight ?? 0) : null;
  const pendingFrame = Boolean(account?.pendingFrame);
  const mempoolLength = Number(account?.mempool?.length || 0);
  let reason: MarketMakerCrossRouteBlocker['reason'] | null = null;
  if (!account) reason = 'missing-account';
  else if (status !== 'active') reason = 'inactive-account';
  else if (Number(currentHeight ?? 0) <= 0) reason = 'height-zero';
  else if (pendingFrame) reason = 'pending-frame';
  else if (mempoolLength > 0) reason = 'mempool';
  if (!reason) return null;
  return {
    role,
    entityId,
    counterpartyEntityId,
    reason,
    status,
    currentHeight,
    pendingFrame,
    pendingFrameHeight: account?.pendingFrame ? Number(account.pendingFrame.height ?? 0) : null,
    mempoolLength,
    swapOffers: Number(account?.swapOffers?.size || 0),
  };
};

const describeMarketMakerSameHubBlocker = (
  env: Env,
  entityId: string,
  counterpartyEntityId: string,
): MarketMakerAccountBlocker | null => {
  const account = getAccountMachine(env, entityId, counterpartyEntityId);
  const status = account ? String(account.status || 'active') : null;
  const currentHeight = account ? Number(account.currentHeight ?? 0) : null;
  const pendingFrame = Boolean(account?.pendingFrame);
  const mempoolLength = Number(account?.mempool?.length || 0);
  let reason: MarketMakerAccountBlocker['reason'] | null = null;
  if (!account) reason = 'missing-account';
  else if (status !== 'active') reason = 'inactive-account';
  else if (Number(currentHeight ?? 0) <= 0) reason = 'height-zero';
  else if (pendingFrame) reason = 'pending-frame';
  else if (mempoolLength > 0) reason = 'mempool';
  if (!reason) return null;
  return {
    entityId,
    counterpartyEntityId,
    reason,
    status,
    currentHeight,
    pendingFrame,
    pendingFrameHeight: account?.pendingFrame ? Number(account.pendingFrame.height ?? 0) : null,
    mempoolLength,
    swapOffers: Number(account?.swapOffers?.size || 0),
  };
};

const buildExpectedMarketMakerCrossRouteGroups = (
  env: Env,
  contexts: MarketMakerEntityContext[],
  visibleHubs: HubProfile[],
  tokenIdsByContext: MarketMakerTokenIdsByContext,
): Map<string, MarketMakerCrossHealthRouteGroup> => {
  const groups = new Map<string, MarketMakerCrossHealthRouteGroup>();
  for (const sourceContext of contexts) {
    const sourceJurisdictionRef = sourceContext.jurisdictionRef;
    const sourceTokenIds = getMarketMakerTokenIds(tokenIdsByContext, sourceContext);
    if (!sourceJurisdictionRef || sourceTokenIds.length < HUB_REQUIRED_TOKEN_COUNT) continue;
    const sourceHubs = visibleHubs.filter(profile => sameJurisdiction(sourceContext, profile));
    if (sourceHubs.length === 0) continue;
    for (const targetContext of contexts) {
      const targetJurisdictionRef = targetContext.jurisdictionRef;
      if (
        sourceContext.entityId === targetContext.entityId ||
        sameJurisdiction(sourceContext, targetContext) ||
        !targetJurisdictionRef
      ) {
        continue;
      }
      const targetTokenIds = getMarketMakerTokenIds(tokenIdsByContext, targetContext);
      if (targetTokenIds.length < HUB_REQUIRED_TOKEN_COUNT) continue;
      const targetHubs = visibleHubs.filter(profile => sameJurisdiction(targetContext, profile));
      if (targetHubs.length === 0) continue;

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
        const group = groups.get(key) ?? {
          sourceJurisdiction: sourceContext.jurisdictionName,
          targetJurisdiction: targetContext.jurisdictionName,
          sourceMmEntityId: sourceContext.entityId,
          targetMmEntityId: targetContext.entityId,
          sourceHubEntityId,
          targetHubEntityId,
          expectedPairs: new Map<string, MarketMakerCrossHealthPairExpectation>(),
          specs: [],
        };
        const expected = group.expectedPairs.get(spec.pairId) ?? {
          sourceTokenIds: [],
          targetTokenIds: [],
        };
        expected.sourceTokenIds = normalizePositiveTokenIds([
          ...expected.sourceTokenIds,
          route.source.tokenId,
        ]);
        expected.targetTokenIds = normalizePositiveTokenIds([
          ...expected.targetTokenIds,
          route.target.tokenId,
        ]);
        group.expectedPairs.set(spec.pairId, expected);
        group.specs.push(spec);
        groups.set(key, group);
      }
    }
  }
  return groups;
};

export const buildMarketMakerCrossHealth = (
  env: Env,
  contexts: MarketMakerEntityContext[],
  visibleHubs: HubProfile[],
  tokenIdsByContext: MarketMakerTokenIdsByContext,
): MarketMakerHealth['cross'] => {
  const routeGroups = buildExpectedMarketMakerCrossRouteGroups(env, contexts, visibleHubs, tokenIdsByContext);

  const expectedRouteCount = routeGroups.size;
  const routes = Array.from(routeGroups.values()).map((group) => {
    const expectedByPair = new Map<string, MarketMakerOfferSpec[]>();
    for (const spec of group.specs) {
      const pairSpecs = expectedByPair.get(spec.pairId) ?? [];
      pairSpecs.push(spec);
      expectedByPair.set(spec.pairId, pairSpecs);
    }
    const pairIds = Array.from(new Set([...group.expectedPairs.keys(), ...expectedByPair.keys()]));
    const pairs = pairIds
      .map((pairId) => {
        const specs = expectedByPair.get(pairId) ?? [];
        const expected = group.expectedPairs.get(pairId) ?? null;
        const offers = specs.filter(spec => hasFinalizedMarketMakerCrossOffer(env, spec)).length;
        const expectedOffers = Math.max(
          specs.length,
          expected ? MARKET_MAKER_CROSS_LEVELS_PER_PAIR : 0,
        );
        const sourceTokenIds = expected?.sourceTokenIds?.length
          ? expected.sourceTokenIds
          : normalizePositiveTokenIds(specs.map(spec => spec.crossJurisdiction?.source.tokenId ?? 0));
        const targetTokenIds = expected?.targetTokenIds?.length
          ? expected.targetTokenIds
          : normalizePositiveTokenIds(specs.map(spec => spec.crossJurisdiction?.target.tokenId ?? 0));
        return {
          pairId,
          offers,
          ready: expectedOffers > 0 && offers > 0,
          depthReady: expectedOffers > 0 && offers >= expectedOffers,
          expectedOffers,
          sourceTokenIds,
          targetTokenIds,
        };
      })
      .sort((left, right) => compareStableText(left.pairId, right.pairId));
    const offers = group.specs.filter(spec => hasFinalizedMarketMakerCrossOffer(env, spec)).length;
    const expectedOffers = pairs.reduce((sum, pair) => sum + pair.expectedOffers, 0);
    const blockers = [
      describeMarketMakerAccountBlocker(env, 'source-mm-hub', group.sourceMmEntityId, group.sourceHubEntityId),
      describeMarketMakerAccountBlocker(env, 'target-mm-hub', group.targetMmEntityId, group.targetHubEntityId),
    ].filter((blocker): blocker is MarketMakerCrossRouteBlocker => Boolean(blocker));
    return {
      sourceJurisdiction: group.sourceJurisdiction,
      targetJurisdiction: group.targetJurisdiction,
      sourceMmEntityId: group.sourceMmEntityId,
      targetMmEntityId: group.targetMmEntityId,
      sourceHubEntityId: group.sourceHubEntityId,
      targetHubEntityId: group.targetHubEntityId,
      offers,
      ready: pairs.length > 0 && pairs.every(pair => pair.ready),
      depthReady: expectedOffers > 0 && offers >= expectedOffers && pairs.every(pair => pair.depthReady),
      blockers,
      pairs,
    };
  }).sort((left, right) =>
    compareStableText(left.sourceJurisdiction, right.sourceJurisdiction) ||
    compareStableText(left.targetJurisdiction, right.targetJurisdiction) ||
    compareStableText(left.sourceHubEntityId, right.sourceHubEntityId) ||
    compareStableText(left.targetHubEntityId, right.targetHubEntityId),
  );

  const expectedOffersPerRoute = expectedRouteCount > 0
    ? Math.max(0, ...Array.from(routeGroups.values()).map(group =>
        Math.max(group.specs.length, group.expectedPairs.size * MARKET_MAKER_CROSS_LEVELS_PER_PAIR),
      ))
    : 0;
  const expectedOffersPerPair = expectedRouteCount > 0 ? Math.max(MARKET_MAKER_CROSS_LEVELS_PER_PAIR, ...Array.from(routeGroups.values()).flatMap((group) => {
    const counts = new Map<string, number>();
    for (const spec of group.specs) counts.set(spec.pairId, (counts.get(spec.pairId) || 0) + 1);
    for (const pairId of group.expectedPairs.keys()) counts.set(pairId, Math.max(counts.get(pairId) || 0, MARKET_MAKER_CROSS_LEVELS_PER_PAIR));
    return Array.from(counts.values());
  })) : 0;

  return {
    applicable: expectedRouteCount > 0,
    ok: expectedRouteCount > 0 && routes.length >= expectedRouteCount && routes.every(route => route.ready),
    expectedRoutes: expectedRouteCount,
    expectedOffersPerRoute,
    expectedOffersPerPair,
    routes,
  };
};

const getCrossRouteStatus = (
  env: Env,
  entityId: string,
  orderId: string,
): string | null => {
  const route = getEntityReplicaById(env, entityId)?.state?.crossJurisdictionSwaps?.get(orderId);
  return route?.status ? String(route.status) : null;
};

const hasCrossBookOrder = (env: Env, route: CrossJurisdictionSwapRoute): boolean => {
  const bookOwnerEntityId = crossJurisdictionBookOwnerRef(route);
  const bookOwner = bookOwnerEntityId ? getEntityReplicaById(env, bookOwnerEntityId)?.state : null;
  return Boolean(bookOwner && hasCrossJurisdictionBookOrder(bookOwner, route));
};

const buildMarketMakerCrossDebugSummary = (
  env: Env,
  contexts: MarketMakerEntityContext[],
  visibleHubs: HubProfile[],
  tokenIdsByContext: MarketMakerTokenIdsByContext,
) => Array.from(buildExpectedMarketMakerCrossRouteGroups(env, contexts, visibleHubs, tokenIdsByContext).values())
  .map((group) => {
    const finalized = group.specs.filter(spec => hasFinalizedMarketMakerCrossOffer(env, spec)).length;
    const visible = group.specs.filter(spec => hasMarketMakerCrossOffer(env, spec)).length;
    const sourceRoutes = group.specs.filter(spec => {
      const route = spec.crossJurisdiction;
      return route ? hasCrossRouteRegistered(env, route.source.entityId, route.orderId) : false;
    }).length;
    const sourceHubRoutes = group.specs.filter(spec => {
      const route = spec.crossJurisdiction;
      return route ? hasCrossRouteRegistered(env, route.source.counterpartyEntityId, route.orderId) : false;
    }).length;
    const targetHubRoutes = group.specs.filter(spec => {
      const route = spec.crossJurisdiction;
      return route ? hasCrossRouteRegistered(env, route.target.entityId, route.orderId) : false;
    }).length;
    const targetRoutes = group.specs.filter(spec => {
      const route = spec.crossJurisdiction;
      return route ? hasCrossRouteRegistered(env, route.target.counterpartyEntityId, route.orderId) : false;
    }).length;
    const bookOrders = group.specs.filter(spec => {
      const route = spec.crossJurisdiction;
      return route ? hasCrossBookOrder(env, route) : false;
    }).length;
    const missingFinalized = group.specs
      .filter(spec => !hasFinalizedMarketMakerCrossOffer(env, spec))
      .slice(0, 8)
      .map((spec) => {
        const route = spec.crossJurisdiction!;
        return {
          orderId: route.orderId,
          pairId: spec.pairId,
          sourceStatus: getCrossRouteStatus(env, route.source.entityId, route.orderId),
          sourceHubStatus: getCrossRouteStatus(env, route.source.counterpartyEntityId, route.orderId),
          targetHubStatus: getCrossRouteStatus(env, route.target.entityId, route.orderId),
          targetStatus: getCrossRouteStatus(env, route.target.counterpartyEntityId, route.orderId),
          bookOrder: hasCrossBookOrder(env, route),
        };
      });
    return {
      sourceJurisdiction: group.sourceJurisdiction,
      targetJurisdiction: group.targetJurisdiction,
      sourceHubEntityId: group.sourceHubEntityId,
      targetHubEntityId: group.targetHubEntityId,
      expected: group.specs.length,
      finalized,
      visible,
      sourceRoutes,
      sourceHubRoutes,
      targetHubRoutes,
      targetRoutes,
      bookOrders,
      missingFinalized,
    };
  })
  .sort((left, right) =>
    compareStableText(left.sourceJurisdiction, right.sourceJurisdiction) ||
    compareStableText(left.targetJurisdiction, right.targetJurisdiction) ||
    compareStableText(left.sourceHubEntityId, right.sourceHubEntityId) ||
    compareStableText(left.targetHubEntityId, right.targetHubEntityId),
  );

const buildDeferredMarketMakerCrossHealth = (applicable: boolean): MarketMakerHealth['cross'] => ({
  applicable,
  ok: !applicable,
  expectedRoutes: 0,
  expectedOffersPerRoute: 0,
  expectedOffersPerPair: 0,
  routes: [],
});

const maintainMarketMakerCrossQuotes = async (
  env: Env,
  sourceContext: MarketMakerEntityContext,
  targetContext: MarketMakerEntityContext,
  sourceHubs: HubProfile[],
  targetHubs: HubProfile[],
  sourceTokenIds: number[],
  targetTokenIds: number[],
  maxOffersPerAccount = Math.max(2, Math.floor(MARKET_MAKER_OFFERS_PER_ACCOUNT_PER_TICK / 2)),
  maxNewOffersTotal = Math.max(2, Math.floor(MARKET_MAKER_MAX_NEW_OFFERS_PER_TICK / 2)),
  connectivityBudget: MarketMakerConnectivityBudget = { remainingTxs: MARKET_MAKER_CONNECTIVITY_MAX_TXS_PER_TICK },
  shouldContinue: () => boolean = () => true,
  maxSourceHubGroups = Number.MAX_SAFE_INTEGER,
  emitBootstrapWaveEvents = false,
): Promise<boolean> => {
  const startedAt = Date.now();
  const direction = `${sourceContext.jurisdictionName}->${targetContext.jurisdictionName}`;
  if (
    sourceHubs.length === 0 ||
    targetHubs.length === 0 ||
    sourceTokenIds.length < HUB_REQUIRED_TOKEN_COUNT ||
    targetTokenIds.length < HUB_REQUIRED_TOKEN_COUNT ||
    sourceContext.entityId === targetContext.entityId ||
    sameJurisdiction(sourceContext, targetContext)
  ) {
    return false;
  }
  if (!shouldContinue()) return false;

  const sourceHubEntityIds = sourceHubs.map(profile => profile.entityId);
  const targetHubEntityIds = targetHubs.map(profile => profile.entityId);
  if (await ensureMarketMakerHubConnectivity(
    env,
    sourceContext.entityId,
    sourceContext.signerId,
    sourceHubEntityIds,
    sourceTokenIds,
    connectivityBudget,
  )) return true;
  if (!shouldContinue()) return false;
  if (await ensureMarketMakerHubConnectivity(
    env,
    targetContext.entityId,
    targetContext.signerId,
    targetHubEntityIds,
    targetTokenIds,
    connectivityBudget,
  )) return true;
  if (!shouldContinue()) return false;

  const desiredOffers = buildMarketMakerCrossOfferSpecs(
    env,
    sourceContext,
    targetContext,
    sourceHubs,
    targetHubs,
    sourceTokenIds,
    targetTokenIds,
  );
  if (desiredOffers.length === 0) return false;

  const grouped = new Map<string, MarketMakerOfferSpec[]>();
  for (const spec of desiredOffers) {
    const arr = grouped.get(spec.hubEntityId) ?? [];
    arr.push(spec);
    grouped.set(spec.hubEntityId, arr);
  }

  const entityInputsByEntitySigner = new Map<string, EntityInput>();
  const pendingCrossRequestOrderIdsBySourceEntity = new Map<string, Set<string>>();
  const getPendingCrossRequestOrderIds = (entityId: string): Set<string> => {
    const normalizedEntityId = normalizeEntityRef(entityId);
    const cached = pendingCrossRequestOrderIdsBySourceEntity.get(normalizedEntityId);
    if (cached) return cached;
    const ids = collectPendingCrossRequestOrderIds(env, normalizedEntityId);
    pendingCrossRequestOrderIdsBySourceEntity.set(normalizedEntityId, ids);
    return ids;
  };
  let remainingNewOffers = Math.max(
    1,
    Math.floor(maxNewOffersTotal),
  );
  let remainingSourceHubGroups = Math.max(1, Math.floor(maxSourceHubGroups));
  const groupedEntries = Array.from(grouped.entries())
    .sort((left, right) =>
      countCrossPairCoverageGaps(env, right[1]) -
      countCrossPairCoverageGaps(env, left[1]) ||
      countCrossSpecBootstrapProgress(env, left[1], getPendingCrossRequestOrderIds) -
      countCrossSpecBootstrapProgress(env, right[1], getPendingCrossRequestOrderIds) ||
      compareStableText(left[0], right[0]),
    );
  if (emitBootstrapWaveEvents) {
    emitMarketMakerCrossBootstrapWaveEvent('cross-wave-start', {
      direction,
      desiredOffers: desiredOffers.length,
      groupedSourceHubs: groupedEntries.length,
      remainingNewOffers,
      remainingSourceHubGroups,
    });
  }

  for (const [sourceHubEntityId, specs] of groupedEntries) {
    await yieldMarketMakerApi();
    if (!shouldContinue()) return false;
    const account = getAccountMachine(env, sourceContext.entityId, sourceHubEntityId);
    if (!account) continue;
    if (String(account.status || 'active') !== 'active') continue;
    if (!isAccountConsensusReady(account)) continue;

    const existingOfferIds = collectOfferIdsForAccount(account);
    if (remainingNewOffers <= 0) continue;
    const remainingOpenSlots = Math.max(0, LIMITS.MAX_ACCOUNT_SWAP_OFFERS - existingOfferIds.size);
    const visibleByPair = countCrossSpecVisibleOffersByPair(env, specs);
    const perAccountLimit = Math.max(1, Math.floor(maxOffersPerAccount));
    const allowedNewOffers = Math.min(
      perAccountLimit,
      remainingOpenSlots,
      remainingNewOffers,
    );
    if (allowedNewOffers <= 0) continue;

    const progressByPair = countCrossSpecBootstrapProgressByPair(env, specs, getPendingCrossRequestOrderIds);
    const missingCandidates = specs
      .filter(spec =>
        spec.crossJurisdiction &&
        !hasCrossSpecBootstrapProgress(env, spec, getPendingCrossRequestOrderIds),
      )
      .filter(spec => {
        const route = spec.crossJurisdiction!;
        const targetAccount = getAccountMachine(env, targetContext.entityId, route.target.entityId);
        if (!targetAccount) return false;
        if (String(targetAccount.status || 'active') !== 'active') return false;
        if (!isAccountConsensusReady(targetAccount)) return false;
        return (
          !hasCrossRouteRegistered(env, route.source.counterpartyEntityId, route.orderId) &&
          !getPendingCrossRequestOrderIds(route.source.entityId).has(route.orderId) &&
          hasPairMutualCredit(env, sourceContext.entityId, route.source.counterpartyEntityId, route.source.tokenId, route.source.amount) &&
          hasPairMutualCredit(env, targetContext.entityId, route.target.entityId, route.target.tokenId, route.target.amount)
        );
      })
      .sort((left, right) =>
        (visibleByPair.get(left.pairId) || 0) - (visibleByPair.get(right.pairId) || 0) ||
        (progressByPair.get(left.pairId) || 0) - (progressByPair.get(right.pairId) || 0) ||
        getMarketMakerOfferLevel(left) - getMarketMakerOfferLevel(right) ||
        compareStableText(left.pairId, right.pairId) ||
        compareStableText(left.offerId, right.offerId),
      );
    if (emitBootstrapWaveEvents) {
      emitMarketMakerCrossBootstrapWaveEvent('cross-wave-source-hub', {
        direction,
        sourceHubEntityId,
        candidateCount: missingCandidates.length,
        remainingNewOffers,
        remainingSourceHubGroups,
        durationMs: Date.now() - startedAt,
      });
    }
    const missing: MarketMakerOfferSpec[] = [];
    for (const spec of missingCandidates) {
      if (missing.length >= allowedNewOffers) break;
      missing.push(spec);
    }
    if (missing.length === 0) continue;
    if (emitBootstrapWaveEvents) {
      emitMarketMakerCrossBootstrapWaveEvent('cross-wave-select', {
        direction,
        sourceHubEntityId,
        candidateCount: missingCandidates.length,
        selectedCount: missing.length,
        remainingNewOffers,
        remainingSourceHubGroups,
        durationMs: Date.now() - startedAt,
      });
    }

    for (const spec of missing) {
      const route = spec.crossJurisdiction!;
      pushMarketMakerEntityTx(
        entityInputsByEntitySigner,
        route.source.entityId,
        sourceContext.signerId,
        {
          type: 'requestCrossJurisdictionSwap' as const,
          data: { route: spec.crossJurisdiction! },
        },
      );
    }
    remainingNewOffers -= missing.length;
    remainingSourceHubGroups -= 1;
    if (remainingSourceHubGroups <= 0) break;
  }

  const entityInputs = Array.from(entityInputsByEntitySigner.values());
  const nonEmptyEntityInputs = entityInputs.filter(input => (input.entityTxs?.length || 0) > 0);
  if (nonEmptyEntityInputs.length > 0) {
    if (!shouldContinue()) return false;
    if (emitBootstrapWaveEvents) {
      emitMarketMakerCrossBootstrapWaveEvent('cross-wave-enqueue', {
        direction,
        enqueuedEntityInputs: nonEmptyEntityInputs.length,
        enqueuedEntityTxs: nonEmptyEntityInputs.reduce((sum, input) => sum + (input.entityTxs?.length || 0), 0),
        durationMs: Date.now() - startedAt,
      });
    }
    enqueueRuntimeInput(env, {
      runtimeTxs: [],
      entityInputs: nonEmptyEntityInputs,
    });
    await yieldMarketMakerApi();
    return true;
  }
  return false;
};

export const getMarketMakerHealth = (
  env: Env,
  mmEntityId: string | null,
  hubEntityIds: string[],
  tokenIds: number[],
  crossOptions?: {
    contexts: MarketMakerEntityContext[];
    visibleHubs: HubProfile[];
    tokenIdsByContext: MarketMakerTokenIdsByContext;
  },
  crossOverride?: MarketMakerHealth['cross'],
): MarketMakerHealth => {
  const pairs = buildDefaultEntitySwapPairs(tokenIds);
  const desiredSpecs = buildMarketMakerOfferSpecs(hubEntityIds, tokenIds);
  const cross = crossOverride ?? (crossOptions
    ? buildMarketMakerCrossHealth(env, crossOptions.contexts, crossOptions.visibleHubs, crossOptions.tokenIdsByContext)
    : {
        applicable: false,
        ok: true,
        expectedRoutes: 0,
        expectedOffersPerRoute: 0,
        expectedOffersPerPair: 0,
        routes: [],
      });
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
    const account = getAccountMachine(env, mmEntityId, hubEntityId);
    const blocker = describeMarketMakerSameHubBlocker(env, mmEntityId, hubEntityId);
    const accountReady = !blocker && isAccountConsensusReady(account);
    const offers = countCommittedMarketMakerOffersForHub(env, mmEntityId, hubEntityId);
    const expectedHubOffers = expectedOffersByHub.get(hubEntityId) || 0;
    const pairHealth = pairs.map((pair) => {
      const pairOffers = countCommittedMarketMakerOffersForHubPair(env, mmEntityId, hubEntityId, pair);
      const expectedPairOffers = expectedOffersByHubPair.get(`${hubEntityId}:${pair.pairId}`) || 0;
      return {
        pairId: pair.pairId,
        offers: pairOffers,
        ready: accountReady && expectedPairOffers > 0 && pairOffers > 0,
        depthReady: accountReady && expectedPairOffers > 0 && pairOffers >= expectedPairOffers,
        expectedOffers: expectedPairOffers,
      };
    });
    return {
      hubEntityId,
      offers,
      ready: accountReady && expectedHubOffers > 0 && pairHealth.every((pair) => pair.ready),
      depthReady: accountReady && expectedHubOffers > 0 && offers >= expectedHubOffers && pairHealth.every((pair) => pair.depthReady),
      blockers: blocker ? [blocker] : [],
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

  const hubsDepthReady = hubs.length > 0 && hubs.every((entry) => entry.depthReady);
  const crossDepthReady = !cross.applicable || (
    cross.expectedRoutes > 0 &&
    cross.routes.length >= cross.expectedRoutes &&
    cross.routes.every((route) => route.depthReady)
  );

  return {
    enabled: true,
    ok: hubsDepthReady && crossDepthReady,
    entityId: mmEntityId,
    connectivity,
    expectedOffersPerHub,
    expectedOffersPerPair,
    hubs,
    cross,
  };
};

const isMarketMakerDepthComplete = (health: MarketMakerHealth | null): boolean => {
  if (!health?.enabled || !health.ok) return false;
  if (health.hubs.length === 0 || !health.hubs.every((hub) => hub.depthReady)) return false;
  if (!health.cross.applicable) return true;
  return (
    health.cross.expectedRoutes > 0 &&
    health.cross.routes.length >= health.cross.expectedRoutes &&
    health.cross.routes.every((route) => route.depthReady)
  );
};

const isMarketMakerSameDepthComplete = (health: MarketMakerHealth | null): boolean =>
  Boolean(health?.enabled && health.hubs.length > 0 && health.hubs.every((hub) => hub.depthReady));

const canonicalJurisdictionRole = (
  value: Pick<MarketMakerEntityContext | HubProfile, 'chainId' | 'jurisdictionName'>,
): string => {
  const chainId = Number(value.chainId || 0);
  const name = String(value.jurisdictionName || '').trim().toLowerCase() || 'unknown';
  return `j:${chainId}:${name}`;
};

const canonicalMarketMakerRole = (context: MarketMakerEntityContext): string =>
  `mm:${canonicalJurisdictionRole(context)}`;

const canonicalHubRole = (profile: HubProfile): string =>
  `hub:${canonicalJurisdictionRole(profile)}:${hubBaseName(profile.name)}`;

const buildUniqueRoleMap = <T>(
  entries: T[],
  getId: (entry: T) => string,
  getRole: (entry: T) => string,
  label: string,
): Map<string, string> => {
  const byId = new Map<string, string>();
  const seenRoles = new Set<string>();
  for (const entry of entries) {
    const id = normalizeEntityRef(getId(entry));
    const role = getRole(entry);
    if (!id) throw new Error(`MARKET_MAKER_BOOTSTRAP_FINGERPRINT_MISSING_${label}_ID`);
    if (seenRoles.has(role)) {
      throw new Error(`MARKET_MAKER_BOOTSTRAP_FINGERPRINT_DUPLICATE_${label}_ROLE:${role}`);
    }
    seenRoles.add(role);
    byId.set(id, role);
  }
  return byId;
};

const requireCanonicalRole = (roles: Map<string, string>, entityId: string, label: string): string => {
  const role = roles.get(normalizeEntityRef(entityId));
  if (!role) throw new Error(`MARKET_MAKER_BOOTSTRAP_FINGERPRINT_UNKNOWN_${label}:${entityId}`);
  return role;
};

const canonicalSwapOfferEconomics = (offer: SwapOffer): Record<string, unknown> => ({
  giveTokenId: Number(offer.giveTokenId),
  giveAmount: String(offer.giveAmount),
  wantTokenId: Number(offer.wantTokenId),
  wantAmount: String(offer.wantAmount),
  priceTicks: offer.priceTicks === undefined ? null : String(offer.priceTicks),
  timeInForce: Number(offer.timeInForce ?? 0),
  minFillRatio: Number(offer.minFillRatio ?? 0),
  quantizedGive: offer.quantizedGive === undefined ? null : String(offer.quantizedGive),
  quantizedWant: offer.quantizedWant === undefined ? null : String(offer.quantizedWant),
});

const parseMarketMakerSameOfferId = (
  offerId: string,
): { baseTokenId: number; quoteTokenId: number; side: 'ask' | 'bid'; level: number } => {
  const match = String(offerId || '').match(/^mm-[^-]+-(\d+)-(\d+)-(ask|bid)-(\d+)$/);
  if (!match) throw new Error(`MARKET_MAKER_BOOTSTRAP_FINGERPRINT_UNPARSEABLE_SAME_OFFER:${offerId}`);
  return {
    baseTokenId: Number(match[1]),
    quoteTokenId: Number(match[2]),
    side: match[3] as 'ask' | 'bid',
    level: Number(match[4]),
  };
};

const parseMarketMakerCrossOfferId = (
  offerId: string,
): { sourceTokenId: number; targetTokenId: number; side: 'sell'; level: number } => {
  const match = String(offerId || '').match(/^mmx-[^-]+-[^-]+-(\d+)-(\d+)-sell-(\d+)$/);
  if (!match) throw new Error(`MARKET_MAKER_BOOTSTRAP_FINGERPRINT_UNPARSEABLE_CROSS_OFFER:${offerId}`);
  return {
    sourceTokenId: Number(match[1]),
    targetTokenId: Number(match[2]),
    side: 'sell',
    level: Number(match[3]),
  };
};

const collectCommittedMarketMakerOfferFingerprintsForHub = (
  env: Env,
  mmEntityId: string,
  hubEntityId: string,
  hubRole: string,
): Array<Record<string, unknown>> => {
  const account = getAccountMachine(env, mmEntityId, hubEntityId);
  const prefix = `mm-${hubEntityId.slice(-6).toLowerCase()}-`;
  return Array.from(account?.swapOffers?.entries?.() ?? [])
    .filter(([offerId]) => String(offerId).startsWith(prefix))
    .map(([offerId, offer]) => {
      const parsed = parseMarketMakerSameOfferId(String(offerId));
      return {
        offer: `mm:${hubRole}:${parsed.baseTokenId}/${parsed.quoteTokenId}:${parsed.side}:${parsed.level}`,
        hub: hubRole,
        baseTokenId: parsed.baseTokenId,
        quoteTokenId: parsed.quoteTokenId,
        side: parsed.side,
        level: parsed.level,
        ...canonicalSwapOfferEconomics(offer),
      };
    })
    .sort((left, right) => compareStableText(String(left.offer), String(right.offer)));
};

const collectCommittedMarketMakerCrossOfferFingerprints = (
  env: Env,
  contexts: MarketMakerEntityContext[],
  visibleHubs: HubProfile[],
  tokenIdsByContext: MarketMakerTokenIdsByContext,
  contextRoles: Map<string, string>,
  hubRoles: Map<string, string>,
): Array<Record<string, unknown>> => {
  const committed: Array<Record<string, unknown>> = [];
  for (const sourceContext of contexts) {
    const sourceHubs = visibleHubs.filter(profile => sameJurisdiction(sourceContext, profile));
    if (sourceHubs.length === 0) continue;
    const sourceTokenIds = getMarketMakerTokenIds(tokenIdsByContext, sourceContext);
    for (const targetContext of contexts) {
      if (sourceContext.entityId === targetContext.entityId || sameJurisdiction(sourceContext, targetContext)) continue;
      const targetHubs = visibleHubs.filter(profile => sameJurisdiction(targetContext, profile));
      if (targetHubs.length === 0) continue;
      const specs = buildMarketMakerCrossOfferSpecs(
        env,
        sourceContext,
        targetContext,
        sourceHubs,
        targetHubs,
        sourceTokenIds,
        getMarketMakerTokenIds(tokenIdsByContext, targetContext),
      );
      for (const spec of specs) {
        if (!spec.crossJurisdiction || !hasFinalizedMarketMakerCrossOffer(env, spec)) continue;
        const offer = getCommittedSourceAccountCrossOffer(env, spec.crossJurisdiction);
        if (!offer) continue;
        const parsed = parseMarketMakerCrossOfferId(spec.offerId);
        const sourceMmRole = requireCanonicalRole(contextRoles, spec.crossJurisdiction.source.entityId, 'MM');
        const targetMmRole = requireCanonicalRole(contextRoles, spec.crossJurisdiction.target.counterpartyEntityId, 'MM');
        const sourceHubRole = requireCanonicalRole(hubRoles, spec.crossJurisdiction.source.counterpartyEntityId, 'HUB');
        const targetHubRole = requireCanonicalRole(hubRoles, spec.crossJurisdiction.target.entityId, 'HUB');
        committed.push({
          offer: `mmx:${sourceMmRole}->${targetMmRole}:${sourceHubRole}->${targetHubRole}:${parsed.sourceTokenId}/${parsed.targetTokenId}:${parsed.side}:${parsed.level}`,
          sourceMm: sourceMmRole,
          targetMm: targetMmRole,
          sourceHub: sourceHubRole,
          targetHub: targetHubRole,
          sourceTokenId: parsed.sourceTokenId,
          targetTokenId: parsed.targetTokenId,
          side: parsed.side,
          level: parsed.level,
          routeStatus: spec.crossJurisdiction.status,
          ...canonicalSwapOfferEconomics(offer),
        });
      }
    }
  }
  return committed.sort((left, right) =>
    compareStableText(String(left['offer']), String(right['offer'])),
  );
};

export const buildMarketMakerBootstrapFingerprint = (
  env: Env,
  contexts: MarketMakerEntityContext[],
  visibleHubs: HubProfile[],
  tokenIdsByContext: MarketMakerTokenIdsByContext,
  health: MarketMakerHealth,
): { hash: string; payload: Record<string, unknown> } => {
  const contextRoles = buildUniqueRoleMap(
    contexts,
    context => context.entityId,
    canonicalMarketMakerRole,
    'MM',
  );
  const hubRoles = buildUniqueRoleMap(
    visibleHubs,
    profile => profile.entityId,
    canonicalHubRole,
    'HUB',
  );
  const payload = {
    schema: 'market-maker-bootstrap-v1',
    expectedOffersPerHub: health.expectedOffersPerHub,
    expectedOffersPerPair: health.expectedOffersPerPair,
    marketMakers: contexts
      .map(context => ({
        role: requireCanonicalRole(contextRoles, context.entityId, 'MM'),
        chainId: Number(context.chainId || 0),
        jurisdictionName: String(context.jurisdictionName || '').trim().toLowerCase(),
        tokenIds: getMarketMakerTokenIds(tokenIdsByContext, context),
      }))
      .sort((left, right) => compareStableText(left.role, right.role)),
    hubs: health.hubs
      .map(hub => ({
        role: requireCanonicalRole(hubRoles, hub.hubEntityId, 'HUB'),
        offers: hub.offers,
        offersCommitted: health.entityId
          ? collectCommittedMarketMakerOfferFingerprintsForHub(
              env,
              health.entityId,
              hub.hubEntityId,
              requireCanonicalRole(hubRoles, hub.hubEntityId, 'HUB'),
            )
          : [],
        pairs: hub.pairs.map(pair => ({
          pairId: pair.pairId,
          offers: pair.offers,
          expectedOffers: pair.expectedOffers,
        })).sort((left, right) => compareStableText(left.pairId, right.pairId)),
      }))
      .sort((left, right) => compareStableText(left.role, right.role)),
    cross: {
      applicable: health.cross.applicable,
      expectedRoutes: health.cross.expectedRoutes,
      expectedOffersPerRoute: health.cross.expectedOffersPerRoute,
      expectedOffersPerPair: health.cross.expectedOffersPerPair,
      routes: health.cross.routes
        .map(route => ({
          sourceMm: requireCanonicalRole(contextRoles, route.sourceMmEntityId, 'MM'),
          targetMm: requireCanonicalRole(contextRoles, route.targetMmEntityId, 'MM'),
          sourceHub: requireCanonicalRole(hubRoles, route.sourceHubEntityId, 'HUB'),
          targetHub: requireCanonicalRole(hubRoles, route.targetHubEntityId, 'HUB'),
          offers: route.offers,
          pairs: route.pairs.map(pair => ({
            sourceTokenIds: pair.sourceTokenIds,
            targetTokenIds: pair.targetTokenIds,
            offers: pair.offers,
            expectedOffers: pair.expectedOffers,
          })).sort((left, right) =>
            compareStableText(left.sourceTokenIds.join(','), right.sourceTokenIds.join(',')) ||
            compareStableText(left.targetTokenIds.join(','), right.targetTokenIds.join(',')),
          ),
        }))
        .sort((left, right) =>
          compareStableText(left.sourceMm, right.sourceMm) ||
          compareStableText(left.targetMm, right.targetMm) ||
          compareStableText(left.sourceHub, right.sourceHub) ||
          compareStableText(left.targetHub, right.targetHub),
        ),
      offersCommitted: collectCommittedMarketMakerCrossOfferFingerprints(
        env,
        contexts,
        visibleHubs,
        tokenIdsByContext,
        contextRoles,
        hubRoles,
      ),
    },
  };
  const encoded = safeStringify(payload);
  return {
    hash: createHash('sha256').update(encoded).digest('hex'),
    payload,
  };
};

export const buildMarketMakerBootstrapEntityStateHash = (env: Env): string => {
  const payload = {
    schema: 'market-maker-bootstrap-entity-state-v1',
    entities: computeCanonicalEntityHashesFromEnv(env),
  };
  return createHash('sha256').update(safeStringify(payload)).digest('hex');
};

const assertMarketMakerBootstrapFinalized = (
  env: Env,
  health: MarketMakerHealth | null,
): MarketMakerHealth => {
  const blockers: unknown[] = [];
  if (!health || !isMarketMakerDepthComplete(health)) {
    blockers.push({
      scope: 'health',
      enabled: health?.enabled ?? false,
      ok: health?.ok ?? false,
      expectedOffersPerHub: health?.expectedOffersPerHub ?? null,
      hubs: health?.hubs.map(hub => ({
        hubEntityId: hub.hubEntityId,
        offers: hub.offers,
        depthReady: hub.depthReady,
        blockers: hub.blockers,
      })) ?? [],
      cross: {
        applicable: health?.cross.applicable ?? null,
        ok: health?.cross.ok ?? null,
        expectedRoutes: health?.cross.expectedRoutes ?? null,
        routes: health?.cross.routes.map(route => ({
          sourceHubEntityId: route.sourceHubEntityId,
          targetHubEntityId: route.targetHubEntityId,
          offers: route.offers,
          depthReady: route.depthReady,
          blockers: route.blockers,
        })) ?? [],
      },
    });
  }
  for (const hub of health?.hubs ?? []) {
    for (const blocker of hub.blockers) {
      blockers.push({ scope: 'same-chain-account', hubEntityId: hub.hubEntityId, ...blocker });
    }
  }
  for (const route of health?.cross.routes ?? []) {
    for (const blocker of route.blockers) {
      blockers.push({
        scope: 'cross-account',
        sourceHubEntityId: route.sourceHubEntityId,
        targetHubEntityId: route.targetHubEntityId,
        ...blocker,
      });
    }
  }
  if (hasMarketMakerRuntimeBacklog(env)) {
    blockers.push({
      scope: 'runtime-backlog',
      ...getMarketMakerRuntimeBacklogSnapshot(env),
    });
  }
  if (blockers.length > 0) {
    throw new Error(`MARKET_MAKER_BOOTSTRAP_INCOMPLETE: ${safeStringify(blockers)}`);
  }
  if (!health) {
    throw new Error('MARKET_MAKER_BOOTSTRAP_INCOMPLETE: null health');
  }
  return health;
};

const hasMarketMakerAccountBacklog = (
  env: Env,
  entityId: string,
  hubEntityId: string,
): boolean => {
  const account = getAccountMachine(env, entityId, hubEntityId);
  return Boolean(account?.pendingFrame) || Number(account?.mempool?.length || 0) > 0;
};

const hasMarketMakerRuntimeBacklog = (env: Env): boolean => {
  const runtimeMempool = env.runtimeMempool;
  return Boolean(env.runtimeState?.processingPromise) ||
    Number(runtimeMempool?.runtimeTxs?.length || 0) > 0 ||
    Number(runtimeMempool?.entityInputs?.length || 0) > 0;
};

const getMarketMakerRuntimeBacklogSnapshot = (
  env: Env,
  options: { includeQueuedEntityInputs?: boolean } = {},
): Record<string, unknown> => {
  const snapshot: Record<string, unknown> = {
    processing: Boolean(env.runtimeState?.processingPromise),
    runtimeTxs: Number(env.runtimeMempool?.runtimeTxs?.length || 0),
    entityInputs: Number(env.runtimeMempool?.entityInputs?.length || 0),
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

const run = async (): Promise<void> => {
  if (resolvedArgs.dbPath) process.env['XLN_DB_PATH'] = resolvedArgs.dbPath;

  const env = await main(resolvedArgs.seed);
  configureMarketMakerStorage(env);
  configureMarketMakerRuntimeLogging(env);
  prewarmLocalMarketMakerSignerKeys();
  startRuntimeLoop(env, {
    tickDelayMs: MARKET_MAKER_RUNTIME_TICK_DELAY_MS,
    maxEntityInputsPerFrame: MARKET_MAKER_MAX_ENTITY_INPUTS_PER_RUNTIME_FRAME,
  });
  let startupPhase = 'boot';
  let activeMmEntityId: string | null = null;
  let mmContexts: MarketMakerEntityContext[] = [];
  let mmTokenIdsByContext: Map<string, number[]> = new Map();
  let cachedMarketMakerHealth: MarketMakerHealth | null = null;
  let bootstrapReadyHash: string | null = null;
  let bootstrapRuntimeStateHash: string | null = null;
  let bootstrapEntityStateHash: string | null = null;
  let bootstrapReadyAt: number | null = null;
  let bootstrapCrossStarted = false;
  let bootstrapReadySnapshotPersisted = false;
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

  const summarizeMarketMakerHealthForDebug = (health: MarketMakerHealth | null): Record<string, unknown> | null => {
    if (!health) return null;
    const accountBlockers = [
      ...health.hubs.flatMap(hub => hub.blockers),
      ...health.cross.routes.flatMap(route => route.blockers),
    ].slice(0, 16);
    return {
      ok: health.ok,
      offers: health.hubs.map(hub => hub.offers),
      hubBlockers: health.hubs.map(hub => hub.blockers.length),
      cross: {
        ok: health.cross.ok,
        expectedRoutes: health.cross.expectedRoutes,
        offers: health.cross.routes.map(route => route.offers),
        blockers: health.cross.routes.map(route => route.blockers.length),
      },
      account: accountBlockers,
      pendingFrame: accountBlockers.some(blocker =>
        typeof blocker === 'object' &&
        blocker !== null &&
        (blocker as { pendingFrame?: unknown }).pendingFrame === true,
      ),
    };
  };

  const emitBootstrapDebugEvent = (event: string, fields: Record<string, unknown> = {}): void => {
    emitMarketMakerBootstrapDebugEvent(event, {
      stage: startupPhase,
      entity: activeMmEntityId,
      runtimeId: String(env.runtimeId || ''),
      height: env.height,
      backlog: getMarketMakerRuntimeBacklogSnapshot(env, { includeQueuedEntityInputs: true }),
      ...fields,
    });
  };

  const buildMarketMakerHealthSnapshot = (options: { includeCross?: boolean } = {}): MarketMakerHealth | null => {
    const primaryContext = mmContexts[0] ?? null;
    const activeEntityId = activeMmEntityId;
    if (!activeEntityId || !primaryContext) return null;
    const visibleHubs = readVisibleHubProfiles(env).filter(profile => sameJurisdiction(primaryContext, profile));
    const allVisibleHubs = readVisibleHubProfiles(env, true);
    const includeCross = options.includeCross !== false;
    const crossApplicable = mmContexts.length > 1 && allVisibleHubs.some(profile =>
      mmContexts.some(context => sameJurisdiction(context, profile)) &&
      !sameJurisdiction(primaryContext, profile),
    );
    return getMarketMakerHealth(
      env,
      primaryContext.entityId,
      visibleHubs.map(profile => profile.entityId),
      getMarketMakerTokenIds(mmTokenIdsByContext, primaryContext),
      includeCross
        ? {
            contexts: mmContexts,
            visibleHubs: allVisibleHubs,
            tokenIdsByContext: mmTokenIdsByContext,
          }
        : undefined,
      includeCross ? undefined : buildDeferredMarketMakerCrossHealth(crossApplicable),
    );
  };

  const publishMarketMakerHealthSnapshot = (options: { includeCross?: boolean } = {}): MarketMakerHealth | null => {
    const health = buildMarketMakerHealthSnapshot(options);
    if (health) cachedMarketMakerHealth = health;
    return health;
  };

  const publishBootstrapHealthSnapshot = (): MarketMakerHealth | null => {
    const sameHealth = publishMarketMakerHealthSnapshot({ includeCross: false });
    const sameDepthComplete =
      isMarketMakerSameDepthComplete(sameHealth) &&
      isAllSameQuoteDepthComplete(readVisibleHubProfiles(env, true));
    if (!bootstrapCrossStarted && !sameDepthComplete) {
      return sameHealth;
    }
    return publishMarketMakerHealthSnapshot({ includeCross: true });
  };

  const buildAccountStatusDebug = (
    entityId: string,
    counterpartyEntityId: string,
    tokenIds: number[],
  ): Record<string, unknown> => {
    const account = getAccountMachine(env, entityId, counterpartyEntityId);
    const replica = getEntityReplicaById(env, entityId);
    const summarizeRuntimeInputs = (inputs: Array<{ entityId?: string; entityTxs?: Array<{ type?: string }> }> | undefined) =>
      (inputs || []).slice(-10).map(input => ({
        entityId: String(input.entityId || '').slice(-8),
        txs: (input.entityTxs || []).map(tx => String(tx?.type || '')),
      }));
    return {
      success: true,
      entityId,
      counterpartyEntityId,
      hasAccount: Boolean(account),
      ready: Boolean(account && isAccountConsensusReady(account)),
      currentHeight: Number(account?.currentHeight ?? 0),
      pendingFrameHeight: account?.pendingFrame ? Number(account.pendingFrame.height ?? 0) : null,
      pendingFrameTxs: (account?.pendingFrame?.accountTxs || []).map(tx => String(tx?.type || '')),
      mempool: Number(account?.mempool?.length ?? 0),
      mempoolTxs: (account?.mempool || []).map(tx => String(tx?.type || '')),
      swapOffers: Number(account?.swapOffers?.size || 0),
      tokens: tokenIds.map(tokenId => ({
        tokenId,
        hasDelta: Boolean(account?.deltas?.has(tokenId)),
        outCapacity: account ? getEntityOutCapacity(account, entityId, tokenId).toString() : '0',
      })),
      runtime: {
        height: Number(env.height ?? 0),
        timestamp: Number(env.timestamp ?? 0),
        halted: Boolean(env.runtimeState?.halted),
        fatalDebugPayload: env.runtimeState?.fatalDebugPayload ?? null,
        loopActive: Boolean(env.runtimeState?.loopActive),
        backlog: getMarketMakerRuntimeBacklogSnapshot(env, { includeQueuedEntityInputs: true }),
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
        messages: (replica.state?.messages || []).slice(-12),
      } : null,
      directInput: {
        lastSeen: lastDirectEntityInput,
        lastError: lastDirectEntityInputError,
      },
    };
  };

  const jurisdiction = resolveJurisdictionConfig(resolvedArgs.rpcUrl);
  nodeLog.info('startup phase', { phase: startupPhase });
  emitBootstrapDebugEvent('startup', { phase: startupPhase });

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
  env.runtimeState.directEntityInputDispatch =
    process.env['XLN_ENABLE_DIRECT_ENTITY_INPUT_DISPATCH'] === '1'
      ? (targetRuntimeId, input, ingressTimestamp) =>
          directRuntimeWs.sendEntityInput(targetRuntimeId, input, ingressTimestamp)
      : null;
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
    idleTimeout: 120,
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

        if (pathname === '/api/account/status' && request.method === 'GET') {
          const entityId = String(
            url.searchParams.get('entityId') ||
            url.searchParams.get('mmEntityId') ||
            activeMmEntityId ||
            '',
          ).toLowerCase();
          const counterpartyEntityId = String(url.searchParams.get('counterpartyEntityId') || '').toLowerCase();
          if (!entityId || !counterpartyEntityId) {
            return new Response(safeStringify({
              success: false,
              code: 'MM_ACCOUNT_STATUS_BAD_REQUEST',
              error: 'entityId/mmEntityId and counterpartyEntityId are required',
            }), { status: 400, headers: JSON_HEADERS });
          }
          const tokenIds = String(url.searchParams.get('tokenIds') || '')
            .split(',')
            .map(value => Number(value.trim()))
            .filter(value => Number.isInteger(value) && value > 0);
          return new Response(
            safeStringify(buildAccountStatusDebug(entityId, counterpartyEntityId, tokenIds)),
            { headers: JSON_HEADERS },
          );
        }

        if (pathname === '/api/info') {
          const includeCrossDebug =
            url.searchParams.get('crossDebug') === '1' ||
            url.searchParams.get('debug') === 'cross';
          const currentHealth = cachedMarketMakerHealth;
          return new Response(safeStringify({
            name: resolvedArgs.name,
            entityId: activeMmEntityId,
            runtimeId: env.runtimeId,
            apiUrl,
            relayUrl: resolvedArgs.relayUrl,
            directWsUrl,
            startupPhase,
            runtimeBacklog: getMarketMakerRuntimeBacklogSnapshot(env, {
              includeQueuedEntityInputs: includeCrossDebug,
            }),
            bootstrap: {
              readyHash: bootstrapReadyHash,
              runtimeStateHash: bootstrapRuntimeStateHash,
              entityStateHash: bootstrapEntityStateHash,
              readyAt: bootstrapReadyAt,
            },
            currentHealth: currentHealth ? {
              ok: currentHealth.ok,
              depthComplete: isMarketMakerDepthComplete(currentHealth),
              sameDepthComplete: isMarketMakerSameDepthComplete(currentHealth),
              offers: currentHealth.hubs.map(hub => hub.offers),
              hubBlockers: currentHealth.hubs.map(hub => hub.blockers.length),
              crossOk: currentHealth.cross.ok,
              crossExpectedRoutes: currentHealth.cross.expectedRoutes,
              crossOffers: currentHealth.cross.routes.map(route => route.offers),
              crossBlockers: currentHealth.cross.routes.map(route => route.blockers.length),
            } : null,
            ...(includeCrossDebug
              ? {
                  crossDebug: buildMarketMakerCrossDebugSummary(
                    env,
                    mmContexts,
                    readVisibleHubProfiles(env, true),
                    mmTokenIdsByContext,
                  ),
                }
              : {}),
          }), { headers: JSON_HEADERS });
        }

        if (pathname === '/api/health') {
          const primaryContext = mmContexts[0] ?? null;
          const visibleHubs = readVisibleHubProfiles(env).filter(profile =>
            primaryContext ? sameJurisdiction(primaryContext, profile) : true,
          );
          const allVisibleHubs = readVisibleHubProfiles(env, true);
          const activeEntityId = activeMmEntityId;
          const cachedHealth = cachedMarketMakerHealth;
          const rawMarketMakerHealth = activeEntityId
            ? (cachedHealth ?? {
                enabled: true,
                ok: false,
                entityId: activeEntityId,
                expectedOffersPerHub: 0,
                expectedOffersPerPair: 0,
                hubs: visibleHubs.map(profile => ({
                  hubEntityId: profile.entityId,
                  offers: 0,
                  ready: false,
                  blockers: [],
                  pairs: [],
                })),
                cross: {
                  applicable: allVisibleHubs.length > 0 && mmContexts.length > 1,
                  ok: false,
                  expectedRoutes: 0,
                  expectedOffersPerRoute: 0,
                  expectedOffersPerPair: 0,
                  routes: [],
                },
              })
            : {
                enabled: true,
                ok: false,
                entityId: null,
                expectedOffersPerHub: 0,
                expectedOffersPerPair: 0,
                hubs: [],
                cross: {
                  applicable: false,
                  ok: false,
                  expectedRoutes: 0,
                  expectedOffersPerRoute: 0,
                  expectedOffersPerPair: 0,
                  routes: [],
                },
              };
          const marketMakerHealth = startupPhase === 'offers-ready'
            ? rawMarketMakerHealth
            : { ...rawMarketMakerHealth, ok: false };
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
            bootstrap: {
              readyHash: bootstrapReadyHash,
              runtimeStateHash: bootstrapRuntimeStateHash,
              entityStateHash: bootstrapEntityStateHash,
              readyAt: bootstrapReadyAt,
            },
            marketMaker: marketMakerHealth,
          };
          return new Response(safeStringify(health), { headers: JSON_HEADERS });
        }

        if (pathname === '/api/control/p2p/stop' && request.method === 'POST') {
          shuttingDown = true;
          if (loop) clearInterval(loop);
          const drained = await waitForRuntimeWorkDrained(env, 10_000);
          if (!drained) {
            console.warn(`[${resolvedArgs.name}] p2p stop timed out waiting for runtime work to drain`);
          }
          const idle = await stopRuntimeLoopAndWait(env, 5_000);
          stopP2P(env);
          return new Response(safeStringify({ ok: true, runtimeDrained: drained, runtimeIdle: idle }), {
            headers: JSON_HEADERS,
          });
        }

        if (pathname === '/api/control/runtime/quiesce' && request.method === 'POST') {
          shuttingDown = true;
          if (loop) clearInterval(loop);
          const drained = await waitForRuntimeWorkDrained(env, 20_000, 750);
          if (!drained) {
            console.warn(`[${resolvedArgs.name}] quiesce timed out waiting for runtime work to drain`);
          }
          return new Response(safeStringify({ ok: true, runtimeDrained: drained, runtimeIdle: true }), {
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
        startAtCurrentBlock: shouldStartJWatcherAtCurrentBlock(),
      },
    }],
    entityInputs: [],
  });
  await settleRuntimeFor(env, 35);

  const jadapter = await waitForActiveJAdapter(env, jurisdiction.name);
  ensureJurisdictionReplica(env, jadapter, resolveImportedJurisdictionRpc(jurisdiction));
  startupPhase = 'token-catalog';
  const tokenCatalog = await waitForTokenCatalog(jadapter);
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
    allowDirectClients: false,
    preferRelayForEntityInput: true,
    advertiseEntityIds: mmContexts.map(context => context.entityId),
    gossipPollMs: BOOTSTRAP_POLL_MS * 5 || 250,
  });
  if (!p2p) throw new Error('P2P_START_FAILED');

  let shuttingDown = false;
  let loopInFlight = false;
  let bootstrapSameCursor = 0;
  let bootstrapCrossCursor = 0;
  let steadyCrossCursor = 0;
  let lastSameQuoteProgressLogAt = 0;
  let lastSameQuoteProgressKey = '';
  let lastCrossProgressLogAt = 0;
  let lastCrossProgressKey = '';
  const hubsForContext = (visibleHubs: HubProfile[], context: MarketMakerEntityContext): HubProfile[] =>
    visibleHubs
      .filter(profile => sameJurisdiction(context, profile))
      .sort((left, right) =>
        compareStableText(left.jurisdictionName || '', right.jurisdictionName || '') ||
        compareStableText(left.entityId, right.entityId),
      );
  const buildSameQuoteJobs = (visibleHubs: HubProfile[]): SameQuoteJob[] => {
    const jobs: SameQuoteJob[] = [];
    for (const context of mmContexts) {
      const tokenIds = getMarketMakerTokenIds(mmTokenIdsByContext, context);
      for (const hub of hubsForContext(visibleHubs, context)) {
        jobs.push({ context, hub, tokenIds });
      }
    }
    return jobs.sort((left, right) =>
      compareStableText(left.context.jurisdictionName, right.context.jurisdictionName) ||
      compareStableText(left.context.entityId, right.context.entityId) ||
      compareStableText(left.hub.entityId, right.hub.entityId),
    );
  };
  const isAllSameQuoteDepthComplete = (visibleHubs: HubProfile[]): boolean => {
    const sameQuoteJobs = buildSameQuoteJobs(visibleHubs);
    return sameQuoteJobs.length > 0 && sameQuoteJobs.every(job => isSameQuoteJobDepthComplete(env, job));
  };
  const describeSameQuoteJobProgress = (job: SameQuoteJob): Record<string, unknown> => {
    const account = getAccountMachine(env, job.context.entityId, job.hub.entityId);
    return {
      mmEntityId: job.context.entityId,
      jurisdiction: job.context.jurisdictionName,
      hubEntityId: job.hub.entityId,
      tokenIds: job.tokenIds,
      committedOffers: countCommittedMarketMakerOffersForHub(env, job.context.entityId, job.hub.entityId),
      expectedOffers: buildMarketMakerOfferSpecs([job.hub.entityId], job.tokenIds).length,
      account: account
        ? {
            height: Number(account.currentHeight ?? 0),
            pendingFrame: Boolean(account.pendingFrame),
            mempoolLength: Number(account.mempool?.length || 0),
          }
        : null,
      blocker: describeMarketMakerSameHubBlocker(env, job.context.entityId, job.hub.entityId),
    };
  };
  const emitSameQuoteProgress = (reason: string, jobs: SameQuoteJob[], selectedJob?: SameQuoteJob): void => {
    if (!MARKET_MAKER_BOOTSTRAP_EVENTS_JSONL) return;
    const incomplete = jobs.filter(job => !isSameQuoteJobDepthComplete(env, job));
    const key = incomplete
      .map(job => `${job.context.entityId}:${job.hub.entityId}:${countCommittedMarketMakerOffersForHub(env, job.context.entityId, job.hub.entityId)}`)
      .join('|');
    const now = Date.now();
    if (key === lastSameQuoteProgressKey && now - lastSameQuoteProgressLogAt < 2_000) return;
    lastSameQuoteProgressKey = key;
    lastSameQuoteProgressLogAt = now;
    emitBootstrapDebugEvent('same-quote-progress', {
      reason,
      selected: selectedJob ? describeSameQuoteJobProgress(selectedJob) : null,
      incomplete: incomplete.slice(0, 8).map(describeSameQuoteJobProgress),
      incompleteCount: incomplete.length,
    });
  };
  const describeCrossQuoteJobProgress = (job: CrossQuoteJob): Record<string, unknown> => {
    const specs = buildMarketMakerCrossOfferSpecs(
      env,
      job.sourceContext,
      job.targetContext,
      job.sourceHubs,
      job.targetHubs,
      job.sourceTokenIds,
      job.targetTokenIds,
    );
    const routeGroups = new Map<string, {
      sourceHubEntityId: string;
      targetHubEntityId: string;
      expected: number;
      finalized: number;
      visible: number;
      pending: number;
    }>();
    const pendingBySource = new Map<string, Set<string>>();
    const pendingFor = (entityId: string): Set<string> => {
      const normalized = normalizeEntityRef(entityId);
      const cached = pendingBySource.get(normalized);
      if (cached) return cached;
      const pending = collectPendingCrossRequestOrderIds(env, normalized);
      pendingBySource.set(normalized, pending);
      return pending;
    };
    for (const spec of specs) {
      const route = spec.crossJurisdiction;
      if (!route) continue;
      const key = `${route.source.counterpartyEntityId}->${route.target.entityId}`;
      const group = routeGroups.get(key) ?? {
        sourceHubEntityId: route.source.counterpartyEntityId,
        targetHubEntityId: route.target.entityId,
        expected: 0,
        finalized: 0,
        visible: 0,
        pending: 0,
      };
      group.expected += 1;
      if (hasFinalizedMarketMakerCrossOffer(env, spec)) group.finalized += 1;
      if (hasMarketMakerCrossOffer(env, spec)) group.visible += 1;
      if (pendingFor(route.source.entityId).has(route.orderId)) group.pending += 1;
      routeGroups.set(key, group);
    }
    return {
      sourceJurisdiction: job.sourceContext.jurisdictionName,
      targetJurisdiction: job.targetContext.jurisdictionName,
      sourceHubs: job.sourceHubs.map(hub => hub.entityId),
      targetHubs: job.targetHubs.map(hub => hub.entityId),
      expectedOffers: specs.length,
      finalizedOffers: specs.filter(spec => hasFinalizedMarketMakerCrossOffer(env, spec)).length,
      visibleOffers: specs.filter(spec => hasMarketMakerCrossOffer(env, spec)).length,
      routes: Array.from(routeGroups.values())
        .sort((left, right) =>
          left.finalized - right.finalized ||
          left.visible - right.visible ||
          compareStableText(left.sourceHubEntityId, right.sourceHubEntityId) ||
          compareStableText(left.targetHubEntityId, right.targetHubEntityId),
        )
        .slice(0, 8),
    };
  };
  const emitCrossProgress = (reason: string, jobs: CrossQuoteJob[], selectedJob?: CrossQuoteJob): void => {
    if (!MARKET_MAKER_BOOTSTRAP_EVENTS_JSONL) return;
    const incomplete = jobs.filter(job => !isCrossQuoteJobDepthComplete(env, job));
    const key = incomplete
      .map((job) => {
        const progress = describeCrossQuoteJobProgress(job);
        return `${String(progress['sourceJurisdiction'])}->${String(progress['targetJurisdiction'])}:${String(progress['finalizedOffers'])}/${String(progress['expectedOffers'])}`;
      })
      .join('|');
    const now = Date.now();
    if (key === lastCrossProgressKey && now - lastCrossProgressLogAt < 2_000) return;
    lastCrossProgressKey = key;
    lastCrossProgressLogAt = now;
    emitBootstrapDebugEvent('cross-progress', {
      reason,
      selected: selectedJob ? describeCrossQuoteJobProgress(selectedJob) : null,
      incomplete: incomplete.slice(0, 4).map(describeCrossQuoteJobProgress),
      incompleteCount: incomplete.length,
    });
  };
  const isBootstrapDepthComplete = (health: MarketMakerHealth | null): boolean =>
    isAllSameQuoteDepthComplete(readVisibleHubProfiles(env, true)) && isMarketMakerDepthComplete(health);
  const driveQuotes = async (mode: 'bootstrap' | 'steady' = 'steady'): Promise<void> => {
    if (shuttingDown) return;
    if (loopInFlight) return;
    loopInFlight = true;
    try {
      if (hasMarketMakerRuntimeBacklog(env)) return;
      const connectivityBudget: MarketMakerConnectivityBudget = {
        remainingTxs: mode === 'bootstrap'
          ? MARKET_MAKER_BOOTSTRAP_CONNECTIVITY_MAX_TXS_PER_TICK
          : MARKET_MAKER_CONNECTIVITY_MAX_TXS_PER_TICK,
      };
      const visibleHubs = readVisibleHubProfiles(env, true);
      const shouldContinue = () => !shuttingDown;
      const quoteableHubsFor = (context: MarketMakerEntityContext): HubProfile[] =>
        hubsForContext(visibleHubs, context)
          .filter(profile => !hasMarketMakerAccountBacklog(env, context.entityId, profile.entityId));
      if (visibleHubs.length === 0) return;
      if (!shouldContinue()) return;
      if (!areMarketMakerHubTransportsReady(getP2PState(env), visibleHubs)) return;
      await yieldMarketMakerApi();
      const healthBeforeQuotes = mode === 'bootstrap'
        ? buildMarketMakerHealthSnapshot({ includeCross: false })
        : null;
      const primarySameDepthReady = isMarketMakerSameDepthComplete(healthBeforeQuotes);

      if (mode === 'bootstrap') {
        const sameQuoteJobs = buildSameQuoteJobs(visibleHubs);
        emitSameQuoteProgress('scan', sameQuoteJobs);
        const orderedIncompleteJobs: SameQuoteJob[] = [];
        for (let offset = 0; offset < sameQuoteJobs.length; offset += 1) {
          const selectedIndex = (bootstrapSameCursor + offset) % sameQuoteJobs.length;
          const job = sameQuoteJobs[selectedIndex];
          if (!job || isSameQuoteJobDepthComplete(env, job)) continue;
          orderedIncompleteJobs.push(job);
        }
        if (orderedIncompleteJobs.length > 0) {
          const jobsByContext = new Map<string, {
            context: MarketMakerEntityContext;
            tokenIds: number[];
            jobs: SameQuoteJob[];
          }>();
          for (const job of orderedIncompleteJobs) {
            const key = marketMakerContextKey(job.context);
            const entry = jobsByContext.get(key) ?? {
              context: job.context,
              tokenIds: job.tokenIds,
              jobs: [],
            };
            entry.jobs.push(job);
            jobsByContext.set(key, entry);
          }
          const groupedEntries = Array.from(jobsByContext.values())
            .sort((left, right) =>
              compareStableText(left.context.jurisdictionName, right.context.jurisdictionName) ||
              compareStableText(left.context.entityId, right.context.entityId),
            );
          const runnableHubEntityIdsFor = (entry: { context: MarketMakerEntityContext; jobs: SameQuoteJob[] }): string[] =>
            entry.jobs
              .map(job => job.hub.entityId)
              .filter(hubEntityId => !hasMarketMakerAccountBacklog(env, entry.context.entityId, hubEntityId))
              .sort(compareStableText);

          let enqueuedConnectivity = false;
          for (const entry of groupedEntries) {
            const runnableHubEntityIds = runnableHubEntityIdsFor(entry);
            if (runnableHubEntityIds.length === 0) continue;
            const selectedJob = entry.jobs.find(job => runnableHubEntityIds.includes(job.hub.entityId)) ?? entry.jobs[0]!;
            bootstrapSameCursor = sameQuoteJobs.indexOf(selectedJob);
            emitSameQuoteProgress('selected', sameQuoteJobs, selectedJob);
            await yieldMarketMakerApi();
            if (!shouldContinue()) return;
            if (await ensureMarketMakerHubConnectivity(
              env,
              entry.context.entityId,
              entry.context.signerId,
              runnableHubEntityIds,
              entry.tokenIds,
              connectivityBudget,
            )) {
              enqueuedConnectivity = true;
            }
          }
          if (enqueuedConnectivity) {
            await yieldMarketMakerApi();
            return;
          }

          let enqueuedQuotes = false;
          for (const entry of groupedEntries) {
            const runnableHubEntityIds = runnableHubEntityIdsFor(entry)
              .slice(0, MARKET_MAKER_BOOTSTRAP_SAME_QUOTE_HUB_GROUPS_PER_WAVE);
            if (runnableHubEntityIds.length === 0) continue;
            const selectedJob = entry.jobs.find(job => runnableHubEntityIds.includes(job.hub.entityId)) ?? entry.jobs[0]!;
            bootstrapSameCursor = sameQuoteJobs.indexOf(selectedJob);
            emitSameQuoteProgress('selected', sameQuoteJobs, selectedJob);
            await yieldMarketMakerApi();
            if (!shouldContinue()) return;
            if (await maintainMarketMakerQuotes(
              env,
              entry.context.entityId,
              entry.context.signerId,
              runnableHubEntityIds,
              entry.tokenIds,
              MARKET_MAKER_BOOTSTRAP_OFFERS_PER_ACCOUNT_PER_TICK,
              MARKET_MAKER_BOOTSTRAP_MAX_NEW_OFFERS_PER_TICK,
              connectivityBudget,
              shouldContinue,
            )) {
              enqueuedQuotes = true;
            }
          }
          if (enqueuedQuotes) {
            await yieldMarketMakerApi();
            return;
          }
          if (orderedIncompleteJobs.some(job =>
            !hasMarketMakerAccountBacklog(env, job.context.entityId, job.hub.entityId),
          )) return;
          await yieldMarketMakerApi();
          return;
        }
      }

      const maintainSameContextQuotes = async (context: MarketMakerEntityContext): Promise<boolean> => {
        await yieldMarketMakerApi();
        if (!shouldContinue()) return false;
        const sameJurisdictionHubs = quoteableHubsFor(context);
        const hubEntityIds = sameJurisdictionHubs.map(profile => profile.entityId);
        if (hubEntityIds.length === 0) return false;
        const contextTokenIds = getMarketMakerTokenIds(mmTokenIdsByContext, context);
        const enqueued = await maintainMarketMakerQuotes(
          env,
          context.entityId,
          context.signerId,
          hubEntityIds,
          contextTokenIds,
          mode === 'bootstrap'
            ? MARKET_MAKER_BOOTSTRAP_OFFERS_PER_ACCOUNT_PER_TICK
            : MARKET_MAKER_OFFERS_PER_ACCOUNT_PER_TICK,
          mode === 'bootstrap'
            ? MARKET_MAKER_BOOTSTRAP_MAX_NEW_OFFERS_PER_TICK
            : MARKET_MAKER_MAX_NEW_OFFERS_PER_TICK,
          connectivityBudget,
          shouldContinue,
        );
        await yieldMarketMakerApi();
        return enqueued;
      };

      if (mode !== 'bootstrap') {
        for (const context of mmContexts) {
          if (await maintainSameContextQuotes(context)) return;
          if (!shouldContinue()) return;
        }
      }
      if (mode === 'bootstrap') {
        const health = buildMarketMakerHealthSnapshot();
        if (!primarySameDepthReady || !isAllSameQuoteDepthComplete(visibleHubs)) return;
        if (isBootstrapDepthComplete(health)) return;
        if (!bootstrapCrossStarted) {
          bootstrapCrossStarted = true;
          startupPhase = 'bootstrap-cross';
          emitBootstrapDebugEvent('phase', {
            phase: startupPhase,
            health: summarizeMarketMakerHealthForDebug(health),
          });
          await yieldMarketMakerApi();
        }
      }

      const crossQuoteJobs: CrossQuoteJob[] = [];
      for (const sourceContext of mmContexts) {
        await yieldMarketMakerApi();
        if (!shouldContinue()) return;
        const sourceHubs = mode === 'bootstrap'
          ? hubsForContext(visibleHubs, sourceContext)
          : quoteableHubsFor(sourceContext);
        if (sourceHubs.length === 0) continue;
        const sourceTokenIds = getMarketMakerTokenIds(mmTokenIdsByContext, sourceContext);
        for (const targetContext of mmContexts) {
          await yieldMarketMakerApi();
          if (!shouldContinue()) return;
          if (sourceContext.entityId === targetContext.entityId || sameJurisdiction(sourceContext, targetContext)) continue;
          const targetHubs = mode === 'bootstrap'
            ? hubsForContext(visibleHubs, targetContext)
            : quoteableHubsFor(targetContext);
          if (targetHubs.length === 0) continue;
          const targetTokenIds = getMarketMakerTokenIds(mmTokenIdsByContext, targetContext);
          crossQuoteJobs.push({
            sourceContext,
            targetContext,
            sourceHubs,
            targetHubs,
            sourceTokenIds,
            targetTokenIds,
          });
        }
      }
      const selectedCrossQuoteJobs: Array<{ index: number; job: CrossQuoteJob }> = [];
      if (crossQuoteJobs.length > 0) {
        if (mode === 'bootstrap') emitCrossProgress('scan', crossQuoteJobs);
        const cursor = mode === 'bootstrap' ? bootstrapCrossCursor : steadyCrossCursor;
        if (mode === 'bootstrap') {
          for (let offset = 0; offset < crossQuoteJobs.length; offset += 1) {
            const selectedIndex = (cursor + offset) % crossQuoteJobs.length;
            const selectedJob = crossQuoteJobs[selectedIndex];
            if (!selectedJob || isCrossQuoteJobDepthComplete(env, selectedJob)) continue;
            selectedCrossQuoteJobs.push({ index: selectedIndex, job: selectedJob });
            bootstrapCrossCursor = selectedIndex;
            break;
          }
        } else {
          const jobCount = Math.min(MARKET_MAKER_STEADY_CROSS_ROUTE_JOBS_PER_TICK, crossQuoteJobs.length);
          let nextCursor = cursor;
          for (let offset = 0; offset < jobCount; offset += 1) {
            const selectedIndex = (cursor + offset) % crossQuoteJobs.length;
            const selectedJob = crossQuoteJobs[selectedIndex];
            if (selectedJob) {
              selectedCrossQuoteJobs.push({ index: selectedIndex, job: selectedJob });
              nextCursor = (selectedIndex + 1) % crossQuoteJobs.length;
            }
          }
          steadyCrossCursor = nextCursor;
        }
      }
      const advanceCrossCursorAfterEnqueue = (index: number, job: CrossQuoteJob): void => {
        const nextCursor = (index + 1) % crossQuoteJobs.length;
        if (mode === 'bootstrap') {
          bootstrapCrossCursor = isCrossQuoteJobDepthComplete(env, job) ? nextCursor : index;
        }
        if (mode === 'steady') steadyCrossCursor = nextCursor;
      };
      for (const entry of selectedCrossQuoteJobs) {
        const job = entry.job;
        await yieldMarketMakerApi();
        if (!shouldContinue()) return;
        if (mode === 'bootstrap') emitCrossProgress('selected', crossQuoteJobs, job);
        if (await maintainMarketMakerCrossQuotes(
          env,
          job.sourceContext,
          job.targetContext,
          job.sourceHubs,
          job.targetHubs,
          job.sourceTokenIds,
          job.targetTokenIds,
          mode === 'bootstrap'
            ? MARKET_MAKER_BOOTSTRAP_CROSS_OFFERS_PER_ACCOUNT_PER_TICK
            : Math.max(2, Math.floor(MARKET_MAKER_OFFERS_PER_ACCOUNT_PER_TICK / 2)),
          mode === 'bootstrap'
            ? MARKET_MAKER_BOOTSTRAP_MAX_NEW_CROSS_OFFERS_PER_TICK
            : Math.max(2, Math.floor(MARKET_MAKER_MAX_NEW_OFFERS_PER_TICK / 2)),
          connectivityBudget,
          shouldContinue,
          mode === 'bootstrap'
            ? MARKET_MAKER_BOOTSTRAP_CROSS_SOURCE_HUB_GROUPS_PER_WAVE
            : Number.MAX_SAFE_INTEGER,
          mode === 'bootstrap',
        )) {
          advanceCrossCursorAfterEnqueue(entry.index, job);
          await yieldMarketMakerApi();
          // A cross request starts a bilateral target-lock lifecycle. During
          // bootstrap, launch one per-account settlement wave and wait for
          // account ACKs before opening more cross routes on the same accounts.
          if (mode === 'bootstrap') return;
          if (mode === 'steady') return;
        }
        if (mode === 'bootstrap' && !isCrossQuoteJobDepthComplete(env, job)) return;
        await yieldMarketMakerApi();
      }
      if (!shouldContinue()) return;
      await yieldMarketMakerApi();
    } finally {
      loopInFlight = false;
    }
  };

  const persistBootstrapReadySnapshotIfRequested = async (): Promise<void> => {
    if (bootstrapReadySnapshotPersisted) return;
    if (!envFlagEnabled(process.env['XLN_MARKET_MAKER_PERSIST_READY_SNAPSHOT'])) return;
    const previousRuntimeConfig = env.runtimeConfig;
    env.runtimeConfig = {
      ...(env.runtimeConfig || {}),
      storage: {
        ...(env.runtimeConfig?.storage || {}),
        enabled: true,
      },
    };
    try {
      await persistRestoredEnvToDB(env);
      bootstrapReadySnapshotPersisted = true;
      console.log(`[MESH-MM] BOOTSTRAP_READY_SNAPSHOT_PERSISTED height=${env.height}`);
    } finally {
      env.runtimeConfig = previousRuntimeConfig;
    }
  };

  const markOffersReady = async (): Promise<void> => {
    if (startupPhase === 'offers-ready') return;
    const visibleHubs = readVisibleHubProfiles(env, true);
    if (!isAllSameQuoteDepthComplete(visibleHubs)) {
      throw new Error(`MARKET_MAKER_BOOTSTRAP_INCOMPLETE: ${safeStringify({
        scope: 'same-chain-all-contexts',
        incomplete: buildSameQuoteJobs(visibleHubs)
          .filter(job => !isSameQuoteJobDepthComplete(env, job))
          .map(job => ({
            mmEntityId: job.context.entityId,
            jurisdiction: job.context.jurisdictionName,
            hubEntityId: job.hub.entityId,
            committedOffers: countCommittedMarketMakerOffersForHub(env, job.context.entityId, job.hub.entityId),
            expectedOffers: buildMarketMakerOfferSpecs([job.hub.entityId], job.tokenIds).length,
            blocker: describeMarketMakerSameHubBlocker(env, job.context.entityId, job.hub.entityId),
          })),
      })}`);
    }
    const health = assertMarketMakerBootstrapFinalized(
      env,
      publishMarketMakerHealthSnapshot({ includeCross: true }),
    );
    const fingerprint = buildMarketMakerBootstrapFingerprint(
      env,
      mmContexts,
      visibleHubs,
      mmTokenIdsByContext,
      health,
    );
    const runtimeStateHash = computeCanonicalStateHashFromEnv(env);
    const entityStateHash = buildMarketMakerBootstrapEntityStateHash(env);
    bootstrapReadyHash = fingerprint.hash;
    bootstrapRuntimeStateHash = runtimeStateHash;
    bootstrapEntityStateHash = entityStateHash;
    bootstrapReadyAt = Date.now();
    await persistBootstrapReadySnapshotIfRequested();
    startupPhase = 'offers-ready';
    emitBootstrapDebugEvent('ready-hash', {
      hash: fingerprint.hash,
      runtimeStateHash,
      entityStateHash,
      health: summarizeMarketMakerHealthForDebug(health),
    });
    console.log(
      `[MESH-MM] BOOTSTRAP_READY_HASH hash=${fingerprint.hash} runtimeStateHash=${runtimeStateHash} entityStateHash=${entityStateHash} payload=${safeStringify(fingerprint.payload)}`,
    );
    console.log(
      `[MESH-MM] OFFERS_READY entityId=${primaryMmContext.entityId} runtimeId=${String(env.runtimeId || '')} api=${apiUrl} relay=${resolvedArgs.relayUrl}`,
    );
  };

  const waitForBootstrapOffers = async (): Promise<boolean> => {
    const deadline = Date.now() + MARKET_MAKER_BOOTSTRAP_TIMEOUT_MS;
    let lastBacklogLogAt = 0;
    const refreshBootstrapPhase = (health: MarketMakerHealth | null): void => {
      if (isBootstrapDepthComplete(health)) return;
      const sameDepthComplete =
        isMarketMakerSameDepthComplete(health) &&
        isAllSameQuoteDepthComplete(readVisibleHubProfiles(env, true));
      if (sameDepthComplete || bootstrapCrossStarted) {
        bootstrapCrossStarted = true;
        if (startupPhase !== 'bootstrap-cross') {
          startupPhase = 'bootstrap-cross';
          emitBootstrapDebugEvent('phase', {
            phase: startupPhase,
            health: summarizeMarketMakerHealthForDebug(health),
          });
        } else {
          startupPhase = 'bootstrap-cross';
        }
        return;
      }
      if (startupPhase !== 'bootstrap-same-chain') {
        startupPhase = 'bootstrap-same-chain';
        emitBootstrapDebugEvent('phase', {
          phase: startupPhase,
          health: summarizeMarketMakerHealthForDebug(health),
        });
      } else {
        startupPhase = 'bootstrap-same-chain';
      }
    };
    while (!shuttingDown && Date.now() < deadline) {
      const beforeDrive = publishBootstrapHealthSnapshot();
      refreshBootstrapPhase(beforeDrive);
      if (isBootstrapDepthComplete(beforeDrive) && !hasMarketMakerRuntimeBacklog(env)) return true;
      await yieldMarketMakerApi();
      await driveQuotes('bootstrap');
      await yieldMarketMakerApi();
      const health = publishBootstrapHealthSnapshot();
      refreshBootstrapPhase(health);
      if (isBootstrapDepthComplete(health)) {
        if (!hasMarketMakerRuntimeBacklog(env)) return true;
        const now = Date.now();
        if (now - lastBacklogLogAt >= 5_000) {
          lastBacklogLogAt = now;
          const backlog = getMarketMakerRuntimeBacklogSnapshot(env);
          emitBootstrapDebugEvent('backlog', { backlog });
          console.warn(`[MESH-MM] BOOTSTRAP_WAIT_BACKLOG ${safeStringify(backlog)}`);
        }
      }
      await sleep(MARKET_MAKER_BOOTSTRAP_LOOP_MS);
    }
    if (shuttingDown) return false;
    const health = publishMarketMakerHealthSnapshot();
    const visibleHubs = readVisibleHubProfiles(env).filter(profile => sameJurisdiction(primaryMmContext, profile));
    console.warn(
      `[MESH-MM] BOOTSTRAP_TIMEOUT visibleHubs=${visibleHubs.length} offers=${safeStringify((health?.hubs ?? []).map(hub => ({ hubEntityId: hub.hubEntityId, offers: hub.offers })))} cross=${safeStringify({ expectedRoutes: health?.cross.expectedRoutes ?? 0, routes: (health?.cross.routes ?? []).map(route => ({ sourceHubEntityId: route.sourceHubEntityId, targetHubEntityId: route.targetHubEntityId, offers: route.offers, ready: route.ready })) })}`,
    );
    emitBootstrapDebugEvent('timeout', {
      health: summarizeMarketMakerHealthForDebug(health),
      visibleHubs: visibleHubs.length,
    });
    return false;
  };

  let loop: ReturnType<typeof setInterval> | null = null;
  const runQuoteMaintenance = async (): Promise<void> => {
    if (startupPhase === 'offers-ready') {
      publishMarketMakerHealthSnapshot({ includeCross: true });
      return;
    }
    const before = startupPhase === 'offers-ready'
      ? publishMarketMakerHealthSnapshot({ includeCross: true })
      : publishBootstrapHealthSnapshot();
    if (startupPhase === 'offers-ready' && isMarketMakerDepthComplete(before)) return;
    if (startupPhase !== 'offers-ready' && isBootstrapDepthComplete(before) && !hasMarketMakerRuntimeBacklog(env)) {
      await markOffersReady();
      return;
    }
    await driveQuotes();
    const health = startupPhase === 'offers-ready'
      ? publishMarketMakerHealthSnapshot({ includeCross: true })
      : publishBootstrapHealthSnapshot();
    if (startupPhase !== 'offers-ready' && isBootstrapDepthComplete(health) && !hasMarketMakerRuntimeBacklog(env)) {
      await markOffersReady();
    }
  };
  const failQuoteLoop = (error: unknown): void => {
    if (shuttingDown) return;
    const message = error instanceof Error ? error.message : String(error);
    emitBootstrapDebugEvent('fatal', { error: message });
    console.error(`[MM] quote loop failed; shutting down:`, message);
    if (loop) clearInterval(loop);
    process.exit(1);
  };
  const startQuoteLoop = (): void => {
    if (loop) return;
    loop = setInterval(() => {
      if (shuttingDown) return;
      void runQuoteMaintenance().catch(failQuoteLoop);
    }, MARKET_MAKER_QUOTE_LOOP_MS);
  };
  startupPhase = 'runtime-ready';
  publishMarketMakerHealthSnapshot({ includeCross: false });
  emitBootstrapDebugEvent('phase', { phase: startupPhase });
  console.log(
    `[MESH-MM] RUNTIME_READY entityId=${primaryMmContext.entityId} runtimeId=${String(env.runtimeId || '')} api=${apiUrl} relay=${resolvedArgs.relayUrl}`,
  );

  void (async () => {
    await sleep(MARKET_MAKER_BOOTSTRAP_START_DELAY_MS);
    if (shuttingDown) return;
    startupPhase = 'bootstrap-same-chain';
    publishBootstrapHealthSnapshot();
    emitBootstrapDebugEvent('phase', { phase: startupPhase });
    if (await waitForBootstrapOffers()) {
      await markOffersReady();
      publishMarketMakerHealthSnapshot({ includeCross: true });
    } else {
      startupPhase = 'bootstrap-degraded';
      emitBootstrapDebugEvent('phase', { phase: startupPhase });
      startQuoteLoop();
    }
  })().catch(failQuoteLoop);

  let shutdownStarted = false;
  const shutdown = async (code: number = 0): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    shuttingDown = true;
    if (loop) clearInterval(loop);
    try {
      const idle = await stopRuntimeLoopAndWait(env, 10_000);
      if (!idle) {
        console.warn(`[${resolvedArgs.name}] shutdown timed out waiting for runtime loop to drain`);
      }
      await stopServerGracefully(server, httpDrain, resolvedArgs.name, 5_000);
      stopP2P(env);
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

if (import.meta.main) {
  resetMeshJurisdictionsCache();
  run().catch(error => {
    console.error(`[MESH-MM] FAILED:`, (error as Error).stack || (error as Error).message);
    process.exit(1);
  });
}
