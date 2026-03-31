/**
 * XLN Unified Server
 *
 * Single entry point combining:
 * - XLN Runtime (always running)
 * - Static file serving (SPA)
 * - WebSocket relay (/relay)
 * - RPC for remote UI (/rpc)
 * - REST API (/api/*)
 *
 * Usage:
 *   bun runtime/server.ts                    # Server on :8080
 *   bun runtime/server.ts --port 9000        # Custom port
 */

import {
  main,
  enqueueRuntimeInput,
  startP2P,
  startRuntimeLoop,
  registerEntityRuntimeHint,
  clearDB,
  ensureGossipProfiles,
  getPersistedLatestHeight,
  readPersistedFrameJournals,
} from './runtime.ts';
import { deserializeTaggedJson, safeStringify, serializeTaggedJson } from './serialization-utils';
import type { AccountMachine, DeliverableEntityInput, Delta, EntityReplica, Env, EntityInput, EntityTx, RoutedEntityInput, RuntimeInput } from './types';
import type { HubHealth } from './health';
import { createExternalWalletApi } from './api/external-wallet-api';
import { encodeBoard, hashBoard } from './entity-factory';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from './account-crypto';
import { createJAdapter, DEV_CHAIN_IDS, type JAdapter } from './jadapter';
import type { JTokenInfo } from './jadapter/types';
import { DEFAULT_TOKENS, DEFAULT_TOKEN_SUPPLY, TOKEN_REGISTRATION_AMOUNT } from './jadapter/default-tokens';
import { resolveEntityProposerId } from './state-helpers';
import { DEFAULT_SPREAD_DISTRIBUTION, ORDERBOOK_PRICE_SCALE } from './orderbook';
import { buildDefaultEntitySwapPairs, deriveDelta, getSwapPairOrientation, getSwapPairPolicyByBaseQuote, getTokenInfo } from './account-utils';
import { LIMITS } from './constants';
import { encryptJSON, hexToPubKey } from './networking/p2p-crypto';
import type { Profile } from './networking/gossip';
import { encodeRebalancePolicyMemo } from './rebalance-policy';
import { hashHtlcSecret } from './htlc-utils';
import { isLoopbackUrl, toPublicRpcUrl } from './loopback-url';
import {
  type RelayStore,
  createRelayStore,
  normalizeRuntimeKey,
  nextWsTimestamp,
  pushDebugEvent,
  storeGossipProfile,
  getAllGossipProfiles,
  removeClient,
  resetStore as resetRelayStore,
  resolveEncryptionPublicKeyHex,
  cacheEncryptionKey,
} from './relay-store';
import { relayRoute, type RelayRouterConfig } from './relay-router';
import { createLocalDeliveryHandler } from './relay-local-delivery';
import { resolveJurisdictionsJsonPath } from './jurisdictions-path';
import {
  RPC_MARKET_DEFAULT_DEPTH,
  RPC_MARKET_MAX_DEPTH,
  RPC_MARKET_PUBLISH_MS,
  buildMarketSnapshotForReplica,
  normalizeMarketEntityId,
  normalizeMarketPairId,
  type MarketSnapshotPayload,
} from './market-snapshot';
import { ethers } from 'ethers';
import type { ContractRunner } from 'ethers';
import { ERC20Mock__factory } from '../jurisdictions/typechain-types/index.ts';
import { mkdir, readdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import type { ServerWebSocket } from 'bun';

// Global J-adapter instance (set during startup)
let globalJAdapter: JAdapter | null = null;
let serverEnv: Env | null = null;
let serverStartupBarrier: Promise<void> = Promise.resolve();
let resolveServerStartupBarrier: (() => void) | null = null;
// Server encryption keypair now managed by relay-local-delivery.ts
const HUB_SEED = process.env.HUB_SEED ?? 'xln-main-hub-2026';
const HEALTH_CACHE_TTL_MS = 10_000;
let cachedHealthResponse:
  | {
      body: string;
      expiresAt: number;
    }
  | null = null;
let cachedHealthInFlight: Promise<string> | null = null;

let tokenCatalogCache: JTokenInfo[] | null = null;
let tokenCatalogPromise: Promise<JTokenInfo[]> | null = null;
let processGuardsInstalled = false;
const ENTITY_ID_HEX_32_RE = /^0x[0-9a-fA-F]{64}$/;
type RelaySocketData = { type: 'relay' | 'rpc' };
type RelaySocket = ServerWebSocket<RelaySocketData>;
const isEntityId32 = (value: unknown): value is string => typeof value === 'string' && ENTITY_ID_HEX_32_RE.test(value);
const JSON_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': '*',
  'Access-Control-Allow-Headers': '*',
  'Content-Type': 'application/json',
} as const;
const DEBUG_DUMPS_DIR = join(process.cwd(), '.logs', 'debug-dumps');
const formatTimingMs = (value: number): string => value.toFixed(2);
const stringifyBootstrapDebug = (value: unknown): string =>
  JSON.stringify(value, (_key, nested) => (typeof nested === 'bigint' ? nested.toString() : nested));
const STACK_COMPATIBILITY_PROBE_ENTITY = `0x${'11'.repeat(32)}`;
const resolveRequiredAnvilRpc = (): string => {
  const rpcUrl = String(process.env.ANVIL_RPC || '').trim();
  if (!rpcUrl) {
    throw new Error('ANVIL_RPC is required for server RPC operations');
  }
  return rpcUrl;
};

const ensureDebugDumpDir = async (): Promise<void> => {
  await mkdir(DEBUG_DUMPS_DIR, { recursive: true });
};

const buildDebugDumpFileName = (reason: string | undefined, runtimeId: string | undefined): string => {
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  const reasonPart = String(reason || 'dump')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .slice(0, 48) || 'dump';
  const runtimePart = String(runtimeId || 'runtime').replace(/[^a-zA-Z0-9_-]+/g, '').slice(-16) || 'runtime';
  return `${iso}-${reasonPart}-${runtimePart}.json`;
};

const invalidateHealthCache = (): void => {
  cachedHealthResponse = null;
  cachedHealthInFlight = null;
};

const probeLocalAnvilContractStack = async (adapter: JAdapter): Promise<{ ok: boolean; reason: string }> => {
  const depositoryAddress = String(adapter.addresses?.depository || '').trim();
  if (!depositoryAddress) {
    return { ok: false, reason: 'DEPOSITORY_ADDRESS_MISSING' };
  }

  const code = await adapter.provider.getCode(depositoryAddress);
  if (!code || code === '0x') {
    return { ok: false, reason: 'DEPOSITORY_CODE_MISSING' };
  }

  const probe = new ethers.Contract(
    depositoryAddress,
    [
      'function getTokensLength() view returns(uint256)',
      'function mintToReserve(bytes32,uint256,uint256)',
      'function mintToReserveBatch((bytes32,uint256,uint256)[])',
    ],
    adapter.signer as ethers.ContractRunner,
  );

  let tokensLength = 0n;
  try {
    tokensLength = await probe.getTokensLength();
  } catch (error) {
    return {
      ok: false,
      reason: `DEPOSITORY_READ_FAILED:${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (tokensLength < 1n) {
    return { ok: false, reason: 'TOKEN_REGISTRY_EMPTY' };
  }

  try {
    await probe.mintToReserve.estimateGas(STACK_COMPATIBILITY_PROBE_ENTITY, 1n, 1n);
  } catch (error) {
    return {
      ok: false,
      reason: `MINT_TO_RESERVE_UNAVAILABLE:${error instanceof Error ? error.message : String(error)}`,
    };
  }

  try {
    await probe.mintToReserveBatch.estimateGas([[STACK_COMPATIBILITY_PROBE_ENTITY, 1n, 1n]]);
  } catch (error) {
    return {
      ok: false,
      reason: `MINT_TO_RESERVE_BATCH_UNAVAILABLE:${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return { ok: true, reason: 'OK' };
};

const resolveRuntimeWaitPollMs = (): number => {
  if (!globalJAdapter) return 100;
  if (globalJAdapter.mode === 'browservm') return 10;
  if (DEV_CHAIN_IDS.has(globalJAdapter.chainId)) return 25;
  return 100;
};

const resolveReserveWaitPollMs = (): number => {
  if (!globalJAdapter) return 300;
  if (globalJAdapter.mode === 'browservm') return 10;
  if (DEV_CHAIN_IDS.has(globalJAdapter.chainId)) return 50;
  return 300;
};

const STARTUP_STEP_TIMEOUT_MS = Math.max(
  5_000,
  Math.floor(Number(process.env.XLN_STARTUP_STEP_TIMEOUT_MS ?? '20000')),
);

const withStartupStepTimeout = async <T>(label: string, work: Promise<T>, timeoutMs = STARTUP_STEP_TIMEOUT_MS): Promise<T> => {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`[XLN] Startup step timed out: ${label} after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
};

const fetchRpcCode = async (
  rpcUrl: string,
  address: string,
  timeoutMs = Math.min(STARTUP_STEP_TIMEOUT_MS, 10_000),
): Promise<string> => {
  if (!ethers.isAddress(address)) {
    throw new Error(`INVALID_PREDEPLOYED_ADDRESS:${String(address)}`);
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getCode',
        params: [address, 'latest'],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`ETH_GET_CODE_HTTP_${response.status}`);
    }

    const body = await response.json() as { result?: unknown; error?: { message?: string } };
    if (body.error) {
      throw new Error(`ETH_GET_CODE_RPC:${body.error.message || 'unknown'}`);
    }
    if (typeof body.result !== 'string') {
      throw new Error('ETH_GET_CODE_INVALID_RESULT');
    }
    return body.result;
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      throw new Error(`ETH_GET_CODE_TIMEOUT:${address}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
};

const isServerBootInProgress = (): boolean =>
  serverBootPhase === 'starting' || serverBootPhase === 'runtime' || serverBootPhase === 'bootstrap';

const oneShotLogs = new Map<string, number>();
const ONE_SHOT_TTL_MS = 60_000;
const logOneShot = (key: string, message: string) => {
  const nowMs = Date.now();
  const last = oneShotLogs.get(key) ?? 0;
  if (nowMs - last < ONE_SHOT_TTL_MS) return;
  oneShotLogs.set(key, nowMs);
  console.warn(message);
};

const hasPendingRuntimeWork = (env: Env): boolean => {
  if (env.pendingOutputs?.length) return true;
  if (env.networkInbox?.length) return true;
  if (env.runtimeInput?.runtimeTxs?.length) return true;
  // Check P2P mempool (where enqueueRuntimeInputs puts inbound messages)
  if (env.runtimeMempool?.entityInputs?.length) return true;
  if (env.runtimeMempool?.runtimeTxs?.length) return true;

  if (env.jReplicas) {
    for (const replica of env.jReplicas.values()) {
      if ((replica.mempool?.length ?? 0) > 0) return true;
    }
  }

  return false;
};

const waitForRuntimeIdle = async (env: Env, timeoutMs = 5000): Promise<boolean> => {
  const started = Date.now();
  const pollMs = resolveRuntimeWaitPollMs();
  while (Date.now() - started < timeoutMs) {
    if (!hasPendingRuntimeWork(env)) return true;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  return false;
};

const waitForJBatchClear = async (env: Env, timeoutMs = 5000): Promise<boolean> => {
  const started = Date.now();
  const pollMs = resolveRuntimeWaitPollMs();
  while (Date.now() - started < timeoutMs) {
    const pendingJ = Array.from(env.jReplicas?.values?.() || []).some(j => (j.mempool?.length ?? 0) > 0);
    if (!pendingJ && !hasPendingRuntimeWork(env)) return true;
    await new Promise(resolve => setTimeout(resolve, pollMs));
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
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  return false;
};

const waitForReserveUpdate = async (
  entityId: string,
  tokenId: number,
  expectedMin: bigint,
  timeoutMs = 10000,
): Promise<bigint | null> => {
  if (!globalJAdapter) return null;
  const started = Date.now();
  const pollMs = resolveReserveWaitPollMs();
  while (Date.now() - started < timeoutMs) {
    try {
      const current = await globalJAdapter.getReserves(entityId, tokenId);
      if (current >= expectedMin) return current;
    } catch (err) {
      console.warn('[FAUCET] getReserves failed while waiting:', (err as Error).message);
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  return null;
};

const hubSignerLabels = new Map<string, string>();
const hubSignerAddresses = new Map<string, string>();
const SERVER_RUNTIME_SEED = (() => {
  const seed = process.env.XLN_RUNTIME_SEED?.trim();
  if (!seed) {
    throw new Error('XLN_RUNTIME_SEED is required for runtime/server.ts');
  }
  return seed;
})();
const HUB_MESH_TOKEN_ID = 1;
const HUB_MESH_CREDIT_AMOUNT = 1_000_000n * 10n ** 18n;
const HUB_MESH_REQUIRED_HUBS = 3;
const HUB_REQUIRED_TOKEN_COUNT = 3;
const HUB_RESERVE_TARGET_UNITS = 1_000_000_000n;
const HUB_WALLET_ETH_TARGET = ethers.parseEther('1000');
const FAUCET_SIGNER_LABEL = process.env.FAUCET_SIGNER_LABEL ?? 'faucet-1';
const FAUCET_SEED = process.env.FAUCET_SEED ?? `${SERVER_RUNTIME_SEED}:faucet`;
const FAUCET_WALLET_ETH_TARGET = ethers.parseEther('100');
const FAUCET_TOKEN_TARGET_UNITS = 1_000_000n;
const HUB_RESERVE_ASSERT_TIMEOUT_MS = 30_000;
const HUB_MESH_ASSERT_TIMEOUT_MS = 20_000;
const HUB_DEFAULT_SUPPORTED_PAIRS = ['1/2', '1/3', '2/3'] as const;
const HUB_DEFAULT_MIN_TRADE_SIZE = 10n * 10n ** 18n;
const BOOTSTRAP_POLL_MS = Math.max(
  10,
  Number(process.env.BOOTSTRAP_POLL_MS || (process.env.NODE_ENV === 'production' ? '40' : '50')),
);
const RUNTIME_SETTLE_POLL_MS = Math.max(
  5,
  Number(process.env.RUNTIME_SETTLE_POLL_MS || (process.env.NODE_ENV === 'production' ? '25' : '10')),
);
const INCLUDE_MARKET_MAKER_BY_DEFAULT = !/^(0|false)$/i.test(process.env.XLN_INCLUDE_MARKET_MAKER ?? '1');
const SKIP_SERVER_BOOTSTRAP = /^(1|true)$/i.test(process.env.XLN_SKIP_SERVER_BOOTSTRAP ?? '');
const MARKET_MAKER_SIGNER_LABEL = process.env.MARKET_MAKER_SIGNER_LABEL ?? 'mm-1';
const MARKET_MAKER_SEED = process.env.MARKET_MAKER_SEED ?? `${HUB_SEED}:market-maker`;
const MARKET_MAKER_NAME = process.env.MARKET_MAKER_NAME ?? 'MM1';
const MARKET_MAKER_CREDIT_AMOUNT = 50_000_000n * 10n ** 18n;
const MARKET_MAKER_QUOTE_LOOP_MS = Math.max(1000, Number(process.env.MARKET_MAKER_QUOTE_LOOP_MS || '30000'));
const MARKET_MAKER_OFFERS_PER_ACCOUNT_PER_TICK = Math.max(
  10,
  Number(process.env.MARKET_MAKER_OFFERS_PER_ACCOUNT_PER_TICK || '30'),
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
const MARKET_MAKER_MIN_READY_OFFERS_PER_PAIR = 30;
type MarketMakerLevelProfile = {
  offsetsBps: readonly number[];
  baseSizes: readonly bigint[];
};

const getMarketMakerLevelProfile = (baseTokenId: number, quoteTokenId: number): MarketMakerLevelProfile => {
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

const getExpectedMarketMakerOffersForPair = (baseTokenId: number, quoteTokenId: number): number => {
  return Math.min(
    MARKET_MAKER_MIN_READY_OFFERS_PER_PAIR,
    getMarketMakerLevelProfile(baseTokenId, quoteTokenId).offsetsBps.length * 2,
  );
};

let marketMakerLoopTimer: ReturnType<typeof setInterval> | null = null;
let marketMakerLoopInFlight = false;
let marketMakerEntityId: string | null = null;
let marketMakerTargetHubIds: string[] = [];
let marketMakerTokenIds: number[] = [];

type MarketMakerOfferSpec = {
  offerId: string;
  hubEntityId: string;
  giveTokenId: number;
  giveAmount: bigint;
  wantTokenId: number;
  wantAmount: bigint;
  minFillRatio: number;
};

const getMapValueCaseInsensitive = <T>(map: Map<string, T>, key: string | undefined): T | undefined => {
  if (!key) return undefined;
  const needle = key.toLowerCase();
  for (const [mapKey, value] of map.entries()) {
    if (String(mapKey).toLowerCase() === needle) return value;
  }
  return undefined;
};

const getHubWallet = async (
  env: Env,
  hubEntityId?: string,
): Promise<{ hubEntityId: string; hubSignerId: string; wallet: ethers.Wallet } | null> => {
  if (!globalJAdapter) return null;
  const activeHubIds = relayStore.activeHubEntityIds;
  let targetEntityId = String(hubEntityId || '').toLowerCase();

  if (!targetEntityId) {
    const firstActiveWithSigner = activeHubIds.find(id => !!getMapValueCaseInsensitive(hubSignerLabels, id));
    if (firstActiveWithSigner) {
      targetEntityId = String(firstActiveWithSigner).toLowerCase();
    } else {
      const hubs = getFaucetHubProfiles(env);
      const firstFaucetWithSigner = hubs.find(h => !!getMapValueCaseInsensitive(hubSignerLabels, h?.entityId));
      if (!firstFaucetWithSigner?.entityId) return null;
      targetEntityId = String(firstFaucetWithSigner.entityId).toLowerCase();
    }
  }

  const signerLabel = getMapValueCaseInsensitive(hubSignerLabels, targetEntityId);
  if (!signerLabel) {
    console.warn(
      `[XLN] Hub signer label missing for ${targetEntityId.slice(0, 12)}... active=${activeHubIds.map(id => id.slice(-8)).join(',')}`,
    );
    return null;
  }
  const hubSignerAddress = getMapValueCaseInsensitive(hubSignerAddresses, targetEntityId);
  const hubPrivateKeyBytes = deriveSignerKeySync(HUB_SEED, signerLabel);
  const hubPrivateKeyHex = '0x' + Buffer.from(hubPrivateKeyBytes).toString('hex');
  const wallet = new ethers.Wallet(hubPrivateKeyHex, globalJAdapter.provider);
  if (hubSignerAddress && wallet.address.toLowerCase() !== hubSignerAddress.toLowerCase()) {
    console.error(
      `[XLN] Hub signer address mismatch for ${targetEntityId.slice(0, 12)}... expected=${hubSignerAddress} got=${wallet.address}`,
    );
    return null;
  }
  return { hubEntityId: targetEntityId, hubSignerId: hubSignerAddress ?? wallet.address, wallet };
};

const ensureHubWalletFunding = async (
  env: Env,
  options: {
    hubEntityId?: string;
    tokenCatalog?: JTokenInfo[];
    ensureTokens?: boolean;
    ensureEth?: boolean;
  } = {},
): Promise<{ hubEntityId: string; hubSignerId: string; wallet: ethers.Wallet } | null> => {
  if (!globalJAdapter) return null;
  const hub = await getHubWallet(env, options.hubEntityId);
  if (!hub) return null;

  if (globalJAdapter.mode === 'browservm') {
    if (options.ensureEth !== false) {
      if (globalJAdapter.fundSignerWallet) {
        await globalJAdapter.fundSignerWallet(await hub.wallet.getAddress(), HUB_WALLET_ETH_TARGET);
      }
    }
    return hub;
  }

  const hubWalletAddress = await hub.wallet.getAddress();
  const deployer = globalJAdapter.signer;
  const ensureTokens = options.ensureTokens === true;
  const ensureEth = options.ensureEth !== false;

  if (ensureTokens) {
    const erc20Abi = [
      'function transfer(address to, uint256 amount) returns (bool)',
      'function balanceOf(address) view returns (uint256)',
    ];
    const tokenCatalog = options.tokenCatalog ?? [];
    for (const token of tokenCatalog.slice(0, HUB_REQUIRED_TOKEN_COUNT)) {
      if (!token?.address) continue;
      const targetBalance = HUB_RESERVE_TARGET_UNITS * 10n ** BigInt(token.decimals ?? 18);
      const erc20 = new ethers.Contract(token.address, erc20Abi, deployer);
      const hubBalance = await erc20.balanceOf(hubWalletAddress);
      if (hubBalance >= targetBalance) continue;
      const tx = await erc20.transfer(hubWalletAddress, targetBalance - hubBalance);
      await tx.wait();
    }
  }

  if (ensureEth) {
    const currentEth = await globalJAdapter.provider.getBalance(hubWalletAddress);
    if (currentEth < HUB_WALLET_ETH_TARGET) {
      const tx = await deployer.sendTransaction({
        to: hubWalletAddress,
        value: HUB_WALLET_ETH_TARGET - currentEth,
      });
      await tx.wait();
    }
  }

  return hub;
};

const externalWalletApi = createExternalWalletApi({
  getJAdapter: () => globalJAdapter,
  getRuntimeId: () => String(serverEnv?.runtimeId || ''),
  getTokenCatalog: async () => ensureTokenCatalog(),
  jsonHeaders: JSON_HEADERS,
  faucetSeed: FAUCET_SEED,
  faucetSignerLabel: FAUCET_SIGNER_LABEL,
  faucetWalletEthTarget: FAUCET_WALLET_ETH_TARGET,
  faucetTokenTargetUnits: FAUCET_TOKEN_TARGET_UNITS,
  emitDebugEvent: (entry) => {
    pushDebugEvent(relayStore, entry);
  },
  fundBrowserVmWallet: async (address: string, amount: bigint): Promise<boolean> => {
    if (!globalJAdapter?.fundSignerWallet) return false;
    await globalJAdapter.fundSignerWallet(address, amount);
    return true;
  },
});

const isHubProfile = (profile: Profile): boolean => {
  return profile.metadata.isHub === true;
};

const isFaucetHubProfile = (profile: Profile): boolean => {
  return relayStore.activeHubEntityIds.some(id => id.toLowerCase() === profile.entityId.toLowerCase());
};

const getFaucetHubProfiles = (env: Env): Profile[] => {
  const profiles = env.gossip?.getProfiles?.() || [];
  const selected: Profile[] = [];
  for (const profile of profiles) {
    if (!isHubProfile(profile) || !isFaucetHubProfile(profile)) continue;
    selected.push(profile);
  }
  const activeSet = new Set(relayStore.activeHubEntityIds.map(id => id.toLowerCase()));
  selected.sort((a, b) => {
    const aActive = activeSet.has(String(a?.entityId || '').toLowerCase()) ? 1 : 0;
    const bActive = activeSet.has(String(b?.entityId || '').toLowerCase()) ? 1 : 0;
    return bActive - aActive;
  });
  return selected;
};

const getMergedKnownGossipProfiles = (env: Env | null): Map<string, Profile> => {
  const merged = new Map<string, Profile>();
  for (const profile of getAllGossipProfiles(relayStore)) {
    const entityId = String(profile?.entityId || '').trim().toLowerCase();
    if (!entityId) continue;
    merged.set(entityId, profile);
  }
  for (const profile of env?.gossip?.getProfiles?.() || []) {
    const entityId = String(profile?.entityId || '').trim().toLowerCase();
    if (!entityId) continue;
    merged.set(entityId, profile);
  }
  return merged;
};

const getKnownProfileBundle = (env: Env | null, entityId: string): { profile: Profile | null; peers: Profile[] } => {
  const target = String(entityId || '').trim().toLowerCase();
  if (!target) return { profile: null, peers: [] };
  const merged = getMergedKnownGossipProfiles(env);
  const profile = merged.get(target) || null;
  if (!profile) return { profile: null, peers: [] };
  const peerIds = new Set<string>();
  for (const peerId of Array.isArray(profile.publicAccounts) ? profile.publicAccounts : []) {
    const normalized = String(peerId || '').trim().toLowerCase();
    if (normalized) peerIds.add(normalized);
  }
  for (const account of Array.isArray(profile.accounts) ? profile.accounts : []) {
    const normalized = String(account?.counterpartyId || '').trim().toLowerCase();
    if (normalized) peerIds.add(normalized);
  }
  const peers: Profile[] = [];
  for (const peerId of peerIds) {
    const peer = merged.get(peerId);
    if (peer) peers.push(peer);
  }
  return { profile, peers };
};

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms));
};

const REQUEST_CREDIT_CAP_WHOLE = 1_000n;

const getRequestCreditCap = (tokenId: number): bigint => {
  const decimals = Number(getTokenInfo(tokenId).decimals);
  const normalizedDecimals = Number.isFinite(decimals) && decimals >= 0 ? Math.floor(decimals) : 18;
  return REQUEST_CREDIT_CAP_WHOLE * 10n ** BigInt(normalizedDecimals);
};

const getEntityReplicaById = (env: Env, entityId: string): EntityReplica | null => {
  if (!env.eReplicas) return null;
  const target = entityId.toLowerCase();
  for (const [key, replica] of env.eReplicas.entries()) {
    if (typeof key === 'string' && key.toLowerCase().startsWith(`${target}:`)) {
      return replica;
    }
  }
  return null;
};

const accountMatchesCounterparty = (
  account: AccountMachine | null | undefined,
  ownerEntityId: string,
  counterpartyId: string,
): boolean => {
  const needle = String(counterpartyId || '').toLowerCase();
  if (!needle) return false;

  const cp = typeof account?.counterpartyEntityId === 'string' ? account.counterpartyEntityId.toLowerCase() : '';
  if (cp === needle) return true;

  const me = String(ownerEntityId || '').toLowerCase();
  const left = typeof account?.leftEntity === 'string' ? account.leftEntity.toLowerCase() : '';
  const right = typeof account?.rightEntity === 'string' ? account.rightEntity.toLowerCase() : '';

  if (left && right) {
    if (left === me && right === needle) return true;
    if (right === me && left === needle) return true;
  }

  return false;
};

const getAccountDelta = (env: Env, entityId: string, counterpartyId: string, tokenId: number): Delta | null => {
  const account = getAccountMachine(env, entityId, counterpartyId);
  if (!account?.deltas) return null;
  return account.deltas.get(tokenId) ?? null;
};

const hasPairMutualCredit = (
  env: Env,
  leftEntityId: string,
  rightEntityId: string,
  tokenId: number,
  amount: bigint,
): boolean => {
  const leftAccount = getAccountMachine(env, leftEntityId, rightEntityId);
  const rightAccount = getAccountMachine(env, rightEntityId, leftEntityId);
  if (!leftAccount || !rightAccount) return false;
  return (
    getEntityOutCapacity(leftAccount, leftEntityId, tokenId) >= amount &&
    getEntityOutCapacity(rightAccount, rightEntityId, tokenId) >= amount
  );
};

const hasAccount = (env: Env, entityId: string, counterpartyId: string): boolean => {
  const replica = getEntityReplicaById(env, entityId);
  if (!replica?.state?.accounts) return false;
  const needle = counterpartyId.toLowerCase();
  for (const [key, account] of replica.state.accounts.entries()) {
    if (typeof key === 'string' && key.toLowerCase() === needle) {
      return true;
    }
    if (accountMatchesCounterparty(account, entityId, counterpartyId)) return true;
  }
  return false;
};

const getAccountMachine = (env: Env, entityId: string, counterpartyId: string): AccountMachine | null => {
  const replica = getEntityReplicaById(env, entityId);
  if (!replica?.state?.accounts) return null;
  const needle = counterpartyId.toLowerCase();
  for (const [key, account] of replica.state.accounts.entries()) {
    if (typeof key === 'string' && key.toLowerCase() === needle) {
      return account ?? null;
    }
    if (accountMatchesCounterparty(account, entityId, counterpartyId)) {
      return account ?? null;
    }
  }
  return null;
};

const getEntityOutCapacity = (
  account: AccountMachine | null,
  ownerEntityId: string,
  tokenId: number,
): bigint => {
  if (!account) return 0n;
  const delta = account.deltas.get(tokenId);
  if (!delta) return 0n;
  return deriveDelta(delta, account.leftEntity === ownerEntityId).outCapacity;
};

const isAccountConsensusReady = (account: AccountMachine | null): boolean => {
  if (!account) return false;
  if (!account.currentFrame) return false;
  if (Number(account.currentHeight ?? 0) <= 0) return false;
  if (account.pendingFrame) return false;
  if ((account.mempool?.length ?? 0) > 0) return false;
  return true;
};

const ensurePairMutualCreditForToken = async (
  env: Env,
  leftEntityId: string,
  leftSignerId: string,
  rightEntityId: string,
  rightSignerId: string,
  tokenId: number,
  amount: bigint,
): Promise<boolean> => {
  if (hasPairMutualCredit(env, leftEntityId, rightEntityId, tokenId, amount)) return true;
  if (!hasAccount(env, leftEntityId, rightEntityId) || !hasAccount(env, rightEntityId, leftEntityId)) return false;

  const pairReady = await waitUntil(() => {
    const leftAccount = getAccountMachine(env, leftEntityId, rightEntityId);
    const rightAccount = getAccountMachine(env, rightEntityId, leftEntityId);
    if (!leftAccount || !rightAccount) return false;
    return isAccountConsensusReady(leftAccount) && isAccountConsensusReady(rightAccount);
  }, 180, RUNTIME_SETTLE_POLL_MS);
  if (!pairReady) return false;

  const leftAccount = getAccountMachine(env, leftEntityId, rightEntityId);
  const rightAccount = getAccountMachine(env, rightEntityId, leftEntityId);
  if (!leftAccount || !rightAccount) return false;

  const entityInputs: EntityInput[] = [];
  const leftOutCapacity = getEntityOutCapacity(leftAccount, leftEntityId, tokenId);
  const rightOutCapacity = getEntityOutCapacity(rightAccount, rightEntityId, tokenId);

  if (leftOutCapacity < amount) {
    entityInputs.push({
      entityId: rightEntityId,
      signerId: rightSignerId,
      entityTxs: [{
        type: 'extendCredit',
        data: {
          counterpartyEntityId: leftEntityId,
          tokenId,
          amount,
        },
      }],
    });
  }

  if (rightOutCapacity < amount) {
    entityInputs.push({
      entityId: leftEntityId,
      signerId: leftSignerId,
      entityTxs: [{
        type: 'extendCredit',
        data: {
          counterpartyEntityId: rightEntityId,
          tokenId,
          amount,
        },
      }],
    });
  }

  if (entityInputs.length === 0) {
    return hasPairMutualCredit(env, leftEntityId, rightEntityId, tokenId, amount);
  }

  enqueueRuntimeInput(env, { runtimeTxs: [], entityInputs });
  return await waitUntil(
    () => hasPairMutualCredit(env, leftEntityId, rightEntityId, tokenId, amount),
    180,
    RUNTIME_SETTLE_POLL_MS,
  );
};

const getHubMeshHealth = (env: Env | null) => {
  if (!env) {
    return {
      requiredHubCount: HUB_MESH_REQUIRED_HUBS,
      tokenId: HUB_MESH_TOKEN_ID,
      requiredCredit: HUB_MESH_CREDIT_AMOUNT.toString(),
      hubIds: [] as string[],
      pairs: [] as Array<{
        left: string;
        right: string;
        tokenId: number;
        requiredCredit: string;
        leftHasAccount: boolean;
        rightHasAccount: boolean;
        leftOutCapacity: string;
        rightOutCapacity: string;
        ok: boolean;
      }>,
      ok: false,
    };
  }
  const hubIds = relayStore.activeHubEntityIds.slice(0, HUB_MESH_REQUIRED_HUBS);
  const pairStatuses: Array<{
    left: string;
    right: string;
    tokenId: number;
    requiredCredit: string;
    leftHasAccount: boolean;
    rightHasAccount: boolean;
    leftOutCapacity: string;
    rightOutCapacity: string;
    ok: boolean;
  }> = [];

  for (let i = 0; i < hubIds.length; i++) {
    for (let j = i + 1; j < hubIds.length; j++) {
      const left = hubIds[i]!;
      const right = hubIds[j]!;
      const leftAccount = getAccountMachine(env, left, right);
      const rightAccount = getAccountMachine(env, right, left);
      const leftHasAccount = hasAccount(env, left, right);
      const rightHasAccount = hasAccount(env, right, left);
      const leftOutCapacity = getEntityOutCapacity(leftAccount, left, HUB_MESH_TOKEN_ID);
      const rightOutCapacity = getEntityOutCapacity(rightAccount, right, HUB_MESH_TOKEN_ID);
      const ok =
        leftHasAccount &&
        rightHasAccount &&
        leftOutCapacity >= HUB_MESH_CREDIT_AMOUNT &&
        rightOutCapacity >= HUB_MESH_CREDIT_AMOUNT;

      pairStatuses.push({
        left,
        right,
        tokenId: HUB_MESH_TOKEN_ID,
        requiredCredit: HUB_MESH_CREDIT_AMOUNT.toString(),
        leftHasAccount,
        rightHasAccount,
        leftOutCapacity: leftOutCapacity.toString(),
        rightOutCapacity: rightOutCapacity.toString(),
        ok,
      });
    }
  }

  const ok = hubIds.length >= HUB_MESH_REQUIRED_HUBS && pairStatuses.length > 0 && pairStatuses.every(p => p.ok);

  return {
    requiredHubCount: HUB_MESH_REQUIRED_HUBS,
    tokenId: HUB_MESH_TOKEN_ID,
    requiredCredit: HUB_MESH_CREDIT_AMOUNT.toString(),
    hubIds,
    pairs: pairStatuses,
    ok,
  };
};

type BootstrapReserveTokenHealth = {
  tokenId: number;
  symbol: string;
  decimals: number;
  current: string;
  expectedMin: string;
  ready: boolean;
};

type BootstrapReserveEntityHealth = {
  entityId: string;
  role: 'hub' | 'market-maker';
  ready: boolean;
  tokens: BootstrapReserveTokenHealth[];
};

type BootstrapReserveHealth = {
  ok: boolean;
  requiredTokenCount: number;
  entityCount: number;
  entities: BootstrapReserveEntityHealth[];
};

const compareText = (left: string, right: string): number => {
  if (left === right) return 0;
  return left < right ? -1 : 1;
};

const serializeReserveMap = (reserves: ReadonlyMap<string | number, bigint>): Record<string, string> => {
  const entries = Array.from(reserves.entries())
    .map(([tokenId, amount]) => [String(tokenId), amount.toString()] as const)
    .sort(([left], [right]) => {
      const leftNum = Number(left);
      const rightNum = Number(right);
      if (Number.isFinite(leftNum) && Number.isFinite(rightNum) && leftNum !== rightNum) {
        return leftNum - rightNum;
      }
      return compareText(left, right);
    });
  return Object.fromEntries(entries);
};

const getReplicaReserveSnapshot = (env: Env, entityId: string): Record<string, string> | undefined => {
  const replica = getEntityReplicaById(env, entityId);
  if (!replica?.state?.reserves || replica.state.reserves.size === 0) return undefined;
  return serializeReserveMap(replica.state.reserves);
};

const getReplicaAccountCount = (env: Env, entityId: string): number | undefined => {
  const replica = getEntityReplicaById(env, entityId);
  return replica?.state?.accounts?.size;
};

const getBootstrapReserveHealth = async (env: Env | null): Promise<BootstrapReserveHealth> => {
  if (!env) {
    return {
      ok: false,
      requiredTokenCount: HUB_REQUIRED_TOKEN_COUNT,
      entityCount: 0,
      entities: [],
    };
  }

  const tokenCatalog = await ensureTokenCatalog().catch(() => []);
  const bootstrapTokens = tokenCatalog
    .slice(0, HUB_REQUIRED_TOKEN_COUNT)
    .map((token) => ({
      tokenId: Number(token.tokenId),
      symbol: String(token.symbol || `token-${token.tokenId}`),
      decimals: Number.isFinite(token.decimals) ? Number(token.decimals) : 18,
    }))
    .filter((token) => Number.isFinite(token.tokenId) && token.tokenId > 0);

  const entityIds = Array.from(
    new Set(
      [
        ...relayStore.activeHubEntityIds.map((entityId) => entityId.toLowerCase()),
        ...(marketMakerEntityId ? [marketMakerEntityId.toLowerCase()] : []),
      ].filter((entityId) => entityId.length > 0),
    ),
  );

  const entities = entityIds.map<BootstrapReserveEntityHealth>((entityId) => {
    const replica = getEntityReplicaById(env, entityId);
    const role: 'hub' | 'market-maker' =
      marketMakerEntityId && entityId === marketMakerEntityId.toLowerCase() ? 'market-maker' : 'hub';
    const tokens = bootstrapTokens.map<BootstrapReserveTokenHealth>((token) => {
      const current = replica?.state?.reserves?.get(token.tokenId) ?? 0n;
      const expectedMin = HUB_RESERVE_TARGET_UNITS * 10n ** BigInt(token.decimals);
      return {
        tokenId: token.tokenId,
        symbol: token.symbol,
        decimals: token.decimals,
        current: current.toString(),
        expectedMin: expectedMin.toString(),
        ready: current >= expectedMin,
      };
    });
    return {
      entityId,
      role,
      ready: tokens.length >= HUB_REQUIRED_TOKEN_COUNT && tokens.every((token) => token.ready),
      tokens,
    };
  });

  return {
    ok:
      bootstrapTokens.length >= HUB_REQUIRED_TOKEN_COUNT &&
      entities.length > 0 &&
      entities.every((entity) => entity.ready),
    requiredTokenCount: HUB_REQUIRED_TOKEN_COUNT,
    entityCount: entities.length,
    entities,
  };
};

const getHubSignerForEntity = (env: Env, entityId: string): string => {
  return hubSignerAddresses.get(entityId) || resolveEntityProposerId(env, entityId, 'hub-mesh-bootstrap');
};

const waitUntil = async (predicate: () => boolean, maxAttempts = 120, stepMs = BOOTSTRAP_POLL_MS): Promise<boolean> => {
  for (let i = 0; i < maxAttempts; i++) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return false;
};

const settleRuntimeFor = async (env: Env, rounds = 30): Promise<void> => {
  for (let i = 0; i < rounds; i++) {
    if (!hasPendingRuntimeWork(env)) break;
    await sleep(RUNTIME_SETTLE_POLL_MS);
  }
};

const stopMarketMakerLoop = (): void => {
  if (marketMakerLoopTimer) {
    clearInterval(marketMakerLoopTimer);
    marketMakerLoopTimer = null;
  }
  marketMakerLoopInFlight = false;
  marketMakerEntityId = null;
  marketMakerTargetHubIds = [];
  marketMakerTokenIds = [];
};

const normalizeTokenIdsForMm = (tokenCatalog: JTokenInfo[]): number[] => {
  const ids = tokenCatalog
    .map(token => Number(token.tokenId))
    .filter(tokenId => Number.isFinite(tokenId) && tokenId > 0)
    .sort((a, b) => a - b);
  return Array.from(new Set(ids)).slice(0, 3);
};

const buildMarketMakerPairs = (tokenIds: number[]): Array<{ baseTokenId: number; quoteTokenId: number; pairId: string }> => {
  return buildDefaultEntitySwapPairs(tokenIds);
};

const ensureMarketMakerEntity = async (
  env: Env,
): Promise<{ entityId: string; signerId: string } | null> => {
  const mmSignerPrivateKey = deriveSignerKeySync(MARKET_MAKER_SEED, MARKET_MAKER_SIGNER_LABEL);
  const mmSignerId = deriveSignerAddressSync(MARKET_MAKER_SEED, MARKET_MAKER_SIGNER_LABEL);
  registerSignerKey(mmSignerId, mmSignerPrivateKey);

  const activeJurisdictionName =
    env.activeJurisdiction || (env.jReplicas ? Array.from(env.jReplicas.keys())[0] : undefined);
  const activeJReplica = activeJurisdictionName ? env.jReplicas?.get(activeJurisdictionName) : undefined;
  const jurisdictionConfig = activeJReplica
    ? {
        name: activeJurisdictionName,
        chainId: Number(activeJReplica.jadapter?.chainId ?? activeJReplica.chainId ?? 0),
        address: activeJReplica.rpcs?.[0] ?? '',
        entityProviderAddress: activeJReplica.entityProviderAddress ?? activeJReplica.contracts?.entityProvider ?? '',
        depositoryAddress: activeJReplica.depositoryAddress ?? activeJReplica.contracts?.depository ?? '',
      }
    : undefined;

  const consensusConfig = {
    mode: 'proposer-based' as const,
    threshold: 1n,
    validators: [mmSignerId],
    shares: { [mmSignerId]: 1n },
    ...(jurisdictionConfig ? { jurisdiction: jurisdictionConfig } : {}),
  };

  const entityId = hashBoard(encodeBoard(consensusConfig)).toLowerCase();
  const existingReplica = getEntityReplicaById(env, entityId);
  if (!existingReplica) {
    enqueueRuntimeInput(env, {
      runtimeTxs: [
        {
          type: 'importReplica',
          entityId,
          signerId: mmSignerId,
          data: {
            config: consensusConfig,
            isProposer: true,
            profileName: MARKET_MAKER_NAME,
            position: { x: 0, y: -40, z: 120 },
          },
        },
      ],
      entityInputs: [],
    });
    await settleRuntimeFor(env, 35);
  }

  return { entityId, signerId: mmSignerId };
};

const collectOfferIdsForAccount = (
  account:
    | Pick<AccountMachine, 'swapOffers' | 'mempool' | 'pendingFrame'>
    | null
    | undefined,
): Set<string> => {
  const ids = new Set<string>();
  if (account?.swapOffers instanceof Map) {
    for (const offerId of account.swapOffers.keys()) {
      ids.add(String(offerId));
    }
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

const countMarketMakerOffersForHub = (
  env: Env,
  mmEntityId: string,
  hubEntityId: string,
): number => {
  const account = getAccountMachine(env, mmEntityId, hubEntityId);
  if (!account) return 0;
  const prefix = `mm-${hubEntityId.slice(-6).toLowerCase()}-`;
  let count = 0;
  for (const offerId of collectOfferIdsForAccount(account)) {
    if (offerId.startsWith(prefix)) count += 1;
  }
  return count;
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

const snapPriceTicks = (ticks: bigint, stepTicks: number, mode: 'up' | 'down'): bigint => {
  const step = BigInt(Math.max(1, stepTicks));
  if (mode === 'up') {
    return ((ticks + step - 1n) / step) * step;
  }
  return (ticks / step) * step;
};

const buildMarketMakerOfferSpecs = (
  hubEntityIds: string[],
  tokenIds: number[],
): MarketMakerOfferSpec[] => {
  const specs: MarketMakerOfferSpec[] = [];
  const pairs = buildMarketMakerPairs(tokenIds);
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
    const pairContexts = pairs.map((pair, pairIndex) => {
      const pairPolicy = getSwapPairPolicyByBaseQuote(pair.baseTokenId, pair.quoteTokenId);
      const levelProfile = getMarketMakerLevelProfile(pair.baseTokenId, pair.quoteTokenId);
      const skewBps = hubSkewBps(hubEntityId, pairIndex);
      return {
        pair,
        levelProfile,
        midPriceTicks: (pairPolicy.mmMidPriceTicks * BigInt(10_000 + skewBps)) / 10_000n,
        stepTicksBig: BigInt(Math.max(1, pairPolicy.priceStepTicks)),
        stepTicks: Math.max(1, pairPolicy.priceStepTicks),
      };
    });
    const maxLevels = pairContexts.reduce((max, entry) => Math.max(max, entry.levelProfile.offsetsBps.length), 0);
    for (let level = 0; level < maxLevels; level++) {
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
        const askWantAmount = (baseSize * askPriceTicks) / ORDERBOOK_PRICE_SCALE;
        const bidGiveAmount = (baseSize * bidPriceTicks) / ORDERBOOK_PRICE_SCALE;
        const levelId = level + 1;

        if (askWantAmount > 0n) {
          specs.push({
            offerId: `mm-${hubSuffix}-${entry.pair.baseTokenId}-${entry.pair.quoteTokenId}-ask-${levelId}`,
            hubEntityId,
            giveTokenId: entry.pair.baseTokenId,
            giveAmount: baseSize,
            wantTokenId: entry.pair.quoteTokenId,
            wantAmount: askWantAmount,
            // Resting MM quotes must remain plain GTC orders. Non-zero minFillRatio is
            // reserved for IOC/FOK semantics and would make bootstrap quotes invalid.
            minFillRatio: 0,
          });
        }

        if (bidGiveAmount > 0n) {
          specs.push({
            offerId: `mm-${hubSuffix}-${entry.pair.baseTokenId}-${entry.pair.quoteTokenId}-bid-${levelId}`,
            hubEntityId,
            giveTokenId: entry.pair.quoteTokenId,
            giveAmount: bidGiveAmount,
            wantTokenId: entry.pair.baseTokenId,
            wantAmount: baseSize,
            // Keep resting bids consistent with the runtime MM path above.
            minFillRatio: 0,
          });
        }
      }
    }
  }
  return specs;
};

const ensureMarketMakerHubConnectivity = async (
  env: Env,
  mmEntityId: string,
  mmSignerId: string,
  hubEntityIds: string[],
  tokenIds: number[],
): Promise<void> => {
  const accountOpenInputs: EntityInput[] = [];
  const creditInputsByEntity = new Map<string, EntityInput>();

  for (const hubEntityId of hubEntityIds) {
    const hubSignerId = getHubSignerForEntity(env, hubEntityId);
    const mmAccount = getAccountMachine(env, mmEntityId, hubEntityId);
    const hubAccount = getAccountMachine(env, hubEntityId, mmEntityId);
    const hasMmToHub = hasAccount(env, mmEntityId, hubEntityId);
    const hasHubToMm = hasAccount(env, hubEntityId, mmEntityId);
    const hasEitherAccount = hasMmToHub || hasHubToMm;
    const hasPendingConsensus =
      Boolean(mmAccount?.pendingFrame) ||
      Boolean(hubAccount?.pendingFrame) ||
      Number(mmAccount?.mempool?.length || 0) > 0 ||
      Number(hubAccount?.mempool?.length || 0) > 0;

    // Single-opener rule: only MM initiates account opening.
    // Counterparty account materializes via inbound accountInput ACK path.
    if (!hasEitherAccount && !hasPendingConsensus) {
      accountOpenInputs.push({
        entityId: mmEntityId,
        signerId: mmSignerId,
        entityTxs: [
          {
            type: 'openAccount',
            data: {
              targetEntityId: hubEntityId,
              tokenId: tokenIds[0] ?? 1,
              // Prime first token credit in the same account frame.
              creditAmount: MARKET_MAKER_CREDIT_AMOUNT,
            },
          },
        ],
      });
    }
  }

  if (accountOpenInputs.length > 0) {
    enqueueRuntimeInput(env, { runtimeTxs: [], entityInputs: accountOpenInputs });
    await settleRuntimeFor(env, 35);
  }

  for (const hubEntityId of hubEntityIds) {
    const hubSignerId = getHubSignerForEntity(env, hubEntityId);
    const mmAccount = getAccountMachine(env, mmEntityId, hubEntityId);
    const hubAccount = getAccountMachine(env, hubEntityId, mmEntityId);
    const hasMmToHub = hasAccount(env, mmEntityId, hubEntityId);
    const hasHubToMm = hasAccount(env, hubEntityId, mmEntityId);
    const hasPendingConsensus =
      Boolean(mmAccount?.pendingFrame) ||
      Boolean(hubAccount?.pendingFrame) ||
      Number(mmAccount?.mempool?.length || 0) > 0 ||
      Number(hubAccount?.mempool?.length || 0) > 0;
    if (hasPendingConsensus) continue;
    if (!hasMmToHub || !hasHubToMm) continue;
    if (!mmAccount || !hubAccount) continue;

    for (const tokenId of tokenIds) {
      if (hasPairMutualCredit(env, mmEntityId, hubEntityId, tokenId, MARKET_MAKER_CREDIT_AMOUNT)) continue;
      const mmOutCapacity = getEntityOutCapacity(mmAccount, mmEntityId, tokenId);
      const hubOutCapacity = getEntityOutCapacity(hubAccount, hubEntityId, tokenId);

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

const maintainMarketMakerQuotes = async (
  env: Env,
  mmEntityId: string,
  mmSignerId: string,
  hubEntityIds: string[],
  tokenIds: number[],
  maxOffersPerAccount = MARKET_MAKER_OFFERS_PER_ACCOUNT_PER_TICK,
): Promise<void> => {
  if (hubEntityIds.length === 0 || tokenIds.length < 3) return;
  await ensureMarketMakerHubConnectivity(env, mmEntityId, mmSignerId, hubEntityIds, tokenIds);
  const desiredOffers = buildMarketMakerOfferSpecs(hubEntityIds, tokenIds);
  const grouped = new Map<string, MarketMakerOfferSpec[]>();
  for (const spec of desiredOffers) {
    const arr = grouped.get(spec.hubEntityId) ?? [];
    arr.push(spec);
    grouped.set(spec.hubEntityId, arr);
  }

  const entityTxs: EntityInput['entityTxs'] = [];
  for (const [hubEntityId, specs] of grouped.entries()) {
    const account = getAccountMachine(env, mmEntityId, hubEntityId);
    if (!account) continue;
    if (String(account.status || 'active') !== 'active') continue;
    if (Number(account.mempool?.length || 0) > 0 || account.pendingFrame) continue;

    const existingOfferIds = collectOfferIdsForAccount(account);
    const remainingOpenSlots = Math.max(0, LIMITS.MAX_ACCOUNT_SWAP_OFFERS - existingOfferIds.size);
    const allowedNewOffers = Math.min(
      Math.max(1, Math.floor(maxOffersPerAccount)),
      remainingOpenSlots,
    );
    if (allowedNewOffers <= 0) continue;
    const missing = specs
      .filter(spec => !existingOfferIds.has(spec.offerId))
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

const getMarketMakerHealth = (env: Env | null): {
  enabled: boolean;
  ok: boolean;
  entityId: string | null;
  expectedOffersPerHub: number;
  expectedOffersPerPair: number;
  hubs: Array<{
    hubEntityId: string;
    offers: number;
    ready: boolean;
    pairs: Array<{ pairId: string; offers: number; ready: boolean }>;
  }>;
} => {
  const entityId = marketMakerEntityId;
  const hubs = [...marketMakerTargetHubIds];
  const pairs = buildMarketMakerPairs(marketMakerTokenIds);
  const expectedOffersPerHub = pairs.reduce(
    (sum, pair) => sum + getExpectedMarketMakerOffersForPair(pair.baseTokenId, pair.quoteTokenId),
    0,
  );

  if (!entityId || hubs.length === 0 || expectedOffersPerHub <= 0) {
    return {
      enabled: false,
      ok: false,
      entityId: entityId || null,
      expectedOffersPerHub: Math.max(0, expectedOffersPerHub),
      expectedOffersPerPair: Math.max(...pairs.map((pair) => getExpectedMarketMakerOffersForPair(pair.baseTokenId, pair.quoteTokenId)), 0),
      hubs: [],
    };
  }

  if (!env) {
    return {
      enabled: true,
      ok: false,
      entityId,
      expectedOffersPerHub,
      expectedOffersPerPair: Math.max(...pairs.map((pair) => getExpectedMarketMakerOffersForPair(pair.baseTokenId, pair.quoteTokenId)), 0),
      hubs: hubs.map((hubEntityId) => ({
        hubEntityId,
        offers: 0,
        ready: false,
        pairs: pairs.map((pair) => ({
          pairId: pair.pairId,
          offers: 0,
          ready: false,
        })),
      })),
    };
  }

  const perHub = hubs.map((hubEntityId) => {
    const offers = countMarketMakerOffersForHub(env, entityId, hubEntityId);
    const pairHealth = pairs.map((pair) => {
      const pairOffers = countMarketMakerOffersForHubPair(env, entityId, hubEntityId, pair);
      const expectedPairOffers = getExpectedMarketMakerOffersForPair(pair.baseTokenId, pair.quoteTokenId);
      return {
        pairId: pair.pairId,
        offers: pairOffers,
        ready: pairOffers >= expectedPairOffers,
      };
    });
    return {
      hubEntityId,
      offers,
      ready: offers >= expectedOffersPerHub && pairHealth.every((pair) => pair.ready),
      pairs: pairHealth,
    };
  });

  return {
    enabled: true,
    ok: perHub.length > 0 && perHub.every((entry) => entry.ready),
    entityId,
    expectedOffersPerHub,
    expectedOffersPerPair: Math.max(...pairs.map((pair) => getExpectedMarketMakerOffersForPair(pair.baseTokenId, pair.quoteTokenId)), 0),
    hubs: perHub,
  };
};

const bootstrapMarketMakerLiquidity = async (
  env: Env,
  hubEntityIds: string[],
  tokenCatalog: JTokenInfo[],
): Promise<void> => {
  const marketMakerBootstrapStartedAt = Date.now();
  stopMarketMakerLoop();
  const mm = await ensureMarketMakerEntity(env);
  if (!mm) return;
  const tokenIds = normalizeTokenIdsForMm(tokenCatalog);
  if (tokenIds.length < 3) {
    console.warn('[XLN] MM bootstrap skipped: less than 3 tokens in catalog');
    return;
  }

  const targetHubs = hubEntityIds.slice(0, HUB_MESH_REQUIRED_HUBS);
  marketMakerEntityId = mm.entityId;
  marketMakerTargetHubIds = [...targetHubs];
  marketMakerTokenIds = [...tokenIds];
  const expectedOffersPerHub = buildMarketMakerPairs(tokenIds).reduce(
    (sum, pair) => sum + getExpectedMarketMakerOffersForPair(pair.baseTokenId, pair.quoteTokenId),
    0,
  );
  const bootstrapOfferLimit = Math.max(expectedOffersPerHub, MARKET_MAKER_OFFERS_PER_ACCOUNT_PER_TICK);

  const bootstrapDeadline = Date.now() + 45_000;
  let bootstrapTicks = 0;
  while (Date.now() < bootstrapDeadline) {
    bootstrapTicks += 1;
    const tickStartedAt = Date.now();
    await maintainMarketMakerQuotes(env, mm.entityId, mm.signerId, targetHubs, tokenIds, bootstrapOfferLimit);
    await settleRuntimeFor(env, 45);
    const health = getMarketMakerHealth(env);
    console.log(
      `[XLN][MM-TIMING] tick=${bootstrapTicks} elapsed=${Date.now() - tickStartedAt}ms ` +
      `offers=${health.hubs.map((hub) => `${hub.hubEntityId.slice(-4)}:${hub.offers}`).join(',')}`,
    );
    if (health.ok) break;
    await sleep(150);
  }

  const mmHealth = getMarketMakerHealth(env);
  if (!mmHealth.ok) {
    throw new Error(
      `HUB_BOOTSTRAP_FAILED: MM liquidity not ready (expected=${mmHealth.expectedOffersPerHub} ` +
      `perHub=${safeStringify(mmHealth.hubs)})`,
    );
  }

  marketMakerLoopTimer = setInterval(() => {
    if (marketMakerLoopInFlight) return;
    marketMakerLoopInFlight = true;
    void maintainMarketMakerQuotes(env, mm.entityId, mm.signerId, targetHubs, tokenIds)
      .catch(error => console.warn('[XLN] MM quote loop tick failed:', (error as Error).message))
      .finally(() => {
        marketMakerLoopInFlight = false;
      });
  }, MARKET_MAKER_QUOTE_LOOP_MS);

  console.log(
    `[XLN] MM bootstrap ready: ${targetHubs.length} hubs, target=${expectedOffersPerHub} resting offers/hub`,
  );
  console.log(
    `[XLN][MM-TIMING] total=${Date.now() - marketMakerBootstrapStartedAt}ms ticks=${bootstrapTicks} ` +
    `expectedOffersPerHub=${expectedOffersPerHub}`,
  );
};

const ensureHubPairMeshCredit = async (env: Env, leftEntityId: string, rightEntityId: string): Promise<void> => {
  const leftSignerId = getHubSignerForEntity(env, leftEntityId);
  const rightSignerId = getHubSignerForEntity(env, rightEntityId);
  if (hasPairMutualCredit(env, leftEntityId, rightEntityId, HUB_MESH_TOKEN_ID, HUB_MESH_CREDIT_AMOUNT)) {
    console.log(`[XLN] Hub pair already funded: ${leftEntityId.slice(0, 8)}.. ↔ ${rightEntityId.slice(0, 8)}..`);
    return;
  }

  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (hasPairMutualCredit(env, leftEntityId, rightEntityId, HUB_MESH_TOKEN_ID, HUB_MESH_CREDIT_AMOUNT)) {
      console.log(`[XLN] Hub pair credit ready: ${leftEntityId.slice(0, 8)}.. ↔ ${rightEntityId.slice(0, 8)}..`);
      return;
    }

    const entityInputs: EntityInput[] = [];
    const leftHasAccount = hasAccount(env, leftEntityId, rightEntityId);
    const rightHasAccount = hasAccount(env, rightEntityId, leftEntityId);
    const hasEitherAccount = leftHasAccount || rightHasAccount;

    // Single-opener rule: only left side initiates openAccount.
    // Right side must materialize via inbound accountInput/ACK flow.
    if (!hasEitherAccount) {
      entityInputs.push({
        entityId: leftEntityId,
        signerId: leftSignerId,
        entityTxs: [
          {
            type: 'openAccount',
            data: {
              targetEntityId: rightEntityId,
              tokenId: HUB_MESH_TOKEN_ID,
              // Prime left->right credit inside the initial account frame.
              creditAmount: HUB_MESH_CREDIT_AMOUNT,
            },
          },
        ],
      });
    }

    if (entityInputs.length > 0) {
      console.log(
        `[XLN] Opening hub account pair ${leftEntityId.slice(0, 8)}.. ↔ ${rightEntityId.slice(0, 8)}.. (attempt ${attempt}/${MAX_ATTEMPTS})`,
      );
      enqueueRuntimeInput(env, { runtimeTxs: [], entityInputs });
      await settleRuntimeFor(env, 35);
    }

    const hasReadyPair = await waitUntil(
      () => {
        const leftAccount = getAccountMachine(env, leftEntityId, rightEntityId);
        const rightAccount = getAccountMachine(env, rightEntityId, leftEntityId);
        return isAccountConsensusReady(leftAccount) && isAccountConsensusReady(rightAccount);
      },
      120,
      120,
    );
    if (!hasReadyPair) {
      console.warn(
        `[XLN] Hub mesh account open timed out before bilateral readiness: ${leftEntityId.slice(0, 8)}.. ↔ ${rightEntityId.slice(0, 8)}.. (attempt ${attempt}/${MAX_ATTEMPTS})`,
      );
      continue;
    }

    const leftAccount = getAccountMachine(env, leftEntityId, rightEntityId);
    const rightAccount = getAccountMachine(env, rightEntityId, leftEntityId);
    if (!leftAccount || !rightAccount) continue;

    const queuedByEntity = new Map<string, EntityInput>();
    const leftOutCapacity = getEntityOutCapacity(leftAccount, leftEntityId, HUB_MESH_TOKEN_ID);
    const rightOutCapacity = getEntityOutCapacity(rightAccount, rightEntityId, HUB_MESH_TOKEN_ID);

    if (leftOutCapacity < HUB_MESH_CREDIT_AMOUNT) {
      queuedByEntity.set(rightEntityId, {
        entityId: rightEntityId,
        signerId: rightSignerId,
        entityTxs: [
          {
            type: 'extendCredit',
            data: {
              counterpartyEntityId: leftEntityId,
              tokenId: HUB_MESH_TOKEN_ID,
              amount: HUB_MESH_CREDIT_AMOUNT,
            },
          },
        ],
      });
    }

    if (rightOutCapacity < HUB_MESH_CREDIT_AMOUNT) {
      queuedByEntity.set(leftEntityId, {
        entityId: leftEntityId,
        signerId: leftSignerId,
        entityTxs: [
          {
            type: 'extendCredit',
            data: {
              counterpartyEntityId: rightEntityId,
              tokenId: HUB_MESH_TOKEN_ID,
              amount: HUB_MESH_CREDIT_AMOUNT,
            },
          },
        ],
      });
    }

    if (queuedByEntity.size > 0) {
      console.log(
        `[XLN] Queueing mesh extendCredit for ${leftEntityId.slice(0, 8)}.. ↔ ${rightEntityId.slice(0, 8)}.. (attempt ${attempt}/${MAX_ATTEMPTS})`,
      );
      enqueueRuntimeInput(env, {
        runtimeTxs: [],
        entityInputs: Array.from(queuedByEntity.values()),
      });
      await settleRuntimeFor(env, 45);
    }
  }

  console.warn(
    `[XLN] Hub pair credit still below target: ${leftEntityId.slice(0, 8)}.. ↔ ${rightEntityId.slice(0, 8)}..`,
  );
};

const bootstrapHubMeshCredit = async (env: Env, requiredHubEntityIds: string[]): Promise<void> => {
  if (requiredHubEntityIds.length < 3) return;
  const normalized = requiredHubEntityIds.map(id => id.toLowerCase());
  const gossipReady = await waitUntil(
    () => {
      const profiles = env.gossip?.getProfiles?.() || [];
      const ids = new Set(profiles.map(p => p.entityId.toLowerCase()));
      return normalized.every(id => ids.has(id));
    },
    120,
    100,
  );

  if (!gossipReady) {
    console.warn('[XLN] Hub mesh bootstrap skipped: all hubs were not visible in gossip in time');
    return;
  }

  console.log('[XLN] Bootstrapping H1/H2/H3 mutual credit mesh ($1M each direction, tokenId=1)');
  for (let i = 0; i < requiredHubEntityIds.length; i++) {
    for (let j = i + 1; j < requiredHubEntityIds.length; j++) {
      const left = requiredHubEntityIds[i];
      const right = requiredHubEntityIds[j];
      if (!left || !right) continue;
      await ensureHubPairMeshCredit(env, left, right);
    }
  }
};

const assertHubBootstrapReadiness = async (
  env: Env,
  hubEntityIds: string[],
  tokenCatalog: JTokenInfo[],
): Promise<void> => {
  if (hubEntityIds.length < HUB_MESH_REQUIRED_HUBS) {
    const message =
      `HUB_BOOTSTRAP_FAILED: expected >=${HUB_MESH_REQUIRED_HUBS} hubs, got ${hubEntityIds.length}`;
    pushDebugEvent(relayStore, {
      event: 'error',
      status: 'failed',
      reason: 'HUB_BOOTSTRAP_HUB_COUNT',
      details: { expected: HUB_MESH_REQUIRED_HUBS, actual: hubEntityIds.length, hubEntityIds },
    });
    throw new Error(message);
  }

  const requiredTokens = tokenCatalog
    .map(token => ({
      tokenId: Number(token.tokenId),
      symbol: String(token.symbol || `token-${token.tokenId}`),
      decimals: Number.isFinite(token.decimals) ? Number(token.decimals) : 18,
    }))
    .filter(token => Number.isFinite(token.tokenId) && token.tokenId > 0)
    .slice(0, HUB_REQUIRED_TOKEN_COUNT);

  if (requiredTokens.length < HUB_REQUIRED_TOKEN_COUNT) {
    const message =
      `HUB_BOOTSTRAP_FAILED: expected >=${HUB_REQUIRED_TOKEN_COUNT} tokens, got ${requiredTokens.length}`;
    pushDebugEvent(relayStore, {
      event: 'error',
      status: 'failed',
      reason: 'HUB_BOOTSTRAP_TOKEN_COUNT',
      details: {
        expected: HUB_REQUIRED_TOKEN_COUNT,
        actual: requiredTokens.length,
        tokenCatalog: tokenCatalog.map(t => ({
          tokenId: Number(t.tokenId),
          symbol: t.symbol,
          decimals: t.decimals,
        })),
      },
    });
    throw new Error(message);
  }

  const expectedTargets = requiredTokens.map(token => ({
    ...token,
    target: HUB_RESERVE_TARGET_UNITS * 10n ** BigInt(token.decimals),
  }));

  const reserveReady = await waitUntil(
    () => {
      for (const hubEntityId of hubEntityIds) {
        const replica = getEntityReplicaById(env, hubEntityId);
        if (!replica?.state) return false;
        for (const token of expectedTargets) {
          const current = replica.state.reserves.get(token.tokenId) ?? 0n;
          if (current < token.target) return false;
        }
      }
      return true;
    },
    Math.ceil(HUB_RESERVE_ASSERT_TIMEOUT_MS / 200),
    200,
  );

  if (!reserveReady) {
    const reserveState = hubEntityIds.map(hubEntityId => {
      const replica = getEntityReplicaById(env, hubEntityId);
      const reserves = expectedTargets.map(token => ({
        tokenId: token.tokenId,
        symbol: token.symbol,
        expectedMin: token.target.toString(),
                actual: (replica?.state?.reserves?.get(token.tokenId) ?? 0n).toString(),
      }));
      return { hubEntityId, reserves };
    });
    pushDebugEvent(relayStore, {
      event: 'error',
      status: 'failed',
      reason: 'HUB_BOOTSTRAP_RESERVES',
      details: { reserveState },
    });
    throw new Error(`HUB_BOOTSTRAP_FAILED: reserves not funded for all hubs/tokens ${safeStringify(reserveState)}`);
  }

  const meshReady = await waitUntil(
    () => getHubMeshHealth(env).ok === true,
    Math.ceil(HUB_MESH_ASSERT_TIMEOUT_MS / 200),
    200,
  );
  if (!meshReady) {
    const mesh = getHubMeshHealth(env);
    pushDebugEvent(relayStore, {
      event: 'error',
      status: 'failed',
      reason: 'HUB_BOOTSTRAP_MESH',
      details: mesh,
    });
    throw new Error(`HUB_BOOTSTRAP_FAILED: hub mesh credit not ready ${safeStringify(mesh)}`);
  }
};

const deployDefaultTokensOnRpc = async (): Promise<void> => {
  if (!globalJAdapter || globalJAdapter.mode === 'browservm') return;
  const existing = await globalJAdapter.getTokenRegistry().catch(() => []);
  const existingSymbols = new Set(
    existing
      .map(token => String(token.symbol || '').trim().toUpperCase())
      .filter(symbol => symbol.length > 0),
  );

  const signer = globalJAdapter.signer;
  const depository = globalJAdapter.depository;
  const depositoryAddress = globalJAdapter.addresses?.depository;
  if (!depositoryAddress) {
    throw new Error('Depository address not available for token deployment');
  }

  console.log('[XLN] Deploying default ERC20 tokens to RPC...');
  const erc20Factory = new ERC20Mock__factory(signer as ContractRunner);

  for (const token of DEFAULT_TOKEN_CATALOG) {
    if (existingSymbols.has(String(token.symbol || '').trim().toUpperCase())) {
      continue;
    }
    const tokenContract = await erc20Factory.deploy(token.name, token.symbol, DEFAULT_TOKEN_SUPPLY);
    await tokenContract.waitForDeployment();
    const tokenAddress = await tokenContract.getAddress();
    console.log(`[XLN] ${token.symbol} deployed at ${tokenAddress}`);

    const approveTx = await tokenContract.approve(depositoryAddress, TOKEN_REGISTRATION_AMOUNT);
    await approveTx.wait();

    const registerTx = await depository.connect(signer).adminRegisterExternalToken({
      entity: ethers.ZeroHash,
      contractAddress: tokenAddress,
      externalTokenId: 0,
      tokenType: 0,
      internalTokenId: 0,
      amount: TOKEN_REGISTRATION_AMOUNT,
    });
    await registerTx.wait();
    console.log(`[XLN] Token registered: ${token.symbol} @ ${tokenAddress.slice(0, 10)}...`);
  }
};

const TOKEN_CATALOG_TIMEOUT_MS = Math.max(1000, Number(process.env.TOKEN_CATALOG_TIMEOUT_MS || '6000'));

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race<T>([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const ensureTokenCatalog = async (): Promise<JTokenInfo[]> => {
  if (!globalJAdapter) return [];
  const fallbackTokens = tokenCatalogCache ?? [];
  const safeGetCode = async (address: string): Promise<string> => {
    try {
      return await withTimeout(
        globalJAdapter.provider.getCode(address).catch(() => '0x'),
        TOKEN_CATALOG_TIMEOUT_MS,
        'provider.getCode',
      );
    } catch (error) {
      console.warn(`[ensureTokenCatalog] getCode failed: ${(error as Error).message}`);
      return '0x';
    }
  };
  const safeGetRegistry = async (): Promise<JTokenInfo[]> => {
    try {
      return await withTimeout(
        globalJAdapter.getTokenRegistry().catch(() => []),
        TOKEN_CATALOG_TIMEOUT_MS,
        'getTokenRegistry',
      );
    } catch (error) {
      console.warn(`[ensureTokenCatalog] getTokenRegistry failed: ${(error as Error).message}`);
      return fallbackTokens;
    }
  };
  if (tokenCatalogCache && tokenCatalogCache.length > 0) {
    if (globalJAdapter.mode !== 'browservm') {
      const firstToken = tokenCatalogCache[0];
      if (firstToken?.address) {
        const code = await safeGetCode(firstToken.address);
        if (code !== '0x' && code.length > 10) {
          return tokenCatalogCache;
        }
        console.warn('[ensureTokenCatalog] Cached token registry appears stale - refreshing');
        tokenCatalogCache = null;
      }
    } else {
      return tokenCatalogCache;
    }
  }
  if (tokenCatalogPromise) return tokenCatalogPromise;

  tokenCatalogPromise = (async () => {
    const current = await safeGetRegistry();
    const needsMoreDefaultTokens = globalJAdapter.mode !== 'browservm' && current.length < HUB_REQUIRED_TOKEN_COUNT;

    // Verify tokens have actual code on-chain (not stale addresses)
    if (current.length > 0 && globalJAdapter.mode !== 'browservm') {
      const firstToken = current[0];
      if (firstToken?.address) {
        const code = await safeGetCode(firstToken.address);
        if (code === '0x' || code.length < 10) {
          console.warn(
            `[ensureTokenCatalog] Token ${firstToken.symbol} at ${firstToken.address} has no code - deploying fresh tokens`,
          );
          try {
            await withTimeout(deployDefaultTokensOnRpc(), TOKEN_CATALOG_TIMEOUT_MS * 2, 'deployDefaultTokensOnRpc');
          } catch (error) {
            console.warn(`[ensureTokenCatalog] Deploy fallback failed: ${(error as Error).message}`);
            return current;
          }
          const refreshed = await safeGetRegistry();
          return refreshed;
        }
      }
      if (needsMoreDefaultTokens) {
        try {
          await withTimeout(deployDefaultTokensOnRpc(), TOKEN_CATALOG_TIMEOUT_MS * 2, 'deployMissingDefaultTokensOnRpc');
        } catch (error) {
          console.warn(`[ensureTokenCatalog] Missing-token deploy fallback failed: ${(error as Error).message}`);
          return current;
        }
        const refreshed = await safeGetRegistry();
        return refreshed;
      }
      return current;
    }

    if (current.length > 0 || globalJAdapter.mode === 'browservm') {
      return current;
    }

    try {
      await withTimeout(deployDefaultTokensOnRpc(), TOKEN_CATALOG_TIMEOUT_MS * 2, 'deployDefaultTokensOnRpc');
    } catch (error) {
      console.warn(`[ensureTokenCatalog] Deploy fallback failed: ${(error as Error).message}`);
      return current;
    }
    const refreshed = await safeGetRegistry();
    return refreshed;
  })();

  const tokens = await tokenCatalogPromise;
  tokenCatalogPromise = null;
  if (tokens.length > 0) tokenCatalogCache = tokens;
  return tokens;
};

const updateJurisdictionsJson = async (
  contracts: JAdapter['addresses'],
  rpcUrl?: string,
  chainIdOverride?: number,
): Promise<void> => {
  try {
    const fs = await import('fs/promises');
    const path = await import('path');
    const canonicalPath = resolveJurisdictionsJsonPath();
    const publicRpc = toPublicRpcUrl(String(process.env.PUBLIC_RPC || rpcUrl || '/rpc'));
    await fs.mkdir(path.dirname(canonicalPath), { recursive: true });

    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(await fs.readFile(canonicalPath, 'utf-8'));
    } catch {
      data = {};
    }
    data.version = data.version ?? '1.0.0';
    data.lastUpdated = new Date().toISOString();
    data.defaults = data.defaults ?? {
      timeout: 30000,
      retryAttempts: 3,
      gasLimit: 1_000_000,
      rebalancePolicyUsd: {
        r2cRequestSoftLimit: 500,
        hardLimit: 10_000,
        maxFee: 15,
      },
    };
    data.defaults.rebalancePolicyUsd = data.defaults.rebalancePolicyUsd ?? {
      r2cRequestSoftLimit: 500,
      hardLimit: 10_000,
      maxFee: 15,
    };
    if (data.testnet) delete data.testnet;
    data.jurisdictions = data.jurisdictions ?? {};
    for (const key of Object.keys(data.jurisdictions)) {
      if (key !== 'arrakis' && key.startsWith('arrakis_')) delete data.jurisdictions[key];
    }
    const existingArrakis = data.jurisdictions.arrakis ?? {};
    data.jurisdictions.arrakis = {
      ...existingArrakis,
      name: 'Arrakis (Shared Anvil)',
      chainId: chainIdOverride ?? 31337,
      rpc: publicRpc,
      rebalancePolicyUsd: existingArrakis.rebalancePolicyUsd ?? data.defaults.rebalancePolicyUsd,
      contracts: {
        account: contracts.account,
        depository: contracts.depository,
        entityProvider: contracts.entityProvider,
        deltaTransformer: contracts.deltaTransformer,
      },
    };

    const payload = JSON.stringify(data, null, 2);
    await fs.writeFile(canonicalPath, payload);
    console.log(`[XLN] Updated jurisdictions.json: ${canonicalPath}`);
  } catch (err) {
    console.warn('[XLN] Failed to update jurisdictions.json:', (err as Error).message);
  }
};

const readCanonicalJurisdictionsJson = async (): Promise<string> => {
  const fs = await import('fs/promises');
  return await fs.readFile(resolveJurisdictionsJsonPath(), 'utf8');
};

const readCanonicalJurisdictionsVersion = async (): Promise<string> => {
  const raw = await readCanonicalJurisdictionsJson();
  const parsed = JSON.parse(raw) as { version?: unknown };
  const version = String(parsed.version || '').trim();
  if (!version) {
    throw new Error('MISSING_JURISDICTIONS_VERSION');
  }
  return version;
};

const buildRuntimeJurisdictionsJson = async (env?: Env | null): Promise<string | null> => {
  if (!env?.jReplicas || env.jReplicas.size === 0) return null;
  const jurisdictionName = env.activeJurisdiction ?? env.jReplicas.keys().next().value;
  if (typeof jurisdictionName !== 'string' || !jurisdictionName) return null;
  const replica = env.jReplicas.get(jurisdictionName) as
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

  const version = await readCanonicalJurisdictionsVersion();
  const payload = {
    version,
    lastUpdated: new Date().toISOString(),
    jurisdictions: {
      arrakis: {
        name: String(replica.name || jurisdictionName || 'Testnet'),
        chainId: Number(replica.chainId || 31337),
        rpc: toPublicRpcUrl(String(process.env.PUBLIC_RPC || replica.rpcs?.[0] || '/rpc')),
        contracts: {
          account: String(addresses.account || replica.contracts?.account || ''),
          depository,
          entityProvider,
          deltaTransformer: String(addresses.deltaTransformer || replica.contracts?.deltaTransformer || ''),
        },
      },
    },
  };
  return JSON.stringify(payload);
};

// ============================================================================
// SERVER OPTIONS
// ============================================================================

export type XlnServerOptions = {
  port: number;
  host?: string;
  staticDir?: string;
  relaySeeds?: string[];
  serverId?: string;
};

const DEFAULT_OPTIONS: XlnServerOptions = {
  port: 8080,
  host: '0.0.0.0',
  staticDir: './frontend/build',
  relaySeeds: [],
  serverId: 'xln-server',
};
let activeServerOptions: XlnServerOptions = { ...DEFAULT_OPTIONS };
const DEFAULT_TOKEN_CATALOG = DEFAULT_TOKENS.map(token => ({ ...token }));
const getDefaultLocalRelayUrl = (port?: number): string => `ws://localhost:${port ?? DEFAULT_OPTIONS.port}/relay`;
const resolveConfiguredRelayUrl = (port?: number): string => {
  const fallback = getDefaultLocalRelayUrl(port);
  const candidates = [
    process.env.INTERNAL_RELAY_URL,
    process.env.RELAY_URL,
  ]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  return candidates[0] || fallback;
};
const resolveAdvertisedRelayUrl = (port?: number): string => {
  const fallback = getDefaultLocalRelayUrl(port);
  const candidates = [
    process.env.PUBLIC_RELAY_URL,
    process.env.RELAY_URL,
    process.env.INTERNAL_RELAY_URL,
  ]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  return candidates[0] || fallback;
};

// ============================================================================
// RELAY STATE (single store for all relay concerns)
// ============================================================================

let relayStore = createRelayStore(DEFAULT_OPTIONS.serverId ?? 'xln-server');
type ServerBootPhase = 'starting' | 'runtime' | 'bootstrap' | 'ready' | 'failed';
let serverBootPhase: ServerBootPhase = 'starting';
let serverBootError: string | null = null;
let serverBootStartedAt = 0;
let serverBootCompletedAt: number | null = null;

type RpcMarketSubscription = {
  hubIds: Set<string>;
  pairIds: Set<string>;
  depth: number;
  seq: number;
};

const rpcMarketSubscriptions = new Map<RelaySocket, RpcMarketSubscription>();
let rpcMarketPublisherTimer: ReturnType<typeof setInterval> | null = null;

const sendEntityInputDirectViaRelaySocket = (
  env: Env,
  targetRuntimeId: string,
  input: DeliverableEntityInput,
  ingressTimestamp?: number,
): boolean => {
  const fromRuntimeId = String(env.runtimeId || '');
  if (!fromRuntimeId) return false;
  const targetKey = normalizeRuntimeKey(targetRuntimeId);
  const targetPubKeyHex = resolveEncryptionPublicKeyHex(relayStore, targetKey);
  if (!targetPubKeyHex) {
    logOneShot(
      `direct-dispatch-missing-key:${targetRuntimeId}`,
      `[RELAY] Direct dispatch missing encryption key for runtime ${targetRuntimeId.slice(0, 10)}`,
    );
    return false;
  }

  try {
    const payload = encryptJSON(input, hexToPubKey(targetPubKeyHex));
    const target = relayStore.clients.get(targetKey);
    const msg = {
      type: 'entity_input',
      id: `srv_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      from: fromRuntimeId,
      to: target?.runtimeId || targetRuntimeId,
      timestamp:
        typeof ingressTimestamp === 'number' && Number.isFinite(ingressTimestamp)
          ? ingressTimestamp
          : nextWsTimestamp(relayStore),
      payload,
      encrypted: true,
    };
    if (target) {
      target.ws.send(safeStringify(msg));
      pushDebugEvent(relayStore, {
        event: 'delivery',
        from: fromRuntimeId,
        to: targetRuntimeId,
        msgType: 'entity_input',
        encrypted: true,
        status: 'delivered-direct-local',
        details: {
          entityId: input.entityId,
          txs: input.entityTxs?.length ?? 0,
        },
      });
      return true;
    }

    // No local WS client for target runtime in this process.
    // IMPORTANT: return false so runtime falls back to normal P2P dispatch
    // via relay socket. Do not queue in local pendingMessages here because
    // that queue is process-local and can blackhole outputs when relay is
    // external to this API/runtime process.
    pushDebugEvent(relayStore, {
      event: 'delivery',
      from: fromRuntimeId,
      to: targetRuntimeId,
      msgType: 'entity_input',
      encrypted: true,
      status: 'direct-miss-fallback',
      details: {
        entityId: input.entityId,
        txs: input.entityTxs?.length ?? 0,
      },
    });
    return false;
  } catch (error) {
    logOneShot(
      `direct-dispatch-send-failed:${targetRuntimeId}`,
      `[RELAY] Direct dispatch send failed for runtime ${targetRuntimeId.slice(0, 10)}: ${(error as Error).message}`,
    );
    return false;
  }
};

const bootstrapServerHubsAndReserves = async (
  env: Env,
  options: XlnServerOptions,
  relayUrl: string,
  anvilRpc: string,
  bootstrapOptions: { includeMarketMaker?: boolean } = {},
): Promise<string[]> => {
  void env;
  void options;
  void relayUrl;
  void anvilRpc;
  void bootstrapOptions;
  throw new Error('SHARED_HUB_BOOTSTRAP_REMOVED: use runtime/orchestrator/orchestrator.ts');
};

const installProcessSafetyGuards = (): void => {
  if (processGuardsInstalled) return;
  processGuardsInstalled = true;

  process.on('unhandledRejection', reason => {
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    console.error(`[PROCESS] Unhandled rejection: ${message}`);
    pushDebugEvent(relayStore, {
      event: 'error',
      reason: 'UNHANDLED_REJECTION',
      details: { message, stack },
    });
  });

  process.on('uncaughtException', error => {
    const message = error?.message || 'Unknown uncaught exception';
    console.error(`[PROCESS] Uncaught exception: ${message}`);
    pushDebugEvent(relayStore, {
      event: 'error',
      reason: 'UNCAUGHT_EXCEPTION',
      details: { message, stack: error?.stack },
    });
  });
};

// ============================================================================
// FAUCET MUTEX (prevent nonce collisions from parallel requests)
// ============================================================================
const faucetLock = {
  locked: false,
  queue: [] as Array<() => void>,

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise(resolve => {
      this.queue.push(resolve);
    });
  },

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  },
};

// ============================================================================
// STATIC FILE SERVING
// ============================================================================

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const getMimeType = (path: string): string | undefined => {
  const idx = path.lastIndexOf('.');
  if (idx === -1) return undefined;
  return MIME_TYPES[path.slice(idx)];
};

const serveStatic = async (pathname: string, staticDir: string): Promise<Response | null> => {
  // Try exact path
  const exactPath = `${staticDir}${pathname}`;
  let file = Bun.file(exactPath);
  if (await file.exists()) {
    const ct = getMimeType(pathname);
    return new Response(file, ct ? { headers: { 'content-type': ct } } : undefined);
  }

  // Try with .html extension
  if (!pathname.includes('.')) {
    const htmlPath = `${staticDir}${pathname}.html`;
    file = Bun.file(htmlPath);
    if (await file.exists()) {
      return new Response(file, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
  }

  return null;
};

// Serve runtime bundle from canonical static/public locations.
// In dev, Vite serves frontend/static. In server mode, frontend/public/build
// may be used depending on deploy workflow.
const serveRuntimeBundle = async (): Promise<Response | null> => {
  const path = await import('path');
  const candidates = [
    path.join(process.cwd(), 'frontend', 'static', 'runtime.js'),
    path.join(process.cwd(), 'frontend', 'public', 'runtime.js'),
    path.join(process.cwd(), 'frontend', 'build', 'runtime.js'),
  ];
  for (const runtimePath of candidates) {
    const file = Bun.file(runtimePath);
    if (!(await file.exists())) continue;
    return new Response(file, {
      headers: {
        'content-type': 'text/javascript; charset=utf-8',
        // Prevent stale module cache across reloads while debugging/prod hotfixes.
        'cache-control': 'no-store, must-revalidate',
      },
    });
  }
  return null;
};

// ============================================================================
// RELAY PROTOCOL (now delegated to relay-router + relay-local-delivery)
// ============================================================================
// ============================================================================
// RPC PROTOCOL (for remote UI)
// ============================================================================

const buildMarketSnapshot = (
  env: Env,
  hubEntityId: string,
  pairId: string,
  depth: number,
): MarketSnapshotPayload => {
  const hubReplica = getEntityReplicaById(env, hubEntityId);
  return buildMarketSnapshotForReplica(hubReplica, hubEntityId, pairId, depth);
};

const sendRpcMarketSnapshot = (
  ws: RelaySocket,
  subscription: RpcMarketSubscription,
  env: Env,
): boolean => {
  let sentAny = false;
  const hubs = Array.from(subscription.hubIds);
  const pairs = Array.from(subscription.pairIds);
  for (const hubEntityId of hubs) {
    for (const pairId of pairs) {
      const payload = buildMarketSnapshot(env, hubEntityId, pairId, subscription.depth);
      subscription.seq += 1;
      ws.send(
        safeStringify({
          type: 'market_snapshot',
          id: `market_${Date.now()}_${subscription.seq}`,
          timestamp: Date.now(),
          payload,
        }),
      );
      sentAny = true;
    }
  }
  return sentAny;
};

const publishRpcMarketSnapshots = (env: Env): void => {
  if (rpcMarketSubscriptions.size === 0) return;
  for (const [ws, subscription] of rpcMarketSubscriptions.entries()) {
    try {
      sendRpcMarketSnapshot(ws, subscription, env);
    } catch {
      rpcMarketSubscriptions.delete(ws);
    }
  }
};

const ensureRpcMarketPublisher = (env: Env): void => {
  if (rpcMarketPublisherTimer) return;
  rpcMarketPublisherTimer = setInterval(() => {
    publishRpcMarketSnapshots(env);
  }, RPC_MARKET_PUBLISH_MS);
};

const stopRpcMarketPublisherIfIdle = (): void => {
  if (rpcMarketSubscriptions.size > 0) return;
  if (!rpcMarketPublisherTimer) return;
  clearInterval(rpcMarketPublisherTimer);
  rpcMarketPublisherTimer = null;
};

const cleanupRpcMarketSubscription = (ws: RelaySocket): void => {
  rpcMarketSubscriptions.delete(ws);
  stopRpcMarketPublisherIfIdle();
};

const isMarketMessageType = (type: unknown): type is 'market_subscribe' | 'market_unsubscribe' | 'market_snapshot_request' =>
  type === 'market_subscribe' || type === 'market_unsubscribe' || type === 'market_snapshot_request';

const handleMarketMessage = (ws: RelaySocket, msg: Record<string, unknown>, env: Env | null): void => {
  const { type, id } = msg;
  if (!isMarketMessageType(type)) return;

  if (type === 'market_subscribe') {
    if (!env) {
      ws.send(safeStringify({ type: 'error', inReplyTo: id, error: 'Runtime not ready' }));
      return;
    }
    const hubValues = Array.isArray(msg?.hubEntityIds)
      ? msg.hubEntityIds
      : msg?.hubEntityId
        ? [msg.hubEntityId]
        : [];
    const pairValues = Array.isArray(msg?.pairs)
      ? msg.pairs
      : msg?.pairId
        ? [msg.pairId]
        : [];
    const hubIds = Array.from(new Set(hubValues.map(normalizeMarketEntityId).filter(Boolean))) as string[];
    const pairIds = Array.from(new Set(pairValues.map(normalizeMarketPairId).filter(Boolean))) as string[];
    if (hubIds.length === 0 || pairIds.length === 0) {
      ws.send(safeStringify({ type: 'error', inReplyTo: id, error: 'market_subscribe requires valid hubEntityId(s) and pair(s)' }));
      return;
    }

    const replace = msg?.replace === true;
    const depthRaw = Number(msg?.depth);
    const depth = Number.isFinite(depthRaw)
      ? Math.max(1, Math.min(Math.floor(depthRaw), RPC_MARKET_MAX_DEPTH))
      : RPC_MARKET_DEFAULT_DEPTH;
    const subscription = rpcMarketSubscriptions.get(ws) || {
      hubIds: new Set<string>(),
      pairIds: new Set<string>(),
      depth,
      seq: 0,
    };
    if (replace) {
      subscription.hubIds.clear();
      subscription.pairIds.clear();
    }
    for (const hubEntityId of hubIds) subscription.hubIds.add(hubEntityId);
    for (const pairId of pairIds) subscription.pairIds.add(pairId);
    subscription.depth = depth;
    rpcMarketSubscriptions.set(ws, subscription);
    ensureRpcMarketPublisher(env);

    ws.send(
      safeStringify({
        type: 'ack',
        inReplyTo: id,
        status: 'market_subscribed',
        data: {
          hubEntityIds: Array.from(subscription.hubIds),
          pairs: Array.from(subscription.pairIds),
          depth: subscription.depth,
          intervalMs: RPC_MARKET_PUBLISH_MS,
        },
      }),
    );

    try {
      sendRpcMarketSnapshot(ws, subscription, env);
    } catch {
      cleanupRpcMarketSubscription(ws);
    }
    return;
  }

  if (type === 'market_unsubscribe') {
    const existing = rpcMarketSubscriptions.get(ws);
    if (!existing) {
      ws.send(safeStringify({ type: 'ack', inReplyTo: id, status: 'market_unsubscribed' }));
      return;
    }

    const hubValues = Array.isArray(msg?.hubEntityIds)
      ? msg.hubEntityIds
      : msg?.hubEntityId
        ? [msg.hubEntityId]
        : [];
    const pairValues = Array.isArray(msg?.pairs)
      ? msg.pairs
      : msg?.pairId
        ? [msg.pairId]
        : [];
    const hubIds = Array.from(new Set(hubValues.map(normalizeMarketEntityId).filter(Boolean))) as string[];
    const pairIds = Array.from(new Set(pairValues.map(normalizeMarketPairId).filter(Boolean))) as string[];

    if (hubIds.length === 0 && pairIds.length === 0) {
      cleanupRpcMarketSubscription(ws);
      ws.send(safeStringify({ type: 'ack', inReplyTo: id, status: 'market_unsubscribed' }));
      return;
    }

    for (const hubEntityId of hubIds) existing.hubIds.delete(hubEntityId);
    for (const pairId of pairIds) existing.pairIds.delete(pairId);
    if (existing.hubIds.size === 0 || existing.pairIds.size === 0) {
      cleanupRpcMarketSubscription(ws);
    }
    ws.send(safeStringify({ type: 'ack', inReplyTo: id, status: 'market_unsubscribed' }));
    return;
  }

  if (!env) {
    ws.send(safeStringify({ type: 'error', inReplyTo: id, error: 'Runtime not ready' }));
    return;
  }
  const existing = rpcMarketSubscriptions.get(ws);
  if (!existing) {
    ws.send(safeStringify({ type: 'error', inReplyTo: id, error: 'No active market subscription' }));
    return;
  }
  try {
    sendRpcMarketSnapshot(ws, existing, env);
    ws.send(safeStringify({ type: 'ack', inReplyTo: id, status: 'market_snapshot_sent' }));
  } catch {
    cleanupRpcMarketSubscription(ws);
    ws.send(safeStringify({ type: 'error', inReplyTo: id, error: 'Failed to send market snapshot' }));
  }
};

const parseRpcBigInt = (value: unknown, field: string): bigint => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new Error(`${field} must be an integer string`);
};

const normalizeRpcStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => (typeof item === 'string' ? item.trim() : ''))
    .filter(item => item.length > 0);
};

const filterReceiptLogs = (
  logs: Array<{ message?: unknown; entityId?: unknown; data?: Record<string, unknown> }>,
  entityId?: string,
  eventNames?: string[],
) => {
  const targetEntityId = typeof entityId === 'string' ? entityId.trim().toLowerCase() : '';
  const allowedEvents = new Set((eventNames || []).map(name => name.trim()).filter(Boolean));
  return logs.filter(log => {
    const eventName = typeof log?.message === 'string' ? log.message : '';
    if (allowedEvents.size > 0 && !allowedEvents.has(eventName)) return false;
    if (!targetEntityId) return true;
    const entityHint =
      typeof log?.entityId === 'string'
        ? log.entityId
        : typeof log?.data?.entityId === 'string'
          ? log.data.entityId
          : '';
    return entityHint.trim().toLowerCase() === targetEntityId;
  });
};

const resolveRpcPaymentRoute = async (
  env: Env,
  sourceEntityId: string,
  targetEntityId: string,
  tokenId: number,
  amount: bigint,
  routeOverride?: unknown,
): Promise<string[]> => {
  if (Array.isArray(routeOverride) && routeOverride.length >= 2) {
    const route = routeOverride
      .map(step => (typeof step === 'string' ? step.trim().toLowerCase() : ''))
      .filter(Boolean);
    if (route.length >= 2) return route;
  }

  try {
    await env.runtimeState?.p2p?.syncProfiles?.();
  } catch {
    // best effort prefetch only
  }

  try {
    await ensureGossipProfiles(env, [sourceEntityId, targetEntityId]);
  } catch {
    // best effort prefetch only
  }

  const routes = await env.gossip.getNetworkGraph().findPaths(sourceEntityId, targetEntityId, amount, tokenId);
  if (routes.length === 0) {
    try {
      await ensureGossipProfiles(env, [sourceEntityId, targetEntityId]);
    } catch {
      // best effort retry only
    }
  }
  const retryRoutes = routes.length > 0
    ? routes
    : await env.gossip.getNetworkGraph().findPaths(sourceEntityId, targetEntityId, amount, tokenId);
  if (retryRoutes.length === 0) {
    const profiles = env.gossip.getProfiles();
    const targetProfile = profiles.find((profile) => profile.entityId.toLowerCase() === targetEntityId.toLowerCase()) || null;
    const hubCount = profiles.filter((profile) =>
      profile.metadata.isHub === true
    ).length;
    throw new Error(
      `No route found from ${sourceEntityId} to ${targetEntityId} ` +
      `out of ${profiles.length} gossip profiles (hubs=${hubCount}, ` +
      `target lastUpdated=${targetProfile ? targetProfile.lastUpdated : 'missing'}, ` +
      `publicAccounts=${targetProfile ? targetProfile.publicAccounts.length : 0})`,
    );
  }
  return retryRoutes[0]!.path;
};

type ControlEntitySummary = {
  entityId: string;
  signerId: string;
  name: string;
  isRoutingEnabled: boolean;
  runtimeId: string | null;
  accountCount: number;
  publicAccountCount: number;
  accountEntityIds: string[];
};

const requireDaemonControlAuth = (req: Request): Response | null => {
  const configuredToken = process.env.DAEMON_CONTROL_TOKEN;
  if (!configuredToken) return null;
  const supplied = req.headers.get('x-daemon-control-token') || '';
  if (supplied === configuredToken) return null;
  return new Response(
    serializeTaggedJson({ ok: false, error: 'Unauthorized' }),
    {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    },
  );
};

const parseTaggedControlBody = async <T>(req: Request): Promise<T> => {
  const raw = await req.text();
  if (!raw.trim()) return {} as T;
  return deserializeTaggedJson<T>(raw);
};

const getProfileNameForEntity = (env: Env, entityId: string): string => {
  const target = entityId.toLowerCase();
  const localReplica = Array.from(env.eReplicas?.values?.() || []).find(
    replica => String(replica?.entityId || '').toLowerCase() === target,
  );
  const localName = localReplica?.state?.profile?.name;
  const gossipProfiles = env.gossip?.getProfiles?.() || [];
  const gossipProfile = gossipProfiles.find(profile => String(profile?.entityId || '').toLowerCase() === target);
  const relayProfile = relayStore.gossipProfiles.get(target)?.profile;
  const rawName = localName ?? gossipProfile?.name ?? relayProfile?.name;
  return typeof rawName === 'string' && rawName.trim().length > 0 ? rawName.trim() : entityId;
};

const listLocalControlEntities = (env: Env): ControlEntitySummary[] => {
  const seen = new Set<string>();
  const entities: ControlEntitySummary[] = [];
  for (const replica of env.eReplicas?.values?.() || []) {
    const entityId = String(replica?.entityId || '').toLowerCase();
    if (!entityId || seen.has(entityId)) continue;
    let signerId = '';
    try {
      signerId = resolveEntityProposerId(env, entityId, 'daemon-control.list');
    } catch {
      continue;
    }
    seen.add(entityId);
    entities.push({
      entityId,
      signerId,
      name: getProfileNameForEntity(env, entityId),
      isRoutingEnabled: !!replica?.state?.hubRebalanceConfig,
      runtimeId: typeof env.runtimeId === 'string' && env.runtimeId.trim().length > 0 ? env.runtimeId : null,
      accountCount: replica?.state?.accounts instanceof Map ? replica.state.accounts.size : 0,
      publicAccountCount: Array.isArray(replica?.state?.profile?.publicAccounts)
        ? replica.state.profile.publicAccounts.length
        : 0,
      accountEntityIds: replica?.state?.accounts instanceof Map
        ? Array.from(replica.state.accounts.keys()).map(value => String(value).toLowerCase()).sort()
        : [],
    });
  }
  entities.sort((left, right) => compareText(left.name, right.name));
  return entities;
};

const handleRpcMessage = async (ws: RelaySocket, msg: Record<string, unknown>, env: Env | null) => {
  const { type, id } = msg;

  if (isMarketMessageType(type)) {
    ws.send(safeStringify({ type: 'error', inReplyTo: id, error: 'market_* messages are supported on /relay websocket' }));
    return;
  }

  if (type === 'subscribe') {
    const client = Array.from(relayStore.clients.values()).find(c => c.ws === ws);
    if (client && msg.topics) {
      for (const topic of msg.topics) {
        client.topics.add(topic);
      }
    }
    ws.send(safeStringify({ type: 'ack', inReplyTo: id, status: 'subscribed' }));
    return;
  }

  if (type === 'get_env' && env) {
    // Serialize env for remote UI
    ws.send(
      safeStringify({
        type: 'env_snapshot',
        inReplyTo: id,
        data: {
          height: env.height,
          timestamp: env.timestamp,
          runtimeId: env.runtimeId,
          entityCount: env.eReplicas?.size || 0,
          // Add more fields as needed
        },
      }),
    );
    return;
  }

  if (type === 'get_frame_receipts') {
    if (!env) {
      ws.send(safeStringify({ type: 'error', inReplyTo: id, error: 'Runtime not ready' }));
      return;
    }
    try {
      const latestPersistedHeight = await getPersistedLatestHeight(env);
      const fromHeightRaw = Number(msg?.fromHeight ?? msg?.sinceHeight ?? 1);
      const toHeightRaw = Number(msg?.toHeight ?? latestPersistedHeight);
      const limitRaw = Number(msg?.limit ?? 200);
      const fromHeight = Number.isFinite(fromHeightRaw) ? Math.max(1, Math.floor(fromHeightRaw)) : 1;
      const requestedToHeight = Number.isFinite(toHeightRaw)
        ? Math.max(fromHeight, Math.floor(toHeightRaw))
        : latestPersistedHeight;
      const toHeight =
        latestPersistedHeight <= 0
          ? 0
          : Math.min(latestPersistedHeight, requestedToHeight);
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, Math.floor(limitRaw))) : 200;
      const entityId =
        typeof msg?.entityId === 'string' && msg.entityId.trim().length > 0 ? msg.entityId.trim().toLowerCase() : undefined;
      const eventNames = normalizeRpcStringArray(msg?.eventNames ?? msg?.events);
      const includeInputs = msg?.includeInputs === true;

      const receipts =
        toHeight > 0 && toHeight >= fromHeight
          ? await readPersistedFrameJournals(env, { fromHeight, toHeight, limit })
          : [];
      const filtered = receipts
        .map(receipt => {
          const matchedLogs = filterReceiptLogs(receipt.logs, entityId, eventNames);
          if ((entityId || eventNames.length > 0) && matchedLogs.length === 0) return null;
          return {
            height: receipt.height,
            timestamp: receipt.timestamp,
            logs: matchedLogs.length > 0 || entityId || eventNames.length > 0 ? matchedLogs : receipt.logs,
            ...(includeInputs ? { runtimeInput: receipt.runtimeInput } : {}),
          };
        })
        .filter((receipt): receipt is NonNullable<typeof receipt> => receipt !== null);

      ws.send(
        safeStringify({
          type: 'frame_receipts',
          inReplyTo: id,
          data: {
            fromHeight,
            toHeight,
            returned: filtered.length,
            receipts: filtered,
          },
        }),
      );
    } catch (error) {
      ws.send(
        safeStringify({
          type: 'error',
          inReplyTo: id,
          error: (error as Error)?.message || 'Failed to load frame receipts',
        }),
      );
    }
    return;
  }

  if (type === 'find_routes') {
    if (!env) {
      ws.send(safeStringify({ type: 'error', inReplyTo: id, error: 'Runtime not ready' }));
      return;
    }
    try {
      const sourceEntityId = String(msg?.sourceEntityId || '').trim().toLowerCase();
      const targetEntityId = String(msg?.targetEntityId || '').trim().toLowerCase();
      const tokenId = Number(msg?.tokenId ?? 1);
      const amount = parseRpcBigInt(msg?.amount, 'amount');
      if (!isEntityId32(sourceEntityId) || !isEntityId32(targetEntityId)) {
        throw new Error('sourceEntityId and targetEntityId must be 32-byte hex entity ids');
      }
      if (!Number.isFinite(tokenId) || tokenId <= 0) {
        throw new Error('tokenId must be a positive integer');
      }

      const route = await resolveRpcPaymentRoute(env, sourceEntityId, targetEntityId, tokenId, amount);
      const routes = await env.gossip.getNetworkGraph().findPaths(sourceEntityId, targetEntityId, amount, tokenId);
      const selected =
        routes.find(candidate => candidate.path.join('>') === route.join('>'))
        ?? routes[0];
      if (!selected) {
        throw new Error(`No route found from ${sourceEntityId} to ${targetEntityId}`);
      }
      ws.send(
        safeStringify({
          type: 'routes',
          inReplyTo: id,
          data: {
            routes: routes.map(candidate => ({
              path: candidate.path,
              hops: candidate.hops.map(hop => ({
                from: hop.from,
                to: hop.to,
                fee: hop.fee.toString(),
                feePPM: hop.feePPM,
              })),
              totalFee: candidate.totalFee.toString(),
              senderAmount: candidate.totalAmount.toString(),
              recipientAmount: amount.toString(),
              probability: candidate.probability,
            })),
            selectedRoute: selected.path,
          },
        }),
      );
    } catch (error) {
      ws.send(safeStringify({ type: 'error', inReplyTo: id, error: (error as Error)?.message || 'Route lookup failed' }));
    }
    return;
  }

  if (type === 'queue_payment') {
    if (!env) {
      ws.send(safeStringify({ type: 'error', inReplyTo: id, error: 'Runtime not ready' }));
      return;
    }
    try {
      const sourceEntityId = String(msg?.sourceEntityId || '').trim().toLowerCase();
      const targetEntityId = String(msg?.targetEntityId || '').trim().toLowerCase();
      const tokenId = Number(msg?.tokenId ?? 1);
      const amount = parseRpcBigInt(msg?.amount, 'amount');
      const mode = msg?.mode === 'direct' ? 'direct' : 'htlc';
      const description = typeof msg?.description === 'string' ? msg.description.trim() : '';
      if (!isEntityId32(sourceEntityId) || !isEntityId32(targetEntityId)) {
        throw new Error('sourceEntityId and targetEntityId must be 32-byte hex entity ids');
      }
      if (!Number.isFinite(tokenId) || tokenId <= 0) {
        throw new Error('tokenId must be a positive integer');
      }
      if (amount <= 0n) {
        throw new Error('amount must be positive');
      }
      if (!getEntityReplicaById(env, sourceEntityId)) {
        throw new Error(`Source entity ${sourceEntityId} not found in runtime`);
      }

      const signerId =
        typeof msg?.signerId === 'string' && msg.signerId.trim().length > 0
          ? msg.signerId.trim().toLowerCase()
          : resolveEntityProposerId(env, sourceEntityId, 'rpc.queue_payment');
      const route = await resolveRpcPaymentRoute(env, sourceEntityId, targetEntityId, tokenId, amount, msg?.route);

      let secret: string | undefined;
      let hashlock: string | undefined;
      const txData: Record<string, unknown> = {
        targetEntityId,
        tokenId,
        amount,
        route,
        ...(description ? { description } : {}),
      };

      let txType: 'directPayment' | 'htlcPayment' = 'directPayment';
      if (mode === 'htlc') {
        txType = 'htlcPayment';
        secret =
          typeof msg?.secret === 'string' && msg.secret.trim().length > 0
            ? msg.secret.trim()
            : ethers.hexlify(ethers.randomBytes(32));
        hashlock =
          typeof msg?.hashlock === 'string' && msg.hashlock.trim().length > 0
            ? msg.hashlock.trim()
            : hashHtlcSecret(secret);
        txData.secret = secret;
        txData.hashlock = hashlock;
      }

      enqueueRuntimeInput(env, {
        runtimeTxs: [],
        entityInputs: [
          {
            entityId: sourceEntityId,
            signerId,
            entityTxs: [{ type: txType, data: txData }],
          },
        ],
      });

      ws.send(
        safeStringify({
          type: 'payment_queued',
          inReplyTo: id,
          data: {
            sourceEntityId,
            signerId,
            targetEntityId,
            tokenId,
            amount: amount.toString(),
            route,
            mode,
            ...(description ? { description } : {}),
            ...(secret ? { secret } : {}),
            ...(hashlock ? { hashlock } : {}),
          },
        }),
      );
    } catch (error) {
      ws.send(safeStringify({ type: 'error', inReplyTo: id, error: (error as Error)?.message || 'Failed to queue payment' }));
    }
    return;
  }

  ws.send(safeStringify({ type: 'error', error: `Unknown RPC type: ${type}` }));
};

// ============================================================================
// REST API
// ============================================================================

const handleApi = async (req: Request, pathname: string, env: Env | null): Promise<Response> => {
  const headers = JSON_HEADERS;

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers });
  }

  if (pathname === '/api/control/entities' && req.method === 'GET') {
    const authError = requireDaemonControlAuth(req);
    if (authError) return authError;
    if (!env) {
      return new Response(serializeTaggedJson({ ok: false, error: 'Runtime not ready' }), { status: 503, headers });
    }
    return new Response(
      serializeTaggedJson({
        ok: true,
        runtimeId: typeof env.runtimeId === 'string' ? env.runtimeId : null,
        entities: listLocalControlEntities(env),
      }),
      { headers },
    );
  }

  if (pathname === '/api/control/signers/register' && req.method === 'POST') {
    const authError = requireDaemonControlAuth(req);
    if (authError) return authError;
    try {
      const body = await parseTaggedControlBody<{ signerId?: unknown; privateKeyHex?: unknown }>(req);
      const signerId = typeof body?.signerId === 'string' ? body.signerId.trim().toLowerCase() : '';
      const privateKeyHex = typeof body?.privateKeyHex === 'string' ? body.privateKeyHex.trim().toLowerCase() : '';
      if (!ethers.isAddress(signerId)) {
        return new Response(
          serializeTaggedJson({ ok: false, error: 'signerId must be an EOA address' }),
          { status: 400, headers },
        );
      }
      if (!ethers.isHexString(privateKeyHex, 32)) {
        return new Response(
          serializeTaggedJson({ ok: false, error: 'privateKeyHex must be a 32-byte hex string' }),
          { status: 400, headers },
        );
      }
      registerSignerKey(signerId, ethers.getBytes(privateKeyHex));
      return new Response(
        serializeTaggedJson({
          ok: true,
          signerId,
        }),
        { headers },
      );
    } catch (error) {
      return new Response(
        serializeTaggedJson({ ok: false, error: (error as Error).message || 'Failed to register signer' }),
        { status: 500, headers },
      );
    }
  }

  if (pathname === '/api/control/runtime-input' && req.method === 'POST') {
    const authError = requireDaemonControlAuth(req);
    if (authError) return authError;
    if (!env) {
      return new Response(serializeTaggedJson({ ok: false, error: 'Runtime not ready' }), { status: 503, headers });
    }
    try {
      const body = await parseTaggedControlBody<Partial<RuntimeInput>>(req);
      const runtimeTxs = Array.isArray(body?.runtimeTxs) ? body.runtimeTxs : [];
      const entityInputs = Array.isArray(body?.entityInputs) ? body.entityInputs : [];
      const jInputs = Array.isArray(body?.jInputs) ? body.jInputs : [];
      if (runtimeTxs.length === 0 && entityInputs.length === 0 && jInputs.length === 0) {
        return new Response(
          serializeTaggedJson({ ok: false, error: 'runtimeTxs, entityInputs, or jInputs are required' }),
          { status: 400, headers },
        );
      }
      enqueueRuntimeInput(env, {
        runtimeTxs,
        entityInputs,
        ...(jInputs.length > 0 ? { jInputs } : {}),
      });
      return new Response(
        serializeTaggedJson({
          ok: true,
          queued: {
            runtimeTxs: runtimeTxs.length,
            entityInputs: entityInputs.length,
            jInputs: jInputs.length,
          },
        }),
        { headers },
      );
    } catch (error) {
      return new Response(
        serializeTaggedJson({ ok: false, error: (error as Error).message || 'Failed to queue runtime input' }),
        { status: 500, headers },
      );
    }
  }

  if (pathname === '/api/control/p2p' && req.method === 'POST') {
    const authError = requireDaemonControlAuth(req);
    if (authError) return authError;
    if (!env) {
      return new Response(serializeTaggedJson({ ok: false, error: 'Runtime not ready' }), { status: 503, headers });
    }
    try {
      const body = await parseTaggedControlBody<{
        relayUrls?: unknown;
        advertiseEntityIds?: unknown;
        gossipPollMs?: unknown;
      }>(req);
      const relayUrls = Array.isArray(body?.relayUrls)
        ? body.relayUrls.map(value => (typeof value === 'string' ? value.trim() : '')).filter(Boolean)
        : undefined;
      const advertiseEntityIds = Array.isArray(body?.advertiseEntityIds)
        ? body.advertiseEntityIds.map(value => (typeof value === 'string' ? value.trim().toLowerCase() : '')).filter(Boolean)
        : undefined;
      const gossipPollMs = Number.isFinite(Number(body?.gossipPollMs))
        ? Math.max(1000, Math.floor(Number(body?.gossipPollMs)))
        : undefined;

      startP2P(env, {
        ...(relayUrls ? { relayUrls } : {}),
        ...(advertiseEntityIds ? { advertiseEntityIds } : {}),
        ...(gossipPollMs !== undefined ? { gossipPollMs } : {}),
      });

      return new Response(
        serializeTaggedJson({
          ok: true,
          config: {
            relayUrls: relayUrls ?? null,
            advertiseEntityIds: advertiseEntityIds ?? null,
            gossipPollMs: gossipPollMs ?? null,
          },
        }),
        { headers },
      );
    } catch (error) {
      return new Response(
        serializeTaggedJson({ ok: false, error: (error as Error).message || 'Failed to update P2P config' }),
        { status: 500, headers },
      );
    }
  }

  // JSON-RPC proxy endpoint (single canonical path: /rpc).
  // Keep /api/rpc for compatibility with older clients.
  if ((pathname === '/api/rpc' || pathname === '/rpc') && req.method === 'POST') {
    const blockLocal = process.env.BLOCK_LOCAL_RPC_PROXY === 'true';
    const explicitUpstream = process.env.RPC_UPSTREAM_URL || process.env.PUBLIC_RPC_URL || process.env.ANVIL_RPC;
    const jMachineRpc = env?.activeJurisdiction ? env.jReplicas.get(env.activeJurisdiction)?.rpcUrl : undefined;
    const upstream = explicitUpstream || jMachineRpc || '';
    const isLocal = isLoopbackUrl(upstream);

    if (!upstream) {
      pushDebugEvent(relayStore, {
        event: 'error',
        reason: 'RPC_PROXY_NO_UPSTREAM',
        details: { path: pathname },
      });
      return new Response(JSON.stringify({ error: 'RPC upstream not configured' }), { status: 503, headers });
    }
    if (isLocal && blockLocal) {
      pushDebugEvent(relayStore, {
        event: 'error',
        reason: 'RPC_PROXY_LOCAL_BLOCKED',
        details: { upstream, path: pathname },
      });
      return new Response(
        JSON.stringify({
          error: 'Local RPC upstream is blocked in this environment',
          upstream,
        }),
        { status: 503, headers },
      );
    }

    try {
      const bodyText = await req.text();
      const rpcRes = await fetch(upstream, {
        method: 'POST',
        headers: {
          'content-type': req.headers.get('content-type') || 'application/json',
        },
        body: bodyText,
      });
      const respBody = await rpcRes.text();
      return new Response(respBody, {
        status: rpcRes.status,
        headers: {
          ...headers,
          'Content-Type': rpcRes.headers.get('content-type') || 'application/json',
        },
      });
    } catch (error: unknown) {
      pushDebugEvent(relayStore, {
        event: 'error',
        reason: 'RPC_PROXY_FETCH_FAILED',
        details: { upstream, path: pathname, error: error?.message || String(error) },
      });
      return new Response(JSON.stringify({ error: error?.message || 'RPC proxy failed' }), { status: 502, headers });
    }
  }

  // Health check
  if (pathname === '/api/health') {
    const now = Date.now();
    if (cachedHealthResponse && cachedHealthResponse.expiresAt > now) {
      return new Response(cachedHealthResponse.body, {
        headers: {
          ...headers,
          'Cache-Control': 'private, max-age=10',
        },
      });
    }

    if (!cachedHealthInFlight) {
      cachedHealthInFlight = (async () => {
        const { getHealthStatus } = await import('./health.ts');
        const health = await getHealthStatus(env);
        const activeClientRuntimeIds = Array.from(relayStore.clients.keys());
        const activeClientsDetailed = Array.from(relayStore.clients.entries()).map(([runtimeId, client]) => ({
          runtimeId,
          lastSeen: client.lastSeen,
          ageMs: Math.max(0, Date.now() - client.lastSeen),
          topics: Array.from(client.topics || []),
        }));
        const relayHubProfiles = getAllGossipProfiles(relayStore).filter((profile: Profile) =>
          profile.metadata.isHub === true,
        );
        const existing = new Set((health.hubs || []).map((hub) => String(hub.entityId).toLowerCase()));
        for (const profile of relayHubProfiles) {
          const entityId = profile.entityId;
          if (existing.has(entityId.toLowerCase())) continue;
          health.hubs.push({
            entityId,
            name: profile.name,
            status: 'healthy',
            reserves: env ? getReplicaReserveSnapshot(env, entityId) : undefined,
            accounts: env ? getReplicaAccountCount(env, entityId) : undefined,
          });
          existing.add(entityId.toLowerCase());
        }

        const relayHubsByEntity = new Map<string, Profile>();
        for (const profile of relayHubProfiles) {
          relayHubsByEntity.set(profile.entityId.toLowerCase(), profile);
        }
        const relayProfiles = getAllGossipProfiles(relayStore);
        const relayProfileSummaries = relayProfiles
          .map((profile: Profile) => ({
            entityId: profile.entityId,
            runtimeId: profile.runtimeId || null,
            name: profile.name,
            isHub: profile.metadata.isHub === true,
            lastUpdated: profile.lastUpdated,
          }))
          .sort((left, right) => right.lastUpdated - left.lastUpdated);
        health.hubs = (health.hubs || []).map((hub: HubHealth) => {
          const entityId = String(hub.entityId || '');
          const profile = relayHubsByEntity.get(entityId.toLowerCase());
          const runtimeId = profile?.runtimeId;
          const normalizedRuntimeId = normalizeRuntimeKey(runtimeId);
          const activeClients =
            normalizedRuntimeId && relayStore.clients.has(normalizedRuntimeId) ? [normalizedRuntimeId] : [];
          return {
            ...hub,
            runtimeId: normalizedRuntimeId || runtimeId,
            online: activeClients.length > 0,
            activeClients,
            reserves: env ? getReplicaReserveSnapshot(env, entityId) ?? hub.reserves : hub.reserves,
            accounts: env ? getReplicaAccountCount(env, entityId) ?? hub.accounts : hub.accounts,
          };
        });
        const bootstrapReserves = await getBootstrapReserveHealth(env);
        const body = JSON.stringify({
          ...health,
          boot: {
            phase: serverBootPhase,
            startedAt: serverBootStartedAt || null,
            completedAt: serverBootCompletedAt,
            error: serverBootError,
          },
          hubMesh: getHubMeshHealth(env),
          marketMaker: getMarketMakerHealth(env),
          bootstrapReserves,
          relay: {
            activeClients: activeClientRuntimeIds,
            activeClientCount: activeClientRuntimeIds.length,
            clientsDetailed: activeClientsDetailed,
            profileCount: relayProfiles.length,
            profiles: relayProfileSummaries,
          },
        });
        cachedHealthResponse = {
          body,
          expiresAt: Date.now() + HEALTH_CACHE_TTL_MS,
        };
        return body;
      })().finally(() => {
        cachedHealthInFlight = null;
      });
    }

    const body = await cachedHealthInFlight;
    return new Response(body, {
      headers: {
        ...headers,
        'Cache-Control': 'private, max-age=10',
      },
    });
  }

  if (pathname === '/api/hubs') {
    const relayHubProfiles = getAllGossipProfiles(relayStore).filter((profile: Profile) =>
      profile.metadata.isHub === true,
    );
    const mergedHubProfiles = new Map<string, Profile>();
    for (const profile of relayHubProfiles) {
      mergedHubProfiles.set(String(profile.entityId || '').toLowerCase(), profile);
    }
    for (const profile of env?.gossip?.getHubs?.() || []) {
      const entityId = String(profile.entityId || '').toLowerCase();
      if (!entityId || mergedHubProfiles.has(entityId)) continue;
      mergedHubProfiles.set(entityId, profile);
    }

    const hubs = Array.from(mergedHubProfiles.values())
      .map((profile: Profile) => {
        const runtimeId = normalizeRuntimeKey(profile.runtimeId);
        return {
          entityId: profile.entityId,
          runtimeId: runtimeId || profile.runtimeId || null,
          name: profile.name,
          bio: profile.bio || null,
          website: profile.website || null,
          wsUrl: profile.wsUrl || null,
          publicAccounts: profile.publicAccounts || [],
          metadata: profile.metadata,
          lastUpdated: profile.lastUpdated,
          online: runtimeId ? relayStore.clients.has(runtimeId) : false,
        };
      })
      .sort((left, right) => {
        const leftName = String(left.name || '');
        const rightName = String(right.name || '');
        if (leftName && rightName && leftName !== rightName) {
          return compareText(leftName, rightName);
        }
        return Number(right.lastUpdated || 0) - Number(left.lastUpdated || 0);
      });

    return new Response(
      safeStringify({
        ok: true,
        count: hubs.length,
        serverTime: Date.now(),
        hubs,
      }),
      { headers },
    );
  }

  if (pathname === '/api/gossip/profile') {
    const url = new URL(req.url);
    const targetEntityId = String(url.searchParams.get('entityId') || '').trim().toLowerCase();
    if (!targetEntityId) {
      return new Response(
        safeStringify({ ok: false, error: 'entityId is required' }),
        { status: 400, headers },
      );
    }

    try {
      await env?.runtimeState?.p2p?.syncProfiles?.();
    } catch {
      // best effort only
    }
    try {
      if (env) {
        await ensureGossipProfiles(env, [targetEntityId]);
      }
    } catch {
      // best effort only
    }

    const bundle = getKnownProfileBundle(env, targetEntityId);
    return new Response(
      safeStringify({
        ok: true,
        entityId: targetEntityId,
        found: !!bundle.profile,
        profile: bundle.profile,
        peers: bundle.peers,
      }),
      { headers },
    );
  }

  if (pathname === '/api/jurisdictions') {
    try {
      const payload = await buildRuntimeJurisdictionsJson(env) ?? await readCanonicalJurisdictionsJson();
      return new Response(payload, {
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        },
      });
    } catch (error: unknown) {
      return new Response(
        JSON.stringify({ error: error?.message || 'Failed to read jurisdictions.json' }),
        { status: 500, headers },
      );
    }
  }

  // Runtime state
  if (pathname === '/api/state' && env) {
    return new Response(
      JSON.stringify({
        height: env.height,
        timestamp: env.timestamp,
        runtimeId: env.runtimeId,
        entityCount: env.eReplicas?.size || 0,
      }),
      { headers },
    );
  }

  // Connected clients
  if (pathname === '/api/clients') {
    return new Response(
      JSON.stringify({
        count: relayStore.clients.size,
        clients: Array.from(relayStore.clients.keys()),
      }),
      { headers },
    );
  }

  // Relay debug timeline (single source for network + critical runtime events)
  if (pathname === '/api/debug/events') {
    const url = new URL(req.url);
    const last = Math.max(1, Math.min(5000, Number(url.searchParams.get('last') || '200')));
    const event = url.searchParams.get('event') || undefined;
    const runtimeId = url.searchParams.get('runtimeId') || undefined;
    const from = url.searchParams.get('from') || undefined;
    const to = url.searchParams.get('to') || undefined;
    const msgType = url.searchParams.get('msgType') || undefined;
    const status = url.searchParams.get('status') || undefined;
    const since = Number(url.searchParams.get('since') || '0');

    let filtered = relayStore.debugEvents;
    if (since > 0) filtered = filtered.filter(e => e.ts >= since);
    if (event) filtered = filtered.filter(e => e.event === event);
    if (runtimeId)
      filtered = filtered.filter(e => e.runtimeId === runtimeId || e.from === runtimeId || e.to === runtimeId);
    if (from) filtered = filtered.filter(e => e.from === from);
    if (to) filtered = filtered.filter(e => e.to === to);
    if (msgType) filtered = filtered.filter(e => e.msgType === msgType);
    if (status) filtered = filtered.filter(e => e.status === status);

    const events = filtered.slice(-last);
    return new Response(
      safeStringify({
        ok: true,
        total: relayStore.debugEvents.length,
        returned: events.length,
        serverTime: Date.now(),
        filters: { last, event, runtimeId, from, to, msgType, status, since: Number.isFinite(since) ? since : 0 },
        events,
      }),
      { headers },
    );
  }

  if (pathname === '/api/debug/events/mark' && req.method === 'POST') {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const label = typeof body?.label === 'string' ? body.label.trim() : '';
    if (!label) {
      return new Response(
        safeStringify({ ok: false, error: 'label is required' }),
        { status: 400, headers },
      );
    }

    const runtimeId = typeof body?.runtimeId === 'string' && body.runtimeId.trim().length > 0
      ? body.runtimeId.trim()
      : undefined;
    const entityId = typeof body?.entityId === 'string' && body.entityId.trim().length > 0
      ? body.entityId.trim()
      : undefined;
    const phase = typeof body?.phase === 'string' && body.phase.trim().length > 0
      ? body.phase.trim()
      : undefined;
    const details = body?.details && typeof body.details === 'object'
      ? body.details
      : undefined;

    pushDebugEvent(relayStore, {
      event: 'e2e_phase',
      runtimeId,
      status: 'mark',
      reason: label,
      details: {
        label,
        phase,
        entityId,
        details,
      },
    });

    return new Response(
      safeStringify({
        ok: true,
        label,
        runtimeId: runtimeId ?? null,
        entityId: entityId ?? null,
        phase: phase ?? null,
      }),
      { headers },
    );
  }

  if (pathname === '/api/debug/dumps' && req.method === 'GET') {
    await ensureDebugDumpDir();
    const limit = Math.max(1, Math.min(200, Number(new URL(req.url).searchParams.get('last') || '50')));
    const files = (await readdir(DEBUG_DUMPS_DIR).catch(() => []))
      .filter((name) => name.endsWith('.json'))
      .sort()
      .slice(-limit)
      .reverse();
    return new Response(
      safeStringify({
        ok: true,
        dir: DEBUG_DUMPS_DIR,
        files,
      }),
      { headers },
    );
  }

  if (pathname === '/api/debug/dumps' && req.method === 'POST') {
    await ensureDebugDumpDir();
    const rawBody = await req.text().catch(() => '');
    const parsed = rawBody
      ? deserializeTaggedJson<Record<string, unknown>>(rawBody)
      : null;
    const payload = parsed && typeof parsed === 'object'
      ? parsed
      : { rawBody };
    const trigger = payload?.trigger && typeof payload.trigger === 'object'
      ? payload.trigger as Record<string, unknown>
      : undefined;
    const reason = typeof trigger?.message === 'string'
      ? trigger.message
      : typeof payload?.reason === 'string'
        ? payload.reason
        : 'debug-dump';
    const runtimeId = typeof payload?.runtimeState === 'object' && payload.runtimeState
      && typeof (payload.runtimeState as Record<string, unknown>).runtimeId === 'string'
      ? String((payload.runtimeState as Record<string, unknown>).runtimeId)
      : undefined;
    const fileName = buildDebugDumpFileName(reason, runtimeId);
    const filePath = join(DEBUG_DUMPS_DIR, fileName);
    await writeFile(filePath, safeStringify(payload, 2), 'utf8');

    let preview: unknown = undefined;
    try {
      preview = JSON.parse(await readFile(filePath, 'utf8'));
    } catch {
      preview = undefined;
    }

    pushDebugEvent(relayStore, {
      event: 'consensus_dump',
      status: 'stored',
      runtimeId,
      reason: String(reason).slice(0, 240),
      details: {
        file: fileName,
        trigger: trigger ?? null,
        height: typeof payload?.runtimeState === 'object' && payload.runtimeState
          ? (payload.runtimeState as Record<string, unknown>).height
          : null,
        persistedLatestHeight: typeof payload?.persistedWal === 'object' && payload.persistedWal
          ? (payload.persistedWal as Record<string, unknown>).latestHeight
          : null,
        preview: preview && typeof preview === 'object'
          ? {
              timestamp: (preview as Record<string, unknown>).timestamp ?? null,
              url: (preview as Record<string, unknown>).url ?? null,
            }
          : null,
      },
    });

    return new Response(
      safeStringify({
        ok: true,
        file: fileName,
        path: filePath,
      }),
      { headers },
    );
  }

  // Registered gossip entities (relay-authoritative public profile store)
  if (pathname === '/api/debug/entities') {
    const url = new URL(req.url);
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(5000, Number(url.searchParams.get('limit') || '1000')));
    const onlineOnly = url.searchParams.get('online') === 'true';
    const entities = Array.from(relayStore.gossipProfiles.entries())
      .map(([entityId, entry]) => {
        const profile = entry.profile || {};
        const runtimeId = typeof profile.runtimeId === 'string' ? profile.runtimeId : undefined;
        const normalizedRuntimeId = normalizeRuntimeKey(runtimeId);
        const name =
          typeof profile.name === 'string' && profile.name.trim().length > 0
            ? profile.name.trim()
            : entityId;
        const isHub = profile.metadata.isHub === true;
        const online = normalizedRuntimeId ? relayStore.clients.has(normalizedRuntimeId) : false;
        return {
          entityId,
          runtimeId: normalizedRuntimeId || runtimeId,
          name,
          isHub,
          online,
          lastUpdated: Number(profile.lastUpdated || entry.timestamp || 0),
          accounts: profile.accounts,
          publicAccounts: profile.publicAccounts,
          metadata: profile.metadata,
        };
      })
      .filter(e => {
        if (onlineOnly && !e.online) return false;
        if (!q) return true;
        const blob = `${e.entityId} ${e.runtimeId || ''} ${e.name}`.toLowerCase();
        return blob.includes(q);
      })
      .sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0))
      .slice(0, limit);

    return new Response(
      safeStringify({
        ok: true,
        totalRegistered: relayStore.gossipProfiles.size,
        returned: entities.length,
        serverTime: Date.now(),
        entities,
      }),
      { headers },
    );
  }

  if (pathname === '/api/debug/reserve') {
    if (!globalJAdapter) {
      return new Response(JSON.stringify({ error: 'J-adapter not initialized' }), { status: 503, headers });
    }

    const url = new URL(req.url);
    const entityId = String(url.searchParams.get('entityId') || '').trim();
    const tokenId = Number(url.searchParams.get('tokenId') || '1');

    if (!entityId) {
      return new Response(JSON.stringify({ error: 'Missing entityId' }), { status: 400, headers });
    }
    if (!Number.isInteger(tokenId) || tokenId <= 0) {
      return new Response(JSON.stringify({ error: 'Invalid tokenId' }), { status: 400, headers });
    }

    try {
      const reserve = await globalJAdapter.getReserves(entityId, tokenId);
      return new Response(
        safeStringify({
          ok: true,
          entityId,
          tokenId,
          reserve: reserve.toString(),
        }),
        { headers },
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers });
    }
  }

  // J-event watching is handled by JAdapter.startWatching() per-jReplica

  // Token catalog (for UI token list + deposits)
  if (pathname === '/api/tokens') {
    return await externalWalletApi.handleTokens();
  }

  // ============================================================================
  // FAUCET ENDPOINTS
  // ============================================================================

  // Faucet A: External ERC20 → user wallet
  if (pathname === '/api/faucet/erc20' && req.method === 'POST') {
    return await externalWalletApi.handleErc20Faucet(req);
  }

  // Faucet A2: Gas-only topup (for approve/deposit)
  if (pathname === '/api/faucet/gas' && req.method === 'POST') {
    return await externalWalletApi.handleGasFaucet(req);
  }

  // Faucet B: Hub reserve → user reserve via processBatch
  if (pathname === '/api/faucet/reserve' && req.method === 'POST') {
    // Acquire mutex to prevent nonce collisions
    await faucetLock.acquire();
    try {
      if (!globalJAdapter) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: 'J-adapter not initialized' }), { status: 503, headers });
      }
      if (!env) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: 'Runtime not initialized' }), { status: 503, headers });
      }

      const body = await req.json();
      const userEntityId = body?.userEntityId;
      const rawTokenId = body?.tokenId ?? 1;
      let tokenId = typeof rawTokenId === 'number' ? rawTokenId : Number(rawTokenId);
      const tokenSymbol = typeof body?.tokenSymbol === 'string' ? body.tokenSymbol : undefined;
      const amount = typeof body?.amount === 'string' ? body.amount : String(body?.amount ?? '100');
      const requestId =
        globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const logPrefix = `FAUCET/RESERVE ${requestId}`;

      if (!userEntityId) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: 'Missing userEntityId' }), { status: 400, headers });
      }
      if (!Number.isFinite(tokenId)) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: 'Invalid tokenId' }), { status: 400, headers });
      }

      // Get hub from server-authoritative hub set + gossip
      const hubs = getFaucetHubProfiles(env);
      if (hubs.length === 0) {
        faucetLock.release();
        return new Response(
          JSON.stringify({
            error: 'No faucet hub available',
            code: 'FAUCET_HUBS_EMPTY',
            profiles: env.gossip?.getProfiles?.()?.length || 0,
            activeHubEntityIds: relayStore.activeHubEntityIds,
          }),
          { status: 503, headers },
        );
      }
      const hubEntityId = hubs[0].entityId;

      const hubSignerId = resolveEntityProposerId(env, hubEntityId, 'faucet-reserve');
      const tokenCatalog = await ensureTokenCatalog();
      let tokenMeta = tokenCatalog.find(t => Number(t.tokenId) === Number(tokenId));
      if (!tokenMeta && tokenSymbol) {
        tokenMeta = tokenCatalog.find(t => t.symbol?.toUpperCase?.() === tokenSymbol.toUpperCase());
        if (tokenMeta?.tokenId !== undefined && tokenMeta?.tokenId !== null) {
          tokenId = Number(tokenMeta.tokenId);
        }
      }
      if (!tokenMeta) {
        faucetLock.release();
        return new Response(JSON.stringify({ error: `Unknown token for faucet`, tokenId, tokenSymbol }), {
          status: 400,
          headers,
        });
      }
      const decimals = typeof tokenMeta.decimals === 'number' ? tokenMeta.decimals : 18;
      const amountWei = ethers.parseUnits(amount, decimals);
      const requestStartedAt = Date.now();
      console.log(
        `[${logPrefix}] Request: hub=${hubEntityId.slice(0, 16)}... signer=${hubSignerId} → user=${userEntityId.slice(0, 16)}... tokenId=${tokenId} symbol=${tokenMeta.symbol} amount=${amount} decimals=${decimals}`,
      );

      const prevUserReserve = await globalJAdapter.getReserves(userEntityId, tokenId).catch(() => 0n);
      let hubReplicaKey = Array.from(env.eReplicas?.keys?.() || []).find(key => key.startsWith(`${hubEntityId}:`));
      let hubReplica = hubReplicaKey ? env.eReplicas?.get(hubReplicaKey) : null;
      const hubReserve = hubReplica?.state?.reserves?.get(tokenId) ?? 0n;
      console.log(`[${logPrefix}] Hub reserve before R2R: token ${tokenId} = ${hubReserve.toString()}`);
      if (hubReserve < amountWei) {
        faucetLock.release();
        return new Response(
          JSON.stringify({
            error: `Hub has insufficient reserves for token ${tokenId}`,
            have: hubReserve.toString(),
            need: amountWei.toString(),
            requestId,
          }),
          { status: 409, headers },
        );
      }

      const enqueueReserveTransfer = (): void => {
        enqueueRuntimeInput(env, {
          runtimeTxs: [],
          entityInputs: [
            {
              entityId: hubEntityId,
              signerId: hubSignerId,
              entityTxs: [
                {
                  type: 'r2r',
                  data: {
                    toEntityId: userEntityId,
                    tokenId,
                    amount: amountWei,
                  },
                },
              ],
            },
          ],
        });
      };

      const enqueueBatchBroadcast = (): void => {
        enqueueRuntimeInput(env, {
          runtimeTxs: [],
          entityInputs: [
            {
              entityId: hubEntityId,
              signerId: hubSignerId,
              entityTxs: [{ type: 'j_broadcast', data: {} }],
            },
          ],
        });
      };

      enqueueReserveTransfer();
      // Log hub jBatchState summary after queuing
      hubReplicaKey = Array.from(env.eReplicas?.keys?.() || []).find(key => key.startsWith(`${hubEntityId}:`));
      hubReplica = hubReplicaKey ? env.eReplicas?.get(hubReplicaKey) : null;
      if (hubReplica?.state?.jBatchState?.batch) {
        const batch = hubReplica.state.jBatchState.batch;
        console.log(
          `[${logPrefix}] Hub jBatch: r2r=${batch.reserveToReserve.length}, r2c=${batch.reserveToCollateral.length}, c2r=${batch.collateralToReserve.length}, settlements=${batch.settlements.length}, sentPending=${hubReplica.state.jBatchState.sentBatch ? 'yes' : 'no'}`,
        );
      }
      if (env.jReplicas) {
        for (const [name, replica] of env.jReplicas.entries()) {
          if ((replica.mempool?.length ?? 0) > 0) {
            console.log(
              `[${logPrefix}] J-mempool "${name}": size=${replica.mempool.length}, block=${replica.blockNumber ?? 0}, lastTs=${replica.lastBlockTimestamp ?? 0}`,
            );
          }
        }
      }
      console.log(`[${logPrefix}] R2R queued (waiting for broadcast window)`);
      const runtimeIdleStartedAt = Date.now();
      const runtimeIdle = await waitForRuntimeIdle(env, 5000);
      const runtimeIdleMs = Date.now() - runtimeIdleStartedAt;
      if (!runtimeIdle) {
        console.warn(
          `[${logPrefix}] runtime idle wait timed out after ${runtimeIdleMs}ms (poll=${resolveRuntimeWaitPollMs()}ms)`,
        );
      }

      const broadcastWindowStartedAt = Date.now();
      const broadcastWindowReady = await waitForEntityBroadcastWindow(env, hubEntityId, 10000);
      const broadcastWindowMs = Date.now() - broadcastWindowStartedAt;
      if (!broadcastWindowReady) {
        faucetLock.release();
        return new Response(
          JSON.stringify({
            error: 'Hub sentBatch did not clear in time',
            requestId,
          }),
          { status: 504, headers },
        );
      }

      enqueueBatchBroadcast();
      const broadcastIdleStartedAt = Date.now();
      const broadcastIdle = await waitForRuntimeIdle(env, 5000);
      const broadcastIdleMs = Date.now() - broadcastIdleStartedAt;
      if (!broadcastIdle) {
        console.warn(
          `[${logPrefix}] runtime idle after broadcast timed out after ${broadcastIdleMs}ms (poll=${resolveRuntimeWaitPollMs()}ms)`,
        );
      }

      const jBatchClearStartedAt = Date.now();
      const jBatchCleared = await waitForJBatchClear(env, 10000);
      const jBatchClearMs = Date.now() - jBatchClearStartedAt;
      if (!jBatchCleared) {
        faucetLock.release();
        return new Response(
          JSON.stringify({
            error: 'J-batch did not broadcast in time',
            requestId,
          }),
          { status: 504, headers },
        );
      }

      const expectedMin = prevUserReserve + amountWei;
      const reserveWaitStartedAt = Date.now();
      const updatedReserve = await waitForReserveUpdate(userEntityId, tokenId, expectedMin, 10000);
      const reserveWaitMs = Date.now() - reserveWaitStartedAt;
      if (updatedReserve === null) {
        faucetLock.release();
        return new Response(
          JSON.stringify({
            error: 'Reserve update not confirmed on-chain',
            requestId,
          }),
          { status: 504, headers },
        );
      }
      const totalMs = Date.now() - requestStartedAt;
      console.log(
        `[${logPrefix}] timings ms(runtimeIdle=${formatTimingMs(runtimeIdleMs)},broadcastWindow=${formatTimingMs(broadcastWindowMs)},broadcastIdle=${formatTimingMs(broadcastIdleMs)},jBatchClear=${formatTimingMs(jBatchClearMs)},reserve=${formatTimingMs(reserveWaitMs)},total=${formatTimingMs(totalMs)}) ` +
          `polls(runtime=${resolveRuntimeWaitPollMs()}ms,reserve=${resolveReserveWaitPollMs()}ms) prevReserve=${prevUserReserve.toString()} updatedReserve=${updatedReserve.toString()}`,
      );

      faucetLock.release();
      return new Response(
        JSON.stringify({
          success: true,
          type: 'reserve',
          amount,
          tokenId,
          from: hubEntityId.slice(0, 16) + '...',
          to: userEntityId.slice(0, 16) + '...',
          requestId,
        }),
        { headers },
      );
    } catch (error: unknown) {
      faucetLock.release();
      console.error('[FAUCET/RESERVE] Error:', error);
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    }
  }

  // Faucet C: Offchain payment via bilateral account
  if (pathname === '/api/faucet/offchain' && req.method === 'POST') {
    try {
      if (!env) {
        return new Response(JSON.stringify({ error: 'Runtime not initialized' }), { status: 503, headers });
      }

      const body = await req.json();
      const {
        userEntityId,
        userRuntimeId,
        tokenId = 1,
        amount = '100',
        hubEntityId: requestedHubEntityId,
      } = body;
      const requestId = `offchain_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      if (!userEntityId) {
        return new Response(JSON.stringify({ error: 'Missing userEntityId' }), { status: 400, headers });
      }
      if (!isEntityId32(userEntityId)) {
        return new Response(
          JSON.stringify({
            error: `Invalid userEntityId: expected bytes32 hex, got "${String(userEntityId)}"`,
            code: 'FAUCET_INVALID_USER_ENTITY_ID',
          }),
          { status: 400, headers },
        );
      }
      if (
        requestedHubEntityId !== undefined &&
        requestedHubEntityId !== null &&
        requestedHubEntityId !== '' &&
        !isEntityId32(requestedHubEntityId)
      ) {
        return new Response(
          JSON.stringify({
            error: `Invalid hubEntityId: expected bytes32 hex, got "${String(requestedHubEntityId)}"`,
            code: 'FAUCET_INVALID_HUB_ENTITY_ID',
          }),
          { status: 400, headers },
        );
      }
      const normalizedUserEntityId = String(userEntityId).toLowerCase();
      let normalizedUserRuntimeId = normalizeRuntimeKey(userRuntimeId);
      if (!normalizedUserRuntimeId) {
        const allProfiles = env.gossip?.getProfiles() || [];
        const userProfile = allProfiles.find(
          (p: Profile) => String(p?.entityId || '').toLowerCase() === normalizedUserEntityId,
        );
        const profileRuntimeId = normalizeRuntimeKey(userProfile?.runtimeId);
        if (profileRuntimeId) {
          normalizedUserRuntimeId = profileRuntimeId;
        }
      }
      if (!normalizedUserRuntimeId) {
        return new Response(
          JSON.stringify({
            success: false,
            code: 'FAUCET_RUNTIME_REQUIRED',
            error: 'Missing userRuntimeId',
            message: 'Runtime is offline or not initialized yet. Re-open runtime and retry faucet.',
          }),
          { status: 400, headers },
        );
      }
      const normalizedRuntimeKey = normalizeRuntimeKey(normalizedUserRuntimeId);
      console.log(
        `[FAUCET/OFFCHAIN] req=${requestId} user=${normalizedUserEntityId.slice(-8)} runtime=${normalizedUserRuntimeId.slice(0, 10)} ` +
          `clients=${relayStore.clients.size} activeHubs=${relayStore.activeHubEntityIds.length}`,
      );
      // Important: local relay client registry is authoritative only when faucet API
      // and relay endpoint are the same node. With external relay (e.g. wss://xln.finance/relay),
      // this process may not see the runtime socket directly. Treat local visibility as diagnostic,
      // not a hard reject.
      const runtimeSeenLocally = relayStore.clients.has(normalizedRuntimeKey);
      const runtimePubKey = relayStore.runtimeEncryptionKeys.get(normalizedRuntimeKey);
      if (!runtimeSeenLocally || !runtimePubKey) {
        const activeRelayClients = Array.from(relayStore.clients.keys());
        console.warn(
          `[FAUCET/OFFCHAIN] runtime-local-miss req=${requestId} runtime=${normalizedUserRuntimeId.slice(0, 10)} ` +
            `seen=${runtimeSeenLocally ? 1 : 0} pubKey=${runtimePubKey ? 1 : 0}`,
        );
        pushDebugEvent(relayStore, {
          event: 'debug_event',
          status: 'warning',
          reason: !runtimeSeenLocally ? 'FAUCET_RUNTIME_NOT_LOCAL_RELAY_CLIENT' : 'FAUCET_RUNTIME_PUBKEY_MISSING_LOCAL',
          details: {
            endpoint: '/api/faucet/offchain',
            userEntityId: normalizedUserEntityId,
            userRuntimeId: normalizedUserRuntimeId,
            runtimeSeenLocally,
            hasRuntimePubKey: !!runtimePubKey,
            activeRelayClients,
          },
        });
      }
      // Get hub from server-authoritative hub set + gossip
      const activeHubCandidates = relayStore.activeHubEntityIds
        .map(entityId => ({ entityId }))
        .filter(hub => !!hub.entityId);
      // Server authority first: if hubs are active on this server, faucet can always target them
      // without depending on client gossip freshness.
      const gossipHubs = activeHubCandidates.length > 0 ? [] : getFaucetHubProfiles(env);
      const hubs = activeHubCandidates.length > 0 ? activeHubCandidates : gossipHubs;
      if (hubs.length === 0) {
        const allProfiles = env.gossip?.getProfiles() || [];
        pushDebugEvent(relayStore, {
          event: 'error',
          status: 'rejected',
          reason: 'FAUCET_HUBS_EMPTY',
          details: {
            endpoint: '/api/faucet/offchain',
            profiles: allProfiles.length,
            activeHubEntityIds: relayStore.activeHubEntityIds,
            gossipHubCount: gossipHubs.length,
            hint: 'No faucet-capable hubs in server active set or gossip cache',
          },
        });
        return new Response(
          JSON.stringify({
            error: 'No faucet hub available in gossip',
            code: 'FAUCET_HUBS_EMPTY',
            profiles: allProfiles.length,
            activeHubEntityIds: relayStore.activeHubEntityIds,
            gossipHubCount: gossipHubs.length,
          }),
          { status: 503, headers },
        );
      }
      const requestedHubId =
        typeof requestedHubEntityId === 'string' && requestedHubEntityId.length > 0
          ? requestedHubEntityId.toLowerCase()
          : '';
      if (!requestedHubId) {
        return new Response(
          JSON.stringify({
            error: 'Missing hubEntityId for offchain faucet',
            code: 'FAUCET_HUB_REQUIRED',
            knownHubEntityIds: hubs.map(hub => hub.entityId),
          }),
          { status: 400, headers },
        );
      }
      const requestedHub = hubs.find(hub => hub.entityId.toLowerCase() === requestedHubId);
      if (!requestedHub) {
        return new Response(
          JSON.stringify({
            error: `Requested hub not found: ${requestedHubId}`,
            code: 'FAUCET_REQUESTED_HUB_NOT_FOUND',
            requestedHubEntityId: requestedHubId,
            knownHubEntityIds: hubs.map(h => h.entityId),
          }),
          { status: 404, headers },
        );
      }
      const hubEntityId = requestedHub.entityId;
      console.log(
        `[FAUCET/OFFCHAIN] selectedHub=${hubEntityId.slice(-8)} requested=${requestedHubId.slice(-8)}`,
      );
      if (!getEntityReplicaById(env, hubEntityId)) {
        return new Response(
          JSON.stringify({
            error: 'Faucet hub is not ready yet',
            code: 'FAUCET_HUB_NOT_READY',
            hubEntityId,
          }),
          { status: 503, headers },
        );
      }
      // Get actual signerId from entity's validators (not runtimeId!)
      let hubSignerId: string;
      try {
        hubSignerId = resolveEntityProposerId(env, hubEntityId, 'faucet-offchain');
      } catch (error) {
        return new Response(
          JSON.stringify({
            error: 'Faucet hub signer is unavailable',
            code: 'FAUCET_HUB_SIGNER_UNAVAILABLE',
            hubEntityId,
            details: (error as Error).message,
          }),
          { status: 503, headers },
        );
      }
      console.log(
        `[FAUCET/OFFCHAIN] hub=${hubEntityId.slice(-8)} signer=${hubSignerId.slice(-8)} amount=${amount} token=${tokenId}`,
      );
      pushDebugEvent(relayStore, {
        event: 'debug_event',
        status: 'info',
        reason: 'REB_STEP0_FAUCET_REQUEST',
        details: {
          requestId,
          hubEntityId,
          userEntityId: normalizedUserEntityId,
          userRuntimeId: normalizedUserRuntimeId,
          tokenId,
          amount,
        },
      });

      const amountWei = ethers.parseUnits(amount, 18);
      const accountMachine = getAccountMachine(env, hubEntityId, normalizedUserEntityId);
      const hasHubAccount = hasAccount(env, hubEntityId, normalizedUserEntityId) || !!accountMachine;
      const buildAccountPresence = () => hubs.map(hub => ({
        hubEntityId: hub.entityId,
        hasAccount: hasAccount(env, hub.entityId, normalizedUserEntityId),
      }));

      // Explicit invariant:
      // faucet is a one-way enqueue endpoint, not a synchronous settlement oracle.
      // It never tries to "repair" credit/sync state and never waits for the
      // counterparty side to materialize locally inside serverEnv.
      if (!hasHubAccount) {
        pushDebugEvent(relayStore, {
          event: 'error',
          status: 'rejected',
          reason: 'FAUCET_ACCOUNT_NOT_OPEN',
          details: {
            requestId,
            hubEntityId,
            userEntityId: normalizedUserEntityId,
            requestedHubEntityId: requestedHubId || null,
            accountPresence: buildAccountPresence(),
          },
        });
        const accountPresence = buildAccountPresence();
        return new Response(
          JSON.stringify({
            success: false,
            error: 'No bilateral account with selected hub. Open account first, then retry faucet.',
            code: 'FAUCET_ACCOUNT_NOT_OPEN',
            requestId,
            hubEntityId,
            userEntityId: normalizedUserEntityId,
            requestedHubEntityId: requestedHubId || null,
            accountPresence,
          }),
          { status: 409, headers },
        );
      }
      const currentOutCapacity = getEntityOutCapacity(accountMachine, hubEntityId, tokenId);
      if (currentOutCapacity < amountWei) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Selected hub does not have enough outbound capacity for offchain faucet.',
            code: 'FAUCET_INSUFFICIENT_OUT_CAPACITY',
            requestId,
            hubEntityId,
            userEntityId: normalizedUserEntityId,
            tokenId,
            requiredAmount: amountWei.toString(),
            senderOutCapacity: currentOutCapacity.toString(),
          }),
          { status: 409, headers },
        );
      }

      // Single-writer invariant: enqueue only; runtime loop applies.
      try {
        const hubPolicy = getEntityReplicaById(env, hubEntityId)?.state?.hubRebalanceConfig;
        const faucetDescription = encodeRebalancePolicyMemo('faucet-offchain', {
          policyVersion:
            Number.isFinite(Number(hubPolicy?.policyVersion)) && Number(hubPolicy?.policyVersion) > 0
              ? Number(hubPolicy?.policyVersion)
              : 1,
          baseFee: hubPolicy?.rebalanceBaseFee ?? 10n ** 17n,
          liquidityFeeBps: hubPolicy?.rebalanceLiquidityFeeBps ?? hubPolicy?.minFeeBps ?? 1n,
          gasFee: hubPolicy?.rebalanceGasFee ?? 0n,
        });
        const entityTxs: Array<{ type: string; data: Record<string, unknown> }> = [{
          type: 'directPayment',
          data: {
            targetEntityId: normalizedUserEntityId,
            tokenId,
            amount: amountWei,
            route: [hubEntityId, normalizedUserEntityId],
            description: faucetDescription,
          },
        }];
        enqueueRuntimeInput(env, {
          runtimeTxs: [],
          entityInputs: [
            {
              entityId: hubEntityId,
              signerId: hubSignerId,
              entityTxs,
            },
          ],
        });
      } catch (error) {
        return new Response(
          JSON.stringify({
            error: 'Failed to enqueue faucet payment',
            code: 'FAUCET_PAYMENT_ENQUEUE_FAILED',
            details: (error as Error).message,
          }),
          { status: 503, headers },
        );
      }
      console.log(`[FAUCET/OFFCHAIN] ✅ Payment accepted`);

      return new Response(
        JSON.stringify({
          success: true,
          type: 'offchain',
          status: 'queued',
          requestId,
          amount,
          tokenId,
          from: hubEntityId.slice(0, 16) + '...',
          to: normalizedUserEntityId.slice(0, 16) + '...',
          accountReady: true,
          senderOutCapacity: currentOutCapacity.toString(),
        }),
        { headers },
      );
    } catch (error: unknown) {
      console.error('[FAUCET/OFFCHAIN] Error:', error);
      const message = error?.message || 'Unknown faucet error';
      const status =
        message.includes('SIGNER_RESOLUTION_FAILED') || message.includes('RUNTIME_REPLICA_NOT_FOUND') ? 503 : 500;
      return new Response(JSON.stringify({ error: message }), { status, headers });
    }
  }

  if (pathname === '/api/credit/request' && req.method === 'POST') {
    try {
      if (!env) {
        return new Response(JSON.stringify({ error: 'Runtime not initialized' }), { status: 503, headers });
      }

      const body = await req.json();
      const userEntityId = typeof body?.userEntityId === 'string' ? body.userEntityId.toLowerCase() : '';
      const requestedHubEntityId = typeof body?.hubEntityId === 'string' ? body.hubEntityId.toLowerCase() : '';
      const tokenId = Number(body?.tokenId ?? 1);
      const amountRaw = typeof body?.amount === 'string' ? body.amount.trim() : '';

      if (!isEntityId32(userEntityId)) {
        return new Response(JSON.stringify({ error: 'Invalid userEntityId' }), { status: 400, headers });
      }
      if (!isEntityId32(requestedHubEntityId)) {
        return new Response(JSON.stringify({ error: 'Invalid hubEntityId' }), { status: 400, headers });
      }
      if (!/^\d+$/.test(amountRaw)) {
        return new Response(JSON.stringify({ error: 'Invalid amount' }), { status: 400, headers });
      }
      if (!Number.isFinite(tokenId) || tokenId <= 0) {
        return new Response(JSON.stringify({ error: 'Invalid tokenId' }), { status: 400, headers });
      }

      const hubs = getFaucetHubProfiles(env);
      const hubProfile = hubs.find((profile) => profile.entityId.toLowerCase() === requestedHubEntityId);
      if (!hubProfile) {
        return new Response(
          JSON.stringify({
            error: 'Requested hub is not available',
            knownHubEntityIds: hubs.map((profile) => profile.entityId),
          }),
          { status: 404, headers },
        );
      }

      const hubEntityId = hubProfile.entityId;
      const accountMachine = getAccountMachine(env, hubEntityId, userEntityId);
      if (!accountMachine || !hasAccount(env, hubEntityId, userEntityId)) {
        return new Response(
          JSON.stringify({
            error: 'No bilateral account with selected hub. Open account first.',
            hubEntityId,
            userEntityId,
          }),
          { status: 409, headers },
        );
      }

      const requestedAmount = BigInt(amountRaw);
      if (requestedAmount <= 0n) {
        return new Response(JSON.stringify({ error: 'Amount must be positive' }), { status: 400, headers });
      }

      const approvedAmount = requestedAmount > getRequestCreditCap(tokenId)
        ? getRequestCreditCap(tokenId)
        : requestedAmount;
      const currentOutCapacity = getEntityOutCapacity(accountMachine, hubEntityId, tokenId);
      if (currentOutCapacity >= approvedAmount) {
        return new Response(
          JSON.stringify({
            success: true,
            hubEntityId,
            userEntityId,
            tokenId,
            approvedAmount: currentOutCapacity.toString(),
          }),
          { status: 200, headers },
        );
      }

      let hubSignerId: string;
      try {
        hubSignerId = resolveEntityProposerId(env, hubEntityId, 'credit-request');
      } catch (error) {
        return new Response(
          JSON.stringify({ error: error instanceof Error ? error.message : 'Hub signer unavailable' }),
          { status: 503, headers },
        );
      }

      enqueueRuntimeInput(env, {
        runtimeTxs: [],
        entityInputs: [
          {
            entityId: hubEntityId,
            signerId: hubSignerId,
            entityTxs: [
              {
                type: 'extendCredit',
                data: {
                  counterpartyEntityId: userEntityId,
                  tokenId,
                  amount: approvedAmount,
                },
              },
            ],
          },
        ],
      });

      return new Response(
        JSON.stringify({
          success: true,
          hubEntityId,
          userEntityId,
          tokenId,
          approvedAmount: approvedAmount.toString(),
        }),
        { status: 200, headers },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), { status: 500, headers });
    }
  }

  return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers });
};

// ============================================================================
// MAIN SERVER
// ============================================================================

export async function startXlnServer(opts: Partial<XlnServerOptions> = {}): Promise<void> {
  installProcessSafetyGuards();
  console.log('═══ startXlnServer() CALLED ═══');
  console.log('Options:', opts);
  const options = { ...DEFAULT_OPTIONS, ...opts };
  activeServerOptions = { ...options };
  relayStore = createRelayStore(options.serverId ?? DEFAULT_OPTIONS.serverId ?? 'xln-server');
  rpcMarketSubscriptions.clear();
  if (rpcMarketPublisherTimer) {
    clearInterval(rpcMarketPublisherTimer);
    rpcMarketPublisherTimer = null;
  }
  const advertisedRelayUrl = resolveAdvertisedRelayUrl(options.port);
  const internalRelayUrl = resolveConfiguredRelayUrl(options.port);
  serverBootStartedAt = Date.now();
  serverBootCompletedAt = null;
  serverBootPhase = 'starting';
  serverBootError = null;
  serverStartupBarrier = new Promise<void>(resolve => {
    resolveServerStartupBarrier = resolve;
  });

  let env: Env | null = null;
  let routerConfig: RelayRouterConfig | null = null;

  const createHttpServer = () => Bun.serve({
    port: options.port,
    hostname: options.host,

    async fetch(req, server) {
      const url = new URL(req.url);
      const pathname = url.pathname;

      if (req.headers.get('upgrade') === 'websocket') {
        const wsType = pathname === '/relay' ? 'relay' : pathname === '/rpc' ? 'rpc' : null;
        if (wsType) {
          const upgraded = server.upgrade(req, { data: { type: wsType } });
          if (upgraded) return;
        }
        return new Response('WebSocket upgrade failed', { status: 400 });
      }

      if (
        pathname.startsWith('/api/') ||
        pathname === '/rpc'
      ) {
        try {
          return await handleApi(req, pathname, env);
        } catch (error) {
          const message = (error as Error)?.message || 'API handler failed';
          console.error(`[API] Unhandled route error (${pathname}): ${message}`);
          pushDebugEvent(relayStore, {
            event: 'error',
            reason: 'API_HANDLER_EXCEPTION',
            details: { pathname, message },
          });
          return new Response(safeStringify({ error: message, code: 'API_HANDLER_EXCEPTION' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      if (options.staticDir) {
        if (pathname === '/runtime.js') {
          const runtimeBundle = await serveRuntimeBundle();
          if (runtimeBundle) return runtimeBundle;
        }

        if (pathname === '/') {
          const index = await serveStatic('/index.html', options.staticDir);
          if (index) return index;
        }

        const file = await serveStatic(pathname, options.staticDir);
        if (file) return file;

        const fallback = await serveStatic('/index.html', options.staticDir);
        if (fallback) return fallback;
      }

      return new Response('Not found', { status: 404 });
    },

    websocket: {
      open(ws: RelaySocket) {
        const data = ws.data;
        console.log(`[WS] New ${data.type} connection`);
        pushDebugEvent(relayStore, {
          event: 'ws_open',
          details: { wsType: data.type },
        });
      },

      message(ws: RelaySocket, message) {
        const data = ws.data;
        const msgStr = message.toString();
        try {
          const msg = JSON.parse(msgStr);
          const routeRelayMessage = () => {
            if (!routerConfig) {
              ws.send(safeStringify({ type: 'error', error: 'Runtime transport not ready' }));
              return;
            }
            Promise.resolve(relayRoute(routerConfig, ws, msg)).catch(error => {
              const reason = (error as Error).message || 'relay handler error';
              console.error(`[WS] Relay handler error: ${reason}`);
              pushDebugEvent(relayStore, {
                event: 'error',
                reason: 'RELAY_HANDLER_EXCEPTION',
                details: {
                  error: reason,
                  msgType: msg?.type,
                  from: msg?.from,
                  to: msg?.to,
                },
              });
              try {
                ws.send(safeStringify({ type: 'error', error: 'Relay handler exception' }));
              } catch {
                // Socket may already be closed; ignore.
              }
            });
          };
          if (data.type === 'relay') {
            if (isMarketMessageType(msg?.type)) {
              handleMarketMessage(ws, msg, env);
              return;
            }
            if (!routerConfig) {
              if (isServerBootInProgress()) {
                void serverStartupBarrier.then(() => {
                  routeRelayMessage();
                });
                return;
              }
              ws.send(safeStringify({ type: 'error', error: 'Runtime transport not ready' }));
              return;
            }
            routeRelayMessage();
          } else if (data.type === 'rpc') {
            Promise.resolve(handleRpcMessage(ws, msg, env)).catch(error => {
              const reason = (error as Error).message || 'rpc handler error';
              console.error(`[WS] RPC handler error: ${reason}`);
              pushDebugEvent(relayStore, {
                event: 'error',
                reason: 'RPC_HANDLER_EXCEPTION',
                details: { error: reason, msgType: msg?.type },
              });
              try {
                ws.send(safeStringify({ type: 'error', error: 'RPC handler exception' }));
              } catch {
                // Socket may already be closed; ignore.
              }
            });
          }
        } catch (error) {
          console.error(`[WS] Parse error (type=${data.type}, len=${msgStr.length}):`, error);
          pushDebugEvent(relayStore, {
            event: 'error',
            reason: 'Invalid JSON',
            details: { wsType: data.type, len: msgStr.length, error: (error as Error).message },
          });
          ws.send(safeStringify({ type: 'error', error: 'Invalid JSON' }));
        }
      },

      close(ws: RelaySocket, code, reason) {
        cleanupRpcMarketSubscription(ws);
        const removedId = removeClient(relayStore, ws);
        const wsType = ws.data.type;
        const reasonText =
          typeof reason === 'string'
            ? reason
            : reason
              ? String(reason)
              : '';
        console.warn(
          `[WS] CLOSE wsType=${wsType} runtime=${removedId?.slice(0, 10) || 'unknown'} ` +
          `code=${Number(code || 0)} reason="${reasonText || 'n/a'}"`,
        );
        if (removedId) {
          pushDebugEvent(relayStore, {
            event: 'ws_close',
            runtimeId: removedId,
            from: removedId,
            details: {
              wsType,
              code: Number(code || 0),
              reason: reasonText || null,
            },
          });
        }
      },
    },
  });
  const server = createHttpServer();

  try {
    serverBootPhase = 'runtime';
    console.log('[XLN] Initializing runtime...');
    env = await main(SERVER_RUNTIME_SEED);
    serverEnv = env;
    console.log('[XLN] Runtime initialized ✓');
    const verboseRuntimeLogs = /^(1|true)$/i.test(process.env.RUNTIME_VERBOSE_LOGS ?? '');
    env.quietRuntimeLogs = !verboseRuntimeLogs;
    console.log(
      `[XLN] Runtime log mode: ${env.quietRuntimeLogs ? 'quiet' : 'verbose'} (set RUNTIME_VERBOSE_LOGS=1 for verbose)`,
    );
    env.runtimeState = env.runtimeState ?? {};
    env.runtimeState.directEntityInputDispatch = (targetRuntimeId, input, ingressTimestamp) =>
      sendEntityInputDirectViaRelaySocket(env, targetRuntimeId, input, ingressTimestamp);
    startRuntimeLoop(env);
    console.log('[XLN] Runtime event loop started ✓');

    // Initialize J-adapter (anvil for testnet, browserVM for local)
    const useAnvil = process.env.USE_ANVIL === 'true';
    const anvilRpc = useAnvil ? resolveRequiredAnvilRpc() : '';

    console.log('[XLN] J-adapter mode check:');
    console.log('  USE_ANVIL =', useAnvil);
    console.log('  ANVIL_RPC =', anvilRpc);

    let activeJName: string | null = null;

    if (useAnvil) {
      console.log('[XLN] Connecting to Anvil testnet...');
      const usePredeployedAddresses = process.env.XLN_USE_PREDEPLOYED_ADDRESSES === 'true';

    // Optional: reuse addresses from jurisdictions.json (disabled by default).
    const fs = await import('fs/promises');
    const path = await import('path');
    let fromReplica = undefined;
    if (usePredeployedAddresses) {
      try {
        const jurisdictionsPath = resolveJurisdictionsJsonPath();
        console.log(`[XLN] Loading predeployed addresses from: ${jurisdictionsPath}`);
        const jurisdictionsData = await fs.readFile(jurisdictionsPath, 'utf-8');
        const jurisdictions = JSON.parse(jurisdictionsData);
        const arrakisConfig = jurisdictions?.jurisdictions?.arrakis;

        if (arrakisConfig?.contracts) {
          fromReplica = {
            depositoryAddress: arrakisConfig.contracts.depository,
            entityProviderAddress: arrakisConfig.contracts.entityProvider,
            contracts: arrakisConfig.contracts,
            chainId: arrakisConfig.chainId ?? 31337,
          };
          console.log('[XLN] Loaded predeployed contract addresses from jurisdictions.json');
        }
      } catch (err) {
        console.warn('[XLN] Could not load predeployed addresses, will deploy fresh:', (err as Error).message);
      }
    } else {
      console.log('[XLN] Fresh deploy mode enabled (XLN_USE_PREDEPLOYED_ADDRESSES!=true)');
    }

    // Wait for ANVIL to be ready (retry up to 30s)
    let detectedChainId = 31337;
    const maxRetries = 30;
    let anvilReady = false;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const probe = new ethers.JsonRpcProvider(anvilRpc);
        const network = await probe.getNetwork();
        if (network?.chainId) detectedChainId = Number(network.chainId);
        anvilReady = true;
        console.log(`[XLN] ✅ ANVIL ready (chainId: ${detectedChainId})`);
        break;
      } catch (err) {
        if (i === 0) console.log(`[XLN] ⏳ Waiting for ANVIL at ${anvilRpc}...`);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    if (!anvilReady) {
      throw new Error(
        `❌ FAIL-FAST: ANVIL not reachable at ${anvilRpc} after ${maxRetries}s. Is anvil running?`,
      );
    }
    if (detectedChainId !== 31337) {
      throw new Error(`❌ FAIL-FAST: expected ANVIL chainId=31337, got ${detectedChainId} at ${anvilRpc}`);
    }

    // Ensure fromReplica carries correct chainId (override if stale)
    if (fromReplica && fromReplica.chainId !== detectedChainId) {
      console.warn(
        `[XLN] fromReplica chainId (${fromReplica.chainId}) does not match RPC chainId (${detectedChainId}) - overriding`,
      );
      fromReplica.chainId = detectedChainId;
    }

    if (fromReplica?.depositoryAddress && fromReplica?.entityProviderAddress) {
      console.log('[XLN] Pre-checking predeployed contract code...');
      const [depositoryCode, entityProviderCode] = await withStartupStepTimeout(
        'precheckPredeployedCode',
        (async () => {
          const depCode = await fetchRpcCode(anvilRpc, fromReplica.depositoryAddress);
          const entityProviderCode = await fetchRpcCode(anvilRpc, fromReplica.entityProviderAddress);
          return [depCode, entityProviderCode] as const;
        })(),
      );
      console.log('[XLN] Predeployed contract code pre-check complete');
      if (depositoryCode === '0x' || entityProviderCode === '0x') {
        console.warn(
          `[XLN] Ignoring stale jurisdictions addresses with no on-chain code: ` +
            `depository=${fromReplica.depositoryAddress} code=${depositoryCode} ` +
            `entityProvider=${fromReplica.entityProviderAddress} code=${entityProviderCode}`,
        );
        fromReplica = undefined;
      }
    }

    globalJAdapter = await withStartupStepTimeout(
      'createJAdapter(rpc)',
      createJAdapter({
        mode: 'rpc',
        chainId: detectedChainId,
        rpcUrl: anvilRpc,
        fromReplica,
      }),
    );

    const deployFreshLocalStack = async (reason: string): Promise<void> => {
      console.warn(`[XLN] Existing anvil contract stack is incompatible (${reason}). Deploying fresh stack...`);
      await globalJAdapter?.close().catch(() => undefined);
      globalJAdapter = await withStartupStepTimeout(
        'createJAdapter(rpc:fresh)',
        createJAdapter({
          mode: 'rpc',
          chainId: detectedChainId,
          rpcUrl: anvilRpc,
        }),
      );
      await withStartupStepTimeout('deployStack', globalJAdapter.deployStack(), Math.max(STARTUP_STEP_TIMEOUT_MS, 60_000));
      console.log('[XLN] Contracts deployed');
    };

    const hasAddresses = !!globalJAdapter.addresses?.depository && !!globalJAdapter.addresses?.entityProvider;
    if (!hasAddresses) {
      console.log('[XLN] Deploying contracts to anvil (missing addresses)...');
      await deployFreshLocalStack('MISSING_ADDRESSES');
    } else {
      const compatibility = await withStartupStepTimeout(
        'probeLocalAnvilContractStack',
        probeLocalAnvilContractStack(globalJAdapter),
      );
      if (!compatibility.ok) {
        await deployFreshLocalStack(compatibility.reason);
      } else if (fromReplica) {
        console.log('[XLN] Using compatible contracts from jurisdictions.json');
      } else {
        console.log('[XLN] Using existing contracts on anvil');
      }
    }

    const block = await withStartupStepTimeout('provider.getBlockNumber', globalJAdapter.provider.getBlockNumber());
    console.log(`[XLN] Anvil connected (block: ${block})`);

    if (globalJAdapter.addresses?.depository && globalJAdapter.addresses?.entityProvider) {
      await withStartupStepTimeout(
        'updateJurisdictionsJson',
        updateJurisdictionsJson(globalJAdapter.addresses, anvilRpc, detectedChainId),
      );
    }

    // Ensure env has a J-replica for this RPC jurisdiction (required for j_broadcast → j-mempool)
    if (globalJAdapter && env) {
      if (!env.jReplicas) env.jReplicas = new Map();
      const jName = 'arrakis';
      if (!env.jReplicas.has(jName)) {
        env.jReplicas.set(jName, {
          name: jName,
          blockNumber: 0n,
          stateRoot: new Uint8Array(32),
          mempool: [],
          blockDelayMs: 300,
          lastBlockTimestamp: env.timestamp,
          position: { x: 0, y: 50, z: 0 },
          depositoryAddress: globalJAdapter.addresses.depository,
          entityProviderAddress: globalJAdapter.addresses.entityProvider,
          contracts: globalJAdapter.addresses,
          rpcs: [anvilRpc],
          chainId: globalJAdapter.chainId,
          jadapter: globalJAdapter,
        });
        console.log(`[XLN] J-replica "${jName}" registered in env`);
      }
      if (!env.activeJurisdiction) env.activeJurisdiction = jName;
      activeJName = jName;
    }
    } else {
      console.log('[XLN] Using BrowserVM (local mode)');
      globalJAdapter = await withStartupStepTimeout(
        'createJAdapter(browservm)',
        createJAdapter({
          mode: 'browservm',
          chainId: 31337,
        }),
      );
      await withStartupStepTimeout('deployStack(browservm)', globalJAdapter.deployStack(), Math.max(STARTUP_STEP_TIMEOUT_MS, 60_000));
      if (globalJAdapter && env) {
        if (!env.jReplicas) env.jReplicas = new Map();
        const jName = 'local';
        if (!env.jReplicas.has(jName)) {
          env.jReplicas.set(jName, {
            name: jName,
            blockNumber: 0n,
            stateRoot: new Uint8Array(32),
            mempool: [],
            blockDelayMs: 300,
            lastBlockTimestamp: env.timestamp,
            position: { x: 0, y: 50, z: 0 },
            depositoryAddress: globalJAdapter.addresses.depository,
            entityProviderAddress: globalJAdapter.addresses.entityProvider,
            contracts: globalJAdapter.addresses,
            rpcs: [],
            chainId: globalJAdapter.chainId,
            jadapter: globalJAdapter,
          });
          console.log(`[XLN] J-replica "${jName}" registered in env`);
        }
        if (!env.activeJurisdiction) env.activeJurisdiction = jName;
        activeJName = jName;
      }
    }

    // J-event watching belongs to the unified runtime loop. The server should
    // wire jReplicas only; startRuntimeLoop() owns startJurisdictionWatchers().

    // Wire relay-router + local delivery as soon as env exists.
    // Relay WS can receive early hello/gossip traffic during bootstrap.
    const localDeliver = createLocalDeliveryHandler(env, relayStore, getEntityReplicaById);
    routerConfig = {
      store: relayStore,
      localRuntimeId: env.runtimeId,
      localDeliver,
      send: (ws, data) => ws.send(data),
      onGossipStore: profile => {
        try {
          env.gossip?.announce?.(profile);
        } catch {
          /* best effort */
        }
      },
    };

    serverBootPhase = 'bootstrap';
    const hubEntityIds = SKIP_SERVER_BOOTSTRAP
      ? (() => {
          console.log('[XLN] Skipping server bootstrap (XLN_SKIP_SERVER_BOOTSTRAP=1)');
          relayStore.activeHubEntityIds = [];
          stopMarketMakerLoop();
          return [] as string[];
        })()
      : await bootstrapServerHubsAndReserves(env, options, advertisedRelayUrl, anvilRpc, {
          includeMarketMaker: INCLUDE_MARKET_MAKER_BY_DEFAULT,
        });

    // Start P2P overlay after WS /relay is actually listening.
    // Plain daemons stay connected even before they own a routing entity;
    // routing capability is an entity-level setting announced later.
    const advertisedEntityIds = [
      ...hubEntityIds,
      ...(marketMakerEntityId ? [marketMakerEntityId.toLowerCase()] : []),
    ];
    startP2P(env, {
      relayUrls: [internalRelayUrl],
      ...(advertisedEntityIds.length > 0 ? { advertiseEntityIds: advertisedEntityIds } : {}),
      isHub: hubEntityIds.length > 0,
      gossipPollMs: 1000,
    });
    serverBootPhase = 'ready';
    serverBootCompletedAt = Date.now();
  } catch (error) {
    serverBootPhase = 'failed';
    serverBootCompletedAt = Date.now();
    serverBootError = (error as Error)?.message || String(error);
    console.error('[XLN] Startup failed after HTTP bind:', error);
    return;
  } finally {
    resolveServerStartupBarrier?.();
    resolveServerStartupBarrier = null;
  }

  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                      XLN Unified Server                          ║
╠══════════════════════════════════════════════════════════════════╣
║  Port: ${String(options.port).padEnd(10)}                                       ║
║  Host: ${(options.host || '0.0.0.0').padEnd(10)}                                       ║
║  Mode: ${(globalJAdapter ? globalJAdapter.mode : 'no-jadapter').padEnd(10)}                                       ║
╠══════════════════════════════════════════════════════════════════╣
║  Endpoints:                                                      ║
║    GET  /                     → SPA                              ║
║    WS   /relay                → P2P relay                        ║
║    WS   /rpc                  → Remote UI                        ║
║    GET  /api/health           → Health check                     ║
║    GET  /api/state            → Runtime state                    ║
║    GET  /api/clients          → Connected clients                ║
║    POST /api/faucet/erc20     → Faucet A (wallet ERC20)          ║
║    POST /api/faucet/reserve   → Faucet B (reserve transfer)      ║
║    POST /api/faucet/offchain  → Faucet C (account payment)       ║
╚══════════════════════════════════════════════════════════════════╝
  `);

  return;
}

// ============================================================================
// CLI ENTRY POINT
// ============================================================================

if (import.meta.main) {
  console.log('═══ SERVER.TS ENTRY POINT ═══');
  console.log('ENV: USE_ANVIL =', process.env.USE_ANVIL);
  console.log('ENV: ANVIL_RPC =', process.env.ANVIL_RPC);
  console.log('Args:', process.argv.slice(2));

  const args = process.argv.slice(2);

  const getArg = (name: string, fallback?: string): string | undefined => {
    const idx = args.indexOf(name);
    if (idx === -1) return fallback;
    return args[idx + 1] || fallback;
  };

  const options: Partial<XlnServerOptions> = {
    port: Number(getArg('--port', '8080')),
    host: getArg('--host', '0.0.0.0'),
    staticDir: getArg('--static-dir', './frontend/build'),
    serverId: getArg('--server-id', 'xln-server'),
  };

  console.log('Calling startXlnServer with options:', options);

  startXlnServer(options)
    .then(() => {
      if (serverBootPhase === 'ready') {
        console.log('[XLN] Server started successfully');
        return;
      }
      console.warn(
        `[XLN] Server HTTP is listening but startup is ${serverBootPhase}` +
          (serverBootError ? `: ${serverBootError}` : ''),
      );
    })
    .catch(error => {
      console.error('[XLN] Server failed:', error);
      console.error('Stack:', error.stack);
      process.exit(1);
    });
}
