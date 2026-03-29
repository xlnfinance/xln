#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ethers } from 'ethers';
import { safeStringify } from '../serialization-utils';
import { encodeBoard, hashBoard } from '../entity-factory';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../account-crypto';
import { createDirectRuntimeWsRoute } from '../networking/direct-runtime-bun';
import { clearJurisdictionsCache, loadJurisdictions } from '../jurisdiction-loader';
import { resolveJurisdictionsJsonPath } from '../jurisdictions-path';
import {
  getActiveJAdapter,
  getP2PState,
  main,
  enqueueRuntimeInput,
  handleInboundP2PEntityInput,
  startP2P,
  stopP2P,
  startRuntimeLoop,
} from '../runtime.ts';
import type { EntityInput, Env } from '../types';
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
import { LIMITS } from '../constants';
import { ORDERBOOK_MAX_LEVELS, ORDERBOOK_PRICE_SCALE } from '../orderbook';

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
const MARKET_MAKER_QUOTE_LOOP_MS = Math.max(1000, Number(process.env.MARKET_MAKER_QUOTE_LOOP_MS || '30000'));
const MARKET_MAKER_BOOTSTRAP_LOOP_MS = Math.max(250, Number(process.env.MARKET_MAKER_BOOTSTRAP_LOOP_MS || '1000'));
const MARKET_MAKER_BOOTSTRAP_TIMEOUT_MS = Math.max(
  10_000,
  Number(process.env.MARKET_MAKER_BOOTSTRAP_TIMEOUT_MS || '90000'),
);
const MARKET_MAKER_OFFERS_PER_ACCOUNT_PER_TICK = Math.max(
  2,
  Number(process.env.MARKET_MAKER_OFFERS_PER_ACCOUNT_PER_TICK || '30'),
);
const MARKET_MAKER_MAX_NEW_OFFERS_PER_TICK = Math.max(
  4,
  Number(process.env.MARKET_MAKER_MAX_NEW_OFFERS_PER_TICK || '12'),
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
const directWsUrl = String(resolvedArgs.directWsUrl || '').trim();
if (!directWsUrl) {
  throw new Error('[MESH-MM] Missing required --direct-ws-url');
}
const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

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

const readVisibleHubProfiles = (env: Env): HubProfile[] => {
  const required = new Set(resolvedArgs.meshHubNames.map((name) => name.toLowerCase()));
  return (env.gossip?.getProfiles?.() || [])
    .filter((profile): profile is { name: string; entityId: string; metadata?: { isHub?: boolean } } =>
      typeof profile?.name === 'string' &&
      typeof profile?.entityId === 'string' &&
      profile.metadata?.isHub === true,
    )
    .filter(profile => required.has(profile.name.toLowerCase()))
    .map(profile => ({
      name: profile.name,
      entityId: profile.entityId.toLowerCase(),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
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

const getReachableMarketMakerLevelCount = (
  midPriceTicks: bigint,
  stepTicks: number,
  offsetsBps: readonly number[],
): number => {
  const maxExactSpanTicks = BigInt(Math.max(1, ORDERBOOK_MAX_LEVELS - 1)) * BigInt(Math.max(1, stepTicks));
  let reachable = 0;
  for (const offsetBps of offsetsBps) {
    const askRaw = (midPriceTicks * BigInt(10_000 + offsetBps)) / 10_000n;
    const bidRaw = (midPriceTicks * BigInt(Math.max(1, 10_000 - offsetBps))) / 10_000n;
    const askPriceTicks = snapPriceTicks(askRaw, stepTicks, 'up');
    let bidPriceTicks = snapPriceTicks(bidRaw, stepTicks, 'down');
    if (bidPriceTicks >= askPriceTicks) {
      bidPriceTicks = askPriceTicks > BigInt(stepTicks) ? askPriceTicks - BigInt(stepTicks) : 1n;
    }
    if ((askPriceTicks - bidPriceTicks) > maxExactSpanTicks) break;
    reachable += 1;
  }
  return reachable;
};

const snapPriceTicks = (ticks: bigint, stepTicks: number, mode: 'up' | 'down'): bigint => {
  const step = BigInt(Math.max(1, stepTicks));
  if (mode === 'up') return ((ticks + step - 1n) / step) * step;
  return (ticks / step) * step;
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
  account: Pick<ReturnType<typeof getAccountMachine>, 'swapOffers' | 'mempool' | 'pendingFrame'> | null | undefined,
): Set<string> => {
  const ids = new Set<string>();
  if (account?.swapOffers instanceof Map) {
    for (const offerId of account.swapOffers.keys()) ids.add(String(offerId));
  }
  for (const tx of account?.mempool || []) {
    if (tx?.type !== 'swap_offer') continue;
    const offerId = String(tx?.data?.offerId || '');
    if (offerId) ids.add(offerId);
  }
  for (const tx of account?.pendingFrame?.accountTxs || []) {
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
        reachableLevelCount: getReachableMarketMakerLevelCount(
          midPriceTicks,
          Math.max(1, pairPolicy.priceStepTicks),
          levelProfile.offsetsBps,
        ),
      };
    });
    const maxLevels = pairContexts.reduce((max, entry) => Math.max(max, entry.levelProfile.offsetsBps.length), 0);
    for (let level = 0; level < maxLevels; level += 1) {
      for (const entry of pairContexts) {
        if (level >= entry.reachableLevelCount) continue;
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
            minFillRatio: 1,
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
            minFillRatio: 1,
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
  const creditInputsByEntity = new Map<string, EntityInput>();

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
        const input = creditInputsByEntity.get(hubEntityId) ?? {
          entityId: hubEntityId,
          signerId: hubSignerId,
          entityTxs: [],
        };
        input.entityTxs.push({
          type: 'extendCredit',
          data: {
            counterpartyEntityId: mmEntityId,
            tokenId,
            amount: MARKET_MAKER_CREDIT_AMOUNT,
          },
        });
        creditInputsByEntity.set(hubEntityId, input);
      }

      if (hubOutCapacity < MARKET_MAKER_CREDIT_AMOUNT) {
        const input = creditInputsByEntity.get(mmEntityId) ?? {
          entityId: mmEntityId,
          signerId: mmSignerId,
          entityTxs: [],
        };
        input.entityTxs.push({
          type: 'extendCredit',
          data: {
            counterpartyEntityId: hubEntityId,
            tokenId,
            amount: MARKET_MAKER_CREDIT_AMOUNT,
          },
        });
        creditInputsByEntity.set(mmEntityId, input);
      }
    }
  }

  if (creditInputsByEntity.size > 0) {
    enqueueRuntimeInput(env, { runtimeTxs: [], entityInputs: Array.from(creditInputsByEntity.values()) });
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
  if (resolvedArgs.dbPath) process.env.XLN_DB_PATH = resolvedArgs.dbPath;

  const env = await main(resolvedArgs.seed);
  startRuntimeLoop(env);
  let startupPhase = 'boot';
  let activeMmEntityId: string | null = null;

  const jurisdiction = resolveJurisdictionConfig(resolvedArgs.rpcUrl);
  console.log(`[MESH-MM] startup phase=${startupPhase}`);

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

      const upgraded = directRuntimeWs.maybeUpgrade(request, serverRef);
      if (upgraded !== undefined) return upgraded;

      if (pathname === '/api/info') {
        return new Response(JSON.stringify({
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
        return new Response(JSON.stringify(health), { headers: JSON_HEADERS });
      }

      if (pathname === '/api/control/p2p/stop' && request.method === 'POST') {
        stopP2P(env);
        return new Response(JSON.stringify({ ok: true }), {
          headers: JSON_HEADERS,
        });
      }

      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: JSON_HEADERS,
      });
    },
    websocket: directRuntimeWs.websocket,
  });

  startupPhase = 'import-jurisdiction';
  enqueueRuntimeInput(env, {
    runtimeTxs: [{
      type: 'importJ',
      data: {
        name: jurisdiction.name,
        chainId: jurisdiction.chainId,
        ticker: 'XLN',
        rpcs: [jurisdiction.rpc],
        contracts: jurisdiction.contracts,
      },
    }],
    entityInputs: [],
  });
  await settleRuntimeFor(env, 35);

  const jadapter = await waitForActiveJAdapter(env);
  ensureJurisdictionReplica(env, jadapter, resolvedArgs.rpcUrl);
  startupPhase = 'token-catalog';
  const tokenCatalog = await waitForTokenCatalog(jadapter);
  const tokenIds = normalizeTokenIdsForMm(tokenCatalog);
  const meshHubIdentities = parseMeshHubIdentities(resolvedArgs.meshHubIdentitiesJson);
  const hubSignerIdsByEntityId = new Map(
    meshHubIdentities.map((hub) => [hub.entityId.toLowerCase(), hub.signerId.toLowerCase()] as const),
  );

  const mmPrivateKey = deriveSignerKeySync(resolvedArgs.seed, resolvedArgs.signerLabel);
  const mmSignerId = deriveSignerAddressSync(resolvedArgs.seed, resolvedArgs.signerLabel);
  registerSignerKey(mmSignerId, mmPrivateKey);
  const consensusConfig = {
    mode: 'proposer-based' as const,
    threshold: 1n,
    validators: [mmSignerId],
    shares: { [mmSignerId]: 1n },
    jurisdiction: {
      name: jurisdiction.name,
      chainId: jurisdiction.chainId,
      address: jurisdiction.rpc,
      entityProviderAddress: jurisdiction.contracts.entityProvider,
      depositoryAddress: jurisdiction.contracts.depository,
    },
  };
  const mmEntityId = hashBoard(encodeBoard(consensusConfig)).toLowerCase();
  activeMmEntityId = mmEntityId;
  if (!getEntityReplicaById(env, mmEntityId)) {
    startupPhase = 'import-replica';
    enqueueRuntimeInput(env, {
      runtimeTxs: [{
        type: 'importReplica',
        entityId: mmEntityId,
        signerId: mmSignerId,
        data: {
          config: consensusConfig,
          isProposer: true,
          profileName: resolvedArgs.name,
          position: { x: 0, y: -40, z: 120 },
        },
      }],
      entityInputs: [],
    });
    await settleRuntimeFor(env, 35);
    await waitForReplicaReady(env, mmEntityId);
  }

  startupPhase = 'start-p2p';
  const p2p = startP2P(env, {
    relayUrls: [resolvedArgs.relayUrl],
    wsUrl: directWsUrl,
    advertiseEntityIds: [mmEntityId],
    gossipPollMs: BOOTSTRAP_POLL_MS * 5 || 250,
  });
  if (!p2p) throw new Error('P2P_START_FAILED');

  let shuttingDown = false;
  let loopInFlight = false;
  const driveQuotes = async (): Promise<void> => {
    if (loopInFlight) return;
    loopInFlight = true;
    try {
      const visibleHubs = readVisibleHubProfiles(env);
      const hubEntityIds = visibleHubs.map(profile => profile.entityId);
      if (hubEntityIds.length === 0) return;
      await maintainMarketMakerQuotes(env, mmEntityId, mmSignerId, hubEntityIds, hubSignerIdsByEntityId, tokenIds);
      await settleRuntimeFor(env, 45);
    } finally {
      loopInFlight = false;
    }
  };

  const waitForBootstrapOffers = async (): Promise<void> => {
    const deadline = Date.now() + MARKET_MAKER_BOOTSTRAP_TIMEOUT_MS;
    while (!shuttingDown && Date.now() < deadline) {
      await driveQuotes();
      const visibleHubs = readVisibleHubProfiles(env);
      const health = getMarketMakerHealth(env, mmEntityId, visibleHubs.map(profile => profile.entityId), tokenIds);
      if (health.ok) return;
      await sleep(MARKET_MAKER_BOOTSTRAP_LOOP_MS);
    }
    const visibleHubs = readVisibleHubProfiles(env);
    const health = getMarketMakerHealth(env, mmEntityId, visibleHubs.map(profile => profile.entityId), tokenIds);
    throw new Error(
      `[MESH-MM] BOOTSTRAP_TIMEOUT visibleHubs=${visibleHubs.length} offers=${safeStringify(health.hubs.map(hub => ({ hubEntityId: hub.hubEntityId, offers: hub.offers })))}`,
    );
  };

  let loop: ReturnType<typeof setInterval> | null = null;
  startupPhase = 'runtime-ready';
  console.log(
    `[MESH-MM] RUNTIME_READY entityId=${mmEntityId} runtimeId=${String(env.runtimeId || '')} api=${apiUrl} relay=${resolvedArgs.relayUrl}`,
  );

  startupPhase = 'bootstrap-offers';
  await waitForBootstrapOffers();
  startupPhase = 'offers-ready';
  console.log(
    `[MESH-MM] OFFERS_READY entityId=${mmEntityId} runtimeId=${String(env.runtimeId || '')} api=${apiUrl} relay=${resolvedArgs.relayUrl}`,
  );
  loop = setInterval(() => {
    if (shuttingDown) return;
    void driveQuotes().catch(error => {
      if (shuttingDown) return;
      console.error(`[MM] quote loop failed:`, (error as Error).message);
    });
  }, MARKET_MAKER_QUOTE_LOOP_MS);

  const shutdown = async (): Promise<void> => {
    shuttingDown = true;
    if (loop) clearInterval(loop);
    stopP2P(env);
    server.stop(true);
    process.exit(0);
  };

  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });
  await new Promise<void>(() => {});
};

clearJurisdictionsCache();
run().catch(error => {
  console.error(`[MESH-MM] FAILED:`, (error as Error).stack || (error as Error).message);
  process.exit(1);
});
